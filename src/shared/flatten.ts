// Shapes made paint (shapes.toPaint): each shape becomes a vector stroke that draws exactly as
// the shape did, in the stroke order of a paint layer. The server and the clients run this, so
// every client makes the same strokes.

import { derivedId } from './ids';
import { effectivelyDeleted, paintOrder } from './layers';
import { byZ, maxScale, shapeCorners, strokeReach } from './shapes';
import { LIMITS, type Layer, type Shape, type Stroke, type StrokeVector } from './types';

/** The vector stroke a shape becomes. */
export function shapeStroke(sh: Shape, key: string, layerId: string, seq: number, author: string): Stroke {
  const { id, layerId: _l, name: _n, z: _z, author: _a, seq: _s, deleted: _d, ...vector } = sh;
  const c = shapeCorners(sh);
  const pts: number[] = [];
  for (let i = 0; i < c.length; i += 2) pts.push(c[i], c[i + 1], 1);
  // A frame goes round: the stroke eraser touches all four sides.
  if (c.length > 4) pts.push(c[0], c[1], 1);
  // The brush size only bounds the stroke for culling (the vector draws it): the stroke band.
  const reach = strokeReach(sh) * maxScale(sh.m) * 2;
  const size = Math.min(LIMITS.maxBrushWorld, Math.max(LIMITS.minBrushWorld, reach));
  return {
    id: derivedId(key, id),
    layerId,
    seq,
    author,
    brush: {
      tool: 'paint',
      color: sh.fill ?? sh.stroke ?? '#000000',
      size,
      opacity: 1,
      flow: 1,
      hardness: 1,
      spacing: 1,
      pressureSize: false,
      pressureFlow: false,
      buildup: false,
    },
    pts,
    vector: vector as StrokeVector,
  };
}

/** A vector stroke as a shape again (to draw it, or to find its bounds). */
export function vectorShape(st: Stroke): Shape {
  return { ...st.vector!, id: st.id, layerId: st.layerId, name: '', z: 0, author: st.author, seq: st.seq };
}

type Plan<T> = { error: string } | T;

/** The live shapes of a layer. */
const liveOn = (shapes: Map<string, Shape>, layerId: string) => [...shapes.values()].filter((s) => !s.deleted && s.layerId === layerId).length;

/**
 * What shapes.toPaint does, or why it cannot: the strokes to add (in drawing order), the shapes
 * to remove, and the new kind of the target layer (null: unchanged). `layers`: every layer, for
 * the drawing order of shapes from several layers.
 */
export function planToPaint(
  layers: Map<string, Layer>,
  strokes: Map<string, Stroke>,
  shapes: Map<string, Shape>,
  op: { key: string; ids: string[]; layerId: string },
  seq: number,
  by: string,
): Plan<{ strokes: Stroke[]; shapes: string[]; kind: 'paint' | null }> {
  const target = layers.get(op.layerId);
  if (!target || effectivelyDeleted(layers, target)) return { error: 'no such layer' };
  const list: Shape[] = [];
  for (const id of op.ids) {
    const s = shapes.get(id);
    if (!s || s.deleted) return { error: 'no such shape' };
    list.push(s);
  }
  let kind: 'paint' | null = null;
  if (target.kind === 'shape') {
    // In place: all the shapes of this layer, which then becomes a paint layer.
    if (list.some((s) => s.layerId !== target.id) || liveOn(shapes, target.id) !== list.length) return { error: 'a shape layer becomes paint with all its shapes' };
    kind = 'paint';
  } else if (target.kind !== undefined && target.kind !== 'paint') return { error: 'vector strokes go on paint layers' };
  const at = new Map(paintOrder(layers.values()).map((l, i) => [l.id, i]));
  list.sort((a, b) => (at.get(a.layerId) ?? 0) - (at.get(b.layerId) ?? 0) || byZ(a, b));
  const out: Stroke[] = [];
  for (const s of list) {
    const st = shapeStroke(s, op.key, op.layerId, seq, by);
    const old = strokes.get(st.id);
    if (old && !old.deleted) return { error: 'duplicate stroke' };
    out.push(st);
  }
  return { strokes: out, shapes: list.map((s) => s.id), kind };
}

/**
 * What shapes.fromPaint does, or why it cannot: the strokes to remove, the shapes to restore, and
 * the new kind of the layer (null: unchanged). A paint layer becomes a shape layer again when the
 * shapes were its own and it holds no other paint.
 */
export function planFromPaint(
  layers: Map<string, Layer>,
  strokes: Map<string, Stroke>,
  shapes: Map<string, Shape>,
  op: { key: string; ids: string[]; layerId: string },
): Plan<{ strokes: string[]; shapes: string[]; kind: 'shape' | null }> {
  const target = layers.get(op.layerId);
  if (!target || effectivelyDeleted(layers, target)) return { error: 'no such layer' };
  const gone: string[] = [];
  for (const id of op.ids) {
    const s = shapes.get(id);
    if (!s || !s.deleted) return { error: 'shape not deleted' };
    const st = strokes.get(derivedId(op.key, id));
    if (!st || st.deleted || st.layerId !== op.layerId) return { error: 'no such stroke' };
    gone.push(st.id);
  }
  let kind: 'shape' | null = null;
  if ((target.kind ?? 'paint') === 'paint' && op.ids.every((id) => shapes.get(id)!.layerId === target.id)) {
    const removed = new Set(gone);
    for (const st of strokes.values()) {
      if (st.layerId === target.id && !st.deleted && !st.mask && !removed.has(st.id)) return { error: 'the layer has other paint now' };
    }
    kind = 'shape';
  }
  return { strokes: gone, shapes: [...op.ids], kind };
}
