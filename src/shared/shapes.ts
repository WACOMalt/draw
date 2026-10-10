// Vector shapes: outlines, bounds, transforms and hit tests. The server, the renderers, the tile
// worker and the editor share this file.
//
// A shape is a frame (0, 0)–(w, h) in local units, mapped to the world by the affine `m`. Its
// outline is a list of contours made of lines and elliptical arcs, in local units. To draw or
// test it, a contour is flattened into points through a "target" affine A (local → target
// pixels, or local → world relative to a point). All math is double precision, and the arcs
// are refined only where they come near the target box: a shape a billion pixels wide stays
// exact in a 256 px tile, with a few dozen points.

import { compose, validAffine } from './layers';
import { POINT_STRIDE, type Affine, type CompoundPart, type CustomShape, type PathContour, type Shape, type ShapeInput, type ShapeKind, type ShapeProps } from './types';
import { insideResult, joinPieces, outlinePieces, type BoolPart } from './boolean';

/** Miter joins longer than this many half widths become bevels (as SVG's default of 4). */
export const MITER_LIMIT = 4;

export type Seg =
  | { t: 'L'; x: number; y: number }
  /** A cubic Bezier from the current point, with the control points (x1, y1) and (x2, y2). */
  | { t: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  /**
   * An x-spline segment from p1 to p2 (p: p0, p1, p2, p3 as 8 numbers; s1, s2: the smoothness
   * of p1 and p2). It starts at the current point (xAt(t = 0)) and ends at (x, y) = xAt(1).
   * `t0`, `t1`: only that part of it (a dash; absent: 0 and 1).
   */
  | { t: 'X'; p: number[]; s1: number; s2: number; x: number; y: number; t0?: number; t1?: number }
  /** An arc of the axis-aligned ellipse (cx, cy, rx, ry) from angle a0 to a1 (radians, either way). */
  | { t: 'A'; cx: number; cy: number; rx: number; ry: number; a0: number; a1: number };

export interface Contour {
  /** Start point. */
  x: number;
  y: number;
  closed: boolean;
  segs: Seg[];
}

/** A box in target units: x0, y0, x1, y1. */
export type Box = [number, number, number, number];

/** The geometry fields of a shape (what its outline depends on). */
export type ShapeGeo = Pick<ShapeProps, 'w' | 'h' | 'radii' | 'sides' | 'points' | 'innerRatio' | 'rounding' | 'line' | 'path' | 'curve' | 'parts' | 'arc' | 'hole' | 'preset'> & { kind: ShapeKind };

// --- outlines --------------------------------------------------------------------------------

/** Corner radii that fit the frame: scaled down together, as CSS does, when two would overlap. */
export function fitRadii(w: number, h: number, r: [number, number, number, number]): [number, number, number, number] {
  const [tl, tr, br, bl] = r.map((v) => Math.max(0, v));
  let f = 1;
  const lim = (len: number, a: number, b: number) => {
    if (a + b > len) f = Math.min(f, len / (a + b));
  };
  lim(w, tl, tr);
  lim(w, bl, br);
  lim(h, tl, bl);
  lim(h, tr, br);
  return [tl * f, tr * f, br * f, bl * f];
}

/** The corners of a polygon or star, scaled to fill the frame. Clockwise on screen, top first. */
export function cornerPoints(s: ShapeGeo): number[] {
  const star = s.kind === 'star';
  const n = star ? (s.points ?? 5) * 2 : (s.sides ?? 6);
  const inner = s.innerRatio ?? 0.5;
  const raw: number[] = [];
  for (let k = 0; k < n; k++) {
    const a = -Math.PI / 2 + (2 * Math.PI * k) / n;
    const r = star && k % 2 ? inner : 1;
    raw.push(r * Math.cos(a), r * Math.sin(a));
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < raw.length; i += 2) {
    x0 = Math.min(x0, raw[i]);
    x1 = Math.max(x1, raw[i]);
    y0 = Math.min(y0, raw[i + 1]);
    y1 = Math.max(y1, raw[i + 1]);
  }
  const sx = x1 > x0 ? s.w / (x1 - x0) : 0, sy = y1 > y0 ? s.h / (y1 - y0) : 0;
  const out: number[] = [];
  for (let i = 0; i < raw.length; i += 2) out.push((raw[i] - x0) * sx, (raw[i + 1] - y0) * sy);
  return out;
}

/** A closed polygon with every corner rounded by up to `radius` (each corner gets what fits). */
function roundedPolygon(p: number[], radius: number): Contour {
  const n = p.length / 2;
  if (!(radius > 0)) {
    const segs: Seg[] = [];
    for (let i = 1; i < n; i++) segs.push({ t: 'L', x: p[2 * i], y: p[2 * i + 1] });
    segs.push({ t: 'L', x: p[0], y: p[1] });
    return { x: p[0], y: p[1], closed: true, segs };
  }
  // For each corner: where the arc meets the two edges (T1 toward the previous corner, T2 toward
  // the next), and the arc itself.
  const corners = [];
  for (let i = 0; i < n; i++) {
    const vx = p[2 * i], vy = p[2 * i + 1];
    const j = (i + n - 1) % n, k = (i + 1) % n;
    let ax = p[2 * j] - vx, ay = p[2 * j + 1] - vy;
    let bx = p[2 * k] - vx, by = p[2 * k + 1] - vy;
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la === 0 || lb === 0) {
      corners.push({ t1: [vx, vy], t2: [vx, vy], arc: null });
      continue;
    }
    ax /= la;
    ay /= la;
    bx /= lb;
    by /= lb;
    const cos = Math.max(-1, Math.min(1, ax * bx + ay * by));
    const phi = Math.acos(cos); // the corner's inner angle
    if (phi < 1e-9 || phi > Math.PI - 1e-9) {
      corners.push({ t1: [vx, vy], t2: [vx, vy], arc: null });
      continue;
    }
    const tan = Math.tan(phi / 2);
    let d = radius / tan; // distance from the corner to where the arc meets an edge
    const dMax = Math.min(la, lb) / 2;
    let r = radius;
    if (d > dMax) {
      d = dMax;
      r = d * tan;
    }
    const t1: [number, number] = [vx + ax * d, vy + ay * d];
    const t2: [number, number] = [vx + bx * d, vy + by * d];
    let mx = ax + bx, my = ay + by;
    const ml = Math.hypot(mx, my);
    mx /= ml;
    my /= ml;
    const cd = r / Math.sin(phi / 2);
    const cx = vx + mx * cd, cy = vy + my * cd;
    const a0 = Math.atan2(t1[1] - cy, t1[0] - cx);
    let a1 = Math.atan2(t2[1] - cy, t2[0] - cx);
    // The short way round: the arc turns less than half a circle.
    while (a1 - a0 > Math.PI) a1 -= 2 * Math.PI;
    while (a1 - a0 < -Math.PI) a1 += 2 * Math.PI;
    corners.push({ t1, t2, arc: { t: 'A', cx, cy, rx: r, ry: r, a0, a1 } as Seg });
  }
  const segs: Seg[] = [];
  const c0 = corners[0];
  if (c0.arc) segs.push(c0.arc);
  // An edge that the two arcs fill completely (the rounding as large as fits) has no straight
  // part left: leave out that empty line. Its direction is noise, and a stroke drew a miter
  // spike on it.
  let size = 0;
  for (let i = 0; i < p.length; i++) size = Math.max(size, Math.abs(p[i]));
  const eps = size * 1e-9;
  for (let i = 1; i <= n; i++) {
    const prev = corners[i - 1], c = corners[i % n];
    if (Math.hypot(c.t1[0] - prev.t2[0], c.t1[1] - prev.t2[1]) > eps) segs.push({ t: 'L', x: c.t1[0], y: c.t1[1] });
    if (i < n && c.arc) segs.push(c.arc);
  }
  return { x: c0.t1[0], y: c0.t1[1], closed: true, segs };
}

/** The outline of a shape in local units. */
export function shapeContours(s: ShapeGeo): Contour[] {
  const { w, h } = s;
  switch (s.kind) {
    case 'rect': {
      const [tl, tr, br, bl] = fitRadii(w, h, s.radii ?? [0, 0, 0, 0]);
      const segs: Seg[] = [];
      const arc = (cx: number, cy: number, r: number, a0: number) => {
        if (r > 0) segs.push({ t: 'A', cx, cy, rx: r, ry: r, a0, a1: a0 + Math.PI / 2 });
      };
      segs.push({ t: 'L', x: w - tr, y: 0 });
      arc(w - tr, tr, tr, -Math.PI / 2);
      segs.push({ t: 'L', x: w, y: h - br });
      arc(w - br, h - br, br, 0);
      segs.push({ t: 'L', x: bl, y: h });
      arc(bl, h - bl, bl, Math.PI / 2);
      segs.push({ t: 'L', x: 0, y: tl });
      arc(tl, tl, tl, Math.PI);
      return [{ x: tl, y: 0, closed: true, segs }];
    }
    case 'ellipse':
      return ellipseContours(w, h, s.arc, s.hole);
    case 'custom': {
      const k: Affine = [w / 100, 0, 0, h / 100, 0, 0];
      return mapPath(CUSTOM_PATHS[s.preset ?? 'heart'] ?? [], k).map(pathContour);
    }
    case 'polygon':
    case 'star':
      return [roundedPolygon(cornerPoints(s), s.rounding ?? 0)];
    case 'line': {
      const [x0, y0, x1, y1] = s.line ?? [0, 0, w, h];
      return [{ x: x0, y: y0, closed: false, segs: [{ t: 'L', x: x1, y: y1 }] }];
    }
    case 'path':
      return (s.path ?? []).filter((c) => c.pts.length >= POINT_STRIDE).map((c) => (s.curve === 'spline' ? splineContour(c) : pathContour(c)));
    case 'compound':
      // Every part's outline (the result's own outline: compoundOutline).
      return (s.parts ?? []).flatMap((p) => {
        const pp = partPath(p);
        return pp.path.filter((c) => c.pts.length >= POINT_STRIDE).map((c) => (pp.curve === 'spline' ? splineContour(c) : pathContour(c)));
      });
  }
}

/**
 * The start and end of a pie slice in radians (end > start, less than one turn more), or null
 * for the whole ellipse. Angles are degrees on the circle before the frame stretches it: 0 is
 * right, 90 is down (clockwise on screen).
 */
export function arcRange(arc: [number, number] | undefined): [number, number] | null {
  if (!arc) return null;
  const sweep = (((arc[1] - arc[0]) % 360) + 360) % 360;
  if (sweep === 0) return null;
  const a0 = (arc[0] * Math.PI) / 180;
  return [a0, a0 + (sweep * Math.PI) / 180];
}

/** An ellipse, a ring (with a hole), a pie slice, or a slice of a ring. */
function ellipseContours(w: number, h: number, arc: [number, number] | undefined, hole: number | undefined): Contour[] {
  const cx = w / 2, cy = h / 2, rx = w / 2, ry = h / 2;
  const k = Math.max(0, Math.min(0.99, hole ?? 0));
  const range = arcRange(arc);
  if (!range) {
    const out: Contour[] = [{ x: w, y: cy, closed: true, segs: [{ t: 'A', cx, cy, rx, ry, a0: 0, a1: 2 * Math.PI }] }];
    // The hole turns the other way: the nonzero fill leaves it empty.
    if (k > 0) out.push({ x: cx + rx * k, y: cy, closed: true, segs: [{ t: 'A', cx, cy, rx: rx * k, ry: ry * k, a0: 2 * Math.PI, a1: 0 }] });
    return out;
  }
  const [a0, a1] = range;
  const segs: Seg[] = [{ t: 'A', cx, cy, rx, ry, a0, a1 }];
  if (k > 0) {
    segs.push({ t: 'L', x: cx + rx * k * Math.cos(a1), y: cy + ry * k * Math.sin(a1) });
    segs.push({ t: 'A', cx, cy, rx: rx * k, ry: ry * k, a0: a1, a1: a0 });
  } else segs.push({ t: 'L', x: cx, y: cy });
  return [{ x: cx + rx * Math.cos(a0), y: cy + ry * Math.sin(a0), closed: true, segs }];
}

// --- custom shapes ----------------------------------------------------------------------------

/**
 * Path contours from SVG path data with absolute M, L, H, V, C and Z commands. A point is a
 * corner, or smooth where its two handles are on one line.
 */
function svgPath(d: string): PathContour[] {
  const tok = d.match(/[MLHVCZ]|-?[\d.]+/g) ?? [];
  const out: PathContour[] = [];
  let pts: number[][] = [];
  let i = 0, cmd = '';
  const num = () => +tok[i++];
  const end = (closed: boolean) => {
    if (!pts.length) return;
    const first = pts[0], last = pts[pts.length - 1];
    if (closed && pts.length > 1 && last[0] === first[0] && last[1] === first[1]) {
      first[2] = last[2];
      first[3] = last[3];
      pts.pop();
    }
    const flat: number[] = [];
    for (const q of pts) {
      const ax = q[0] - q[2], ay = q[1] - q[3], bx = q[4] - q[0], by = q[5] - q[1];
      const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
      flat.push(q[0], q[1], q[2], q[3], q[4], q[5], la > 0 && lb > 0 && (ax * bx + ay * by) / (la * lb) > Math.cos(0.02) ? 1 : 0);
    }
    out.push({ closed, pts: flat });
    pts = [];
  };
  const to = (x: number, y: number) => pts.push([x, y, x, y, x, y]);
  while (i < tok.length) {
    if (/[A-Z]/.test(tok[i])) cmd = tok[i++];
    const cur = pts[pts.length - 1];
    if (cmd === 'M') {
      end(false);
      to(num(), num());
      cmd = 'L';
    } else if (cmd === 'L') to(num(), num());
    else if (cmd === 'H') to(num(), cur[1]);
    else if (cmd === 'V') to(cur[0], num());
    else if (cmd === 'C') {
      const [x1, y1, x2, y2, x, y] = [num(), num(), num(), num(), num(), num()];
      cur[4] = x1;
      cur[5] = y1;
      pts.push([x, y, x2, y2, x, y]);
    } else if (cmd === 'Z') end(true);
  }
  end(false);
  return out;
}

/** A starburst: `n` points, the inner radius a fraction of the outer one. */
function burst(n: number, inner: number): string {
  let d = '';
  for (let k = 0; k < 2 * n; k++) {
    const a = -Math.PI / 2 + (Math.PI * k) / n, r = k % 2 ? 48 * inner : 48;
    d += `${k ? 'L' : 'M'}${(50 + r * Math.cos(a)).toFixed(3)} ${(50 + r * Math.sin(a)).toFixed(3)} `;
  }
  return d + 'Z';
}

/** The outlines of the custom shapes, in a 100 × 100 box (the frame stretches them). */
export const CUSTOM_PATHS: Record<CustomShape, PathContour[]> = {
  heart: svgPath('M50 92 C26 74 2 56 2 32 C2 16 14 5 28 5 C38 5 46 11 50 19 C54 11 62 5 72 5 C86 5 98 16 98 32 C98 56 74 74 50 92 Z'),
  bubble: svgPath('M16 6 H84 C92 6 98 12 98 20 V60 C98 68 92 74 84 74 H46 L22 95 L28 74 H16 C8 74 2 68 2 60 V20 C2 12 8 6 16 6 Z'),
  arrow: svgPath('M2 34 H56 V10 L98 50 L56 90 V66 H2 Z'),
  cloud: svgPath('M24 82 C11 82 2 72 2 60 C2 48 11 39 23 39 C24 25 35 15 49 15 C60 15 69 21 74 31 C88 31 98 42 98 56 C98 70 87 82 73 82 Z'),
  check: svgPath('M4 54 L18 40 L38 60 L82 14 L96 28 L38 88 Z'),
  bolt: svgPath('M60 2 L14 58 H46 L36 98 L86 38 H54 Z'),
  moon: svgPath('M66 4 C40 6 16 26 16 54 C16 80 37 98 62 98 C76 98 88 92 96 82 C70 86 44 68 44 40 C44 24 52 11 66 4 Z'),
  drop: svgPath('M50 2 C50 2 14 46 14 64 C14 84 30 98 50 98 C70 98 86 84 86 64 C86 46 50 2 50 2 Z'),
  plus: svgPath('M36 2 H64 V36 H98 V64 H64 V98 H36 V64 H2 V36 H36 Z'),
  banner: svgPath('M2 20 H98 L84 50 L98 80 H2 L16 50 Z'),
  burst: svgPath(burst(16, 0.8)),
  // The hole turns the other way: the nonzero fill leaves it empty.
  frame: svgPath('M2 2 H98 V98 H2 Z M20 20 V80 H80 V20 Z'),
};

// --- compound shapes -------------------------------------------------------------------------

/** A path mapped by an affine (an x-spline maps exactly too: its weights sum to one). */
function mapPath(path: PathContour[], m: Affine): PathContour[] {
  return path.map((c) => {
    const pts = c.pts.slice();
    for (let i = 0; i < pts.length; i += POINT_STRIDE) {
      for (let k = 0; k < 6; k += 2) {
        const x = pts[i + k], y = pts[i + k + 1];
        pts[i + k] = tx(m, x, y);
        pts[i + k + 1] = ty(m, x, y);
      }
    }
    return { closed: c.closed, pts };
  });
}

/** A part of a compound as a path in the compound's local units (Bezier, or its own spline). */
export function partPath(p: CompoundPart): { path: PathContour[]; curve: 'bezier' | 'spline' } {
  const spline = p.kind === 'path' && p.curve === 'spline';
  const local = p.kind === 'path' ? (p.path ?? []) : toPath({ ...p, kind: p.kind } as ShapeGeo);
  return { path: mapPath(local, p.m), curve: spline ? 'spline' : 'bezier' };
}

/** The parts of a compound as boolean rings, flattened through A to `tol` (refined near `box`). */
export function compoundRings(s: Pick<ShapeGeo, 'parts'>, A: Affine, tol: number, box: Box | null, reach = 0): BoolPart[] {
  return (s.parts ?? []).map((p) => {
    const pp = partPath(p);
    const rings = pp.path
      .filter((c) => c.pts.length >= 2 * POINT_STRIDE)
      .map((c) => {
        const f = flattenContour(pp.curve === 'spline' ? splineContour(c) : pathContour(c), A, tol, box, reach);
        const r: number[] = [];
        for (let i = 0; i < f.pts.length; i += 2) r.push(tx(A, f.pts[i], f.pts[i + 1]), ty(A, f.pts[i], f.pts[i + 1]));
        return r;
      });
    return { op: p.op, rings };
  });
}

/**
 * The outline of a compound's result as one Bezier path (local units): what "flatten to one path"
 * makes. The parts' own curves stay, cut where they cross; only the crossing points come from a
 * fine flattening (within a millionth of the size).
 */
export function compoundToPath(s: Pick<ShapeGeo, 'parts'>): PathContour[] {
  // Each part as Bezier contours; each contour flattened, every flat point knowing its curve and t.
  type Src = { seg: number[]; t: number }; // seg: 8 numbers (a line has its handles at its ends)
  const parts: BoolPart[] = [];
  const meta: Src[][][] = [];
  let size = 0;
  for (const p of s.parts ?? []) {
    const pp = partPath(p);
    const bez = pp.curve === 'spline' ? toPath({ kind: 'path', w: 0, h: 0, path: pp.path, curve: 'spline' }) : pp.path;
    const [x0, y0, x1, y1] = pathBounds(bez);
    size = Math.max(size, x1 - x0, y1 - y0);
    parts.push({ op: p.op, rings: [] });
    meta.push([]);
    for (const c of bez) {
      if (c.pts.length < 2 * POINT_STRIDE) continue;
      const n = c.pts.length / POINT_STRIDE;
      const ring: number[] = [];
      const src: Src[] = [];
      const segs = c.closed ? n : n - 1;
      for (let i = 0; i < segs; i++) {
        const a = i * POINT_STRIDE, b = ((i + 1) % n) * POINT_STRIDE, q = c.pts;
        const seg = [q[a], q[a + 1], q[a + 4], q[a + 5], q[b + 2], q[b + 3], q[b], q[b + 1]];
        ring.push(seg[0], seg[1]);
        src.push({ seg, t: 0 });
        const straight = seg[2] === seg[0] && seg[3] === seg[1] && seg[4] === seg[6] && seg[5] === seg[7];
        if (!straight) {
          const N = 64;
          for (let k = 1; k < N; k++) {
            const [x, y] = cubicAt(seg, k / N);
            ring.push(x, y);
            src.push({ seg, t: k / N });
          }
        }
      }
      if (!c.closed) {
        // An open contour fills as if closed: its closing line is part of the outline.
        ring.push(c.pts[(n - 1) * POINT_STRIDE], c.pts[(n - 1) * POINT_STRIDE + 1]);
        src.push({ seg: [], t: 0 });
      }
      parts[parts.length - 1].rings.push(ring);
      meta[meta.length - 1].push(src);
    }
  }
  const chains = joinPieces(outlinePieces(parts));
  const out: PathContour[] = [];
  for (const ch of chains) {
    // Runs of pieces on one curve become one cut of that curve.
    type Run = { seg: number[]; ta: number; tb: number; ax: number; ay: number; bx: number; by: number };
    const runs: Run[] = [];
    for (const pc of ch.pieces) {
      const src = meta[pc.part][pc.ring];
      const a = src[pc.edge], b = src[(pc.edge + 1) % src.length];
      // The edge's curve and its t range (the next flat point may start the next curve: t = 1).
      const seg = a.seg;
      const tEnd = b.seg === seg ? b.t : 1;
      const ta = a.t + (tEnd - a.t) * pc.t0, tb = a.t + (tEnd - a.t) * pc.t1;
      const last = runs[runs.length - 1];
      if (last && last.seg === seg && seg.length && Math.abs(last.tb - ta) < 1e-9) {
        last.tb = tb;
        last.bx = pc.bx;
        last.by = pc.by;
      } else runs.push({ seg, ta, tb, ax: pc.ax, ay: pc.ay, bx: pc.bx, by: pc.by });
    }
    if (ch.closed && runs.length > 1) {
      // The loop may start in the middle of a run: join its last run to its first.
      const f = runs[0], l = runs[runs.length - 1];
      if (f.seg === l.seg && f.seg.length && Math.abs(l.tb - f.ta) < 1e-9) {
        f.ta = l.ta;
        f.ax = l.ax;
        f.ay = l.ay;
        runs.pop();
      }
    }
    const pts: number[] = [];
    const cubics = runs.map((r) => {
      if (!r.seg.length) return [r.ax, r.ay, r.ax, r.ay, r.bx, r.by, r.bx, r.by];
      const c = subCubic(r.seg, r.ta, r.tb);
      // The cut points of the outline join the runs exactly.
      const dx0 = r.ax - c[0], dy0 = r.ay - c[1], dx1 = r.bx - c[6], dy1 = r.by - c[7];
      return [r.ax, r.ay, c[2] + dx0, c[3] + dy0, c[4] + dx1, c[5] + dy1, r.bx, r.by];
    });
    const n = cubics.length;
    for (let i = 0; i < n; i++) {
      const c = cubics[i], prev = cubics[(i - 1 + n) % n];
      const hasPrev = ch.closed || i > 0;
      const ix = hasPrev ? prev[4] : c[0], iy = hasPrev ? prev[5] : c[1];
      const ax = c[0] - ix, ay = c[1] - iy, bx = c[2] - c[0], by = c[3] - c[1];
      const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
      const smooth = la > 0 && lb > 0 && (ax * bx + ay * by) / (la * lb) > Math.cos(0.0018);
      pts.push(c[0], c[1], ix, iy, c[2], c[3], smooth ? 1 : 0);
    }
    if (!ch.closed && n) {
      const c = cubics[n - 1];
      pts.push(c[6], c[7], c[4], c[5], c[6], c[7], 0);
    }
    if (pts.length >= 2 * POINT_STRIDE) out.push({ closed: ch.closed, pts });
  }
  return size > 0 ? out : [];
}

/** The part of a cubic from t = a to t = b (b < a: reversed). */
export function subCubic(c: number[], a: number, b: number): number[] {
  if (b < a) {
    const r = subCubic(c, b, a);
    return [r[6], r[7], r[4], r[5], r[2], r[3], r[0], r[1]];
  }
  const right = a > 0 ? splitCubic(c, a)[1] : c;
  return b < 1 ? splitCubic(right, (b - a) / (1 - a))[0] : right;
}

/** Whether a world point is in a compound's result (world units relative to the point). */
function compoundInside(s: ShapeInput, x: number, y: number, tol: number): boolean {
  const m = s.m;
  const A: Affine = [m[0], m[1], m[2], m[3], m[4] - x, m[5] - y];
  return insideResult(compoundRings(s, A, Math.max(tol / 4, 1e-300), [-tol * 4, -tol * 4, tol * 4, tol * 4]), 0, 0);
}

// --- x-splines ---------------------------------------------------------------------------------
// General x-splines (Blanc and Schlick, "X-Splines: a spline model designed for the end-user",
// SIGGRAPH 1995), as xfig draws them. A segment from p1 to p2 blends p0..p3 with weights that
// depend on the smoothness s1 of p1 and s2 of p2. q = -s/2 makes s = -1 a Catmull-Rom curve.

function xf(num: number, den: number): number {
  const p = 2 * den * den;
  const u = num / den;
  return u * u * u * (10 - p + (2 * p - 15) * u + (6 - p) * u * u);
}
const xg = (u: number, q: number) => u * (q + u * (2 * q + u * (8 - 12 * q + u * (14 * q - 11 + u * (4 - 5 * q)))));
const xh = (u: number, q: number) => u * (q + u * (2 * q + u * u * (-2 * q - u * q)));

/** A point of an x-spline segment (or of its part from t0 to t1) at t, 0 to 1. */
export function xSegAt(g: Extract<Seg, { t: 'X' }>, t: number): [number, number] {
  const t0 = g.t0 ?? 0, t1 = g.t1 ?? 1;
  return xAt(g.p, g.s1, g.s2, t0 + (t1 - t0) * t);
}

/** A point of an x-spline segment at t (0..1). */
export function xAt(p: number[], s1: number, s2: number, t: number): [number, number] {
  let a0: number, a1: number, a2: number, a3: number;
  if (s1 < 0) {
    a0 = xh(-t, -s1 / 2);
    a2 = xg(t, -s1 / 2);
  } else {
    a0 = t < s1 ? xf(t - s1, -1 - s1) : 0;
    a2 = xf(t + s1, 1 + s1);
  }
  if (s2 < 0) {
    a1 = xg(1 - t, -s2 / 2);
    a3 = xh(t - 1, -s2 / 2);
  } else {
    a1 = xf(t - 1 - s2, -1 - s2);
    a3 = t > 1 - s2 ? xf(t - 1 + s2, 1 + s2) : 0;
  }
  const w = a0 + a1 + a2 + a3;
  return [(a0 * p[0] + a1 * p[2] + a2 * p[4] + a3 * p[6]) / w, (a0 * p[1] + a1 * p[3] + a2 * p[5] + a3 * p[7]) / w];
}

/** The x-spline segments of a contour. An open contour starts and ends at its end points. */
export function splineSegs(c: PathContour): Extract<Seg, { t: 'X' }>[] {
  const S = POINT_STRIDE;
  const n = c.pts.length / S;
  const closed = c.closed && n > 2;
  const P = (i: number) => {
    const j = closed ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i));
    return [c.pts[j * S], c.pts[j * S + 1]];
  };
  // The ends of an open contour are sharp, so the curve starts and ends there.
  const sm = (i: number) => {
    const j = closed ? ((i % n) + n) % n : i;
    if (!closed && (j <= 0 || j >= n - 1)) return 0;
    return Math.max(-1, Math.min(1, c.pts[j * S + 6]));
  };
  const out: Extract<Seg, { t: 'X' }>[] = [];
  const count = closed ? n : n - 1;
  for (let i = 0; i < count; i++) {
    const p = [...P(i - 1), ...P(i), ...P(i + 1), ...P(i + 2)];
    const s1 = sm(i), s2 = sm(i + 1);
    const [x, y] = xAt(p, s1, s2, 1);
    out.push({ t: 'X', p, s1, s2, x, y });
  }
  return out;
}

function splineContour(c: PathContour): Contour {
  const segs = splineSegs(c);
  const [x, y] = segs.length ? xAt(segs[0].p, segs[0].s1, segs[0].s2, 0) : [c.pts[0], c.pts[1]];
  return { x, y, closed: c.closed && c.pts.length / POINT_STRIDE > 2, segs };
}

/** The segment from point a to point b of a path contour: straight when both handles are at their anchors. */
function pathSeg(p: number[], a: number, b: number): Seg {
  const S = POINT_STRIDE;
  const [x0, y0, ox, oy] = [p[a * S], p[a * S + 1], p[a * S + 4], p[a * S + 5]];
  const [x1, y1, ix, iy] = [p[b * S], p[b * S + 1], p[b * S + 2], p[b * S + 3]];
  if (ox === x0 && oy === y0 && ix === x1 && iy === y1) return { t: 'L', x: x1, y: y1 };
  return { t: 'C', x1: ox, y1: oy, x2: ix, y2: iy, x: x1, y: y1 };
}

function pathContour(c: PathContour): Contour {
  const n = c.pts.length / POINT_STRIDE;
  const segs: Seg[] = [];
  for (let i = 0; i + 1 < n; i++) segs.push(pathSeg(c.pts, i, i + 1));
  if (c.closed && n > 1) segs.push(pathSeg(c.pts, n - 1, 0));
  return { x: c.pts[0], y: c.pts[1], closed: c.closed && n > 1, segs };
}

// --- flattening ------------------------------------------------------------------------------

/** The largest factor by which the affine stretches a length (its largest singular value). */
export function maxScale(m: Affine): number {
  const [a, b, c, d] = m;
  const p = (a * a + b * b + c * c + d * d) / 2;
  const q = Math.abs(a * d - b * c);
  return Math.sqrt(p + Math.sqrt(Math.max(0, p * p - q * q)));
}

const tx = (A: Affine, x: number, y: number) => A[0] * x + A[2] * y + A[4];
const ty = (A: Affine, x: number, y: number) => A[1] * x + A[3] * y + A[5];

/** True when the box around the segment a–b, grown by `pad`, misses `box`. */
function misses(box: Box, ax: number, ay: number, bx: number, by: number, pad: number): boolean {
  return Math.max(ax, bx) + pad < box[0] || Math.min(ax, bx) - pad > box[2] || Math.max(ay, by) + pad < box[1] || Math.min(ay, by) - pad > box[3];
}

/** Distance from (px, py) to the segment a–b. */
function ptSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax, vy = by - ay;
  const l = vx * vx + vy * vy;
  const t = l > 0 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / l)) : 0;
  return Math.hypot(ax + t * vx - px, ay + t * vy - py);
}

/**
 * Points along an arc, after its start point, in local units. A piece becomes one chord when the
 * chord is within `tol` target units of the arc, or when no edge of what is drawn can cross `box`
 * there: neither the outline nor the edge of the stroke band `reach` (local units) around it.
 * Deep inside a wide stroke, or far from the box, a coarse chord gives the same pixels. Each point
 * gets a smooth flag: points inside the arc are smooth, the end point is not (the caller decides).
 */
function flattenArc(seg: Extract<Seg, { t: 'A' }>, A: Affine, scale: number, tol: number, box: Box | null, reach: number, pts: number[], smooth: boolean[]): void {
  const { cx, cy, rx, ry } = seg;
  const R = Math.max(Math.abs(rx), Math.abs(ry));
  const band = reach * scale;
  const px = (t: number) => cx + rx * Math.cos(t);
  const py = (t: number) => cy + ry * Math.sin(t);
  const sub = (t0: number, t1: number, depth: number, last: boolean) => {
    const dt = Math.abs(t1 - t0);
    if (dt <= Math.PI / 2 || depth > 60) {
      const k = 1 - Math.cos(dt / 2);
      // How far the arc can stray from the chord, and the offset edge of the band beside it.
      const dev = R * k * scale;
      const err = (R + reach) * k * scale;
      let done = err <= tol || depth > 60;
      if (!done && box) {
        const x0 = px(t0), y0 = py(t0), x1 = px(t1), y1 = py(t1);
        const ax = tx(A, x0, y0), ay = ty(A, x0, y0), bx = tx(A, x1, y1), by = ty(A, x1, y1);
        // The range of distances from the chord to points of the box.
        const dMin = Math.hypot(Math.max(0, box[0] - Math.max(ax, bx), Math.min(ax, bx) - box[2]), Math.max(0, box[1] - Math.max(ay, by), Math.min(ay, by) - box[3]));
        const m = err + 2;
        let near = dMin <= m;
        if (!near && band > 0 && dMin <= band + m) {
          const dMax = Math.max(ptSeg(box[0], box[1], ax, ay, bx, by), ptSeg(box[2], box[1], ax, ay, bx, by), ptSeg(box[2], box[3], ax, ay, bx, by), ptSeg(box[0], box[3], ax, ay, bx, by));
          near = dMax >= band - m;
        }
        done = !near;
      }
      if (done) {
        pts.push(px(t1), py(t1));
        smooth.push(!last);
        return;
      }
    }
    const tm = (t0 + t1) / 2;
    sub(t0, tm, depth + 1, false);
    sub(tm, t1, depth + 1, last);
  };
  sub(seg.a0, seg.a1, 0, true);
}

/**
 * Points along a cubic Bezier (p: the four control points, local units), after its start point:
 * the same refinement rules as flattenArc. A piece lies inside the box of its control points; its
 * distance from the chord is at most that of its two inner control points.
 */
function flattenCubic(p0: number[], A: Affine, scale: number, tol: number, box: Box | null, reach: number, pts: number[], smooth: boolean[]): void {
  const band = reach * scale;
  const sub = (p: number[], depth: number, last: boolean) => {
    const [x0, y0, x1, y1, x2, y2, x3, y3] = p;
    const dev = Math.max(ptSeg(x1, y1, x0, y0, x3, y3), ptSeg(x2, y2, x0, y0, x3, y3)) * scale;
    // The band beside the curve strays further where the piece turns.
    let turn = 0;
    if (reach > 0) {
      const ax = x1 - x0 || x2 - x0, ay = y1 - y0 || y2 - y0;
      const bx = x3 - x2 || x3 - x1, by = y3 - y2 || y3 - y1;
      const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
      if (la > 0 && lb > 0) turn = Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb))));
    }
    const err = dev + band * (1 - Math.cos(Math.min(turn, Math.PI) / 2));
    let done = (err <= tol && turn < Math.PI / 2) || depth > 40;
    if (!done && box && turn < Math.PI / 2) {
      let hx0 = Infinity, hy0 = Infinity, hx1 = -Infinity, hy1 = -Infinity;
      for (let i = 0; i < 8; i += 2) {
        const X = tx(A, p[i], p[i + 1]), Y = ty(A, p[i], p[i + 1]);
        hx0 = Math.min(hx0, X);
        hx1 = Math.max(hx1, X);
        hy0 = Math.min(hy0, Y);
        hy1 = Math.max(hy1, Y);
      }
      const dMin = Math.hypot(Math.max(0, box[0] - hx1, hx0 - box[2]), Math.max(0, box[1] - hy1, hy0 - box[3]));
      const m = err + 2;
      let near = dMin <= m;
      if (!near && band > 0 && dMin <= band + m) {
        const ax = tx(A, x0, y0), ay = ty(A, x0, y0), bx = tx(A, x3, y3), by = ty(A, x3, y3);
        const dMax = Math.max(ptSeg(box[0], box[1], ax, ay, bx, by), ptSeg(box[2], box[1], ax, ay, bx, by), ptSeg(box[2], box[3], ax, ay, bx, by), ptSeg(box[0], box[3], ax, ay, bx, by));
        near = dMax + dev >= band - m;
      }
      done = !near;
    }
    if (done) {
      pts.push(x3, y3);
      smooth.push(!last);
      return;
    }
    const [l, r] = splitCubic(p, 0.5);
    sub(l, depth + 1, false);
    sub(r, depth + 1, last);
  };
  sub(p0, 0, true);
}

/**
 * Points along an x-spline segment, after its start point: the rules of flattenCubic. Its
 * polynomials have no simple bound, so every segment splits at least three times (8 pieces); a
 * piece's distance from its chord is estimated from three inner points.
 */
function flattenSpline(seg: Extract<Seg, { t: 'X' }>, A: Affine, scale: number, tol: number, box: Box | null, reach: number, pts: number[], smooth: boolean[]): void {
  const band = reach * scale;
  const at = (t: number) => xSegAt(seg, t);
  const sub = (t0: number, a: [number, number], t1: number, b: [number, number], depth: number, last: boolean) => {
    const tm = (t0 + t1) / 2, m = at(tm);
    if (depth >= 3) {
      const q1 = at(t0 + (t1 - t0) / 4), q3 = at(t0 + ((t1 - t0) * 3) / 4);
      const dev = 1.5 * Math.max(ptSeg(m[0], m[1], a[0], a[1], b[0], b[1]), ptSeg(q1[0], q1[1], a[0], a[1], b[0], b[1]), ptSeg(q3[0], q3[1], a[0], a[1], b[0], b[1])) * scale;
      const ax = q1[0] - a[0], ay = q1[1] - a[1], bx = b[0] - q3[0], by = b[1] - q3[1];
      const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
      const turn = la > 0 && lb > 0 ? Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)))) : 0;
      const err = dev + band * (1 - Math.cos(Math.min(turn, Math.PI) / 2));
      let done = (err <= tol && turn < Math.PI / 2) || depth > 40;
      if (!done && box && turn < Math.PI / 2) {
        let hx0 = Infinity, hy0 = Infinity, hx1 = -Infinity, hy1 = -Infinity;
        for (const q of [a, b, m, q1, q3]) {
          const X = tx(A, q[0], q[1]), Y = ty(A, q[0], q[1]);
          hx0 = Math.min(hx0, X);
          hx1 = Math.max(hx1, X);
          hy0 = Math.min(hy0, Y);
          hy1 = Math.max(hy1, Y);
        }
        const g = dev + 2;
        const dMin = Math.hypot(Math.max(0, box[0] - hx1 - g, hx0 - g - box[2]), Math.max(0, box[1] - hy1 - g, hy0 - g - box[3]));
        let near = dMin <= err + 2;
        if (!near && band > 0 && dMin <= band + err + 2) {
          const AX = tx(A, a[0], a[1]), AY = ty(A, a[0], a[1]), BX = tx(A, b[0], b[1]), BY = ty(A, b[0], b[1]);
          const dMax = Math.max(ptSeg(box[0], box[1], AX, AY, BX, BY), ptSeg(box[2], box[1], AX, AY, BX, BY), ptSeg(box[2], box[3], AX, AY, BX, BY), ptSeg(box[0], box[3], AX, AY, BX, BY));
          near = dMax + dev >= band - err - 2;
        }
        done = !near;
      }
      if (done) {
        pts.push(b[0], b[1]);
        smooth.push(!last);
        return;
      }
    }
    sub(t0, a, tm, m, depth + 1, false);
    sub(tm, m, t1, b, depth + 1, last);
  };
  sub(0, at(0), 1, [seg.x, seg.y], 0, true);
}

/**
 * Cubics that follow an x-spline segment: the same ends and end directions, the handle lengths
 * fitted by least squares to points between. A piece that strays more than 0.2% of the segment
 * length splits in two.
 */
export function xToCubics(g: Extract<Seg, { t: 'X' }>): number[][] {
  const at = (t: number) => xSegAt(g, t);
  const a = at(0), b = at(1);
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) + 1e-300;
  const out: number[][] = [];
  const fit = (t0: number, t1: number, depth: number) => {
    const h = (t1 - t0) * 1e-4;
    const p0 = at(t0), p3 = at(t1);
    const d0 = at(t0 + h), d1 = at(t1 - h);
    // Unit directions at the ends.
    let ux = d0[0] - p0[0], uy = d0[1] - p0[1], vx = p3[0] - d1[0], vy = p3[1] - d1[1];
    const lu = Math.hypot(ux, uy) || 1, lv = Math.hypot(vx, vy) || 1;
    ux /= lu;
    uy /= lu;
    vx /= lv;
    vy /= lv;
    // B(t) = c0 p0 + c1 (p0 + al u) + c2 (p3 - be v) + c3 p3: linear in al, be.
    let m11 = 0, m12 = 0, m22 = 0, r1 = 0, r2 = 0;
    const N = 12;
    const samples: [number, number, number][] = [];
    for (let k = 1; k < N; k++) {
      const t = k / N, u = 1 - t;
      const c0 = u * u * u, c1 = 3 * u * u * t, c2 = 3 * u * t * t, c3 = t * t * t;
      const q = at(t0 + (t1 - t0) * t);
      samples.push([t, q[0], q[1]]);
      const bx = (c0 + c1) * p0[0] + (c2 + c3) * p3[0], by = (c0 + c1) * p0[1] + (c2 + c3) * p3[1];
      const ex = q[0] - bx, ey = q[1] - by;
      const ax = c1 * ux, ay = c1 * uy, cx = -c2 * vx, cy = -c2 * vy;
      m11 += ax * ax + ay * ay;
      m12 += ax * cx + ay * cy;
      m22 += cx * cx + cy * cy;
      r1 += ax * ex + ay * ey;
      r2 += cx * ex + cy * ey;
    }
    const det = m11 * m22 - m12 * m12;
    const chord = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]);
    let al = chord / 3, be = chord / 3;
    if (Math.abs(det) > 1e-300) {
      al = (r1 * m22 - r2 * m12) / det;
      be = (m11 * r2 - m12 * r1) / det;
    }
    const cub = [p0[0], p0[1], p0[0] + al * ux, p0[1] + al * uy, p3[0] - be * vx, p3[1] - be * vy, p3[0], p3[1]];
    let err = 0;
    for (const [t, qx, qy] of samples) {
      const c = cubicAt(cub, t);
      err = Math.max(err, Math.hypot(c[0] - qx, c[1] - qy));
    }
    if (err > len * 2e-3 && depth < 5) {
      const tm = (t0 + t1) / 2;
      fit(t0, tm, depth + 1);
      fit(tm, t1, depth + 1);
    } else out.push(cub);
  };
  fit(0, 1, 0);
  return out;
}

/** A cubic Bezier (8 numbers) cut in two at t (de Casteljau): the exact same curve. */
export function splitCubic(p: number[], t: number): [number[], number[]] {
  const [x0, y0, x1, y1, x2, y2, x3, y3] = p;
  const l = (a: number, b: number) => a + (b - a) * t;
  const ax = l(x0, x1), ay = l(y0, y1), bx = l(x1, x2), by = l(y1, y2), cx = l(x2, x3), cy = l(y2, y3);
  const dx = l(ax, bx), dy = l(ay, by), ex = l(bx, cx), ey = l(by, cy);
  const fx = l(dx, ex), fy = l(dy, ey);
  return [
    [x0, y0, ax, ay, dx, dy, fx, fy],
    [fx, fy, ex, ey, cx, cy, x3, y3],
  ];
}

/** A point on a cubic Bezier. */
export function cubicAt(p: number[], t: number): [number, number] {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return [a * p[0] + b * p[2] + c * p[4] + d * p[6], a * p[1] + b * p[3] + c * p[5] + d * p[7]];
}

/** Direction of a segment where it starts and where it ends (not normalized). */
export function tangents(seg: Seg, x: number, y: number): [number, number, number, number] {
  if (seg.t === 'L') return [seg.x - x, seg.y - y, seg.x - x, seg.y - y];
  if (seg.t === 'X') {
    const a = xSegAt(seg, 1e-4), b = xSegAt(seg, 1 - 1e-4);
    return [a[0] - x, a[1] - y, seg.x - b[0], seg.y - b[1]];
  }
  if (seg.t === 'C') {
    // A handle at its anchor gives no direction: the next control point does.
    const [sx, sy] = seg.x1 !== x || seg.y1 !== y ? [seg.x1 - x, seg.y1 - y] : seg.x2 !== x || seg.y2 !== y ? [seg.x2 - x, seg.y2 - y] : [seg.x - x, seg.y - y];
    const [ex, ey] = seg.x2 !== seg.x || seg.y2 !== seg.y ? [seg.x - seg.x2, seg.y - seg.y2] : seg.x1 !== seg.x || seg.y1 !== seg.y ? [seg.x - seg.x1, seg.y - seg.y1] : [seg.x - x, seg.y - y];
    return [sx, sy, ex, ey];
  }
  const s = seg.a1 >= seg.a0 ? 1 : -1;
  return [-seg.rx * Math.sin(seg.a0) * s, seg.ry * Math.cos(seg.a0) * s, -seg.rx * Math.sin(seg.a1) * s, seg.ry * Math.cos(seg.a1) * s];
}

/** True when two directions are the same (a tangent-continuous join: no corner). */
function sameDir(ax: number, ay: number, bx: number, by: number): boolean {
  const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
  if (la === 0 || lb === 0) return true;
  return Math.abs(ax * by - ay * bx) / (la * lb) < 1e-7 && ax * bx + ay * by > 0;
}

export interface Flat {
  /** Local x, y pairs. A closed contour does not repeat its start point. */
  pts: number[];
  /** Per point: true where the outline is smooth (no corner: joins there need no miter). */
  smooth: boolean[];
  closed: boolean;
}

/** A contour as points (local units), refined as flattenArc says. */
export function flattenContour(c: Contour, A: Affine, tol: number, box: Box | null = null, reach = 0): Flat {
  const scale = maxScale(A);
  const pts = [c.x, c.y];
  const smooth = [false];
  let x = c.x, y = c.y;
  const tans: [number, number, number, number][] = [];
  const startIdx: number[] = [];
  for (const seg of c.segs) {
    tans.push(tangents(seg, x, y));
    startIdx.push(smooth.length - 1);
    if (seg.t === 'L') {
      pts.push(seg.x, seg.y);
      smooth.push(false);
      x = seg.x;
      y = seg.y;
    } else if (seg.t === 'C') {
      flattenCubic([x, y, seg.x1, seg.y1, seg.x2, seg.y2, seg.x, seg.y], A, scale, tol, box, reach, pts, smooth);
      x = seg.x;
      y = seg.y;
    } else if (seg.t === 'X') {
      flattenSpline(seg, A, scale, tol, box, reach, pts, smooth);
      x = seg.x;
      y = seg.y;
    } else {
      flattenArc(seg, A, scale, tol, box, reach, pts, smooth);
      x = pts[pts.length - 2];
      y = pts[pts.length - 1];
    }
  }
  // Where two segments meet with the same direction, the outline has no corner.
  for (let i = 1; i < c.segs.length; i++) {
    const a = tans[i - 1], b = tans[i];
    if (sameDir(a[2], a[3], b[0], b[1])) smooth[startIdx[i]] = true;
  }
  if (c.closed) {
    const a = tans[tans.length - 1], b = tans[0];
    // Drop the end point when it repeats the start.
    const n = pts.length;
    if (n > 2 && Math.abs(pts[n - 2] - pts[0]) <= 1e-12 * (Math.abs(pts[0]) + 1) && Math.abs(pts[n - 1] - pts[1]) <= 1e-12 * (Math.abs(pts[1]) + 1)) {
      pts.length -= 2;
      smooth.pop();
    }
    smooth[0] = !!a && !!b && sameDir(a[2], a[3], b[0], b[1]);
  }
  return { pts, smooth, closed: c.closed };
}

// --- stroke outlines ---------------------------------------------------------------------------

/**
 * Polygons (target units, each with a positive area) whose union is the stroke of a flat
 * contour: a quad per segment, joins at corners, caps at open ends. `hw` is half the band width
 * in local units. Drawn with the nonzero rule, they make one stroke without overlaps showing.
 * Polygons that miss `box` are left out; the others are cut to it.
 */
export function strokePolygons(f: Flat, hw: number, cap: 'butt' | 'round' | 'square', join: 'miter' | 'round' | 'bevel', A: Affine, box: Box, tol: number): number[][] {
  const out: number[][] = [];
  const scale = maxScale(A);
  const add = (local: number[]) => {
    const p = new Array<number>(local.length);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < local.length; i += 2) {
      const x = tx(A, local[i], local[i + 1]), y = ty(A, local[i], local[i + 1]);
      p[i] = x;
      p[i + 1] = y;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    if (x1 < box[0] || x0 > box[2] || y1 < box[1] || y0 > box[3]) return;
    if (signedArea(p) < 0) reverse(p);
    const inside = x0 >= box[0] && x1 <= box[2] && y0 >= box[1] && y1 <= box[3];
    const c = inside ? p : clipPolygon(p, box);
    if (c.length >= 6) out.push(c);
  };
  const disk = (cx: number, cy: number) => {
    const X = tx(A, cx, cy), Y = ty(A, cx, cy), r = hw * scale;
    if (misses(box, X, Y, X, Y, r + 1)) return;
    const d = flattenContour({ x: cx + hw, y: cy, closed: true, segs: [{ t: 'A', cx, cy, rx: hw, ry: hw, a0: 0, a1: 2 * Math.PI }] }, A, tol, box);
    add(d.pts);
  };

  // Distinct points (zero-length segments have no direction).
  const pts: number[] = [];
  const smooth: boolean[] = [];
  for (let i = 0; i < f.pts.length; i += 2) {
    const n = pts.length;
    if (n && pts[n - 2] === f.pts[i] && pts[n - 1] === f.pts[i + 1]) continue;
    pts.push(f.pts[i], f.pts[i + 1]);
    smooth.push(f.smooth[i / 2]);
  }
  let n = pts.length / 2;
  if (f.closed && n > 1 && pts[0] === pts[2 * n - 2] && pts[1] === pts[2 * n - 1]) {
    pts.length -= 2;
    n--;
  }
  if (n === 1) {
    // A zero-length line: a dot with round caps, a square with square caps.
    if (cap === 'round') disk(pts[0], pts[1]);
    else if (cap === 'square') add([pts[0] - hw, pts[1] - hw, pts[0] + hw, pts[1] - hw, pts[0] + hw, pts[1] + hw, pts[0] - hw, pts[1] + hw]);
    return out;
  }
  const segCount = f.closed ? n : n - 1;
  // Unit direction of each segment.
  const dir: number[] = [];
  for (let i = 0; i < segCount; i++) {
    const j = (i + 1) % n;
    const dx = pts[2 * j] - pts[2 * i], dy = pts[2 * j + 1] - pts[2 * i + 1];
    const l = Math.hypot(dx, dy);
    dir.push(dx / l, dy / l);
  }
  for (let i = 0; i < segCount; i++) {
    const j = (i + 1) % n;
    const nx = -dir[2 * i + 1] * hw, ny = dir[2 * i] * hw;
    const ax = pts[2 * i], ay = pts[2 * i + 1], bx = pts[2 * j], by = pts[2 * j + 1];
    add([ax + nx, ay + ny, bx + nx, by + ny, bx - nx, by - ny, ax - nx, ay - ny]);
  }
  // Joins: on the outer side of each corner (the inner side is inside the two quads).
  const first = f.closed ? 0 : 1, last = f.closed ? n - 1 : n - 2;
  for (let v = first; v <= last; v++) {
    const a = (v - 1 + segCount) % segCount, b = v % segCount;
    const d1x = dir[2 * a], d1y = dir[2 * a + 1], d2x = dir[2 * b], d2y = dir[2 * b + 1];
    const cross = d1x * d2y - d1y * d2x, dot = d1x * d2x + d1y * d2y;
    if (Math.abs(cross) < 1e-12 && dot > 0) continue; // straight on
    const vx = pts[2 * v], vy = pts[2 * v + 1];
    const n1x = -d1y, n1y = d1x, n2x = -d2y, n2y = d2x;
    // The outer side: away from where the path turns.
    const s = n1x * d2x + n1y * d2y > 0 ? -1 : 1;
    const o1x = vx + s * n1x * hw, o1y = vy + s * n1y * hw;
    const o2x = vx + s * n2x * hw, o2y = vy + s * n2y * hw;
    if (smooth[v] || join === 'bevel') {
      add([vx, vy, o1x, o1y, o2x, o2y]);
    } else if (join === 'round') {
      disk(vx, vy);
    } else {
      const nd = n1x * n2x + n1y * n2y;
      const ratio = Math.sqrt(2 / Math.max(1e-12, 1 + nd));
      if (ratio > MITER_LIMIT) add([vx, vy, o1x, o1y, o2x, o2y]);
      else {
        const k = hw / (1 + nd);
        add([vx, vy, o1x, o1y, vx + s * (n1x + n2x) * k, vy + s * (n1y + n2y) * k, o2x, o2y]);
      }
    }
  }
  if (!f.closed && cap !== 'butt') {
    for (const end of [0, n - 1]) {
      const di = end === 0 ? 0 : segCount - 1;
      const sign = end === 0 ? -1 : 1;
      const dx = dir[2 * di] * sign, dy = dir[2 * di + 1] * sign;
      const x = pts[2 * end], y = pts[2 * end + 1];
      if (cap === 'round') disk(x, y);
      else {
        const nx = -dy * hw, ny = dx * hw;
        add([x + nx, y + ny, x + nx + dx * hw, y + ny + dy * hw, x - nx + dx * hw, y - ny + dy * hw, x - nx, y - ny]);
      }
    }
  }
  return out;
}

export function signedArea(p: number[]): number {
  let a = 0;
  for (let i = 0, n = p.length; i < n; i += 2) {
    const j = (i + 2) % n;
    a += p[i] * p[j + 1] - p[j] * p[i + 1];
  }
  return a / 2;
}

function reverse(p: number[]): void {
  for (let i = 0, j = p.length - 2; i < j; i += 2, j -= 2) {
    [p[i], p[j]] = [p[j], p[i]];
    [p[i + 1], p[j + 1]] = [p[j + 1], p[i + 1]];
  }
}

/** A polygon cut to a box (Sutherland–Hodgman). Keeps the orientation; area outside is gone. */
export function clipPolygon(p: number[], box: Box): number[] {
  let cur = p;
  for (let edge = 0; edge < 4; edge++) {
    if (cur.length < 6) return [];
    const next: number[] = [];
    const inside = (x: number, y: number) => (edge === 0 ? x >= box[0] : edge === 1 ? x <= box[2] : edge === 2 ? y >= box[1] : y <= box[3]);
    const cut = (ax: number, ay: number, bx: number, by: number): [number, number] => {
      const t = edge < 2 ? ((edge === 0 ? box[0] : box[2]) - ax) / (bx - ax) : ((edge === 2 ? box[1] : box[3]) - ay) / (by - ay);
      return edge < 2 ? [edge === 0 ? box[0] : box[2], ay + (by - ay) * t] : [ax + (bx - ax) * t, edge === 2 ? box[1] : box[3]];
    };
    const n = cur.length;
    for (let i = 0; i < n; i += 2) {
      const ax = cur[(i - 2 + n) % n], ay = cur[(i - 1 + n) % n];
      const bx = cur[i], by = cur[i + 1];
      const ain = inside(ax, ay), bin = inside(bx, by);
      if (bin) {
        if (!ain) next.push(...cut(ax, ay, bx, by));
        next.push(bx, by);
      } else if (ain) next.push(...cut(ax, ay, bx, by));
    }
    cur = next;
  }
  return cur;
}

// --- bounds, transforms ------------------------------------------------------------------------

export interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Corners of the frame in the world (a line: its two end points). */
export function shapeCorners(s: Pick<ShapeInput, 'kind' | 'w' | 'h' | 'm' | 'line' | 'path' | 'parts'>): number[] {
  const m = s.m;
  let local = s.kind === 'line' && s.line ? s.line : [0, 0, s.w, 0, s.w, s.h, 0, s.h];
  if (s.kind === 'compound') {
    // The frame corners of every part: the result lies within them.
    local = [];
    for (const p of s.parts ?? []) {
      for (const [x, y] of [[0, 0], [p.w, 0], [p.w, p.h], [0, p.h]]) local.push(tx(p.m, x, y), ty(p.m, x, y));
    }
  }
  const out: number[] = [];
  for (let i = 0; i < local.length; i += 2) out.push(tx(m, local[i], local[i + 1]), ty(m, local[i], local[i + 1]));
  return out;
}

/** The band of stroke outside the outline, in local units (0: none). */
export function strokeReach(s: Pick<ShapeProps, 'stroke' | 'strokeWidth' | 'align' | 'cap' | 'join' | 'path' | 'arrows' | 'dash'> & { kind: ShapeKind }): number {
  if (!s.stroke || !(s.strokeWidth > 0)) return 0;
  const open = centerOnly(s);
  const band = open || s.align === 'center' ? s.strokeWidth / 2 : s.align === 'outside' ? s.strokeWidth : 0;
  const miter = s.kind !== 'line' && s.join === 'miter' ? MITER_LIMIT : 1;
  // Square caps reach out at the ends of an open contour, and at the ends of every dash.
  const cap = (open || s.dash?.some((d) => d > 0)) && s.cap === 'square' ? Math.SQRT2 : 1;
  // Arrowheads reach up to 3 stroke widths from the end point (strokeStyle.ts HEAD_REACH).
  const heads = open && s.arrows?.some((a) => a !== 'none') ? 3 * s.strokeWidth : 0;
  return Math.max(band * Math.max(miter, cap), heads);
}

/** World bounding box of what a shape draws (the stroke included). */
export function shapeBounds(s: ShapeInput): Bounds {
  const c = shapeCorners(s);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < c.length; i += 2) {
    x0 = Math.min(x0, c[i]);
    x1 = Math.max(x1, c[i]);
    y0 = Math.min(y0, c[i + 1]);
    y1 = Math.max(y1, c[i + 1]);
  }
  // The reach, plus a margin relative to the size, so anti-aliasing at any zoom stays inside.
  const r = strokeReach(s) * maxScale(s.m) + Math.max(x1 - x0, y1 - y0) * 1e-6;
  return { x0: x0 - r, y0: y0 - r, x1: x1 + r, y1: y1 + r };
}

/** True when every frame corner is within ±max. */
export function cornersWithin(s: Pick<ShapeInput, 'kind' | 'w' | 'h' | 'm' | 'line' | 'path' | 'parts'>, max: number): boolean {
  if (!shapeCorners(s).every((v) => Math.abs(v) <= max)) return false;
  // A path: every anchor and handle too (they may lie outside the frame); a compound: its parts' too.
  const paths = s.kind === 'path' ? (s.path ?? []) : s.kind === 'compound' ? (s.parts ?? []).flatMap((p) => mapPath(p.path ?? [], p.m)) : [];
  for (const c of paths) {
    for (let i = 0; i < c.pts.length; i += POINT_STRIDE) {
      for (let k = 0; k < 6; k += 2) {
        const x = c.pts[i + k], y = c.pts[i + k + 1];
        if (!(Math.abs(tx(s.m, x, y)) <= max && Math.abs(ty(s.m, x, y)) <= max)) return false;
      }
    }
  }
  return true;
}

// --- paths -----------------------------------------------------------------------------------

/** True when the shape strokes on the center only: a line, or a path with an open contour. */
export function centerOnly(s: Pick<ShapeInput, 'kind' | 'path'>): boolean {
  return s.kind === 'line' || (s.kind === 'path' && (s.path ?? []).some((c) => !c.closed));
}

/** The fields each kind uses besides the common ones. Others are dropped (stripForKind). */
const KIND_FIELDS: Record<ShapeKind, string[]> = {
  rect: ['radii', 'radiiLinked'],
  ellipse: ['arc', 'hole'],
  polygon: ['sides', 'rounding'],
  star: ['points', 'innerRatio', 'rounding'],
  line: ['line'],
  path: ['path', 'curve'],
  compound: ['parts'],
  custom: ['preset'],
};
const ALL_KIND_FIELDS = new Set(Object.values(KIND_FIELDS).flat());

/** A copy without the settings of other kinds (after a kind change). */
export function stripForKind<T extends Pick<ShapeInput, 'kind'>>(s: T): T {
  const keep = new Set(KIND_FIELDS[s.kind]);
  const out = { ...s } as Record<string, unknown>;
  for (const k of ALL_KIND_FIELDS) if (!keep.has(k)) delete out[k];
  return out as T;
}

/**
 * The outline of any shape as path contours (local units): what point editing starts from.
 * Arcs become cubic Beziers of at most 90° each (within 0.03% of the radius).
 */
export function toPath(s: ShapeGeo): PathContour[] {
  if (s.kind === 'compound') return compoundToPath(s);
  if (s.kind === 'path' && s.curve !== 'spline') return (s.path ?? []).map((c) => ({ closed: c.closed, pts: [...c.pts] }));
  return shapeContours(s).map((c) => {
    // Anchors with handles: x, y, ix, iy, ox, oy (the type is set below).
    const p: number[][] = [[c.x, c.y, c.x, c.y, c.x, c.y]];
    let x = c.x, y = c.y;
    const to = (x1: number, y1: number, x2: number, y2: number, nx: number, ny: number) => {
      const last = p[p.length - 1];
      last[4] = x1;
      last[5] = y1;
      p.push([nx, ny, x2, y2, nx, ny]);
      x = nx;
      y = ny;
    };
    for (const g of c.segs) {
      if (g.t === 'L') to(x, y, g.x, g.y, g.x, g.y);
      else if (g.t === 'C') to(g.x1, g.y1, g.x2, g.y2, g.x, g.y);
      else if (g.t === 'X') {
        // An x-spline segment becomes one cubic or more, fitted within 0.2% of its length.
        for (const q of xToCubics(g)) to(q[2], q[3], q[4], q[5], q[6], q[7]);
      } else {
        const n = Math.max(1, Math.ceil(Math.abs(g.a1 - g.a0) / (Math.PI / 2) - 1e-9));
        const da = (g.a1 - g.a0) / n;
        const k = (4 / 3) * Math.tan(da / 4);
        for (let i = 0; i < n; i++) {
          const a = g.a0 + da * i, b = a + da;
          const ex = g.cx + g.rx * Math.cos(b), ey = g.cy + g.ry * Math.sin(b);
          to(x - k * g.rx * Math.sin(a), y + k * g.ry * Math.cos(a), ex + k * g.rx * Math.sin(b), ey - k * g.ry * Math.cos(b), ex, ey);
        }
      }
    }
    // A closed contour ends where it starts: the last point is the first one.
    if (c.closed && p.length > 1) {
      const last = p[p.length - 1], first = p[0];
      if (Math.abs(last[0] - first[0]) <= 1e-9 * (Math.abs(first[0]) + 1) && Math.abs(last[1] - first[1]) <= 1e-9 * (Math.abs(first[1]) + 1)) {
        first[2] = last[2];
        first[3] = last[3];
        p.pop();
      }
    }
    const pts: number[] = [];
    for (const q of p) {
      // Smooth: both handles, on one line (within 0.1°: a fitted spline is not exact).
      const ax = q[0] - q[2], ay = q[1] - q[3], bx = q[4] - q[0], by = q[5] - q[1];
      const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
      const smooth = la > 0 && lb > 0 && (ax * bx + ay * by) / (la * lb) > Math.cos(0.0018);
      pts.push(q[0], q[1], q[2], q[3], q[4], q[5], smooth ? 1 : 0);
    }
    return { closed: c.closed, pts };
  });
}

/** The box of the curves of path contours (local units): anchors and the extremes of each curve. */
export function pathBounds(path: PathContour[], curve?: ShapeProps['curve']): [number, number, number, number] {
  if (curve === 'spline') {
    // An x-spline: the box of its points, flattened finely for its size.
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const c of path) {
      for (let i = 0; i < c.pts.length; i += POINT_STRIDE) {
        x0 = Math.min(x0, c.pts[i]);
        x1 = Math.max(x1, c.pts[i]);
        y0 = Math.min(y0, c.pts[i + 1]);
        y1 = Math.max(y1, c.pts[i + 1]);
      }
    }
    if (!(x0 <= x1)) return [0, 0, 0, 0];
    const tol = Math.max(x1 - x0, y1 - y0, 1e-300) * 1e-6;
    x0 = y0 = Infinity;
    x1 = y1 = -Infinity;
    for (const c of path) {
      const f = flattenContour(splineContour(c), [1, 0, 0, 1, 0, 0], tol);
      for (let i = 0; i < f.pts.length; i += 2) {
        x0 = Math.min(x0, f.pts[i]);
        x1 = Math.max(x1, f.pts[i]);
        y0 = Math.min(y0, f.pts[i + 1]);
        y1 = Math.max(y1, f.pts[i + 1]);
      }
    }
    return [x0, y0, x1, y1];
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x: number, y: number) => {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  };
  for (const c of path) {
    const con = pathContour(c);
    let x = con.x, y = con.y;
    add(x, y);
    for (const g of con.segs) {
      if (g.t === 'C') {
        const p = [x, y, g.x1, g.y1, g.x2, g.y2, g.x, g.y];
        // Where the derivative is zero, on each axis.
        for (const axis of [0, 1]) {
          const [a, b, c2, d] = [p[axis], p[axis + 2], p[axis + 4], p[axis + 6]];
          const qa = -a + 3 * b - 3 * c2 + d, qb = 2 * (a - 2 * b + c2), qc = b - a;
          const roots: number[] = [];
          if (Math.abs(qa) < 1e-12 * (Math.abs(a) + Math.abs(d) + 1)) {
            if (qb !== 0) roots.push(-qc / qb);
          } else {
            const disc = qb * qb - 4 * qa * qc;
            if (disc >= 0) roots.push((-qb + Math.sqrt(disc)) / (2 * qa), (-qb - Math.sqrt(disc)) / (2 * qa));
          }
          for (const t of roots) if (t > 0 && t < 1) add(...cubicAt(p, t));
        }
      }
      if (g.t !== 'A') add(g.x, g.y);
      x = (g as { x: number }).x;
      y = (g as { y: number }).y;
    }
  }
  return x0 <= x1 ? [x0, y0, x1, y1] : [0, 0, 0, 0];
}

/** A path shape with its frame fitted to its curves again: the origin moves into `m`. */
export function fitPathFrame<T extends Pick<ShapeInput, 'm' | 'w' | 'h' | 'path' | 'curve'>>(s: T): T {
  const path = s.path ?? [];
  const [x0, y0, x1, y1] = pathBounds(path, s.curve);
  const moved = path.map((c) => {
    const pts = c.pts.slice();
    for (let i = 0; i < pts.length; i += POINT_STRIDE) {
      for (let k = 0; k < 6; k += 2) {
        pts[i + k] -= x0;
        pts[i + k + 1] -= y0;
      }
    }
    return { closed: c.closed, pts };
  });
  return { ...s, path: moved, w: x1 - x0, h: y1 - y0, m: compose(s.m, [1, 0, 0, 1, x0, y0]) };
}

/** The shape's matrix after a layer transform, or null when it would go out of range. */
export function transformShapeMatrix(s: ShapeInput, M: Affine, maxCoord: number): Affine | null {
  const m = compose(M, s.m);
  if (!validAffine(m) || !cornersWithin({ ...s, m }, maxCoord)) return null;
  return m;
}

/** Shapes of a layer in drawing order (bottom to top). */
export const byZ = (a: Pick<Shape, 'z' | 'id'>, b: Pick<Shape, 'z' | 'id'>) => a.z - b.z || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// --- hit tests ---------------------------------------------------------------------------------

/** Distance from (0, 0) to the segment a–b. */
function segDist(ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax, vy = by - ay;
  const l = vx * vx + vy * vy;
  const t = l > 0 ? Math.max(0, Math.min(1, -(ax * vx + ay * vy) / l)) : 0;
  return Math.hypot(ax + t * vx, ay + t * vy);
}

/**
 * The outline of a shape as polygons in the target units of `A` (local → target), refined to
 * `tol` near `box`. For overlays (screen pixels) and hit tests (world, relative to a point).
 */
export function outlinePolys(s: ShapeGeo, A: Affine, tol: number, box: Box | null): { pts: number[]; closed: boolean }[] {
  return shapeContours(s).map((c) => {
    const f = flattenContour(c, A, tol, box);
    const p: number[] = [];
    for (let i = 0; i < f.pts.length; i += 2) p.push(tx(A, f.pts[i], f.pts[i + 1]), ty(A, f.pts[i], f.pts[i + 1]));
    return { pts: p, closed: f.closed };
  });
}

/**
 * Whether a world point is on a shape: on its fill, or within `tol` (world units) of its stroke
 * band or its outline. Unfilled shapes are hit on their stroke and outline only.
 */
export function hitShape(s: ShapeInput, x: number, y: number, tol: number): boolean {
  const b = shapeBounds(s);
  if (x < b.x0 - tol || x > b.x1 + tol || y < b.y0 - tol || y > b.y1 + tol) return false;
  if (s.kind === 'compound') {
    // In the result, or near its outline (a point around differs), or on its stroke band.
    const sc = maxScale(s.m);
    const r = (s.stroke && s.strokeWidth > 0 ? s.strokeWidth * sc * (s.align === 'center' ? 0.5 : s.align === 'outside' ? 1 : 0) : 0) + tol;
    const c = compoundInside(s, x, y, r);
    if (c && (s.fill || !s.stroke)) return true;
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      if (compoundInside(s, x + Math.cos(a) * r, y + Math.sin(a) * r, r) !== c) return true;
    }
    return false;
  }
  const m = s.m;
  // World relative to the point: the numbers stay small near it at any zoom.
  const A: Affine = [m[0], m[1], m[2], m[3], m[4] - x, m[5] - y];
  const sc = maxScale(m);
  const half = s.stroke && s.strokeWidth > 0 ? s.strokeWidth * sc : 0;
  const reach = centerOnly(s) || s.align === 'center' ? half / 2 : s.align === 'outside' ? half : 0;
  const r = reach + tol;
  const polys = outlinePolys(s, A, Math.max(tol / 4, 1e-300), [-r * 2, -r * 2, r * 2, r * 2]);
  let wind = 0;
  let dist = Infinity;
  for (const { pts, closed } of polys) {
    const n = pts.length;
    // A path fills an open contour as if it were closed (as SVG does).
    const fills = closed || s.kind === 'path';
    for (let i = 0; i < n; i += 2) {
      const ax = pts[i], ay = pts[i + 1], bx = pts[(i + 2) % n], by = pts[(i + 3) % n];
      if (closed || i + 2 < n) dist = Math.min(dist, segDist(ax, ay, bx, by));
      if (fills) {
        // Winding number around the origin.
        if (ay <= 0) {
          if (by > 0 && ax * by - bx * ay > 0) wind++;
        } else if (by <= 0 && ax * by - bx * ay < 0) wind--;
      }
    }
  }
  const inside = wind !== 0;
  if (inside && s.fill && s.kind !== 'line') return true;
  if (dist <= r) return true;
  // An inside stroke covers a band within the outline.
  return inside && s.align === 'inside' && dist <= half + tol;
}
