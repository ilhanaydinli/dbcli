import { beforeAll, describe, expect, it, jest } from 'bun:test'
import { existsSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { detectMongoAuthSource, MongoDbAdapter } from '@/adapters/mongodb-adapter'
import type { DbConfig } from '@/interfaces'
import { DbType } from '@/interfaces'

jest.setTimeout(30000)

const AUTH_HOST = process.env.MONGO_AUTH_HOST ?? 'localhost'
const AUTH_PORT = parseInt(process.env.MONGO_AUTH_PORT ?? '27018', 10)
const ROOT_USER = process.env.MONGO_AUTH_ROOT_USER ?? 'root'
const ROOT_PASSWORD = process.env.MONGO_AUTH_ROOT_PASSWORD ?? 'rootpass'

const scopedDbName = 'db_cli_auth_scoped'
const scopedUser = 'scopeduser'
const scopedPassword = 'scopedpass'

async function isReachable(): Promise<boolean> {
    try {
        const socket = await Bun.connect({
            hostname: AUTH_HOST,
            port: AUTH_PORT,
            socket: { data: () => {} },
        })
        socket.end()
        return true
    } catch {
        return false
    }
}

const authAvailable = await isReachable()

const baseConfig: DbConfig = {
    id: 'auth-test',
    name: 'Auth Test',
    type: DbType.MongoDB,
    host: AUTH_HOST,
    port: AUTH_PORT,
    user: ROOT_USER,
    password: ROOT_PASSWORD,
    database: scopedDbName,
    ssl: false,
    verbose: false,
}

function rootUri(dbName: string): string {
    return `mongodb://${ROOT_USER}:${ROOT_PASSWORD}@${AUTH_HOST}:${AUTH_PORT}/${dbName}?authSource=admin`
}

describe.skipIf(!authAvailable)('MongoDB authSource detection (auth enabled server)', () => {
    beforeAll(async () => {
        const script = `
            const target = db.getSiblingDB('${scopedDbName}');
            target.products.insertMany([{ p: 1 }, { p: 2 }]);
            if (!target.getUser('${scopedUser}')) {
                target.createUser({
                    user: '${scopedUser}',
                    pwd: '${scopedPassword}',
                    roles: [{ role: 'readWrite', db: '${scopedDbName}' }],
                });
            }
        `
        const proc = Bun.spawn(['mongosh', rootUri('admin'), '--quiet', '--eval', script], {
            stdout: 'ignore',
            stderr: 'ignore',
        })
        const exitCode = await proc.exited
        if (exitCode !== 0) throw new Error(`auth fixture setup failed (exit ${exitCode})`)
    })

    it('should fail to connect without an authSource when the user lives in admin', async () => {
        const adapter = new MongoDbAdapter(baseConfig)
        expect(await adapter.testConnection()).toBe(false)
    })

    it('should detect admin for a user defined in the admin database', async () => {
        expect(await detectMongoAuthSource(baseConfig)).toBe('admin')
    })

    it('should connect once the detected authSource is applied', async () => {
        const authSource = await detectMongoAuthSource(baseConfig)
        const adapter = new MongoDbAdapter({ ...baseConfig, authSource })
        expect(await adapter.testConnection()).toBe(true)
    })

    it('should export successfully once the detected authSource is applied', async () => {
        const exportFile = join(tmpdir(), `db_cli_auth_export_${Date.now()}.archive`)
        const authSource = await detectMongoAuthSource(baseConfig)

        const adapter = new MongoDbAdapter({ ...baseConfig, authSource })
        await adapter.export(exportFile)

        expect(existsSync(exportFile)).toBe(true)
        unlinkSync(exportFile)
    })

    it('should detect the target database for a user scoped to it', async () => {
        const scopedConfig: DbConfig = {
            ...baseConfig,
            user: scopedUser,
            password: scopedPassword,
        }
        expect(await detectMongoAuthSource(scopedConfig)).toBe(scopedDbName)
    })

    it('should return undefined when the password is wrong', async () => {
        const wrongConfig: DbConfig = { ...baseConfig, password: 'definitely-wrong' }
        expect(await detectMongoAuthSource(wrongConfig)).toBeUndefined()
    }, 30000)

    it('should export by recovering the auth source when none is configured', async () => {
        const exportFile = join(tmpdir(), `db_cli_auth_recover_${Date.now()}.archive`)
        const resolved: string[] = []

        const adapter = new MongoDbAdapter(baseConfig, {
            onAuthSourceResolved: (authSource) => void resolved.push(authSource),
        })
        await adapter.export(exportFile)

        expect(existsSync(exportFile)).toBe(true)
        expect(resolved).toEqual(['admin'])
        unlinkSync(exportFile)
    })

    it('should import by recovering the auth source for a scoped user', async () => {
        const exportFile = join(tmpdir(), `db_cli_auth_recover_import_${Date.now()}.archive`)
        await new MongoDbAdapter({ ...baseConfig, authSource: 'admin' }).export(exportFile)

        const resolved: string[] = []
        const adapter = new MongoDbAdapter(
            { ...baseConfig, user: scopedUser, password: scopedPassword },
            { onAuthSourceResolved: (authSource) => void resolved.push(authSource) },
        )
        await adapter.import(exportFile, { reset: true })

        expect(resolved).toEqual([scopedDbName])
        unlinkSync(exportFile)
    })

    it('should import for an admin user without needing recovery', async () => {
        const exportFile = join(tmpdir(), `db_cli_auth_import_admin_${Date.now()}.archive`)
        await new MongoDbAdapter({ ...baseConfig, authSource: 'admin' }).export(exportFile)

        const resolved: string[] = []
        const adapter = new MongoDbAdapter(baseConfig, {
            onAuthSourceResolved: (authSource) => void resolved.push(authSource),
        })
        await adapter.import(exportFile, { reset: true })

        expect(resolved).toEqual([])
        unlinkSync(exportFile)
    })

    it('should list databases by recovering the auth source for a scoped user', async () => {
        const resolved: string[] = []
        const adapter = new MongoDbAdapter(
            { ...baseConfig, user: scopedUser, password: scopedPassword },
            { onAuthSourceResolved: (authSource) => void resolved.push(authSource) },
        )

        const databases = await adapter.listDatabases()

        expect(resolved).toEqual([scopedDbName])
        expect(databases.some((db) => db.name === scopedDbName)).toBe(true)
    })

    it('should not recover from a failure that is not an authentication error', async () => {
        const badArchive = join(tmpdir(), `db_cli_auth_bad_${Date.now()}.archive`)
        await Bun.write(badArchive, 'this is not an archive')

        const resolved: string[] = []
        const adapter = new MongoDbAdapter(
            { ...baseConfig, authSource: 'admin' },
            { onAuthSourceResolved: (authSource) => void resolved.push(authSource) },
        )

        await expect(adapter.import(badArchive)).rejects.toThrow()
        expect(resolved).toEqual([])
        unlinkSync(badArchive)
    })

    it('should leave a uri that already carries authSource untouched', async () => {
        const uriConfig: DbConfig = { ...baseConfig, uri: rootUri(scopedDbName) }
        expect(await detectMongoAuthSource(uriConfig)).toBeUndefined()

        const adapter = new MongoDbAdapter(uriConfig)
        expect(await adapter.testConnection()).toBe(true)
    })
})
