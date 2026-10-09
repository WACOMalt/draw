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
import type { Affine, Brush, Layer, Shape, Stroke } from './types';

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
 * shape (as Photoshop's vector strokes would not, but dabs cannot stretch). Null: a point would go
 * past `maxCoord` or the size out of range.
 */
export function transformStroke(s: Stroke, m: Affine, maxCoord: number, sizeRange: [number, number]): Pick<Stroke, 'pts' | 'brush'> | null {
  const pts = s.pts.slice();
  for (let i = 0; i < pts.length; i += 3) {
    const x = pts[i], y = pts[i + 1];
    const nx = m[0] * x + m[2] * y + m[4];
    const ny = m[1] * x + m[3] * y + m[5];
    if (!(Math.abs(nx) <= maxCoord && Math.abs(ny) <= maxCoord)) return null;
    pts[i] = nx;
    pts[i + 1] = ny;
  }
  const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
  const size = s.brush.size * scale;
  if (!(size >= sizeRange[0] && size <= sizeRange[1])) return null;
  const brush: Brush = { ...s.brush, size };
  if (brush.angle !== undefined || (brush.tip && brush.tip !== 'round') || (brush.roundness ?? 1) < 1) {
    // Turn the tip with the transform's rotation (not needed with followDirection: dabs follow the path).
    if (!brush.followDirection) {
      const deg = (Math.atan2(m[1], m[0]) * 180) / Math.PI;
      brush.angle = ((((brush.angle ?? 0) + deg) % 360) + 360) % 360;
    }
  }
  return { pts, brush };
}

/** Checks a transform: finite, invertible, and not absurdly large or small. */
export function validAffine(m: unknown): m is Affine {
  if (!Array.isArray(m) || m.length !== 6 || !m.every((v) => typeof v === 'number' && Number.isFinite(v))) return false;
  const det = Math.abs(m[0] * m[3] - m[1] * m[2]);
  return det > 1e-24 && det < 1e24;
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
