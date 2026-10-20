// Committed strokes grouped by layer in z-order, with cheap bounding boxes for culling.
// Used by the WebGL renderer (main thread) and the Canvas 2D tile worker.

import { computeDabs, strokeSeed, type DabList } from '../../shared/brush';
import type { Brush, Stroke } from '../../shared/types';
import { vectorShape } from '../../shared/flatten';
import { shapeBounds } from '../../shared/shapes';

/** Index and tile key of a stroke: its layer, or `layer#maskId` for a stroke on a layer mask. */
export function strokeKey(s: Pick<Stroke, 'layerId' | 'mask'>): string {
  return s.mask ? `${s.layerId}#${s.mask}` : s.layerId;
}

/** Tile key of a layer's mask content. */
export const maskKey = (layerId: string, maskId: string) => `${layerId}#${maskId}`;

export interface StrokeRec {
  stroke: Stroke;
  /** World bbox from the points, grown by the max radius. Culling never needs the dabs. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  dabs: DabList | null;
}

/**
 * The id a stroke's random dab numbers come from: a copy's (a tilted kaleidoscope's `id@node:i`,
 * the render test's `id~k`) is its original's, so the copy scatters and jitters as the original
 * does. (Stroke ids are base 62: no @ or ~.)
 */
export const seedId = (id: string): string => id.replace(/[@~].*$/, '');

/**
 * Dab lists by stroke, for every renderer of the page (one per thread): an export uses the walks
 * the view did, and the other way round. An export walked every stroke again on the main thread
 * (a third of its time on a canvas of many strokes). A committed stroke's points and brush do not
 * change in place (a change makes new ones), and an entry is good only for the ones it came from.
 */
let walked = new WeakMap<Stroke, { pts: number[]; brush: Brush; n: number; list: DabList }>();

/** The stroke's dab list if a renderer of this thread walked it (then on `rec` too), else null. */
export function cachedDabs(rec: StrokeRec): DabList | null {
  if (rec.dabs) return rec.dabs;
  const s = rec.stroke, e = walked.get(s);
  if (e && e.pts === s.pts && e.brush === s.brush && e.n === s.pts.length) rec.dabs = e.list;
  return rec.dabs;
}

/** Keeps a stroke's dab list on `rec`, and for the other renderers. */
export function keepDabs(rec: StrokeRec, list: DabList): DabList {
  const s = rec.stroke;
  rec.dabs = list;
  walked.set(s, { pts: s.pts, brush: s.brush, n: s.pts.length, list });
  return list;
}

/** Forgets every kept dab list (the benchmark's cold steps). */
export function forgetDabs(): void {
  walked = new WeakMap();
}

export function strokeDabs(rec: StrokeRec): DabList {
  return cachedDabs(rec) ?? keepDabs(rec, computeDabs(rec.stroke.brush, rec.stroke.pts, strokeSeed(seedId(rec.stroke.id))));
}

export class StrokeIndex {
  readonly recs = new Map<string, StrokeRec>();
  /** By strokeKey (a layer, or a layer mask), sorted by seq. */
  readonly byLayer = new Map<string, StrokeRec[]>();

  clear(): void {
    this.recs.clear();
    this.byLayer.clear();
  }

  static makeRec(stroke: Stroke): StrokeRec {
    if (stroke.vector) {
      // A vector stroke: what its shape draws.
      const b = shapeBounds(vectorShape(stroke));
      return { stroke, x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, dabs: null };
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const p = stroke.pts;
    for (let i = 0; i < p.length; i += 3) {
      if (p[i] < x0) x0 = p[i];
      if (p[i] > x1) x1 = p[i];
      if (p[i + 1] < y0) y0 = p[i + 1];
      if (p[i + 1] > y1) y1 = p[i + 1];
    }
    // Max radius plus a margin (relative, so it works at any zoom), plus the scatter reach.
    const r = stroke.brush.size * (0.51 + (stroke.brush.scatter ?? 0));
    return { stroke, x0: x0 - r, y0: y0 - r, x1: x1 + r, y1: y1 + r, dabs: null };
  }

  /** Adds or replaces a stroke. Returns the new record. */
  add(stroke: Stroke): StrokeRec {
    this.remove(stroke.id);
    const rec = StrokeIndex.makeRec(stroke);
    this.recs.set(stroke.id, rec);
    const key = strokeKey(stroke);
    let list = this.byLayer.get(key);
    if (!list) this.byLayer.set(key, (list = []));
    // Usually an append. Restored strokes go back to their original z position.
    let i = list.length;
    while (i > 0 && list[i - 1].stroke.seq > stroke.seq) i--;
    list.splice(i, 0, rec);
    return rec;
  }

  remove(id: string): StrokeRec | null {
    const rec = this.recs.get(id);
    if (!rec) return null;
    this.recs.delete(id);
    const list = this.byLayer.get(strokeKey(rec.stroke));
    if (list) {
      const i = list.indexOf(rec);
      if (i >= 0) list.splice(i, 1);
    }
    return rec;
  }

  /** The highest seq in a layer, or -1. */
  topSeq(layer: string): number {
    const list = this.byLayer.get(layer);
    return list && list.length ? list[list.length - 1].stroke.seq : -1;
  }
}

export function intersects(rec: StrokeRec, x0: number, y0: number, x1: number, y1: number): boolean {
  return rec.x1 > x0 && rec.x0 < x1 && rec.y1 > y0 && rec.y0 < y1;
}
