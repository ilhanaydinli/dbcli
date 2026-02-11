import { isCancel, select, text } from '@clack/prompts'
import { readdir, stat } from 'fs/promises'
import { join } from 'path'

import { AdapterFactory } from '@/adapters/adapter-factory'
import { fetchDatabaseList, selectConfig, selectLocale } from '@/cli/prompts'
import {
    formatFileSize,
    formatRelativeTime,
    logSuccess,
    logWarn,
    withSpinner,
} from '@/helpers/utils'
import { DbNameSchema, zodValidate } from '@/validations'

export async function showImportMenu(): Promise<void> {
    const config = await selectConfig()

    const adapter = AdapterFactory.createAdapter(config)
    const databases = await withSpinner(
        'Testing connection and fetching databases...',
        () => fetchDatabaseList(adapter),
        'Databases fetched.',
        'Failed to fetch databases.',
    )

    let targetDbName = await select({
        message: 'Select Target Database',
        options: [
            { label: '+ Create New Database', value: '__create_new__' },
            ...databases.map((db) => ({ label: db.name, value: db.name, hint: db.size })),
        ],
    })

    if (isCancel(targetDbName)) return

    if (targetDbName === '__create_new__') {
        const newDbResponse = await text({
            message: 'Enter new database name',
            validate: (value) => zodValidate(DbNameSchema, value),
        })

        if (isCancel(newDbResponse)) return

        const localeResult = await selectLocale(adapter)
        if (!localeResult) return

        await adapter.createDatabase(newDbResponse as string, { locale: localeResult.locale })
        logSuccess(
            `Database '${newDbResponse}' created with locale '${localeResult.locale || localeResult.serverDefault}' (UTF8).`,
        )
        targetDbName = newDbResponse
    }

    const targetConfig = { ...config, database: targetDbName as string }
    const targetAdapter = AdapterFactory.createAdapter(targetConfig)

    const extensionsMap: Record<string, string[]> = {
        postgres: ['.sql'],
    }
    const allowedExtensions = extensionsMap[targetConfig.type] || []

    const cwd = process.cwd()
    const allFiles = (await readdir(cwd)).filter((f) =>
        allowedExtensions.some((ext) => f.endsWith(ext)),
    )

    const filesWithStats = await Promise.all(
        allFiles.map(async (f) => {
            const s = await stat(join(cwd, f))
            return { name: f, size: s.size, mtimeMs: s.mtimeMs }
        }),
    )

    const sortedFiles = filesWithStats.sort((a, b) => b.mtimeMs - a.mtimeMs)

    if (sortedFiles.length === 0) {
        logWarn(
            `No files found for ${targetConfig.type} (${allowedExtensions.join(', ')}) in current directory.`,
        )
        return
    }

    const fileResponse = await select({
        message: 'Select file to import',
        options: sortedFiles.map((f) => ({
            label: f.name,
            value: f.name,
            hint: `${formatFileSize(f.size)} - ${formatRelativeTime(f.mtimeMs)}`,
        })),
    })

    if (isCancel(fileResponse)) return

    const resetResponse = await select({
        message: `Do you want to reset the database '${targetConfig.database}' before importing? (This will delete all existing data)`,
        options: [
            { label: 'No, just import', value: false },
            { label: 'Yes, reset database', value: true },
        ],
        initialValue: false,
    })

    if (isCancel(resetResponse)) return

    await withSpinner(
        `Importing into '${targetConfig.database}'...`,
        () => targetAdapter.import(fileResponse as string, { reset: resetResponse as boolean }),
        'Import completed successfully!',
        'Import failed.',
    )
}
