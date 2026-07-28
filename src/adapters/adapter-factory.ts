import { MongoDbAdapter } from '@/adapters/mongodb-adapter'
import { MSSQLAdapter } from '@/adapters/mssql-adapter'
import { MySQLAdapter } from '@/adapters/mysql-adapter'
import { PostgresAdapter } from '@/adapters/postgres-adapter'
import { ConfigManager } from '@/core/config-manager'
import type { AdapterHooks, DatabaseAdapter, DbConfig } from '@/interfaces'
import { DbType } from '@/interfaces'

const adapterMap: Record<DbType, (config: DbConfig, hooks: AdapterHooks) => DatabaseAdapter> = {
    [DbType.Postgres]: (config) => new PostgresAdapter(config),
    [DbType.MongoDB]: (config, hooks) => new MongoDbAdapter(config, hooks),
    [DbType.MySQL]: (config) => new MySQLAdapter(config),
    [DbType.MariaDB]: (config) => new MySQLAdapter(config),
    [DbType.MSSQL]: (config) => new MSSQLAdapter(config),
}

export class AdapterFactory {
    static createAdapter(config: DbConfig): DatabaseAdapter {
        const factory = adapterMap[config.type]
        if (!factory) {
            throw new Error(`Unsupported database type: ${config.type}`)
        }

        const adapter = factory(config, {
            onAuthSourceResolved: (authSource) =>
                ConfigManager.getInstance().setAuthSource(config.id, authSource),
        })
        adapter.checkDependencies()
        return adapter
    }
}
