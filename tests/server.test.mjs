// Integration test: runs the real server (built dist/server) against a scratch database and
// checks accounts, claiming, roles, links, join passwords, live re-checks, expiry and legacy
// adoption over HTTP and WebSocket.
//
//   npm run build:server && node tests/server.test.mjs
import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import zlib from 'node:zlib';
import { solveChallenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2';

const PORT = 3400 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'draw-test-'));
const DB = path.join(dir, 'canvas.db');
const MAIL = path.join(dir, 'mail');
let failures = 0;
const check = (cond, label) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A database from before accounts: one canvas, old schema.
{
  const db = new Database(DB);
  db.exec(`CREATE TABLE sessions (code TEXT PRIMARY KEY, created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL, seq INTEGER NOT NULL DEFAULT 0);
           CREATE TABLE ops (code TEXT NOT NULL, seq INTEGER NOT NULL, client_id TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (code, seq)) WITHOUT ROWID;`);
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, 0)').run('QWRT-ZXCV', 1, 1);
  db.close();
}

// A light proof of work, so the tests solve it fast (the real widget solves the same kind).
const EASY_CAPTCHA = { CAPTCHA_COST: '10', CAPTCHA_COUNTER_MIN: '10', CAPTCHA_COUNTER_MAX: '40' };
const server = spawn(process.execPath, ['dist/server/index.js'], {
  env: { ...process.env, PORT: String(PORT), DB_PATH: DB, DEV_MAIL_DIR: MAIL, PUBLIC_URL: BASE, ADMIN_EMAILS: 'admin@example.com', TEMP_TTL_MS: '4000', CLEANUP_EVERY_MS: '1000', NODE_ENV: 'test', ...EASY_CAPTCHA },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));
for (let i = 0; i < 50 && !log.includes('draw '); i++) await sleep(100);

// --- helpers -------------------------------------------------------------------------------
class Browser {
  cookie = '';
  anon = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  // Each test browser is a different person behind the proxy (per-IP rate limits).
  ip = `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  async api(method, p, body) {
    const res = await fetch(BASE + p, {
      method,
      redirect: 'manual',
      headers: { 'X-Real-IP': this.ip, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    let data = null;
    try {
      data = await res.json();
    } catch {}
    return { status: res.status, data, location: res.headers.get('location') };
  }
  /** POST /api/import: a .bdraw body with the create options in X-Draw-Options. */
  async upload(bytes, opts, headers = {}) {
    const res = await fetch(BASE + '/api/import', {
      method: 'POST',
      headers: { 'X-Real-IP': this.ip, 'Content-Type': 'application/octet-stream', 'X-Draw-Options': encodeURIComponent(JSON.stringify({ anon: this.anon, ...opts })), ...(this.cookie ? { Cookie: this.cookie } : {}), ...headers },
      body: bytes,
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  }
  join(key, extra = {}) {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?code=${key}`, { headers: this.cookie ? { Cookie: this.cookie } : {} });
      const msgs = [];
      const conn = { ws, msgs, closed: null, next: (pred, ms = 2000) => waitFor(msgs, pred, ms), send: (m) => ws.send(JSON.stringify(m)) };
      ws.on('message', (d) => msgs.push(JSON.parse(d)));
      ws.on('close', (code) => (conn.closed = code));
      ws.on('open', () => {
        conn.send({ t: 'hello', name: 'Tester', color: '#ff0000', anon: this.anon, ...extra });
        resolve(conn);
      });
    });
  }
}
async function waitFor(msgs, pred, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const m = msgs.find(pred);
    if (m) return m;
    await sleep(20);
  }
  return null;
}
const first = (conn) => conn.next((m) => m.t === 'welcome' || m.t === 'denied');
function lastMail(to) {
  const files = fs.existsSync(MAIL) ? fs.readdirSync(MAIL).filter((f) => f.includes(to)).sort() : [];
  return files.length ? JSON.parse(fs.readFileSync(path.join(MAIL, files.at(-1)), 'utf8')) : null;
}
/** A solved captcha payload, as the ALTCHA widget sends it. */
async function solvedCaptcha(base = BASE) {
  const challenge = await (await fetch(`${base}/api/captcha`)).json();
  const solution = await solveChallenge({ challenge, deriveKey });
  return btoa(JSON.stringify({ challenge, solution }));
}
/** Registers (no email confirmation on this server): logged in at once. */
async function account(b, email, name) {
  return b.api('POST', '/api/auth/register', { email, name, password: 'correct horse battery', captcha: await solvedCaptcha() });
}
const layerId = (welcome) => welcome.layers[0].id;
const strokeOp = (layer, n = 1) => ({ t: 'op', opId: `op${n}xxxxx`, op: { type: 'stroke.add', stroke: { id: `stroke${n}${Math.random().toString(36).slice(2, 8)}`, layerId: layer, brush: { tool: 'paint', color: '#000000', size: 4, opacity: 1, flow: 1, hardness: 1, spacing: 0.1, pressureSize: false, pressureFlow: false, buildup: false }, pts: [0, 0, 1, 10, 10, 1] } } });

try {
  // --- legacy canvas -------------------------------------------------------------------------
  const admin = new Browser();
  check((await admin.api('GET', '/api/sessions/QWRT-ZXCV')).data.exists, 'legacy canvas survives the migration');

  // --- temporary canvas and claim ---------------------------------------------------------------
  const funky = new Browser(); // creates the canvas
  const busy = new Browser(); // joins by code
  const created = await funky.api('POST', '/api/sessions', { anon: funky.anon });
  const temp = created.data.key;
  check(created.status === 201 && /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(temp), 'anonymous user creates a temporary canvas');
  check((await funky.api('POST', '/api/sessions', { name: 'my-room', anon: funky.anon })).status === 401, 'anonymous user cannot create a named canvas');

  const fConn = await funky.join(temp);
  const fWelcome = await first(fConn);
  check(fWelcome?.t === 'welcome' && fWelcome.role === 'editor', 'creator joins as editor');
  check(fWelcome.canvas.canClaim === true && fWelcome.canvas.owned === false && fWelcome.canvas.expiresAt > Date.now(), 'creator sees claim + expiry');
  const bConn = await busy.join(temp);
  const bWelcome = await first(bConn);
  check(bWelcome.canvas.canClaim === false, 'someone else does not see claim');

  await account(busy, 'busy@example.com', 'Busy Mongoose');
  check((await busy.api('POST', `/api/canvases/${temp}/claim`, { anon: busy.anon })).status === 403, 'logged-in non-creator cannot claim');
  check((await funky.api('POST', `/api/canvases/${temp}/claim`, { anon: funky.anon })).status === 401, 'creator must log in to claim');
  check((await funky.api('POST', '/api/auth/register', { email: 'funky@example.com', name: 'Funky Otter', password: 'correct horse battery' })).data.error === 'captcha', 'registering needs the captcha');
  const used = await solvedCaptcha();
  const registered = await funky.api('POST', '/api/auth/register', { email: 'funky@example.com', name: 'Funky Otter', password: 'correct horse battery', captcha: used });
  check(registered.status === 201 && registered.data.user?.name === 'Funky Otter' && !lastMail('funky@example.com'), 'registering logs in at once, no email');
  check((await new Browser().api('POST', '/api/auth/register', { email: 'other@example.com', name: 'X', password: 'correct horse battery', captcha: used })).data.error === 'captcha', 'a solved captcha works only once');
  check((await new Browser().api('POST', '/api/auth/register', { email: 'FUNKY@example.com', name: 'X', password: 'correct horse battery', captcha: await solvedCaptcha() })).status === 409, 'an email that has an account cannot register again');
  check((await funky.api('GET', '/api/auth/me')).data.user?.name === 'Funky Otter', 'me returns the account');
  check((await funky.api('POST', `/api/canvases/${temp}/claim`, { anon: funky.anon })).status === 200, 'creator claims after login');
  const fAccess = await fConn.next((m) => m.t === 'access');
  check(fAccess?.canvas.owned === true && fAccess.canvas.expiresAt === null && fAccess.canvas.canClaim === false, 'connected creator sees it owned, no expiry');
  const bAccess = await bConn.next((m) => m.t === 'access');
  check(bAccess?.role === 'viewer', 'after the claim the code is a view link: others become viewers');
  const tempShare = (await funky.api('GET', `/api/canvases/${temp}/sharing`)).data;
  check(tempShare.codeRole === 'viewer' && tempShare.codeLink.endsWith(`/s/${temp}`) && new URL(tempShare.editLink).searchParams.get('k')?.length === 22, 'claimed canvas: short view link, token edit link');
  check((await funky.api('POST', `/api/canvases/${temp}/claim`, { anon: funky.anon })).status === 403, 'cannot claim twice');

  // --- claim with options: a name and an access level; people on it follow the rename -----------
  const gus = new Browser();
  const gTemp = (await gus.api('POST', '/api/sessions', { anon: gus.anon })).data.key;
  const gConn = await gus.join(gTemp);
  const gWelcome = await first(gConn);
  gConn.send(strokeOp(layerId(gWelcome), 7));
  await gConn.next((m) => m.t === 'op');
  const pal = await new Browser().join(gTemp);
  await first(pal);
  await account(gus, 'gus@example.com', 'Gus');
  await funky.api('POST', '/api/sessions', { name: 'taken-name' });
  check((await gus.api('POST', `/api/canvases/${gTemp}/claim`, { anon: gus.anon, access: 'editor', name: 'Taken Name' })).status === 409, 'claim with a taken name fails');
  check((await gus.api('GET', `/api/sessions/${gTemp}`)).data.exists && !(await gus.api('GET', `/api/canvases/${gTemp}/sharing`)).data?.key, 'a failed claim changes nothing');
  const gClaim = await gus.api('POST', `/api/canvases/${gTemp}/claim`, { anon: gus.anon, access: 'editor', name: 'Gus Room' });
  check(gClaim.status === 200 && gClaim.data.key === 'gus-room', 'claim with a new name');
  const palMoved = await pal.next((m) => m.t === 'access');
  check(palMoved?.canvas.key === 'gus-room' && palMoved.role === 'editor', 'public claim: others keep drawing and learn the new name');
  check(!(await gus.api('GET', `/api/sessions/${gTemp}`)).data.exists, 'the old code is gone');
  const rejoin = await first(await new Browser().join('gus-room'));
  check(rejoin?.role === 'editor' && rejoin.strokes.length === 1, 'renamed canvas keeps its strokes; public code draws');
  const rnd = await gus.api('POST', '/api/canvases/gus-room/rename', { random: true });
  check(rnd.status === 200 && /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(rnd.data.key), 'rename to a new random code');
  check(!!(await pal.next((m) => m.t === 'access' && m.canvas.key === rnd.data.key)), 'connected people follow a second rename');
  await gus.api('POST', `/api/canvases/${rnd.data.key}/links`, { kind: 'code', role: 'none' });
  check((await pal.next((m) => m.t === 'denied'))?.reason === 'login_required', 'made private: link people are removed');
  const solo = new Browser();
  const sTemp = (await solo.api('POST', '/api/sessions', { anon: solo.anon })).data.key;
  await account(solo, 'solo@example.com', 'Solo');
  await solo.api('POST', `/api/canvases/${sTemp}/claim`, { anon: solo.anon, access: 'none' });
  check((await first(await new Browser().join(sTemp)))?.reason === 'login_required', 'private claim: the code gives nothing');

  // --- owned canvas, links and roles --------------------------------------------------------------
  const own = await funky.api('POST', '/api/sessions', { name: 'Friday Jam' });
  check(own.status === 201 && own.data.key === 'friday-jam', 'account creates a named canvas');
  const share = (await funky.api('GET', '/api/canvases/friday-jam/sharing')).data;
  const editTok = new URL(share.editLink).searchParams.get('k');
  check(share.codeLink === `${BASE}/s/friday-jam` && share.codeRole === 'viewer' && share.viewLink === null && editTok?.length === 22, 'canvas link views by default, edit link has a token');

  const stranger = new Browser();
  const viewer = await stranger.join('friday-jam');
  const vWelcome = await first(viewer);
  check(vWelcome?.role === 'viewer', 'plain code gives viewer');
  const guess = await first(await new Browser().join('friday-jam', { link: 'friday-jam' }));
  check(guess?.role === 'viewer', 'a wrong token never gives more than the plain code');
  viewer.send(strokeOp(layerId(vWelcome)));
  const rej = await viewer.next((m) => m.t === 'reject');
  check(rej?.reason === 'view only', 'viewer cannot draw');
  const editor = await new Browser().join('friday-jam', { link: editTok });
  const eWelcome = await first(editor);
  check(eWelcome?.role === 'editor', 'edit link gives editor');
  editor.send(strokeOp(layerId(eWelcome), 2));
  check(!!(await editor.next((m) => m.t === 'op' && m.op.type === 'stroke.add')), 'editor can draw');

  // Reset the edit link: the editor who came by the old link loses access at once.
  await funky.api('POST', '/api/canvases/friday-jam/links', { kind: 'edit', action: 'reset' });
  const demoted = await editor.next((m) => m.t === 'access' || m.t === 'denied');
  check(demoted?.t === 'access' && demoted.role === 'viewer', 'reset edit link drops old-link editors to view only');

  // --- join password ------------------------------------------------------------------------------
  await funky.api('POST', '/api/canvases/friday-jam/password', { password: 'sesame' });
  const kickedViewer = await viewer.next((m) => m.t === 'denied');
  check(kickedViewer?.reason === 'password_required', 'new password re-asks connected link users');
  const pw = await new Browser().join('friday-jam');
  check((await first(pw))?.reason === 'password_required', 'link user must enter the password');
  pw.send({ t: 'hello', name: 'x', color: '#000000', password: 'wrong' });
  check(!!(await pw.next((m) => m.t === 'denied' && m.reason === 'password_wrong')), 'wrong password refused');
  pw.send({ t: 'hello', name: 'x', color: '#000000', password: 'sesame' });
  const pwWelcome = await pw.next((m) => m.t === 'welcome');
  check(pwWelcome?.role === 'viewer' && !!pwWelcome.grant, 'right password lets in, with a grant');
  const again = await new Browser().join('friday-jam', { grant: pwWelcome.grant });
  check((await first(again))?.role === 'viewer', 'grant skips the password next time');

  // Canvas link off: the plain code gives nothing; a private view link still works.
  await funky.api('POST', '/api/canvases/friday-jam/links', { kind: 'code', role: 'none' });
  check((await first(await new Browser().join('friday-jam')))?.reason === 'login_required', 'canvas link off: the plain code gives nothing');
  const vr = (await funky.api('POST', '/api/canvases/friday-jam/links', { kind: 'view', action: 'enable' })).data;
  const viewTok = new URL(vr.viewLink).searchParams.get('k');
  check(viewTok?.length === 22, 'private view link has a token');
  check((await first(await new Browser().join('friday-jam', { link: viewTok, grant: pwWelcome.grant })))?.role === 'viewer', 'private view link gives viewer');

  // Public: anyone with the code draws, connected viewers are upgraded live.
  const pub = await new Browser().join('friday-jam', { link: viewTok, grant: pwWelcome.grant });
  await first(pub);
  await funky.api('POST', '/api/canvases/friday-jam/links', { kind: 'code', role: 'editor' });
  check((await pub.next((m) => m.t === 'access'))?.role === 'editor', 'public canvas: connected viewers can draw at once');
  check((await first(await new Browser().join('friday-jam', { grant: pwWelcome.grant })))?.role === 'editor', 'public canvas: the plain code draws');
  check((await funky.api('POST', '/api/canvases/friday-jam/links', { kind: 'code', role: 'owner' })).status === 400, 'canvas link cannot give owner');
  await funky.api('POST', '/api/canvases/friday-jam/links', { kind: 'code', role: 'viewer' });
  check(!!(await pub.next((m) => m.t === 'access' && m.role === 'viewer')), 'public off: back to view only');

  // --- members ------------------------------------------------------------------------------------
  const vee = new Browser();
  await account(vee, 'vee@example.com', 'Vee');
  check((await funky.api('POST', '/api/canvases/friday-jam/members', { email: 'nobody@example.com', role: 'editor' })).status === 404, 'cannot add an unknown email');
  const added = await funky.api('POST', '/api/canvases/friday-jam/members', { email: 'vee@example.com', role: 'viewer' });
  const veeId = added.data.members.find((m) => m.email === 'vee@example.com').id;
  const vConn = await vee.join('friday-jam');
  const vMember = await first(vConn);
  check(vMember?.role === 'viewer', 'member joins without link or password');
  await funky.api('PATCH', `/api/canvases/friday-jam/members/${veeId}`, { role: 'editor' });
  check((await vConn.next((m) => m.t === 'access'))?.role === 'editor', 'role change applies live');
  check((await vee.api('GET', '/api/canvases/friday-jam/sharing')).status === 403, 'non-owner cannot see sharing');
  const list = (await vee.api('GET', '/api/canvases')).data;
  check(list.shared.some((c) => c.key === 'friday-jam'), 'canvas appears under "shared with me"');
  await funky.api('DELETE', `/api/canvases/friday-jam/members/${veeId}`);
  check(!!(await vConn.next((m) => m.t === 'denied')), 'removed member is disconnected');

  // --- .bdraw files ---------------------------------------------------------------------------------
  const brush = { tool: 'paint', color: '#336699', size: 4, opacity: 1, flow: 1, hardness: 1, spacing: 0.1, pressureSize: false, pressureFlow: false, buildup: false };
  const bfile = {
    format: 'bdraw', version: 1, app: 'test', savedAt: new Date().toISOString(),
    layers: [
      { id: 'layerink01', name: 'Ink', order: 1, blend: 'multiply', opacity: 0.5, visible: true, deleted: false },
      { id: 'layergone1', name: 'Gone', order: 2, blend: 'normal', opacity: 1, visible: true, deleted: true },
    ],
    strokes: [
      { id: 'strokeb002', layerId: 'layerink01', seq: 9, author: 'someone', brush, pts: [5, 5, 1, 9, 9, 1] },
      { id: 'strokea001', layerId: 'layerink01', seq: 3, author: 'someone', brush, pts: [0, 0, 1, 4, 4, 1] },
      { id: 'strokec003', layerId: 'layergone1', seq: 4, author: 'x', brush, pts: [1, 1, 1] },
      { id: 'strokebad4', layerId: 'layerink01', seq: 5, author: 'x', brush, pts: 'nope' },
    ],
  };
  const gz = zlib.gzipSync(JSON.stringify(bfile));
  const imp = await funky.upload(gz, { name: 'Imported Jam', access: 'editor' });
  check(imp.status === 201 && imp.data.key === 'imported-jam' && imp.data.layers === 1 && imp.data.strokes === 2 && imp.data.skipped === 2, 'import a gzipped .bdraw as a named public canvas');
  const iw = await first(await new Browser().join('imported-jam'));
  const live = iw.layers.filter((l) => !l.deleted);
  check(iw.role === 'editor' && live.length === 1 && live[0].blend === 'multiply' && live[0].opacity === 0.5, 'imported layer keeps its settings; public code draws');
  check(iw.strokes.map((x) => x.id).join() === 'strokea001,strokeb002' && iw.strokes[0].author === 'someone', 'imported strokes keep draw order and author');
  // Round trip: the welcome document is the file body.
  const roundTrip = { format: 'bdraw', version: 1, app: 'test', savedAt: '', layers: iw.layers, strokes: iw.strokes };
  const anonImp = await new Browser().upload(Buffer.from(JSON.stringify(roundTrip)), {});
  check(anonImp.status === 201 && /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(anonImp.data.key) && anonImp.data.strokes === 2 && anonImp.data.skipped === 0, 'plain JSON file imports as a temporary canvas (round trip)');
  check((await new Browser().upload(gz, { name: 'nope-name' })).status === 401, 'named import needs an account');
  check((await funky.upload(Buffer.from('not a drawing'), {})).data?.error === 'bad_file', 'a file that is not .bdraw is refused');
  check((await funky.upload(Buffer.from(JSON.stringify({ ...bfile, version: 99 })), {})).data?.error === 'file_too_new', 'a file from a newer version is refused');
  const noHeader = await fetch(BASE + '/api/import', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: gz });
  check(noHeader.status === 403, 'import without X-Draw-Options is refused (CSRF)');
  check((await funky.upload(gz, {}, { Origin: 'https://evil.example' })).status === 403, 'import from a foreign Origin is refused');
  check((await funky.upload(Buffer.alloc(33 * 1024 * 1024), {})).status === 413, 'a file over 32 MB is refused');

  // --- adjustment layers, clipping, masks, brush dynamics -------------------------------------------
  const art = new Browser();
  const artKey = (await art.api('POST', '/api/sessions', { anon: art.anon })).data.key;
  const aConn = await art.join(artKey);
  const aWelcome = await first(aConn);
  const base = layerId(aWelcome);
  let opn = 0;
  const op = async (o) => {
    const opId = `ad${++opn}xxxxxx`;
    aConn.send({ t: 'op', opId, op: o });
    return aConn.next((m) => (m.t === 'op' && m.opId === opId) || (m.t === 'reject' && m.opId === opId));
  };
  const adjLayer = { id: 'adjlayer01', kind: 'adjust', name: 'Levels', order: 5, blend: 'normal', opacity: 1, visible: true, adjust: { type: 'levels', inBlack: 0.1, inWhite: 0.9, gamma: 1.2, outBlack: 0, outWhite: 1 } };
  const adjAdded = await op({ type: 'layer.add', layer: adjLayer });
  check(adjAdded?.t === 'op' && adjAdded.op.layer.kind === 'adjust' && adjAdded.op.layer.adjust.gamma === 1.2, 'add an adjustment layer');
  check((await op({ type: 'layer.add', layer: { ...adjLayer, id: 'adjlayer02', adjust: undefined } }))?.t === 'reject', 'adjustment layer needs settings');
  check((await op({ type: 'layer.update', id: 'adjlayer01', props: { adjust: { type: 'curves', points: [[0.5, 0.2], [0.2, 0.9]] } } }))?.t === 'reject', 'curve points must ascend');
  check((await op({ type: 'layer.update', id: 'adjlayer01', props: { adjust: { type: 'curves', points: [[0, 0], [0.4, 0.6], [1, 1]] } } }))?.t === 'op', 'change to a curves adjustment');
  const paintOnAdjust = await op({ type: 'stroke.add', stroke: { id: 'adjstroke1', layerId: 'adjlayer01', brush, pts: [0, 0, 1, 5, 5, 1] } });
  check(paintOnAdjust?.t === 'reject' && /no paint/.test(paintOnAdjust.reason), 'an adjustment layer refuses plain paint');
  check((await op({ type: 'layer.update', id: base, props: { mask: { id: 'maskid0001', enabled: true }, clip: false } }))?.t === 'op', 'add a layer mask');
  check((await op({ type: 'stroke.add', stroke: { id: 'maskstrok1', layerId: base, mask: 'maskid0001', brush: { ...brush, color: '#000000' }, pts: [0, 0, 1, 9, 9, 1] } }))?.t === 'op', 'paint on the mask');
  const dynBrush = { ...brush, tip: 'chalk', angle: 30, roundness: 0.5, followDirection: true, scatter: 1, sizeJitter: 0.3, grain: 'paper', grainScale: 2, grainStrength: 0.6 };
  check((await op({ type: 'stroke.add', stroke: { id: 'dynstroke1', layerId: base, brush: dynBrush, pts: [0, 0, 1, 20, 4, 1] } }))?.t === 'op', 'stroke with tip and dynamics');
  check((await op({ type: 'stroke.add', stroke: { id: 'badtip0001', layerId: base, brush: { ...brush, tip: 'banana' }, pts: [0, 0, 1] } }))?.t === 'reject', 'unknown tip is refused');
  check((await op({ type: 'layer.update', id: 'adjlayer01', props: { clip: true } }))?.t === 'op', 'clip a layer');
  const peer = await art.join(artKey);
  const pWelcome = await first(peer);
  const feats = new Set(pWelcome.features);
  check(['adjust', 'clip', 'mask', 'tips'].every((f) => feats.has(f)), 'welcome lists the document features');
  const ms = pWelcome.strokes.find((x) => x.id === 'maskstrok1');
  const ds = pWelcome.strokes.find((x) => x.id === 'dynstroke1');
  check(ms?.mask === 'maskid0001' && ds?.brush.tip === 'chalk' && ds.brush.grain === 'paper', 'mask and brush fields survive');
  const plainOnly = await first(await new Browser().join((await new Browser().api('POST', '/api/sessions', {})).data.key));
  check(Array.isArray(plainOnly.features) && plainOnly.features.length === 0, 'a plain canvas lists no features');
  aConn.send({ t: 'live', id: 'livemask01', layerId: base, mask: 'maskid0001', brush, pts: [1, 1, 1], start: true });
  check((await peer.next((m) => m.t === 'live' && m.id === 'livemask01'))?.mask === 'maskid0001', 'live strokes on a mask carry the mask id');
  check((await op({ type: 'layer.update', id: base, props: { mask: null, clip: false } }))?.t === 'op', 'delete a mask (undo sends null and false)');
  // .bdraw version 2 keeps all of it.
  const v2 = { format: 'bdraw', version: 2, app: 'test', savedAt: '', layers: pWelcome.layers, strokes: pWelcome.strokes };
  const v2imp = await new Browser().upload(Buffer.from(JSON.stringify(v2)), {});
  const v2w = await first(await new Browser().join(v2imp.data.key));
  check(v2imp.status === 201 && v2imp.data.skipped === 0 && v2w.layers.some((l) => l.kind === 'adjust' && l.clip) && v2w.strokes.some((x) => x.mask === 'maskid0001'), '.bdraw v2 keeps adjustment layers, clip and masks');

  // --- CSRF guard, password reset, device login ----------------------------------------------------
  const evil = await fetch(`${BASE}/api/canvases/friday-jam/password`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', Cookie: funky.cookie }, body: '{"password":null}' });
  check(evil.status === 403, 'foreign Origin is refused');
  check((await stranger.api('POST', '/api/auth/forgot', { email: 'vee@example.com' })).data.error === 'captcha', 'a reset email needs the captcha');
  await stranger.api('POST', '/api/auth/forgot', { email: 'vee@example.com', captcha: await solvedCaptcha() });
  const resetTok = /reset=(\S+)/.exec(lastMail('vee@example.com').text)[1];
  check((await stranger.api('POST', '/api/auth/reset', { token: resetTok, password: 'a new long password' })).status === 200, 'password reset by email');
  check((await stranger.api('POST', '/api/auth/reset', { token: resetTok, password: 'another password' })).status === 400, 'reset link works once');
  const loginNew = await new Browser().api('POST', '/api/auth/login', { email: 'vee@example.com', password: 'a new long password' });
  check(loginNew.status === 200, 'login with the new password');

  const desk = new Browser();
  const start = (await desk.api('POST', '/api/auth/device/start', {})).data;
  check((await desk.api('POST', '/api/auth/device/poll', { device: start.device })).data.status === 'pending', 'device login pending');
  await funky.api('POST', '/api/auth/device/approve', { code: start.code });
  const polled = (await desk.api('POST', '/api/auth/device/poll', { device: start.device })).data;
  check(polled.status === 'approved' && polled.token && polled.user.name === 'Funky Otter', 'device login approved with a token');
  const deskConn = await desk.join('friday-jam', { token: polled.token });
  check((await first(deskConn))?.role === 'owner', 'desktop token joins as the owner');

  // --- legacy adoption and expiry ------------------------------------------------------------------
  await account(admin, 'admin@example.com', 'Admin');
  const adminList = (await admin.api('GET', '/api/canvases')).data;
  check(adminList.owned.some((c) => c.key === 'QWRT-ZXCV'), 'admin gets the legacy canvas at first login');
  check((await first(await new Browser().join('QWRT-ZXCV')))?.role === 'viewer', 'old plain links to an adopted canvas are view only');
  const legacyEdit = new URL((await admin.api('GET', '/api/canvases/QWRT-ZXCV/sharing')).data.editLink).searchParams.get('k');
  check((await first(await new Browser().join('QWRT-ZXCV', { link: legacyEdit })))?.role === 'editor', 'adopted canvas has an edit token link');

  // --- brush presets -----------------------------------------------------------------------------
  const settings = { size: 40, opacity: 1, flow: 0.8, hardness: 0.5, spacing: 0.2, pressureSize: true, pressureFlow: false, buildup: false, tip: 'charcoal', scatter: 0.5 };
  const anonP = new Browser();
  const pSaved = await anonP.api('POST', '/api/presets', { name: 'Scatter Charcoal', settings, anon: anonP.anon, creatorName: 'Busy Mongoose' });
  check(pSaved.status === 201 && pSaved.data.preset.creatorName === 'Busy Mongoose' && /^a:[0-9a-f]{16}$/.test(pSaved.data.preset.creator), 'save a preset without an account');
  check((await anonP.api('POST', '/api/presets', { name: 'x', settings: { ...settings, size: 5000 }, anon: anonP.anon })).status === 400, 'preset size is in screen pixels (1..1000)');
  check((await anonP.api('POST', '/api/presets', { name: '  ', settings, anon: anonP.anon })).status === 400, 'preset needs a name');
  const presetList = (await new Browser().api('GET', '/api/presets')).data.presets;
  check(presetList.some((x) => x.id === pSaved.data.preset.id && x.settings.tip === 'charcoal' && x.settings.scatter === 0.5), 'everyone sees the preset');
  const stranger2 = new Browser();
  check((await stranger2.api('POST', `/api/presets/${pSaved.data.preset.id}/delete`, { anon: stranger2.anon })).status === 403, 'someone else cannot delete it');
  check((await anonP.api('POST', `/api/presets/${pSaved.data.preset.id}/delete`, { anon: anonP.anon })).status === 200, 'the same browser deletes its preset');
  const vSaved = await funky.api('POST', '/api/presets', { name: 'Charcoal', settings, creatorName: 'Spoofed Name' });
  check(vSaved.status === 201 && vSaved.data.preset.creatorName === 'Funky Otter' && vSaved.data.preset.creator.startsWith('u:'), 'an account saves under its account name');
  check((await anonP.api('POST', `/api/presets/${vSaved.data.preset.id}/delete`, { anon: anonP.anon })).status === 403, 'an anonymous browser cannot delete an account preset');
  check((await admin.api('POST', `/api/presets/${vSaved.data.preset.id}/delete`, {})).status === 200, 'the admin deletes any preset');

  // --- embeds -------------------------------------------------------------------------------------
  const emb = (await funky.api('POST', '/api/sessions', { name: 'embed-test' })).data.key;
  await funky.api('POST', `/api/canvases/${emb}/links`, { kind: 'code', role: 'editor' });
  const embShare = (await funky.api('GET', `/api/canvases/${emb}/sharing`)).data;
  const embEditTok = new URL(embShare.editLink).searchParams.get('k');
  const ownerConn = await funky.join(emb);
  const ownerWelcome = await first(ownerConn);
  check(ownerWelcome?.role === 'owner', 'embed test: owner joins');
  const embConn = await new Browser().join(emb, { embed: true });
  const embWelcome = await first(embConn);
  check(embWelcome?.role === 'viewer' && embWelcome.peers.length === 0, 'embed of a public canvas: view only, sees no people');
  await sleep(200);
  check(!ownerConn.msgs.some((m) => m.t === 'peer.join'), 'other people do not see an embed join');
  embConn.send(strokeOp(layerId(embWelcome), 7));
  check((await embConn.next((m) => m.t === 'reject'))?.reason === 'view only', 'an embed cannot draw');
  embConn.send({ t: 'cursor', x: 1, y: 2, layerId: null });
  await sleep(200);
  check(!ownerConn.msgs.some((m) => m.t === 'cursor'), 'an embed sends no cursor');
  ownerConn.send(strokeOp(layerId(ownerWelcome), 8));
  check(!!(await embConn.next((m) => m.t === 'op' && m.op.type === 'stroke.add')), 'an embed gets new strokes live');
  check((await first(await new Browser().join(emb, { embed: true, link: embEditTok })))?.role === 'viewer', 'an embed with the edit link is still view only');
  await new Browser().join(emb);
  check(!!(await ownerConn.next((m) => m.t === 'peer.join')), 'a normal visitor still shows up');
  embConn.ws.close();
  await sleep(200);
  check(!ownerConn.msgs.some((m) => m.t === 'peer.leave' && m.id === embWelcome.clientId), 'an embed leaves without a trace');
  await funky.api('POST', `/api/canvases/${emb}/links`, { kind: 'code', role: 'none' });
  check((await first(await funky.join(emb, { embed: true })))?.reason === 'login_required', "an embed ignores the owner's login: a private canvas needs a link");
  const embView = (await funky.api('POST', `/api/canvases/${emb}/links`, { kind: 'view', action: 'enable' })).data;
  const embViewTok = new URL(embView.viewLink).searchParams.get('k');
  check((await first(await new Browser().join(emb, { embed: true, link: embViewTok })))?.role === 'viewer', 'a private canvas embeds with the private view link');

  // --- link previews ------------------------------------------------------------------------------
  const pngOf = (w, h) => {
    const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const chunk = (type, data) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
    const raw = Buffer.alloc((w * 3 + 1) * h, 255); for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  };
  const pv = (await funky.api('POST', '/api/sessions', { name: 'preview-test' })).data.key;
  await funky.api('POST', `/api/canvases/${pv}/links`, { kind: 'code', role: 'editor' });
  const pvOwner = await funky.join(pv);
  const pvWelcome = await first(pvOwner);
  check(pvWelcome?.previewSeq === null, 'link preview: none at first');
  pvOwner.send(strokeOp(layerId(pvWelcome), 11));
  await pvOwner.next((m) => m.t === 'op' && m.op.type === 'stroke.add');
  const seqNow = pvOwner.msgs.filter((m) => m.t === 'op').at(-1).seq;
  const frame = [-10, -20, 1200, 630];
  const viewerPv = await new Browser().join(pv, { embed: true });
  await first(viewerPv);
  viewerPv.send({ t: 'preview', png: pngOf(1200, 630).toString('base64'), seq: seqNow, frame });
  await sleep(200);
  check((await fetch(`${BASE}/api/canvases/${pv}/preview.png`)).status === 404, 'an embed (view only) cannot set the preview');
  pvOwner.send({ t: 'preview', png: pngOf(800, 600).toString('base64'), seq: seqNow, frame });
  await sleep(200);
  check((await fetch(`${BASE}/api/canvases/${pv}/preview.png`)).status === 404, 'a preview of the wrong size is refused');
  pvOwner.send({ t: 'preview', png: pngOf(1200, 630).toString('base64'), seq: seqNow, frame });
  check((await pvOwner.next((m) => m.t === 'preview.saved'))?.seq === seqNow, 'an editor sets the preview; everyone is told');
  const img = await fetch(`${BASE}/api/canvases/${pv}/preview.png?v=${seqNow}`);
  check(img.status === 200 && img.headers.get('content-type') === 'image/png' && (await img.arrayBuffer()).byteLength > 33, 'the preview image is served');
  pvOwner.send({ t: 'preview', png: pngOf(1200, 630).toString('base64'), seq: seqNow + 0, frame });
  await sleep(200);
  check(pvOwner.msgs.filter((m) => m.t === 'preview.saved').length === 1, 'the same seq again, within a minute: ignored');
  check((await first(await new Browser().join(pv)))?.previewSeq === seqNow, 'welcome tells the preview seq');
  const page = await (await fetch(`${BASE}/s/${pv}`)).text();
  check(page.includes('property="og:image" content="' + BASE + '/api/canvases/' + pv + '/preview.png?v=' + seqNow) && page.includes('summary_large_image') && page.includes('<title>' + pv + ' · Draw</title>') && page.includes('by Funky Otter'), 'the canvas page has Open Graph tags with the preview');
  check(page.includes('application/json+oembed'), 'the canvas page links oEmbed');
  const embedRes = await fetch(`${BASE}/e/${pv}?r=0,0,10,10`);
  check(embedRes.headers.get('content-security-policy') === 'frame-ancestors * file: data: blob:', 'an embed page may be framed by any site (CSP frame-ancestors)');
  check(!(await fetch(`${BASE}/s/${pv}`)).headers.get('content-security-policy'), 'the canvas page keeps the default (no frame-ancestors from the app)');
  const oe = await (await fetch(`${BASE}/api/oembed?url=${encodeURIComponent(BASE + '/s/' + pv)}`)).json();
  check(oe.type === 'rich' && oe.html.includes(`/e/${pv}?r=-10,-20,1200,630`) && oe.thumbnail_width === 1200 && oe.width === 800 && oe.height === 420, 'oEmbed gives the live embed, framed like the preview');
  check((await fetch(`${BASE}/api/oembed?url=${encodeURIComponent('https://evil.example/s/' + pv)}`)).status === 404, 'oEmbed answers only for this site');
  await funky.api('POST', `/api/canvases/${pv}/links`, { kind: 'code', role: 'none' });
  const privPage = await (await fetch(`${BASE}/s/${pv}`)).text();
  check(!privPage.includes('preview.png') && privPage.includes('A private drawing') && !privPage.includes('Funky'), 'a private canvas: generic card, no image, no owner');
  check((await fetch(`${BASE}/api/canvases/${pv}/preview.png`)).status === 404, 'a private canvas: no image without a token');
  check((await fetch(`${BASE}/api/oembed?url=${encodeURIComponent(BASE + '/s/' + pv)}`)).status === 401, 'a private canvas: oEmbed says private');
  const pvView = new URL((await funky.api('POST', `/api/canvases/${pv}/links`, { kind: 'view', action: 'enable' })).data.viewLink).searchParams.get('k');
  check((await fetch(`${BASE}/api/canvases/${pv}/preview.png?k=${pvView}`)).status === 200, 'a private canvas: the view link token shows the image');
  check((await (await fetch(`${BASE}/s/${pv}?k=${pvView}`)).text()).includes(`preview.png?v=${seqNow}&amp;k=${pvView}`), 'a private canvas: the view link page has the image, with the token');
  const pvRenamed = await funky.api('POST', `/api/canvases/${pv}/rename`, { name: 'preview-moved' });
  check(pvRenamed.status === 200 && (await fetch(`${BASE}/api/canvases/preview-moved/preview.png?k=${pvView}`)).status === 200, 'rename keeps the preview');

  // --- layer groups, transforms, duplicates ------------------------------------------------------
  {
    // Its own account (and address): canvas creation is rate limited per address.
    const gb = new Browser();
    await account(gb, 'groups@example.com', 'Group Tester');
    const gc = (await gb.api('POST', '/api/sessions', { name: 'groups-test' })).data.key;
    const o = await gb.join(gc);
    const w = await first(o);
    const L1 = layerId(w);
    let opn = 100;
    const send = (op) => o.send({ t: 'op', opId: `g${opn++}xxxxx`, op });
    const echo = (pred) => o.next((m) => m.t === 'op' && pred(m.op), 2000);
    const rejected = (n) => o.next((m) => m.t === 'reject' && m.opId === `g${n}xxxxx`, 2000);
    const layer = (id, extra = {}) => ({ type: 'layer.add', layer: { id, name: id, order: 2, blend: 'normal', opacity: 1, visible: true, ...extra } });

    send(layer('groupAAAA1', { kind: 'group', blend: 'pass' }));
    check(!!(await echo((op) => op.type === 'layer.add' && op.layer.id === 'groupAAAA1')), 'groups: add a group (pass through)');
    let n = opn;
    send(layer('paintPASS1', { blend: 'pass' }));
    check(!!(await rejected(n)), 'groups: pass through is for groups only');
    send({ type: 'layer.update', id: L1, props: { parent: 'groupAAAA1', order: 1 } });
    check(!!(await echo((op) => op.type === 'layer.update' && op.props.parent === 'groupAAAA1')), 'groups: move a layer into a group');
    o.send(strokeOp(L1, 41));
    const st = await o.next((m) => m.t === 'op' && m.op.type === 'stroke.add');
    check(!!st, 'groups: draw on a layer in a group');
    n = opn;
    send({ type: 'stroke.add', stroke: { id: 'strokeGRP01', layerId: 'groupAAAA1', brush: st.op.stroke.brush, pts: [0, 0, 1, 5, 5, 1] } });
    check(!!(await rejected(n)), 'groups: a group holds no paint');
    send(layer('groupBBBB1', { kind: 'group', parent: 'groupAAAA1' }));
    await echo((op) => op.type === 'layer.add' && op.layer.id === 'groupBBBB1');
    n = opn;
    send({ type: 'layer.update', id: 'groupAAAA1', props: { parent: 'groupBBBB1' } });
    check(!!(await rejected(n)), 'groups: a group cannot go into itself');
    n = opn;
    send({ type: 'layer.update', id: 'groupBBBB1', props: { parent: L1 } });
    check(!!(await rejected(n)), 'groups: only a group can hold layers');

    // Transform the group: the stroke of the layer inside moves.
    send({ type: 'layer.transform', id: 'groupAAAA1', m: [2, 0, 0, 2, 100, 50] });
    check(!!(await echo((op) => op.type === 'layer.transform')), 'transform: a group transform is accepted');
    const w2 = await first(await gb.join(gc));
    const moved = w2.strokes.find((x) => x.id === st.op.stroke.id);
    check(moved?.pts[0] === 100 && moved.pts[1] === 50 && moved.pts[3] === 120 && moved.pts[4] === 70 && moved.brush.size === 8, 'transform: points mapped, brush scaled by the average scale');
    n = opn;
    send({ type: 'layer.transform', id: L1, m: [1e14, 0, 0, 1e14, 0, 0] });
    check(!!(await rejected(n)), 'transform: out of range is refused, nothing changes');
    n = opn;
    send({ type: 'layer.transform', id: L1, m: [1, 0, 0, 0, 0, 0] });
    check(!!(await rejected(n)), 'transform: a flat (not invertible) matrix is refused');

    // Duplicate the group: the copy has the inner group, the layer and the stroke, with new ids.
    send({ type: 'layer.duplicate', id: 'groupAAAA1', newId: 'groupCOPY1', name: 'Copy', order: 3, parent: null });
    check(!!(await echo((op) => op.type === 'layer.duplicate')), 'duplicate: a group duplicate is accepted');
    const w3 = await first(await gb.join(gc));
    const copyLayers = w3.layers.filter((l) => l.id === 'groupCOPY1' || l.parent === 'groupCOPY1');
    const copyPaint = copyLayers.find((l) => l.kind !== 'group' && l.id !== 'groupCOPY1');
    const copyStroke = w3.strokes.find((x) => x.layerId === copyPaint?.id);
    check(copyLayers.length === 3 && copyLayers.some((l) => l.kind === 'group' && l.parent === 'groupCOPY1') && copyStroke && copyStroke.id !== st.op.stroke.id && copyStroke.pts[0] === 100, 'duplicate: layers and strokes copied, with new ids');
    check(w3.features.includes('groups'), 'groups: welcome lists the groups feature');

    // Deleting the group hides its layers: no drawing there until restored.
    send({ type: 'layer.remove', id: 'groupAAAA1' });
    await echo((op) => op.type === 'layer.remove');
    n = opn;
    o.send({ t: 'op', opId: `g${opn++}xxxxx`, op: strokeOp(L1, 42).op });
    check(!!(await rejected(n)), 'groups: a layer in a deleted group takes no strokes');
    send({ type: 'layer.restore', id: 'groupAAAA1' });
    await echo((op) => op.type === 'layer.restore');
    o.send(strokeOp(L1, 43));
    check(!!(await o.next((m) => m.t === 'op' && m.op.type === 'stroke.add' && m.op.stroke.layerId === L1 && m.seq > st.seq)), 'groups: restoring the group brings its layers back');

    // Nesting deeper than the limit is refused.
    let parent = null, refused = false;
    for (let d = 0; d < 10; d++) {
      const id = `deepGRP${d}xx`;
      n = opn;
      send(layer(id, { kind: 'group', ...(parent ? { parent } : {}) }));
      const r = await o.next((m) => (m.t === 'op' && m.op.type === 'layer.add' && m.op.layer.id === id) || (m.t === 'reject' && m.opId === `g${n}xxxxx`), 2000);
      if (r?.t === 'reject') {
        refused = d === 8;
        break;
      }
      parent = id;
    }
    check(refused, 'groups: nesting is limited to 8 levels');

    // A .bdraw with a layer listed before its group: the import adds the group first.
    const brush = { tool: 'paint', color: '#000000', size: 4, opacity: 1, flow: 1, hardness: 1, spacing: 0.1, pressureSize: false, pressureFlow: false, buildup: false };
    const file = {
      format: 'bdraw', version: 2, app: 'test', savedAt: '',
      layers: [
        { id: 'impLAYER1', name: 'In group', order: 1, blend: 'normal', opacity: 1, visible: true, deleted: false, parent: 'impGROUP1' },
        { id: 'impGROUP1', name: 'Group', order: 1, blend: 'pass', opacity: 1, visible: true, deleted: false, kind: 'group' },
      ],
      strokes: [{ id: 'impSTROKE1', layerId: 'impLAYER1', seq: 1, author: 'x', brush, pts: [0, 0, 1, 5, 5, 1] }],
    };
    const gImp = await gb.upload(Buffer.from(JSON.stringify(file)), {});
    const gw = await first(await new Browser().join(gImp.data.key));
    check(gImp.status === 201 && gImp.data.skipped === 0 && gw.layers.find((l) => l.id === 'impLAYER1')?.parent === 'impGROUP1' && gw.strokes.length === 1, 'groups: a .bdraw with a group imports, layers listed before their group');
  }

  // --- vector shapes ---------------------------------------------------------------------------
  {
    const sb = new Browser();
    await account(sb, 'shapes@example.com', 'Shape Tester');
    const sc = (await sb.api('POST', '/api/sessions', { name: 'shapes-test' })).data.key;
    const o = await sb.join(sc);
    const w = await first(o);
    const L1 = layerId(w);
    let opn = 300;
    const send = (op) => o.send({ t: 'op', opId: `s${opn++}xxxxx`, op });
    const echo = (pred) => o.next((m) => m.t === 'op' && pred(m.op), 2000);
    const rejected = (n) => o.next((m) => m.t === 'reject' && m.opId === `s${n}xxxxx`, 2000);
    const tryOp = async (op) => {
      const n = opn;
      send(op);
      return o.next((m) => (m.t === 'reject' && m.opId === `s${n}xxxxx`) || (m.t === 'op' && m.opId === `s${n}xxxxx`), 2000);
    };
    const rect = (id, extra = {}) => ({
      id, layerId: 'shapeLAYER1', kind: 'rect', name: 'Rectangle 1', z: 1, w: 100, h: 50, m: [1, 0, 0, 1, 10, 20],
      radii: [4, 4, 4, 4], fill: '#7c3aed', stroke: null, strokeWidth: 2, align: 'inside', cap: 'round', join: 'miter', ...extra,
    });

    send({ type: 'layer.add', layer: { id: 'shapeLAYER1', kind: 'shape', name: 'Shapes 1', order: 2, blend: 'normal', opacity: 1, visible: true } });
    check(!!(await echo((op) => op.type === 'layer.add' && op.layer.kind === 'shape')), 'shapes: add a shape layer');
    send({ type: 'shape.add', shape: rect('shapeRECT01') });
    const added = await echo((op) => op.type === 'shape.add');
    check(added?.op.shape.id === 'shapeRECT01' && added.op.shape.author === w.clientId && added.op.shape.seq === added.seq, 'shapes: add a rectangle (author and seq set)');

    // Checks: where a shape may go, and what makes a valid one.
    let r = await tryOp({ type: 'shape.add', shape: rect('shapeONPAINT', { layerId: L1 }) });
    check(r?.t === 'reject' && /shape layers/.test(r.reason), 'shapes: a paint layer takes no shapes');
    r = await tryOp({ type: 'stroke.add', stroke: { ...strokeOp(L1).op.stroke, layerId: 'shapeLAYER1' } });
    check(r?.t === 'reject' && /not paint/.test(r.reason), 'shapes: a shape layer takes no strokes');
    r = await tryOp({ type: 'shape.add', shape: { ...rect('shapePOLY01'), kind: 'polygon' } });
    check(r?.t === 'reject' && /needs sides/.test(r.reason), 'shapes: a polygon needs its sides');
    r = await tryOp({ type: 'shape.add', shape: { ...rect('shapePOLY02'), kind: 'polygon', sides: 2 } });
    check(r?.t === 'reject', 'shapes: a polygon has at least 3 sides');
    r = await tryOp({ type: 'shape.add', shape: { ...rect('shapeSTAR01'), kind: 'star', points: 5, innerRatio: 0 } });
    check(r?.t === 'reject', 'shapes: a star inner ratio must be above 0');
    r = await tryOp({ type: 'shape.add', shape: rect('shapeCOLOR1', { fill: 'red' }) });
    check(r?.t === 'reject', 'shapes: colors are #rrggbb or null');
    r = await tryOp({ type: 'shape.add', shape: rect('shapeFAR001', { m: [1, 0, 0, 1, 2e15, 0] }) });
    check(r?.t === 'reject', 'shapes: a frame out of range is refused');
    r = await tryOp({ type: 'shape.add', shape: rect('shapeRECT01') });
    check(r?.t === 'reject', 'shapes: a duplicate id is refused');
    r = await tryOp({ type: 'shape.add', shape: { ...rect('shapeLINE01'), kind: 'line', line: [0, 0, 100, 50], fill: '#ff0000', align: 'outside' } });
    check(r?.t === 'op' && r.op.shape.fill === null && r.op.shape.align === 'center' && r.op.shape.radii === undefined, 'shapes: a line has no fill, a center stroke, and no settings of other kinds');

    // Partial updates: the result must still be a valid shape of its kind.
    r = await tryOp({ type: 'shape.update', id: 'shapeRECT01', props: { fill: null, stroke: '#112233', radii: [0, 8, 0, 8], sides: 7 } });
    check(r?.t === 'op', 'shapes: update some props');
    r = await tryOp({ type: 'shape.update', id: 'shapeRECT01', props: { w: -5 } });
    check(r?.t === 'reject', 'shapes: an update that breaks the shape is refused');
    r = await tryOp({ type: 'shape.update', id: 'shapeRECT01', props: {} });
    check(r?.t === 'reject', 'shapes: an empty update is refused');
    let w2 = await first(await sb.join(sc));
    let sh = w2.shapes.find((x) => x.id === 'shapeRECT01');
    check(sh?.fill === null && sh.stroke === '#112233' && sh.radii.join() === '0,8,0,8' && sh.sides === undefined && sh.w === 100, 'shapes: updates persist; settings of other kinds are dropped');
    check(w2.features.includes('shapes'), 'shapes: welcome lists the shapes feature');

    // Remove and restore (undo): the restore carries the whole shape for late joiners.
    send({ type: 'shape.remove', id: 'shapeRECT01' });
    await echo((op) => op.type === 'shape.remove');
    w2 = await first(await sb.join(sc));
    check(!w2.shapes.some((x) => x.id === 'shapeRECT01'), 'shapes: a removed shape is not in the welcome');
    r = await tryOp({ type: 'shape.update', id: 'shapeRECT01', props: { fill: '#000000' } });
    check(r?.t === 'reject', 'shapes: a removed shape takes no updates');
    send({ type: 'shape.restore', id: 'shapeRECT01' });
    const restored = await echo((op) => op.type === 'shape.restore');
    check(restored?.op.shape?.stroke === '#112233', 'shapes: restore brings the shape back, with its body');

    // Layer transform: the shape matrix follows; out of range is refused.
    send({ type: 'layer.transform', id: 'shapeLAYER1', m: [0, 2, -2, 0, 5, 5] });
    await echo((op) => op.type === 'layer.transform');
    w2 = await first(await sb.join(sc));
    sh = w2.shapes.find((x) => x.id === 'shapeRECT01');
    check(sh?.m.join() === '0,2,-2,0,-35,25' && sh.w === 100, 'shapes: a layer transform composes into the shape matrix');
    r = await tryOp({ type: 'layer.transform', id: 'shapeLAYER1', m: [1, 0, 0, 1, 2e15, 0] });
    check(r?.t === 'reject', 'shapes: a layer transform out of range is refused');

    // Duplicate the layer: the shapes are copied with new ids.
    send({ type: 'layer.duplicate', id: 'shapeLAYER1', newId: 'shapeLAYER2', name: 'Copy', order: 3, parent: null });
    await echo((op) => op.type === 'layer.duplicate');
    w2 = await first(await sb.join(sc));
    const copies = w2.shapes.filter((x) => x.layerId === 'shapeLAYER2');
    check(copies.length === 2 && copies.every((c) => !['shapeRECT01', 'shapeLINE01'].includes(c.id)), 'shapes: a layer duplicate copies its shapes');

    // Viewers: no shape ops, no live shapes; they see the live shapes of editors.
    const v = await new Browser().join(sc);
    const vw = await first(v);
    check(vw?.role === 'viewer' && vw.shapes.length === 4, 'shapes: a viewer gets the shapes');
    v.send({ t: 'op', opId: 'vshape1xxx', op: { type: 'shape.add', shape: rect('shapeVIEW01') } });
    check((await v.next((m) => m.t === 'reject' && m.opId === 'vshape1xxx'))?.reason === 'view only', 'shapes: a viewer cannot add shapes');
    v.send({ t: 'shape.live', shapes: [rect('shapeVLIVE1')] });
    o.send({ t: 'shape.live', shapes: [rect('shapeLIVE01', { w: 60 })] });
    const seen = await v.next((m) => m.t === 'shape.live', 2000);
    check(seen?.by === w.clientId && seen.shapes[0].w === 60, 'shapes: live shapes reach other people');
    check(!(await o.next((m) => m.t === 'shape.live', 500)), 'shapes: live shapes from a viewer are dropped');
    o.send({ t: 'shape.live', shapes: [rect('shapeLIVE02', { kind: 'star' })] });
    check(!(await v.next((m) => m.t === 'shape.live' && m.shapes[0]?.id === 'shapeLIVE02', 500)), 'shapes: malformed live shapes are dropped');

    // A .bdraw (version 3) with shapes: the bad one is skipped; a newer version is refused.
    const fileShapes = [
      rect('impSHAPE01', { layerId: 'impSHAPEL1', author: 'someone', seq: 5 }),
      { ...rect('impSHAPE02', { layerId: 'impSHAPEL1' }), kind: 'polygon', sides: 1 },
    ];
    const file = {
      format: 'bdraw', version: 3, app: 'test', savedAt: '',
      layers: [{ id: 'impSHAPEL1', name: 'Shapes', order: 1, blend: 'normal', opacity: 1, visible: true, deleted: false, kind: 'shape' }],
      strokes: [],
      shapes: fileShapes,
    };
    const imp = await sb.upload(Buffer.from(JSON.stringify(file)), {});
    const iw = await first(await new Browser().join(imp.data.key));
    check(imp.status === 201 && imp.data.shapes === 1 && imp.data.skipped === 1 && iw.shapes[0]?.author === 'someone', 'shapes: a .bdraw with shapes imports (author kept, a bad shape skipped)');
    check((await sb.upload(Buffer.from(JSON.stringify({ ...file, version: 4 })), {})).data?.error === 'file_too_new', 'shapes: a newer .bdraw version is refused');
  }

  // --- admins manage every owned canvas like its owner ------------------------------------------
  const adm = (await funky.api('POST', '/api/sessions', { name: 'admin-test' })).data.key;
  await funky.api('POST', `/api/canvases/${adm}/links`, { kind: 'code', role: 'none' });
  check((await first(await new Browser().join(adm)))?.reason === 'login_required', 'admin test: the canvas is private');
  check((await first(await admin.join(adm)))?.role === 'owner', 'an admin joins any canvas as its owner');
  const admShare = await admin.api('GET', `/api/canvases/${adm}/sharing`);
  check(admShare.status === 200 && admShare.data.owner?.name === 'Funky Otter', 'an admin opens sharing, which names the real owner');
  check((await admin.api('POST', `/api/canvases/${adm}/links`, { kind: 'code', role: 'viewer' })).status === 200, 'an admin changes the canvas link');
  const admRen = await admin.api('POST', `/api/canvases/${adm}/rename`, { name: 'admin-renamed' });
  check(admRen.status === 200 && admRen.data.key === 'admin-renamed', 'an admin renames');
  check((await busy.api('GET', '/api/canvases/admin-renamed/sharing')).status === 403, 'a normal account still cannot');
  check((await admin.api('POST', '/api/canvases/admin-renamed/transfer', { email: 'busy@example.com' })).status === 200, 'an admin transfers ownership');
  const afterTransfer = (await busy.api('GET', '/api/canvases/admin-renamed/sharing')).data;
  check(afterTransfer.owner?.name === 'Busy Mongoose' && afterTransfer.members.some((m) => m.name === 'Funky Otter' && m.role === 'editor') && !afterTransfer.members.some((m) => m.email === 'admin@example.com'), 'transfer keeps the old owner (not the admin) as editor');

  // --- email confirmation mode (EMAIL_VERIFICATION=1), on a second server ------------------------
  {
    const port2 = PORT + 501;
    const base2 = `http://127.0.0.1:${port2}`;
    const mail2 = path.join(dir, 'mail2');
    const srv2 = spawn(process.execPath, ['dist/server/index.js'], {
      env: { ...process.env, PORT: String(port2), DB_PATH: path.join(dir, 'verify.db'), DEV_MAIL_DIR: mail2, PUBLIC_URL: base2, NODE_ENV: 'test', EMAIL_VERIFICATION: '1', ...EASY_CAPTCHA },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log2 = '';
    srv2.stdout.on('data', (d) => (log2 += d));
    for (let i = 0; i < 50 && !log2.includes('draw '); i++) await sleep(100);
    try {
      const post = (p, body, cookie) => fetch(base2 + p, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json', 'X-Real-IP': '10.9.9.9', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
      const r = await post('/api/auth/register', { email: 'conf@example.com', name: 'Conf', password: 'correct horse battery', captcha: await solvedCaptcha(base2) });
      const body = await r.json();
      check(r.status === 201 && body.verify === true && !body.user && !r.headers.get('set-cookie'), 'confirmation mode: registering sends a link, no login yet');
      check((await (await post('/api/auth/login', { email: 'conf@example.com', password: 'correct horse battery' })).json()).error === 'unverified', 'confirmation mode: no login before the link');
      const files = fs.readdirSync(mail2).filter((f) => f.includes('conf@example.com'));
      const link = /(http\S+verify\?token=\S+)/.exec(JSON.parse(fs.readFileSync(path.join(mail2, files.at(-1)), 'utf8')).text)[1];
      const v = await fetch(link, { redirect: 'manual' });
      check(v.status === 302 && v.headers.get('location') === '/?verify=ok', 'confirmation mode: the link confirms and logs in');
    } finally {
      srv2.kill();
    }
  }

  const shortLived = (await new Browser().api('POST', '/api/sessions', {})).data.key;
  const watcher = await new Browser().join(shortLived);
  await first(watcher);
  const gone = await watcher.next((m) => m.t === 'denied', 7000);
  check(gone?.reason === 'expired', 'expired temporary canvas: connected people are told');
  check(!(await admin.api('GET', `/api/sessions/${shortLived}`)).data.exists, 'expired temporary canvas is deleted');
  check((await admin.api('GET', `/api/sessions/${temp}`)).data.exists, 'claimed canvas is kept');
  check((await admin.api('GET', '/api/sessions/QWRT-ZXCV')).data.exists, 'legacy canvas is kept');
} catch (e) {
  console.error(e);
  failures++;
} finally {
  server.kill();
  if (failures) console.log(`\nserver log:\n${log}`);
  console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
