import { MongoDbAdapter } from '@/adapters/mongodb-adapter'
import { MySQLAdapter } from '@/adapters/mysql-adapter'
import { PostgresAdapter } from '@/adapters/postgres-adapter'
import type { DatabaseAdapter, DbConfig } from '@/interfaces'
import { DbType } from '@/interfaces'

const adapterMap: Record<DbType, (config: DbConfig) => DatabaseAdapter> = {
    [DbType.Postgres]: (config) => new PostgresAdapter(config),
    [DbType.MongoDB]: (config) => new MongoDbAdapter(config),
    [DbType.MySQL]: (config) => new MySQLAdapter(config),
    [DbType.MariaDB]: (config) => new MySQLAdapter(config),
}

export class AdapterFactory {
    static createAdapter(config: DbConfig): DatabaseAdapter {
        const factory = adapterMap[config.type]
        if (!factory) {
            throw new Error(`Unsupported database type: ${config.type}`)
        }

        const adapter = factory(config)
        adapter.checkDependencies()
        return adapter
    }
}
