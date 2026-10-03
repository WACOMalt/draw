// REST API: accounts, canvases, sharing.
//
// Security notes
// - State-changing requests need a JSON body (forces a CORS preflight for other sites) and, when
//   the browser sends an Origin, an allowed one. The session cookie is SameSite=Lax as well.
// - Account lookups never reveal whether an email is registered (register, forgot, resend).

import crypto from 'node:crypto';
import http from 'node:http';
import { newId, newSessionCode } from '../shared/ids';
import { normalizeName, parseKey, candidateKeys } from '../shared/types';
import { canClaim, isTemporary, TEMP_TTL_MS } from './access';
import {
  clearSessionCookie,
  hashPassword,
  Limiter,
  newToken,
  normalizeEmail,
  requestToken,
  SESSION_TTL_MS,
  sessionCookie,
  userFromToken,
  verifyPassword,
} from './auth';
import { sha256, type CanvasRow, type MemberRole, type Store, type UserRow } from './db';
import { actionMail, type Mailer } from './mailer';

export interface ApiContext {
  store: Store;
  mailer: Mailer;
  publicUrl: string; // https://draw.bsums.xyz
  adminEmails: Set<string>;
  allowedOrigins: Set<string>;
  /** Re-checks connected clients of a canvas after a change (claim, sharing, delete). */
  refreshCanvas(code: string): void;
}

type Handler = (ctx: ApiContext, req: Req) => Promise<Res>;
interface Req {
  raw: http.IncomingMessage;
  url: URL;
  ip: string;
  body: Record<string, unknown>;
  user: UserRow | undefined;
  token: string | undefined;
  params: string[];
}
interface Res {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

const ok = (body: unknown = { ok: true }, status = 200): Res => ({ status, body });
const err = (status: number, error: string, extra: Record<string, unknown> = {}): Res => ({ status, body: { error, ...extra } });

const VERIFY_TTL = 48 * 3600 * 1000;
const RESET_TTL = 2 * 3600 * 1000;
const DEVICE_TTL = 10 * 60 * 1000;
const MIN_PASSWORD = 8;
/** Compared against when the email is unknown, so login takes the same time either way. */
const dummyHash = hashPassword(crypto.randomUUID());

const limits = {
  register: new Limiter(5, 3600_000),
  login: new Limiter(10, 15 * 60_000),
  mail: new Limiter(3, 3600_000), // per email address: verify/reset/resend
  create: new Limiter(10, 60_000),
  device: new Limiter(10, 15 * 60_000),
  share: new Limiter(60, 60_000),
};

function publicUser(u: UserRow, admins: Set<string>) {
  return { id: u.id, email: u.email, name: u.name, admin: admins.has(u.email) };
}

function str(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max ? v.trim() : null;
}

function secureCookie(ctx: ApiContext): boolean {
  return ctx.publicUrl.startsWith('https://');
}

async function startSession(ctx: ApiContext, user: UserRow, kind: 'cookie' | 'bearer'): Promise<{ token: string; cookie?: string }> {
  const { token, hash } = newToken();
  ctx.store.createAuthSession(hash, user.id, kind, SESSION_TTL_MS);
  // First login of an admin account: the canvases from before accounts become theirs.
  if (ctx.adminEmails.has(user.email)) {
    const n = ctx.store.adoptLegacy(user.id);
    if (n) console.log(`accounts: ${n} legacy canvases assigned to ${user.email}`);
  }
  return { token, cookie: kind === 'cookie' ? sessionCookie(token, secureCookie(ctx)) : undefined };
}

async function sendVerify(ctx: ApiContext, user: UserRow): Promise<void> {
  const { token, hash } = newToken();
  ctx.store.createEmailToken(hash, user.id, 'verify', VERIFY_TTL);
  const url = `${ctx.publicUrl}/api/auth/verify?token=${token}`;
  await ctx.mailer.send(
    actionMail(user.email, 'Confirm your Draw account', `Hi ${user.name}, confirm your email to finish creating your Draw account.`, 'Confirm email', url, 'The link works for 48 hours. If you did not sign up, ignore this email.'),
  );
}

// --- auth handlers -------------------------------------------------------------------------------

/** In production without SMTP nobody could confirm an account: say so instead of pretending. */
function mailDown(ctx: ApiContext): boolean {
  return ctx.mailer.mode === 'dev' && process.env.NODE_ENV === 'production';
}

const register: Handler = async (ctx, req) => {
  if (mailDown(ctx)) return err(503, 'mail_unavailable');
  if (!limits.register.allow(req.ip)) return err(429, 'rate_limited');
  const email = normalizeEmail(req.body.email);
  const name = str(req.body.name, 40);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!email) return err(400, 'bad_email');
  if (!name) return err(400, 'bad_name');
  if (password.length < MIN_PASSWORD || password.length > 200) return err(400, 'bad_password', { min: MIN_PASSWORD });

  const existing = ctx.store.userByEmail(email);
  if (existing?.email_verified_at) {
    // Do not reveal that the account exists. Tell its owner instead.
    if (limits.mail.allow(email)) {
      await ctx.mailer.send(
        actionMail(email, 'Your Draw account', 'Someone tried to create a Draw account with this email, but you already have one.', 'Reset password', `${ctx.publicUrl}/?forgot=1`, 'If this was you and you forgot your password, use the button. Otherwise ignore this email.'),
      );
    }
    return ok({ ok: true, verify: true });
  }
  if (existing) {
    // Unverified: update the details and send a fresh link.
    ctx.store.updateUser(existing.id, { name, password_hash: await hashPassword(password) });
    if (limits.mail.allow(email)) await sendVerify(ctx, ctx.store.userById(existing.id)!);
    return ok({ ok: true, verify: true });
  }
  const user = { id: newId(), email, name, password_hash: await hashPassword(password) };
  ctx.store.createUser(user);
  limits.mail.allow(email);
  await sendVerify(ctx, ctx.store.userById(user.id)!);
  return ok({ ok: true, verify: true }, 201);
};

const verify: Handler = async (ctx, req) => {
  const token = req.url.searchParams.get('token') ?? '';
  const userId = token ? ctx.store.takeEmailToken(sha256(token), 'verify') : undefined;
  if (!userId) return { status: 302, headers: { Location: '/?verify=failed' } } as Res;
  ctx.store.updateUser(userId, { email_verified_at: Date.now() });
  const user = ctx.store.userById(userId)!;
  const { cookie } = await startSession(ctx, user, 'cookie');
  return { status: 302, headers: { Location: '/?verify=ok', 'Set-Cookie': cookie! } };
};

const resend: Handler = async (ctx, req) => {
  const email = normalizeEmail(req.body.email);
  const user = email ? ctx.store.userByEmail(email) : undefined;
  if (user && !user.email_verified_at && limits.mail.allow(user.email)) await sendVerify(ctx, user);
  return ok();
};

const login: Handler = async (ctx, req) => {
  const email = normalizeEmail(req.body.email);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!email || !password) return err(400, 'bad_login');
  if (!limits.login.allow(`${req.ip}|${email}`) || !limits.login.allow(req.ip)) return err(429, 'rate_limited');
  const user = ctx.store.userByEmail(email);
  // Always run scrypt, so response time does not tell whether the account exists.
  const good = await verifyPassword(password, user?.password_hash ?? (await dummyHash));
  if (!user || !good) return err(401, 'bad_login');
  if (!user.email_verified_at) return err(403, 'unverified');
  const kind = req.body.client === 'desktop' ? 'bearer' : 'cookie';
  const { token, cookie } = await startSession(ctx, user, kind);
  return { status: 200, body: { user: publicUser(user, ctx.adminEmails), token: kind === 'bearer' ? token : undefined }, headers: cookie ? { 'Set-Cookie': cookie } : undefined };
};

const logout: Handler = async (ctx, req) => {
  if (req.token) ctx.store.deleteAuthSession(sha256(req.token));
  return { status: 200, body: { ok: true }, headers: { 'Set-Cookie': clearSessionCookie(secureCookie(ctx)) } };
};

const me: Handler = async (ctx, req) => ok({ user: req.user ? publicUser(req.user, ctx.adminEmails) : null });

const forgot: Handler = async (ctx, req) => {
  if (mailDown(ctx)) return err(503, 'mail_unavailable');
  const email = normalizeEmail(req.body.email);
  const user = email ? ctx.store.userByEmail(email) : undefined;
  if (user && limits.mail.allow(user.email)) {
    const { token, hash } = newToken();
    ctx.store.createEmailToken(hash, user.id, 'reset', RESET_TTL);
    await ctx.mailer.send(
      actionMail(user.email, 'Reset your Draw password', 'Use the button to choose a new password for your Draw account.', 'Choose a new password', `${ctx.publicUrl}/?reset=${token}`, 'The link works for 2 hours and only once. If you did not ask for this, ignore this email.'),
    );
  }
  return ok();
};

const reset: Handler = async (ctx, req) => {
  const token = typeof req.body.token === 'string' ? req.body.token : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (password.length < MIN_PASSWORD || password.length > 200) return err(400, 'bad_password', { min: MIN_PASSWORD });
  const userId = token ? ctx.store.takeEmailToken(sha256(token), 'reset') : undefined;
  if (!userId) return err(400, 'bad_token');
  // A reset proves control of the email, so it also verifies the account.
  ctx.store.updateUser(userId, { password_hash: await hashPassword(password), email_verified_at: ctx.store.userById(userId)!.email_verified_at ?? Date.now() });
  ctx.store.deleteAuthSessionsOf(userId); // log out everywhere
  const user = ctx.store.userById(userId)!;
  const { cookie } = await startSession(ctx, user, 'cookie');
  return { status: 200, body: { user: publicUser(user, ctx.adminEmails) }, headers: { 'Set-Cookie': cookie! } };
};

// Desktop app login: the app shows a code and opens the browser; the logged-in browser approves.
const deviceStart: Handler = async (ctx, req) => {
  if (!limits.device.allow(req.ip)) return err(429, 'rate_limited');
  const { token: device, hash } = newToken();
  const userCode = newSessionCode(); // XXXX-XXXX, easy to compare by eye
  ctx.store.createDeviceLogin(hash, userCode, DEVICE_TTL);
  return ok({ device, code: userCode, url: `${ctx.publicUrl}/?device=${userCode}`, interval: 2, expiresIn: DEVICE_TTL / 1000 });
};

const deviceApprove: Handler = async (ctx, req) => {
  if (!req.user) return err(401, 'login_required');
  const code = typeof req.body.code === 'string' ? req.body.code.toUpperCase() : '';
  return ctx.store.approveDeviceLogin(code, req.user.id) ? ok() : err(404, 'bad_code');
};

const devicePoll: Handler = async (ctx, req) => {
  const device = typeof req.body.device === 'string' ? req.body.device : '';
  const hash = sha256(device);
  const row = device ? ctx.store.deviceLogin(hash) : undefined;
  if (!row || row.expires_at < Date.now()) return ok({ status: 'expired' });
  if (!row.user_id) return ok({ status: 'pending' });
  ctx.store.deleteDeviceLogin(hash);
  const user = ctx.store.userById(row.user_id)!;
  const { token } = await startSession(ctx, user, 'bearer');
  return ok({ status: 'approved', token, user: publicUser(user, ctx.adminEmails) });
};

// --- canvases --------------------------------------------------------------------------------

function canvasSummary(ctx: ApiContext, c: CanvasRow, role: string) {
  return { key: c.code, role, createdAt: c.created_at, lastActiveAt: c.last_active_at, owner: c.owner_id ? ctx.store.userById(c.owner_id)?.name ?? null : null };
}

const createCanvas: Handler = async (ctx, req) => {
  if (!limits.create.allow(req.ip)) return err(429, 'rate_limited');
  const anon = typeof req.body.anon === 'string' && req.body.anon.length <= 100 ? req.body.anon : null;
  const owned = !!req.user;
  // Accounts get fresh link tokens. A temporary canvas is open to anyone with its code.
  const init: Partial<CanvasRow> = owned
    ? { owner_id: req.user!.id, code_role: 'none', edit_token: newToken().token, view_token: newToken().token }
    : { creator_anon: anon ? sha256(anon) : null, code_role: 'editor' };

  if (typeof req.body.name === 'string' && req.body.name.trim()) {
    if (!owned) return err(401, 'login_required');
    const name = normalizeName(req.body.name);
    if (!name) return err(400, 'bad_name');
    if (!ctx.store.createCanvas(name, init)) return err(409, 'name_taken', { key: name });
    return ok({ key: name, link: init.edit_token }, 201);
  }
  for (let i = 0; i < 5; i++) {
    const code = newSessionCode();
    if (ctx.store.createCanvas(code, init)) return ok({ key: code, link: init.edit_token ?? null }, 201);
  }
  return err(500, 'code_collision');
};

/** Resolves what someone typed (a code with or without the dash, or a name). */
const resolveCanvas: Handler = async (ctx, req) => {
  const key = candidateKeys(req.params[0]).find((k) => ctx.store.sessionExists(k)) ?? null;
  return ok({ exists: key !== null, key });
};

const myCanvases: Handler = async (ctx, req) => {
  if (!req.user) return err(401, 'login_required');
  return ok({
    owned: ctx.store.canvasesOwnedBy(req.user.id).map((c) => canvasSummary(ctx, c, 'owner')),
    shared: ctx.store.canvasesSharedWith(req.user.id).map((c) => canvasSummary(ctx, c, c.role)),
  });
};

function ownedCanvas(ctx: ApiContext, req: Req): { c: CanvasRow } | { res: Res } {
  if (!req.user) return { res: err(401, 'login_required') };
  const key = parseKey(req.params[0]);
  const c = key ? ctx.store.canvas(key) : undefined;
  if (!c) return { res: err(404, 'not_found') };
  if (c.owner_id !== req.user.id) return { res: err(403, 'not_owner') };
  if (!limits.share.allow(req.user.id)) return { res: err(429, 'rate_limited') };
  return { c };
}

function sharing(ctx: ApiContext, c: CanvasRow) {
  const base = `${ctx.publicUrl}/s/${c.code}`;
  return {
    key: c.code,
    members: ctx.store.members(c.code).map((m) => ({ id: m.user_id, email: m.email, name: m.name, role: m.role })),
    // The plain code link counts as the edit link while code_role is 'editor' (claimed canvases).
    editLink: c.edit_token ? `${base}?k=${c.edit_token}` : c.code_role === 'editor' ? base : null,
    viewLink: c.view_token ? `${base}?k=${c.view_token}` : null,
    password: !!c.join_password,
  };
}

const getSharing: Handler = async (ctx, req) => {
  const r = ownedCanvas(ctx, req);
  return 'res' in r ? r.res : ok(sharing(ctx, r.c));
};

const claim: Handler = async (ctx, req) => {
  if (!req.user) return err(401, 'login_required');
  const key = parseKey(req.params[0]);
  const c = key ? ctx.store.canvas(key) : undefined;
  if (!c) return err(404, 'not_found');
  const anon = typeof req.body.anon === 'string' ? req.body.anon : '';
  if (!isTemporary(c) || !canClaim(c, anon ? sha256(anon) : undefined)) return err(403, 'cannot_claim');
  // Keep the plain code working as the edit link, so people already drawing stay in.
  ctx.store.updateCanvas(c.code, { owner_id: req.user.id, code_role: 'editor', view_token: newToken().token });
  ctx.refreshCanvas(c.code);
  return ok({ key: c.code });
};

const addMember: Handler = async (ctx, req) => {
  const r = ownedCanvas(ctx, req);
  if ('res' in r) return r.res;
  const email = normalizeEmail(req.body.email);
  const role = req.body.role === 'viewer' ? 'viewer' : req.body.role === 'editor' ? 'editor' : null;
  if (!email || !role) return err(400, 'bad_request');
  const user = ctx.store.userByEmail(email);
  if (!user?.email_verified_at) return err(404, 'no_such_user');
  if (user.id === r.c.owner_id) return err(400, 'is_owner');
  ctx.store.setMember(r.c.code, user.id, role);
  ctx.refreshCanvas(r.c.code);
  return ok(sharing(ctx, ctx.store.canvas(r.c.code)!));
};

const updateMember: Handler = async (ctx, req) => {
  const r = ownedCanvas(ctx, req);
  if ('res' in r) return r.res;
  const userId = req.params[1];
  if (req.raw.method === 'DELETE') ctx.store.removeMember(r.c.code, userId);
  else {
    const role: MemberRole | null = req.body.role === 'viewer' ? 'viewer' : req.body.role === 'editor' ? 'editor' : null;
    if (!role || !ctx.store.memberRole(r.c.code, userId)) return err(400, 'bad_request');
    ctx.store.setMember(r.c.code, userId, role);
  }
  ctx.refreshCanvas(r.c.code);
  return ok(sharing(ctx, ctx.store.canvas(r.c.code)!));
};

const updateLink: Handler = async (ctx, req) => {
  const r = ownedCanvas(ctx, req);
  if ('res' in r) return r.res;
  const kind = req.body.kind === 'edit' ? 'edit' : req.body.kind === 'view' ? 'view' : null;
  const action = req.body.action;
  if (!kind || !['enable', 'disable', 'reset'].includes(action as string)) return err(400, 'bad_request');
  const field = kind === 'edit' ? 'edit_token' : 'view_token';
  // Any change to the edit link retires the plain code link.
  const extra = kind === 'edit' ? { code_role: 'none' as const } : {};
  if (action === 'disable') ctx.store.updateCanvas(r.c.code, { [field]: null, ...extra });
  else if (action === 'reset' || !r.c[field]) ctx.store.updateCanvas(r.c.code, { [field]: newToken().token, ...extra });
  ctx.refreshCanvas(r.c.code);
  return ok(sharing(ctx, ctx.store.canvas(r.c.code)!));
};

const setPassword: Handler = async (ctx, req) => {
  const r = ownedCanvas(ctx, req);
  if ('res' in r) return r.res;
  const pw = req.body.password;
  if (pw === null) ctx.store.updateCanvas(r.c.code, { join_password: null });
  else if (typeof pw === 'string' && pw.length >= 4 && pw.length <= 200) ctx.store.updateCanvas(r.c.code, { join_password: await hashPassword(pw) });
  else return err(400, 'bad_password', { min: 4 });
  ctx.refreshCanvas(r.c.code);
  return ok(sharing(ctx, ctx.store.canvas(r.c.code)!));
};

const transfer: Handler = async (ctx, req) => {
  const r = ownedCanvas(ctx, req);
  if ('res' in r) return r.res;
  const email = normalizeEmail(req.body.email);
  const user = email ? ctx.store.userByEmail(email) : undefined;
  if (!user?.email_verified_at) return err(404, 'no_such_user');
  if (user.id === r.c.owner_id) return err(400, 'is_owner');
  ctx.store.transaction(() => {
    ctx.store.removeMember(r.c.code, user.id);
    ctx.store.updateCanvas(r.c.code, { owner_id: user.id });
    ctx.store.setMember(r.c.code, req.user!.id, 'editor'); // the old owner keeps edit access
  });
  ctx.refreshCanvas(r.c.code);
  return ok();
};

const deleteCanvas: Handler = async (ctx, req) => {
  const r = ownedCanvas(ctx, req);
  if ('res' in r) return r.res;
  ctx.store.deleteCanvas(r.c.code);
  ctx.refreshCanvas(r.c.code); // tells connected people it is gone
  return ok();
};

// --- routing -------------------------------------------------------------------------------------

const ROUTES: [string, RegExp, Handler][] = [
  ['POST', /^\/api\/auth\/register$/, register],
  ['GET', /^\/api\/auth\/verify$/, verify],
  ['POST', /^\/api\/auth\/resend$/, resend],
  ['POST', /^\/api\/auth\/login$/, login],
  ['POST', /^\/api\/auth\/logout$/, logout],
  ['GET', /^\/api\/auth\/me$/, me],
  ['POST', /^\/api\/auth\/forgot$/, forgot],
  ['POST', /^\/api\/auth\/reset$/, reset],
  ['POST', /^\/api\/auth\/device\/start$/, deviceStart],
  ['POST', /^\/api\/auth\/device\/approve$/, deviceApprove],
  ['POST', /^\/api\/auth\/device\/poll$/, devicePoll],
  ['POST', /^\/api\/sessions$/, createCanvas],
  ['GET', /^\/api\/sessions\/([^/]+)$/, resolveCanvas],
  ['GET', /^\/api\/canvases$/, myCanvases],
  ['GET', /^\/api\/canvases\/([^/]+)\/sharing$/, getSharing],
  ['POST', /^\/api\/canvases\/([^/]+)\/claim$/, claim],
  ['POST', /^\/api\/canvases\/([^/]+)\/members$/, addMember],
  ['PATCH', /^\/api\/canvases\/([^/]+)\/members\/([A-Za-z0-9_-]+)$/, updateMember],
  ['DELETE', /^\/api\/canvases\/([^/]+)\/members\/([A-Za-z0-9_-]+)$/, updateMember],
  ['POST', /^\/api\/canvases\/([^/]+)\/links$/, updateLink],
  ['POST', /^\/api\/canvases\/([^/]+)\/password$/, setPassword],
  ['POST', /^\/api\/canvases\/([^/]+)\/transfer$/, transfer],
  ['DELETE', /^\/api\/canvases\/([^/]+)$/, deleteCanvas],
];

function readBody(req: http.IncomingMessage, limit = 4096): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        resolve(null);
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString();
        const v = raw ? JSON.parse(raw) : {};
        resolve(typeof v === 'object' && v !== null && !Array.isArray(v) ? v : null);
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

/** Handles /api/*. Returns false when no route matched. */
export async function handleApi(ctx: ApiContext, raw: http.IncomingMessage, res: http.ServerResponse, url: URL, ip: string): Promise<boolean> {
  const method = raw.method ?? 'GET';
  let params: string[] = [];
  const route = ROUTES.find(([m, re]) => {
    if (m !== method) return false;
    const match = re.exec(url.pathname);
    if (!match) return false;
    try {
      params = match.slice(1).map(decodeURIComponent);
    } catch {
      return false;
    }
    return true;
  });
  if (!route) return false;

  const send = (r: Res) => {
    res.writeHead(r.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...r.headers });
    res.end(r.body === undefined ? '' : JSON.stringify(r.body));
  };

  let body: Record<string, unknown> = {};
  if (method !== 'GET') {
    // CSRF: other sites cannot send JSON without a preflight, and the Origin must be ours.
    const origin = raw.headers.origin;
    if (origin && origin !== new URL(ctx.publicUrl).origin && !ctx.allowedOrigins.has(origin)) {
      send(err(403, 'bad_origin'));
      return true;
    }
    if (method !== 'DELETE' && !String(raw.headers['content-type'] ?? '').startsWith('application/json')) {
      send(err(415, 'json_required'));
      return true;
    }
    const parsed = method === 'DELETE' ? {} : await readBody(raw);
    if (!parsed) {
      send(err(400, 'bad_json'));
      return true;
    }
    body = parsed;
  }

  const token = requestToken(raw);
  const req: Req = { raw, url, ip, body, user: userFromToken(ctx.store, token), token, params };
  try {
    send(await route[2](ctx, req));
  } catch (e) {
    console.error(`api ${method} ${url.pathname}`, e);
    if (!res.headersSent) send(err(500, 'internal'));
  }
  return true;
}

export { TEMP_TTL_MS };
