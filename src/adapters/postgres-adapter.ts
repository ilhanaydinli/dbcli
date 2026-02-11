import { note } from '@clack/prompts'

import { AdapterError } from '@/errors'
import { assertValidDbName, logInfo } from '@/helpers/utils'
import type { DatabaseAdapter, DatabaseInfo, DbConfig } from '@/interfaces'

const CONNECTION_TIMEOUT_MS = 10000

export class PostgresAdapter implements DatabaseAdapter {
    private static dependenciesChecked = false
    private psqlPath = 'psql'
    private pgDumpPath = 'pg_dump'

    constructor(private config: DbConfig) {
        const psql = Bun.which('psql')
        const pgdump = Bun.which('pg_dump')

        if (psql) this.psqlPath = psql
        if (pgdump) this.pgDumpPath = pgdump
    }

    private getStdioConfig(): { stdout: 'inherit' | 'ignore'; stderr: 'inherit' | 'ignore' } {
        return {
            stdout: this.config.verbose ? 'inherit' : 'ignore',
            stderr: this.config.verbose ? 'inherit' : 'ignore',
        }
    }

    private getEnv() {
        const env: Record<string, string | undefined> = {}

        // Pass necessary locale vars if they exist in parent
        if (process.env.LC_ALL) env.LC_ALL = process.env.LC_ALL
        if (process.env.LANG) env.LANG = process.env.LANG

        if (this.config.password) {
            env.PGPASSWORD = this.config.password
        }
        if (this.config.ssl) {
            env.PGSSLMODE = 'require'
        }
        return env
    }

    private getConnectionArgs() {
        return ['-h', this.config.host, '-p', this.config.port.toString(), '-U', this.config.user]
    }

    private getPsqlArgs() {
        return [...this.getConnectionArgs(), '-v', 'ON_ERROR_STOP=1']
    }

    async testConnection(): Promise<boolean> {
        try {
            this.verbose(`Connecting to ${this.config.host}:${this.config.port}...`)

            const proc = Bun.spawn(
                [
                    this.psqlPath,
                    ...this.getPsqlArgs(),
                    '-d',
                    this.config.database,
                    '-c',
                    'SELECT 1',
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
            logInfo(`[PostgreSQL] ${message}`)
        }
    }

    async listDatabases(): Promise<DatabaseInfo[]> {
        this.verbose('Fetching database list with sizes...')

        const query = `
            SELECT datname, pg_size_pretty(pg_database_size(datname)) as size
            FROM pg_database
            WHERE datistemplate = false
            ORDER BY datname;
        `

        const proc = Bun.spawn(
            [
                this.psqlPath,
                ...this.getPsqlArgs(),
                '-d',
                this.config.database,
                '-t',
                '-A',
                '-F',
                '|',
                '-c',
                query,
            ],
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
                const [name, size] = line.split('|')
                return { name: name.trim(), size: size?.trim() || 'N/A' }
            })

        this.verbose(`Found ${databases.length} databases`)
        return databases
    }

    async getLocales(): Promise<{ locales: string[]; default: string }> {
        try {
            // Fetch locales AND the default collation in one go (or separately)
            // It's safer to use separate queries or a smart union, but simple is better.

            // 1. Get List
            const procList = Bun.spawn(
                [
                    this.psqlPath,
                    ...this.getPsqlArgs(),
                    '-d',
                    this.config.database,
                    '-t',
                    '-A',
                    '-c',
                    'SELECT DISTINCT collname FROM pg_collation WHERE collencoding = -1 OR collencoding = (SELECT encoding FROM pg_database WHERE datname = current_database()) ORDER BY collname;',
                ],
                {
                    env: this.getEnv(),
                    stdout: 'pipe',
                    stderr: 'ignore',
                },
            )

            // 2. Get Default (from current connection context)
            const procDef = Bun.spawn(
                [
                    this.psqlPath,
                    ...this.getPsqlArgs(),
                    '-d',
                    this.config.database,
                    '-t',
                    '-A',
                    '-c',
                    'SHOW LC_COLLATE;',
                ],
                {
                    env: this.getEnv(),
                    stdout: 'pipe',
                    stderr: 'ignore',
                },
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

            const defaultLocale = outputDef.trim() || 'en_US.UTF-8' // Fallback if empty

            return { locales, default: defaultLocale }
        } catch {
            return { locales: [], default: 'en_US.UTF-8' }
        }
    }

    async createDatabase(dbName: string, options?: { locale?: string }): Promise<void> {
        assertValidDbName(dbName)
        this.verbose(`Creating database '${dbName}'...`)

        let query = `CREATE DATABASE "${dbName}" TEMPLATE template0 ENCODING 'UTF8'`
        if (options?.locale) {
            const safeLocale = options.locale.replace(/[^a-zA-Z0-9_.-]/g, '')
            query += ` LC_COLLATE='${safeLocale}' LC_CTYPE='${safeLocale}'`
            this.verbose(`Using locale: ${safeLocale}`)
        }

        const proc = Bun.spawn(
            [this.psqlPath, ...this.getPsqlArgs(), '-d', 'postgres', '-c', query],
            {
                env: this.getEnv(),
                ...this.getStdioConfig(),
            },
        )

        const exitCode = await proc.exited
        if (exitCode !== 0) {
            throw new AdapterError(`Failed to create database ${dbName} (exit code ${exitCode})`)
        }
        this.verbose(`Database '${dbName}' created successfully`)
    }

    private async terminateConnections(dbName: string) {
        const proc = Bun.spawn(
            [
                this.psqlPath,
                ...this.getPsqlArgs(),
                '-d',
                'postgres',
                '-c',
                `SELECT pg_terminate_backend(pg_stat_activity.pid) FROM pg_stat_activity WHERE pg_stat_activity.datname = :'dbname' AND pid <> pg_backend_pid();`,
                '-v',
                `dbname=${dbName}`,
            ],
            {
                env: this.getEnv(),
                stdout: 'ignore',
                stderr: 'ignore',
            },
        )
        await proc.exited
    }

    async dropDatabase(dbName: string): Promise<void> {
        assertValidDbName(dbName)
        this.verbose(`Terminating connections to '${dbName}'...`)
        await this.terminateConnections(dbName)
        this.verbose(`Dropping database '${dbName}'...`)

        const proc = Bun.spawn(
            [
                this.psqlPath,
                ...this.getPsqlArgs(),
                '-d',
                'postgres',
                '-c',
                `DROP DATABASE "${dbName}"`,
            ],
            {
                env: this.getEnv(),
                ...this.getStdioConfig(),
            },
        )
        const exitCode = await proc.exited
        if (exitCode !== 0) {
            throw new AdapterError(
                `Failed to drop database ${dbName}. Ensure no active sessions are connected.`,
            )
        }
        this.verbose(`Database '${dbName}' dropped`)
    }

    async renameDatabase(oldName: string, newName: string): Promise<void> {
        assertValidDbName(oldName)
        assertValidDbName(newName)
        this.verbose(`Terminating connections to '${oldName}'...`)
        await this.terminateConnections(oldName)
        this.verbose(`Renaming '${oldName}' to '${newName}'...`)

        const proc = Bun.spawn(
            [
                this.psqlPath,
                ...this.getPsqlArgs(),
                '-d',
                'postgres',
                '-c',
                `ALTER DATABASE "${oldName}" RENAME TO "${newName}"`,
            ],
            {
                env: this.getEnv(),
                ...this.getStdioConfig(),
            },
        )
        const exitCode = await proc.exited
        if (exitCode !== 0) {
            throw new AdapterError(
                `Failed to rename database. Ensure no active sessions are connected to '${oldName}'.`,
            )
        }
        this.verbose(`Database renamed to '${newName}'`)
    }

    async cloneDatabase(sourceName: string, targetName: string): Promise<void> {
        assertValidDbName(sourceName)
        assertValidDbName(targetName)
        this.verbose(`Cloning '${sourceName}' to '${targetName}'...`)

        const proc = Bun.spawn(
            [
                this.psqlPath,
                ...this.getPsqlArgs(),
                '-d',
                'postgres',
                '-c',
                `CREATE DATABASE "${targetName}" WITH TEMPLATE "${sourceName}"`,
            ],
            {
                env: this.getEnv(),
                ...this.getStdioConfig(),
            },
        )
        const exitCode = await proc.exited
        if (exitCode !== 0) {
            throw new AdapterError(
                `Failed to clone database. Ensure no active sessions are connected to '${sourceName}'.`,
            )
        }
        this.verbose(`Database cloned to '${targetName}'`)
    }

    async export(outputFile: string): Promise<void> {
        this.verbose(`Exporting '${this.config.database}' to '${outputFile}'...`)
        this.verbose(`Using pg_dump: ${this.pgDumpPath}`)

        const dumpProc = Bun.spawn(
            [this.pgDumpPath, ...this.getConnectionArgs(), '-f', outputFile, this.config.database],
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
                `pg_dump failed with exit code ${exitCode}${errorOutput ? `: ${errorOutput.trim()}` : ''}`,
            )
        }
        this.verbose(`Export completed: ${outputFile}`)
    }

    async import(inputFile: string, options?: { reset?: boolean }): Promise<void> {
        this.verbose(`Importing '${inputFile}' to '${this.config.database}'...`)

        if (options?.reset) {
            this.verbose('Resetting database (dropping public schema)...')
            const resetProc = Bun.spawn(
                [
                    this.psqlPath,
                    ...this.getPsqlArgs(),
                    '-d',
                    this.config.database,
                    '-c',
                    'DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO public;',
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

        this.verbose(`Running psql import from ${inputFile}...`)
        const psqlProc = Bun.spawn(
            [
                this.psqlPath,
                ...this.getConnectionArgs(),
                '-d',
                this.config.database,
                '-f',
                inputFile,
            ],
            {
                env: this.getEnv(),
                stdout: this.config.verbose ? 'inherit' : 'ignore',
                stderr: 'pipe',
            },
        )

        const exitCode = await psqlProc.exited
        if (exitCode !== 0) {
            const errorOutput = await new Response(psqlProc.stderr).text()
            throw new AdapterError(
                `psql failed with exit code ${exitCode}${errorOutput ? `: ${errorOutput.trim()}` : ''}`,
            )
        }
        this.verbose('Import completed successfully')
    }

    checkDependencies(): void {
        if (PostgresAdapter.dependenciesChecked) {
            return
        }

        const missing: string[] = []
        if (!Bun.which('psql')) missing.push('psql')
        if (!Bun.which('pg_dump')) missing.push('pg_dump')

        if (missing.length > 0) {
            const missingList = missing.map((tool) => `  ✖ ${tool}`).join('\n')
            note(
                `${missingList}\n\nPlease install PostgreSQL client tools to continue.`,
                '⚠️  Missing Required Tools',
            )

            throw new AdapterError(`Missing required tools: ${missing.join(', ')}`)
        }

        PostgresAdapter.dependenciesChecked = true
    }
}
