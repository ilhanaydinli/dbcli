import { confirm, isCancel, password, select, spinner, text } from '@clack/prompts'
import { randomUUID } from 'crypto'

import { AdapterFactory } from '@/adapters/adapter-factory'
import { detectMongoAuthSource } from '@/adapters/mongodb-adapter'
import { showConnectionActionMenu } from '@/cli/menus/connection-actions'
import { selectWithSearch } from '@/cli/prompts'
import { ConnectionMenuAction } from '@/cli/types'
import { runWizard } from '@/cli/wizard'
import { ConfigManager } from '@/core/config-manager'
import {
    formatConnectionLabel,
    logSuccess,
    parseConnectionUrl,
    parseMongoUrl,
    parseMSSQLUrl,
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
        const configs = configManager.getConfigs()

        const value = await selectWithSearch<string>({
            message: 'Manage Connections',
            pinnedTop: [
                { label: '+ Add Connection', value: ConnectionMenuAction.Add },
                {
                    label: '+ Add from URL',
                    value: ConnectionMenuAction.AddFromUrl,
                    hint: 'postgresql://, mongodb://, mysql://, mssql://',
                },
            ],
            items: configs.map((c) => ({
                label: formatConnectionLabel(c),
                value: c.id,
                hint: c.group,
            })),
            pinnedBottom: [{ label: '← Back', value: ConnectionMenuAction.Back }],
        })

        if (isCancel(value) || value === ConnectionMenuAction.Back) return

        if (value === ConnectionMenuAction.Add) {
            await addConnection()
        } else if (value === ConnectionMenuAction.AddFromUrl) {
            await addConnectionFromUrl()
        } else {
            const config = configManager.getConfig(value as string)
            if (config) await showConnectionActionMenu(config)
        }
    }
}

async function addConnectionFromUrl(): Promise<void> {
    const url = await text({
        message: 'Paste connection URL',
        placeholder:
            'postgresql://..., mongodb://..., mysql://..., or mssql://user:password@host:1433/database',
        validate: (value) => {
            if (!value) return 'URL is required'
            if (
                !parseConnectionUrl(value) &&
                !parseMongoUrl(value) &&
                !parseMySQLUrl(value) &&
                !parseMSSQLUrl(value)
            )
                return 'Invalid connection URL'
            return undefined
        },
    })

    if (isCancel(url)) return

    const urlStr = url as string
    const isMongoUrl = urlStr.startsWith('mongodb://') || urlStr.startsWith('mongodb+srv://')
    const isMySQLUrl = urlStr.startsWith('mysql://')
    const isMariaDBUrl = urlStr.startsWith('mariadb://')
    const isMSSQLUrl = urlStr.startsWith('mssql://') || urlStr.startsWith('sqlserver://')

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
    } else if (isMSSQLUrl) {
        const parsed = parseMSSQLUrl(urlStr)!
        await addConnection({
            type: DbType.MSSQL,
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

export async function addConnection(initialValues?: Partial<DbConfig>): Promise<void> {
    const draft: Partial<DbConfig> = { ...initialValues }

    await runWizard([
        () =>
            askText(draft, 'name', {
                message: 'Connection Name (e.g. Local Postgres)',
                initialValue: draft.name,
                validate: (value) => zodValidate(ConnectionNameSchema, value),
            }),
        async () => {
            const type = await select({
                message: 'Database Type',
                initialValue: draft.type || DbType.Postgres,
                options: [
                    { label: 'PostgreSQL', value: DbType.Postgres },
                    { label: 'MySQL', value: DbType.MySQL },
                    { label: 'MariaDB', value: DbType.MariaDB },
                    { label: 'MongoDB', value: DbType.MongoDB },
                    { label: 'SQL Server (MSSQL)', value: DbType.MSSQL },
                ],
            })
            if (isCancel(type)) return false
            draft.type = type as DbType
            return true
        },
        () => addConnectionOfType(draft),
    ])
}

async function addConnectionOfType(draft: Partial<DbConfig>): Promise<boolean> {
    const name = draft.name as string

    if (draft.type === DbType.MongoDB) return addMongoConnection(name, draft)
    if (draft.type === DbType.MySQL || draft.type === DbType.MariaDB) {
        return addMySQLConnection(name, draft.type, draft)
    }
    if (draft.type === DbType.MSSQL) return addMSSQLConnection(name, draft)
    return addPostgresConnection(name, draft)
}

type TextField = 'name' | 'host' | 'database' | 'user' | 'authSource' | 'uri'

async function askText(
    draft: Partial<DbConfig>,
    field: TextField,
    options: Parameters<typeof text>[0],
): Promise<boolean> {
    const value = await text(options)
    if (isCancel(value)) return false
    draft[field] = value as string
    return true
}

async function askPort(draft: Partial<DbConfig>, initialValue: string): Promise<boolean> {
    const value = await text({
        message: 'Port',
        initialValue,
        validate: (value) => zodValidate(PortSchema, value),
    })
    if (isCancel(value)) return false
    draft.port = Number(value)
    return true
}

async function askPassword(draft: Partial<DbConfig>): Promise<boolean> {
    const value = await password({ message: 'Password' })
    if (isCancel(value)) return false
    draft.password = (value as string) || draft.password || ''
    return true
}

async function askSsl(draft: Partial<DbConfig>, message: string): Promise<boolean> {
    const value = await confirm({ message, initialValue: draft.ssl ?? false })
    if (isCancel(value)) return false
    draft.ssl = value as boolean
    return true
}

async function askGroup(draft: Partial<DbConfig>): Promise<boolean> {
    const group = await selectGroup(draft.group)
    if (group === null) return false
    draft.group = group || undefined
    return true
}

async function addPostgresConnection(
    name: string,
    initialValues?: Partial<DbConfig>,
): Promise<boolean> {
    const draft: Partial<DbConfig> = { ...initialValues }

    const completed = await runWizard([
        () =>
            askText(draft, 'host', {
                message: 'Host',
                initialValue: draft.host || 'localhost',
                validate: (value) => zodValidate(HostSchema, value),
            }),
        () => askPort(draft, String(draft.port || 5432)),
        () =>
            askText(draft, 'database', {
                message: 'Maintenance Database',
                initialValue: draft.database || 'postgres',
                validate: (value) => zodValidate(DatabaseSchema, value),
            }),
        () =>
            askText(draft, 'user', {
                message: 'Username',
                initialValue: draft.user,
                validate: (value) => zodValidate(UsernameSchema, value),
            }),
        () => askPassword(draft),
        () => askSsl(draft, 'Use SSL?'),
        () => askGroup(draft),
    ])

    if (!completed) return false

    const config: DbConfig = {
        id: draft.id || randomUUID(),
        name,
        type: DbType.Postgres,
        host: draft.host as string,
        port: Number(draft.port),
        database: draft.database as string,
        user: draft.user as string,
        password: draft.password || '',
        ssl: draft.ssl ?? false,
        verbose: false,
        group: draft.group || undefined,
    }

    await testAndSaveConfig(config, () => addPostgresConnection(name, config))
    return true
}

async function addMySQLConnection(
    name: string,
    type: DbType.MySQL | DbType.MariaDB,
    initialValues?: Partial<DbConfig>,
): Promise<boolean> {
    const draft: Partial<DbConfig> = { ...initialValues }

    const completed = await runWizard([
        () =>
            askText(draft, 'host', {
                message: 'Host',
                initialValue: draft.host || 'localhost',
                validate: (value) => zodValidate(HostSchema, value),
            }),
        () => askPort(draft, String(draft.port || 3306)),
        () =>
            askText(draft, 'database', {
                message: 'Maintenance Database',
                initialValue: draft.database || 'mysql',
                validate: (value) => zodValidate(DatabaseSchema, value),
            }),
        () =>
            askText(draft, 'user', {
                message: 'Username',
                initialValue: draft.user || 'root',
                validate: (value) => zodValidate(UsernameSchema, value),
            }),
        () => askPassword(draft),
        () => askSsl(draft, 'Use SSL?'),
        () => askGroup(draft),
    ])

    if (!completed) return false

    const config: DbConfig = {
        id: draft.id || randomUUID(),
        name,
        type,
        host: draft.host as string,
        port: Number(draft.port),
        database: draft.database as string,
        user: draft.user as string,
        password: draft.password || '',
        ssl: draft.ssl ?? false,
        verbose: false,
        group: draft.group || undefined,
    }

    await testAndSaveConfig(config, () => addMySQLConnection(name, type, config))
    return true
}

async function addMSSQLConnection(
    name: string,
    initialValues?: Partial<DbConfig>,
): Promise<boolean> {
    const draft: Partial<DbConfig> = { ...initialValues }

    const completed = await runWizard([
        () =>
            askText(draft, 'host', {
                message: 'Host',
                initialValue: draft.host || 'localhost',
                validate: (value) => zodValidate(HostSchema, value),
            }),
        () => askPort(draft, String(draft.port || 1433)),
        () =>
            askText(draft, 'database', {
                message: 'Maintenance Database',
                initialValue: draft.database || 'master',
                validate: (value) => zodValidate(DatabaseSchema, value),
            }),
        () =>
            askText(draft, 'user', {
                message: 'Username',
                initialValue: draft.user || 'sa',
                validate: (value) => zodValidate(UsernameSchema, value),
            }),
        () => askPassword(draft),
        () => askSsl(draft, 'Use SSL/Encrypt?'),
        () => askGroup(draft),
    ])

    if (!completed) return false

    const config: DbConfig = {
        id: draft.id || randomUUID(),
        name,
        type: DbType.MSSQL,
        host: draft.host as string,
        port: Number(draft.port),
        database: draft.database as string,
        user: draft.user as string,
        password: draft.password || '',
        ssl: draft.ssl ?? false,
        verbose: false,
        group: draft.group || undefined,
    }

    await testAndSaveConfig(config, () => addMSSQLConnection(name, config))
    return true
}

async function addMongoConnection(
    name: string,
    initialValues?: Partial<DbConfig>,
): Promise<boolean> {
    let useUri = !!initialValues?.uri

    return runWizard([
        async () => {
            const answer = await confirm({
                message: 'Connect using a URI?',
                initialValue: useUri,
            })
            if (isCancel(answer)) return false
            useUri = answer as boolean
            return true
        },
        () =>
            useUri
                ? addMongoConnectionFromUri(name, initialValues)
                : addMongoConnectionFromFields(name, initialValues),
    ])
}

async function addMongoConnectionFromUri(
    name: string,
    initialValues?: Partial<DbConfig>,
): Promise<boolean> {
    const draft: Partial<DbConfig> = { ...initialValues }

    const completed = await runWizard([
        () =>
            askText(draft, 'uri', {
                message: 'MongoDB URI',
                placeholder: 'mongodb://user:password@host:27017/mydb',
                initialValue: draft.uri,
                validate: (value) => zodValidate(MongoUriSchema, value),
            }),
        () =>
            askText(draft, 'database', {
                message: 'Default Database',
                initialValue:
                    draft.database || parseMongoUrl(draft.uri as string)?.database || 'admin',
                validate: (value) => zodValidate(DatabaseSchema, value),
            }),
        () => askGroup(draft),
    ])

    if (!completed) return false

    const parsed = parseMongoUrl(draft.uri as string)

    const config: DbConfig = {
        id: draft.id || randomUUID(),
        name,
        type: DbType.MongoDB,
        host: parsed?.host || 'localhost',
        port: parsed?.port || 27017,
        user: parsed?.user || '',
        password: parsed?.password || draft.password || '',
        database: draft.database as string,
        ssl: parsed?.ssl ?? false,
        verbose: false,
        group: draft.group || undefined,
        uri: draft.uri as string,
        authSource: draft.authSource,
    }

    await testAndSaveConfig(config, () => addMongoConnectionFromUri(name, config))
    return true
}

async function addMongoConnectionFromFields(
    name: string,
    initialValues?: Partial<DbConfig>,
): Promise<boolean> {
    const draft: Partial<DbConfig> = { ...initialValues }

    const completed = await runWizard([
        () =>
            askText(draft, 'host', {
                message: 'Host',
                initialValue: draft.host || 'localhost',
                validate: (value) => zodValidate(HostSchema, value),
            }),
        () => askPort(draft, String(draft.port || 27017)),
        () =>
            askText(draft, 'database', {
                message: 'Default Database',
                initialValue: draft.database || 'admin',
                validate: (value) => zodValidate(DatabaseSchema, value),
            }),
        () =>
            askText(draft, 'user', {
                message: 'Username (leave empty if no auth)',
                initialValue: draft.user,
            }),
        () => askPassword(draft),
        async () => {
            if (!draft.user) {
                draft.authSource = undefined
                return 'skip'
            }
            return askText(draft, 'authSource', {
                message: 'Auth Source (leave empty to detect automatically)',
                placeholder: 'admin',
                initialValue: draft.authSource,
            })
        },
        () => askSsl(draft, 'Use TLS/SSL?'),
        () => askGroup(draft),
    ])

    if (!completed) return false

    const config: DbConfig = {
        id: draft.id || randomUUID(),
        name,
        type: DbType.MongoDB,
        host: draft.host as string,
        port: Number(draft.port),
        database: draft.database as string,
        user: draft.user || '',
        password: draft.password || '',
        ssl: draft.ssl ?? false,
        verbose: false,
        group: draft.group || undefined,
        authSource: draft.authSource || undefined,
    }

    await testAndSaveConfig(config, () => addMongoConnectionFromFields(name, config))
    return true
}

async function withDetectedAuthSource(
    config: DbConfig,
    s: ReturnType<typeof spinner>,
): Promise<DbConfig> {
    if (config.type !== DbType.MongoDB) return config

    s.message('Detecting authentication database...')
    const authSource = await detectMongoAuthSource(config)
    return authSource ? { ...config, authSource } : config
}

async function testAndSaveConfig(config: DbConfig, retryFn: () => Promise<unknown>): Promise<void> {
    const s = spinner()
    s.start('Testing connection...')

    const resolved = await withDetectedAuthSource(config, s)
    s.message('Testing connection...')

    const adapter = AdapterFactory.createAdapter(resolved)

    if (await adapter.testConnection()) {
        s.stop(
            resolved.authSource
                ? `Connection verified (auth source: '${resolved.authSource}')!`
                : 'Connection verified!',
        )
        await configManager.addConfig(resolved)
        logSuccess('Connection added successfully!')
    } else {
        s.error('Connection failed.')
        const retry = await confirm({
            message: 'Would you like to edit the connection details?',
            initialValue: true,
        })

        if (isCancel(retry)) return

        if (retry) {
            await retryFn()
            return
        }

        const save = await confirm({
            message: 'Save connection anyway?',
            initialValue: false,
        })

        if (isCancel(save)) return

        if (save) {
            await configManager.addConfig(resolved)
            logSuccess('Connection added (unverified).')
        }
    }
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
