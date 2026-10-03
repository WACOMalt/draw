#!/usr/bin/env bash
# Updates the Draw server to the latest GitHub release, or to a given tag.
#
#   First time, or any time:
#     curl -fsSL https://raw.githubusercontent.com/WACOMalt/draw/main/scripts/update-server.sh | bash
#   After the first run (the release copies this script into ~/draw):
#     bash ~/draw/update-server.sh            # latest release
#     bash ~/draw/update-server.sh v0.2.7     # a specific release (also a rollback)
#
# Never touches ~/draw/data (the database). Settings: DRAW_DIR, DRAW_REPO, DRAW_URL, PORT.
set -euo pipefail

REPO="${DRAW_REPO:-WACOMalt/draw}"
DIR="${DRAW_DIR:-$HOME/draw}"
TAG="${1:-latest}"
if [ -n "${DRAW_URL:-}" ]; then
  URL="$DRAW_URL" # a bundle from elsewhere (testing, mirrors)
elif [ "$TAG" = latest ]; then
  URL="https://github.com/$REPO/releases/latest/download/draw-web.tar.gz"
else
  URL="https://github.com/$REPO/releases/download/$TAG/draw-web.tar.gz"
fi

# Use the same Node as pm2 (nvm), also in non-interactive shells.
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null
for cmd in curl tar node npm pm2; do
  command -v "$cmd" >/dev/null || { echo "error: $cmd not found" >&2; exit 1; }
done

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading $URL"
curl -fL --retry 3 --progress-bar -o "$TMP/web.tgz" "$URL"
tar -xzf "$TMP/web.tgz" -C "$TMP"
NEW="$(node -p "require('$TMP/draw/package.json').version")"
OLD="$( [ -f "$DIR/package.json" ] && node -p "require('$DIR/package.json').version" || echo none )"
echo "Installed: $OLD   Release: $NEW"

mkdir -p "$DIR/data"
cp "$TMP/draw/package.json" "$TMP/draw/package-lock.json" "$TMP/draw/ecosystem.config.cjs" "$TMP/draw/update-server.sh" "$DIR/"
cd "$DIR"
# npm runs install scripts with every parent node_modules/.bin first on PATH, which can pick up
# a different Node than pm2 uses. Pin native prebuilds (better-sqlite3) to this Node.
npm_config_target="$(node -p process.versions.node)" npm ci --omit=dev --no-audit --no-fund

# Swap the build only after the install worked.
rm -rf dist.old
[ -d dist ] && mv dist dist.old
mv "$TMP/draw/dist" dist
rm -rf dist.old

pm2 startOrReload ecosystem.config.cjs
pm2 save >/dev/null
sleep 2
echo "Health: $(curl -fsS "http://127.0.0.1:${PORT:-3210}/api/health")"
