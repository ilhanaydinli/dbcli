import { note } from '@clack/prompts'
import { cpus, totalmem } from 'os'

import { ConfigManager } from '@/core/config-manager'
import { AdapterError } from '@/errors'
import { assertValidDbName, logInfo, logWarn } from '@/helpers/utils'
import type { DatabaseAdapter, DatabaseInfo, DbConfig } from '@/interfaces'

const CONNECTION_TIMEOUT_MS = 10000

function shQuote(s: string): string {
    if (s.length === 0) return "''"
    if (/^[a-zA-Z0-9_.\-/=]+$/.test(s)) return s
    return `'${s.replace(/'/g, "'\\''")}'`
}

function tunedMaintenanceWorkMemMB(): number {
    const quarterRam = Math.floor(totalmem() / 4)
    const maxBytes = 8 * 1024 * 1024 * 1024
    const minBytes = 1 * 1024 * 1024 * 1024
    const target = Math.max(minBytes, Math.min(maxBytes, quarterRam))
    return Math.floor(target / (1024 * 1024))
}

// Strips \restrict/\unrestrict (PG17+), drops CREATE INDEX (multi-line, COPY-aware), keeps CREATE UNIQUE INDEX.
function buildFastImportPerlScript(): string {
    return [
        'BEGIN { our $skip = 0; our $in_copy = 0; }',
        'if ($in_copy) {',
        '  my $s = $_; chomp $s;',
        "  $in_copy = 0 if $s eq '\\\\.';",
        '  print; next;',
        '}',
        'if (/^COPY .+ FROM stdin/) { $in_copy = 1; print; next; }',
        'if ($skip) { $skip = 0 if /;\\s*$/; next; }',
        'if (/^CREATE\\s+INDEX\\b/i) { $skip = 1 unless /;\\s*$/; next; }',
        's/^\\\\(un)?restrict\\b.*//;',
        'print;',
    ].join(' ')
}

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

        await this.preCreateMissingRoles(inputFile)

        const fastImport = ConfigManager.getInstance().getPreference('fastImport') ?? false

        if (fastImport) {
            await this.importFastMode(inputFile)
        } else {
            await this.importStandard(inputFile)
        }
    }

    private async importFastMode(inputFile: string): Promise<void> {
        if (!Bun.which('pg_ctl')) {
            throw new AdapterError(
                'Fast Import Mode requires "pg_ctl" in PATH (LOCAL PG only). ' +
                    'Disable in Settings or install pg_ctl.',
            )
        }
        if (!Bun.which('perl')) {
            throw new AdapterError(
                'Fast Import Mode requires "perl" in PATH. ' +
                    'Disable in Settings or install perl.',
            )
        }

        let dataDir: string
        try {
            dataDir = await this.getDataDirectory()
        } catch (e) {
            throw new AdapterError(
                `Could not query data_directory: ${(e as Error).message}\n` +
                    'Fast Import Mode works only with LOCAL PostgreSQL — disable in Settings if the target is managed (Cloud SQL/RDS/etc.).',
            )
        }

        const ramQuarterMB = tunedMaintenanceWorkMemMB()
        logInfo(
            `[PostgreSQL] Fast Import Mode ON (LOCAL) — data_directory=${dataDir}, shared_buffers=${ramQuarterMB}MB`,
        )

        let aggressiveApplied = false
        try {
            await this.applyAggressiveSettings(ramQuarterMB)
            aggressiveApplied = true

            logInfo('[PostgreSQL] Restarting server with import-optimized settings...')
            await this.pgCtlRestart(dataDir)

            await this.runFastPipeline(inputFile, ramQuarterMB)
        } finally {
            if (aggressiveApplied) {
                try {
                    logInfo('[PostgreSQL] Restoring server settings...')
                    await this.resetAggressiveSettings()
                    await this.pgCtlRestart(dataDir)
                    logInfo('[PostgreSQL] Server settings restored.')
                } catch (e) {
                    logWarn(
                        `[PostgreSQL] FAILED to restore server settings: ${(e as Error).message}\n` +
                            'Run manually: psql -c "ALTER SYSTEM RESET ALL" && pg_ctl restart.',
                    )
                }
            }
        }
    }

    private async getDataDirectory(): Promise<string> {
        const proc = Bun.spawn(
            [
                this.psqlPath,
                ...this.getPsqlArgs(),
                '-d',
                this.config.database,
                '-t',
                '-A',
                '-c',
                'SHOW data_directory;',
            ],
            { env: this.getEnv(), stdout: 'pipe', stderr: 'pipe' },
        )
        const output = await new Response(proc.stdout).text()
        const exit = await proc.exited
        if (exit !== 0) {
            const err = await new Response(proc.stderr).text()
            throw new Error(err.trim() || `psql exit ${exit}`)
        }
        const dir = output.trim()
        if (!dir) {
            throw new Error('SHOW data_directory returned empty result')
        }
        return dir
    }

    private buildAggressiveSetStatements(sharedBuffersMB: number): string[] {
        return [
            'ALTER SYSTEM SET fsync = off',
            'ALTER SYSTEM SET full_page_writes = off',
            'ALTER SYSTEM SET autovacuum = off',
            'ALTER SYSTEM SET synchronous_commit = off',
            "ALTER SYSTEM SET max_wal_size = '64GB'",
            'ALTER SYSTEM SET checkpoint_completion_target = 0.95',
            'ALTER SYSTEM SET wal_level = minimal',
            'ALTER SYSTEM SET max_wal_senders = 0',
            'ALTER SYSTEM SET archive_mode = off',
            `ALTER SYSTEM SET shared_buffers = '${sharedBuffersMB}MB'`,
        ]
    }

    private static readonly AGGRESSIVE_RESET_STATEMENTS = [
        'ALTER SYSTEM RESET fsync',
        'ALTER SYSTEM RESET full_page_writes',
        'ALTER SYSTEM RESET autovacuum',
        'ALTER SYSTEM RESET synchronous_commit',
        'ALTER SYSTEM RESET max_wal_size',
        'ALTER SYSTEM RESET checkpoint_completion_target',
        'ALTER SYSTEM RESET wal_level',
        'ALTER SYSTEM RESET max_wal_senders',
        'ALTER SYSTEM RESET archive_mode',
        'ALTER SYSTEM RESET shared_buffers',
    ]

    private async applyAggressiveSettings(sharedBuffersMB: number): Promise<void> {
        // ALTER SYSTEM cannot run inside a transaction. psql -c "stmt1; stmt2"
        // wraps the whole string in a transaction; multiple -c flags run each
        // independently in autocommit mode.
        const args = [this.psqlPath, ...this.getPsqlArgs(), '-d', 'postgres']
        for (const stmt of this.buildAggressiveSetStatements(sharedBuffersMB)) {
            args.push('-c', stmt)
        }
        const proc = Bun.spawn(args, {
            env: this.getEnv(),
            stdout: 'ignore',
            stderr: 'pipe',
        })
        const exit = await proc.exited
        if (exit !== 0) {
            const err = await new Response(proc.stderr).text()
            throw new AdapterError(
                `ALTER SYSTEM failed (exit ${exit}): ${err.trim()}\n` +
                    'Likely cause: target PG is managed (Cloud SQL/RDS) and disallows ALTER SYSTEM.',
            )
        }
    }

    private async resetAggressiveSettings(): Promise<void> {
        const args = [this.psqlPath, ...this.getPsqlArgs(), '-d', 'postgres']
        for (const stmt of PostgresAdapter.AGGRESSIVE_RESET_STATEMENTS) {
            args.push('-c', stmt)
        }
        const proc = Bun.spawn(args, {
            env: this.getEnv(),
            stdout: 'ignore',
            stderr: 'pipe',
        })
        const exit = await proc.exited
        if (exit !== 0) {
            const err = await new Response(proc.stderr).text()
            throw new Error(err.trim() || `psql exit ${exit}`)
        }
    }

    private async pgCtlRestart(dataDir: string): Promise<void> {
        const proc = Bun.spawn(['pg_ctl', '-D', dataDir, 'restart', '-m', 'fast', '-w'], {
            stdout: this.config.verbose ? 'inherit' : 'ignore',
            stderr: 'pipe',
        })
        const exit = await proc.exited
        if (exit !== 0) {
            const err = await new Response(proc.stderr).text()
            throw new Error(`pg_ctl restart failed (exit ${exit}): ${err.trim()}`)
        }
    }

    private async preCreateMissingRoles(inputFile: string): Promise<void> {
        if (!Bun.which('perl')) {
            this.verbose('perl not found in PATH; skipping role pre-create.')
            return
        }

        this.verbose('Scanning dump for role references...')

        // [^"\s;]+ matches role names with dots, hyphens, etc. (e.g. "user.name")
        // All patterns run independently so a line containing both ALTER DEFAULT
        // PRIVILEGES FOR ROLE x ... GRANT ... TO y captures both x and y.
        const perlScript =
            'if (/OWNER TO\\s+"?([^"\\s;]+)"?\\s*;/) { print "$1\\n" }' +
            ' if (/GRANT [^;]+ TO\\s+"?([^"\\s;]+)"?\\s*;/) { print "$1\\n" }' +
            ' if (/REVOKE [^;]+ FROM\\s+"?([^"\\s;]+)"?\\s*;/) { print "$1\\n" }' +
            ' if (/ALTER DEFAULT PRIVILEGES FOR ROLE\\s+"?([^"\\s;]+)"?/) { print "$1\\n" }'

        const scanCmd = `perl -ne ${shQuote(perlScript)} < ${shQuote(inputFile)} | sort -u`
        const scanProc = Bun.spawn(['sh', '-c', scanCmd], {
            stdout: 'pipe',
            stderr: 'pipe',
        })
        const scanOutput = await new Response(scanProc.stdout).text()
        const scanExit = await scanProc.exited
        if (scanExit !== 0) {
            this.verbose('Could not scan dump for roles; proceeding without pre-create.')
            return
        }

        const referencedRoles = scanOutput
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean)
            .filter((r) => r !== 'PUBLIC' && r !== this.config.user)

        if (referencedRoles.length === 0) {
            this.verbose('No external roles referenced in dump.')
            return
        }

        const existingRoles = await this.getExistingRoles()
        const missing = referencedRoles.filter((r) => !existingRoles.includes(r))

        if (missing.length === 0) {
            this.verbose(`All ${referencedRoles.length} referenced roles already exist.`)
            return
        }

        logInfo(
            `[PostgreSQL] Pre-creating ${missing.length} missing role(s): ${missing.join(', ')}`,
        )

        const createSql = missing.map((r) => `CREATE ROLE "${r}";`).join(' ')
        const createProc = Bun.spawn(
            [this.psqlPath, ...this.getPsqlArgs(), '-d', this.config.database, '-c', createSql],
            { env: this.getEnv(), stdout: 'ignore', stderr: 'pipe' },
        )

        const createExit = await createProc.exited
        if (createExit !== 0) {
            const err = await new Response(createProc.stderr).text()
            logWarn(
                `[PostgreSQL] Could not pre-create some roles (need CREATEROLE privilege?). Import may fail.\n${err.trim()}`,
            )
        }
    }

    private async getExistingRoles(): Promise<string[]> {
        const proc = Bun.spawn(
            [
                this.psqlPath,
                ...this.getPsqlArgs(),
                '-d',
                this.config.database,
                '-t',
                '-A',
                '-c',
                'SELECT rolname FROM pg_roles ORDER BY rolname;',
            ],
            { env: this.getEnv(), stdout: 'pipe', stderr: 'pipe' },
        )

        const output = await new Response(proc.stdout).text()
        const exit = await proc.exited
        if (exit !== 0) return []
        return output
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean)
    }

    private async importStandard(inputFile: string): Promise<void> {
        this.verbose(`Running psql import from ${inputFile}...`)
        const psqlProc = Bun.spawn(
            [this.psqlPath, ...this.getPsqlArgs(), '-d', this.config.database, '-f', inputFile],
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

    private async runFastPipeline(inputFile: string, memMB: number): Promise<void> {
        const workers = Math.min(8, Math.max(2, cpus().length))
        const skipIndexes = ConfigManager.getInstance().getPreference('skipIndexes') ?? false

        logInfo(
            `[PostgreSQL] Tuning: maintenance_work_mem=${memMB}MB, parallel_workers=${workers}.`,
        )
        if (skipIndexes) {
            logInfo('[PostgreSQL] Skip Indexes ON — secondary CREATE INDEX statements omitted.')
        }

        const perlInvocation = skipIndexes
            ? `perl -ne ${shQuote(buildFastImportPerlScript())}`
            : `perl -pe ${shQuote('s/^\\\\(un)?restrict\\b.*//')}`

        const psqlArgs = [
            ...this.getPsqlArgs(),
            '-d',
            this.config.database,
            '--single-transaction',
            '-c',
            'SET synchronous_commit = OFF',
            '-c',
            `SET maintenance_work_mem = '${memMB}MB'`,
            '-c',
            "SET work_mem = '1GB'",
            '-c',
            'SET session_replication_role = replica',
            '-c',
            `SET max_parallel_maintenance_workers = ${workers}`,
            '-f',
            '-',
        ]

        const cmd =
            `${perlInvocation} < ${shQuote(inputFile)} | ` +
            [shQuote(this.psqlPath), ...psqlArgs.map(shQuote)].join(' ')

        const proc = Bun.spawn(['sh', '-c', cmd], {
            env: this.getEnv(),
            stdout: this.config.verbose ? 'inherit' : 'ignore',
            stderr: 'pipe',
        })

        const [exitCode, stderr] = await Promise.all([
            proc.exited,
            new Response(proc.stderr).text(),
        ])

        if (exitCode !== 0) {
            const cleaned = stderr
                .split('\n')
                .filter((line) => !line.includes('Broken pipe'))
                .join('\n')
                .trim()
            throw new AdapterError(
                `psql failed with exit code ${exitCode}${cleaned ? `: ${cleaned}` : ''}`,
            )
        }

        logInfo('[PostgreSQL] Fast Import Mode pipeline completed.')
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
