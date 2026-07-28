import type { DbConfig } from '@/interfaces'

const ADMIN_DATABASE = 'admin'
const AUTH_FAILURE_PATTERN = /authentication failed|authenticationfailed|auth error/i

export function isAuthenticationFailure(output: string): boolean {
    return AUTH_FAILURE_PATTERN.test(output)
}

function uriHasAuthSource(uri: string): boolean {
    try {
        return new URL(uri).searchParams.has('authSource')
    } catch {
        return /[?&]authSource=/.test(uri)
    }
}

function uriDatabase(uri: string): string | undefined {
    try {
        const database = new URL(uri).pathname.replace(/^\//, '')
        return database || undefined
    } catch {
        return undefined
    }
}

function hasCredentials(config: DbConfig): boolean {
    if (config.user) return true
    if (!config.uri) return false
    try {
        return new URL(config.uri).username !== ''
    } catch {
        return false
    }
}

function candidatesFor(config: DbConfig): string[] {
    const fromUri = config.uri ? uriDatabase(config.uri) : undefined
    const database = fromUri || config.database
    const candidates = [ADMIN_DATABASE]
    if (database && database !== ADMIN_DATABASE) candidates.push(database)
    return candidates
}

export async function resolveMongoAuthSource(
    config: DbConfig,
    probe: (authSource: string) => Promise<boolean>,
): Promise<string | undefined> {
    if (!hasCredentials(config)) return undefined
    if (config.authSource) return undefined
    if (config.uri && uriHasAuthSource(config.uri)) return undefined

    for (const candidate of candidatesFor(config)) {
        if (await probe(candidate)) return candidate
    }

    return undefined
}
