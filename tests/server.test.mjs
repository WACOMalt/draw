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

const server = spawn(process.execPath, ['dist/server/index.js'], {
  env: { ...process.env, PORT: String(PORT), DB_PATH: DB, DEV_MAIL_DIR: MAIL, PUBLIC_URL: BASE, ADMIN_EMAILS: 'admin@example.com', TEMP_TTL_MS: '4000', CLEANUP_EVERY_MS: '1000', NODE_ENV: 'test' },
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
async function account(b, email, name) {
  await b.api('POST', '/api/auth/register', { email, name, password: 'correct horse battery' });
  const url = /(http\S+verify\?token=\S+)/.exec(lastMail(email).text)[1];
  const r = await b.api('GET', new URL(url).pathname + new URL(url).search);
  return r;
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
  const verified = await account(funky, 'funky@example.com', 'Funky Otter');
  check(verified.status === 302 && verified.location === '/?verify=ok', 'email verification logs in');
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
  check((await funky.upload(Buffer.from(JSON.stringify({ ...bfile, version: 3 })), {})).data?.error === 'file_too_new', 'a file from a newer version is refused');
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
  await stranger.api('POST', '/api/auth/forgot', { email: 'vee@example.com' });
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
