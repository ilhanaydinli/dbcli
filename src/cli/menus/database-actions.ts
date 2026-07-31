import { confirm, isCancel, select, spinner, text } from '@clack/prompts'

import { DatabaseItemAction } from '@/cli/types'
import type { DatabaseAdapter } from '@/interfaces'
import { DbNameSchema, zodValidate } from '@/validations'

type ActionContext = { adapter: DatabaseAdapter; dbName: string }
type ActionOutcome = 'stay' | 'exit'
type ActionHandler = (ctx: ActionContext) => Promise<ActionOutcome>

export async function showDatabaseActionMenu(
    adapter: DatabaseAdapter,
    dbName: string,
): Promise<void> {
    while (true) {
        const action = await select({
            message: `Action for database: ${dbName}`,
            options: [
                { label: 'Clone Database', value: DatabaseItemAction.Clone },
                { label: 'Rename Database', value: DatabaseItemAction.Rename },
                { label: 'Delete Database', value: DatabaseItemAction.Delete },
                { label: '← Back', value: DatabaseItemAction.Back },
            ],
        })

        if (isCancel(action) || action === DatabaseItemAction.Back) return

        const handler = actions[action as DatabaseItemAction]
        if (!handler) continue

        if ((await handler({ adapter, dbName })) === 'exit') return
    }
}

const actions: Partial<Record<DatabaseItemAction, ActionHandler>> = {
    [DatabaseItemAction.Clone]: cloneDatabase,
    [DatabaseItemAction.Rename]: renameDatabase,
    [DatabaseItemAction.Delete]: deleteDatabase,
}

async function cloneDatabase({ adapter, dbName }: ActionContext): Promise<ActionOutcome> {
    const value = await text({
        message: `Enter name for the clone of '${dbName}'`,
        initialValue: `${dbName}_copy`,
        validate: (value) => zodValidate(DbNameSchema, value),
    })

    if (isCancel(value)) return 'stay'

    const s = spinner()
    s.start(`Cloning '${dbName}' to '${value}'...`)
    await adapter.cloneDatabase(dbName, value as string)
    s.stop(`Database cloned successfully to '${value}'.`)
    return 'stay'
}

async function renameDatabase({ adapter, dbName }: ActionContext): Promise<ActionOutcome> {
    const value = await text({
        message: `Enter new name for '${dbName}'`,
        initialValue: dbName,
        validate: (value) => zodValidate(DbNameSchema, value),
    })

    if (isCancel(value)) return 'stay'

    const s = spinner()
    s.start(`Renaming '${dbName}' to '${value}'...`)
    await adapter.renameDatabase(dbName, value as string)
    s.stop('Database renamed successfully.')
    return 'exit'
}

async function deleteDatabase({ adapter, dbName }: ActionContext): Promise<ActionOutcome> {
    const shouldDelete = await confirm({
        message: `Are you sure you want to PERMANENTLY DELETE database '${dbName}'?`,
        initialValue: false,
    })

    if (isCancel(shouldDelete) || !shouldDelete) return 'stay'

    const s = spinner()
    s.start(`Deleting database '${dbName}'...`)
    await adapter.dropDatabase(dbName)
    s.stop(`Database '${dbName}' deleted.`)
    return 'exit'
}
