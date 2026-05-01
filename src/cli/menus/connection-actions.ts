import { confirm, isCancel, password, select } from '@clack/prompts'

import { addConnection } from '@/cli/menus/connection'
import { ConnectionItemAction } from '@/cli/types'
import { ConfigManager } from '@/core/config-manager'
import { formatConnectionLabel, logSuccess } from '@/helpers/utils'
import type { DbConfig } from '@/interfaces'

const configManager = ConfigManager.getInstance()

type ActionHandler = (config: DbConfig) => Promise<void>

export async function showConnectionActionMenu(config: DbConfig): Promise<void> {
    const action = await select({
        message: `Action for connection: ${formatConnectionLabel(config)}`,
        options: [
            { label: 'Edit Connection', value: ConnectionItemAction.Edit },
            { label: 'Update Password', value: ConnectionItemAction.UpdatePassword },
            { label: 'Remove Connection', value: ConnectionItemAction.Remove },
            { label: 'Back', value: ConnectionItemAction.Back },
        ],
    })

    if (isCancel(action) || action === ConnectionItemAction.Back) return

    const handler = actions[action as ConnectionItemAction]
    if (handler) await handler(config)
}

const actions: Partial<Record<ConnectionItemAction, ActionHandler>> = {
    [ConnectionItemAction.Edit]: editConnection,
    [ConnectionItemAction.UpdatePassword]: updatePassword,
    [ConnectionItemAction.Remove]: removeConnection,
}

async function editConnection(config: DbConfig): Promise<void> {
    await configManager.removeConfig(config.id)
    await addConnection(config)

    if (!configManager.getConfig(config.id)) {
        await configManager.addConfig(config)
    }
}

async function updatePassword(config: DbConfig): Promise<void> {
    const pw = await password({
        message: `New password for '${config.name}'`,
    })

    if (isCancel(pw)) return

    config.password = (pw as string) || ''
    await configManager.updateConfig(config)
    logSuccess(`Password updated for '${config.name}'.`)
}

async function removeConnection(config: DbConfig): Promise<void> {
    const shouldRemove = await confirm({
        message: `Remove connection '${config.name}'?`,
        initialValue: false,
    })

    if (isCancel(shouldRemove) || !shouldRemove) return

    await configManager.removeConfig(config.id)
    logSuccess(`Connection '${config.name}' removed.`)
}
