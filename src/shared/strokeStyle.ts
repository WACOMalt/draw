// Stroke styles that change what the stroke covers: dashes and arrowheads. The renderers and the
// tile worker share this file.
//
// Dashes are measured along the true curve, in local units, never along a flattened copy: every
// tile then cuts the same dashes, and they meet at tile edges at any zoom. A segment is split in
// halves (by its parameter) until a piece holds a few dash ends; pieces far from the target are
// skipped. The offset of a piece is the offset of its parent plus the length of its left
// sibling, so each piece has the same offset in every tile, whatever else the tile skips.
//
// Arrowheads sit on the ends of lines and of open contours. A filled arrow shortens the line, so
// its end and its cap stay under the head.

import { centerOnly, clipPolygon, cubicAt, flattenContour, maxScale, signedArea, strokePolygons, subCubic, tangents, xSegAt, type Box, type Contour, type Seg } from './shapes';
import type { Affine, ArrowKind, ShapeInput } from './types';

type Pt = [number, number];

// --- segments by parameter ---------------------------------------------------------------------

/** A point of a segment that starts at (x0, y0), at t from 0 to 1. */
export function segAt(g: Seg, x0: number, y0: number, t: number): Pt {
  switch (g.t) {
    case 'L':
      return [x0 + (g.x - x0) * t, y0 + (g.y - y0) * t];
    case 'C':
      return cubicAt([x0, y0, g.x1, g.y1, g.x2, g.y2, g.x, g.y], t);
    case 'X':
      return xSegAt(g, t);
    case 'A': {
      const a = g.a0 + (g.a1 - g.a0) * t;
      return [g.cx + g.rx * Math.cos(a), g.cy + g.ry * Math.sin(a)];
    }
  }
}

/** The end point of a segment. */
function segEnd(g: Seg, x0: number, y0: number): Pt {
  return g.t === 'A' ? segAt(g, x0, y0, 1) : [g.x, g.y];
}

/** |dP/dt| of a segment at t. */
function speed(g: Seg, x0: number, y0: number, t: number): number {
  switch (g.t) {
    case 'L':
      return Math.hypot(g.x - x0, g.y - y0);
    case 'C': {
      const u = 1 - t;
      const a = 3 * u * u, b = 6 * u * t, c = 3 * t * t;
      return Math.hypot(a * (g.x1 - x0) + b * (g.x2 - g.x1) + c * (g.x - g.x2), a * (g.y1 - y0) + b * (g.y2 - g.y1) + c * (g.y - g.y2));
    }
    case 'A': {
      const a = g.a0 + (g.a1 - g.a0) * t;
      return Math.abs(g.a1 - g.a0) * Math.hypot(g.rx * Math.sin(a), g.ry * Math.cos(a));
    }
    case 'X': {
      const h = 1e-6;
      const t0 = Math.max(0, t - h), t1 = Math.min(1, t + h);
      const p = xSegAt(g, t0), q = xSegAt(g, t1);
      return Math.hypot(q[0] - p[0], q[1] - p[1]) / (t1 - t0);
    }
  }
}

// Gauss–Legendre, 5 points.
const GX = [-0.906179845938664, -0.5384693101056831, 0, 0.5384693101056831, 0.906179845938664];
const GW = [0.2369268850561891, 0.4786286704993665, 0.5688888888888889, 0.4786286704993665, 0.2369268850561891];

function gauss(g: Seg, x0: number, y0: number, a: number, b: number): number {
  const m = (a + b) / 2, r = (b - a) / 2;
  let s = 0;
  for (let k = 0; k < 5; k++) s += GW[k] * speed(g, x0, y0, m + r * GX[k]);
  return s * r;
}

/** The length of a segment from t = a to t = b: adaptive, the same number for the same a and b every time. */
export function segLength(g: Seg, x0: number, y0: number, a = 0, b = 1, depth = 0): number {
  if (g.t === 'L') return Math.hypot(g.x - x0, g.y - y0) * (b - a);
  const m = (a + b) / 2;
  const whole = gauss(g, x0, y0, a, b), halves = gauss(g, x0, y0, a, m) + gauss(g, x0, y0, m, b);
  if (Math.abs(whole - halves) <= 1e-11 * halves || depth >= 20) return halves;
  return segLength(g, x0, y0, a, m, depth + 1) + segLength(g, x0, y0, m, b, depth + 1);
}

/** The t in [a, b] where the length from a is `d` (`len`: the length from a to b). */
function paramAt(g: Seg, x0: number, y0: number, a: number, b: number, len: number, d: number): number {
  if (d <= 0) return a;
  if (d >= len) return b;
  if (g.t === 'L') return a + ((b - a) * d) / len;
  // Newton steps, kept inside a bracket that shrinks (bisection when a step leaves it).
  let lo = a, hi = b, t = a + ((b - a) * d) / len;
  for (let i = 0; i < 30; i++) {
    const e = segLength(g, x0, y0, a, t) - d;
    if (Math.abs(e) <= 1e-12 * len) break;
    if (e > 0) hi = t;
    else lo = t;
    const v = speed(g, x0, y0, t);
    let next = v > 0 ? t - e / v : (lo + hi) / 2;
    if (!(next > lo && next < hi)) next = (lo + hi) / 2;
    t = next;
  }
  return t;
}

/** The part of a segment from t = a to t = b: its start point and the exact sub-segment. */
function subSeg(g: Seg, x0: number, y0: number, a: number, b: number): { x: number; y: number; seg: Seg } {
  const [sx, sy] = segAt(g, x0, y0, a);
  switch (g.t) {
    case 'L': {
      const [ex, ey] = segAt(g, x0, y0, b);
      return { x: sx, y: sy, seg: { t: 'L', x: ex, y: ey } };
    }
    case 'C': {
      const q = subCubic([x0, y0, g.x1, g.y1, g.x2, g.y2, g.x, g.y], a, b);
      return { x: q[0], y: q[1], seg: { t: 'C', x1: q[2], y1: q[3], x2: q[4], y2: q[5], x: q[6], y: q[7] } };
    }
    case 'A':
      return { x: sx, y: sy, seg: { ...g, a0: g.a0 + (g.a1 - g.a0) * a, a1: g.a0 + (g.a1 - g.a0) * b } };
    case 'X': {
      const t0 = g.t0 ?? 0, t1 = g.t1 ?? 1;
      const [ex, ey] = segAt(g, x0, y0, b);
      return { x: sx, y: sy, seg: { ...g, t0: t0 + (t1 - t0) * a, t1: t0 + (t1 - t0) * b, x: ex, y: ey } };
    }
  }
}

/** Points that a piece of a segment stays near (local units), and how far it may stray from them. */
function pieceHull(g: Seg, x0: number, y0: number, a: number, b: number): { pts: number[]; pad: number } {
  switch (g.t) {
    case 'L':
      return { pts: [...segAt(g, x0, y0, a), ...segAt(g, x0, y0, b)], pad: 0 };
    case 'C':
      return { pts: subCubic([x0, y0, g.x1, g.y1, g.x2, g.y2, g.x, g.y], a, b), pad: 0 };
    case 'A': {
      const turn = Math.abs(g.a1 - g.a0) * (b - a);
      if (turn >= Math.PI) return { pts: [g.cx - g.rx, g.cy - g.ry, g.cx + g.rx, g.cy + g.ry], pad: 0 };
      const r = Math.max(Math.abs(g.rx), Math.abs(g.ry));
      return { pts: [...segAt(g, x0, y0, a), ...segAt(g, x0, y0, (a + b) / 2), ...segAt(g, x0, y0, b)], pad: r * (1 - Math.cos(turn / 2)) };
    }
    case 'X': {
      // No simple bound: five points of the piece, and half their spread around them.
      const pts: number[] = [];
      for (let k = 0; k <= 4; k++) pts.push(...segAt(g, x0, y0, a + ((b - a) * k) / 4));
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      for (let i = 0; i < pts.length; i += 2) {
        x1 = Math.min(x1, pts[i]);
        x2 = Math.max(x2, pts[i]);
        y1 = Math.min(y1, pts[i + 1]);
        y2 = Math.max(y2, pts[i + 1]);
      }
      return { pts, pad: Math.max(x2 - x1, y2 - y1) / 2 };
    }
  }
}

// --- dashes --------------------------------------------------------------------------------------

/** Most dashes in one target: beyond this they are finer than pixels, and the stroke draws solid. */
const MAX_DASHES = 20000;

/**
 * The dashes of contours, as open contours (local units). `pattern`: dash, gap... in local units.
 * `box`: the target (target units of A); `reach`: how far the stroke reaches past its center line
 * there. Null: the dashes are too fine to show, so the stroke draws solid.
 */
export function dashContours(cs: Contour[], pattern: number[], A: Affine, box: Box | null, reach: number): Contour[] | null {
  const pat = pattern.length % 2 ? [...pattern, ...pattern] : pattern;
  const period = pat.reduce((a, b) => a + b, 0);
  if (!(period > 0) || period * maxScale(A) < 1.5) return null;
  const starts: number[] = [];
  let acc = 0;
  for (const p of pat) {
    starts.push(acc);
    acc += p;
  }
  const out: Contour[] = [];
  const far = (g: Seg, x0: number, y0: number, a: number, b: number) => {
    if (!box) return false;
    const { pts, pad } = pieceHull(g, x0, y0, a, b);
    let X0 = Infinity, Y0 = Infinity, X1 = -Infinity, Y1 = -Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      const X = A[0] * pts[i] + A[2] * pts[i + 1] + A[4], Y = A[1] * pts[i] + A[3] * pts[i + 1] + A[5];
      X0 = Math.min(X0, X);
      X1 = Math.max(X1, X);
      Y0 = Math.min(Y0, Y);
      Y1 = Math.max(Y1, Y);
    }
    const g2 = pad * maxScale(A) + reach + 2;
    return X1 < box[0] - g2 || X0 > box[2] + g2 || Y1 < box[1] - g2 || Y0 > box[3] + g2;
  };
  for (const c of cs) {
    let cur: Contour | null = null;
    let curEnd = NaN;
    /** The dashes on a piece of a segment (t from ta to tb), which starts at length o of the contour. */
    const emit = (g: Seg, x0: number, y0: number, ta: number, tb: number, o: number, len: number) => {
      const end = o + len;
      // The pattern entry at offset o, and where it started.
      const pos = o % period;
      let k = 0;
      while (k + 1 < pat.length && starts[k + 1] <= pos) k++;
      for (let s = o - (pos - starts[k]); s < end; k = (k + 1) % pat.length) {
        const e = s + pat[k];
        // A dash (even entries) on this piece. A dot (a dash of length 0) counts where it is.
        const a = Math.max(s, o), b = Math.min(e, end);
        if (k % 2 === 0 && (b > a || (pat[k] === 0 && s >= o))) {
          const piece = subSeg(g, x0, y0, paramAt(g, x0, y0, ta, tb, len, a - o), paramAt(g, x0, y0, ta, tb, len, b - o));
          // A dash that goes on from the piece before continues its contour (no cap in between).
          if (cur && a === o && Math.abs(curEnd - o) <= 1e-9 * (Math.abs(o) + period)) cur.segs.push(piece.seg);
          else {
            cur = { x: piece.x, y: piece.y, closed: false, segs: [piece.seg] };
            out.push(cur);
          }
          curEnd = b;
          if (e < end) cur = null;
        }
        s = e;
      }
    };
    const walk = (g: Seg, x0: number, y0: number, ta: number, tb: number, o: number, len: number, depth: number) => {
      if (out.length > MAX_DASHES) return;
      if (far(g, x0, y0, ta, tb)) {
        cur = null;
        return;
      }
      if (len > period * 8 && depth < 48) {
        const tm = (ta + tb) / 2;
        const l1 = segLength(g, x0, y0, ta, tm);
        walk(g, x0, y0, ta, tm, o, l1, depth + 1);
        walk(g, x0, y0, tm, tb, o + l1, segLength(g, x0, y0, tm, tb), depth + 1);
        return;
      }
      emit(g, x0, y0, ta, tb, o, len);
    };
    let x = c.x, y = c.y, o = 0;
    const segs = c.segs.slice();
    // A closed contour ends where it starts (add the closing line when the segments do not).
    if (c.closed && segs.length) {
      const [ex, ey] = segEnd(segs[segs.length - 1], ...lastStart(c));
      if (ex !== c.x || ey !== c.y) segs.push({ t: 'L', x: c.x, y: c.y });
    }
    for (const g of segs) {
      const len = segLength(g, x, y);
      if (len > 0) walk(g, x, y, 0, 1, o, len, 0);
      o += len;
      [x, y] = segEnd(g, x, y);
    }
    if (out.length > MAX_DASHES) return null;
  }
  return out;
}

/** Where the last segment of a contour starts. */
function lastStart(c: Contour): Pt {
  let x = c.x, y = c.y;
  for (let i = 0; i + 1 < c.segs.length; i++) [x, y] = segEnd(c.segs[i], x, y);
  return [x, y];
}

// --- arrowheads ----------------------------------------------------------------------------------

/** Sizes in stroke widths: the length of a head along the line, and its half width across it. */
const HEAD_LEN = 4;
const HEAD_HALF = 2;
/** How far a line stops before the tip of a filled arrow (its end and its cap stay under the head). */
const TRIM: Record<ArrowKind, number> = { none: 0, arrow: 2, open: 0, circle: 0, bar: 0 };

/** How far heads reach past the line's end points, in stroke widths. */
export const HEAD_REACH = 3;

/** The point at length d along a contour (d from 0 to its length), and the contour from length d0 to d1. */
function measure(c: Contour) {
  const segs: { g: Seg; x0: number; y0: number; len: number }[] = [];
  let x = c.x, y = c.y, total = 0;
  for (const g of c.segs) {
    const len = segLength(g, x, y);
    segs.push({ g, x0: x, y0: y, len });
    total += len;
    [x, y] = segEnd(g, x, y);
  }
  const at = (d: number): Pt => {
    let o = 0;
    for (const s of segs) {
      if (d <= o + s.len || s === segs[segs.length - 1]) return segAt(s.g, s.x0, s.y0, paramAt(s.g, s.x0, s.y0, 0, 1, s.len, d - o));
      o += s.len;
    }
    return [c.x, c.y];
  };
  const part = (d0: number, d1: number): Contour | null => {
    let o = 0;
    let out: Contour | null = null;
    for (const s of segs) {
      const a = Math.max(d0, o), b = Math.min(d1, o + s.len);
      if (b > a || (s.len === 0 && a === b && o >= d0 && o <= d1)) {
        const piece = subSeg(s.g, s.x0, s.y0, paramAt(s.g, s.x0, s.y0, 0, 1, s.len, a - o), paramAt(s.g, s.x0, s.y0, 0, 1, s.len, b - o));
        if (!out) out = { x: piece.x, y: piece.y, closed: false, segs: [] };
        out.segs.push(piece.seg);
      }
      o += s.len;
    }
    return out;
  };
  return { segs, total, at, part };
}

/** A head (target units, polygons with a positive area): `tip` its point, (dx, dy) the way it points. */
function headPolys(kind: ArrowKind, tip: Pt, dx: number, dy: number, w: number, s: Pick<ShapeInput, 'cap' | 'join'>, A: Affine, box: Box, tol: number): number[][] {
  const nx = -dy, ny = dx;
  const T = (x: number, y: number): Pt => [A[0] * x + A[2] * y + A[4], A[1] * x + A[3] * y + A[5]];
  const poly = (local: number[]) => {
    const p: number[] = [];
    for (let i = 0; i < local.length; i += 2) p.push(...T(local[i], local[i + 1]));
    if (signedArea(p) < 0) {
      for (let i = 0, j = p.length - 2; i < j; i += 2, j -= 2) {
        [p[i], p[j]] = [p[j], p[i]];
        [p[i + 1], p[j + 1]] = [p[j + 1], p[i + 1]];
      }
    }
    const c = clipPolygon(p, box);
    return c.length >= 6 ? [c] : [];
  };
  const L = HEAD_LEN * w, H = HEAD_HALF * w;
  const [x, y] = tip;
  switch (kind) {
    case 'arrow':
      return poly([x, y, x - L * dx + H * nx, y - L * dy + H * ny, x - L * dx - H * nx, y - L * dy - H * ny]);
    case 'circle': {
      const r = 0.875 * H;
      const f = flattenContour({ x: x + r, y, closed: true, segs: [{ t: 'A', cx: x, cy: y, rx: r, ry: r, a0: 0, a1: 2 * Math.PI }] }, A, tol, box);
      return poly(f.pts);
    }
    case 'open': {
      // A V: two arms back from the tip, about 37° off the line.
      const ax = Math.cos(0.65) * L, ay = Math.sin(0.65) * L;
      const pts = [x - ax * dx + ay * nx, y - ax * dy + ay * ny, x, y, x - ax * dx - ay * nx, y - ax * dy - ay * ny];
      return strokePolygons({ pts, smooth: [false, false, false], closed: false }, w / 2, s.cap, s.join, A, box, tol);
    }
    case 'bar': {
      const b = 1.125 * H;
      return strokePolygons({ pts: [x + b * nx, y + b * ny, x - b * nx, y - b * ny], smooth: [false, false], closed: false }, w / 2, 'butt', s.join, A, box, tol);
    }
    default:
      return [];
  }
}

/**
 * What a shape's stroke covers, with its style: the contours to stroke (shortened for arrows,
 * cut into dashes), and the arrowheads as polygons in target units. `box`: the target, `reach`:
 * how far the stroke reaches past its center line there (target units).
 */
export function styledStroke(s: ShapeInput, cs: Contour[], A: Affine, box: Box, reach: number, tol: number): { lines: Contour[]; heads: number[][] } {
  const w = s.strokeWidth;
  let lines = cs;
  const heads: number[][] = [];
  const arrows = s.arrows && centerOnly(s) && (s.arrows[0] !== 'none' || s.arrows[1] !== 'none') ? s.arrows : null;
  if (arrows) {
    lines = [];
    for (const c of cs) {
      if (c.closed) {
        lines.push(c);
        continue;
      }
      const m = measure(c);
      for (const start of [true, false]) {
        const kind = arrows[start ? 0 : 1];
        if (kind === 'none') continue;
        // The head points from a point one head length back along the curve to the end.
        const tip = start ? ([c.x, c.y] as Pt) : m.at(m.total);
        const base = m.at(start ? Math.min(HEAD_LEN * w, m.total) : Math.max(0, m.total - HEAD_LEN * w));
        let dx = tip[0] - base[0], dy = tip[1] - base[1];
        let l = Math.hypot(dx, dy);
        if (!(l > 0)) {
          // No length to point along: the direction of the end segment.
          const seg = start ? m.segs[0] : m.segs[m.segs.length - 1];
          const tg = seg ? tangents(seg.g, seg.x0, seg.y0) : [1, 0, 1, 0];
          [dx, dy] = start ? [-tg[0], -tg[1]] : [tg[2], tg[3]];
          l = Math.hypot(dx, dy) || 1;
        }
        heads.push(...headPolys(kind, tip, dx / l, dy / l, w, s, A, box, tol));
      }
      const d0 = TRIM[arrows[0]] * w, d1 = m.total - TRIM[arrows[1]] * w;
      if (d1 > d0) {
        const part = d0 > 0 || d1 < m.total ? m.part(d0, d1) : c;
        if (part) lines.push(part);
      }
    }
  }
  if (s.dash?.some((d) => d > 0)) {
    const d = dashContours(lines, s.dash.map((x) => x * w), A, box, reach);
    if (d) lines = d;
  }
  return { lines, heads };
}
