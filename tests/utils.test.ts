import { describe, expect, it } from 'bun:test'

import { parseConnectionUrl } from '@/helpers/utils'
import { DbNameSchema, FilenameSchema, PortSchema, zodValidate } from '@/validations'

describe('DbNameSchema', () => {
    it('should accept valid alphanumeric names', () => {
        expect(zodValidate(DbNameSchema, 'mydb')).toBeUndefined()
        expect(zodValidate(DbNameSchema, 'my_db')).toBeUndefined()
        expect(zodValidate(DbNameSchema, 'MyDatabase123')).toBeUndefined()
        expect(zodValidate(DbNameSchema, 'DB_NAME_2024')).toBeUndefined()
    })

    it('should accept single characters and hyphens', () => {
        expect(zodValidate(DbNameSchema, 'a')).toBeUndefined()
        expect(zodValidate(DbNameSchema, 'Z')).toBeUndefined()
        expect(zodValidate(DbNameSchema, '1')).toBeUndefined()
        expect(zodValidate(DbNameSchema, '_')).toBeUndefined()
        expect(zodValidate(DbNameSchema, 'my-db')).toBeUndefined()
    })

    it('should reject names with special characters', () => {
        const errorMsg =
            'Invalid name. Only alphanumeric characters, underscores, and hyphens allowed.'
        expect(zodValidate(DbNameSchema, 'my.db')).toBe(errorMsg)
        expect(zodValidate(DbNameSchema, 'my db')).toBe(errorMsg)
        expect(zodValidate(DbNameSchema, 'db@name')).toBe(errorMsg)
        expect(zodValidate(DbNameSchema, 'db!name')).toBe(errorMsg)
    })

    it('should reject empty string', () => {
        expect(zodValidate(DbNameSchema, '')).toBe('Name is required')
    })
})

describe('FilenameSchema', () => {
    it('should accept valid filenames', () => {
        expect(zodValidate(FilenameSchema, 'file.sql')).toBeUndefined()
        expect(zodValidate(FilenameSchema, 'backup_2024.sql')).toBeUndefined()
        expect(zodValidate(FilenameSchema, 'my-file.json')).toBeUndefined()
    })

    it('should reject empty filename', () => {
        expect(zodValidate(FilenameSchema, '')).toBe('Filename is required')
    })

    it('should reject undefined filename', () => {
        expect(zodValidate(FilenameSchema, undefined)).toBeDefined()
    })

    it('should reject path separators', () => {
        expect(zodValidate(FilenameSchema, 'path/file.sql')).toContain('path separators')
        expect(zodValidate(FilenameSchema, 'path\\file.sql')).toContain('path separators')
    })

    it('should reject invalid characters', () => {
        expect(zodValidate(FilenameSchema, 'file<name>.sql')).toContain('invalid characters')
        expect(zodValidate(FilenameSchema, 'file:name.sql')).toContain('invalid characters')
    })
})

describe('parseConnectionUrl', () => {
    it('should parse a full PostgreSQL URL', () => {
        const result = parseConnectionUrl('postgresql://admin:secret@db.example.com:5433/mydb')
        expect(result).toEqual({
            host: 'db.example.com',
            port: 5433,
            user: 'admin',
            password: 'secret',
            database: 'mydb',
            ssl: false,
        })
    })

    it('should parse URL with sslmode=require', () => {
        const result = parseConnectionUrl('postgresql://user:pass@host:5432/db?sslmode=require')
        expect(result).not.toBeNull()
        expect(result!.ssl).toBe(true)
    })

    it('should handle postgres:// protocol', () => {
        const result = parseConnectionUrl('postgres://user:pass@localhost/mydb')
        expect(result).not.toBeNull()
        expect(result!.host).toBe('localhost')
        expect(result!.database).toBe('mydb')
    })

    it('should use defaults for missing parts', () => {
        const result = parseConnectionUrl('postgresql://@localhost')
        expect(result).not.toBeNull()
        expect(result!.port).toBe(5432)
        expect(result!.database).toBe('postgres')
        expect(result!.user).toBe('postgres')
    })

    it('should decode URL-encoded password', () => {
        const result = parseConnectionUrl('postgresql://user:p%40ss%23word@host/db')
        expect(result).not.toBeNull()
        expect(result!.password).toBe('p@ss#word')
    })

    it('should return null for invalid URL', () => {
        expect(parseConnectionUrl('not-a-url')).toBeNull()
        expect(parseConnectionUrl('mysql://user:pass@host/db')).toBeNull()
        expect(parseConnectionUrl('')).toBeNull()
    })
})

describe('PortSchema', () => {
    it('should validate correct ports', () => {
        expect(zodValidate(PortSchema, '5432')).toBeUndefined()
        expect(zodValidate(PortSchema, 5432)).toBeUndefined()
        expect(zodValidate(PortSchema, '1')).toBeUndefined()
        expect(zodValidate(PortSchema, '65535')).toBeUndefined()
    })

    it('should reject invalid ports', () => {
        expect(zodValidate(PortSchema, '0')).toBe('Port must be valid')
        expect(zodValidate(PortSchema, '-1')).toBe('Port must be valid')
        expect(zodValidate(PortSchema, '65536')).toBe('Port must be valid')
        expect(zodValidate(PortSchema, 'abc')).toBeDefined()
    })
})
