import { confirm, isCancel, select, text } from '@clack/prompts'
import { existsSync } from 'fs'

import { AdapterFactory } from '@/adapters/adapter-factory'
import { fetchDatabaseList, selectConfig } from '@/cli/prompts'
import { logWarn, withSpinner } from '@/helpers/utils'
import { FilenameSchema, zodValidate } from '@/validations'

export async function showExportMenu(): Promise<void> {
    const config = await selectConfig()

    const adapter = AdapterFactory.createAdapter(config)
    const databases = await withSpinner(
        'Testing connection and fetching databases...',
        () => fetchDatabaseList(adapter),
        'Databases fetched.',
        'Failed to fetch databases.',
    )

    const database = await select({
        message: 'Select Database to Export',
        options: databases.map((db) => ({ label: db.name, value: db.name, hint: db.size })),
    })

    if (isCancel(database)) return

    const targetConfig = { ...config, database: database as string }
    const targetAdapter = AdapterFactory.createAdapter(targetConfig)

    const filename = await text({
        message: 'Output filename (default: dump_YYYYMMDD.sql)',
        initialValue: `dump_${database}_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.sql`,
        validate: (value) => zodValidate(FilenameSchema, value),
    })

    if (isCancel(filename)) return

    if (existsSync(filename as string)) {
        const overwrite = await confirm({
            message: `File '${filename}' already exists. Overwrite?`,
            initialValue: false,
        })

        if (isCancel(overwrite) || !overwrite) {
            logWarn('Export cancelled.')
            return
        }
    }

    await withSpinner(
        `Exporting database '${targetConfig.database}'...`,
        () => targetAdapter.export(filename as string),
        `Export completed successfully to ${filename}`,
    )
}
