import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, unlinkSync } from 'fs'
import sql from 'mssql'
import { tmpdir } from 'os'
import { join } from 'path'

import { MSSQLAdapter } from '@/adapters/mssql-adapter'
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
    name: 'Test MSSQL',
    type: DbType.MSSQL,
    host: process.env.MSSQL_HOST!,
    port: parseInt(process.env.MSSQL_PORT!),
    user: process.env.MSSQL_USER!,
    password: process.env.MSSQL_PASSWORD!,
    database: process.env.MSSQL_DB!,
    ssl: false,
    verbose: false,
}

async function seedTestData(dbName: string): Promise<void> {
    const pool = await sql.connect({
        server: testConfig.host,
        port: testConfig.port,
        user: testConfig.user,
        password: testConfig.password,
        database: dbName,
        options: { encrypt: false, trustServerCertificate: true },
    })
    try {
        await pool.request().batch(`
            CREATE SCHEMA app;
        `)
        await pool.request().batch(`
            CREATE TABLE users (
                id INT IDENTITY(1,1) PRIMARY KEY,
                first_name NVARCHAR(50) NOT NULL,
                last_name NVARCHAR(50) NOT NULL,
                email NVARCHAR(200) NULL,
                full_name AS (first_name + N' ' + last_name) PERSISTED,
                CONSTRAINT CK_users_email CHECK (email IS NULL OR email LIKE '%@%')
            );
            CREATE TABLE posts (
                id INT IDENTITY(1,1) PRIMARY KEY,
                user_id INT NOT NULL,
                title NVARCHAR(200) NOT NULL,
                body NVARCHAR(MAX) NULL,
                vote_count INT NOT NULL DEFAULT 0,
                CONSTRAINT FK_posts_users FOREIGN KEY (user_id) REFERENCES users(id),
                CONSTRAINT CK_posts_votes CHECK (vote_count >= 0)
            );
            CREATE TABLE empty_table (
                id INT IDENTITY(1,1) PRIMARY KEY,
                placeholder NVARCHAR(50) NULL
            );
            CREATE TABLE app.audit_log (
                id BIGINT IDENTITY(1,1) PRIMARY KEY,
                actor NVARCHAR(100) NOT NULL,
                action_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
            );
            CREATE TABLE wide_types (
                id INT IDENTITY(1,1) PRIMARY KEY,
                bit_col BIT NOT NULL,
                bigint_col BIGINT NOT NULL,
                decimal_col DECIMAL(18,4) NOT NULL,
                money_col MONEY NOT NULL,
                date_col DATE NOT NULL,
                datetime2_col DATETIME2 NOT NULL,
                varbinary_col VARBINARY(16) NULL,
                guid_col UNIQUEIDENTIFIER NOT NULL,
                nullable_col NVARCHAR(50) NULL
            );
            INSERT INTO users (first_name, last_name, email) VALUES
                (N'Alice', N'Smith', N'alice@example.com'),
                (N'Bob', N'Jones', NULL),
                (N'Çağlar', N'Yılmaz', N'caglar@example.com'),
                (N'O''Brien', N'D''Angelo', N'obrien@example.com');
            CREATE UNIQUE INDEX UX_posts_title ON posts(title);
            INSERT INTO posts (user_id, title, body, vote_count) VALUES
                (1, N'Hello', N'World', 5),
                (2, N'Test ''with'' quotes', NULL, 0),
                (3, N'Tricky', N'Body has '' apostrophes and ; semicolons -- and SQL comments', 12);
            INSERT INTO app.audit_log (actor) VALUES (N'system'), (N'admin');
            INSERT INTO wide_types (bit_col, bigint_col, decimal_col, money_col, date_col, datetime2_col, varbinary_col, guid_col, nullable_col)
            VALUES
                (1, 9223372036854775000, 1234.5678, 99.99, '2024-01-15', '2024-01-15 10:30:45.123', 0xDEADBEEF, '11111111-2222-3333-4444-555555555555', N'present'),
                (0, -1, 0.0001, 0.00, '1999-12-31', '1999-12-31 23:59:59.999', NULL, '00000000-0000-0000-0000-000000000000', NULL);
            -- Push identity counter forward to verify reseed (insert + delete leaves gap)
            INSERT INTO empty_table (placeholder) VALUES (N'temp1'), (N'temp2'), (N'temp3'), (N'temp4'), (N'temp5');
            DELETE FROM empty_table;
        `)
    } finally {
        await pool.close()
    }
}

interface RowSnapshot {
    users: Array<{
        first_name: string
        last_name: string
        email: string | null
        full_name: string
    }>
    posts: Array<{ title: string; body: string | null; vote_count: number }>
    auditLog: Array<{ actor: string }>
    wideTypes: Array<Record<string, unknown>>
}

async function snapshotData(dbName: string): Promise<RowSnapshot> {
    const pool = await sql.connect({
        server: testConfig.host,
        port: testConfig.port,
        user: testConfig.user,
        password: testConfig.password,
        database: dbName,
        options: { encrypt: false, trustServerCertificate: true },
    })
    try {
        const usersResult = await pool.request().query<{
            first_name: string
            last_name: string
            email: string | null
            full_name: string
        }>('SELECT first_name, last_name, email, full_name FROM users ORDER BY id;')
        const postsResult = await pool.request().query<{
            title: string
            body: string | null
            vote_count: number
        }>('SELECT title, body, vote_count FROM posts ORDER BY id;')
        const auditResult = await pool
            .request()
            .query<{ actor: string }>('SELECT actor FROM app.audit_log ORDER BY id;')
        const wideResult = await pool
            .request()
            .query<
                Record<string, unknown>
            >('SELECT bit_col, bigint_col, decimal_col, money_col, date_col, datetime2_col, varbinary_col, guid_col, nullable_col FROM wide_types ORDER BY id;')
        return {
            users: usersResult.recordset,
            posts: postsResult.recordset,
            auditLog: auditResult.recordset,
            wideTypes: wideResult.recordset,
        }
    } finally {
        await pool.close()
    }
}

async function execScalar<T = unknown>(dbName: string, query: string): Promise<T> {
    const pool = await sql.connect({
        server: testConfig.host,
        port: testConfig.port,
        user: testConfig.user,
        password: testConfig.password,
        database: dbName,
        options: { encrypt: false, trustServerCertificate: true },
    })
    try {
        const result = await pool.request().query<Record<string, T>>(query)
        const firstRow = result.recordset[0]
        const firstKey = Object.keys(firstRow)[0]
        return firstRow[firstKey]
    } finally {
        await pool.close()
    }
}

async function tryExec(
    dbName: string,
    query: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
    const pool = await sql.connect({
        server: testConfig.host,
        port: testConfig.port,
        user: testConfig.user,
        password: testConfig.password,
        database: dbName,
        options: { encrypt: false, trustServerCertificate: true },
    })
    try {
        await pool.request().batch(query)
        return { ok: true }
    } catch (error) {
        return { ok: false, error: (error as Error).message }
    } finally {
        await pool.close()
    }
}

async function countRows(dbName: string, table: string): Promise<number> {
    const pool = await sql.connect({
        server: testConfig.host,
        port: testConfig.port,
        user: testConfig.user,
        password: testConfig.password,
        database: dbName,
        options: { encrypt: false, trustServerCertificate: true },
    })
    try {
        const result = await pool
            .request()
            .query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table};`)
        return Number(result.recordset[0].n)
    } finally {
        await pool.close()
    }
}

describe('MSSQLAdapter Integration Tests', () => {
    let adapter: MSSQLAdapter
    const createdDatabases: string[] = []

    beforeAll(() => {
        adapter = new MSSQLAdapter(testConfig)
    })

    afterAll(async () => {
        for (const db of createdDatabases) {
            try {
                const cleanupAdapter = new MSSQLAdapter({ ...testConfig, database: 'master' })
                await cleanupAdapter.dropDatabase(db)
            } catch {
                /* ignore cleanup errors */
            }
        }
    })

    describe('checkDependencies', () => {
        it('should not throw when mssql package is installed', () => {
            expect(() => adapter.checkDependencies()).not.toThrow()
        })
    })

    describe('testConnection', () => {
        it('should return true for valid connection', async () => {
            const result = await adapter.testConnection()
            expect(result).toBe(true)
        })

        it('should return false for invalid connection', async () => {
            const badAdapter = new MSSQLAdapter({
                ...testConfig,
                password: 'wrong-password-xyz',
            })
            const result = await badAdapter.testConnection()
            expect(result).toBe(false)
        })
    })

    describe('getLocales', () => {
        it('should return a non-empty list of collations and a default', async () => {
            const result = await adapter.getLocales()
            expect(Array.isArray(result.locales)).toBe(true)
            expect(result.locales.length).toBeGreaterThan(0)
            expect(result.default.length).toBeGreaterThan(0)
            expect(result.locales).toContain(result.default)
        })
    })

    describe('listDatabases', () => {
        it('should return an array of database info with names and sizes', async () => {
            const databases = await adapter.listDatabases()
            expect(Array.isArray(databases)).toBe(true)
        })

        it('should not include system databases', async () => {
            const databases = await adapter.listDatabases()
            const names = databases.map((d) => d.name)
            expect(names).not.toContain('master')
            expect(names).not.toContain('tempdb')
            expect(names).not.toContain('model')
            expect(names).not.toContain('msdb')
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
    })

    describe('cloneDatabase', () => {
        beforeAll(async () => {
            await seedTestData(testDbName)
        })

        it('should clone an existing database with data', async () => {
            await adapter.cloneDatabase(testDbName, cloneDbName)
            createdDatabases.push(cloneDbName)

            const databases = await adapter.listDatabases()
            expect(databases.some((db) => db.name === cloneDbName)).toBe(true)

            const userCount = await countRows(cloneDbName, 'users')
            const postCount = await countRows(cloneDbName, 'posts')
            expect(userCount).toBe(4)
            expect(postCount).toBe(3)
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
            const exportAdapter = new MSSQLAdapter({ ...testConfig, database: testDbName })
            await exportAdapter.export(exportFile)

            expect(existsSync(exportFile)).toBe(true)
            const file = Bun.file(exportFile)
            expect(file.size).toBeGreaterThan(0)
            const content = await file.text()
            expect(content).toContain('CREATE TABLE')
            expect(content).toContain('INSERT INTO')
            expect(content).toContain('FOREIGN KEY')
            expect(content).toContain('Çağlar')
            expect(content).toContain('[app].[audit_log]')
            expect(content).toContain('[empty_table]')
            expect(content.toLowerCase()).toContain('0xdeadbeef')
            // Critical fix #2: computed column written as AS (...)
            expect(content).toContain('[full_name] AS')
            expect(content).toContain('PERSISTED')
            // Critical fix #3: CHECK constraints in dump
            expect(content).toContain('CK_users_email')
            expect(content).toContain('CK_posts_votes')
            expect(content).toContain('CHECK')
            // Critical fix #1: DBCC CHECKIDENT for identity reseed
            expect(content).toContain('DBCC CHECKIDENT')
            // Unique index coverage
            expect(content).toContain('CREATE UNIQUE INDEX [UX_posts_title]')
            // Critical fix #4: edge-case strings escaped properly
            expect(content).toContain("N'O''Brien'") // single-quote escape
        })

        it('should import SQL file into a fresh database with full data integrity', async () => {
            await adapter.createDatabase(importDbName)
            createdDatabases.push(importDbName)

            const importAdapter = new MSSQLAdapter({ ...testConfig, database: importDbName })
            await importAdapter.import(exportFile)

            expect(await countRows(importDbName, 'users')).toBe(4)
            expect(await countRows(importDbName, 'posts')).toBe(3)
            expect(await countRows(importDbName, 'app.audit_log')).toBe(2)
            expect(await countRows(importDbName, 'wide_types')).toBe(2)
            expect(await countRows(importDbName, 'empty_table')).toBe(0)

            const original = await snapshotData(testDbName)
            const restored = await snapshotData(importDbName)

            expect(restored.users).toEqual(original.users)
            expect(restored.posts).toEqual(original.posts)
            expect(restored.auditLog).toEqual(original.auditLog)

            expect(restored.wideTypes.length).toBe(2)
            for (let i = 0; i < restored.wideTypes.length; i++) {
                const o = original.wideTypes[i]
                const r = restored.wideTypes[i]
                expect(r.bit_col).toBe(o.bit_col)
                expect(String(r.bigint_col)).toBe(String(o.bigint_col))
                expect(Number(r.decimal_col)).toBeCloseTo(Number(o.decimal_col), 4)
                expect(Number(r.money_col)).toBeCloseTo(Number(o.money_col), 2)
                expect((r.date_col as Date).toISOString().slice(0, 10)).toBe(
                    (o.date_col as Date).toISOString().slice(0, 10),
                )
                expect((r.datetime2_col as Date).getTime()).toBe(
                    (o.datetime2_col as Date).getTime(),
                )
                if (o.varbinary_col === null) {
                    expect(r.varbinary_col).toBeNull()
                } else {
                    expect(Buffer.from(r.varbinary_col as Buffer).toString('hex')).toBe(
                        Buffer.from(o.varbinary_col as Buffer).toString('hex'),
                    )
                }
                expect(String(r.guid_col).toLowerCase()).toBe(String(o.guid_col).toLowerCase())
                expect(r.nullable_col).toBe(o.nullable_col)
            }
        })

        it('should import with reset option', async () => {
            const importAdapter = new MSSQLAdapter({ ...testConfig, database: importDbName })
            await importAdapter.import(exportFile, { reset: true })
            expect(await countRows(importDbName, 'users')).toBe(4)
        })

        it('should throw AdapterError on invalid SQL', async () => {
            const badFile = join(tmpdir(), `db_cli_test_bad_${Date.now()}.sql`)
            await Bun.write(badFile, 'THIS IS NOT VALID SQL;\nGO\n')
            try {
                const importAdapter = new MSSQLAdapter({
                    ...testConfig,
                    database: importDbName,
                })
                await expect(importAdapter.import(badFile)).rejects.toThrow(AdapterError)
            } finally {
                if (existsSync(badFile)) unlinkSync(badFile)
            }
        })
    })

    describe('critical fixes — behavioral verification on imported DB', () => {
        it('fix #1: IDENTITY counter reseeded — next INSERT gets max(id)+1, no PK conflict', async () => {
            await tryExec(
                importDbName,
                `INSERT INTO posts (user_id, title, body, vote_count) VALUES (1, N'After-restore', N'check', 1);`,
            )
            const newId = await execScalar<number>(
                importDbName,
                `SELECT TOP 1 id FROM posts ORDER BY id DESC;`,
            )
            // Original posts had id 1-3 (3 rows). Without reseed, IDENTITY would be 1
            // and INSERT would PK-conflict. With reseed, next id must be > 3.
            expect(Number(newId)).toBeGreaterThan(3)
        })

        it('fix #1: empty_table identity not corrupted — INSERT works without PK conflict', async () => {
            // empty_table had identity bumped to 5 then DELETEd (no rows in dump)
            // Without reseed in the empty case, identity would still be 1 after restore — OK.
            // We just verify INSERT works at all (regression check).
            const result = await tryExec(
                importDbName,
                `INSERT INTO empty_table (placeholder) VALUES (N'restored');`,
            )
            expect(result.ok).toBe(true)
        })

        it('fix #2: computed column produces correct value after restore', async () => {
            const fullName = await execScalar<string>(
                importDbName,
                `SELECT TOP 1 full_name FROM users WHERE first_name = N'Alice';`,
            )
            expect(fullName).toBe('Alice Smith')
        })

        it('fix #3: CHECK constraint enforces email format on restored DB', async () => {
            const result = await tryExec(
                importDbName,
                `INSERT INTO users (first_name, last_name, email) VALUES (N'Bad', N'Email', N'no-at-sign');`,
            )
            expect(result.ok).toBe(false)
            if (!result.ok) expect(result.error).toMatch(/CHECK|conflict/i)
        })

        it('unique index enforces no duplicate post title on restored DB', async () => {
            const result = await tryExec(
                importDbName,
                `INSERT INTO posts (user_id, title, body, vote_count) VALUES (1, N'Hello', N'dup', 0);`,
            )
            expect(result.ok).toBe(false)
            if (!result.ok) expect(result.error).toMatch(/duplicate|UX_posts_title/i)
        })

        it('fix #3: CHECK constraint enforces non-negative votes on restored DB', async () => {
            const result = await tryExec(
                importDbName,
                `INSERT INTO posts (user_id, title, vote_count) VALUES (1, N'Negative', -5);`,
            )
            expect(result.ok).toBe(false)
            if (!result.ok) expect(result.error).toMatch(/CHECK|conflict/i)
        })

        it("fix #4: O'Brien-style apostrophes preserved exactly", async () => {
            const restored = await snapshotData(importDbName)
            const obrien = restored.users.find((u) => u.first_name === "O'Brien")
            expect(obrien).toBeDefined()
            expect(obrien?.last_name).toBe("D'Angelo")
            const trickyPost = restored.posts.find((p) => p.title === "Test 'with' quotes")
            expect(trickyPost).toBeDefined()
        })

        it('fix #4: post body with apostrophes, semicolons, and SQL comment markers survives round-trip', async () => {
            const restored = await snapshotData(importDbName)
            const tricky = restored.posts.find((p) => p.title === 'Tricky')
            expect(tricky?.body).toContain("'")
            expect(tricky?.body).toContain(';')
            expect(tricky?.body).toContain('--')
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
    })
})
