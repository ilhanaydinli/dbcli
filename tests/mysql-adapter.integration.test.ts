import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { MySQLAdapter } from '@/adapters/mysql-adapter'
import { AdapterError } from '@/errors'
import type { DbConfig } from '@/interfaces'
import { DbType } from '@/interfaces'

const TEST_DB_PREFIX = 'db_cli_test_'
const testDbName = `${TEST_DB_PREFIX}${Date.now()}`
const cloneDbName = `${testDbName}_clone`
const renameDbName = `${testDbName}_renamed`
const importDbName = `${testDbName}_import`

const testConfig: DbConfig = {
    id: 'test-connection',
    name: 'Test MySQL',
    type: DbType.MySQL,
    host: process.env.MYSQL_HOST!,
    port: parseInt(process.env.MYSQL_PORT!),
    user: process.env.MYSQL_USER!,
    password: process.env.MYSQL_PASSWORD!,
    database: process.env.MYSQL_DB!,
    ssl: false,
    verbose: false,
}

describe('MySQLAdapter Integration Tests', () => {
    let adapter: MySQLAdapter
    const createdDatabases: string[] = []

    beforeAll(() => {
        adapter = new MySQLAdapter(testConfig)
    })

    afterAll(async () => {
        for (const db of createdDatabases) {
            try {
                const cleanupAdapter = new MySQLAdapter({ ...testConfig, database: 'mysql' })
                await cleanupAdapter.dropDatabase(db)
            } catch {
                // Ignore cleanup errors
            }
        }
    })

    describe('checkDependencies', () => {
        it('should not throw when mysql and mysqldump are installed', () => {
            expect(() => adapter.checkDependencies()).not.toThrow()
        })
    })

    describe('testConnection', () => {
        it('should return true for valid connection', async () => {
            const result = await adapter.testConnection()
            expect(result).toBe(true)
        })

        it('should return false for invalid connection', async () => {
            const badAdapter = new MySQLAdapter({
                ...testConfig,
                host: 'invalid-host-that-does-not-exist',
            })
            const result = await badAdapter.testConnection()
            expect(result).toBe(false)
        })
    })

    describe('listDatabases', () => {
        it('should return an array of database info with names and sizes', async () => {
            const databases = await adapter.listDatabases()
            expect(Array.isArray(databases)).toBe(true)
            expect(databases[0]).toHaveProperty('name')
            expect(databases[0] ?? { size: '' }).toHaveProperty('size')
        })

        it('should not include system databases', async () => {
            const databases = await adapter.listDatabases()
            const names = databases.map((d) => d.name)
            expect(names).not.toContain('information_schema')
            expect(names).not.toContain('performance_schema')
            expect(names).not.toContain('mysql')
            expect(names).not.toContain('sys')
        })
    })

    describe('createDatabase', () => {
        it('should create a new database', async () => {
            await adapter.createDatabase(testDbName)
            createdDatabases.push(testDbName)

            const databases = await adapter.listDatabases()
            expect(databases.some((db) => db.name === testDbName)).toBe(true)
        })

        it('should throw for invalid database name', async () => {
            await expect(adapter.createDatabase('invalid-name!')).rejects.toThrow()
        })

        it('should throw when creating duplicate database', async () => {
            await expect(adapter.createDatabase(testDbName)).rejects.toThrow(AdapterError)
        })
    })

    describe('cloneDatabase', () => {
        it('should clone an existing database', async () => {
            await adapter.cloneDatabase(testDbName, cloneDbName)
            createdDatabases.push(cloneDbName)

            const databases = await adapter.listDatabases()
            expect(databases.some((db) => db.name === cloneDbName)).toBe(true)
        })
    })

    describe('renameDatabase', () => {
        it('should rename a database', async () => {
            await adapter.renameDatabase(cloneDbName, renameDbName)

            const idx = createdDatabases.indexOf(cloneDbName)
            if (idx !== -1) createdDatabases[idx] = renameDbName

            const databases = await adapter.listDatabases()
            expect(databases.some((db) => db.name === cloneDbName)).toBe(false)
            expect(databases.some((db) => db.name === renameDbName)).toBe(true)
        })
    })

    describe('export and import', () => {
        const exportFile = join(tmpdir(), `db_cli_test_export_${Date.now()}.sql`)

        afterAll(() => {
            if (existsSync(exportFile)) unlinkSync(exportFile)
        })

        it('should export database to file', async () => {
            const exportAdapter = new MySQLAdapter({ ...testConfig, database: testDbName })
            await exportAdapter.export(exportFile)

            expect(existsSync(exportFile)).toBe(true)
        })

        it('should import SQL file into database', async () => {
            await adapter.createDatabase(importDbName)
            createdDatabases.push(importDbName)

            const importAdapter = new MySQLAdapter({ ...testConfig, database: importDbName })
            await importAdapter.import(exportFile)
        })

        it('should import with reset option', async () => {
            const importAdapter = new MySQLAdapter({ ...testConfig, database: importDbName })
            await importAdapter.import(exportFile, { reset: true })
        })
    })

    describe('dropDatabase', () => {
        it('should drop an existing database', async () => {
            await adapter.dropDatabase(renameDbName)
            const idx = createdDatabases.indexOf(renameDbName)
            if (idx !== -1) createdDatabases.splice(idx, 1)

            const databases = await adapter.listDatabases()
            expect(databases.some((db) => db.name === renameDbName)).toBe(false)
        })

        it('should drop the test database', async () => {
            await adapter.dropDatabase(testDbName)
            const idx = createdDatabases.indexOf(testDbName)
            if (idx !== -1) createdDatabases.splice(idx, 1)

            const databases = await adapter.listDatabases()
            expect(databases.some((db) => db.name === testDbName)).toBe(false)
        })
    })
})
