import { note } from '@clack/prompts'
import * as os from 'os'
import * as path from 'path'

import { AdapterError } from '@/errors'
import { assertValidDbName, logInfo } from '@/helpers/utils'
import type { DatabaseAdapter, DatabaseInfo, DbConfig, ImportOptions } from '@/interfaces'

const CONNECTION_TIMEOUT_MS = 10000

export class MongoDbAdapter implements DatabaseAdapter {
    private static dependenciesChecked = false
    private mongoshPath = 'mongosh'
    private mongodumpPath = 'mongodump'
    private mongorestorePath = 'mongorestore'

    constructor(private config: DbConfig) {
        const mongosh = Bun.which('mongosh')
        const mongodump = Bun.which('mongodump')
        const mongorestore = Bun.which('mongorestore')

        if (mongosh) this.mongoshPath = mongosh
        if (mongodump) this.mongodumpPath = mongodump
        if (mongorestore) this.mongorestorePath = mongorestore
    }

    private getUri(dbName?: string): string {
        if (this.config.uri) {
            if (!dbName) return this.config.uri
            try {
                const url = new URL(this.config.uri)
                url.pathname = `/${dbName}`
                return url.toString()
            } catch {
                return this.config.uri
            }
        }

        const user = this.config.user ? encodeURIComponent(this.config.user) : ''
        const pass = this.config.password ? `:${encodeURIComponent(this.config.password)}` : ''
        const auth = user ? `${user}${pass}@` : ''
        const db = dbName || this.config.database || 'admin'
        const tls = this.config.ssl ? '?tls=true' : ''
        return `mongodb://${auth}${this.config.host}:${this.config.port}/${db}${tls}`
    }

    private getHostUri(): string {
        if (this.config.uri) {
            try {
                const url = new URL(this.config.uri)
                url.pathname = '/'
                return url.toString()
            } catch {
                return this.config.uri
            }
        }

        const user = this.config.user ? encodeURIComponent(this.config.user) : ''
        const pass = this.config.password ? `:${encodeURIComponent(this.config.password)}` : ''
        const auth = user ? `${user}${pass}@` : ''
        const tls = this.config.ssl ? '?tls=true' : ''
        return `mongodb://${auth}${this.config.host}:${this.config.port}/${tls}`
    }

    private verbose(message: string): void {
        if (this.config.verbose) {
            logInfo(`[MongoDB] ${message}`)
        }
    }

    async testConnection(): Promise<boolean> {
        try {
            this.verbose(
                `Connecting to ${this.config.uri || `${this.config.host}:${this.config.port}`}...`,
            )

            const proc = Bun.spawn(
                [
                    this.mongoshPath,
                    this.getUri(),
                    '--quiet',
                    '--eval',
                    'db.runCommand({ ping: 1 })',
                ],
                {
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

    async listDatabases(): Promise<DatabaseInfo[]> {
        this.verbose('Fetching database list...')

        const proc = Bun.spawn(
            [
                this.mongoshPath,
                this.getUri('admin'),
                '--quiet',
                '--eval',
                'JSON.stringify(db.adminCommand({ listDatabases: 1 }).databases.map(d => ({ name: d.name, size: d.sizeOnDisk })))',
            ],
            {
                stdout: 'pipe',
                stderr: this.config.verbose ? 'inherit' : 'ignore',
            },
        )

        const output = await new Response(proc.stdout).text()
        const exitCode = await proc.exited

        if (exitCode !== 0) {
            throw new AdapterError(`Failed to list databases (exit code ${exitCode})`)
        }

        const jsonLine = output
            .split('\n')
            .map((l) => l.trim())
            .find((l) => l.startsWith('['))

        if (!jsonLine) {
            return []
        }

        const parsed: Array<{ name: string; size: number }> = JSON.parse(jsonLine)

        const databases = parsed
            .filter((db) => !['admin', 'local', 'config'].includes(db.name))
            .map((db) => ({
                name: db.name,
                size: db.size > 0 ? formatBytes(db.size) : 'N/A',
            }))

        this.verbose(`Found ${databases.length} databases`)
        return databases
    }

    async getLocales(): Promise<{ locales: string[]; default: string }> {
        return { locales: [], default: '' }
    }

    async createDatabase(dbName: string): Promise<void> {
        assertValidDbName(dbName)
        this.verbose(`Creating database '${dbName}'...`)

        const proc = Bun.spawn(
            [
                this.mongoshPath,
                this.getUri(dbName),
                '--quiet',
                '--eval',
                'db.createCollection("_init")',
            ],
            {
                stdout: this.config.verbose ? 'inherit' : 'ignore',
                stderr: this.config.verbose ? 'inherit' : 'ignore',
            },
        )

        const exitCode = await proc.exited
        if (exitCode !== 0) {
            throw new AdapterError(`Failed to create database '${dbName}' (exit code ${exitCode})`)
        }
        this.verbose(`Database '${dbName}' created`)
    }

    async dropDatabase(dbName: string): Promise<void> {
        assertValidDbName(dbName)
        this.verbose(`Dropping database '${dbName}'...`)

        const proc = Bun.spawn(
            [this.mongoshPath, this.getUri(dbName), '--quiet', '--eval', 'db.dropDatabase()'],
            {
                stdout: this.config.verbose ? 'inherit' : 'ignore',
                stderr: this.config.verbose ? 'inherit' : 'ignore',
            },
        )

        const exitCode = await proc.exited
        if (exitCode !== 0) {
            throw new AdapterError(`Failed to drop database '${dbName}' (exit code ${exitCode})`)
        }
        this.verbose(`Database '${dbName}' dropped`)
    }

    async renameDatabase(oldName: string, newName: string): Promise<void> {
        assertValidDbName(oldName)
        assertValidDbName(newName)
        this.verbose(`Renaming '${oldName}' to '${newName}' (dump → restore → drop)...`)

        const tmpFile = path.join(os.tmpdir(), `mongo_rename_${Date.now()}.archive`)

        await this.dumpDatabase(oldName, tmpFile)
        await this.restoreDatabase(tmpFile, oldName, newName)
        await this.dropDatabase(oldName)

        await Bun.file(tmpFile)
            .exists()
            .then((exists) => {
                if (exists) Bun.spawn(['rm', tmpFile])
            })

        this.verbose(`Database renamed to '${newName}'`)
    }

    async cloneDatabase(sourceName: string, targetName: string): Promise<void> {
        assertValidDbName(sourceName)
        assertValidDbName(targetName)
        this.verbose(`Cloning '${sourceName}' to '${targetName}'...`)

        const tmpFile = path.join(os.tmpdir(), `mongo_clone_${Date.now()}.archive`)

        await this.dumpDatabase(sourceName, tmpFile)
        await this.restoreDatabase(tmpFile, sourceName, targetName)

        await Bun.file(tmpFile)
            .exists()
            .then((exists) => {
                if (exists) Bun.spawn(['rm', tmpFile])
            })

        this.verbose(`Database cloned to '${targetName}'`)
    }

    async export(outputFile: string): Promise<void> {
        this.verbose(`Exporting '${this.config.database}' to '${outputFile}'...`)
        await this.dumpDatabase(this.config.database, outputFile)
        this.verbose(`Export completed: ${outputFile}`)
    }

    async import(inputFile: string, options?: ImportOptions): Promise<void> {
        this.verbose(`Importing '${inputFile}' into '${this.config.database}'...`)

        const args = [
            this.mongorestorePath,
            `--uri=${this.getHostUri()}`,
            `--archive=${inputFile}`,
            `--nsInclude=${this.config.database}.*`,
        ]

        if (options?.reset) {
            args.push('--drop')
            this.verbose('Drop mode enabled (--drop)')
        }

        const proc = Bun.spawn(args, {
            stdout: this.config.verbose ? 'inherit' : 'ignore',
            stderr: 'pipe',
        })

        const [exitCode, errorOutput] = await Promise.all([
            proc.exited,
            new Response(proc.stderr).text(),
        ])

        if (exitCode !== 0) {
            throw new AdapterError(
                `mongorestore failed with exit code ${exitCode}${errorOutput ? `: ${errorOutput.trim()}` : ''}`,
            )
        }
        this.verbose('Import completed successfully')
    }

    private async dumpDatabase(dbName: string, archiveFile: string): Promise<void> {
        const proc = Bun.spawn(
            [
                this.mongodumpPath,
                `--uri=${this.getHostUri()}`,
                `--db=${dbName}`,
                `--archive=${archiveFile}`,
            ],
            {
                stdout: this.config.verbose ? 'inherit' : 'ignore',
                stderr: 'pipe',
            },
        )

        const [exitCode, errorOutput] = await Promise.all([
            proc.exited,
            new Response(proc.stderr).text(),
        ])

        if (exitCode !== 0) {
            throw new AdapterError(
                `mongodump failed with exit code ${exitCode}${errorOutput ? `: ${errorOutput.trim()}` : ''}`,
            )
        }
    }

    private async restoreDatabase(
        archiveFile: string,
        fromDb: string,
        toDb: string,
    ): Promise<void> {
        const proc = Bun.spawn(
            [
                this.mongorestorePath,
                `--uri=${this.getHostUri()}`,
                `--archive=${archiveFile}`,
                `--nsFrom=${fromDb}.*`,
                `--nsTo=${toDb}.*`,
            ],
            {
                stdout: this.config.verbose ? 'inherit' : 'ignore',
                stderr: 'pipe',
            },
        )

        const [exitCode, errorOutput] = await Promise.all([
            proc.exited,
            new Response(proc.stderr).text(),
        ])

        if (exitCode !== 0) {
            throw new AdapterError(
                `mongorestore failed with exit code ${exitCode}${errorOutput ? `: ${errorOutput.trim()}` : ''}`,
            )
        }
    }

    checkDependencies(): void {
        if (MongoDbAdapter.dependenciesChecked) {
            return
        }

        const missing: string[] = []
        if (!Bun.which('mongosh')) missing.push('mongosh')
        if (!Bun.which('mongodump')) missing.push('mongodump')
        if (!Bun.which('mongorestore')) missing.push('mongorestore')

        if (missing.length > 0) {
            const missingList = missing.map((tool) => `  ✖ ${tool}`).join('\n')
            note(
                `${missingList}\n\nPlease install MongoDB Shell and MongoDB Database Tools to continue.`,
                '⚠️  Missing Required Tools',
            )

            throw new AdapterError(`Missing required tools: ${missing.join(', ')}`)
        }

        MongoDbAdapter.dependenciesChecked = true
    }
}

function formatBytes(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB']
    let i = 0
    let size = bytes
    while (size >= 1024 && i < units.length - 1) {
        size /= 1024
        i++
    }
    return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}
