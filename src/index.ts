#!/usr/bin/env bun
import { note, outro } from '@clack/prompts'

import { App } from '@/cli/app'
import { checkForUpdate, readPendingUpdate } from '@/helpers/update-checker'
import { logError, logInfo } from '@/helpers/utils'

import pkg from '../package.json'

const cachedPending = readPendingUpdate(pkg.version)
const updatePromise = checkForUpdate(pkg.version)

function setupGracefulShutdown(): void {
    const shutdown = (signal: string) => {
        logInfo(`${signal} received. Shutting down gracefully...`)
        process.exit(0)
    }

    process.on('SIGINT', () => shutdown('SIGINT'))
    process.on('SIGTERM', () => shutdown('SIGTERM'))
}

setupGracefulShutdown()

function showUpdateNote(latestVersion: string): void {
    note(
        `${pkg.version}  →  ${latestVersion}\n\nbun install -g @ilhanaydinli/dbcli`,
        '✨ Update available',
    )
}

async function main(): Promise<void> {
    const app = new App()
    await app.run(cachedPending ? () => showUpdateNote(cachedPending) : undefined)
}

main()
    .then(async () => {
        const liveUpdate = await Promise.race([
            updatePromise,
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
        ])
        if (liveUpdate && liveUpdate !== cachedPending) {
            showUpdateNote(liveUpdate)
        }
        outro('Goodbye!')
    })
    .catch((error) => {
        logError(`Fatal error: ${(error as Error).message}`)
        process.exit(1)
    })
