import { logError } from '@/helpers/utils'

import packageJson from '../../package.json'

const SERVICE_NAME = packageJson.name

export class KeychainHelper {
    static async setPassword(account: string, password: string): Promise<boolean> {
        try {
            if (!Bun.secrets) {
                throw new Error('Bun.secrets API is not available')
            }

            await Bun.secrets.set({
                service: SERVICE_NAME,
                name: account,
                value: password,
            })
            return true
        } catch (error) {
            logError(`Failed to save password to keychain: ${error}`)
            return false
        }
    }

    static async getPassword(account: string): Promise<string | null> {
        try {
            if (!Bun.secrets) return null

            const secret = await Bun.secrets.get({
                service: SERVICE_NAME,
                name: account,
            })

            return secret || null
        } catch (error) {
            logError(`Failed to get password from keychain: ${error}`)
            return null
        }
    }

    static async deletePassword(account: string): Promise<boolean> {
        try {
            if (!Bun.secrets) return false

            const result = await Bun.secrets.delete({
                service: SERVICE_NAME,
                name: account,
            })

            return result
        } catch (error) {
            logError(`Failed to delete password from keychain: ${error}`)
            return false
        }
    }
}
