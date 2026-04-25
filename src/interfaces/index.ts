import { z } from 'zod'

export enum DbType {
    Postgres = 'postgres',
    MongoDB = 'mongodb',
}

const DbTypeSchema = z.nativeEnum(DbType)

export const DbConfigSchema = z.object({
    id: z.string(),
    name: z.string(),
    type: DbTypeSchema,
    host: z.string(),
    port: z.number(),
    user: z.string(),
    password: z.string().default(''),
    database: z.string(),
    ssl: z.boolean().default(false),
    verbose: z.boolean().default(false),
    group: z.string().optional(),
    uri: z.string().optional(),
})

export type DbConfig = z.infer<typeof DbConfigSchema>

export interface ImportOptions {
    reset?: boolean
}

export interface DatabaseInfo {
    name: string
    size: string
}

export interface DatabaseAdapter {
    testConnection(): Promise<boolean>
    listDatabases(): Promise<DatabaseInfo[]>
    getLocales(): Promise<{ locales: string[]; default: string }>
    createDatabase(dbName: string, options?: { locale?: string }): Promise<void>
    dropDatabase(dbName: string): Promise<void>
    renameDatabase(oldName: string, newName: string): Promise<void>
    cloneDatabase(sourceName: string, targetName: string): Promise<void>
    export(outputFile: string): Promise<void>
    import(inputFile: string, options?: ImportOptions): Promise<void>
    checkDependencies(): void
}
