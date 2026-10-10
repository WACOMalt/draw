// Compound shapes (kind 'compound'): parts combined live. A part is edited as a shape of its own
// (its id: `<compound id>~<index>`), with the world matrix and the style of the compound; a change
// goes back into the compound's parts. The server and the editor share these helpers.

import { compose, invert } from './layers';
import { compoundToPath, shapeCorners } from './shapes';
import type { Affine, CompoundOp, CompoundPart, Shape, ShapeKind } from './types';

export const OP_LABEL: Record<CompoundOp, string> = { unite: 'Unite', subtract: 'Subtract', intersect: 'Intersect', exclude: 'Exclude' };
/** Names of new compounds, by the op of their parts. */
export const OP_NAME: Record<CompoundOp, string> = { unite: 'Union', subtract: 'Subtraction', intersect: 'Intersection', exclude: 'Exclusion' };

const PART_FIELDS = ['radii', 'radiiLinked', 'sides', 'points', 'innerRatio', 'rounding', 'path', 'curve'] as const;

export const partId = (compound: string, i: number) => `${compound}~${i}`;

/** The compound id and part index of a part id, or null. */
export function splitPartId(id: string): [string, number] | null {
  const k = id.indexOf('~');
  if (k < 0) return null;
  const i = Number(id.slice(k + 1));
  return Number.isInteger(i) && i >= 0 ? [id.slice(0, k), i] : null;
}

const det = (m: Affine) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;

/** A part as a shape of its own: world matrix, the compound's style (its stroke width scaled to the part). */
export function partShape(c: Shape, i: number, label: (kind: ShapeKind) => string): Shape | undefined {
  const p = c.parts?.[i];
  if (!p) return undefined;
  const { op: _o, name, ...geo } = p;
  return {
    ...geo,
    id: partId(c.id, i),
    layerId: c.layerId,
    name: name ?? `${label(p.kind)} ${i + 1}`,
    z: i,
    m: compose(c.m, p.m),
    fill: c.fill,
    stroke: c.stroke,
    strokeWidth: c.strokeWidth / det(p.m),
    align: c.align,
    cap: c.cap,
    join: c.join,
    author: c.author,
    seq: c.seq,
  } as Shape;
}

/** A shape's geometry as a part (`T`: world to the compound's local units). A compound gives its outline path. */
export function partOf(s: Shape, op: CompoundOp, T: Affine): CompoundPart {
  if (s.kind === 'compound') {
    return { kind: 'path', op, w: s.w, h: s.h, m: compose(T, s.m), path: compoundToPath(s), name: s.name };
  }
  const part: Record<string, unknown> = { kind: s.kind, op, w: s.w, h: s.h, m: compose(T, s.m) };
  if (s.name) part.name = s.name;
  for (const k of PART_FIELDS) if (s[k] !== undefined) part[k] = s[k];
  return part as unknown as CompoundPart;
}

/**
 * The compound with part i changed to the shape `s` (a part shape after an edit: its geometry
 * goes back into the compound's units). A change of style there is the compound's style.
 */
export function withPart(c: Shape, i: number, s: Shape): Shape {
  const inv = invert(c.m);
  const old = c.parts?.[i];
  if (!inv || !old) return c;
  const part = partOf(s, old.op, inv);
  if (old.name === undefined && s.name === partShape(c, i, () => '')?.name) delete part.name;
  else part.name = s.name;
  const parts = c.parts!.slice();
  parts[i] = part;
  const out: Shape = { ...c, parts, fill: s.fill, stroke: s.stroke, align: s.align, cap: s.cap, join: s.join, strokeWidth: s.strokeWidth * det(part.m) };
  return fitCompoundFrame(out);
}

/** A compound with its frame fitted to its parts again: the origin moves into `m`. */
export function fitCompoundFrame<T extends Pick<Shape, 'kind' | 'w' | 'h' | 'm' | 'parts'>>(c: T): T {
  if (c.kind !== 'compound' || !c.parts?.length) return c;
  const pts = shapeCorners({ ...c, m: [1, 0, 0, 1, 0, 0] });
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    x0 = Math.min(x0, pts[i]);
    x1 = Math.max(x1, pts[i]);
    y0 = Math.min(y0, pts[i + 1]);
    y1 = Math.max(y1, pts[i + 1]);
  }
  const back: Affine = [1, 0, 0, 1, -x0, -y0];
  return { ...c, w: x1 - x0, h: y1 - y0, m: compose(c.m, [1, 0, 0, 1, x0, y0]), parts: c.parts.map((p) => ({ ...p, m: compose(back, p.m) })) };
}
