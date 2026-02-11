import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { decrypt, encrypt } from '@/helpers/crypto'
import type { DbConfig } from '@/interfaces'
import { DbConfigSchema } from '@/interfaces'

const testConfigPath = join(tmpdir(), '.db-cli-test-config.json')
const testExportPath = join(tmpdir(), 'db-cli-export-test.json')

const createTestConfig = (overrides: Partial<DbConfig> = {}): DbConfig => ({
    id: crypto.randomUUID(),
    name: 'Test Connection',
    type: 'postgres',
    host: 'localhost',
    port: 5432,
    user: 'postgres',
    password: 'secret',
    database: 'testdb',
    ssl: false,
    verbose: false,
    ...overrides,
})

describe('DbConfigSchema', () => {
    it('should validate a complete config', () => {
        const config = createTestConfig()
        const result = DbConfigSchema.safeParse(config)
        expect(result.success).toBe(true)
    })

    it('should apply default values', () => {
        const partial = {
            id: 'test-id',
            name: 'Test',
            type: 'postgres',
            host: 'localhost',
            port: 5432,
            user: 'admin',
            database: 'mydb',
        }
        const result = DbConfigSchema.parse(partial)
        expect(result.password).toBe('')
        expect(result.ssl).toBe(false)
        expect(result.verbose).toBe(false)
    })

    it('should reject invalid type', () => {
        const config = createTestConfig({ type: 'mysql' as DbConfig['type'] })
        const result = DbConfigSchema.safeParse(config)
        expect(result.success).toBe(false)
    })

    it('should reject non-number port', () => {
        const config = { ...createTestConfig(), port: '5432' }
        const result = DbConfigSchema.safeParse(config)
        expect(result.success).toBe(false)
    })

    it('should reject missing required fields', () => {
        const invalid = { id: 'test', name: 'Test' }
        const result = DbConfigSchema.safeParse(invalid)
        expect(result.success).toBe(false)
    })
})

describe('Config File Operations', () => {
    beforeAll(() => {
        if (existsSync(testConfigPath)) unlinkSync(testConfigPath)
        if (existsSync(testExportPath)) unlinkSync(testExportPath)
    })

    afterAll(() => {
        if (existsSync(testConfigPath)) unlinkSync(testConfigPath)
        if (existsSync(testExportPath)) unlinkSync(testExportPath)
    })

    it('should write valid JSON to file', () => {
        const configs = [createTestConfig(), createTestConfig({ name: 'Second' })]
        writeFileSync(testConfigPath, JSON.stringify(configs, null, 2))

        expect(existsSync(testConfigPath)).toBe(true)
        const content = readFileSync(testConfigPath, 'utf-8')
        const parsed = JSON.parse(content)
        expect(parsed).toHaveLength(2)
    })

    it('should read and parse config from file', () => {
        const content = readFileSync(testConfigPath, 'utf-8')
        const parsed = JSON.parse(content)

        for (const config of parsed) {
            const result = DbConfigSchema.safeParse(config)
            expect(result.success).toBe(true)
        }
    })

    it('should handle export format with metadata', () => {
        const configs = [createTestConfig()]
        const exportData = {
            version: 1,
            exportedAt: new Date().toISOString(),
            connections: configs,
        }
        writeFileSync(testExportPath, JSON.stringify(exportData, null, 2))

        const content = readFileSync(testExportPath, 'utf-8')
        const parsed = JSON.parse(content)

        expect(parsed.version).toBe(1)
        expect(parsed.exportedAt).toBeDefined()
        expect(parsed.connections).toHaveLength(1)
    })

    it('should filter configs by ID', () => {
        const configs = [
            createTestConfig({ id: 'keep-1' }),
            createTestConfig({ id: 'remove-me' }),
            createTestConfig({ id: 'keep-2' }),
        ]

        const filtered = configs.filter((c) => c.id !== 'remove-me')
        expect(filtered).toHaveLength(2)
        expect(filtered.find((c) => c.id === 'remove-me')).toBeUndefined()
    })

    it('should update config at correct index', () => {
        const configs = [
            createTestConfig({ id: 'id-1', name: 'First' }),
            createTestConfig({ id: 'id-2', name: 'Second' }),
        ]

        const updated = { ...configs[1], name: 'Updated Second' }
        const index = configs.findIndex((c) => c.id === updated.id)
        if (index !== -1) {
            configs[index] = updated
        }

        expect(configs[1].name).toBe('Updated Second')
    })
})

describe('Encrypted Export/Import', () => {
    const encryptedExportPath = join(tmpdir(), 'db-cli-encrypted-export.enc')
    const testPassword = 'test-password-123'

    afterAll(() => {
        if (existsSync(encryptedExportPath)) unlinkSync(encryptedExportPath)
    })

    it('should export with encryption', () => {
        const configs = [createTestConfig({ name: 'Encrypted Test' })]
        const exportData = {
            version: 1,
            exportedAt: new Date().toISOString(),
            connections: configs,
        }

        const jsonContent = JSON.stringify(exportData, null, 2)
        const encrypted = encrypt(jsonContent, testPassword)

        writeFileSync(encryptedExportPath, encrypted)

        expect(existsSync(encryptedExportPath)).toBe(true)
        const content = readFileSync(encryptedExportPath, 'utf-8')
        expect(content).toStartWith('ENC:')
    })

    it('should import encrypted file with correct password', () => {
        const content = readFileSync(encryptedExportPath, 'utf-8')
        const decrypted = decrypt(content, testPassword)
        const parsed = JSON.parse(decrypted)

        expect(parsed.version).toBe(1)
        expect(parsed.connections).toHaveLength(1)
        expect(parsed.connections[0].name).toBe('Encrypted Test')
    })

    it('should fail to import with wrong password', () => {
        const content = readFileSync(encryptedExportPath, 'utf-8')

        expect(() => decrypt(content, 'wrong-password')).toThrow()
    })

    it('should preserve passwords in encrypted export', () => {
        const configWithPassword = createTestConfig({
            name: 'With Password',
            password: 'super-secret',
        })
        const exportData = {
            version: 1,
            exportedAt: new Date().toISOString(),
            connections: [configWithPassword],
        }

        const jsonContent = JSON.stringify(exportData, null, 2)
        const encrypted = encrypt(jsonContent, testPassword)
        const decrypted = decrypt(encrypted, testPassword)
        const parsed = JSON.parse(decrypted)

        expect(parsed.connections[0].password).toBe('super-secret')
    })

    it('should strip passwords in non-encrypted export', () => {
        const configs = [createTestConfig({ password: 'secret123' })]
        const configsWithoutPasswords = configs.map((c) => ({
            ...c,
            password: '',
        }))

        expect(configsWithoutPasswords[0].password).toBe('')
        expect(configs[0].password).toBe('secret123') // Original unchanged
    })
})
