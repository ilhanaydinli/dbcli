import { describe, expect, it } from 'bun:test'

import { isAuthenticationFailure, resolveMongoAuthSource } from '@/helpers/mongo-auth-source'
import type { DbConfig } from '@/interfaces'
import { DbType } from '@/interfaces'

const baseConfig: DbConfig = {
    id: 'test',
    name: 'Test',
    type: DbType.MongoDB,
    host: 'localhost',
    port: 27017,
    user: 'root',
    password: 'secret',
    database: 'shopdb',
    ssl: false,
    verbose: false,
}

function probeAccepting(accepted: string[], attempts: string[] = []) {
    return async (candidate: string): Promise<boolean> => {
        attempts.push(candidate)
        return accepted.includes(candidate)
    }
}

describe('resolveMongoAuthSource', () => {
    it('should return admin when credentials live in the admin database', async () => {
        const result = await resolveMongoAuthSource(baseConfig, probeAccepting(['admin']))
        expect(result).toBe('admin')
    })

    it('should fall back to the configured database when admin is rejected', async () => {
        const result = await resolveMongoAuthSource(baseConfig, probeAccepting(['shopdb']))
        expect(result).toBe('shopdb')
    })

    it('should try admin before the configured database', async () => {
        const attempts: string[] = []
        await resolveMongoAuthSource(baseConfig, probeAccepting([], attempts))
        expect(attempts).toEqual(['admin', 'shopdb'])
    })

    it('should return undefined when every candidate is rejected', async () => {
        const result = await resolveMongoAuthSource(baseConfig, probeAccepting([]))
        expect(result).toBeUndefined()
    })

    it('should not probe when no user is configured', async () => {
        const attempts: string[] = []
        const result = await resolveMongoAuthSource(
            { ...baseConfig, user: '' },
            probeAccepting(['admin'], attempts),
        )
        expect(result).toBeUndefined()
        expect(attempts).toEqual([])
    })

    it('should not probe when authSource is already configured', async () => {
        const attempts: string[] = []
        const result = await resolveMongoAuthSource(
            { ...baseConfig, authSource: 'users' },
            probeAccepting(['admin'], attempts),
        )
        expect(result).toBeUndefined()
        expect(attempts).toEqual([])
    })

    it('should not probe when the uri already carries authSource', async () => {
        const attempts: string[] = []
        const result = await resolveMongoAuthSource(
            { ...baseConfig, uri: 'mongodb://root:secret@localhost:27017/shopdb?authSource=users' },
            probeAccepting(['admin'], attempts),
        )
        expect(result).toBeUndefined()
        expect(attempts).toEqual([])
    })

    it('should probe a database taken from the uri path', async () => {
        const attempts: string[] = []
        await resolveMongoAuthSource(
            { ...baseConfig, uri: 'mongodb://root:secret@localhost:27017/billing' },
            probeAccepting([], attempts),
        )
        expect(attempts).toEqual(['admin', 'billing'])
    })

    it('should not probe when the uri carries no credentials', async () => {
        const attempts: string[] = []
        const result = await resolveMongoAuthSource(
            { ...baseConfig, user: '', uri: 'mongodb://localhost:27017/shopdb' },
            probeAccepting(['admin'], attempts),
        )
        expect(result).toBeUndefined()
        expect(attempts).toEqual([])
    })

    it('should probe when credentials are only present in the uri', async () => {
        const attempts: string[] = []
        await resolveMongoAuthSource(
            { ...baseConfig, user: '', uri: 'mongodb://root:secret@localhost:27017/shopdb' },
            probeAccepting([], attempts),
        )
        expect(attempts).toEqual(['admin', 'shopdb'])
    })

    it('should probe admin only once when it is also the configured database', async () => {
        const attempts: string[] = []
        await resolveMongoAuthSource(
            { ...baseConfig, database: 'admin' },
            probeAccepting([], attempts),
        )
        expect(attempts).toEqual(['admin'])
    })
})

describe('isAuthenticationFailure', () => {
    it('should recognise a mongodump sasl authentication error', () => {
        const stderr =
            'Failed: can\'t create session: failed to connect to mongodb://root:pass@localhost:27018/: connection() error occurred during connection handshake: auth error: sasl conversation error: unable to authenticate using mechanism "SCRAM-SHA-1": (AuthenticationFailed) Authentication failed.'
        expect(isAuthenticationFailure(stderr)).toBe(true)
    })

    it('should recognise a mongosh authentication error', () => {
        expect(isAuthenticationFailure('MongoServerError: Authentication failed.')).toBe(true)
    })

    it('should not treat an authorization error as an authentication failure', () => {
        const stderr =
            'Failed: (Unauthorized) not authorized on admin to execute command { listDatabases: 1 }'
        expect(isAuthenticationFailure(stderr)).toBe(false)
    })

    it('should not treat an unrelated failure as an authentication failure', () => {
        expect(
            isAuthenticationFailure(
                'Failed: stream or file does not appear to be a mongodump archive',
            ),
        ).toBe(false)
    })

    it('should not treat empty output as an authentication failure', () => {
        expect(isAuthenticationFailure('')).toBe(false)
    })
})
