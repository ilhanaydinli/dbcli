import { note } from '@clack/prompts'

import { AdapterError } from '@/errors'
import { assertValidDbName, formatFileSize, logInfo } from '@/helpers/utils'
import type { DatabaseAdapter, DatabaseInfo, DbConfig } from '@/interfaces'
import { DbType } from '@/interfaces'

const CONNECTION_TIMEOUT_MS = 10000

const SYSTEM_DATABASES = ['information_schema', 'performance_schema', 'mysql', 'sys']
const DEFAULT_COLLATION = 'utf8mb4_unicode_ci'

export class MySQLAdapter implements DatabaseAdapter {
    private static dependenciesChecked = false
    private mysqlPath = 'mysql'
    private mysqldumpPath = 'mysqldump'

    constructor(private config: DbConfig) {
        const mysql = Bun.which('mysql')
        const mysqldump = Bun.which('mysqldump')

        if (mysql) this.mysqlPath = mysql
        if (mysqldump) this.mysqldumpPath = mysqldump
    }

    private get flavor(): string {
        return this.config.type === DbType.MariaDB ? 'MariaDB' : 'MySQL'
    }

    private getStdioConfig(): { stdout: 'inherit' | 'ignore'; stderr: 'inherit' | 'ignore' } {
        return {
            stdout: this.config.verbose ? 'inherit' : 'ignore',
            stderr: this.config.verbose ? 'inherit' : 'ignore',
        }
    }

    private getEnv() {
        const env: Record<string, string | undefined> = {}
        if (this.config.password) env.MYSQL_PWD = this.config.password
        return env
    }

    private getConnectionArgs() {
        const args = [
            '-h',
            this.config.host,
            '-P',
            this.config.port.toString(),
            '-u',
            this.config.user,
        ]
        if (this.config.ssl) args.push('--ssl-mode=REQUIRED')
        return args
    }

    async testConnection(): Promise<boolean> {
        try {
            this.verbose(`Connecting to ${this.config.host}:${this.config.port}...`)

            const proc = Bun.spawn(
                [
                    this.mysqlPath,
                    ...this.getConnectionArgs(),
                    '-N',
                    '-B',
                    '-e',
                    'SELECT 1',
                    this.config.database,
                ],
                {
                    env: this.getEnv(),
                    stdout: 'ignore',
                    stderr: 'ignore',
                },
            )

            let timerId: Timer | undefined
            const timeout = new Promise<never>((_, reject) => {
                timerId = setTimeout(() => {
                    proc.kill()
                    reject(new Error('Connection timeout'))
                }, CONNECTION_TIMEOUT_MS)
            })

            const exitCode = await Promise.race([proc.exited, timeout])
            clearTimeout(timerId)

            if (exitCode === 0) {
                this.verbose('Connection successful')
                return true
            }
            return false
        } catch (error) {
            if ((error as Error).message === 'Connection timeout') {
                this.verbose(`Connection timed out after ${CONNECTION_TIMEOUT_MS / 1000}s`)
            }
            return false
        }
    }

    private verbose(message: string): void {
        if (this.config.verbose) {
            logInfo(`[${this.flavor}] ${message}`)
        }
    }

    async listDatabases(): Promise<DatabaseInfo[]> {
        this.verbose('Fetching database list with sizes...')

        const systemList = SYSTEM_DATABASES.map((d) => `'${d}'`).join(',')
        const query = `
            SELECT s.schema_name,
                   COALESCE(SUM(t.data_length + t.index_length), 0) AS size_bytes
            FROM information_schema.schemata s
            LEFT JOIN information_schema.tables t ON t.table_schema = s.schema_name
            WHERE s.schema_name NOT IN (${systemList})
            GROUP BY s.schema_name
            ORDER BY s.schema_name;
        `

        const proc = Bun.spawn(
            [this.mysqlPath, ...this.getConnectionArgs(), '-N', '-B', '-e', query],
            {
                env: this.getEnv(),
                stdout: 'pipe',
                stderr: this.config.verbose ? 'inherit' : 'ignore',
            },
        )

        const output = await new Response(proc.stdout).text()
        const exitCode = await proc.exited

        if (exitCode !== 0) {
            throw new AdapterError(`Failed to list databases (exit code ${exitCode})`)
        }

        const databases = output
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .map((line) => {
                const [name, sizeBytes] = line.split('\t')
                const bytes = Number(sizeBytes) || 0
                return { name: name.trim(), size: formatFileSize(bytes) }
            })

        this.verbose(`Found ${databases.length} databases`)
        return databases
    }

    async getLocales(): Promise<{ locales: string[]; default: string }> {
        try {
            const procList = Bun.spawn(
                [
                    this.mysqlPath,
                    ...this.getConnectionArgs(),
                    '-N',
                    '-B',
                    '-e',
                    'SELECT collation_name FROM information_schema.collations ORDER BY collation_name;',
                ],
                { env: this.getEnv(), stdout: 'pipe', stderr: 'ignore' },
            )

            const procDef = Bun.spawn(
                [
                    this.mysqlPath,
                    ...this.getConnectionArgs(),
                    '-N',
                    '-B',
                    '-e',
                    "SHOW VARIABLES LIKE 'collation_database';",
                ],
                { env: this.getEnv(), stdout: 'pipe', stderr: 'ignore' },
            )

            const [outputList, outputDef] = await Promise.all([
                new Response(procList.stdout).text(),
                new Response(procDef.stdout).text(),
            ])

            await Promise.all([procList.exited, procDef.exited])

            const locales = outputList
                .split('\n')
                .map((line) => line.trim())
                .filter((line) => line.length > 0)

            const defaultLine = outputDef.trim().split('\n')[0] || ''
            const defaultLocale = defaultLine.split('\t')[1]?.trim() || DEFAULT_COLLATION

            return { locales, default: defaultLocale }
        } catch {
            return { locales: [], default: DEFAULT_COLLATION }
        }
    }

    async createDatabase(dbName: string, options?: { locale?: string }): Promise<void> {
        assertValidDbName(dbName)
        this.verbose(`Creating database '${dbName}'...`)

        const collation = options?.locale
            ? options.locale.replace(/[^a-zA-Z0-9_]/g, '')
            : DEFAULT_COLLATION
        const charset = collation.split('_')[0] || 'utf8mb4'
        const query = `CREATE DATABASE \`${dbName}\` CHARACTER SET ${charset} COLLATE ${collation};`

        if (options?.locale) {
            this.verbose(`Using collation: ${collation}`)
        }

        const proc = Bun.spawn([this.mysqlPath, ...this.getConnectionArgs(), '-e', query], {
            env: this.getEnv(),
            ...this.getStdioConfig(),
        })

        const exitCode = await proc.exited
        if (exitCode !== 0) {
            throw new AdapterError(`Failed to create database ${dbName} (exit code ${exitCode})`)
        }
        this.verbose(`Database '${dbName}' created successfully`)
    }

    async dropDatabase(dbName: string): Promise<void> {
        assertValidDbName(dbName)
        this.verbose(`Dropping database '${dbName}'...`)

        const proc = Bun.spawn(
            [this.mysqlPath, ...this.getConnectionArgs(), '-e', `DROP DATABASE \`${dbName}\`;`],
            {
                env: this.getEnv(),
                ...this.getStdioConfig(),
            },
        )
        const exitCode = await proc.exited
        if (exitCode !== 0) {
            throw new AdapterError(`Failed to drop database ${dbName}`)
        }
        this.verbose(`Database '${dbName}' dropped`)
    }

    async renameDatabase(oldName: string, newName: string): Promise<void> {
        assertValidDbName(oldName)
        assertValidDbName(newName)
        this.verbose(`Renaming '${oldName}' to '${newName}' (dump+restore)...`)

        await this.createDatabase(newName)
        await this.copyDatabaseContents(oldName, newName)
        await this.dropDatabase(oldName)

        this.verbose(`Database renamed to '${newName}'`)
    }

    async cloneDatabase(sourceName: string, targetName: string): Promise<void> {
        assertValidDbName(sourceName)
        assertValidDbName(targetName)
        this.verbose(`Cloning '${sourceName}' to '${targetName}' (dump+restore)...`)

        await this.createDatabase(targetName)
        await this.copyDatabaseContents(sourceName, targetName)

        this.verbose(`Database cloned to '${targetName}'`)
    }

    private async copyDatabaseContents(sourceName: string, targetName: string): Promise<void> {
        const dumpProc = Bun.spawn([this.mysqldumpPath, ...this.getConnectionArgs(), sourceName], {
            env: this.getEnv(),
            stdout: 'pipe',
            stderr: 'pipe',
        })

        const restoreProc = Bun.spawn([this.mysqlPath, ...this.getConnectionArgs(), targetName], {
            env: this.getEnv(),
            stdin: dumpProc.stdout,
            stdout: 'ignore',
            stderr: 'pipe',
        })

        const [dumpExit, restoreExit] = await Promise.all([dumpProc.exited, restoreProc.exited])

        if (dumpExit !== 0) {
            const err = await new Response(dumpProc.stderr).text()
            throw new AdapterError(
                `mysqldump failed during copy (exit ${dumpExit})${err ? `: ${err.trim()}` : ''}`,
            )
        }
        if (restoreExit !== 0) {
            const err = await new Response(restoreProc.stderr).text()
            throw new AdapterError(
                `mysql restore failed during copy (exit ${restoreExit})${err ? `: ${err.trim()}` : ''}`,
            )
        }
    }

    async export(outputFile: string): Promise<void> {
        this.verbose(`Exporting '${this.config.database}' to '${outputFile}'...`)
        this.verbose(`Using mysqldump: ${this.mysqldumpPath}`)

        const dumpProc = Bun.spawn(
            [
                this.mysqldumpPath,
                ...this.getConnectionArgs(),
                `--result-file=${outputFile}`,
                this.config.database,
            ],
            {
                env: this.getEnv(),
                stdout: this.config.verbose ? 'inherit' : 'ignore',
                stderr: 'pipe',
            },
        )

        const exitCode = await dumpProc.exited
        if (exitCode !== 0) {
            const errorOutput = await new Response(dumpProc.stderr).text()
            throw new AdapterError(
                `mysqldump failed with exit code ${exitCode}${errorOutput ? `: ${errorOutput.trim()}` : ''}`,
            )
        }
        this.verbose(`Export completed: ${outputFile}`)
    }

    async import(inputFile: string, options?: { reset?: boolean }): Promise<void> {
        this.verbose(`Importing '${inputFile}' to '${this.config.database}'...`)

        if (options?.reset) {
            assertValidDbName(this.config.database)
            this.verbose('Resetting database (drop + create)...')
            const resetProc = Bun.spawn(
                [
                    this.mysqlPath,
                    ...this.getConnectionArgs(),
                    '-e',
                    `DROP DATABASE IF EXISTS \`${this.config.database}\`; CREATE DATABASE \`${this.config.database}\` CHARACTER SET utf8mb4 COLLATE ${DEFAULT_COLLATION};`,
                ],
                {
                    env: this.getEnv(),
                    ...this.getStdioConfig(),
                },
            )
            const resetExit = await resetProc.exited
            if (resetExit !== 0) {
                throw new AdapterError(`Database reset failed with exit code ${resetExit}`)
            }
            this.verbose('Database reset complete')
        }

        this.verbose(`Running mysql import from ${inputFile}...`)
        const importProc = Bun.spawn(
            [this.mysqlPath, ...this.getConnectionArgs(), this.config.database],
            {
                env: this.getEnv(),
                stdin: Bun.file(inputFile),
                stdout: this.config.verbose ? 'inherit' : 'ignore',
                stderr: 'pipe',
            },
        )

        const exitCode = await importProc.exited
        if (exitCode !== 0) {
            const errorOutput = await new Response(importProc.stderr).text()
            throw new AdapterError(
                `mysql failed with exit code ${exitCode}${errorOutput ? `: ${errorOutput.trim()}` : ''}`,
            )
        }
        this.verbose('Import completed successfully')
    }

    checkDependencies(): void {
        if (MySQLAdapter.dependenciesChecked) {
            return
        }

        const missing: string[] = []
        if (!Bun.which('mysql')) missing.push('mysql')
        if (!Bun.which('mysqldump')) missing.push('mysqldump')

        if (missing.length > 0) {
            const missingList = missing.map((tool) => `  ✖ ${tool}`).join('\n')
            note(
                `${missingList}\n\nPlease install MySQL/MariaDB client tools to continue.`,
                '⚠️  Missing Required Tools',
            )

            throw new AdapterError(`Missing required tools: ${missing.join(', ')}`)
        }

        MySQLAdapter.dependenciesChecked = true
    }
}
