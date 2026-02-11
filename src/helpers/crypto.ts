import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'crypto'

import { DbCliError } from '@/errors'

const MSG_PREFIX = 'ENC:'
const SALT_LEN = 16
const IV_LEN = 16
const KEY_LEN = 32
const ITERATIONS = 100000
const ALGO = 'sha256'
const CIPHER_ALGO = 'aes-256-cbc'

export class EncryptedFileError extends DbCliError {
    constructor(message = 'File is encrypted') {
        super(message)
        this.name = 'EncryptedFileError'
    }
}

/**
 * Encrypts a string using AES-256-CBC.
 * returns "ENC:salt:iv:encrypted_base64"
 */
export function encrypt(data: string, password: string): string {
    const salt = randomBytes(SALT_LEN)
    const iv = randomBytes(IV_LEN)
    const key = pbkdf2Sync(password, salt, ITERATIONS, KEY_LEN, ALGO)

    const cipher = createCipheriv(CIPHER_ALGO, key, iv)
    let encrypted = cipher.update(data, 'utf8', 'base64')
    encrypted += cipher.final('base64')

    return `${MSG_PREFIX}${salt.toString('base64')}:${iv.toString('base64')}:${encrypted}`
}

/**
 * Decrypts a string using AES-256-CBC.
 */
export function decrypt(encryptedString: string, password: string): string {
    if (!encryptedString.startsWith(MSG_PREFIX)) {
        throw new Error('Invalid encrypted format')
    }

    const parts = encryptedString.substring(MSG_PREFIX.length).split(':')
    if (parts.length !== 3) {
        throw new Error('Invalid encrypted format')
    }

    const [saltB64, ivB64, encryptedData] = parts
    const salt = Buffer.from(saltB64, 'base64')
    const iv = Buffer.from(ivB64, 'base64')

    const key = pbkdf2Sync(password, salt, ITERATIONS, KEY_LEN, ALGO)

    const decipher = createDecipheriv(CIPHER_ALGO, key, iv)
    let decrypted = decipher.update(encryptedData, 'base64', 'utf8')
    decrypted += decipher.final('utf8')

    return decrypted
}
