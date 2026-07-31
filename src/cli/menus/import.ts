import { isCancel, select, text } from '@clack/prompts'
import { dirname } from 'path'

import { AdapterFactory } from '@/adapters/adapter-factory'
import {
    fetchDatabaseList,
    pickConfig,
    selectLocale,
    selectPath,
    selectWithSearch,
} from '@/cli/prompts'
import { runWizard } from '@/cli/wizard'
import { ConfigManager } from '@/core/config-manager'
import { logSuccess, withSpinner, withTimedSpinner } from '@/helpers/utils'
import type { DatabaseAdapter, DbConfig } from '@/interfaces'
import { DbType } from '@/interfaces'
import { DbNameSchema, zodValidate } from '@/validations'

const configManager = ConfigManager.getInstance()

const CREATE_NEW = '__create_new__'

const extensionsMap: Record<DbType, string[]> = {
    [DbType.Postgres]: ['.sql'],
    [DbType.MongoDB]: ['.archive'],
    [DbType.MySQL]: ['.sql'],
    [DbType.MariaDB]: ['.sql'],
    [DbType.MSSQL]: ['.sql'],
}

export async function showImportMenu(): Promise<void> {
    const draft: {
        config?: DbConfig
        targetDb?: string
        filePath?: string
        reset?: boolean
    } = {}

    const completed = await runWizard([
        async () => {
            const picked = await pickConfig()
            if (!picked) return false
            draft.config = picked.config
            return picked.prompted ? true : 'skip'
        },
        async () => {
            const adapter = AdapterFactory.createAdapter(draft.config as DbConfig)
            const databases = await withSpinner(
                'Testing connection and fetching databases...',
                () => fetchDatabaseList(adapter),
                'Databases fetched.',
                'Failed to fetch databases.',
            )

            while (true) {
                const target = await selectWithSearch<string>({
                    message: 'Select Target Database',
                    pinnedTop: [{ label: '+ Create New Database', value: CREATE_NEW }],
                    items: databases.map((db) => ({
                        label: db.name,
                        value: db.name,
                        hint: db.size,
                    })),
                    initialValue: draft.targetDb,
                })
                if (isCancel(target)) return false

                if (target !== CREATE_NEW) {
                    draft.targetDb = target as string
                    return true
                }

                const created = await createTargetDatabase(adapter)
                if (created) {
                    draft.targetDb = created
                    return true
                }
            }
        },
        async () => {
            const allowedExtensions = extensionsMap[(draft.config as DbConfig).type] ?? []
            const fileChoice = await selectPath({
                message: 'Select file to import',
                mode: 'file',
                initialDir: draft.filePath
                    ? dirname(draft.filePath)
                    : (configManager.getPreference('lastDbDumpDir') ?? process.cwd()),
                extensions: allowedExtensions,
            })
            if (isCancel(fileChoice)) return false

            draft.filePath = fileChoice as string
            configManager.setPreference('lastDbDumpDir', dirname(draft.filePath))
            return true
        },
        async () => {
            const reset = await select({
                message: `Do you want to reset the database '${draft.targetDb}' before importing? (This will delete all existing data)`,
                options: [
                    { label: 'No, just import', value: false },
                    { label: 'Yes, reset database', value: true },
                ],
                initialValue: draft.reset ?? false,
            })
            if (isCancel(reset)) return false

            draft.reset = reset as boolean
            return true
        },
    ])

    if (!completed) return

    const targetConfig = { ...(draft.config as DbConfig), database: draft.targetDb as string }
    const targetAdapter = AdapterFactory.createAdapter(targetConfig)

    await withTimedSpinner(
        `Importing into '${targetConfig.database}'...`,
        () => targetAdapter.import(draft.filePath as string, { reset: draft.reset }),
        'Import completed successfully!',
        'Import failed.',
    )
}

async function createTargetDatabase(adapter: DatabaseAdapter): Promise<string | null> {
    const name = await text({
        message: 'Enter new database name',
        validate: (value) => zodValidate(DbNameSchema, value),
    })
    if (isCancel(name)) return null

    const localeResult = await selectLocale(adapter)
    if (!localeResult) return null

    await adapter.createDatabase(name as string, { locale: localeResult.locale })
    logSuccess(
        `Database '${name}' created with locale '${localeResult.locale || localeResult.serverDefault}' (UTF8).`,
    )
    return name as string
}
