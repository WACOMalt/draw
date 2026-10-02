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
import type { Store } from './db';

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
  peer: Peer | null; // null until hello
  ops: Bucket;
  live: Bucket;
  cursor: Bucket;
}

export function newClient(ws: WebSocket): Client {
  return {
    id: newId(),
    ws,
    peer: null,
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

  constructor(readonly code: string, private store: Store) {}

  static load(store: Store, code: string): Session {
    const s = new Session(code, store);
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

  handle(client: Client, msg: ClientMsg): void {
    if (msg.t === 'ping') return this.send(client, { t: 'pong' });
    if (msg.t === 'hello') return this.hello(client, msg);
    if (!client.peer) return;
    switch (msg.t) {
      case 'op': {
        const opId = typeof msg.opId === 'string' ? msg.opId.slice(0, 40) : '';
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
        if (!client.live.take()) return;
        try {
          this.broadcast(
            {
              t: 'live',
              by: client.id,
              id: validateId(msg.id),
              layerId: validateId(msg.layerId, 'layerId'),
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

  private hello(client: Client, msg: Extract<ClientMsg, { t: 'hello' }>): void {
    if (client.peer) return;
    let name = 'Guest';
    let color = '#31a8ff';
    try {
      name = validateString(msg.name, LIMITS.maxPeerName, 'name').trim() || name;
      color = validateColor(msg.color);
    } catch {
      // fall back to defaults
    }
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
    });
    this.broadcast({ t: 'peer.join', peer: client.peer }, client);
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
