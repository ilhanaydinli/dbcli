import { confirm, isCancel, text } from '@clack/prompts'
import { existsSync } from 'fs'
import { join } from 'path'

import { AdapterFactory } from '@/adapters/adapter-factory'
import { fetchDatabaseList, selectConfig, selectPath, selectWithSearch } from '@/cli/prompts'
import { ConfigManager } from '@/core/config-manager'
import { logWarn, withSpinner, withTimedSpinner } from '@/helpers/utils'
import { DbType } from '@/interfaces'
import { FilenameSchema, zodValidate } from '@/validations'

const configManager = ConfigManager.getInstance()

export async function showExportMenu(): Promise<void> {
    const config = await selectConfig()

    const adapter = AdapterFactory.createAdapter(config)
    const databases = await withSpinner(
        'Testing connection and fetching databases...',
        () => fetchDatabaseList(adapter),
        'Databases fetched.',
        'Failed to fetch databases.',
    )

    const database = await selectWithSearch<string>({
        message: 'Select Database to Export',
        items: databases.map((db) => ({ label: db.name, value: db.name, hint: db.size })),
    })

    if (isCancel(database)) return

    const targetConfig = { ...config, database: database as string }
    const targetAdapter = AdapterFactory.createAdapter(targetConfig)

    const dirChoice = await selectPath({
        message: 'Select output directory',
        mode: 'directory',
        initialDir: configManager.getPreference('lastDbDumpDir') ?? process.cwd(),
    })
    if (isCancel(dirChoice)) return
    const outDir = dirChoice as string
    configManager.setPreference('lastDbDumpDir', outDir)

    const ext = targetConfig.type === DbType.MongoDB ? 'archive' : 'sql'
    const filename = await text({
        message: `Output filename (default: dump_YYYYMMDD.${ext})`,
        initialValue: `dump_${database}_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.${ext}`,
        validate: (value) => zodValidate(FilenameSchema, value),
    })

    if (isCancel(filename)) return

    const fullPath = join(outDir, filename as string)

    if (existsSync(fullPath)) {
        const overwrite = await confirm({
            message: `File '${fullPath}' already exists. Overwrite?`,
            initialValue: false,
        })

        if (isCancel(overwrite) || !overwrite) {
            logWarn('Export cancelled.')
            return
        }
    }

    await withTimedSpinner(
        `Exporting database '${targetConfig.database}'...`,
        () => targetAdapter.export(fullPath),
        `Export completed successfully to ${fullPath}`,
        'Export failed',
    )
}
