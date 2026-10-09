import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { LIMITS, parseKey, type ClientMsg } from '../shared/types';
import { keyFromPath, oembed, pageWithTags, previewImage } from './linkPreview';
import { makeCaptcha } from './captcha';
import { setAdminEmails } from './access';
import { handleApi, type ApiContext } from './api';
import { readCookie, SESSION_COOKIE, userFromToken } from './auth';
import { cleanup } from './cleanup';
import { Store } from './db';
import { Mailer } from './mailer';
import { Session, newClient } from './session';

const PORT = Number(process.env.PORT ?? 3210);
const HOST = process.env.HOST ?? '127.0.0.1';
const DB_PATH = process.env.DB_PATH ?? './data/canvas.db';
const here = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.resolve(process.env.STATIC_DIR ?? path.join(here, '../client'));
const UNLOAD_AFTER_MS = 5 * 60 * 1000;
const CLEANUP_EVERY_MS = Number(process.env.CLEANUP_EVERY_MS ?? 3600_000);
/** Base URL in emails and share links. */
const PUBLIC_URL = (process.env.PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/+$/, '');
/** Accounts that receive the canvases from before accounts existed, at their first login. */
const ADMIN_EMAILS = new Set((process.env.ADMIN_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean));
// Other origins that may call /api: the desktop app's webview (Tauri v2 on macOS/Linux, Windows).
const CORS_ORIGINS = new Set(
  (process.env.CORS_ORIGINS ?? 'tauri://localhost,http://tauri.localhost,https://tauri.localhost')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
);

/** package.json sits next to dist/ in development and on the server (the deploy copies it). */
const VERSION: string = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(here, '../../package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
})();

const store = new Store(DB_PATH);
const mailer = new Mailer();
const sessions = new Map<string, Session>();

function getSession(code: string): Session | null {
  let s = sessions.get(code);
  if (s) return s;
  s = Session.load(store, code) ?? undefined;
  if (!s) return null;
  sessions.set(code, s);
  return s;
}

/** After a claim, a sharing change or a delete: re-check everyone on that canvas. */
function refreshCanvas(code: string, gone: 'deleted' | 'expired' = 'deleted'): void {
  const s = sessions.get(code);
  if (!s) return;
  s.refresh(gone)
    .catch((e) => console.error(`[${code}] refresh`, e))
    .finally(() => {
      if (!store.sessionExists(code)) sessions.delete(code);
    });
}

/** After a rename: the live session moves to the new code, then everyone is re-checked. */
function moveCanvas(from: string, to: string): void {
  const s = sessions.get(from);
  if (s) {
    sessions.delete(from);
    s.code = to;
    sessions.set(to, s);
  }
  refreshCanvas(to);
}

/** EMAIL_VERIFICATION=1: new accounts confirm their email before they can log in. */
const EMAIL_VERIFICATION = process.env.EMAIL_VERIFICATION === '1';
const captcha = await makeCaptcha(store.secret('captcha'));

setAdminEmails(ADMIN_EMAILS);

const api: ApiContext = {
  store,
  mailer,
  captcha,
  emailVerification: EMAIL_VERIFICATION,
  publicUrl: PUBLIC_URL,
  adminEmails: ADMIN_EMAILS,
  allowedOrigins: CORS_ORIGINS,
  refreshCanvas,
  moveCanvas,
  importDoc: (row, layers, strokes, shapes) => Session.importDoc(store, row, layers, strokes, shapes),
};

setInterval(() => {
  try {
    cleanup(store, (code) => refreshCanvas(code, 'expired'), EMAIL_VERIFICATION);
  } catch (e) {
    console.error('cleanup', e);
  }
}, CLEANUP_EVERY_MS).unref();

function clientIp(req: http.IncomingMessage): string {
  // nginx sets X-Real-IP. The server binds to localhost, so only the proxy can set it.
  const h = req.headers['x-real-ip'];
  return (typeof h === 'string' && h) || req.socket.remoteAddress || 'unknown';
}

// --- static files ---------------------------------------------------------------------------
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): void {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return void res.writeHead(400).end('bad request');
  }
  if (rel === '/' || rel.startsWith('/s/') || rel.startsWith('/e/')) rel = '/index.html';
  const file = path.join(STATIC_DIR, path.normalize(rel));
  if (!file.startsWith(STATIC_DIR + path.sep)) return void res.writeHead(403).end();
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      // Unknown paths fall back to the app shell.
      if (path.extname(rel) === '') return serveStatic(req, res, '/');
      return void res.writeHead(404).end('not found');
    }
    const immutable = rel.startsWith('/assets/');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    if (req.method === 'HEAD') return void res.end();
    fs.createReadStream(file).pipe(res);
  });
}

const linkCtx = { store, publicUrl: PUBLIC_URL };

/**
 * Embeds (/e/KEY) are meant to be framed by any site, also a local file. A CSP frame-ancestors
 * rule makes browsers ignore an X-Frame-Options header (the proxy may add SAMEORIGIN to every
 * response), so this works without changing the proxy. Other pages keep the proxy's rule.
 */
const EMBED_CSP = 'frame-ancestors * file: data: blob:';

/** /s/KEY and /e/KEY: the app shell with the link preview tags for that canvas. */
function servePage(req: http.IncomingMessage, res: http.ServerResponse, pathname: string, search: URLSearchParams): void {
  fs.readFile(path.join(STATIC_DIR, 'index.html'), 'utf8', (err, html) => {
    if (err) return void res.writeHead(404).end('not found');
    pageWithTags(linkCtx, html, pathname, search)
      .catch(() => html)
      .then((body) => {
        const buf = Buffer.from(body);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': buf.length,
          'Cache-Control': 'no-cache',
          ...(pathname.startsWith('/e/') ? { 'Content-Security-Policy': EMBED_CSP } : {}),
        });
        res.end(req.method === 'HEAD' ? undefined : buf);
      });
  });
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

// --- HTTP -----------------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const p = url.pathname;

  if (p.startsWith('/api/')) {
    const origin = req.headers.origin;
    if (origin && CORS_ORIGINS.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Draw-Options');
      res.setHeader('Access-Control-Max-Age', '86400');
    }
    if (req.method === 'OPTIONS') return void res.writeHead(204).end();
  }

  if (p === '/api/health') return json(res, 200, { ok: true, version: VERSION, sessions: sessions.size, mail: mailer.mode });
  // Link previews (linkPreview.ts): the image, and oEmbed.
  const previewPath = /^\/api\/canvases\/([^/]+)\/preview\.png$/.exec(p);
  if (previewPath && (req.method === 'GET' || req.method === 'HEAD')) {
    let key: string | null = null;
    try {
      key = parseKey(decodeURIComponent(previewPath[1]));
    } catch {
      key = null;
    }
    if (!key) return json(res, 404, { error: 'not_found' });
    previewImage(linkCtx, req, res, key, url.searchParams.get('k')).catch((e) => {
      console.error('preview', e);
      if (!res.headersSent) json(res, 500, { error: 'internal' });
    });
    return;
  }
  if (p === '/api/oembed' && req.method === 'GET') {
    oembed(linkCtx, url.searchParams)
      .then((r) => json(res, r.status, r.body))
      .catch(() => json(res, 500, { error: 'internal' }));
    return;
  }
  if (p.startsWith('/api/')) {
    handleApi(api, req, res, url, clientIp(req))
      .then((handled) => {
        if (!handled && !res.headersSent) json(res, 404, { error: 'not_found' });
      })
      .catch((e) => {
        console.error('api', e);
        if (!res.headersSent) json(res, 500, { error: 'internal' });
      });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return void res.writeHead(405).end();
  if (keyFromPath(p)) return void servePage(req, res, p, url.searchParams);
  serveStatic(req, res, p);
});

// --- WebSocket ------------------------------------------------------------------------------
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: LIMITS.maxMessageBytes,
  perMessageDeflate: { threshold: 1024 },
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const code = url.pathname === '/ws' ? parseKey(url.searchParams.get('code') ?? '') : null;
  const session = code ? getSession(code) : null;
  if (!session) {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }
  // The web app's session cookie comes with the upgrade (same origin). The desktop app sends
  // its token in the hello instead.
  const user = userFromToken(store, readCookie(req, SESSION_COOKIE));
  wss.handleUpgrade(req, socket, head, (ws) => {
    const client = newClient(ws, user);
    let alive = true;
    session.join(client);
    ws.on('pong', () => (alive = true));
    const beat = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, 30_000);
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg: ClientMsg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (typeof msg !== 'object' || msg === null) return;
      session.handle(client, msg).catch((e) => console.error(`[${session.code}] handler error`, e));
    });
    ws.on('close', () => {
      clearInterval(beat);
      session.leave(client);
      if (session.clients.size === 0) {
        session.unloadTimer = setTimeout(() => {
          if (session.clients.size === 0) sessions.delete(session.code);
        }, UNLOAD_AFTER_MS);
      }
    });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`draw ${VERSION} on http://${HOST}:${PORT} (db ${DB_PATH}, public ${PUBLIC_URL}, mail ${mailer.mode})`);
  if (!ADMIN_EMAILS.size) console.log('accounts: no ADMIN_EMAILS set; legacy canvases stay unassigned');
  void mailer.verify();
  cleanup(store, (code) => refreshCanvas(code, 'expired'), EMAIL_VERIFICATION);
});

function shutdown() {
  wss.clients.forEach((ws) => ws.close(1012, 'server restart'));
  server.close();
  store.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
