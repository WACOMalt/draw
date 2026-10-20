// Dab walks in Web Workers (dabs.worker.ts), for every renderer of the page. A stroke's dab list
// is a walk along its points in order (each step depends on the dab before), done once per
// stroke and kept on its record. A canvas of thousands of strokes walked them on the main thread
// as tiles first needed them: now workers walk them in the background as strokes arrive, a tile
// asks for the ones it needs first, and the main thread waits only for those.

import { strokeSeed } from '../../shared/brush';
import { cachedDabs, keepDabs, seedId, type StrokeRec } from './strokeIndex';
import DabWorker from './dabs.worker?worker';
import type { DabJob, DabResult } from './dabs.worker';

/** Points in one message to a worker: small enough that a tile's urgent request waits little. */
const BATCH_POINTS = 30_000;
/** Messages in flight per worker. */
const IN_FLIGHT = 2;

interface Entry {
  rec: StrokeRec;
  job: DabJob;
}

class DabPool {
  private workers: { w: Worker; busy: number }[] = [];
  private urgent: Entry[] = [];
  private queue: Entry[] = [];
  /** Walks asked for and not back yet, by job id; and the record's job id. */
  private open = new Map<number, Entry>();
  private ids = new WeakMap<StrokeRec, number>();
  private nextId = 1;
  private waiters: { recs: Set<StrokeRec>; done: () => void }[] = [];
  /** Called when walks come back (renderers draw again). */
  private listeners = new Set<() => void>();

  constructor(n: number) {
    for (let i = 0; i < n; i++) {
      const w = new DabWorker();
      const slot = { w, busy: 0 };
      w.onmessage = (e: MessageEvent<DabResult[]>) => {
        slot.busy--;
        this.take(e.data);
        this.pump();
      };
      w.onerror = () => {
        // A worker that fails: its walks go back to the main thread (strokeDabs walks there).
        slot.busy = Infinity;
      };
      this.workers.push(slot);
    }
  }

  onReady(f: () => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  /** Asks for the dab lists of these records (in the background, or `urgent`: before the rest). */
  request(recs: Iterable<StrokeRec>, urgent = false): void {
    for (const rec of recs) {
      if (rec.stroke.vector || cachedDabs(rec)) continue;
      const id = this.ids.get(rec);
      if (id !== undefined && this.open.has(id)) {
        if (urgent) this.promote(id);
        continue;
      }
      const job: DabJob = { id: this.nextId++, brush: rec.stroke.brush, pts: rec.stroke.pts, seed: strokeSeed(seedId(rec.stroke.id)) };
      const entry = { rec, job };
      this.ids.set(rec, job.id);
      this.open.set(job.id, entry);
      (urgent ? this.urgent : this.queue).push(entry);
    }
    this.pump();
  }

  /** The record's walk is asked for and not back yet. */
  pending(rec: StrokeRec): boolean {
    const id = this.ids.get(rec);
    return id !== undefined && this.open.has(id) && !rec.dabs;
  }

  /** Resolves once the walks of these records are back (or were never asked for). */
  whenReady(recs: Iterable<StrokeRec>): Promise<void> {
    const wait = new Set<StrokeRec>();
    for (const r of recs) if (this.pending(r)) wait.add(r);
    if (!wait.size) return Promise.resolve();
    return new Promise((done) => this.waiters.push({ recs: wait, done }));
  }

  /** A walk still queued moves to the urgent queue. */
  private promote(id: number): void {
    const i = this.queue.findIndex((e) => e.job.id === id);
    if (i >= 0) this.urgent.push(...this.queue.splice(i, 1));
  }

  private pump(): void {
    for (const slot of this.workers) {
      while (slot.busy < IN_FLIGHT && (this.urgent.length || this.queue.length)) {
        const batch: DabJob[] = [];
        let pts = 0;
        while (pts < BATCH_POINTS && (this.urgent.length || this.queue.length)) {
          const e = (this.urgent.length ? this.urgent : this.queue).shift()!;
          // Walked on the main thread meanwhile (strokeDabs): nothing to ask.
          if (e.rec.dabs) {
            this.open.delete(e.job.id);
            continue;
          }
          batch.push(e.job);
          pts += e.job.pts.length / 3;
        }
        if (!batch.length) break;
        slot.busy++;
        slot.w.postMessage(batch);
      }
    }
    this.settle();
  }

  private take(results: DabResult[]): void {
    for (const r of results) {
      const e = this.open.get(r.id);
      if (!e) continue;
      this.open.delete(r.id);
      if (!e.rec.dabs) keepDabs(e.rec, r.list);
    }
    this.settle();
    for (const f of this.listeners) f();
  }

  private settle(): void {
    if (!this.waiters.length) return;
    this.waiters = this.waiters.filter((w) => {
      for (const r of w.recs) if (!this.pending(r)) w.recs.delete(r);
      if (w.recs.size) return true;
      w.done();
      return false;
    });
  }
}

let pool: DabPool | null | undefined;

/** The page's pool, or null where workers cannot run (then the main thread walks). */
export function dabPool(): DabPool | null {
  if (pool !== undefined) return pool;
  try {
    const cores = navigator.hardwareConcurrency || 2;
    pool = typeof Worker === 'undefined' ? null : new DabPool(Math.max(1, Math.min(4, cores - 1)));
  } catch {
    pool = null;
  }
  return pool;
}
