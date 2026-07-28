import type { DbConfig } from '@/interfaces'

const AUTH_SOURCE_PARAM = 'authSource'

function buildCredentials(config: DbConfig): string {
    if (!config.user) return ''
    const user = encodeURIComponent(config.user)
    const pass = config.password ? `:${encodeURIComponent(config.password)}` : ''
    return `${user}${pass}@`
}

function buildQuery(config: DbConfig): string {
    const params = new URLSearchParams()
    if (config.ssl) params.set('tls', 'true')
    if (config.authSource) params.set(AUTH_SOURCE_PARAM, config.authSource)
    const query = params.toString()
    return query ? `?${query}` : ''
}

function rewriteUri(uri: string, authSource: string | undefined, dbName?: string): string {
    try {
        const url = new URL(uri)
        if (dbName !== undefined) url.pathname = `/${dbName}`
        if (authSource && !url.searchParams.has(AUTH_SOURCE_PARAM)) {
            url.searchParams.set(AUTH_SOURCE_PARAM, authSource)
        }
        return url.toString()
    } catch {
        return uri
    }
}

export function buildMongoUri(config: DbConfig, dbName?: string): string {
    if (config.uri) {
        if (!dbName && !config.authSource) return config.uri
        return rewriteUri(config.uri, config.authSource, dbName)
    }

    const database = dbName || config.database || 'admin'
    return `mongodb://${buildCredentials(config)}${config.host}:${config.port}/${database}${buildQuery(config)}`
}

export function buildMongoHostUri(config: DbConfig): string {
    if (config.uri) return rewriteUri(config.uri, config.authSource, '')

    return `mongodb://${buildCredentials(config)}${config.host}:${config.port}/${buildQuery(config)}`
}
