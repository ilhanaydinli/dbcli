import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'

const CACHE_PATH = join(homedir(), '.config', 'dbcli', 'update-cache.json')

interface UpdateCache {
    latestVersion: string
}

function isNewerVersion(current: string, latest: string): boolean {
    const parse = (v: string) => v.replace(/^v/, '').split('.').map(Number)
    const [cMaj, cMin, cPatch] = parse(current)
    const [lMaj, lMin, lPatch] = parse(latest)
    if (lMaj !== cMaj) return lMaj > cMaj
    if (lMin !== cMin) return lMin > cMin
    return lPatch > cPatch
}

function readCache(path: string = CACHE_PATH): UpdateCache | null {
    try {
        if (!existsSync(path)) return null
        const data = JSON.parse(readFileSync(path, 'utf-8')) as Partial<UpdateCache>
        if (typeof data?.latestVersion !== 'string') return null
        return { latestVersion: data.latestVersion }
    } catch {
        return null
    }
}

function writeCache(cache: UpdateCache, path: string = CACHE_PATH): void {
    try {
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, JSON.stringify(cache), 'utf-8')
    } catch {
        // silent fail
    }
}

export function readPendingUpdate(
    currentVersion: string,
    path: string = CACHE_PATH,
): string | null {
    const cache = readCache(path)
    if (!cache) return null
    return isNewerVersion(currentVersion, cache.latestVersion) ? cache.latestVersion : null
}

export async function checkForUpdate(
    currentVersion: string,
    path: string = CACHE_PATH,
): Promise<string | null> {
    try {
        const response = await fetch('https://registry.npmjs.org/@ilhanaydinli/dbcli/latest', {
            signal: AbortSignal.timeout(5000),
        })
        const data = (await response.json()) as { version: string }
        writeCache({ latestVersion: data.version }, path)
        return isNewerVersion(currentVersion, data.version) ? data.version : null
    } catch {
        return null
    }
}
