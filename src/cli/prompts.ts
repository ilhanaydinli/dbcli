import { autocomplete, isCancel, type Option } from '@clack/prompts'

import { LocaleMenuAction } from '@/cli/types'
import { ConfigManager } from '@/core/config-manager'
import { ConfigError, ConnectionError } from '@/errors'
import { formatConnectionLabel, logInfo, withSpinner } from '@/helpers/utils'
import type { DatabaseAdapter, DatabaseInfo, DbConfig } from '@/interfaces'

const configManager = ConfigManager.getInstance()

type Primitive = string | boolean | number

type SelectSearchOption<T extends Primitive> = { label: string; value: T; hint?: string }

type SelectSearchOptions<T extends Primitive> = {
    message: string
    items: SelectSearchOption<T>[]
    pinnedTop?: SelectSearchOption<T>[]
    pinnedBottom?: SelectSearchOption<T>[]
    initialValue?: T
    placeholder?: string
    maxItems?: number
}

export function selectWithSearch<T extends Primitive>(
    opts: SelectSearchOptions<T>,
): Promise<T | symbol> {
    const pinnedTop = opts.pinnedTop ?? []
    const pinnedBottom = opts.pinnedBottom ?? []
    const pinnedValues = new Set<unknown>([
        ...pinnedTop.map((o) => o.value),
        ...pinnedBottom.map((o) => o.value),
    ])

    return autocomplete<T>({
        message: opts.message,
        options: [...pinnedTop, ...opts.items, ...pinnedBottom] as Option<T>[],
        initialValue: opts.initialValue,
        placeholder: opts.placeholder ?? 'Type to search...',
        maxItems: opts.maxItems ?? 10,
        filter: (search, option) => {
            if (pinnedValues.has(option.value)) return true
            const term = search.toLowerCase()
            const label = String(option.label ?? '').toLowerCase()
            const hint = String(option.hint ?? '').toLowerCase()
            const value = String(option.value ?? '').toLowerCase()
            return label.includes(term) || hint.includes(term) || value.includes(term)
        },
    })
}

function ensureConnectionsExist(): DbConfig[] {
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
        logInfo(`Using default connection: ${formatConnectionLabel(config)}`)
        return config
    }

    const id = await selectWithSearch<string>({
        message: 'Select Database Connection',
        items: configs.map((c: DbConfig) => ({
            label: formatConnectionLabel(c),
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

    if (locales.length === 0) {
        return { locale: undefined, serverDefault }
    }

    const selection = await selectWithSearch<string>({
        message: 'Select Database Locale (Encoding: UTF8)',
        pinnedTop: [
            {
                label: `Default (Server: ${serverDefault})`,
                value: LocaleMenuAction.Default,
            },
        ],
        items: locales.map((l) => ({ label: l, value: l })),
        initialValue: LocaleMenuAction.Default,
    })

    if (isCancel(selection)) return null

    const locale = selection === LocaleMenuAction.Default ? undefined : (selection as string)
    return { locale, serverDefault }
}
