import { existsSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { z } from 'zod'

import { decrypt, encrypt, EncryptedFileError } from '@/helpers/crypto'
import { KeychainHelper } from '@/helpers/keychain'
import { logError } from '@/helpers/utils'
import type { DbConfig } from '@/interfaces'
import { DbConfigSchema } from '@/interfaces'

const ConfigFileSchema = z.array(DbConfigSchema)

export class ConfigManager {
    private static instance: ConfigManager
    private configPath: string
    private configs: DbConfig[] = []

    private constructor() {
        this.configPath = join(homedir(), '.db-cli-config.json')
        this.loadConfigRaw()
    }

    public static getInstance(): ConfigManager {
        if (!ConfigManager.instance) {
            ConfigManager.instance = new ConfigManager()
        }
        return ConfigManager.instance
    }

    public async init(): Promise<void> {
        await this.loadPasswordsFromKeychain()
    }

    private loadConfigRaw(): void {
        if (!existsSync(this.configPath)) {
            return
        }

        try {
            const fileContent = readFileSync(this.configPath, 'utf-8')
            const parsed = JSON.parse(fileContent)
            this.configs = ConfigFileSchema.parse(parsed)
        } catch (error) {
            logError(`Error loading config: ${error}`)
            this.configs = []
        }
    }

    private async loadPasswordsFromKeychain(): Promise<void> {
        for (const config of this.configs) {
            const password = await KeychainHelper.getPassword(config.id)
            if (password) {
                config.password = password
            }
        }
    }

    private saveConfigRaw(): void {
        try {
            const configsWithoutPasswords = this.configs.map((c) => ({
                ...c,
                password: '',
            }))

            writeFileSync(this.configPath, JSON.stringify(configsWithoutPasswords, null, 2), {
                mode: 0o600,
            })
        } catch (error) {
            logError(`Error saving config: ${error}`)
        }
    }

    public getConfigs(): DbConfig[] {
        return this.configs
    }

    public getConfig(id: string): DbConfig | undefined {
        return this.configs.find((c) => c.id === id)
    }

    public async addConfig(config: DbConfig): Promise<void> {
        try {
            DbConfigSchema.parse(config)

            if (config.password) {
                await KeychainHelper.setPassword(config.id, config.password)
            }

            this.configs.push(config)
            this.saveConfigRaw()
        } catch (e) {
            logError(`Invalid configuration, not saving: ${e}`)
            throw e
        }
    }

    public async removeConfig(id: string): Promise<void> {
        this.configs = this.configs.filter((c) => c.id !== id)
        this.saveConfigRaw()
        await KeychainHelper.deletePassword(id)
    }

    public async updateConfig(config: DbConfig): Promise<void> {
        const index = this.configs.findIndex((c) => c.id === config.id)
        if (index !== -1) {
            if (config.password) {
                await KeychainHelper.setPassword(config.id, config.password)
            }

            this.configs[index] = config
            this.saveConfigRaw()
        }
    }

    public exportToFile(
        filePath: string,
        encryptionPassword?: string,
        includePlainPasswords = false,
    ): void {
        let configsToExport = this.configs

        if (!encryptionPassword && !includePlainPasswords) {
            configsToExport = this.configs.map((c) => ({
                ...c,
                password: '',
            }))
        }

        const exportData = {
            version: 1,
            exportedAt: new Date().toISOString(),
            connections: configsToExport,
        }

        const jsonContent = JSON.stringify(exportData, null, 2)
        const finalContent = encryptionPassword
            ? encrypt(jsonContent, encryptionPassword)
            : jsonContent

        writeFileSync(filePath, finalContent, { mode: 0o600 })
    }

    public async importFromFile(filePath: string, decryptionPassword?: string): Promise<number> {
        const fileContent = readFileSync(filePath, 'utf-8')
        let parsed: any

        try {
            parsed = JSON.parse(fileContent)
        } catch (e) {
            if (decryptionPassword) {
                try {
                    const decrypted = decrypt(fileContent, decryptionPassword)
                    parsed = JSON.parse(decrypted)
                } catch {
                    throw new Error('Invalid password or corrupted file')
                }
            } else {
                if (fileContent.startsWith('ENC:')) {
                    throw new EncryptedFileError()
                }
                throw e
            }
        }

        const connections = parsed.connections || parsed
        const validated = ConfigFileSchema.parse(connections)

        let imported = 0
        for (const config of validated) {
            const existing = this.configs.find((c) => c.id === config.id)
            if (!existing) {
                if (config.password) {
                    await KeychainHelper.setPassword(config.id, config.password)
                }
                this.configs.push(config)
                imported++
            }
        }

        if (imported > 0) {
            this.saveConfigRaw()
        }

        return imported
    }
}
