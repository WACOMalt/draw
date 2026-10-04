// Client document: the confirmed state from the server, plus this client's ops that the
// server has not echoed yet. The UI shows confirmed state with pending layer ops on top.

import type { AppliedOp, Layer, Op, Stroke } from '../../shared/types';

export interface PendingOp {
  opId: string;
  op: Op;
}

function applyLayerOp(layers: Map<string, Layer>, op: Op | AppliedOp): boolean {
  switch (op.type) {
    case 'layer.add':
      layers.set(op.layer.id, { ...op.layer, deleted: false });
      return true;
    case 'layer.update': {
      const l = layers.get(op.id);
      if (l) layers.set(op.id, { ...l, ...op.props });
      return true;
    }
    case 'layer.remove':
    case 'layer.restore': {
      const l = layers.get(op.id);
      if (l) layers.set(op.id, { ...l, deleted: op.type === 'layer.remove' });
      return true;
    }
    default:
      return false;
  }
}

export function sortLayers(a: Layer, b: Layer): number {
  return a.order - b.order || (a.id < b.id ? -1 : 1);
}

/** World bounding box of a stroke, including its brush radius. */
export interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function strokeBounds(s: Stroke): Bounds {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const p = s.pts;
  for (let i = 0; i < p.length; i += 3) {
    if (p[i] < x0) x0 = p[i];
    if (p[i] > x1) x1 = p[i];
    if (p[i + 1] < y0) y0 = p[i + 1];
    if (p[i + 1] > y1) y1 = p[i + 1];
  }
  const r = s.brush.size * (0.5 + (s.brush.scatter ?? 0));
  return { x0: x0 - r, y0: y0 - r, x1: x1 + r, y1: y1 + r };
}

export class Doc {
  seq = 0;
  layers = new Map<string, Layer>();
  strokes = new Map<string, Stroke>();
  /** Bounds of each confirmed stroke, kept in step with `strokes`. */
  bounds = new Map<string, Bounds>();
  /** Increments when strokes change; consumers cache against it. */
  version = 0;
  pending: PendingOp[] = [];

  reset(seq: number, layers: Layer[], strokes: Stroke[]): void {
    this.seq = seq;
    this.layers = new Map(layers.map((l) => [l.id, l]));
    this.strokes = new Map(strokes.map((s) => [s.id, s]));
    this.bounds = new Map(strokes.map((s) => [s.id, strokeBounds(s)]));
    this.version++;
  }

  addPending(opId: string, op: Op): void {
    this.pending.push({ opId, op });
  }

  dropPending(opId: string): PendingOp | null {
    const i = this.pending.findIndex((p) => p.opId === opId);
    if (i < 0) return null;
    return this.pending.splice(i, 1)[0];
  }

  /** Applies a server op to the confirmed state. */
  apply(seq: number, op: AppliedOp): void {
    this.seq = seq;
    switch (op.type) {
      case 'stroke.add':
      case 'stroke.restore':
        this.strokes.set(op.stroke.id, { ...op.stroke, deleted: false });
        this.bounds.set(op.stroke.id, strokeBounds(op.stroke));
        this.version++;
        break;
      case 'stroke.remove':
        this.strokes.delete(op.id);
        this.bounds.delete(op.id);
        this.version++;
        break;
      default:
        applyLayerOp(this.layers, op);
    }
  }

  /** Layers as the user sees them, bottom to top, without deleted ones. */
  displayLayers(): Layer[] {
    const view = new Map(this.layers);
    for (const p of this.pending) applyLayerOp(view, p.op);
    return [...view.values()].filter((l) => !l.deleted).sort(sortLayers);
  }

  /** Every layer including deleted ones, with pending ops applied. Used for undo bookkeeping. */
  layer(id: string): Layer | undefined {
    const view = new Map<string, Layer>();
    const base = this.layers.get(id);
    if (base) view.set(id, base);
    for (const p of this.pending) if ('id' in p.op ? p.op.id === id : p.op.type === 'layer.add' && p.op.layer.id === id) applyLayerOp(view, p.op);
    return view.get(id);
  }
}
