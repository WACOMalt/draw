// A canvas on this device behaves as the server does for one person: the engine sends the same
// messages (hello, op, ...) and gets the same answers (welcome, op, reject), with no network.
// The ops go through the same checks (validateOp, shared/docState.ts) and into the op log in
// IndexedDB (store.ts). Live strokes, cursors and link previews are for other people: dropped.
//
// A Web Lock keeps a canvas open in one window at a time: two windows would both number their
// ops and spoil the log.

import { newId } from '../../shared/ids';
import type { AppliedOp, ClientMsg, ServerMsg } from '../../shared/types';
import { ValidationError, validateOp } from '../../shared/validate';
import { DocState, OpError } from '../../shared/docState';
import { docFeatures } from '../../shared/features';
import type { NetStatus } from '../engine/net';
import { appendOps, getLocal, loadOps, type StoredOp } from './store';

export class LocalNet {
  private doc = new DocState();
  private seq = 0;
  private clientId = newId();
  private ready: Promise<boolean>;
  private closed = false;
  private releaseLock: (() => void) | null = null;
  /** Ops not yet written, and the write in progress (writes go one after another). */
  private unwritten: StoredOp[] = [];
  private writing: Promise<void> = Promise.resolve();
  private flushTimer: number | undefined;

  constructor(
    private id: string,
    private onMessage: (msg: ServerMsg) => void,
    private onStatus: (s: NetStatus) => void,
    private onOpen: () => void,
  ) {
    onStatus('connecting');
    this.ready = this.load();
    void this.ready.then((ok) => {
      if (!ok || this.closed) return;
      this.onStatus('online');
      this.onOpen();
    });
  }

  private async load(): Promise<boolean> {
    if (!(await this.lock())) {
      this.deliver({ t: 'denied', reason: 'open_elsewhere' });
      return false;
    }
    try {
      if (!(await getLocal(this.id))) {
        this.deliver({ t: 'denied', reason: 'deleted' });
        return false;
      }
      for (const o of await loadOps(this.id)) {
        this.doc.applyStored(o.op, o.by, o.seq);
        this.seq = o.seq;
      }
    } catch (e) {
      console.error('local canvas', e);
      this.deliver({ t: 'denied', reason: 'storage_failed' });
      return false;
    }
    if (this.doc.layers.size === 0) {
      // A new canvas: its first layer, through the op log as on the server.
      this.commit({ type: 'layer.add', layer: { id: newId(), name: 'Layer 1', order: 1, blend: 'normal', opacity: 1, visible: true } }, 'local');
    }
    return true;
  }

  /** Holds this canvas's lock until close. False: another window has it. */
  private lock(): Promise<boolean> {
    if (!navigator.locks) return Promise.resolve(true); // no Web Locks: one window is up to the person
    return new Promise((resolve) => {
      void navigator.locks.request(`draw-local-${this.id}`, { ifAvailable: true }, (lock) => {
        if (!lock) return resolve(false);
        resolve(true);
        return new Promise<void>((release) => (this.releaseLock = release));
      });
    });
  }

  get online(): boolean {
    return !this.closed;
  }

  send(msg: ClientMsg): boolean {
    if (this.closed) return false;
    void this.ready.then((ok) => ok && !this.closed && this.handle(msg));
    return true;
  }

  private handle(msg: ClientMsg): void {
    switch (msg.t) {
      case 'ping':
        return this.deliver({ t: 'pong' });
      case 'hello':
        return this.deliver({
          t: 'welcome',
          clientId: this.clientId,
          code: this.id,
          seq: this.seq,
          layers: [...this.doc.layers.values()],
          strokes: [...this.doc.strokes.values()].filter((s) => !s.deleted),
          shapes: [...this.doc.shapes.values()].filter((s) => !s.deleted),
          peers: [],
          role: 'editor',
          canvas: { key: this.id, owned: false, ownerName: null, expiresAt: null, canClaim: false, local: true },
          features: docFeatures(this.doc.layers.values(), this.doc.strokes.values(), this.doc.shapes.values()),
          previewSeq: null,
        });
      case 'op': {
        const opId = typeof msg.opId === 'string' ? msg.opId.slice(0, 40) : '';
        try {
          this.commit(validateOp(msg.op), this.clientId, opId);
        } catch (e) {
          if (e instanceof ValidationError || e instanceof OpError) this.deliver({ t: 'reject', opId, reason: e.message });
          else throw e;
        }
        return;
      }
      default:
        return; // live strokes, cursors and previews are for other people
    }
  }

  private commit(op: Parameters<DocState['apply']>[0], by: string, opId = ''): void {
    const seq = this.seq + 1;
    const applied = this.doc.apply(op, by, seq);
    this.seq = seq;
    // As on the server: restores are stored without the body (replay already has it).
    const stored: AppliedOp = applied.type === 'stroke.restore' || applied.type === 'shape.restore' ? (op as AppliedOp) : applied;
    this.unwritten.push({ canvas: this.id, seq, by, op: stored });
    this.scheduleFlush();
    this.deliver({ t: 'op', seq, by, opId, op: applied });
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== undefined) return;
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush();
    }, 50);
  }

  /** Writes the ops not yet written. Resolves when they are in IndexedDB. */
  flush(): Promise<void> {
    window.clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    const batch = this.unwritten.splice(0);
    if (batch.length) {
      this.writing = this.writing
        .then(() => appendOps(this.id, batch))
        .catch((e) => {
          console.error('local canvas: write failed', e);
          this.onMessage({ t: 'denied', reason: 'storage_failed' });
        });
    }
    return this.writing;
  }

  /** Answers come later, as from a socket: the engine never gets one inside its own send. */
  private deliver(msg: ServerMsg): void {
    queueMicrotask(() => {
      if (!this.closed || msg.t === 'denied') this.onMessage(msg);
    });
  }

  /** After a login or logout: nothing changes for a canvas on this device; greet again. */
  reconnect(): void {
    void this.ready.then((ok) => ok && !this.closed && this.onOpen());
  }

  close(): void {
    if (this.closed) return;
    void this.flush().finally(() => this.releaseLock?.());
    this.closed = true;
    this.onStatus('offline');
  }
}
