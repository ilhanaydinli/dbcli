import { isCancel, select, text } from '@clack/prompts'
import { dirname } from 'path'

import { AdapterFactory } from '@/adapters/adapter-factory'
import {
    fetchDatabaseList,
    selectConfig,
    selectLocale,
    selectPath,
    selectWithSearch,
} from '@/cli/prompts'
import { ConfigManager } from '@/core/config-manager'
import { logSuccess, withSpinner } from '@/helpers/utils'
import { DbType } from '@/interfaces'
import { DbNameSchema, zodValidate } from '@/validations'

const configManager = ConfigManager.getInstance()

export async function showImportMenu(): Promise<void> {
    const config = await selectConfig()

    const adapter = AdapterFactory.createAdapter(config)
    const databases = await withSpinner(
        'Testing connection and fetching databases...',
        () => fetchDatabaseList(adapter),
        'Databases fetched.',
        'Failed to fetch databases.',
    )

    let targetDbName = await selectWithSearch<string>({
        message: 'Select Target Database',
        pinnedTop: [{ label: '+ Create New Database', value: '__create_new__' }],
        items: databases.map((db) => ({ label: db.name, value: db.name, hint: db.size })),
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

    const extensionsMap: Record<DbType, string[]> = {
        [DbType.Postgres]: ['.sql'],
        [DbType.MongoDB]: ['.archive'],
        [DbType.MySQL]: ['.sql'],
        [DbType.MariaDB]: ['.sql'],
        [DbType.MSSQL]: ['.sql'],
    }
    const allowedExtensions = extensionsMap[targetConfig.type] || []

    const fileChoice = await selectPath({
        message: 'Select file to import',
        mode: 'file',
        initialDir: configManager.getPreference('lastDbDumpDir') ?? process.cwd(),
        extensions: allowedExtensions,
    })
    if (isCancel(fileChoice)) return
    const filePath = fileChoice as string
    configManager.setPreference('lastDbDumpDir', dirname(filePath))

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
        () => targetAdapter.import(filePath, { reset: resetResponse as boolean }),
        'Import completed successfully!',
        'Import failed.',
    )
}
