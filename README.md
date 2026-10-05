# Draw

An infinite, multiplayer drawing canvas. People join a session with a share code. See [SPEC.md](SPEC.md) for the design.

## Develop

```bash
npm install
npm run dev
```

Open http://localhost:5173. The dev script starts the API and WebSocket server on port 3210 (`tsx watch`) and the Vite dev server, which proxies `/api` and `/ws` to it.

`npm run check` runs the type checks for the client and the server. `npm run test:server` runs the server integration test (accounts, sharing, expiry).

In the browser console, `__draw.ed` is the editor state and `__draw.engine` is the engine. Add `?renderer=2d` to a canvas URL to use the Canvas 2D renderer in place of WebGL2.

## Build and run

```bash
npm run build
npm start
```

`npm run build` writes `dist/client` (static files) and `dist/server/index.js`. The server serves both the app and the API.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3210` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address. Keep it local behind nginx. |
| `DB_PATH` | `./data/canvas.db` | SQLite file. Back up this file. |
| `STATIC_DIR` | `dist/client` | Built client files |

## Release

Push to `main`. GitHub Actions (`.github/workflows/release.yml`) checks the code and builds on GitHub's runners:

- the web/server bundle (`draw-web.tar.gz`)
- desktop installers: Linux (`.rpm`, `.deb`, AppImage), Windows (`.exe`, `.msi`), macOS (universal `.dmg`)

Then it publishes all of them as a GitHub Release, `vMAJOR.MINOR.RUN`. MAJOR.MINOR come from `package.json`. Change them with `node scripts/set-version.mjs 0.3.0` and commit. The patch number is the workflow run number, so every push has a new version.

Update the server (on the SSH host):

```bash
bash /opt/draw/update-server.sh
```

Give a tag to install a specific release, or to roll back: `bash /opt/draw/update-server.sh v0.2.7`. The script never touches the database.

## Server setup (one time)

The server runs Draw as a hardened systemd service with an encrypted SMTP credential. Run this on the server as your normal user. It asks for sudo once and for the SMTP details:

```bash
curl -fsSL https://raw.githubusercontent.com/WACOMalt/draw/main/deploy/setup-systemd.sh -o setup-systemd.sh && less setup-systemd.sh && bash setup-systemd.sh
```

It moves the database from `~/draw/data` to `/var/lib/draw`, installs the app in `/opt/draw`, and prints the rollback command. For local development, mail goes to the console (set `DEV_MAIL_DIR` to also write each email to a folder).

The version shows in the status bar, on the home page, and in `/api/health`.

## Deploy from this PC (fallback)

`npm run deploy` builds locally, copies `dist/` and the package files to `~/draw` on `potato-vps1.bsums.xyz`, installs the runtime dependencies there, and reloads the pm2 app `draw`. The database in `~/draw/data` stays in place.

The nginx site is `deploy/draw.bsums.xyz.conf`. It uses the `*.bsums.xyz` wildcard certificate. Install it one time:

1. Copy it to `/etc/nginx/sites-available/draw.bsums.xyz`.
2. Link it into `/etc/nginx/sites-enabled/`.
3. Run `sudo nginx -t`, then `sudo systemctl reload nginx`.

## Desktop apps

Linux: Electron (`electron/`). The window shows `https://draw.bsums.xyz` in Chromium, which has pen pressure and fast WebGL. WebKitGTK, the Tauri engine on Linux, has neither.

```bash
npm run linux:dev                                   # the app on the live site
DRAW_URL=http://localhost:5173 npm run linux:dev    # on the local dev server
npm run linux:build                                 # AppImage, .deb, .rpm in dist/electron/
```

Settings: `DRAW_OZONE=x11` forces X11 (default: native Wayland on a Wayland desktop), `DRAW_GPU_INFO=1` prints the WebGL renderer.

Android: Tauri (`src-tauri/gen/android/`), in the Android System WebView. Needs JDK 17 or 21, the Android SDK and NDK, and the Rust Android targets:

```bash
export ANDROID_HOME=~/Android/Sdk NDK_HOME=~/Android/Sdk/ndk/<version> JAVA_HOME=<jdk 21>
npx tauri android build --apk     # unsigned without src-tauri/gen/android/keystore.properties
```

CI signs the release APK with the keystore in the GitHub secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`. Keep a backup of that keystore: Android installs an update only with the same key.

Windows and macOS: Tauri (`src-tauri/`). Needs Rust and the Tauri system packages.

```bash
npm run desktop:dev     # native window on the local dev server
npm run desktop:build   # installers in src-tauri/target/release/bundle/
```

The release app connects to `https://draw.bsums.xyz` (set in `.env.tauri`).

## Layout

```
src/shared/   types, protocol, brush dab walker, validation (client + server)
src/server/   HTTP + WebSocket server, sessions, SQLite store
src/client/   Svelte UI (ui/), engine (engine/): compositor, tile worker, sync
src-tauri/    desktop app for Windows and macOS (Tauri v2)
electron/     desktop app for Linux (Electron)
deploy/       nginx server block
```
