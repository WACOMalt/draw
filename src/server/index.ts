import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { newSessionCode } from '../shared/ids';
import { LIMITS, normalizeCode, type ClientMsg } from '../shared/types';
import { Store } from './db';
import { Session, newClient } from './session';

const PORT = Number(process.env.PORT ?? 3210);
const HOST = process.env.HOST ?? '127.0.0.1';
const DB_PATH = process.env.DB_PATH ?? './data/canvas.db';
const here = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.resolve(process.env.STATIC_DIR ?? path.join(here, '../client'));
const UNLOAD_AFTER_MS = 5 * 60 * 1000;
const CREATE_PER_MINUTE = 10;

const store = new Store(DB_PATH);
const sessions = new Map<string, Session>();

function getSession(code: string): Session | null {
  let s = sessions.get(code);
  if (s) return s;
  if (!store.sessionExists(code)) return null;
  s = Session.load(store, code);
  sessions.set(code, s);
  return s;
}

// --- rate limit for session creation, per client IP ---------------------------------------
const createLog = new Map<string, number[]>();
function allowCreate(ip: string): boolean {
  const now = Date.now();
  const recent = (createLog.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= CREATE_PER_MINUTE) return false;
  recent.push(now);
  createLog.set(ip, recent);
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, ts] of createLog) if (ts.every((t) => now - t >= 60_000)) createLog.delete(ip);
}, 60_000).unref();

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
  '.woff2': 'font/woff2',
};

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): void {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel.startsWith('/s/')) rel = '/index.html';
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

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

// --- HTTP -----------------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const p = url.pathname;

  if (p === '/api/sessions' && req.method === 'POST') {
    if (!allowCreate(clientIp(req))) return json(res, 429, { error: 'rate_limited' });
    for (let i = 0; i < 5; i++) {
      const code = newSessionCode();
      if (store.createSession(code)) return json(res, 201, { code });
    }
    return json(res, 500, { error: 'code_collision' });
  }

  const m = /^\/api\/sessions\/([^/]+)$/.exec(p);
  if (m && req.method === 'GET') {
    const code = normalizeCode(m[1]);
    return json(res, 200, { exists: code !== null && store.sessionExists(code), code });
  }

  if (p === '/api/health') return json(res, 200, { ok: true, sessions: sessions.size });
  if (p.startsWith('/api/')) return json(res, 404, { error: 'not_found' });
  if (req.method !== 'GET' && req.method !== 'HEAD') return void res.writeHead(405).end();
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
  const code = url.pathname === '/ws' ? normalizeCode(url.searchParams.get('code') ?? '') : null;
  const session = code ? getSession(code) : null;
  if (!session) {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const client = newClient(ws);
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
      try {
        session.handle(client, msg);
      } catch (e) {
        console.error(`[${session.code}] handler error`, e);
      }
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
  console.log(`draw server on http://${HOST}:${PORT} (db ${DB_PATH}, static ${STATIC_DIR})`);
});

function shutdown() {
  wss.clients.forEach((ws) => ws.close(1012, 'server restart'));
  server.close();
  store.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
