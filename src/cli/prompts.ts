import { autocomplete, isCancel, type Option } from '@clack/prompts'
import { existsSync, readdirSync, statSync } from 'fs'
import { readdir, stat } from 'fs/promises'
import { homedir } from 'os'
import { basename, dirname, join, resolve } from 'path'

import { LocaleMenuAction } from '@/cli/types'
import { ConfigManager } from '@/core/config-manager'
import { ConfigError, ConnectionError } from '@/errors'
import {
    formatConnectionLabel,
    formatFileSize,
    formatRelativeTime,
    logInfo,
    logWarn,
    withSpinner,
} from '@/helpers/utils'
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

export function expandTilde(path: string): string {
    if (path === '~') return homedir()
    if (path.startsWith('~/')) return join(homedir(), path.slice(2))
    return path
}

type PathEntry = { name: string; path: string; isDir: boolean; size: number; mtimeMs: number }

export async function listEntries(
    dir: string,
    opts: { mode: 'file' | 'directory'; extensions?: string[] },
): Promise<PathEntry[]> {
    const names = await readdir(dir)
    const entries = await Promise.all(
        names.map(async (name) => {
            try {
                const fullPath = join(dir, name)
                const st = await stat(fullPath)
                return {
                    name,
                    path: fullPath,
                    isDir: st.isDirectory(),
                    size: st.size,
                    mtimeMs: st.mtimeMs,
                }
            } catch {
                return null
            }
        }),
    )

    const filtered = entries.filter((e): e is PathEntry => e !== null && !e.name.startsWith('.'))
    const dirs = filtered.filter((e) => e.isDir).sort((a, b) => a.name.localeCompare(b.name))

    if (opts.mode === 'directory') return dirs

    const exts = opts.extensions ?? []
    const files = filtered
        .filter((e) => !e.isDir && (exts.length === 0 || exts.some((ext) => e.name.endsWith(ext))))
        .sort((a, b) => b.mtimeMs - a.mtimeMs)

    return [...dirs, ...files]
}

const DIR_CACHE_TTL_MS = 5000
const dirCache = new Map<string, { entries: PathEntry[]; expiresAt: number }>()

function readDirCached(dir: string): PathEntry[] {
    const now = Date.now()
    const cached = dirCache.get(dir)
    if (cached && cached.expiresAt > now) {
        return cached.entries
    }

    const names = readdirSync(dir)
    const entries: PathEntry[] = []
    for (const name of names) {
        if (name.startsWith('.')) continue
        try {
            const fullPath = join(dir, name)
            const st = statSync(fullPath)
            entries.push({
                name,
                path: fullPath,
                isDir: st.isDirectory(),
                size: st.size,
                mtimeMs: st.mtimeMs,
            })
        } catch {
            continue
        }
    }

    dirCache.set(dir, { entries, expiresAt: now + DIR_CACHE_TTL_MS })
    return entries
}

function listEntriesSync(
    dir: string,
    opts: { mode: 'file' | 'directory'; extensions?: string[] },
): PathEntry[] {
    const all = readDirCached(dir)
    const dirs = all.filter((e) => e.isDir).sort((a, b) => a.name.localeCompare(b.name))
    if (opts.mode === 'directory') return dirs

    const exts = opts.extensions ?? []
    const files = all
        .filter((e) => !e.isDir && (exts.length === 0 || exts.some((ext) => e.name.endsWith(ext))))
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
    return [...dirs, ...files]
}

export function parseInputPath(input: string, baseDir: string): { dir: string; prefix: string } {
    const expanded = expandTilde(input)
    if (!expanded) return { dir: baseDir, prefix: '' }
    const isDirInput = expanded.endsWith('/')
    const resolved = resolve(baseDir, expanded)
    if (isDirInput) {
        return { dir: resolved, prefix: '' }
    }
    return { dir: dirname(resolved), prefix: basename(resolved) }
}

async function manualPathEntry(opts: {
    mode: 'file' | 'directory'
    initialDir: string
    extensions?: string[]
}): Promise<string | symbol> {
    let baseDir = opts.initialDir
    let initialUserInput = baseDir.endsWith('/') ? baseDir : `${baseDir}/`

    while (true) {
        const result = await autocomplete<string>({
            message: 'Type path (suggestions update as you type)',
            initialUserInput,
            placeholder: baseDir,
            options: function () {
                const { dir } = parseInputPath(this.userInput, baseDir)
                let entries: PathEntry[]
                try {
                    entries = listEntriesSync(dir, {
                        mode: opts.mode,
                        extensions: opts.extensions,
                    })
                } catch {
                    return []
                }
                const options: Option<string>[] = []
                const wantsThisDir =
                    opts.mode === 'directory' &&
                    (this.userInput === '' || this.userInput.endsWith('/'))
                if (wantsThisDir && existsSync(dir) && statSync(dir).isDirectory()) {
                    options.push({
                        label: '✓ Use this directory',
                        value: dir,
                        hint: dir,
                    })
                }
                for (const e of entries) {
                    options.push({
                        label: e.isDir ? `${e.name}/` : e.name,
                        value: e.path,
                        hint: e.isDir
                            ? ''
                            : `${formatFileSize(e.size)} - ${formatRelativeTime(e.mtimeMs)}`,
                    })
                }
                return options
            },
            filter: (search, opt) => {
                const { dir, prefix } = parseInputPath(search, baseDir)
                if (opt.value === dir) return true
                if (!prefix) return true
                return String(opt.label ?? '')
                    .toLowerCase()
                    .startsWith(prefix.toLowerCase())
            },
        })

        if (isCancel(result)) return result

        const path = result as string
        try {
            const st = statSync(path)
            if (st.isDirectory()) {
                if (opts.mode === 'directory') return path
                baseDir = path
                initialUserInput = `${path}/`
                continue
            }
            return path
        } catch {
            return path
        }
    }
}

const PATH_USE_DIR = '__use_dir__'
const PATH_MANUAL = '__manual__'
const PATH_PARENT = '__parent__'

type SelectPathOptions = {
    message: string
    mode: 'file' | 'directory'
    initialDir: string
    extensions?: string[]
}

export async function selectPath(opts: SelectPathOptions): Promise<string | symbol> {
    let currentDir = resolve(expandTilde(opts.initialDir))
    if (!existsSync(currentDir) || !statSync(currentDir).isDirectory()) {
        currentDir = process.cwd()
    }

    while (true) {
        let entries: PathEntry[]
        try {
            entries = await listEntries(currentDir, {
                mode: opts.mode,
                extensions: opts.extensions,
            })
        } catch (e) {
            const parent = dirname(currentDir)
            if (parent === currentDir) {
                throw new Error(`Cannot read root directory ${currentDir}`, { cause: e })
            }
            logWarn(`Cannot read ${currentDir}: ${(e as Error).message}`)
            currentDir = parent
            continue
        }

        const pinnedTop: SelectSearchOption<string>[] = []
        if (opts.mode === 'directory') {
            pinnedTop.push({
                label: '✓ Use this directory',
                value: PATH_USE_DIR,
                hint: currentDir,
            })
        }
        pinnedTop.push({ label: '✏ Enter path manually...', value: PATH_MANUAL })
        const parent = dirname(currentDir)
        if (parent !== currentDir) {
            pinnedTop.push({ label: '[..] Parent directory', value: PATH_PARENT, hint: parent })
        }

        const items: SelectSearchOption<string>[] = entries.map((e) => ({
            label: e.isDir ? `${e.name}/` : e.name,
            value: e.path,
            hint: e.isDir ? '' : `${formatFileSize(e.size)} - ${formatRelativeTime(e.mtimeMs)}`,
        }))

        const choice = await selectWithSearch<string>({
            message: `${opts.message} — ${currentDir}`,
            pinnedTop,
            items,
        })

        if (isCancel(choice)) return choice

        if (choice === PATH_USE_DIR) return currentDir

        if (choice === PATH_PARENT) {
            currentDir = parent
            continue
        }

        if (choice === PATH_MANUAL) {
            const manual = await manualPathEntry({
                mode: opts.mode,
                initialDir: currentDir,
                extensions: opts.extensions,
            })
            if (isCancel(manual)) continue
            const path = manual as string
            const st = statSync(path)
            if (st.isDirectory()) {
                if (opts.mode === 'directory') return path
                currentDir = path
                continue
            }
            return path
        }

        const st = statSync(choice as string)
        if (st.isDirectory()) {
            currentDir = choice as string
            continue
        }
        return choice as string
    }
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
