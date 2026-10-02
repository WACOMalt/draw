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

1. Copy the project to the server, then run `npm ci && npm run build`.
2. Run `pm2 start ecosystem.config.cjs`, then `pm2 save`.
3. Install `deploy/draw.bsums.xyz.conf` in nginx, then run `nginx -t && systemctl reload nginx`.
4. Add TLS with `certbot --nginx -d draw.bsums.xyz`, or reuse the certificate of the other subdomains.

## Layout

```
src/shared/   types, protocol, brush dab walker, validation (client + server)
src/server/   HTTP + WebSocket server, sessions, SQLite store
src/client/   Svelte UI (ui/), engine (engine/): compositor, tile worker, sync
deploy/       nginx server block
```
