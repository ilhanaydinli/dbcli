import { isCancel, select, text } from '@clack/prompts'

import { AdapterFactory } from '@/adapters/adapter-factory'
import { showDatabaseActionMenu } from '@/cli/menus/database-actions'
import { fetchDatabaseList, selectConfig, selectLocale } from '@/cli/prompts'
import { DatabaseAction } from '@/cli/types'
import { logSuccess, withSpinner } from '@/helpers/utils'
import type { DatabaseAdapter } from '@/interfaces'
import { DbNameSchema, zodValidate } from '@/validations'

export async function showDatabaseMenu(): Promise<void> {
    const config = await selectConfig()
    const adapter = AdapterFactory.createAdapter(config)

    while (true) {
        const databases = await withSpinner(
            'Fetching databases...',
            () => fetchDatabaseList(adapter),
            'Databases fetched.',
            'Failed to fetch databases.',
        )

        const value = await select({
            message: `Manage Databases @ ${config.name}`,
            options: [
                { label: '+ Create New Database', value: DatabaseAction.Create },
                ...databases.map((db) => ({
                    label: db.name,
                    value: db.name,
                    hint: db.size,
                })),
                { label: '← Back', value: DatabaseAction.Back },
            ],
        })

        if (isCancel(value) || value === DatabaseAction.Back) return

        if (value === DatabaseAction.Create) {
            await createDatabase(adapter)
        } else {
            await showDatabaseActionMenu(adapter, value as string)
        }
    }
}

async function createDatabase(adapter: DatabaseAdapter): Promise<void> {
    const name = await text({
        message: 'Enter new database name',
        validate: (value) => zodValidate(DbNameSchema, value),
    })

    if (isCancel(name)) return

    const result = await selectLocale(adapter)
    if (!result) return

    await adapter.createDatabase(name as string, { locale: result.locale })
    logSuccess(
        `Database '${name}' created with locale '${result.locale || result.serverDefault}' (UTF8).`,
    )
}
