// Client document: the confirmed state from the server, plus this client's ops that the
// server has not echoed yet. The UI shows confirmed state with pending layer ops on top.

import { duplicateOf, paintOrder, subtreeIds, transformStroke } from '../../shared/layers';
import { LIMITS, type AppliedOp, type Layer, type Op, type Stroke } from '../../shared/types';

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
      if (l) {
        const next = { ...l, ...op.props };
        if (next.parent === null) delete next.parent;
        layers.set(op.id, next);
      }
      return true;
    }
    case 'layer.duplicate':
      // The layers only (pending view); Doc.apply copies the strokes too.
      for (const l of duplicateOf(layers, [], op).layers) layers.set(l.id, l);
      return true;
    case 'layer.transform':
      return true;
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

export { sortLayers } from '../../shared/layers';

/** What an op changed in the strokes, for the renderer. */
export interface StrokeChanges {
  /** Strokes that changed in place (same id: the renderer drops and adds them). */
  changed: Stroke[];
  /** New strokes (copies). */
  added: Stroke[];
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

  /** Applies a server op to the confirmed state. Returns what changed in the strokes, if anything. */
  apply(seq: number, op: AppliedOp): StrokeChanges | null {
    this.seq = seq;
    switch (op.type) {
      case 'layer.transform': {
        const ids = subtreeIds(this.layers.values(), op.id);
        const changed: Stroke[] = [];
        for (const st of this.strokes.values()) {
          if (!ids.has(st.layerId)) continue;
          // The server checked the range; a failure here means the documents differ: skip.
          const t = transformStroke(st, op.m, LIMITS.maxCoord, [LIMITS.minBrushWorld, LIMITS.maxBrushWorld]);
          if (!t) continue;
          const next = { ...st, ...t };
          this.strokes.set(st.id, next);
          this.bounds.set(st.id, strokeBounds(next));
          changed.push(next);
        }
        this.version++;
        return { changed, added: [] };
      }
      case 'layer.duplicate': {
        const copy = duplicateOf(this.layers, this.strokes.values(), op);
        for (const l of copy.layers) this.layers.set(l.id, l);
        for (const st of copy.strokes) {
          this.strokes.set(st.id, st);
          this.bounds.set(st.id, strokeBounds(st));
        }
        this.version++;
        return { changed: [], added: copy.strokes };
      }
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
    return null;
  }

  /**
   * Layers as the user sees them, in paint order (bottom to top; a group's layers come right before
   * the group), without deleted ones and without layers in deleted groups. Groups included.
   */
  displayLayers(): Layer[] {
    return paintOrder(this.layerView().values());
  }

  /** All layers (deleted ones too) with the pending ops applied. */
  layerView(): Map<string, Layer> {
    const view = new Map(this.layers);
    for (const p of this.pending) applyLayerOp(view, p.op);
    return view;
  }

  /** Every layer including deleted ones, with pending ops applied. Used for undo bookkeeping. */
  layer(id: string): Layer | undefined {
    return this.layerView().get(id);
  }

}
