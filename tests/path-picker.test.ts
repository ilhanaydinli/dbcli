import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'

import { expandTilde, listEntries, parseInputPath } from '@/cli/prompts'

const root = join(tmpdir(), 'db-cli-path-picker-test')

beforeAll(() => {
    rmSync(root, { recursive: true, force: true })
    mkdirSync(root, { recursive: true })
    mkdirSync(join(root, 'subdir-a'))
    mkdirSync(join(root, 'subdir-b'))
    writeFileSync(join(root, 'dump_old.sql'), 'old')
    writeFileSync(join(root, 'dump_new.sql'), 'new')
    writeFileSync(join(root, 'notes.txt'), 'ignore me')
    writeFileSync(join(root, '.hidden'), 'hidden')
})

afterAll(() => {
    rmSync(root, { recursive: true, force: true })
})

describe('expandTilde', () => {
    it('expands ~ to homedir', () => {
        expect(expandTilde('~')).toBe(homedir())
    })

    it('expands ~/foo', () => {
        expect(expandTilde('~/foo')).toBe(join(homedir(), 'foo'))
    })

    it('returns unchanged absolute paths', () => {
        expect(expandTilde('/tmp/x')).toBe('/tmp/x')
    })

    it('returns unchanged paths that contain but do not start with ~', () => {
        expect(expandTilde('/tmp/~backup')).toBe('/tmp/~backup')
    })
})

describe('parseInputPath', () => {
    const base = '/Users/me/dumps'

    it('returns base with empty prefix on empty input', () => {
        expect(parseInputPath('', base)).toEqual({ dir: base, prefix: '' })
    })

    it('treats trailing slash as directory listing (no prefix)', () => {
        expect(parseInputPath('/Users/me/dumps/', base)).toEqual({
            dir: '/Users/me/dumps',
            prefix: '',
        })
    })

    it('splits absolute path into dirname + basename', () => {
        expect(parseInputPath('/Users/me/dumps/foo', base)).toEqual({
            dir: '/Users/me/dumps',
            prefix: 'foo',
        })
    })

    it('resolves relative paths against baseDir', () => {
        expect(parseInputPath('sub/bar', base)).toEqual({
            dir: '/Users/me/dumps/sub',
            prefix: 'bar',
        })
    })

    it('expands ~ in input', () => {
        const { dir } = parseInputPath('~/foo', base)
        expect(dir).toBe(homedir())
    })

    it('expands ~/ with subpath', () => {
        const { dir, prefix } = parseInputPath('~/foo/bar', base)
        expect(dir).toBe(join(homedir(), 'foo'))
        expect(prefix).toBe('bar')
    })

    it('handles root /', () => {
        const result = parseInputPath('/', base)
        expect(result.dir).toBe('/')
        expect(result.prefix).toBe('')
    })

    it('handles bare filename as prefix in baseDir', () => {
        expect(parseInputPath('foo', base)).toEqual({
            dir: base,
            prefix: 'foo',
        })
    })
})

describe('listEntries', () => {
    it('returns only directories in directory mode', async () => {
        const entries = await listEntries(root, { mode: 'directory' })
        expect(entries.every((e) => e.isDir)).toBe(true)
        expect(entries.map((e) => e.name).sort()).toEqual(['subdir-a', 'subdir-b'])
    })

    it('returns dirs and matching files in file mode', async () => {
        const entries = await listEntries(root, { mode: 'file', extensions: ['.sql'] })
        const names = entries.map((e) => e.name)
        expect(names).toContain('subdir-a')
        expect(names).toContain('dump_old.sql')
        expect(names).toContain('dump_new.sql')
        expect(names).not.toContain('notes.txt')
    })

    it('orders directories before files', async () => {
        const entries = await listEntries(root, { mode: 'file', extensions: ['.sql'] })
        const firstFileIndex = entries.findIndex((e) => !e.isDir)
        const lastDirIndex = entries.map((e) => e.isDir).lastIndexOf(true)
        expect(lastDirIndex).toBeLessThan(firstFileIndex)
    })

    it('hides dotfiles', async () => {
        const entries = await listEntries(root, { mode: 'file' })
        expect(entries.find((e) => e.name === '.hidden')).toBeUndefined()
    })

    it('returns all files when no extensions provided', async () => {
        const entries = await listEntries(root, { mode: 'file' })
        const fileNames = entries.filter((e) => !e.isDir).map((e) => e.name)
        expect(fileNames).toContain('notes.txt')
        expect(fileNames).toContain('dump_old.sql')
    })
})
