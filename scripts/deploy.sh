#!/usr/bin/env bash
# Build locally, copy the build to the server, install runtime deps there, (re)start pm2.
# Usage: scripts/deploy.sh [user@host] [remote dir]
set -euo pipefail

HOST="${1:-bsumsxyz@potato-vps1.bsums.xyz}"
DIR="${2:-draw}"

cd "$(dirname "$0")/.."
npm run build

ssh "$HOST" "mkdir -p '$DIR/data'"
# dist/ is replaced; data/ (the SQLite database) is never touched.
rsync -az --delete dist/ "$HOST:$DIR/dist/"
rsync -az package.json package-lock.json ecosystem.config.cjs "$HOST:$DIR/"
ssh "$HOST" "cd '$DIR' && npm ci --omit=dev --no-audit --no-fund && pm2 startOrReload ecosystem.config.cjs && pm2 save"
ssh "$HOST" "sleep 1; curl -fsS http://127.0.0.1:3210/api/health && echo"
