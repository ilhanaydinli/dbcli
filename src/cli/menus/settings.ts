import { confirm, isCancel, password, select, text } from '@clack/prompts'
import { readdir, stat } from 'fs/promises'
import { join } from 'path'

import { SettingsMenuAction } from '@/cli/types'
import { ConfigManager } from '@/core/config-manager'
import { EncryptedFileError } from '@/helpers/crypto'
import { logError, logSuccess, logWarn } from '@/helpers/utils'
import type { DbConfig } from '@/interfaces'
import { PasswordRequiredSchema, RequiredStringSchema, zodValidate } from '@/validations'

const configManager = ConfigManager.getInstance()

export async function showSettingsMenu(): Promise<void> {
    while (true) {
        const action = await select({
            message: 'Settings',
            options: [
                { label: 'Toggle Verbose Mode', value: SettingsMenuAction.ToggleVerbose },
                { label: 'Export Connections', value: SettingsMenuAction.ExportConfig },
                { label: 'Import Connections', value: SettingsMenuAction.ImportConfig },
                { label: '← Back', value: SettingsMenuAction.Back },
            ],
        })

        if (isCancel(action) || action === SettingsMenuAction.Back) return

        const handler = menuActions[action as SettingsMenuAction]
        if (handler) {
            await handler()
        }
    }
}

const menuActions: Partial<Record<SettingsMenuAction, () => Promise<void>>> = {
    [SettingsMenuAction.ToggleVerbose]: handleToggleVerbose,
    [SettingsMenuAction.ExportConfig]: handleExportConfig,
    [SettingsMenuAction.ImportConfig]: handleImportConfig,
}

async function handleToggleVerbose(): Promise<void> {
    const configs = configManager.getConfigs()
    const currentVerbose = configs.length > 0 ? configs.some((c: DbConfig) => c.verbose) : false

    const verbose = await confirm({
        message: 'Show detailed command output (Verbose Mode)?',
        initialValue: currentVerbose,
    })

    if (isCancel(verbose)) return

    if (configs.length === 0) {
        logWarn('No connections exist yet. Setting will apply to new connections.')
    } else {
        for (const c of configs) {
            c.verbose = verbose as boolean
            await configManager.updateConfig(c)
        }
    }
    logSuccess(`Verbose mode set to ${verbose ? 'ON' : 'OFF'}.`)
}

async function handleExportConfig(): Promise<void> {
    const configs = configManager.getConfigs()
    if (configs.length === 0) {
        logWarn('No connections to export.')
        return
    }

    const filename = await text({
        message: 'Export filename',
        placeholder: 'db-cli-connections.json',
        initialValue: `db-cli-connections-${new Date().toISOString().slice(0, 10)}.json`,
        validate: (value) => zodValidate(RequiredStringSchema, value),
    })
    if (isCancel(filename)) return

    const encryptSettings = await getEncryptionSettings()
    if (!encryptSettings) return

    const finalPath = encryptSettings.encrypt
        ? ensureEncExtension(filename as string)
        : (filename as string)

    configManager.exportToFile(finalPath, encryptSettings.password, encryptSettings.includePlain)

    logExportSuccess(configs.length, finalPath, encryptSettings)
}

async function handleImportConfig(): Promise<void> {
    const cwd = process.cwd()
    const allFiles = (await readdir(cwd)).filter((f) => f.endsWith('.json') || f.endsWith('.enc'))

    if (allFiles.length === 0) {
        logWarn('No config files (.json or .enc) found in current directory.')
        return
    }

    const filesWithStats = await Promise.all(
        allFiles.map(async (f) => {
            const s = await stat(join(cwd, f))
            return { name: f, mtimeMs: s.mtimeMs }
        }),
    )

    const files = filesWithStats.sort((a, b) => b.mtimeMs - a.mtimeMs).map((f) => f.name)

    const filePath = await select({
        message: 'Select config file to import',
        options: files.map((f) => ({ label: f, value: f })),
    })
    if (isCancel(filePath)) return

    try {
        const imported = await configManager.importFromFile(filePath as string)
        logImportSuccess(imported)
    } catch (error) {
        if (isEncryptedError(error)) {
            await handleEncryptedImport(filePath as string)
        } else {
            logError(`Import failed: ${(error as Error).message}`)
        }
    }
}

async function getEncryptionSettings() {
    const encrypt = await confirm({
        message: 'Encrypt this export with a password?',
        initialValue: true,
    })
    if (isCancel(encrypt)) return null

    if (encrypt) {
        const pass = await password({
            message: 'Enter encryption password',
            validate: (value) => zodValidate(PasswordRequiredSchema, value),
        })
        if (isCancel(pass)) return null
        return { encrypt: true, password: pass as string, includePlain: false }
    }

    const includePlain = await confirm({
        message: 'Include database passwords in plain text? (NOT RECOMMENDED)',
        initialValue: false,
    })
    if (isCancel(includePlain)) return null
    return { encrypt: false, password: undefined, includePlain: includePlain as boolean }
}

function ensureEncExtension(path: string): string {
    return path.endsWith('.enc') ? path : `${path}.enc`
}

function logExportSuccess(count: number, path: string, settings: any) {
    if (settings.encrypt) {
        logSuccess(`Exported ${count} connection(s) (ENCRYPTED) to ${path}`)
    } else {
        const label = settings.includePlain ? 'UNSAFE' : 'SAFE'
        logSuccess(`Exported ${count} connection(s) (${label}) to ${path}`)
    }
}

function logImportSuccess(imported: number) {
    if (imported > 0) {
        logSuccess(`Imported ${imported} new connection(s).`)
        logWarn('Remember to update passwords for imported connections.')
    } else {
        logWarn('No new connections to import (all already exist).')
    }
}

function isEncryptedError(error: unknown): boolean {
    return error instanceof EncryptedFileError || (error as Error).name === 'EncryptedFileError'
}

async function handleEncryptedImport(filePath: string) {
    const pass = await password({
        message: 'File is encrypted. Enter password:',
        validate: (value) => zodValidate(PasswordRequiredSchema, value),
    })
    if (isCancel(pass)) return

    try {
        const imported = await configManager.importFromFile(filePath, pass as string)
        logSuccess(`Imported ${imported} new connection(s) (Decrypted).`)
    } catch {
        logError('Import failed: Invalid password or corrupted file')
    }
}
