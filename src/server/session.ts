import type { WebSocket } from 'ws';
import { newId } from '../shared/ids';
import {
  LIMITS,
  type AppliedOp,
  type ClientMsg,
  type Layer,
  type Op,
  type Peer,
  type ServerMsg,
  type Stroke,
} from '../shared/types';
import {
  ValidationError,
  validateBrush,
  validateColor,
  validateId,
  validateNumber,
  validateOp,
  validatePoints,
  validateString,
} from '../shared/validate';
import { docFeatures } from '../shared/features';
import { atLeast, canClaim, isTemporary, recheckAccess, resolveAccess, TEMP_TTL_MS, type AccessInput } from './access';
import { userFromToken } from './auth';
import { sha256, type CanvasRow, type Store, type UserRow } from './db';
import type { CanvasInfo, DeniedReason, Role } from '../shared/types';

class Bucket {
  private tokens: number;
  private last = Date.now();
  constructor(private burst: number, private perSec: number) {
    this.tokens = burst;
  }
  take(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.perSec);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export interface Client {
  id: string;
  ws: WebSocket;
  peer: Peer | null; // null until a hello is accepted
  /** Access inputs from the upgrade request and the hello; kept for re-checks. */
  access: AccessInput;
  role: Role | null;
  joining: boolean;
  passwordTries: number;
  ops: Bucket;
  live: Bucket;
  cursor: Bucket;
}

export function newClient(ws: WebSocket, user: UserRow | undefined): Client {
  return {
    id: newId(),
    ws,
    peer: null,
    access: { user },
    role: null,
    joining: false,
    passwordTries: 0,
    ops: new Bucket(200, 60),
    live: new Bucket(120, 60),
    cursor: new Bucket(40, 30),
  };
}

class OpError extends Error {}

export class Session {
  seq = 0;
  layers = new Map<string, Layer>();
  strokes = new Map<string, Stroke>();
  clients = new Map<string, Client>();
  unloadTimer: NodeJS.Timeout | null = null;

  constructor(
    public code: string, // changes when the owner renames the canvas
    private store: Store,
    public row: CanvasRow,
  ) {}

  static load(store: Store, code: string): Session | null {
    const row = store.canvas(code);
    if (!row) return null;
    const s = new Session(code, store, row);
    for (const row of store.loadOps(code)) {
      s.applyStored(JSON.parse(row.data) as AppliedOp, row.client_id, row.seq);
      s.seq = row.seq;
    }
    if (s.layers.size === 0) {
      // Fresh session: seed one layer through the op log so it persists like any other op.
      s.commit(
        {
          type: 'layer.add',
          layer: { id: newId(), name: 'Layer 1', order: 1, blend: 'normal', opacity: 1, visible: true },
        },
        'server',
      );
    }
    return s;
  }

  /**
   * Fills a new, empty canvas from a .bdraw file: layer.add then stroke.add ops, each through
   * the same checks as a live op. Entries that fail are skipped and counted.
   */
  static importDoc(store: Store, row: CanvasRow, layers: unknown[], strokes: unknown[]): { layers: number; strokes: number; skipped: number } {
    const s = new Session(row.code, store, row);
    const n = { layers: 0, strokes: 0, skipped: 0 };
    const tryCommit = (op: () => Op, by: string, kind: 'layers' | 'strokes') => {
      try {
        s.commit(op(), by);
        n[kind]++;
      } catch (e) {
        if (e instanceof ValidationError || e instanceof OpError) n.skipped++;
        else throw e;
      }
    };
    const field = (v: unknown, k: string) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined);
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    store.transaction(() => {
      for (const l of layers) {
        if (field(l, 'deleted') === true) continue;
        tryCommit(() => validateOp({ type: 'layer.add', layer: l }), 'import', 'layers');
      }
      const ordered = [...strokes].sort((a, b) => num(field(a, 'seq')) - num(field(b, 'seq')));
      for (const st of ordered) {
        if (field(st, 'deleted') === true) continue;
        const author = field(st, 'author');
        const by = typeof author === 'string' && /^[\w-]{1,40}$/.test(author) ? author : 'import';
        tryCommit(() => validateOp({ type: 'stroke.add', stroke: st }), by, 'strokes');
      }
    });
    return n;
  }

  /** Replays a persisted op. No checks: the op passed them when it was first accepted. */
  private applyStored(op: AppliedOp, by: string, seq: number): void {
    try {
      this.apply(op as Op, by, seq);
    } catch {
      // A bad historic op must not make the whole session unloadable.
    }
  }

  /** Mutates state. Throws OpError when the op does not make sense for the current state. */
  private apply(op: Op, by: string, seq: number): AppliedOp {
    switch (op.type) {
      case 'stroke.add': {
        const layer = this.layers.get(op.stroke.layerId);
        if (!layer || layer.deleted) throw new OpError('no such layer');
        if (layer.kind === 'adjust' && !op.stroke.mask) throw new OpError('adjustment layers hold no paint');
        if (this.strokes.has(op.stroke.id)) throw new OpError('duplicate stroke');
        const stroke: Stroke = { ...op.stroke, seq, author: by };
        this.strokes.set(stroke.id, stroke);
        return { type: 'stroke.add', stroke };
      }
      case 'stroke.remove': {
        const s = this.strokes.get(op.id);
        if (!s || s.deleted) throw new OpError('no such stroke');
        s.deleted = true;
        return op;
      }
      case 'stroke.restore': {
        const s = this.strokes.get(op.id);
        if (!s || !s.deleted) throw new OpError('stroke not deleted');
        delete s.deleted;
        return { type: 'stroke.restore', id: op.id, stroke: s };
      }
      case 'layer.add': {
        if (this.layers.has(op.layer.id)) throw new OpError('duplicate layer');
        let live = 0;
        for (const l of this.layers.values()) if (!l.deleted) live++;
        if (live >= LIMITS.maxLayers) throw new OpError('too many layers');
        this.layers.set(op.layer.id, { ...op.layer, deleted: false });
        return op;
      }
      case 'layer.update': {
        const l = this.layers.get(op.id);
        if (!l) throw new OpError('no such layer');
        Object.assign(l, op.props);
        return op;
      }
      case 'layer.remove': {
        const l = this.layers.get(op.id);
        if (!l || l.deleted) throw new OpError('no such layer');
        l.deleted = true;
        return op;
      }
      case 'layer.restore': {
        const l = this.layers.get(op.id);
        if (!l || !l.deleted) throw new OpError('layer not deleted');
        l.deleted = false;
        return op;
      }
    }
  }

  private commit(op: Op, by: string, opId = ''): void {
    const seq = this.seq + 1;
    const applied = this.apply(op, by, seq);
    this.seq = seq;
    // Persist restores without the stroke body: replay already has it.
    const stored: AppliedOp = applied.type === 'stroke.restore' ? (op as AppliedOp) : applied;
    this.store.appendOp(this.code, seq, by, stored);
    this.broadcast({ t: 'op', seq, by, opId, op: applied });
  }

  join(client: Client): void {
    if (this.unloadTimer) {
      clearTimeout(this.unloadTimer);
      this.unloadTimer = null;
    }
    this.clients.set(client.id, client);
  }

  leave(client: Client): void {
    this.clients.delete(client.id);
    if (client.peer) this.broadcast({ t: 'peer.leave', id: client.id });
  }

  async handle(client: Client, msg: ClientMsg): Promise<void> {
    if (msg.t === 'ping') return this.send(client, { t: 'pong' });
    if (msg.t === 'hello') return this.hello(client, msg);
    if (!client.peer) return;
    switch (msg.t) {
      case 'op': {
        const opId = typeof msg.opId === 'string' ? msg.opId.slice(0, 40) : '';
        if (!atLeast(client.role, 'editor')) return this.send(client, { t: 'reject', opId, reason: 'view only' });
        if (!client.ops.take()) return this.send(client, { t: 'reject', opId, reason: 'rate limited' });
        try {
          this.commit(validateOp(msg.op), client.id, opId);
        } catch (e) {
          if (e instanceof ValidationError || e instanceof OpError) {
            this.send(client, { t: 'reject', opId, reason: e.message });
          } else throw e;
        }
        return;
      }
      case 'live': {
        if (!atLeast(client.role, 'editor') || !client.live.take()) return;
        try {
          this.broadcast(
            {
              t: 'live',
              by: client.id,
              id: validateId(msg.id),
              layerId: validateId(msg.layerId, 'layerId'),
              ...(msg.mask !== undefined ? { mask: validateId(msg.mask, 'mask') } : {}),
              brush: validateBrush(msg.brush),
              pts: validatePoints(msg.pts, 0),
              start: msg.start === true,
            },
            client,
          );
        } catch {
          // Drop malformed live data. It is not persisted.
        }
        return;
      }
      case 'live.end':
        if (typeof msg.id === 'string') this.broadcast({ t: 'live.end', by: client.id, id: msg.id }, client);
        return;
      case 'cursor': {
        if (!client.cursor.take()) return;
        const coord = (v: unknown) =>
          v === null ? null : validateNumber(v, -LIMITS.maxCoord, LIMITS.maxCoord, 'cursor');
        try {
          this.broadcast(
            {
              t: 'cursor',
              by: client.id,
              x: coord(msg.x),
              y: coord(msg.y),
              layerId: msg.layerId === null ? null : validateId(msg.layerId, 'layerId'),
            },
            client,
          );
        } catch {
          // ignore
        }
        return;
      }
    }
  }

  private async hello(client: Client, msg: Extract<ClientMsg, { t: 'hello' }>): Promise<void> {
    if (client.peer || client.joining) return;
    client.joining = true;
    try {
      const str = (v: unknown, max = 200) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined);
      // The web app authenticates with its cookie at the upgrade; the desktop app sends a token.
      client.access.user ??= userFromToken(this.store, str(msg.token));
      const anon = str(msg.anon);
      client.access.anonHash = anon ? sha256(anon) : undefined;
      client.access.link = str(msg.link);
      client.access.grant = str(msg.grant);
      const password = typeof msg.password === 'string' ? msg.password.slice(0, 200) : undefined;
      if (password !== undefined && ++client.passwordTries > 5) return this.kick(client, 'password_wrong');

      const row = this.store.canvas(this.code);
      if (!row) return this.kick(client, 'deleted');
      this.row = row;
      const access = await resolveAccess(this.store, row, { ...client.access, password });
      if (!access.ok) {
        // A password prompt keeps the socket open: the client sends another hello.
        if (access.reason === 'password_required' || access.reason === 'password_wrong') {
          return this.send(client, { t: 'denied', reason: access.reason });
        }
        return this.kick(client, access.reason);
      }
      if (access.grant) client.access.grant = access.grant;
      client.role = access.role;

      let name = 'Guest';
      let color = '#31a8ff';
      try {
        name = validateString(msg.name, LIMITS.maxPeerName, 'name').trim() || name;
        color = validateColor(msg.color);
      } catch {
        // fall back to defaults
      }
      if (client.access.user) name = client.access.user.name.slice(0, LIMITS.maxPeerName);
      client.peer = { id: client.id, name, color };
      const peers: Peer[] = [];
      for (const c of this.clients.values()) if (c.peer && c !== client) peers.push(c.peer);
      this.send(client, {
        t: 'welcome',
        clientId: client.id,
        code: this.code,
        seq: this.seq,
        layers: [...this.layers.values()],
        strokes: [...this.strokes.values()].filter((s) => !s.deleted),
        peers,
        role: client.role,
        canvas: this.info(client),
        grant: access.grant,
        features: docFeatures(this.layers.values(), this.strokes.values()),
      });
      this.broadcast({ t: 'peer.join', peer: client.peer }, client);
    } finally {
      client.joining = false;
    }
  }

  /** What this client may know about the canvas. */
  info(client: Client): CanvasInfo {
    const r = this.row;
    return {
      key: this.code,
      owned: !!r.owner_id,
      ownerName: r.owner_id ? (this.store.userById(r.owner_id)?.name ?? null) : null,
      expiresAt: isTemporary(r) ? r.created_at + TEMP_TTL_MS : null,
      canClaim: canClaim(r, client.access.anonHash),
    };
  }

  /**
   * Re-reads the canvas row and re-checks every client (after a claim or a sharing change).
   * Clients that lost access are told why and disconnected; the others get their new role.
   */
  async refresh(gone: DeniedReason = 'deleted'): Promise<void> {
    const row = this.store.canvas(this.code);
    if (!row) {
      for (const c of [...this.clients.values()]) this.kick(c, gone);
      return;
    }
    this.row = row;
    for (const c of [...this.clients.values()]) {
      if (!c.peer) continue;
      // The owner's user row may have changed name; reload it.
      if (c.access.user) c.access.user = this.store.userById(c.access.user.id);
      const access = await recheckAccess(this.store, row, c.access);
      if (!access.ok) {
        this.kick(c, access.reason);
        continue;
      }
      c.role = access.role;
      this.send(c, { t: 'access', role: access.role, canvas: this.info(c) });
    }
  }

  /** Tells the client why, then closes its socket. */
  kick(client: Client, reason: DeniedReason): void {
    this.send(client, { t: 'denied', reason });
    setTimeout(() => client.ws.close(4003, reason), 50);
  }

  send(client: Client, msg: ServerMsg): void {
    if (client.ws.readyState === client.ws.OPEN) client.ws.send(JSON.stringify(msg));
  }

  broadcast(msg: ServerMsg, except?: Client): void {
    const data = JSON.stringify(msg);
    for (const c of this.clients.values()) {
      if (c !== except && c.peer && c.ws.readyState === c.ws.OPEN) c.ws.send(data);
    }
  }
}
