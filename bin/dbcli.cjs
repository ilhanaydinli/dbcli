#!/usr/bin/env node
const path = require('path')

const indexPath = path.join(__dirname, '..', 'dist', 'index.js')

if (process.versions.bun) {
    import(indexPath).catch((err) => {
        console.error(err)
        process.exit(1)
    })
} else {
    const { spawnSync } = require('child_process')

    if (spawnSync('bun', ['--version'], { stdio: 'ignore' }).error) {
        console.error('\n  ⚠ dbcli requires the Bun runtime.')
        console.error('  Install Bun: https://bun.sh\n')
        process.exit(1)
    }

    const result = spawnSync('bun', [indexPath, ...process.argv.slice(2)], {
        stdio: 'inherit',
    })
    process.exit(result.status ?? 1)
}
