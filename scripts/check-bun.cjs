#!/usr/bin/env node
const { spawnSync } = require('child_process')

if (spawnSync('bun', ['--version'], { stdio: 'ignore' }).error) {
    console.error('\n  ⚠ dbcli requires the Bun runtime.')
    console.error('  Install Bun: https://bun.sh\n')
    process.exit(1)
}
