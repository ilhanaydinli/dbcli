import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { MongoDbAdapter } from '@/adapters/mongodb-adapter'
import type { DbConfig } from '@/interfaces'
import { DbType } from '@/interfaces'

const TEST_DB_PREFIX = 'db_cli_mongo_test_'
const testDbName = `${TEST_DB_PREFIX}${Date.now()}`
const seedDbName = `${TEST_DB_PREFIX}seed_${Date.now()}`
const cloneDbName = `${testDbName}_clone`
const renameDbName = `${testDbName}_renamed`
const importDbName = `${testDbName}_import`

const testConfig: DbConfig = {
    id: 'test-mongo-connection',
    name: 'Test MongoDB',
    type: DbType.MongoDB,
    host: process.env.MONGO_HOST ?? 'localhost',
    port: parseInt(process.env.MONGO_PORT ?? '27017'),
    user: process.env.MONGO_USER ?? '',
    password: process.env.MONGO_PASSWORD ?? '',
    database: process.env.MONGO_DB ?? 'admin',
    ssl: false,
    verbose: false,
    uri: process.env.MONGO_URI,
}

describe('MongoDbAdapter Integration Tests', () => {
    let adapter: MongoDbAdapter
    const createdDatabases: string[] = []

    beforeAll(async () => {
        adapter = new MongoDbAdapter(testConfig)
        await adapter.createDatabase(seedDbName)
        createdDatabases.push(seedDbName)
    })

    afterAll(async () => {
        for (const db of createdDatabases) {
            try {
                await adapter.dropDatabase(db)
            } catch {
                // Ignore cleanup errors
            }
        }
    })

    describe('checkDependencies', () => {
        it('should not throw when mongosh and mongodump are installed', () => {
            expect(() => adapter.checkDependencies()).not.toThrow()
        })
    })

    describe('testConnection', () => {
        it('should return true for valid connection', async () => {
            const result = await adapter.testConnection()
            expect(result).toBe(true)
        })

        it('should return false for invalid connection', async () => {
            const badAdapter = new MongoDbAdapter({
                ...testConfig,
                host: 'invalid-host-that-does-not-exist',
                uri: undefined,
            })
            const result = await badAdapter.testConnection()
            expect(result).toBe(false)
        }, 15000)
    })

    describe('getLocales', () => {
        it('should return empty locales for MongoDB', async () => {
            const result = await adapter.getLocales()
            expect(result.locales).toEqual([])
            expect(result.default).toBe('')
        })
    })

    describe('listDatabases', () => {
        it('should return an array of database info with names and sizes', async () => {
            const databases = await adapter.listDatabases()
            expect(Array.isArray(databases)).toBe(true)
            expect(databases[0]).toHaveProperty('name')
            expect(databases[0]).toHaveProperty('size')
        })

        it('should not include system databases', async () => {
            const databases = await adapter.listDatabases()
            const names = databases.map((db) => db.name)
            expect(names).not.toContain('admin')
            expect(names).not.toContain('local')
            expect(names).not.toContain('config')
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
            await expect(adapter.createDatabase('invalid name!')).rejects.toThrow()
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
        const exportFile = join(tmpdir(), `db_cli_mongo_export_${Date.now()}.archive`)

        afterAll(() => {
            if (existsSync(exportFile)) unlinkSync(exportFile)
        })

        it('should export database to archive file', async () => {
            const exportAdapter = new MongoDbAdapter({ ...testConfig, database: testDbName })
            await exportAdapter.export(exportFile)

            expect(existsSync(exportFile)).toBe(true)
        })

        it('should import archive file into database', async () => {
            await adapter.createDatabase(importDbName)
            createdDatabases.push(importDbName)

            const importAdapter = new MongoDbAdapter({ ...testConfig, database: importDbName })
            await importAdapter.import(exportFile)
        })

        it('should import with reset option', async () => {
            const importAdapter = new MongoDbAdapter({ ...testConfig, database: importDbName })
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

        it('should throw for invalid database name', async () => {
            await expect(adapter.dropDatabase('invalid name!')).rejects.toThrow()
        })
    })
})
