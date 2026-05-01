import { confirm, isCancel, password, select, text } from '@clack/prompts'
import { existsSync } from 'fs'
import { dirname, join } from 'path'

import { selectPath } from '@/cli/prompts'
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

    const dirChoice = await selectPath({
        message: 'Select output directory',
        mode: 'directory',
        initialDir: configManager.getPreference('lastConnectionConfigDir') ?? process.cwd(),
    })
    if (isCancel(dirChoice)) return
    const outDir = dirChoice as string
    configManager.setPreference('lastConnectionConfigDir', outDir)

    const filename = await text({
        message: 'Export filename',
        placeholder: 'db-cli-connections.json',
        initialValue: `db-cli-connections-${new Date().toISOString().slice(0, 10)}.json`,
        validate: (value) => zodValidate(RequiredStringSchema, value),
    })
    if (isCancel(filename)) return

    const encryptSettings = await getEncryptionSettings()
    if (!encryptSettings) return

    const fullPath = join(outDir, filename as string)
    const finalPath = encryptSettings.encrypt ? ensureEncExtension(fullPath) : fullPath

    if (existsSync(finalPath)) {
        const overwrite = await confirm({
            message: `File '${finalPath}' already exists. Overwrite?`,
            initialValue: false,
        })

        if (isCancel(overwrite) || !overwrite) {
            logWarn('Export cancelled.')
            return
        }
    }

    configManager.exportToFile(finalPath, encryptSettings.password, encryptSettings.includePlain)

    logExportSuccess(configs.length, finalPath, encryptSettings)
}

async function handleImportConfig(): Promise<void> {
    const fileChoice = await selectPath({
        message: 'Select config file to import',
        mode: 'file',
        initialDir: configManager.getPreference('lastConnectionConfigDir') ?? process.cwd(),
        extensions: ['.json', '.enc'],
    })
    if (isCancel(fileChoice)) return
    const filePath = fileChoice as string
    configManager.setPreference('lastConnectionConfigDir', dirname(filePath))

    try {
        const imported = await configManager.importFromFile(filePath)
        logImportSuccess(imported)
    } catch (error) {
        if (isEncryptedError(error)) {
            await handleEncryptedImport(filePath)
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
