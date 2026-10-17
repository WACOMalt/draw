// Layer groups (as in Photoshop) and layer transforms: the rules the server, the client document,
// the renderers and the layers panel share.
//
// - A group is a layer with kind 'group'. A layer's `parent` names its group (absent or null: the
//   top level). `order` sorts the layers of one parent, bottom to top.
// - A layer counts as deleted when it or any group above it is deleted, and as visible only when
//   it and every group above it are visible. Deleting a group hides its layers; restoring it brings
//   them back unchanged.
// - Paint order (bottom to top, as the renderers composite): the layers of a group come right
//   before the group itself. The panel shows the reverse: the group's row, then its layers.

import { derivedId } from './ids';
import type { Affine, Affine3, Brush, Layer, Shape, Stroke, StrokeThreeD } from './types';

export interface LayerNode {
  layer: Layer;
  /** Bottom to top. Empty for layers that are not groups. */
  children: LayerNode[];
}

export const sortLayers = (a: Layer, b: Layer) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The live layer tree, roots bottom to top. Leaves out deleted layers and everything under a
 * deleted or missing group (also a parent that is not a group).
 */
export function layerTree(layers: Iterable<Layer>): LayerNode[] {
  const byParent = new Map<string | null, Layer[]>();
  const byId = new Map<string, Layer>();
  for (const l of layers) byId.set(l.id, l);
  for (const l of byId.values()) {
    if (l.deleted) continue;
    const p = l.parent ?? null;
    let list = byParent.get(p);
    if (!list) byParent.set(p, (list = []));
    list.push(l);
  }
  const build = (parent: string | null, depth: number): LayerNode[] =>
    (byParent.get(parent) ?? [])
      .sort(sortLayers)
      .map((layer) => ({ layer, children: layer.kind === 'group' && depth < 64 ? build(layer.id, depth + 1) : [] }));
  return build(null, 0);
}

/** Live layers in paint order (bottom to top): a group's layers, then the group. */
export function paintOrder(layers: Iterable<Layer>): Layer[] {
  const out: Layer[] = [];
  const walk = (nodes: LayerNode[]) => {
    for (const n of nodes) {
      walk(n.children);
      out.push(n.layer);
    }
  };
  walk(layerTree(layers));
  return out;
}

/**
 * The layer is 3D for a 3D step (a kaleidoscope's, or a 3D transform's): a 3D paint layer, or a
 * group whose paint layers (live ones) are all 3D paint layers. `layers`: the live layers.
 */
export function allThreeD(layers: Layer[], id: string): boolean {
  const l = layers.find((x) => x.id === id);
  if (!l) return false;
  if (l.kind !== 'group') return !!l.threed && (l.kind ?? 'paint') === 'paint';
  const ids = subtreeIds(layers, id);
  const paint = layers.filter((x) => ids.has(x.id) && x.kind !== 'group' && x.kind !== 'adjust');
  return paint.length > 0 && paint.every((x) => x.threed && (x.kind ?? 'paint') === 'paint');
}

/** The ids of the group `id` and everything in it at any depth (deleted layers too). */
export function subtreeIds(layers: Iterable<Layer>, id: string): Set<string> {
  const kids = new Map<string, string[]>();
  for (const l of layers) {
    if (!l.parent) continue;
    let list = kids.get(l.parent);
    if (!list) kids.set(l.parent, (list = []));
    list.push(l.id);
  }
  const out = new Set<string>();
  const walk = (x: string) => {
    if (out.has(x)) return;
    out.add(x);
    for (const k of kids.get(x) ?? []) walk(k);
  };
  walk(id);
  return out;
}

/** Groups above the layer, nearest first. Stops at a cycle or a missing layer. */
export function ancestors(byId: Map<string, Layer>, l: Layer): Layer[] {
  const out: Layer[] = [];
  const seen = new Set([l.id]);
  let p = l.parent ? byId.get(l.parent) : undefined;
  while (p && !seen.has(p.id)) {
    out.push(p);
    seen.add(p.id);
    p = p.parent ? byId.get(p.parent) : undefined;
  }
  return out;
}

/** Deleted itself, under a deleted group, or under a group that does not exist. */
export function effectivelyDeleted(byId: Map<string, Layer>, l: Layer): boolean {
  if (l.deleted) return true;
  let cur = l;
  const seen = new Set([l.id]);
  while (cur.parent) {
    const p = byId.get(cur.parent);
    if (!p || p.deleted || p.kind !== 'group' || seen.has(p.id)) return true;
    seen.add(p.id);
    cur = p;
  }
  return false;
}

/** Visible itself and in every group above. */
export function effectivelyVisible(byId: Map<string, Layer>, l: Layer): boolean {
  return l.visible && ancestors(byId, l).every((g) => g.visible);
}

/** Groups between the layer and the top level, 0 for a top-level layer. */
export const depthOf = (byId: Map<string, Layer>, l: Layer): number => ancestors(byId, l).length;

/**
 * Levels a layer needs below its own place: 0 for a paint or adjustment layer, and for a group
 * 1 + the most its layers need (a group's contents sit one level deeper). With LIMITS.maxGroupDepth
 * 8: 8 levels of groups, and layers inside the 8th.
 */
export function subtreeHeight(layers: Iterable<Layer>, id: string): number {
  const list = [...layers];
  const byId = new Map(list.map((l) => [l.id, l]));
  const kids = (p: string) => list.filter((l) => l.parent === p && !l.deleted);
  const h = (x: string, d: number): number =>
    byId.get(x)?.kind !== 'group' || d > 64 ? 0 : 1 + Math.max(0, ...kids(x).map((k) => h(k.id, d + 1)));
  return h(id, 0);
}

// --- transforms ------------------------------------------------------------------------------

export const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

/** m1 after m2: apply m2 first. */
export function compose(m1: Affine, m2: Affine): Affine {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [a1 * a2 + c1 * b2, b1 * a2 + d1 * b2, a1 * c2 + c1 * d2, b1 * c2 + d1 * d2, a1 * e2 + c1 * f2 + e1, b1 * e2 + d1 * f2 + f1];
}

export function invert(m: Affine): Affine | null {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-300) return null;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

export const applyPoint = (m: Affine, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/**
 * A stroke after a transform: points mapped, the brush size scaled by √|det| (the average scale),
 * and a fixed tip angle turned with the rotation. A non-uniform scale or a skew keeps the tip
 * shape (as Photoshop's vector strokes would not, but dabs cannot stretch). The depth of a 3D
 * stroke follows (transformThreeD). Null: a point or a depth would go past `maxCoord` or the size out
 * of range.
 */
export function transformStroke(s: Stroke, m: Affine, maxCoord: number, sizeRange: [number, number]): Pick<Stroke, 'pts' | 'brush' | 'vector' | 'threed'> | null {
  const pts = s.pts.slice();
  for (let i = 0; i < pts.length; i += 3) {
    const x = pts[i], y = pts[i + 1];
    const nx = m[0] * x + m[2] * y + m[4];
    const ny = m[1] * x + m[3] * y + m[5];
    if (!(Math.abs(nx) <= maxCoord && Math.abs(ny) <= maxCoord)) return null;
    pts[i] = nx;
    pts[i + 1] = ny;
  }
  const brush = scaledBrush(s.brush, Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])), Math.atan2(m[1], m[0]), sizeRange);
  if (!brush) return null;
  if (s.vector) {
    // A vector stroke: its shape's matrix follows (its frame corners, in pts, are checked above).
    const vm = compose(m, s.vector.m);
    if (!validAffine(vm)) return null;
    return { pts, brush, vector: { ...s.vector, m: vm } };
  }
  if (s.threed) {
    const threed = transformThreeD(s.threed, m, maxCoord);
    if (!threed) return null;
    return { pts, brush, threed };
  }
  return { pts, brush };
}

/**
 * The brush after a transform that scales by `scale` and turns by `turn` radians: the size
 * scales, and a fixed tip angle turns (not needed with followDirection: dabs follow the path).
 * Null: the size would go out of `sizeRange`.
 */
function scaledBrush(b: Brush, scale: number, turn: number, sizeRange: [number, number]): Brush | null {
  const size = b.size * scale;
  if (!(size >= sizeRange[0] && size <= sizeRange[1])) return null;
  const brush: Brush = { ...b, size };
  if ((brush.angle !== undefined || (brush.tip && brush.tip !== 'round') || (brush.roundness ?? 1) < 1) && !brush.followDirection) {
    const deg = (turn * 180) / Math.PI;
    brush.angle = ((((brush.angle ?? 0) + deg) % 360) + 360) % 360;
  }
  return brush;
}

/**
 * The depth of a 3D stroke after a transform of the paper: the 2D affine `m` as a 3D map that
 * scales depth by √|det| (the average scale, as brush sizes). Depths scale; the up directions
 * turn with the map (turnUps). Null: a depth would go past `maxCoord`.
 */
export function transformThreeD(threed: StrokeThreeD, m: Affine, maxCoord: number): StrokeThreeD | null {
  const [a, b, c, d] = m;
  const k = Math.sqrt(Math.abs(a * d - b * c));
  const z = threed.z.map((v) => v * k);
  if (!z.every((v) => Math.abs(v) <= maxCoord)) return null;
  return threed.up ? { z, up: turnUps(threed.up, [a, b, 0, c, d, 0, 0, 0, k]) } : { z };
}

/**
 * Up directions (three numbers each) through the linear map `l` (3×3, column-major, as the
 * first nine numbers of an Affine3), made unit again and rounded to 3 decimals, as clients send
 * them. One that would vanish stays as it was.
 */
function turnUps(up: number[], l: number[]): number[] {
  const out = up.slice();
  const round = (v: number) => Math.round(v * 1000) / 1000;
  for (let i = 0; i < out.length; i += 3) {
    const ux = out[i], uy = out[i + 1], uz = out[i + 2];
    const nx = l[0] * ux + l[3] * uy + l[6] * uz;
    const ny = l[1] * ux + l[4] * uy + l[7] * uz;
    const nz = l[2] * ux + l[5] * uy + l[8] * uz;
    const len = Math.hypot(nx, ny, nz);
    if (!(len > 1e-9 && Number.isFinite(len))) continue;
    out[i] = round(nx / len);
    out[i + 1] = round(ny / len);
    out[i + 2] = round(nz / len);
  }
  return out;
}

/** Checks a transform: finite, invertible, and not absurdly large or small. */
export function validAffine(m: unknown): m is Affine {
  if (!Array.isArray(m) || m.length !== 6 || !m.every((v) => typeof v === 'number' && Number.isFinite(v))) return false;
  const det = Math.abs(m[0] * m[3] - m[1] * m[2]);
  return det > 1e-24 && det < 1e24;
}

// --- 3D transforms (3D layers) ---------------------------------------------------------------

/** The uniform scale of a 3D transform's linear part: ∛|det|. */
export function scale3(m: Affine3): number {
  const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[3] * (m[1] * m[8] - m[2] * m[7]) + m[6] * (m[1] * m[5] - m[2] * m[4]);
  return Math.cbrt(Math.abs(det));
}

/**
 * Checks a 3D transform: 12 finite numbers, and a linear part that is a turn times one uniform
 * scale (columns of equal length and at right angles, within a relative 1e-6, no mirror), with
 * the scale in the range a 2D transform allows (validAffine: 1e-12 to 1e12).
 */
export function validAffine3(m: unknown): m is Affine3 {
  if (!Array.isArray(m) || m.length !== 12 || !m.every((v) => typeof v === 'number' && Number.isFinite(v))) return false;
  const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[3] * (m[1] * m[8] - m[2] * m[7]) + m[6] * (m[1] * m[5] - m[2] * m[4]);
  if (!(det > 1e-36 && det < 1e36)) return false;
  const s2 = Math.cbrt(det) ** 2;
  const dot = (i: number, j: number) => m[i] * m[j] + m[i + 1] * m[j + 1] + m[i + 2] * m[j + 2];
  const tol = 1e-6 * s2;
  return (
    Math.abs(dot(0, 0) - s2) <= tol &&
    Math.abs(dot(3, 3) - s2) <= tol &&
    Math.abs(dot(6, 6) - s2) <= tol &&
    Math.abs(dot(0, 3)) <= tol &&
    Math.abs(dot(0, 6)) <= tol &&
    Math.abs(dot(3, 6)) <= tol
  );
}

/**
 * The layers a 3D transform of `l` moves: a 3D layer, or a group whose paint layers are all 3D
 * layers (with everything in it, deleted layers too, as a 2D transform of a group). A message
 * instead when it cannot: vector strokes and shapes cannot move in 3D.
 */
export function threeDTargets(layers: Map<string, Layer>, l: Layer, strokes: Iterable<Stroke>, shapes: Iterable<Shape>): Set<string> | string {
  let ids: Set<string>;
  if (l.kind === 'group') {
    ids = subtreeIds(layers.values(), l.id);
    let any = false;
    for (const id of ids) {
      const x = layers.get(id);
      if (!x || x.kind === 'group' || x.kind === 'adjust' || effectivelyDeleted(layers, x)) continue;
      if (!x.threed) return 'a 3D transform of a group needs all its layers to be 3D layers';
      any = true;
    }
    if (!any) return '3D transforms are for 3D layers';
  } else {
    if (!l.threed) return '3D transforms are for 3D layers';
    ids = new Set([l.id]);
  }
  for (const st of strokes) if (ids.has(st.layerId) && st.vector) return 'a 3D transform cannot move vector strokes';
  for (const sh of shapes) if (ids.has(sh.layerId)) return 'a 3D transform cannot move shapes';
  return ids;
}

/**
 * A stroke of a 3D layer after a 3D transform: each point (x, y, depth) moves in 3D (a stroke
 * without depth is at depth 0, and gets its depth), the up directions turn, the brush size
 * scales by ∛|det|, and a fixed tip angle turns with the turn of the x axis in the paper (as a
 * 2D transform does). Null: a vector stroke (it cannot move in 3D), or a point, a depth or the
 * size would go out of range.
 */
export function transformStroke3(s: Stroke, m: Affine3, maxCoord: number, sizeRange: [number, number]): Pick<Stroke, 'pts' | 'brush' | 'threed'> | null {
  if (s.vector) return null;
  const pts = s.pts.slice();
  const z = new Array<number>(pts.length / 3);
  for (let i = 0, j = 0; i < pts.length; i += 3, j++) {
    const x = pts[i], y = pts[i + 1], d = s.threed?.z[j] ?? 0;
    const nx = m[0] * x + m[3] * y + m[6] * d + m[9];
    const ny = m[1] * x + m[4] * y + m[7] * d + m[10];
    const nz = m[2] * x + m[5] * y + m[8] * d + m[11];
    if (!(Math.abs(nx) <= maxCoord && Math.abs(ny) <= maxCoord && Math.abs(nz) <= maxCoord)) return null;
    pts[i] = nx;
    pts[i + 1] = ny;
    z[j] = nz;
  }
  const brush = scaledBrush(s.brush, scale3(m), Math.atan2(m[1], m[0]), sizeRange);
  if (!brush) return null;
  return { pts, brush, threed: s.threed?.up ? { z, up: turnUps(s.threed.up, m) } : { z } };
}

/**
 * The paper's view of a 3D transform, for what lives in the 2D plane (effect lengths and
 * offsets): its scale, the turn of the x axis in the paper, and the move of the origin.
 */
export function flatAffine(m: Affine3): Affine {
  const k = scale3(m), t = Math.atan2(m[1], m[0]);
  const c = Math.cos(t) * k, s = Math.sin(t) * k;
  return [c, s, -s, c, m[9], m[10]];
}

// --- duplicates ------------------------------------------------------------------------------

/**
 * The copies layer.duplicate makes of the layer or group `id`: new layers (the top one with
 * `newId`, name, order and parent from the op; the others keep their name and order under their
 * copied group), new strokes and new shapes (same seq and author, ids derived from the copy's
 * id). Only live layers, strokes and shapes are copied. Both the server and the clients run this.
 */
export function duplicateOf(
  layers: Map<string, Layer>,
  strokes: Iterable<Stroke>,
  op: { id: string; newId: string; name: string; order: number; parent: string | null },
  shapes: Iterable<Shape> = [],
): { layers: Layer[]; strokes: Stroke[]; shapes: Shape[] } {
  const src = layers.get(op.id);
  if (!src) return { layers: [], strokes: [], shapes: [] };
  const mapId = new Map<string, string>([[op.id, op.newId]]);
  const outLayers: Layer[] = [];
  const walk = (l: Layer, top: boolean) => {
    const nid = top ? op.newId : derivedId(op.newId, l.id);
    mapId.set(l.id, nid);
    const copy: Layer = { ...l, id: nid, deleted: false };
    if (top) Object.assign(copy, { name: op.name, order: op.order, parent: op.parent });
    else copy.parent = mapId.get(l.parent!)!;
    if (copy.parent === null) delete copy.parent;
    outLayers.push(copy);
    if (l.kind === 'group') {
      for (const k of [...layers.values()].filter((x) => x.parent === l.id && !x.deleted).sort(sortLayers)) walk(k, false);
    }
  };
  walk(src, true);
  const outStrokes: Stroke[] = [];
  for (const s of strokes) {
    if (s.deleted) continue;
    const nl = mapId.get(s.layerId);
    if (!nl) continue;
    outStrokes.push({ ...s, id: derivedId(op.newId, s.id), layerId: nl });
  }
  const outShapes: Shape[] = [];
  for (const s of shapes) {
    if (s.deleted) continue;
    const nl = mapId.get(s.layerId);
    if (nl) outShapes.push({ ...s, id: derivedId(op.newId, s.id), layerId: nl });
  }
  return { layers: outLayers, strokes: outStrokes, shapes: outShapes };
}
