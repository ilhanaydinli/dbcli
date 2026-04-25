import { confirm, isCancel, password, select, spinner, text } from '@clack/prompts'
import { randomUUID } from 'crypto'

import { AdapterFactory } from '@/adapters/adapter-factory'
import { ensureConnectionsExist } from '@/cli/prompts'
import { ConnectionMenuAction } from '@/cli/types'
import { ConfigManager } from '@/core/config-manager'
import {
    formatConnectionLabel,
    logError,
    logSuccess,
    logWarn,
    parseConnectionUrl,
    parseMongoUrl,
    parseMySQLUrl,
} from '@/helpers/utils'
import type { DbConfig } from '@/interfaces'
import { DbType } from '@/interfaces'
import {
    ConnectionNameSchema,
    DatabaseSchema,
    HostSchema,
    MongoUriSchema,
    PortSchema,
    UsernameSchema,
    zodValidate,
} from '@/validations'

const configManager = ConfigManager.getInstance()

export async function showConnectionMenu(): Promise<void> {
    while (true) {
        const value = await select({
            message: 'Manage Connections',
            options: [
                { label: 'Add Connection', value: ConnectionMenuAction.Add },
                {
                    label: 'Add from URL',
                    value: ConnectionMenuAction.AddFromUrl,
                    hint: 'postgresql://, mongodb://, mysql://',
                },
                { label: 'Edit Connection', value: ConnectionMenuAction.Edit },
                { label: 'Update Password', value: ConnectionMenuAction.UpdatePassword },
                { label: 'Remove Connection', value: ConnectionMenuAction.Remove },
                { label: '← Back', value: ConnectionMenuAction.Back },
            ],
        })

        if (isCancel(value) || value === ConnectionMenuAction.Back) return

        const handler = menuActions[value as ConnectionMenuAction]
        if (handler) {
            await handler()
        }
    }
}

const menuActions: Partial<Record<ConnectionMenuAction, () => void | Promise<void>>> = {
    [ConnectionMenuAction.Add]: addConnection,
    [ConnectionMenuAction.AddFromUrl]: addConnectionFromUrl,
    [ConnectionMenuAction.Edit]: editConnection,
    [ConnectionMenuAction.UpdatePassword]: updatePassword,
    [ConnectionMenuAction.Remove]: removeConnection,
}

async function addConnectionFromUrl(): Promise<void> {
    const url = await text({
        message: 'Paste connection URL',
        placeholder: 'postgresql://..., mongodb://..., or mysql://user:password@host:3306/database',
        validate: (value) => {
            if (!value) return 'URL is required'
            if (!parseConnectionUrl(value) && !parseMongoUrl(value) && !parseMySQLUrl(value))
                return 'Invalid connection URL'
            return undefined
        },
    })

    if (isCancel(url)) return

    const urlStr = url as string
    const isMongoUrl = urlStr.startsWith('mongodb://') || urlStr.startsWith('mongodb+srv://')
    const isMySQLUrl = urlStr.startsWith('mysql://')
    const isMariaDBUrl = urlStr.startsWith('mariadb://')

    if (isMongoUrl) {
        const parsed = parseMongoUrl(urlStr)!
        await addConnection({
            type: DbType.MongoDB,
            host: parsed.host,
            port: parsed.port,
            user: parsed.user,
            password: parsed.password,
            database: parsed.database,
            ssl: parsed.ssl,
            uri: urlStr,
        })
    } else if (isMySQLUrl || isMariaDBUrl) {
        const parsed = parseMySQLUrl(urlStr)!
        await addConnection({
            type: isMariaDBUrl ? DbType.MariaDB : DbType.MySQL,
            host: parsed.host,
            port: parsed.port,
            user: parsed.user,
            password: parsed.password,
            database: parsed.database,
            ssl: parsed.ssl,
        })
    } else {
        const parsed = parseConnectionUrl(urlStr)!
        await addConnection({
            host: parsed.host,
            port: parsed.port,
            user: parsed.user,
            password: parsed.password,
            database: parsed.database,
            ssl: parsed.ssl,
        })
    }
}

async function addConnection(initialValues?: Partial<DbConfig>): Promise<void> {
    const name = await text({
        message: 'Connection Name (e.g. Local Postgres)',
        initialValue: initialValues?.name,
        validate: (value) => zodValidate(ConnectionNameSchema, value),
    })
    if (isCancel(name)) return

    const type = await select({
        message: 'Database Type',
        initialValue: initialValues?.type || DbType.Postgres,
        options: [
            { label: 'PostgreSQL', value: DbType.Postgres },
            { label: 'MySQL', value: DbType.MySQL },
            { label: 'MariaDB', value: DbType.MariaDB },
            { label: 'MongoDB', value: DbType.MongoDB },
        ],
    })
    if (isCancel(type)) return

    const dbType = type as DbType

    if (dbType === DbType.MongoDB) {
        await addMongoConnection(name as string, initialValues)
    } else if (dbType === DbType.MySQL || dbType === DbType.MariaDB) {
        await addMySQLConnection(name as string, dbType, initialValues)
    } else {
        await addPostgresConnection(name as string, initialValues)
    }
}

async function addPostgresConnection(
    name: string,
    initialValues?: Partial<DbConfig>,
): Promise<void> {
    const host = await text({
        message: 'Host',
        initialValue: initialValues?.host || 'localhost',
        validate: (value) => zodValidate(HostSchema, value),
    })
    if (isCancel(host)) return

    const port = await text({
        message: 'Port',
        initialValue: String(initialValues?.port || 5432),
        validate: (value) => zodValidate(PortSchema, value),
    })
    if (isCancel(port)) return

    const database = await text({
        message: 'Maintenance Database',
        initialValue: initialValues?.database || 'postgres',
        validate: (value) => zodValidate(DatabaseSchema, value),
    })
    if (isCancel(database)) return

    const user = await text({
        message: 'Username',
        initialValue: initialValues?.user,
        validate: (value) => zodValidate(UsernameSchema, value),
    })
    if (isCancel(user)) return

    const pw = await password({ message: 'Password' })
    if (isCancel(pw)) return

    const ssl = await confirm({
        message: 'Use SSL?',
        initialValue: initialValues?.ssl ?? false,
    })
    if (isCancel(ssl)) return

    const group = await selectGroup(initialValues?.group)
    if (group === null) return

    const config: DbConfig = {
        id: initialValues?.id || randomUUID(),
        name,
        type: DbType.Postgres,
        host: host as string,
        port: Number(port),
        database: database as string,
        user: user as string,
        password: (pw as string) || initialValues?.password || '',
        ssl: ssl as boolean,
        verbose: false,
        group: group || undefined,
    }

    await testAndSaveConfig(config, () => addPostgresConnection(name, config))
}

async function addMySQLConnection(
    name: string,
    type: DbType.MySQL | DbType.MariaDB,
    initialValues?: Partial<DbConfig>,
): Promise<void> {
    const host = await text({
        message: 'Host',
        initialValue: initialValues?.host || 'localhost',
        validate: (value) => zodValidate(HostSchema, value),
    })
    if (isCancel(host)) return

    const port = await text({
        message: 'Port',
        initialValue: String(initialValues?.port || 3306),
        validate: (value) => zodValidate(PortSchema, value),
    })
    if (isCancel(port)) return

    const database = await text({
        message: 'Maintenance Database',
        initialValue: initialValues?.database || 'mysql',
        validate: (value) => zodValidate(DatabaseSchema, value),
    })
    if (isCancel(database)) return

    const user = await text({
        message: 'Username',
        initialValue: initialValues?.user || 'root',
        validate: (value) => zodValidate(UsernameSchema, value),
    })
    if (isCancel(user)) return

    const pw = await password({ message: 'Password' })
    if (isCancel(pw)) return

    const ssl = await confirm({
        message: 'Use SSL?',
        initialValue: initialValues?.ssl ?? false,
    })
    if (isCancel(ssl)) return

    const group = await selectGroup(initialValues?.group)
    if (group === null) return

    const config: DbConfig = {
        id: initialValues?.id || randomUUID(),
        name,
        type,
        host: host as string,
        port: Number(port),
        database: database as string,
        user: user as string,
        password: (pw as string) || initialValues?.password || '',
        ssl: ssl as boolean,
        verbose: false,
        group: group || undefined,
    }

    await testAndSaveConfig(config, () => addMySQLConnection(name, type, config))
}

async function addMongoConnection(name: string, initialValues?: Partial<DbConfig>): Promise<void> {
    const useUri = await confirm({
        message: 'Connect using a URI?',
        initialValue: !!initialValues?.uri,
    })
    if (isCancel(useUri)) return

    if (useUri) {
        await addMongoConnectionFromUri(name, initialValues)
    } else {
        await addMongoConnectionFromFields(name, initialValues)
    }
}

async function addMongoConnectionFromUri(
    name: string,
    initialValues?: Partial<DbConfig>,
): Promise<void> {
    const uri = await text({
        message: 'MongoDB URI',
        placeholder: 'mongodb://user:password@host:27017/mydb',
        initialValue: initialValues?.uri,
        validate: (value) => zodValidate(MongoUriSchema, value),
    })
    if (isCancel(uri)) return

    const parsed = parseMongoUrl(uri as string)

    const database = await text({
        message: 'Default Database',
        initialValue: initialValues?.database || parsed?.database || 'admin',
        validate: (value) => zodValidate(DatabaseSchema, value),
    })
    if (isCancel(database)) return

    const group = await selectGroup(initialValues?.group)
    if (group === null) return

    const config: DbConfig = {
        id: initialValues?.id || randomUUID(),
        name,
        type: DbType.MongoDB,
        host: parsed?.host || 'localhost',
        port: parsed?.port || 27017,
        user: parsed?.user || '',
        password: parsed?.password || initialValues?.password || '',
        database: database as string,
        ssl: parsed?.ssl ?? false,
        verbose: false,
        group: group || undefined,
        uri: uri as string,
    }

    await testAndSaveConfig(config, () => addMongoConnectionFromUri(name, config))
}

async function addMongoConnectionFromFields(
    name: string,
    initialValues?: Partial<DbConfig>,
): Promise<void> {
    const host = await text({
        message: 'Host',
        initialValue: initialValues?.host || 'localhost',
        validate: (value) => zodValidate(HostSchema, value),
    })
    if (isCancel(host)) return

    const port = await text({
        message: 'Port',
        initialValue: String(initialValues?.port || 27017),
        validate: (value) => zodValidate(PortSchema, value),
    })
    if (isCancel(port)) return

    const database = await text({
        message: 'Default Database',
        initialValue: initialValues?.database || 'admin',
        validate: (value) => zodValidate(DatabaseSchema, value),
    })
    if (isCancel(database)) return

    const user = await text({
        message: 'Username (leave empty if no auth)',
        initialValue: initialValues?.user,
    })
    if (isCancel(user)) return

    const pw = await password({ message: 'Password' })
    if (isCancel(pw)) return

    const ssl = await confirm({
        message: 'Use TLS/SSL?',
        initialValue: initialValues?.ssl ?? false,
    })
    if (isCancel(ssl)) return

    const group = await selectGroup(initialValues?.group)
    if (group === null) return

    const config: DbConfig = {
        id: initialValues?.id || randomUUID(),
        name,
        type: DbType.MongoDB,
        host: host as string,
        port: Number(port),
        database: database as string,
        user: (user as string) || '',
        password: (pw as string) || initialValues?.password || '',
        ssl: ssl as boolean,
        verbose: false,
        group: group || undefined,
    }

    await testAndSaveConfig(config, () => addMongoConnectionFromFields(name, config))
}

async function testAndSaveConfig(config: DbConfig, retryFn: () => Promise<void>): Promise<void> {
    const s = spinner()
    s.start('Testing connection...')
    const adapter = AdapterFactory.createAdapter(config)

    if (await adapter.testConnection()) {
        s.stop('Connection verified!')
        await configManager.addConfig(config)
        logSuccess('Connection added successfully!')
    } else {
        s.error('Connection failed.')
        const retry = await confirm({
            message: 'Would you like to edit the connection details?',
            initialValue: true,
        })

        if (isCancel(retry)) return

        if (retry) {
            return retryFn()
        }

        const save = await confirm({
            message: 'Save connection anyway?',
            initialValue: false,
        })

        if (isCancel(save)) return

        if (save) {
            await configManager.addConfig(config)
            logSuccess('Connection added (unverified).')
        }
    }
}

async function editConnection(): Promise<void> {
    const configs = ensureConnectionsExist()

    const id = await select({
        message: 'Select connection to edit',
        options: configs.map((c: DbConfig) => ({ label: formatConnectionLabel(c), value: c.id })),
    })

    if (isCancel(id)) {
        logWarn('Operation cancelled.')
        return
    }

    const existingConfig = configManager.getConfig(id as string)
    if (!existingConfig) {
        logError('Connection not found.')
        return
    }

    await configManager.removeConfig(id as string)
    await addConnection(existingConfig)

    if (!configManager.getConfig(existingConfig.id)) {
        await configManager.addConfig(existingConfig)
    }
}

async function updatePassword(): Promise<void> {
    const configs = ensureConnectionsExist()

    const id = await select({
        message: 'Select connection to update password',
        options: configs.map((c: DbConfig) => ({
            label: formatConnectionLabel(c),
            value: c.id,
        })),
    })

    if (isCancel(id)) return

    const config = configManager.getConfig(id as string)
    if (!config) {
        logError('Connection not found.')
        return
    }

    const pw = await password({
        message: `New password for '${config.name}'`,
    })

    if (isCancel(pw)) return

    config.password = (pw as string) || ''
    await configManager.updateConfig(config)
    logSuccess(`Password updated for '${config.name}'.`)
}

async function removeConnection(): Promise<void> {
    const configs = ensureConnectionsExist()

    const id = await select({
        message: 'Select connection to remove',
        options: configs.map((c: DbConfig) => ({ label: formatConnectionLabel(c), value: c.id })),
    })

    if (isCancel(id)) {
        logWarn('Operation cancelled.')
        return
    }

    await configManager.removeConfig(id as string)
    logSuccess('Connection removed.')
}

async function selectGroup(currentGroup?: string): Promise<string | null> {
    const configs = configManager.getConfigs()
    const existingGroups = [...new Set(configs.map((c) => c.group).filter(Boolean))] as string[]

    const options = [
        { label: 'No Group', value: '' },
        ...(existingGroups.length > 0 ? existingGroups.map((g) => ({ label: g, value: g })) : []),
        { label: '+ Create New Group', value: '__new__' },
    ]

    const selected = await select({
        message: 'Connection Group',
        options,
        initialValue: currentGroup || '',
    })

    if (isCancel(selected)) return null

    if (selected === '__new__') {
        const groupName = await text({
            message: 'Enter group name (e.g. production, staging, dev)',
            validate: (value) => {
                if (!value || !value.trim()) return 'Group name is required'
                return undefined
            },
        })

        if (isCancel(groupName)) return null
        return (groupName as string).trim()
    }

    return selected as string
}
