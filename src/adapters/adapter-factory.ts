import { PostgresAdapter } from '@/adapters/postgres-adapter'
import type { DatabaseAdapter, DbConfig } from '@/interfaces'

export class AdapterFactory {
    static createAdapter(config: DbConfig): DatabaseAdapter {
        let adapter: DatabaseAdapter
        switch (config.type) {
            case 'postgres':
                adapter = new PostgresAdapter(config)
                break
            default:
                throw new Error(`Unsupported database type: ${config.type}`)
        }

        adapter.checkDependencies()
        return adapter
    }
}
