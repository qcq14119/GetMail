#!/bin/sh
set -eu

cd -- "$(dirname -- "$0")"

if node -e "process.exit(process.versions.node.split('.')[0] === '26' ? 0 : 1)" >/dev/null 2>&1; then
    if [ ! -f node_modules/express/package.json ]; then
        npm ci --omit=dev
    fi
    exec node index.js
fi

if ! command -v npm >/dev/null 2>&1; then
    printf '%s\n' 'Install Node.js 26 with npm and add it to PATH.' >&2
    exit 1
fi

printf '%s\n' 'Node.js 26 is not on PATH. Starting with Node.js 26 via npm...'
if [ ! -f node_modules/express/package.json ]; then
    npm exec --yes --package=node@26 --call 'npm ci --omit=dev'
fi
exec npm exec --yes --package=node@26 -- node index.js
