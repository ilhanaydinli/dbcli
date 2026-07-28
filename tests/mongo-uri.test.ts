import { describe, expect, it } from 'bun:test'

import { buildMongoHostUri, buildMongoUri } from '@/helpers/mongo-uri'
import type { DbConfig } from '@/interfaces'
import { DbType } from '@/interfaces'

const baseConfig: DbConfig = {
    id: 'test',
    name: 'Test',
    type: DbType.MongoDB,
    host: 'localhost',
    port: 27017,
    user: '',
    password: '',
    database: 'shopdb',
    ssl: false,
    verbose: false,
}

describe('buildMongoUri', () => {
    it('should use the configured database when no name is given', () => {
        expect(buildMongoUri(baseConfig)).toBe('mongodb://localhost:27017/shopdb')
    })

    it('should use the given database name over the configured one', () => {
        expect(buildMongoUri(baseConfig, 'other')).toBe('mongodb://localhost:27017/other')
    })

    it('should fall back to admin when no database is configured', () => {
        expect(buildMongoUri({ ...baseConfig, database: '' })).toBe(
            'mongodb://localhost:27017/admin',
        )
    })

    it('should embed encoded credentials', () => {
        const config = { ...baseConfig, user: 'root', password: 'p@ss word' }
        expect(buildMongoUri(config)).toBe('mongodb://root:p%40ss%20word@localhost:27017/shopdb')
    })

    it('should omit credentials when no user is set', () => {
        expect(buildMongoUri({ ...baseConfig, password: 'secret' })).toBe(
            'mongodb://localhost:27017/shopdb',
        )
    })

    it('should append tls when ssl is enabled', () => {
        expect(buildMongoUri({ ...baseConfig, ssl: true })).toBe(
            'mongodb://localhost:27017/shopdb?tls=true',
        )
    })

    it('should append authSource when configured', () => {
        expect(buildMongoUri({ ...baseConfig, authSource: 'admin' })).toBe(
            'mongodb://localhost:27017/shopdb?authSource=admin',
        )
    })

    it('should join tls and authSource with an ampersand', () => {
        expect(buildMongoUri({ ...baseConfig, ssl: true, authSource: 'admin' })).toBe(
            'mongodb://localhost:27017/shopdb?tls=true&authSource=admin',
        )
    })

    it('should return the raw uri when no database name is given', () => {
        const uri = 'mongodb://root:secret@db.example.com:27017/shopdb?retryWrites=true'
        expect(buildMongoUri({ ...baseConfig, uri })).toBe(uri)
    })

    it('should replace the database in a uri while keeping its query', () => {
        const uri = 'mongodb://db.example.com:27017/shopdb?retryWrites=true'
        expect(buildMongoUri({ ...baseConfig, uri }, 'other')).toBe(
            'mongodb://db.example.com:27017/other?retryWrites=true',
        )
    })

    it('should inject authSource into a uri that lacks it', () => {
        const uri = 'mongodb://root:secret@db.example.com:27017/shopdb'
        expect(buildMongoUri({ ...baseConfig, uri, authSource: 'admin' })).toBe(
            'mongodb://root:secret@db.example.com:27017/shopdb?authSource=admin',
        )
    })

    it('should keep the authSource already present in a uri', () => {
        const uri = 'mongodb://db.example.com:27017/shopdb?authSource=users'
        expect(buildMongoUri({ ...baseConfig, uri, authSource: 'admin' })).toBe(uri)
    })

    it('should support mongodb+srv uris', () => {
        const uri = 'mongodb+srv://cluster.example.mongodb.net/shopdb'
        expect(buildMongoUri({ ...baseConfig, uri, authSource: 'admin' })).toBe(
            'mongodb+srv://cluster.example.mongodb.net/shopdb?authSource=admin',
        )
    })

    it('should return an unparsable uri untouched', () => {
        const uri = 'not a uri'
        expect(buildMongoUri({ ...baseConfig, uri, authSource: 'admin' })).toBe(uri)
    })
})

describe('buildMongoHostUri', () => {
    it('should omit the database path', () => {
        expect(buildMongoHostUri(baseConfig)).toBe('mongodb://localhost:27017/')
    })

    it('should append authSource when configured', () => {
        expect(buildMongoHostUri({ ...baseConfig, authSource: 'admin' })).toBe(
            'mongodb://localhost:27017/?authSource=admin',
        )
    })

    it('should join tls and authSource with an ampersand', () => {
        expect(buildMongoHostUri({ ...baseConfig, ssl: true, authSource: 'admin' })).toBe(
            'mongodb://localhost:27017/?tls=true&authSource=admin',
        )
    })

    it('should strip the database from a uri but keep its query', () => {
        const uri = 'mongodb://root:secret@db.example.com:27017/shopdb?authSource=admin'
        expect(buildMongoHostUri({ ...baseConfig, uri })).toBe(
            'mongodb://root:secret@db.example.com:27017/?authSource=admin',
        )
    })

    it('should inject authSource into a uri that lacks it', () => {
        const uri = 'mongodb://db.example.com:27017/shopdb'
        expect(buildMongoHostUri({ ...baseConfig, uri, authSource: 'admin' })).toBe(
            'mongodb://db.example.com:27017/?authSource=admin',
        )
    })
})
