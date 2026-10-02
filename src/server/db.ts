import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { AppliedOp } from '../shared/types';

export interface OpRow {
  seq: number;
  client_id: string;
  data: string;
}

export class Store {
  private db: Database.Database;
  private stmts;

  constructor(file: string) {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(`
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
    `);
    this.stmts = {
      createSession: this.db.prepare(
        'INSERT INTO sessions (code, created_at, last_active_at, seq) VALUES (?, ?, ?, 0)',
      ),
      getSession: this.db.prepare<[string], { code: string; seq: number }>(
        'SELECT code, seq FROM sessions WHERE code = ?',
      ),
      insertOp: this.db.prepare(
        'INSERT INTO ops (code, seq, client_id, type, data, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ),
      touch: this.db.prepare('UPDATE sessions SET seq = ?, last_active_at = ? WHERE code = ?'),
      loadOps: this.db.prepare<[string], OpRow>(
        'SELECT seq, client_id, data FROM ops WHERE code = ? ORDER BY seq',
      ),
    };
  }

  createSession(code: string): boolean {
    const now = Date.now();
    try {
      this.stmts.createSession.run(code, now, now);
      return true;
    } catch (e) {
      if ((e as { code?: string }).code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return false;
      throw e;
    }
  }

  sessionExists(code: string): boolean {
    return this.stmts.getSession.get(code) !== undefined;
  }

  appendOp(code: string, seq: number, clientId: string, op: AppliedOp): void {
    const now = Date.now();
    this.stmts.insertOp.run(code, seq, clientId, op.type, JSON.stringify(op), now);
    this.stmts.touch.run(seq, now, code);
  }

  loadOps(code: string): OpRow[] {
    return this.stmts.loadOps.all(code);
  }

  close(): void {
    this.db.close();
  }
}
