import { isCancel, select, text } from '@clack/prompts'

import { LocaleMenuAction } from '@/cli/types'
import { ConfigManager } from '@/core/config-manager'
import { ConfigError, ConnectionError } from '@/errors'
import { logInfo, withSpinner } from '@/helpers/utils'
import type { DatabaseAdapter, DatabaseInfo, DbConfig } from '@/interfaces'

const configManager = ConfigManager.getInstance()

export function ensureConnectionsExist(): DbConfig[] {
    const configs = configManager.getConfigs()
    if (configs.length === 0) {
        throw new ConfigError('No saved database connections found. Please add one first.')
    }
    return configs
}

export async function selectConfig(): Promise<DbConfig> {
    const configs = ensureConnectionsExist()

    if (configs.length === 1) {
        const config = configs[0]
        logInfo(`Using default connection: ${config.name} (${config.host}:${config.database})`)
        return config
    }

    const id = await select({
        message: 'Select Database Connection',
        options: configs.map((c: DbConfig) => ({
            label: `${c.name} (${c.host}:${c.database})`,
            value: c.id,
            hint: c.group,
        })),
    })

    if (isCancel(id)) {
        throw new ConfigError('Operation cancelled.')
    }

    const config = configManager.getConfig(id as string)
    if (!config) {
        throw new ConfigError('Selected connection no longer exists.')
    }

    return config
}

export async function fetchDatabaseList(adapter: DatabaseAdapter): Promise<DatabaseInfo[]> {
    const connected = await adapter.testConnection()
    if (!connected) {
        throw new ConnectionError('Connection failed. Please check your credentials.')
    }
    return adapter.listDatabases()
}

export async function selectLocale(
    adapter: DatabaseAdapter,
): Promise<{ locale: string | undefined; serverDefault: string } | null> {
    const localeResult = await withSpinner(
        'Fetching available locales...',
        () => adapter.getLocales(),
        'Locales fetched.',
        'Failed to fetch locales.',
    )

    const locales = localeResult.locales
    const serverDefault = localeResult.default

    let selectedLocale: string | undefined = undefined

    if (locales.length > 0) {
        let currentLocales = locales
        let searchMode = false
        let lastSearchTerm = ''

        while (true) {
            const localeOptions = []

            if (searchMode) {
                localeOptions.push({
                    label: `🔍 Modify Search (Current: "${lastSearchTerm}")`,
                    value: LocaleMenuAction.Search,
                })
                localeOptions.push({
                    label: '❌ Clear Search',
                    value: LocaleMenuAction.ClearSearch,
                })
            } else {
                localeOptions.push({
                    label: '🔍 Search Locale...',
                    value: LocaleMenuAction.Search,
                })
                localeOptions.push({
                    label: `Default (Server: ${serverDefault})`,
                    value: LocaleMenuAction.Default,
                })
            }

            localeOptions.push(...currentLocales.map((l) => ({ label: l, value: l })))

            const message = searchMode
                ? `Select Locale (Found ${currentLocales.length} results for "${lastSearchTerm}")`
                : 'Select Database Locale (Encoding: UTF8)'

            const localeSelection = await select({
                message,
                options: localeOptions,
                initialValue: searchMode
                    ? currentLocales[0] || LocaleMenuAction.Search
                    : LocaleMenuAction.Default,
            })

            if (isCancel(localeSelection)) return null

            if (localeSelection === LocaleMenuAction.ClearSearch) {
                currentLocales = locales
                searchMode = false
                lastSearchTerm = ''
                continue
            }

            if (localeSelection === LocaleMenuAction.Search) {
                const searchTerm = await text({
                    message: 'Enter search term (case-insensitive):',
                    placeholder: 'e.g. tr_TR, utf8',
                    initialValue: lastSearchTerm,
                })

                if (isCancel(searchTerm)) continue

                const term = String(searchTerm).trim().toLowerCase()

                if (!term) {
                    currentLocales = locales
                    searchMode = false
                    lastSearchTerm = ''
                } else {
                    currentLocales = locales.filter((l) => l.toLowerCase().includes(term))
                    searchMode = true
                    lastSearchTerm = String(searchTerm).trim()
                }
                continue
            }

            if (localeSelection !== LocaleMenuAction.Default) {
                selectedLocale = localeSelection as string
            }
            break
        }
    }

    return { locale: selectedLocale, serverDefault }
}
