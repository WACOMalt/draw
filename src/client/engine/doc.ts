// Client document: the confirmed state from the server, plus this client's ops that the
// server has not echoed yet. The UI shows confirmed state with pending layer ops on top.

import { duplicateOf, paintOrder, subtreeIds, transformStroke } from '../../shared/layers';
import { shapeBounds, transformShapeMatrix } from '../../shared/shapes';
import { LIMITS, type AppliedOp, type Layer, type Op, type Shape, type Stroke } from '../../shared/types';

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

/** What an op changed in the strokes and shapes, for the renderer. */
export interface StrokeChanges {
  /** Strokes that changed in place (same id: the renderer drops and adds them). */
  changed: Stroke[];
  /** New strokes (copies). */
  added: Stroke[];
  /** Shapes that are new or changed (the renderer replaces them by id). */
  shapes: Shape[];
  /** Shapes that are gone (removed). */
  shapesGone: string[];
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
  /**
   * Confirmed shapes. Removed ones stay with `deleted` (undo can show them again before the
   * server confirms the restore); shapes from the welcome are all live.
   */
  shapes = new Map<string, Shape>();
  /** World bounds of each live shape. */
  shapeBounds = new Map<string, Bounds>();
  /** Increments when strokes change; consumers cache against it. */
  version = 0;
  pending: PendingOp[] = [];

  reset(seq: number, layers: Layer[], strokes: Stroke[], shapes: Shape[] = []): void {
    this.seq = seq;
    this.layers = new Map(layers.map((l) => [l.id, l]));
    this.strokes = new Map(strokes.map((s) => [s.id, s]));
    this.bounds = new Map(strokes.map((s) => [s.id, strokeBounds(s)]));
    this.shapes = new Map(shapes.map((s) => [s.id, s]));
    this.shapeBounds = new Map(shapes.map((s) => [s.id, shapeBounds(s)]));
    this.version++;
  }

  private putShape(s: Shape): void {
    this.shapes.set(s.id, s);
    if (s.deleted) this.shapeBounds.delete(s.id);
    else this.shapeBounds.set(s.id, shapeBounds(s));
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
        const shapes: Shape[] = [];
        for (const sh of this.shapes.values()) {
          if (!ids.has(sh.layerId)) continue;
          const m = transformShapeMatrix(sh, op.m, LIMITS.maxCoord);
          if (!m) continue;
          const next = { ...sh, m };
          this.putShape(next);
          if (!next.deleted) shapes.push(next);
        }
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
        return { changed, added: [], shapes, shapesGone: [] };
      }
      case 'layer.duplicate': {
        const copy = duplicateOf(this.layers, this.strokes.values(), op, this.shapes.values());
        for (const l of copy.layers) this.layers.set(l.id, l);
        for (const st of copy.strokes) {
          this.strokes.set(st.id, st);
          this.bounds.set(st.id, strokeBounds(st));
        }
        for (const sh of copy.shapes) this.putShape(sh);
        this.version++;
        return { changed: [], added: copy.strokes, shapes: copy.shapes, shapesGone: [] };
      }
      case 'shape.add':
      case 'shape.restore': {
        const sh: Shape = { ...op.shape };
        delete sh.deleted;
        this.putShape(sh);
        this.version++;
        return { changed: [], added: [], shapes: [sh], shapesGone: [] };
      }
      case 'shape.update': {
        const old = this.shapes.get(op.id);
        if (!old) return null;
        const next = applyShapeProps(old, op.props);
        this.putShape(next);
        this.version++;
        return { changed: [], added: [], shapes: next.deleted ? [] : [next], shapesGone: [] };
      }
      case 'shape.remove': {
        const old = this.shapes.get(op.id);
        if (!old) return null;
        this.putShape({ ...old, deleted: true });
        this.version++;
        return { changed: [], added: [], shapes: [], shapesGone: [op.id] };
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

  /**
   * Shapes changed by pending ops (not confirmed yet), as they will be: new ones, changed ones,
   * and removed ones (with `deleted`). The renderer draws these over the confirmed shapes.
   */
  pendingShapes(): Map<string, Shape> {
    const out = new Map<string, Shape>();
    const get = (id: string) => out.get(id) ?? this.shapes.get(id);
    for (const { op } of this.pending) {
      if (op.type === 'shape.add') out.set(op.shape.id, { ...op.shape, author: '', seq: Infinity });
      else if (op.type === 'shape.update') {
        const s = get(op.id);
        if (s) out.set(op.id, applyShapeProps(s, op.props));
      } else if (op.type === 'shape.remove' || op.type === 'shape.restore') {
        const s = get(op.id);
        if (s) out.set(op.id, { ...s, deleted: op.type === 'shape.remove' });
      }
    }
    return out;
  }

  /** A shape as the user sees it: confirmed, with pending ops applied. Deleted ones too. */
  shapeView(id: string): Shape | undefined {
    return this.pendingShapes().get(id) ?? this.shapes.get(id);
  }
}

/** A shape with some props changed (the client sends only props that fit the shape's kind). */
export function applyShapeProps(s: Shape, props: Partial<Shape>): Shape {
  return { ...s, ...props };
}
