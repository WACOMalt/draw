import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AppliedOp } from '../shared/types';

export interface OpRow {
  seq: number;
  client_id: string;
  data: string;
}

export type Role = 'owner' | 'editor' | 'viewer';
export type MemberRole = 'editor' | 'viewer';

export interface CanvasRow {
  code: string;
  created_at: number;
  last_active_at: number;
  seq: number;
  /** Account that owns the canvas. NULL: a temporary canvas (or a legacy one, see `legacy`). */
  owner_id: string | null;
  /** sha256 of the anonymous secret of the browser that created it. Only that browser may claim. */
  creator_anon: string | null;
  /** Created before accounts existed: never expires, goes to the admin at first admin login. */
  legacy: number;
  /** What the plain /s/CODE link grants to people without other access: 'editor' or 'none'. */
  code_role: 'editor' | 'none';
  /** Secret tokens for the share links (?k=TOKEN). NULL: link turned off. */
  edit_token: string | null;
  view_token: string | null;
  /** scrypt hash of the join password for link users. NULL: no password. */
  join_password: string | null;
}

export interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string | null;
  email_verified_at: number | null;
  created_at: number;
}

export interface MemberRow {
  user_id: string;
  role: MemberRole;
  email: string;
  name: string;
}

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export class Store {
  private db: Database.Database;

  constructor(file: string) {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  // --- schema ----------------------------------------------------------------------------------

  private migrate(): void {
    const db = this.db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        code TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL,
        seq INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS ops (
        code TEXT NOT NULL,
        seq INTEGER NOT NULL,
        client_id TEXT NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (code, seq)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const version = Number(this.setting('schema') ?? 1);
    if (version < 2) {
      db.transaction(() => {
        // Accounts and access. Canvases that exist now predate accounts: mark them legacy so
        // the cleanup never deletes them; the admin gets them at first login.
        db.exec(`
          ALTER TABLE sessions ADD COLUMN owner_id TEXT;
          ALTER TABLE sessions ADD COLUMN creator_anon TEXT;
          ALTER TABLE sessions ADD COLUMN legacy INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE sessions ADD COLUMN code_role TEXT NOT NULL DEFAULT 'editor';
          ALTER TABLE sessions ADD COLUMN edit_token TEXT;
          ALTER TABLE sessions ADD COLUMN view_token TEXT;
          ALTER TABLE sessions ADD COLUMN join_password TEXT;
          UPDATE sessions SET legacy = 1;
          CREATE INDEX sessions_owner ON sessions (owner_id);
          CREATE INDEX sessions_temp ON sessions (owner_id, legacy, created_at);

          CREATE TABLE users (
            id TEXT PRIMARY KEY,
            email TEXT NOT NULL UNIQUE COLLATE NOCASE,
            name TEXT NOT NULL,
            password_hash TEXT,
            email_verified_at INTEGER,
            created_at INTEGER NOT NULL
          );
          -- Sign-in methods besides email + password (OAuth: authentik, google, github, ...).
          CREATE TABLE identities (
            provider TEXT NOT NULL,
            subject TEXT NOT NULL,
            user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (provider, subject)
          );
          CREATE TABLE auth_sessions (
            token_hash TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
            kind TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            last_seen_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL
          );
          CREATE TABLE email_tokens (
            token_hash TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
            purpose TEXT NOT NULL,
            expires_at INTEGER NOT NULL
          );
          CREATE TABLE device_logins (
            device_hash TEXT PRIMARY KEY,
            user_code TEXT NOT NULL UNIQUE,
            expires_at INTEGER NOT NULL,
            user_id TEXT REFERENCES users (id) ON DELETE CASCADE
          );
          CREATE TABLE members (
            code TEXT NOT NULL REFERENCES sessions (code) ON DELETE CASCADE,
            user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
            role TEXT NOT NULL,
            added_at INTEGER NOT NULL,
            PRIMARY KEY (code, user_id)
          );
          CREATE INDEX members_user ON members (user_id);
        `);
        this.setSetting('schema', '2');
      })();
    }
  }

  setting(key: string): string | undefined {
    return this.db.prepare<[string], { value: string }>('SELECT value FROM settings WHERE key = ?').get(key)?.value;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /** A random server secret, made once and kept in the database (HMAC for join grants). */
  secret(name: string): string {
    let v = this.setting(`secret.${name}`);
    if (!v) {
      v = crypto.randomBytes(32).toString('base64url');
      this.setSetting(`secret.${name}`, v);
    }
    return v;
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // --- canvases --------------------------------------------------------------------------------

  createCanvas(code: string, init: Partial<CanvasRow>): boolean {
    const now = Date.now();
    try {
      this.db
        .prepare(
          `INSERT INTO sessions (code, created_at, last_active_at, seq, owner_id, creator_anon, legacy, code_role, edit_token, view_token)
           VALUES (?, ?, ?, 0, ?, ?, 0, ?, ?, ?)`,
        )
        .run(code, now, now, init.owner_id ?? null, init.creator_anon ?? null, init.code_role ?? 'editor', init.edit_token ?? null, init.view_token ?? null);
      return true;
    } catch (e) {
      if ((e as { code?: string }).code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return false;
      throw e;
    }
  }

  canvas(code: string): CanvasRow | undefined {
    return this.db.prepare<[string], CanvasRow>('SELECT * FROM sessions WHERE code = ?').get(code);
  }

  sessionExists(code: string): boolean {
    return this.canvas(code) !== undefined;
  }

  updateCanvas(code: string, fields: Partial<Pick<CanvasRow, 'owner_id' | 'legacy' | 'code_role' | 'edit_token' | 'view_token' | 'join_password'>>): void {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (!keys.length) return;
    this.db.prepare(`UPDATE sessions SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE code = ?`).run(...keys.map((k) => fields[k] ?? null), code);
  }

  deleteCanvas(code: string): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM ops WHERE code = ?').run(code);
      this.db.prepare('DELETE FROM sessions WHERE code = ?').run(code);
    });
  }

  /** Temporary canvases created before `before`: the cleanup deletes these. */
  expiredTemporary(before: number): string[] {
    return this.db
      .prepare<[number], { code: string }>('SELECT code FROM sessions WHERE owner_id IS NULL AND legacy = 0 AND created_at < ?')
      .all(before)
      .map((r) => r.code);
  }

  /** Gives every legacy canvas to a user (the admin). Returns how many. */
  adoptLegacy(userId: string): number {
    return this.db.prepare("UPDATE sessions SET owner_id = ?, legacy = 0 WHERE legacy = 1 AND owner_id IS NULL").run(userId).changes;
  }

  canvasesOwnedBy(userId: string): CanvasRow[] {
    return this.db.prepare<[string], CanvasRow>('SELECT * FROM sessions WHERE owner_id = ? ORDER BY last_active_at DESC').all(userId);
  }

  canvasesSharedWith(userId: string): (CanvasRow & { role: MemberRole })[] {
    return this.db
      .prepare<[string], CanvasRow & { role: MemberRole }>(
        'SELECT s.*, m.role AS role FROM members m JOIN sessions s ON s.code = m.code WHERE m.user_id = ? ORDER BY s.last_active_at DESC',
      )
      .all(userId);
  }

  // --- members ---------------------------------------------------------------------------------

  members(code: string): MemberRow[] {
    return this.db
      .prepare<[string], MemberRow>(
        'SELECT m.user_id, m.role, u.email, u.name FROM members m JOIN users u ON u.id = m.user_id WHERE m.code = ? ORDER BY m.added_at',
      )
      .all(code);
  }

  memberRole(code: string, userId: string): MemberRole | undefined {
    return this.db.prepare<[string, string], { role: MemberRole }>('SELECT role FROM members WHERE code = ? AND user_id = ?').get(code, userId)?.role;
  }

  setMember(code: string, userId: string, role: MemberRole): void {
    this.db
      .prepare('INSERT INTO members (code, user_id, role, added_at) VALUES (?, ?, ?, ?) ON CONFLICT (code, user_id) DO UPDATE SET role = excluded.role')
      .run(code, userId, role, Date.now());
  }

  removeMember(code: string, userId: string): void {
    this.db.prepare('DELETE FROM members WHERE code = ? AND user_id = ?').run(code, userId);
  }

  // --- ops -------------------------------------------------------------------------------------

  appendOp(code: string, seq: number, clientId: string, op: AppliedOp): void {
    const now = Date.now();
    this.db.prepare('INSERT INTO ops (code, seq, client_id, type, data, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(code, seq, clientId, op.type, JSON.stringify(op), now);
    this.db.prepare('UPDATE sessions SET seq = ?, last_active_at = ? WHERE code = ?').run(seq, now, code);
  }

  loadOps(code: string): OpRow[] {
    return this.db.prepare<[string], OpRow>('SELECT seq, client_id, data FROM ops WHERE code = ? ORDER BY seq').all(code);
  }

  // --- users -----------------------------------------------------------------------------------

  userById(id: string): UserRow | undefined {
    return this.db.prepare<[string], UserRow>('SELECT * FROM users WHERE id = ?').get(id);
  }

  userByEmail(email: string): UserRow | undefined {
    return this.db.prepare<[string], UserRow>('SELECT * FROM users WHERE email = ?').get(email);
  }

  createUser(u: Pick<UserRow, 'id' | 'email' | 'name' | 'password_hash'>): void {
    this.db.prepare('INSERT INTO users (id, email, name, password_hash, email_verified_at, created_at) VALUES (?, ?, ?, ?, NULL, ?)').run(u.id, u.email, u.name, u.password_hash, Date.now());
  }

  updateUser(id: string, fields: Partial<Pick<UserRow, 'name' | 'password_hash' | 'email_verified_at'>>): void {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (!keys.length) return;
    this.db.prepare(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k] ?? null), id);
  }

  /** Accounts never verified within `maxAge`: removed so the email can register again. */
  purgeUnverified(before: number): number {
    return this.db.prepare('DELETE FROM users WHERE email_verified_at IS NULL AND created_at < ?').run(before).changes;
  }

  // --- auth sessions, email tokens, device logins ----------------------------------------------

  createAuthSession(tokenHash: string, userId: string, kind: 'cookie' | 'bearer', ttlMs: number): void {
    const now = Date.now();
    this.db.prepare('INSERT INTO auth_sessions (token_hash, user_id, kind, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run(tokenHash, userId, kind, now, now, now + ttlMs);
  }

  /** The user of a live auth session; slides the expiry forward (at most once a minute). */
  authSession(tokenHash: string, ttlMs: number): UserRow | undefined {
    const row = this.db
      .prepare<[string, number], { user_id: string; last_seen_at: number }>('SELECT user_id, last_seen_at FROM auth_sessions WHERE token_hash = ? AND expires_at > ?')
      .get(tokenHash, Date.now());
    if (!row) return undefined;
    const now = Date.now();
    if (now - row.last_seen_at > 60_000) {
      this.db.prepare('UPDATE auth_sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?').run(now, now + ttlMs, tokenHash);
    }
    return this.userById(row.user_id);
  }

  deleteAuthSession(tokenHash: string): void {
    this.db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(tokenHash);
  }

  deleteAuthSessionsOf(userId: string): void {
    this.db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(userId);
  }

  createEmailToken(tokenHash: string, userId: string, purpose: 'verify' | 'reset', ttlMs: number): void {
    this.db.prepare('DELETE FROM email_tokens WHERE user_id = ? AND purpose = ?').run(userId, purpose);
    this.db.prepare('INSERT INTO email_tokens (token_hash, user_id, purpose, expires_at) VALUES (?, ?, ?, ?)').run(tokenHash, userId, purpose, Date.now() + ttlMs);
  }

  /** Uses up an email token. Returns its user id, or undefined if unknown, used or expired. */
  takeEmailToken(tokenHash: string, purpose: 'verify' | 'reset'): string | undefined {
    return this.transaction(() => {
      const row = this.db
        .prepare<[string, string, number], { user_id: string }>('SELECT user_id FROM email_tokens WHERE token_hash = ? AND purpose = ? AND expires_at > ?')
        .get(tokenHash, purpose, Date.now());
      this.db.prepare('DELETE FROM email_tokens WHERE token_hash = ?').run(tokenHash);
      return row?.user_id;
    });
  }

  createDeviceLogin(deviceHash: string, userCode: string, ttlMs: number): void {
    this.db.prepare('INSERT INTO device_logins (device_hash, user_code, expires_at, user_id) VALUES (?, ?, ?, NULL)').run(deviceHash, userCode, Date.now() + ttlMs);
  }

  approveDeviceLogin(userCode: string, userId: string): boolean {
    return this.db.prepare('UPDATE device_logins SET user_id = ? WHERE user_code = ? AND expires_at > ? AND user_id IS NULL').run(userId, userCode, Date.now()).changes > 0;
  }

  deviceLogin(deviceHash: string): { user_id: string | null; expires_at: number } | undefined {
    return this.db.prepare<[string], { user_id: string | null; expires_at: number }>('SELECT user_id, expires_at FROM device_logins WHERE device_hash = ?').get(deviceHash);
  }

  deleteDeviceLogin(deviceHash: string): void {
    this.db.prepare('DELETE FROM device_logins WHERE device_hash = ?').run(deviceHash);
  }

  /** Drops expired auth sessions, email tokens and device logins. */
  purgeExpiredAuth(): void {
    const now = Date.now();
    this.db.prepare('DELETE FROM auth_sessions WHERE expires_at < ?').run(now);
    this.db.prepare('DELETE FROM email_tokens WHERE expires_at < ?').run(now);
    this.db.prepare('DELETE FROM device_logins WHERE expires_at < ?').run(now);
  }

  checkpoint(): void {
    this.db.pragma('wal_checkpoint(TRUNCATE)');
  }

  close(): void {
    this.db.close();
  }
}
