import { confirm, isCancel, text } from '@clack/prompts'
import { existsSync } from 'fs'
import { join } from 'path'

import { AdapterFactory } from '@/adapters/adapter-factory'
import { fetchDatabaseList, pickConfig, selectPath, selectWithSearch } from '@/cli/prompts'
import { runWizard } from '@/cli/wizard'
import { ConfigManager } from '@/core/config-manager'
import { withSpinner, withTimedSpinner } from '@/helpers/utils'
import type { DbConfig } from '@/interfaces'
import { DbType } from '@/interfaces'
import { FilenameSchema, zodValidate } from '@/validations'

const configManager = ConfigManager.getInstance()

export async function showExportMenu(): Promise<void> {
    const draft: {
        config?: DbConfig
        database?: string
        outDir?: string
        filename?: string
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

            const database = await selectWithSearch<string>({
                message: 'Select Database to Export',
                items: databases.map((db) => ({ label: db.name, value: db.name, hint: db.size })),
                initialValue: draft.database,
            })
            if (isCancel(database)) return false

            if (draft.database !== database) draft.filename = undefined
            draft.database = database as string
            return true
        },
        async () => {
            const dirChoice = await selectPath({
                message: 'Select output directory',
                mode: 'directory',
                initialDir:
                    draft.outDir ?? configManager.getPreference('lastDbDumpDir') ?? process.cwd(),
            })
            if (isCancel(dirChoice)) return false

            draft.outDir = dirChoice as string
            configManager.setPreference('lastDbDumpDir', draft.outDir)
            return true
        },
        async () => {
            const ext = draft.config?.type === DbType.MongoDB ? 'archive' : 'sql'
            const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')

            while (true) {
                const filename = await text({
                    message: `Output filename (default: dump_YYYYMMDD.${ext})`,
                    initialValue: draft.filename ?? `dump_${draft.database}_${stamp}.${ext}`,
                    validate: (value) => zodValidate(FilenameSchema, value),
                })
                if (isCancel(filename)) return false

                const candidate = join(draft.outDir as string, filename as string)
                if (!existsSync(candidate)) {
                    draft.filename = filename as string
                    return true
                }

                const overwrite = await confirm({
                    message: `File '${candidate}' already exists. Overwrite?`,
                    initialValue: false,
                })
                if (isCancel(overwrite)) return false

                if (overwrite) {
                    draft.filename = filename as string
                    return true
                }

                draft.filename = undefined
            }
        },
    ])

    if (!completed) return

    const targetConfig = { ...(draft.config as DbConfig), database: draft.database as string }
    const fullPath = join(draft.outDir as string, draft.filename as string)
    const targetAdapter = AdapterFactory.createAdapter(targetConfig)

    await withTimedSpinner(
        `Exporting database '${targetConfig.database}'...`,
        () => targetAdapter.export(fullPath),
        `Export completed successfully to ${fullPath}`,
        'Export failed',
    )
}
