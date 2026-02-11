import { intro, isCancel, outro, select } from '@clack/prompts'

import { showConnectionMenu } from '@/cli/menus/connection'
import { showDatabaseMenu } from '@/cli/menus/database'
import { showExportMenu } from '@/cli/menus/export'
import { showImportMenu } from '@/cli/menus/import'
import { showSettingsMenu } from '@/cli/menus/settings'
import { MainMenuAction } from '@/cli/types'
import { ConfigManager } from '@/core/config-manager'
import { DbCliError } from '@/errors'
import { logError, logWarn } from '@/helpers/utils'

export class App {
    async run(): Promise<void> {
        console.clear()

        await ConfigManager.getInstance().init()

        intro('DB CLI Manager')

        while (true) {
            const value = await select({
                message: 'Main Menu',
                options: [
                    {
                        label: 'Import Database',
                        value: MainMenuAction.Import,
                        hint: 'Import a SQL file to a database',
                    },
                    {
                        label: 'Export Database',
                        value: MainMenuAction.Export,
                        hint: 'Export a database to a SQL file',
                    },
                    {
                        label: 'Manage Databases',
                        value: MainMenuAction.ManageDbs,
                        hint: 'Create/Clone/Rename/Delete databases',
                    },
                    {
                        label: 'Manage Connections',
                        value: MainMenuAction.Manage,
                        hint: 'Add/Edit/Remove connections',
                    },
                    {
                        label: 'Settings',
                        value: MainMenuAction.Settings,
                        hint: 'Export/Import connection configs',
                    },
                    { label: 'Exit', value: MainMenuAction.Exit },
                ],
            })

            if (isCancel(value) || value === MainMenuAction.Exit) {
                outro('Goodbye!')
                process.exit(0)
            }

            try {
                const handler = menuActions[value as MainMenuAction]
                if (handler) {
                    await handler()
                }
            } catch (error: unknown) {
                if (error instanceof DbCliError) {
                    logWarn(error.message)
                } else {
                    logError(`Error: ${(error as Error).message}`)
                }
            }
        }
    }
}

const menuActions: Partial<Record<MainMenuAction, () => Promise<void>>> = {
    [MainMenuAction.Import]: showImportMenu,
    [MainMenuAction.Export]: showExportMenu,
    [MainMenuAction.ManageDbs]: showDatabaseMenu,
    [MainMenuAction.Manage]: showConnectionMenu,
    [MainMenuAction.Settings]: showSettingsMenu,
}
