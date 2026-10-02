#!/usr/bin/env bash
# Build locally, copy the build to the server, install runtime deps there, (re)start pm2.
# Usage: scripts/deploy.sh [user@host] [remote dir]
set -euo pipefail

HOST="${1:-bsumsxyz@potato-vps1.bsums.xyz}"
DIR="${2:-draw}"
# Node on the server that builds and runs this app. better-sqlite3 is a native module, so the
# Node that runs `npm ci` and the Node that pm2 uses for this app must be the same.
NODE_BIN="${NODE_BIN:-/usr/local/bin}"
# Non-interactive SSH does not read .bashrc: load nvm for the pm2 CLI, then put NODE_BIN first.
ENV='export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh" >/dev/null; export PATH="'"$NODE_BIN"':$PATH"'

cd "$(dirname "$0")/.."
npm run build

ssh "$HOST" "mkdir -p '$DIR/data'"
# dist/ is replaced; data/ (the SQLite database) is never touched.
rsync -az --delete dist/ "$HOST:$DIR/dist/"
rsync -az package.json package-lock.json ecosystem.config.cjs "$HOST:$DIR/"
ssh "$HOST" "$ENV && node -v && cd '$DIR' && npm ci --omit=dev --no-audit --no-fund && DRAW_NODE='$NODE_BIN/node' pm2 startOrReload ecosystem.config.cjs && pm2 save"
ssh "$HOST" "sleep 2; curl -fsS http://127.0.0.1:3210/api/health && echo"
