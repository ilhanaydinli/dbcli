import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { checkForUpdate, readPendingUpdate } from '@/helpers/update-checker'

const originalFetch = globalThis.fetch

let tmpDir: string
let cachePath: string

beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dbcli-update-test-'))
    cachePath = join(tmpDir, 'cache.json')
})

afterEach(() => {
    globalThis.fetch = originalFetch
    rmSync(tmpDir, { recursive: true, force: true })
})

function mockFetch(version: string): void {
    globalThis.fetch = (async () =>
        new Response(JSON.stringify({ version }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        })) as unknown as typeof fetch
}

function mockFetchFailure(): void {
    globalThis.fetch = (async () => {
        throw new Error('Network error')
    }) as unknown as typeof fetch
}

describe('checkForUpdate', () => {
    it('returns latest version when update is available (patch bump)', async () => {
        mockFetch('1.8.1')
        const result = await checkForUpdate('1.8.0', cachePath)
        expect(result).toBe('1.8.1')
    })

    it('returns latest version when update is available (minor bump)', async () => {
        mockFetch('1.9.0')
        const result = await checkForUpdate('1.8.0', cachePath)
        expect(result).toBe('1.9.0')
    })

    it('returns latest version when update is available (major bump)', async () => {
        mockFetch('2.0.0')
        const result = await checkForUpdate('1.8.0', cachePath)
        expect(result).toBe('2.0.0')
    })

    it('returns null when already on latest version', async () => {
        mockFetch('1.8.0')
        const result = await checkForUpdate('1.8.0', cachePath)
        expect(result).toBeNull()
    })

    it('returns null when current version is newer than registry', async () => {
        mockFetch('1.7.0')
        const result = await checkForUpdate('1.8.0', cachePath)
        expect(result).toBeNull()
    })

    it('returns null on network failure', async () => {
        mockFetchFailure()
        const result = await checkForUpdate('1.8.0', cachePath)
        expect(result).toBeNull()
    })

    it('writes the fetched version to cache on success', async () => {
        mockFetch('1.9.0')
        await checkForUpdate('1.8.0', cachePath)
        expect(existsSync(cachePath)).toBe(true)
        const result = readPendingUpdate('1.8.0', cachePath)
        expect(result).toBe('1.9.0')
    })

    it('does not write cache on network failure', async () => {
        mockFetchFailure()
        await checkForUpdate('1.8.0', cachePath)
        expect(existsSync(cachePath)).toBe(false)
    })
})

describe('readPendingUpdate', () => {
    it('returns null when cache file does not exist', () => {
        const result = readPendingUpdate('1.8.0', cachePath)
        expect(result).toBeNull()
    })

    it('returns version when cache has newer version', () => {
        writeFileSync(cachePath, JSON.stringify({ latestVersion: '1.9.0' }))
        const result = readPendingUpdate('1.8.0', cachePath)
        expect(result).toBe('1.9.0')
    })

    it('returns null when cache version equals current', () => {
        writeFileSync(cachePath, JSON.stringify({ latestVersion: '1.8.0' }))
        const result = readPendingUpdate('1.8.0', cachePath)
        expect(result).toBeNull()
    })

    it('returns null when cache version is older than current', () => {
        writeFileSync(cachePath, JSON.stringify({ latestVersion: '1.7.0' }))
        const result = readPendingUpdate('1.8.0', cachePath)
        expect(result).toBeNull()
    })

    it('returns null when cache file is malformed', () => {
        writeFileSync(cachePath, 'not valid json')
        const result = readPendingUpdate('1.8.0', cachePath)
        expect(result).toBeNull()
    })

    it('returns null when cache file has missing fields', () => {
        writeFileSync(cachePath, JSON.stringify({ otherField: 'foo' }))
        const result = readPendingUpdate('1.8.0', cachePath)
        expect(result).toBeNull()
    })
})
