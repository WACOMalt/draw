// Passwords, tokens and request authentication.
//
// - Account and join passwords: scrypt with a random salt (memory-hard, slow by design).
// - Session, email and device tokens: 256 random bits. The database keeps only their sha256:
//   a fast hash is right for high-entropy random tokens (no dictionary to guess from), and a
//   database leak does not give working tokens.

import crypto from 'node:crypto';
import type http from 'node:http';
import { promisify } from 'node:util';
import { sha256, type Store, type UserRow } from './db';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number, opts: crypto.ScryptOptions) => Promise<Buffer>;
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export const SESSION_COOKIE = 'draw_session';
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [kind, n, r, p, salt, key] = stored.split('$');
  if (kind !== 'scrypt') return false;
  const want = Buffer.from(key, 'base64url');
  const got = await scrypt(password, Buffer.from(salt, 'base64url'), want.length, { N: +n, r: +r, p: +p, maxmem: SCRYPT.maxmem });
  return crypto.timingSafeEqual(got, want);
}

/** A fresh random token and the hash the database stores for it. */
export function newToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, hash: sha256(token) };
}

export function readCookie(req: http.IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

export function sessionCookie(token: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${secure ? '; Secure' : ''}`;
}

export function clearSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

/** The session token of a request: the web app's cookie, or the desktop app's bearer token. */
export function requestToken(req: http.IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
  return readCookie(req, SESSION_COOKIE);
}

export function userFromToken(store: Store, token: string | undefined): UserRow | undefined {
  if (!token || token.length > 100) return undefined;
  const user = store.authSession(sha256(token), SESSION_TTL_MS);
  return user?.email_verified_at ? user : undefined;
}

export const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

export function normalizeEmail(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const e = v.trim().toLowerCase();
  return e.length <= 254 && EMAIL_RE.test(e) ? e : null;
}

/** Fixed-window counter per key: allow(key) is false after `max` hits in `windowMs`. */
export class Limiter {
  private hits = new Map<string, number[]>();
  constructor(private max: number, private windowMs: number) {
    setInterval(() => this.sweep(), windowMs).unref();
  }
  allow(key: string): boolean {
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
  private sweep(): void {
    const now = Date.now();
    for (const [k, ts] of this.hits) if (ts.every((t) => now - t >= this.windowMs)) this.hits.delete(k);
  }
}
