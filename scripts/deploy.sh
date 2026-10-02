#!/usr/bin/env bash
# Build locally, copy the build to the server, install runtime deps there, (re)start pm2.
# Usage: scripts/deploy.sh [user@host] [remote dir]
set -euo pipefail

# The server runs Node 20. better-sqlite3 is pinned to 12.9.0, the newest release with a
# prebuilt Node 20 binary. Newer releases compile from source there (slow, ~10+ min).
# npm_config_target pins the prebuilt download to the Node that runs the app: install scripts
# put every parent node_modules/.bin first on PATH, and ~/node_modules/.bin/node on the server
# is a different Node version.

HOST="${1:-bsumsxyz@potato-vps1.bsums.xyz}"
DIR="${2:-draw}"
# Non-interactive SSH does not read .bashrc. Load nvm so npm, pm2 and the native module build
# all use the same Node as the running pm2 daemon.
NVM='export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh" >/dev/null'

cd "$(dirname "$0")/.."
npm run build

ssh "$HOST" "mkdir -p '$DIR/data'"
# dist/ is replaced; data/ (the SQLite database) is never touched.
rsync -az --delete dist/ "$HOST:$DIR/dist/"
rsync -az package.json package-lock.json ecosystem.config.cjs "$HOST:$DIR/"
ssh "$HOST" "$NVM && node -v && cd '$DIR' && npm_config_target=\$(node -p process.versions.node) npm ci --omit=dev --no-audit --no-fund && pm2 startOrReload ecosystem.config.cjs && pm2 save"
ssh "$HOST" "sleep 2; curl -fsS http://127.0.0.1:3210/api/health && echo"
