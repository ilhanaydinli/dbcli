#!/usr/bin/env node
import updateNotifier from 'update-notifier'

import { App } from '@/cli/app'
import { logError, logInfo } from '@/helpers/utils'

import pkg from '../package.json'

const notifier = updateNotifier({
    pkg,
    updateCheckInterval: 1000 * 60 * 60 * 24 * 7, // 1 week
})

notifier.notify()

function setupGracefulShutdown(): void {
    const shutdown = (signal: string) => {
        logInfo(`${signal} received. Shutting down gracefully...`)
        process.exit(0)
    }

    process.on('SIGINT', () => shutdown('SIGINT'))
    process.on('SIGTERM', () => shutdown('SIGTERM'))
}

setupGracefulShutdown()

async function main(): Promise<void> {
    const app = new App()
    await app.run()
}

main().catch((error) => {
    logError(`Fatal error: ${(error as Error).message}`)
    process.exit(1)
})
