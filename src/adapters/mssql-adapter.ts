import { createWriteStream } from 'fs'
import { readFile } from 'fs/promises'
import sql from 'mssql'
import { tmpdir } from 'os'
import { join } from 'path'

import { AdapterError } from '@/errors'
import { assertValidDbName, formatFileSize, logInfo } from '@/helpers/utils'
import type { DatabaseAdapter, DatabaseInfo, DbConfig, ImportOptions } from '@/interfaces'

const CONNECTION_TIMEOUT_MS = 10000
const SYSTEM_DATABASE_IDS = [1, 2, 3, 4]
const DEFAULT_COLLATION = 'SQL_Latin1_General_CP1_CI_AS'

function quoteIdent(name: string): string {
    return `[${name.replace(/]/g, ']]')}]`
}

function escapeStringLiteral(value: string): string {
    return value.replace(/'/g, "''")
}

interface ColumnInfo {
    name: string
    typeName: string
    maxLength: number
    precision: number
    scale: number
    isNullable: boolean
    isIdentity: boolean
    identitySeed: number | null
    identityIncrement: number | null
    defaultDefinition: string | null
    isComputed: boolean
    computedDefinition: string | null
    computedIsPersisted: boolean
}

interface TableInfo {
    schema: string
    name: string
    objectId: number
    columns: ColumnInfo[]
}

interface CheckConstraintInfo {
    tableObjectId: number
    constraintName: string
    definition: string
}

interface PrimaryKeyInfo {
    tableObjectId: number
    constraintName: string
    columns: string[]
}

interface UniqueIndexInfo {
    tableObjectId: number
    indexName: string
    columns: string[]
}

interface ForeignKeyInfo {
    constraintName: string
    parentTable: string
    parentSchema: string
    parentColumns: string[]
    referencedTable: string
    referencedSchema: string
    referencedColumns: string[]
    deleteAction: string
    updateAction: string
}

export class MSSQLAdapter implements DatabaseAdapter {
    constructor(private config: DbConfig) {}

    private getDriverConfig(database?: string): sql.config {
        return {
            server: this.config.host,
            port: this.config.port,
            user: this.config.user,
            password: this.config.password,
            database: database ?? this.config.database,
            options: {
                encrypt: this.config.ssl,
                trustServerCertificate: true,
                connectTimeout: CONNECTION_TIMEOUT_MS,
                requestTimeout: 60000,
            },
            pool: {
                max: 1,
                min: 0,
                idleTimeoutMillis: 1000,
            },
        }
    }

    private async withPool<T>(
        database: string | undefined,
        fn: (pool: sql.ConnectionPool) => Promise<T>,
    ): Promise<T> {
        const pool = new sql.ConnectionPool(this.getDriverConfig(database))
        await pool.connect()
        try {
            return await fn(pool)
        } finally {
            try {
                await pool.close()
            } catch {
                // preserve original error from fn()
            }
        }
    }

    private verbose(message: string): void {
        if (this.config.verbose) {
            logInfo(`[MSSQL] ${message}`)
        }
    }

    async testConnection(): Promise<boolean> {
        this.verbose(`Connecting to ${this.config.host}:${this.config.port}...`)
        try {
            await this.withPool(this.config.database, async (pool) => {
                await pool.request().query('SELECT 1')
            })
            this.verbose('Connection successful')
            return true
        } catch (error) {
            this.verbose(`Connection failed: ${(error as Error).message}`)
            return false
        }
    }

    async listDatabases(): Promise<DatabaseInfo[]> {
        this.verbose('Fetching database list with sizes...')
        const systemList = SYSTEM_DATABASE_IDS.join(',')
        const query = `
            SELECT
                d.name AS name,
                COALESCE(SUM(CAST(mf.size AS BIGINT) * 8192), 0) AS size_bytes
            FROM sys.databases d
            LEFT JOIN sys.master_files mf ON mf.database_id = d.database_id
            WHERE d.database_id NOT IN (${systemList})
            GROUP BY d.name
            ORDER BY d.name;
        `

        const databases = await this.withPool('master', async (pool) => {
            const result = await pool
                .request()
                .query<{ name: string; size_bytes: string | number }>(query)
            return result.recordset.map((row) => ({
                name: row.name,
                size: formatFileSize(Number(row.size_bytes) || 0),
            }))
        })

        this.verbose(`Found ${databases.length} databases`)
        return databases
    }

    async getLocales(): Promise<{ locales: string[]; default: string }> {
        return this.withPool('master', async (pool) => {
            const [collationsResult, defaultResult] = await Promise.all([
                pool.request().query<{
                    name: string
                }>('SELECT name FROM sys.fn_helpcollations() ORDER BY name;'),
                pool.request().query<{
                    collation: string
                }>("SELECT CAST(SERVERPROPERTY('Collation') AS NVARCHAR(128)) AS collation;"),
            ])
            return {
                locales: collationsResult.recordset.map((r) => r.name),
                default: defaultResult.recordset[0]?.collation || DEFAULT_COLLATION,
            }
        })
    }

    async createDatabase(dbName: string, options?: { locale?: string }): Promise<void> {
        assertValidDbName(dbName)
        this.verbose(`Creating database '${dbName}'...`)

        const collation = options?.locale
            ? options.locale.replace(/[^a-zA-Z0-9_]/g, '')
            : DEFAULT_COLLATION
        const query = `CREATE DATABASE ${quoteIdent(dbName)} COLLATE ${collation};`

        await this.withPool('master', async (pool) => {
            await pool.request().query(query)
        })
        this.verbose(`Database '${dbName}' created successfully`)
    }

    async dropDatabase(dbName: string): Promise<void> {
        assertValidDbName(dbName)
        this.verbose(`Dropping database '${dbName}'...`)

        await this.withPool('master', async (pool) => {
            const ident = quoteIdent(dbName)
            await pool.request().batch(
                `IF DB_ID('${escapeStringLiteral(dbName)}') IS NOT NULL
                     BEGIN
                         ALTER DATABASE ${ident} SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
                         DROP DATABASE ${ident};
                     END`,
            )
        })
        this.verbose(`Database '${dbName}' dropped`)
    }

    async renameDatabase(oldName: string, newName: string): Promise<void> {
        assertValidDbName(oldName)
        assertValidDbName(newName)
        this.verbose(`Renaming '${oldName}' to '${newName}'...`)

        await this.withPool('master', async (pool) => {
            const oldIdent = quoteIdent(oldName)
            const newIdent = quoteIdent(newName)
            await pool.request().batch(
                `ALTER DATABASE ${oldIdent} SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
                     ALTER DATABASE ${oldIdent} MODIFY NAME = ${newIdent};
                     ALTER DATABASE ${newIdent} SET MULTI_USER;`,
            )
        })
        this.verbose(`Database renamed to '${newName}'`)
    }

    async cloneDatabase(sourceName: string, targetName: string): Promise<void> {
        assertValidDbName(sourceName)
        assertValidDbName(targetName)
        this.verbose(`Cloning '${sourceName}' to '${targetName}' (dump+restore)...`)

        const tmpFile = join(tmpdir(), `dbcli-clone-${Date.now()}.sql`)
        const originalDb = this.config.database
        try {
            this.config.database = sourceName
            await this.export(tmpFile)
            await this.createDatabase(targetName)
            this.config.database = targetName
            await this.import(tmpFile)
        } finally {
            this.config.database = originalDb
            try {
                await Bun.file(tmpFile).unlink?.()
            } catch {
                /* ignore cleanup errors */
            }
        }
        this.verbose(`Database cloned to '${targetName}'`)
    }

    async export(outputFile: string): Promise<void> {
        this.verbose(`Exporting '${this.config.database}' to '${outputFile}'...`)

        await this.withPool(this.config.database, async (pool) => {
            const tables = await this.fetchTables(pool)
            const primaryKeys = await this.fetchPrimaryKeys(pool)
            const uniqueIndexes = await this.fetchUniqueIndexes(pool)
            const foreignKeys = await this.fetchForeignKeys(pool)
            const checkConstraints = await this.fetchCheckConstraints(pool)

            const stream = createWriteStream(outputFile, { encoding: 'utf-8' })
            const writeLine = (line: string): Promise<void> =>
                new Promise((resolve, reject) => {
                    stream.write(line + '\n', (err) => (err ? reject(err) : resolve()))
                })

            try {
                await writeLine(`-- dbcli MSSQL dump`)
                await writeLine(`-- Database: ${this.config.database}`)
                await writeLine(`-- Generated: ${new Date().toISOString()}`)
                await writeLine(`SET NOCOUNT ON;`)
                await writeLine(`SET XACT_ABORT ON;`)
                await writeLine(`GO`)
                await writeLine(``)

                const schemas = Array.from(new Set(tables.map((t) => t.schema))).filter(
                    (s) => s !== 'dbo',
                )
                for (const schema of schemas) {
                    await writeLine(
                        `IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = '${escapeStringLiteral(schema)}') EXEC('CREATE SCHEMA ${quoteIdent(schema)}');`,
                    )
                    await writeLine(`GO`)
                }
                if (schemas.length > 0) await writeLine(``)

                for (const table of tables) {
                    const ident = `${quoteIdent(table.schema)}.${quoteIdent(table.name)}`
                    await writeLine(`-- Table: ${table.schema}.${table.name}`)
                    await writeLine(
                        `IF OBJECT_ID('${escapeStringLiteral(`${table.schema}.${table.name}`)}', 'U') IS NOT NULL DROP TABLE ${ident};`,
                    )
                    await writeLine(`GO`)
                    await writeLine(this.buildCreateTable(table, primaryKeys, checkConstraints))
                    await writeLine(`GO`)
                    await writeLine(``)
                }

                for (const idx of uniqueIndexes) {
                    const table = tables.find((t) => t.objectId === idx.tableObjectId)
                    if (!table) continue
                    const tableIdent = `${quoteIdent(table.schema)}.${quoteIdent(table.name)}`
                    const cols = idx.columns.map(quoteIdent).join(', ')
                    await writeLine(
                        `CREATE UNIQUE INDEX ${quoteIdent(idx.indexName)} ON ${tableIdent} (${cols});`,
                    )
                    await writeLine(`GO`)
                }
                if (uniqueIndexes.length > 0) await writeLine(``)

                for (const table of tables) {
                    await this.dumpTableData(pool, table, writeLine)
                }

                for (const fk of foreignKeys) {
                    const parentIdent = `${quoteIdent(fk.parentSchema)}.${quoteIdent(fk.parentTable)}`
                    const refIdent = `${quoteIdent(fk.referencedSchema)}.${quoteIdent(fk.referencedTable)}`
                    const parentCols = fk.parentColumns.map(quoteIdent).join(', ')
                    const refCols = fk.referencedColumns.map(quoteIdent).join(', ')
                    let line = `ALTER TABLE ${parentIdent} ADD CONSTRAINT ${quoteIdent(fk.constraintName)} FOREIGN KEY (${parentCols}) REFERENCES ${refIdent} (${refCols})`
                    if (fk.deleteAction !== 'NO_ACTION')
                        line += ` ON DELETE ${fk.deleteAction.replace('_', ' ')}`
                    if (fk.updateAction !== 'NO_ACTION')
                        line += ` ON UPDATE ${fk.updateAction.replace('_', ' ')}`
                    line += ';'
                    await writeLine(line)
                    await writeLine(`GO`)
                }
            } finally {
                await new Promise<void>((resolve, reject) => {
                    stream.end((err: Error | null | undefined) => (err ? reject(err) : resolve()))
                })
            }
        })
        this.verbose(`Export completed: ${outputFile}`)
    }

    async import(inputFile: string, options?: ImportOptions): Promise<void> {
        this.verbose(`Importing '${inputFile}' to '${this.config.database}'...`)

        if (options?.reset) {
            assertValidDbName(this.config.database)
            this.verbose('Resetting database (drop + create)...')
            await this.dropDatabase(this.config.database)
            await this.createDatabase(this.config.database)
        }

        const content = await readFile(inputFile, 'utf-8')
        const batches = splitOnGo(content).filter((b) => b.trim().length > 0)

        await this.withPool(this.config.database, async (pool) => {
            for (let i = 0; i < batches.length; i++) {
                try {
                    await pool.request().batch(batches[i])
                } catch (error) {
                    throw new AdapterError(
                        `Import failed at batch ${i + 1}/${batches.length}: ${(error as Error).message}`,
                    )
                }
            }
        })
        this.verbose('Import completed successfully')
    }

    private async fetchTables(pool: sql.ConnectionPool): Promise<TableInfo[]> {
        const result = await pool.request().query<{
            object_id: number
            schema_name: string
            table_name: string
            column_name: string
            type_name: string
            max_length: number
            precision: number
            scale: number
            is_nullable: boolean
            is_identity: boolean
            seed_value: number | null
            increment_value: number | null
            default_definition: string | null
            is_computed: boolean
            computed_definition: string | null
            computed_is_persisted: boolean | null
            column_id: number
        }>(`
            SELECT
                t.object_id,
                s.name AS schema_name,
                t.name AS table_name,
                c.name AS column_name,
                ty.name AS type_name,
                c.max_length,
                c.precision,
                c.scale,
                c.is_nullable,
                c.is_identity,
                ic.seed_value,
                ic.increment_value,
                dc.definition AS default_definition,
                c.is_computed,
                cc.definition AS computed_definition,
                cc.is_persisted AS computed_is_persisted,
                c.column_id
            FROM sys.tables t
            JOIN sys.schemas s ON s.schema_id = t.schema_id
            JOIN sys.columns c ON c.object_id = t.object_id
            JOIN sys.types ty ON ty.user_type_id = c.user_type_id
            LEFT JOIN sys.identity_columns ic ON ic.object_id = c.object_id AND ic.column_id = c.column_id
            LEFT JOIN sys.default_constraints dc ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
            LEFT JOIN sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
            WHERE t.type = 'U' AND t.is_ms_shipped = 0
            ORDER BY s.name, t.name, c.column_id;
        `)

        const tableMap = new Map<number, TableInfo>()
        for (const row of result.recordset) {
            let table = tableMap.get(row.object_id)
            if (!table) {
                table = {
                    objectId: row.object_id,
                    schema: row.schema_name,
                    name: row.table_name,
                    columns: [],
                }
                tableMap.set(row.object_id, table)
            }
            table.columns.push({
                name: row.column_name,
                typeName: row.type_name,
                maxLength: row.max_length,
                precision: row.precision,
                scale: row.scale,
                isNullable: row.is_nullable,
                isIdentity: row.is_identity,
                identitySeed: row.seed_value !== null ? Number(row.seed_value) : null,
                identityIncrement:
                    row.increment_value !== null ? Number(row.increment_value) : null,
                defaultDefinition: row.default_definition,
                isComputed: row.is_computed,
                computedDefinition: row.computed_definition,
                computedIsPersisted: row.computed_is_persisted === true,
            })
        }
        return Array.from(tableMap.values())
    }

    private async fetchCheckConstraints(pool: sql.ConnectionPool): Promise<CheckConstraintInfo[]> {
        const result = await pool.request().query<{
            object_id: number
            constraint_name: string
            definition: string
        }>(`
            SELECT
                cc.parent_object_id AS object_id,
                cc.name AS constraint_name,
                cc.definition AS definition
            FROM sys.check_constraints cc
            JOIN sys.tables t ON t.object_id = cc.parent_object_id
            WHERE t.is_ms_shipped = 0 AND cc.is_ms_shipped = 0
            ORDER BY cc.parent_object_id, cc.name;
        `)
        return result.recordset.map((r) => ({
            tableObjectId: r.object_id,
            constraintName: r.constraint_name,
            definition: r.definition,
        }))
    }

    private async fetchPrimaryKeys(pool: sql.ConnectionPool): Promise<PrimaryKeyInfo[]> {
        const result = await pool.request().query<{
            object_id: number
            constraint_name: string
            column_name: string
            key_ordinal: number
        }>(`
            SELECT
                t.object_id,
                kc.name AS constraint_name,
                c.name AS column_name,
                ic.key_ordinal
            FROM sys.tables t
            JOIN sys.key_constraints kc ON kc.parent_object_id = t.object_id AND kc.type = 'PK'
            JOIN sys.index_columns ic ON ic.object_id = kc.parent_object_id AND ic.index_id = kc.unique_index_id
            JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
            WHERE t.is_ms_shipped = 0
            ORDER BY t.object_id, ic.key_ordinal;
        `)

        const pkMap = new Map<number, PrimaryKeyInfo>()
        for (const row of result.recordset) {
            let pk = pkMap.get(row.object_id)
            if (!pk) {
                pk = {
                    tableObjectId: row.object_id,
                    constraintName: row.constraint_name,
                    columns: [],
                }
                pkMap.set(row.object_id, pk)
            }
            pk.columns.push(row.column_name)
        }
        return Array.from(pkMap.values())
    }

    private async fetchUniqueIndexes(pool: sql.ConnectionPool): Promise<UniqueIndexInfo[]> {
        const result = await pool.request().query<{
            object_id: number
            index_name: string
            column_name: string
            key_ordinal: number
        }>(`
            SELECT
                t.object_id,
                i.name AS index_name,
                c.name AS column_name,
                ic.key_ordinal
            FROM sys.tables t
            JOIN sys.indexes i ON i.object_id = t.object_id
            JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
            JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
            WHERE t.is_ms_shipped = 0
              AND i.is_unique = 1
              AND i.is_primary_key = 0
              AND i.is_unique_constraint = 0
              AND i.type IN (1, 2)
            ORDER BY t.object_id, i.name, ic.key_ordinal;
        `)

        const idxMap = new Map<string, UniqueIndexInfo>()
        for (const row of result.recordset) {
            const key = `${row.object_id}:${row.index_name}`
            let idx = idxMap.get(key)
            if (!idx) {
                idx = { tableObjectId: row.object_id, indexName: row.index_name, columns: [] }
                idxMap.set(key, idx)
            }
            idx.columns.push(row.column_name)
        }
        return Array.from(idxMap.values())
    }

    private async fetchForeignKeys(pool: sql.ConnectionPool): Promise<ForeignKeyInfo[]> {
        const result = await pool.request().query<{
            constraint_name: string
            parent_schema: string
            parent_table: string
            parent_column: string
            referenced_schema: string
            referenced_table: string
            referenced_column: string
            constraint_column_id: number
            delete_action: string
            update_action: string
        }>(`
            SELECT
                fk.name AS constraint_name,
                ps.name AS parent_schema,
                pt.name AS parent_table,
                pc.name AS parent_column,
                rs.name AS referenced_schema,
                rt.name AS referenced_table,
                rc.name AS referenced_column,
                fkc.constraint_column_id,
                fk.delete_referential_action_desc AS delete_action,
                fk.update_referential_action_desc AS update_action
            FROM sys.foreign_keys fk
            JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
            JOIN sys.tables pt ON pt.object_id = fkc.parent_object_id
            JOIN sys.schemas ps ON ps.schema_id = pt.schema_id
            JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
            JOIN sys.tables rt ON rt.object_id = fkc.referenced_object_id
            JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
            JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
            ORDER BY fk.name, fkc.constraint_column_id;
        `)

        const fkMap = new Map<string, ForeignKeyInfo>()
        for (const row of result.recordset) {
            let fk = fkMap.get(row.constraint_name)
            if (!fk) {
                fk = {
                    constraintName: row.constraint_name,
                    parentTable: row.parent_table,
                    parentSchema: row.parent_schema,
                    parentColumns: [],
                    referencedTable: row.referenced_table,
                    referencedSchema: row.referenced_schema,
                    referencedColumns: [],
                    deleteAction: row.delete_action,
                    updateAction: row.update_action,
                }
                fkMap.set(row.constraint_name, fk)
            }
            fk.parentColumns.push(row.parent_column)
            fk.referencedColumns.push(row.referenced_column)
        }
        return Array.from(fkMap.values())
    }

    private buildCreateTable(
        table: TableInfo,
        primaryKeys: PrimaryKeyInfo[],
        checkConstraints: CheckConstraintInfo[],
    ): string {
        const tableIdent = `${quoteIdent(table.schema)}.${quoteIdent(table.name)}`
        const columnDefs = table.columns.map((c) => this.buildColumnDef(c))
        const pk = primaryKeys.find((p) => p.tableObjectId === table.objectId)
        if (pk) {
            const pkCols = pk.columns.map(quoteIdent).join(', ')
            columnDefs.push(
                `    CONSTRAINT ${quoteIdent(pk.constraintName)} PRIMARY KEY (${pkCols})`,
            )
        }
        for (const cc of checkConstraints.filter((c) => c.tableObjectId === table.objectId)) {
            columnDefs.push(
                `    CONSTRAINT ${quoteIdent(cc.constraintName)} CHECK ${cc.definition}`,
            )
        }
        return `CREATE TABLE ${tableIdent} (\n${columnDefs.join(',\n')}\n);`
    }

    private buildColumnDef(c: ColumnInfo): string {
        if (c.isComputed && c.computedDefinition) {
            const persisted = c.computedIsPersisted ? ' PERSISTED' : ''
            return `    ${quoteIdent(c.name)} AS ${c.computedDefinition}${persisted}`
        }

        let typeSpec = c.typeName.toLowerCase()
        const lengthBased = ['varchar', 'nvarchar', 'char', 'nchar', 'varbinary', 'binary']
        const precisionBased = ['decimal', 'numeric']
        const timeBased = ['datetime2', 'time', 'datetimeoffset']

        if (lengthBased.includes(typeSpec)) {
            const isUnicode = typeSpec.startsWith('n')
            const charLen = isUnicode ? c.maxLength / 2 : c.maxLength
            typeSpec += `(${c.maxLength === -1 ? 'MAX' : charLen})`
        } else if (precisionBased.includes(typeSpec)) {
            typeSpec += `(${c.precision},${c.scale})`
        } else if (timeBased.includes(typeSpec) && c.scale !== 7) {
            typeSpec += `(${c.scale})`
        }

        const parts = [`    ${quoteIdent(c.name)} ${typeSpec}`]
        if (c.isIdentity && c.identitySeed !== null && c.identityIncrement !== null) {
            parts.push(`IDENTITY(${c.identitySeed},${c.identityIncrement})`)
        }
        parts.push(c.isNullable ? 'NULL' : 'NOT NULL')
        if (c.defaultDefinition) {
            parts.push(`DEFAULT ${c.defaultDefinition}`)
        }
        return parts.join(' ')
    }

    private async dumpTableData(
        pool: sql.ConnectionPool,
        table: TableInfo,
        writeLine: (line: string) => Promise<void>,
    ): Promise<void> {
        const tableIdent = `${quoteIdent(table.schema)}.${quoteIdent(table.name)}`
        const writableCols = table.columns.filter((c) => !c.isComputed)
        const colNames = writableCols.map((c) => quoteIdent(c.name)).join(', ')
        const hasIdentity = writableCols.some((c) => c.isIdentity)
        const identityCol = writableCols.find((c) => c.isIdentity)

        await writeLine(`-- Data for ${table.schema}.${table.name}`)
        if (hasIdentity) await writeLine(`SET IDENTITY_INSERT ${tableIdent} ON;`)

        const result = await pool
            .request()
            .query<Record<string, unknown>>(`SELECT ${colNames} FROM ${tableIdent};`)

        for (const row of result.recordset) {
            const values = writableCols.map((c) => formatValue(row[c.name], c.typeName))
            await writeLine(
                `INSERT INTO ${tableIdent} (${colNames}) VALUES (${values.join(', ')});`,
            )
        }

        if (hasIdentity) await writeLine(`SET IDENTITY_INSERT ${tableIdent} OFF;`)

        if (identityCol && result.recordset.length > 0) {
            const maxId = result.recordset.reduce((max, row) => {
                const v = Number(row[identityCol.name])
                return Number.isFinite(v) && v > max ? v : max
            }, Number.NEGATIVE_INFINITY)
            if (Number.isFinite(maxId)) {
                const quotedRef = `${quoteIdent(table.schema)}.${quoteIdent(table.name)}`
                await writeLine(
                    `DBCC CHECKIDENT('${escapeStringLiteral(quotedRef)}', RESEED, ${maxId});`,
                )
            }
        }

        await writeLine(`GO`)
        await writeLine(``)
    }

    checkDependencies(): void {}
}

function formatValue(value: unknown, typeName: string): string {
    if (value === null || value === undefined) return 'NULL'
    const t = typeName.toLowerCase()
    if (t === 'bit') return value ? '1' : '0'
    if (Buffer.isBuffer(value)) return `0x${value.toString('hex')}`
    if (value instanceof Uint8Array) return `0x${Buffer.from(value).toString('hex')}`
    if (value instanceof Date) {
        const iso = value.toISOString()
        if (t === 'date') return `'${iso.slice(0, 10)}'`
        if (t === 'time') return `'${iso.slice(11, 23)}'`
        return `'${iso.slice(0, 23).replace('T', ' ')}'`
    }
    if (typeof value === 'number' || typeof value === 'bigint') return String(value)
    if (typeof value === 'boolean') return value ? '1' : '0'
    const str = String(value)
    const isUnicode = t.startsWith('n')
    return `${isUnicode ? 'N' : ''}'${escapeStringLiteral(str)}'`
}

function splitOnGo(sqlText: string): string[] {
    const lines = sqlText.split(/\r?\n/)
    const batches: string[] = []
    let current: string[] = []
    for (const line of lines) {
        if (/^\s*GO\s*(?:--.*)?$/i.test(line)) {
            if (current.length > 0) {
                batches.push(current.join('\n'))
                current = []
            }
        } else {
            current.push(line)
        }
    }
    if (current.length > 0) batches.push(current.join('\n'))
    return batches
}
