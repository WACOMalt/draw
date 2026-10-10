// Edits of path points (point editing and the Pen tool, shapeTool.ts). Pure functions: each
// returns new contours and leaves its input alone. Coordinates are local units of the shape.

import { cubicAt, splitCubic } from '../../shared/shapes';
import { POINT_STRIDE as S, type PathContour } from '../../shared/types';

export const CORNER = 0;
export const SMOOTH = 1;
export const SYMMETRIC = 2;

/** A point of a path: its contour and its index there. */
export interface PKey {
  c: number;
  i: number;
}

export const keyOf = (k: PKey) => `${k.c}:${k.i}`;
export const parseKey = (s: string): PKey => {
  const [c, i] = s.split(':').map(Number);
  return { c, i };
};

export interface Pt {
  x: number;
  y: number;
  ix: number;
  iy: number;
  ox: number;
  oy: number;
  t: number;
}

export function clonePath(p: PathContour[]): PathContour[] {
  return p.map((c) => ({ closed: c.closed, pts: c.pts.slice() }));
}

export const count = (c: PathContour) => c.pts.length / S;

export function getPt(p: PathContour[], k: PKey): Pt {
  const a = p[k.c].pts, o = k.i * S;
  return { x: a[o], y: a[o + 1], ix: a[o + 2], iy: a[o + 3], ox: a[o + 4], oy: a[o + 5], t: a[o + 6] };
}

function setPt(p: PathContour[], k: PKey, v: Pt): void {
  const a = p[k.c].pts, o = k.i * S;
  a[o] = v.x;
  a[o + 1] = v.y;
  a[o + 2] = v.ix;
  a[o + 3] = v.iy;
  a[o + 4] = v.ox;
  a[o + 5] = v.oy;
  a[o + 6] = v.t;
}

const hasIn = (p: Pt) => p.ix !== p.x || p.iy !== p.y;
const hasOut = (p: Pt) => p.ox !== p.x || p.oy !== p.y;

/** Moves anchors, with their handles, by (dx, dy). */
export function moveAnchors(path: PathContour[], keys: PKey[], dx: number, dy: number): PathContour[] {
  const p = clonePath(path);
  for (const k of keys) {
    const v = getPt(p, k);
    setPt(p, k, { ...v, x: v.x + dx, y: v.y + dy, ix: v.ix + dx, iy: v.iy + dy, ox: v.ox + dx, oy: v.oy + dy });
  }
  return p;
}

/**
 * Puts one handle of a point at (x, y). A smooth point turns its other handle to stay on one
 * line (keeping its length), a symmetric one mirrors it. `free` (Alt): the point becomes a corner
 * and the other handle stays.
 */
export function setHandle(path: PathContour[], k: PKey, which: 'in' | 'out', x: number, y: number, free: boolean): PathContour[] {
  const p = clonePath(path);
  const v = getPt(p, k);
  const t = free ? CORNER : v.t;
  const n = { ...v, t };
  if (which === 'in') {
    n.ix = x;
    n.iy = y;
  } else {
    n.ox = x;
    n.oy = y;
  }
  if (t !== CORNER) {
    const dx = x - v.x, dy = y - v.y;
    const len = Math.hypot(dx, dy);
    const other = which === 'in' ? Math.hypot(v.ox - v.x, v.oy - v.y) : Math.hypot(v.ix - v.x, v.iy - v.y);
    const l = t === SYMMETRIC ? len : other;
    if (len > 0) {
      const ox = v.x - (dx / len) * l, oy = v.y - (dy / len) * l;
      if (which === 'in') {
        n.ox = ox;
        n.oy = oy;
      } else {
        n.ix = ox;
        n.iy = oy;
      }
    }
  }
  setPt(p, k, n);
  return p;
}

/** The neighbors of a point in its contour (null at the ends of an open contour). */
function neighbors(p: PathContour[], k: PKey): [Pt | null, Pt | null] {
  const c = p[k.c], n = count(c);
  const prev = k.i > 0 ? k.i - 1 : c.closed && n > 1 ? n - 1 : -1;
  const next = k.i < n - 1 ? k.i + 1 : c.closed && n > 1 ? 0 : -1;
  return [prev >= 0 ? getPt(p, { c: k.c, i: prev }) : null, next >= 0 ? getPt(p, { c: k.c, i: next }) : null];
}

/**
 * Double-click on a point: a corner becomes a symmetric point (handles along the line between its
 * neighbors, a third of the distance to each); a smooth point becomes a corner without handles.
 */
export function toggleSmooth(path: PathContour[], k: PKey): PathContour[] {
  const p = clonePath(path);
  const v = getPt(p, k);
  if (v.t !== CORNER || hasIn(v) || hasOut(v)) {
    setPt(p, k, { ...v, ix: v.x, iy: v.y, ox: v.x, oy: v.y, t: CORNER });
    return p;
  }
  const [a, b] = neighbors(p, k);
  const ax = a ? a.x : v.x - (b!.x - v.x), ay = a ? a.y : v.y - (b!.y - v.y);
  const bx = b ? b.x : v.x + (v.x - ax), by = b ? b.y : v.y + (v.y - ay);
  let dx = bx - ax, dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (!(len > 0)) return p;
  dx /= len;
  dy /= len;
  const l = (Math.hypot(v.x - ax, v.y - ay) + Math.hypot(bx - v.x, by - v.y)) / 6;
  setPt(p, k, { ...v, ix: v.x - dx * l, iy: v.y - dy * l, ox: v.x + dx * l, oy: v.y + dy * l, t: SYMMETRIC });
  return p;
}

/** Sets the type of points (smooth and symmetric also line up the handles they have). */
export function setType(path: PathContour[], keys: PKey[], t: number): PathContour[] {
  let p = clonePath(path);
  for (const k of keys) {
    const v = getPt(p, k);
    if (t === CORNER) setPt(p, k, { ...v, t });
    else if (!hasIn(v) && !hasOut(v)) {
      p = toggleSmooth(p, k);
      setPt(p, k, { ...getPt(p, k), t });
    } else {
      setPt(p, k, { ...v, t });
      // Line the handles up along the out handle (or the in handle when there is no out handle).
      p = hasOut(v) ? setHandle(p, k, 'out', v.ox, v.oy, false) : setHandle(p, k, 'in', v.ix, v.iy, false);
    }
  }
  return p;
}

/** The cubic of segment i of a contour (from point i to the next), as 8 numbers. */
export function segCubic(c: PathContour, i: number): number[] {
  const j = (i + 1) % count(c), a = i * S, b = j * S, q = c.pts;
  return [q[a], q[a + 1], q[a + 4], q[a + 5], q[b + 2], q[b + 3], q[b], q[b + 1]];
}

/** Segments of a contour: one per point, minus one when it is open. */
export const segCount = (c: PathContour) => (c.closed ? count(c) : Math.max(0, count(c) - 1));

/** Adds a point on segment `seg` at t, without changing the curve. */
export function insertPoint(path: PathContour[], c: number, seg: number, t: number): { path: PathContour[]; key: PKey } {
  const p = clonePath(path);
  const con = p[c], n = count(con), j = (seg + 1) % n;
  const cub = segCubic(con, seg);
  const straight = cub[2] === cub[0] && cub[3] === cub[1] && cub[4] === cub[6] && cub[5] === cub[7];
  let np: number[];
  if (straight) {
    const [x, y] = cubicAt(cub, t);
    np = [x, y, x, y, x, y, CORNER];
  } else {
    const [l, r] = splitCubic(cub, t);
    // The neighbors' handles shorten to fit the two halves.
    con.pts[seg * S + 4] = l[2];
    con.pts[seg * S + 5] = l[3];
    con.pts[j * S + 2] = r[4];
    con.pts[j * S + 3] = r[5];
    np = [l[6], l[7], l[4], l[5], r[2], r[3], SMOOTH];
  }
  con.pts.splice((seg + 1) * S, 0, ...np);
  return { path: p, key: { c, i: seg + 1 } };
}

/**
 * Removes points. A contour left with one point goes; an empty result is []. (The curve around a
 * removed point keeps the handles of its neighbors.)
 */
export function removePoints(path: PathContour[], keys: PKey[]): PathContour[] {
  const gone = new Set(keys.map(keyOf));
  const out: PathContour[] = [];
  path.forEach((c, ci) => {
    const pts: number[] = [];
    for (let i = 0; i < count(c); i++) if (!gone.has(`${ci}:${i}`)) pts.push(...c.pts.slice(i * S, (i + 1) * S));
    if (pts.length >= 2 * S) out.push({ closed: c.closed, pts });
  });
  return out;
}

/** Every point key of a path. */
export function allKeys(path: PathContour[]): PKey[] {
  const out: PKey[] = [];
  path.forEach((c, ci) => {
    for (let i = 0; i < count(c); i++) out.push({ c: ci, i });
  });
  return out;
}

/**
 * The point of the path nearest to a screen point (`toScreen` maps local units to screen
 * pixels): its segment, its t and the distance in pixels. Null when there is no segment.
 */
export function nearestOnPath(path: PathContour[], toScreen: (x: number, y: number) => [number, number], x: number, y: number): { c: number; seg: number; t: number; d: number } | null {
  let best: { c: number; seg: number; t: number; d: number } | null = null;
  path.forEach((con, c) => {
    for (let seg = 0; seg < segCount(con); seg++) {
      const cub = segCubic(con, seg);
      const dist = (t: number) => {
        const [lx, ly] = cubicAt(cub, t);
        const [sx, sy] = toScreen(lx, ly);
        return Math.hypot(sx - x, sy - y);
      };
      // Coarse samples, then a finer search around the best one.
      let bt = 0, bd = Infinity;
      for (let k = 0; k <= 48; k++) {
        const d = dist(k / 48);
        if (d < bd) {
          bd = d;
          bt = k / 48;
        }
      }
      let lo = Math.max(0, bt - 1 / 48), hi = Math.min(1, bt + 1 / 48);
      for (let k = 0; k < 30; k++) {
        const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
        if (dist(m1) < dist(m2)) hi = m2;
        else lo = m1;
      }
      const t = (lo + hi) / 2, d = dist(t);
      if (!best || d < best.d) best = { c, seg, t, d };
    }
  });
  return best;
}
