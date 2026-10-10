// Boolean combinations of polygon rings, for compound shapes: is a point inside the result, and
// where is the result's outline. Used to draw a compound's stroke on a tile, to hit-test it, and
// to flatten it into one path.
//
// The outline: every edge of every part is cut where it crosses an edge of any part. A piece of an
// edge is on the outline when the result differs on its two sides (a test just beside its middle).
// The pieces point so that the result lies on their left (the side of (-dy, dx)); joined end to
// end, they make the outline, holes included, and a nonzero fill of it is the result.

export type BoolOp = 'unite' | 'subtract' | 'intersect' | 'exclude';

export interface BoolPart {
  op: BoolOp;
  /** Closed rings, flat x, y pairs (the last point does not repeat the first). Nonzero rule. */
  rings: number[][];
}

/** The winding number of rings around (x, y). */
function winding(rings: number[][], x: number, y: number): number {
  let w = 0;
  for (const p of rings) {
    const n = p.length;
    for (let i = 0; i < n; i += 2) {
      const ax = p[i] - x, ay = p[i + 1] - y, bx = p[(i + 2) % n] - x, by = p[(i + 3) % n] - y;
      if (ay <= 0) {
        if (by > 0 && ax * by - bx * ay > 0) w++;
      } else if (by <= 0 && ax * by - bx * ay < 0) w--;
    }
  }
  return w;
}

/** Whether (x, y) is inside the result: the first part, then each next part by its op. */
export function insideResult(parts: BoolPart[], x: number, y: number): boolean {
  let r = false;
  parts.forEach((p, i) => {
    const w = winding(p.rings, x, y) !== 0;
    if (i === 0) r = w;
    else if (p.op === 'unite') r = r || w;
    else if (p.op === 'subtract') r = r && !w;
    else if (p.op === 'intersect') r = r && w;
    else r = r !== w;
  });
  return r;
}

/** A piece of the outline: from (ax, ay) to (bx, by), the result on its left. */
export interface Piece {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** Where it comes from: part, ring, edge (from point `edge` to the next), the edge's t range. */
  part: number;
  ring: number;
  edge: number;
  t0: number;
  t1: number;
}

interface Edge {
  part: number;
  ring: number;
  edge: number;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Cuts: t along the edge, and the point (shared exactly with the other edge). */
  cuts: [number, number, number][];
}

/**
 * The outline pieces of the result. `skip` leaves out edges that are not real (the sides of a
 * box the rings were cut to); they still count for inside tests.
 */
export function outlinePieces(parts: BoolPart[], skip?: (ax: number, ay: number, bx: number, by: number) => boolean): Piece[] {
  const edges: Edge[] = [];
  let ext = 0;
  parts.forEach((p, part) =>
    p.rings.forEach((r, ring) => {
      const n = r.length;
      for (let i = 0; i < n; i += 2) {
        const ax = r[i], ay = r[i + 1], bx = r[(i + 2) % n], by = r[(i + 3) % n];
        ext = Math.max(ext, Math.abs(ax), Math.abs(ay));
        if (ax === bx && ay === by) continue;
        if (skip?.(ax, ay, bx, by)) continue;
        edges.push({ part, ring, edge: i / 2, ax, ay, bx, by, x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by), cuts: [] });
      }
    }),
  );
  // Cut every pair of edges where they cross (or overlap, when they lie on one line).
  const order = edges.map((_, i) => i).sort((a, b) => edges[a].x0 - edges[b].x0);
  for (let oi = 0; oi < order.length; oi++) {
    const e = edges[order[oi]];
    for (let oj = oi + 1; oj < order.length; oj++) {
      const f = edges[order[oj]];
      if (f.x0 > e.x1) break;
      if (f.y1 < e.y0 || f.y0 > e.y1) continue;
      const rx = e.bx - e.ax, ry = e.by - e.ay, sx = f.bx - f.ax, sy = f.by - f.ay;
      const qx = f.ax - e.ax, qy = f.ay - e.ay;
      const d = rx * sy - ry * sx;
      const lr = Math.hypot(rx, ry), ls = Math.hypot(sx, sy);
      if (Math.abs(d) > 1e-12 * lr * ls) {
        const t = (qx * sy - qy * sx) / d, u = (qx * ry - qy * rx) / d;
        if (t < 0 || t > 1 || u < 0 || u > 1) continue;
        // The ends of an edge already cut it there: use them exactly.
        let px: number, py: number;
        if (u === 0 || u === 1) [px, py] = u === 0 ? [f.ax, f.ay] : [f.bx, f.by];
        else if (t === 0 || t === 1) [px, py] = t === 0 ? [e.ax, e.ay] : [e.bx, e.by];
        else [px, py] = [e.ax + t * rx, e.ay + t * ry];
        e.cuts.push([t, px, py]);
        f.cuts.push([u, px, py]);
      } else if (Math.abs(qx * ry - qy * rx) <= 1e-12 * lr * Math.hypot(qx, qy) + 1e-300) {
        // On one line: each edge is cut at the other's ends that lie on it.
        const proj = (x: number, y: number, ox: number, oy: number, vx: number, vy: number, l2: number) => ((x - ox) * vx + (y - oy) * vy) / l2;
        for (const [x, y] of [[f.ax, f.ay], [f.bx, f.by]]) {
          const t = proj(x, y, e.ax, e.ay, rx, ry, lr * lr);
          if (t > 0 && t < 1) e.cuts.push([t, x, y]);
        }
        for (const [x, y] of [[e.ax, e.ay], [e.bx, e.by]]) {
          const u = proj(x, y, f.ax, f.ay, sx, sy, ls * ls);
          if (u > 0 && u < 1) f.cuts.push([u, x, y]);
        }
      }
    }
  }
  const out: Piece[] = [];
  const seen = new Set<string>();
  const tiny = ext * 1e-13;
  for (const e of edges) {
    const pts: [number, number, number][] = [[0, e.ax, e.ay], ...e.cuts.sort((a, b) => a[0] - b[0]), [1, e.bx, e.by]];
    for (let k = 1; k < pts.length; k++) {
      const [t0, ax, ay] = pts[k - 1], [t1, bx, by] = pts[k];
      const dx = bx - ax, dy = by - ay;
      const len = Math.hypot(dx, dy);
      if (len <= tiny) continue;
      const mx = (ax + bx) / 2, my = (ay + by) / 2;
      const eps = Math.max(len * 1e-4, tiny * 10);
      const nx = (-dy / len) * eps, ny = (dx / len) * eps;
      const left = insideResult(parts, mx + nx, my + ny), right = insideResult(parts, mx - nx, my - ny);
      if (left === right) continue;
      // Two parts with an edge in common give the same piece twice: keep one.
      const key = ax < bx || (ax === bx && ay < by) ? `${ax},${ay},${bx},${by}` : `${bx},${by},${ax},${ay}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(left ? { ax, ay, bx, by, part: e.part, ring: e.ring, edge: e.edge, t0, t1 } : { ax: bx, ay: by, bx: ax, by: ay, part: e.part, ring: e.ring, edge: e.edge, t0: t1, t1: t0 });
    }
  }
  return out;
}

/** Pieces joined end to end: closed loops, and open runs (where pieces were left out). */
export function joinPieces(pieces: Piece[]): { pieces: Piece[]; closed: boolean }[] {
  const key = (x: number, y: number) => `${x},${y}`;
  const from = new Map<string, number[]>();
  const ends = new Set<string>();
  pieces.forEach((p, i) => {
    const k = key(p.ax, p.ay);
    let l = from.get(k);
    if (!l) from.set(k, (l = []));
    l.push(i);
    ends.add(key(p.bx, p.by));
  });
  const used = new Uint8Array(pieces.length);
  const out: { pieces: Piece[]; closed: boolean }[] = [];
  const walk = (start: number) => {
    const run: Piece[] = [];
    let i = start;
    const k0 = key(pieces[i].ax, pieces[i].ay);
    for (;;) {
      used[i] = 1;
      run.push(pieces[i]);
      const k = key(pieces[i].bx, pieces[i].by);
      if (k === k0) return out.push({ pieces: run, closed: true });
      const next = (from.get(k) ?? []).find((j) => !used[j]);
      if (next === undefined) return out.push({ pieces: run, closed: false });
      i = next;
    }
  };
  // Open runs first (from a piece that no piece leads into), then the loops.
  pieces.forEach((p, i) => {
    if (!used[i] && !ends.has(key(p.ax, p.ay))) walk(i);
  });
  pieces.forEach((_, i) => {
    if (!used[i]) walk(i);
  });
  return out;
}
