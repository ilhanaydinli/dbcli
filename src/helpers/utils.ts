import { log, spinner } from '@clack/prompts'

import { ValidationError } from '@/errors'
import { DbNameSchema, zodValidate } from '@/validations'

export function assertValidDbName(name: string): void {
    const result = zodValidate(DbNameSchema, name)
    if (result) {
        throw new ValidationError(result)
    }
}

export function logError(message: string): void {
    log.error(message)
}

export function logSuccess(message: string): void {
    log.success(message)
}

export function logWarn(message: string): void {
    log.warn(message)
}

export function logInfo(message: string): void {
    log.info(message)
}

export function formatFileSize(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB']
    let i = 0
    let size = bytes
    while (size >= 1024 && i < units.length - 1) {
        size /= 1024
        i++
    }
    return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

export function formatRelativeTime(mtimeMs: number): string {
    const diffMs = Date.now() - mtimeMs
    const seconds = Math.floor(diffMs / 1000)
    const minutes = Math.floor(seconds / 60)
    const hours = Math.floor(minutes / 60)
    const days = Math.floor(hours / 24)

    if (days > 0) return `${days}d ago`
    if (hours > 0) return `${hours}h ago`
    if (minutes > 0) return `${minutes}m ago`
    return 'just now'
}

interface ParsedConnectionUrl {
    host: string
    port: number
    user: string
    password: string
    database: string
    ssl: boolean
}

export function parseConnectionUrl(url: string): ParsedConnectionUrl | null {
    try {
        const parsed = new URL(url)
        if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') return null

        return {
            host: parsed.hostname || 'localhost',
            port: Number(parsed.port) || 5432,
            user: decodeURIComponent(parsed.username) || 'postgres',
            password: decodeURIComponent(parsed.password) || '',
            database: parsed.pathname.replace(/^\//, '') || 'postgres',
            ssl: parsed.searchParams.get('sslmode') === 'require',
        }
    } catch {
        return null
    }
}

export async function withSpinner<T>(
    startMessage: string,
    action: () => Promise<T>,
    successMessage?: string,
    failureMessage?: string,
): Promise<T> {
    const s = spinner()
    s.start(startMessage)
    try {
        const result = await action()
        s.stop(successMessage || 'Done')
        return result
    } catch (error) {
        s.error(failureMessage || 'Operation failed')
        throw error
    }
}
