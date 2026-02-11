import { describe, expect, it } from 'bun:test'

import { decrypt, encrypt, EncryptedFileError } from '@/helpers/crypto'

describe('Crypto Helper', () => {
    const testPassword = 'test-password-123'
    const testData = 'sensitive data'

    describe('encrypt', () => {
        it('should encrypt data with password', () => {
            const encrypted = encrypt(testData, testPassword)

            expect(encrypted).toBeString()
            expect(encrypted).toStartWith('ENC:')
            expect(encrypted.split(':')).toHaveLength(4) // ENC:salt:iv:data
        })

        it('should produce different output for same data (due to random salt/iv)', () => {
            const encrypted1 = encrypt(testData, testPassword)
            const encrypted2 = encrypt(testData, testPassword)

            expect(encrypted1).not.toBe(encrypted2)
        })

        it('should handle empty string', () => {
            const encrypted = encrypt('', testPassword)
            expect(encrypted).toStartWith('ENC:')
        })

        it('should handle unicode characters', () => {
            const unicodeData = 'Hello 世界 🚀'
            const encrypted = encrypt(unicodeData, testPassword)
            const decrypted = decrypt(encrypted, testPassword)

            expect(decrypted).toBe(unicodeData)
        })
    })

    describe('decrypt', () => {
        it('should decrypt encrypted data correctly', () => {
            const encrypted = encrypt(testData, testPassword)
            const decrypted = decrypt(encrypted, testPassword)

            expect(decrypted).toBe(testData)
        })

        it('should throw error with wrong password', () => {
            const encrypted = encrypt(testData, testPassword)

            expect(() => decrypt(encrypted, 'wrong-password')).toThrow()
        })

        it('should throw error with invalid format', () => {
            expect(() => decrypt('not-encrypted', testPassword)).toThrow('Invalid encrypted format')
        })

        it('should throw error with malformed encrypted string', () => {
            expect(() => decrypt('ENC:invalid:format', testPassword)).toThrow(
                'Invalid encrypted format',
            )
        })

        it('should handle long text', () => {
            const longText = 'a'.repeat(10000)
            const encrypted = encrypt(longText, testPassword)
            const decrypted = decrypt(encrypted, testPassword)

            expect(decrypted).toBe(longText)
        })
    })

    describe('EncryptedFileError', () => {
        it('should create error with default message', () => {
            const error = new EncryptedFileError()

            expect(error.message).toBe('File is encrypted')
            expect(error.name).toBe('EncryptedFileError')
        })

        it('should create error with custom message', () => {
            const customMessage = 'Custom encrypted file error'
            const error = new EncryptedFileError(customMessage)

            expect(error.message).toBe(customMessage)
            expect(error.name).toBe('EncryptedFileError')
        })
    })

    describe('encrypt/decrypt integration', () => {
        it('should handle complex JSON data', () => {
            const complexData = JSON.stringify({
                connections: [
                    { id: '1', name: 'test', password: 'secret' },
                    { id: '2', name: 'prod', password: 'super-secret' },
                ],
                metadata: { version: 1, exportedAt: new Date().toISOString() },
            })

            const encrypted = encrypt(complexData, testPassword)
            const decrypted = decrypt(encrypted, testPassword)
            const parsed = JSON.parse(decrypted)

            expect(parsed.connections).toHaveLength(2)
            expect(parsed.connections[0].password).toBe('secret')
            expect(parsed.metadata.version).toBe(1)
        })
    })
})
