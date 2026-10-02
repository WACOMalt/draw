# Draw

An infinite, multiplayer drawing canvas. People join a session with a share code. See [SPEC.md](SPEC.md) for the design.

## Develop

```bash
npm install
npm run dev
```

Open http://localhost:5173. The dev script starts the API and WebSocket server on port 3210 (`tsx watch`) and the Vite dev server, which proxies `/api` and `/ws` to it.

`npm run check` runs the type checks for the client and the server.

In the browser console, `__draw.ed` is the editor state and `__draw.engine` is the engine.

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

## Deploy (draw.bsums.xyz)

`npm run deploy` builds locally, copies `dist/` and the package files to `~/draw` on `potato-vps1.bsums.xyz`, installs the runtime dependencies there, and reloads the pm2 app `draw`. The database in `~/draw/data` stays in place.

The nginx site is `deploy/draw.bsums.xyz.conf`. It uses the `*.bsums.xyz` wildcard certificate. Install it one time:

1. Copy it to `/etc/nginx/sites-available/draw.bsums.xyz`.
2. Link it into `/etc/nginx/sites-enabled/`.
3. Run `sudo nginx -t`, then `sudo systemctl reload nginx`.

## Layout

```
src/shared/   types, protocol, brush dab walker, validation (client + server)
src/server/   HTTP + WebSocket server, sessions, SQLite store
src/client/   Svelte UI (ui/), engine (engine/): compositor, tile worker, sync
deploy/       nginx server block
```
