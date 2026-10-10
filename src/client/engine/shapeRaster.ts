// Draws vector shapes with Canvas 2D paths into a target: a 256 px tile (both renderers, the
// tile worker), or the screen while a shape layer is being edited.
//
// Exact at any zoom. The local → target matrix is built in double precision with the target
// origin subtracted first, as the brush dabs do (putDab in gl/glRenderer.ts). When the whole
// shape lies within ±SAFE target pixels, Canvas draws its path directly (with the matrix, so the
// stroke follows a skew exactly). Further out, float32 inside Canvas would move the edges: then
// the outline and the stroke are built here as polygons in double precision, cut to the target,
// and Canvas only fills small numbers.

import { MITER_LIMIT, centerOnly, clipPolygon, compoundRings, flattenContour, maxScale, shapeContours, strokePolygons, type Box, type Contour } from '../../shared/shapes';
import { joinPieces, outlinePieces, type BoolPart } from '../../shared/boolean';
import { invert } from '../../shared/layers';
import type { Affine, Shape } from '../../shared/types';

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Target pixels within which Canvas paths are exact enough (float32 has 24 bits). */
const SAFE = 32768;
/** Flattening tolerance, in target pixels. */
const TOL = 0.15;
/** The exact path cuts its polygons this far outside the target. */
const PAD = 4;

/**
 * Draws shapes bottom to top into a w × h target whose top left corner is world (ox, oy), at
 * `scale` target pixels per world unit.
 */
export function drawShapes(ctx: Ctx2D, shapes: Iterable<Shape>, ox: number, oy: number, scale: number, w: number, h: number): void {
  for (const s of shapes) drawShape(ctx, s, ox, oy, scale, w, h);
}

function drawShape(ctx: Ctx2D, s: Shape, ox: number, oy: number, sc: number, w: number, h: number): void {
  const fill = s.kind !== 'line' && s.fill ? s.fill : null;
  const stroke = s.stroke && s.strokeWidth > 0 ? s.stroke : null;
  if (!fill && !stroke) return;
  const m = s.m;
  const A: Affine = [m[0] * sc, m[1] * sc, m[2] * sc, m[3] * sc, (m[4] - ox) * sc, (m[5] - oy) * sc];
  const align = centerOnly(s) ? 'center' : s.align;
  // Inside and outside strokes draw twice the width on the center line, then cut away half.
  const band = stroke ? (align === 'center' ? s.strokeWidth : 2 * s.strokeWidth) : 0;
  // How far the stroke reaches past the outline (miter tips and square caps reach further).
  const reach = (band / 2) * (s.kind !== 'line' && s.join === 'miter' ? MITER_LIMIT : Math.SQRT2);
  // Every point Canvas gets: the frame (a line: its ends; a path: its anchors and handles too).
  const local = s.kind === 'line' && s.line ? s.line : [0, 0, s.w, 0, s.w, s.h, 0, s.h];
  if (s.kind === 'path') for (const c of s.path ?? []) for (let i = 0; i < c.pts.length; i += 7) local.push(...c.pts.slice(i, i + 6));
  let safe = reach * maxScale(A) < SAFE;
  for (let i = 0; safe && i < local.length; i += 2) {
    const x = A[0] * local[i] + A[2] * local[i + 1] + A[4];
    const y = A[1] * local[i] + A[3] * local[i + 1] + A[5];
    safe = Math.abs(x) < SAFE && Math.abs(y) < SAFE;
  }
  if (s.kind === 'compound') return drawCompound(ctx, s, A, w, h, fill, stroke, align, band);
  const contours = shapeContours(s);
  const paths = safe ? nativePaths(contours, A, band) : exactPaths(contours, A, band, s, w, h);
  if (!paths) return;
  ctx.save();
  ctx.setTransform(paths.m[0], paths.m[1], paths.m[2], paths.m[3], paths.m[4], paths.m[5]);
  const drawStroke = () => {
    ctx.strokeStyle = ctx.fillStyle = stroke!;
    if (align === 'inside') {
      ctx.save();
      ctx.clip(paths.outline, 'nonzero');
      paths.stroke();
      ctx.restore();
    } else if (align === 'outside' && !fill) {
      // Everything but the inside: the target box with the outline as a hole.
      const inv = invert(paths.m);
      if (!inv) return;
      const q = new Path2D();
      const corners = [-PAD, -PAD, w + PAD, -PAD, w + PAD, h + PAD, -PAD, h + PAD];
      for (let i = 0; i < 8; i += 2) {
        const x = inv[0] * corners[i] + inv[2] * corners[i + 1] + inv[4];
        const y = inv[1] * corners[i] + inv[3] * corners[i + 1] + inv[5];
        if (i === 0) q.moveTo(x, y);
        else q.lineTo(x, y);
      }
      q.closePath();
      q.addPath(paths.outline);
      ctx.save();
      ctx.clip(q, 'evenodd');
      paths.stroke();
      ctx.restore();
    } else paths.stroke();
  };
  // An outside stroke under the fill: the fill covers its inner half, and no seam shows.
  if (stroke && align === 'outside' && fill) drawStroke();
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill(paths.outline, 'nonzero');
  }
  if (stroke && !(align === 'outside' && fill)) drawStroke();
  ctx.restore();

  /** Canvas paths in local units, drawn through A. */
  function nativePaths(cs: Contour[], A: Affine, band: number) {
    const outline = new Path2D();
    for (const c of cs) {
      outline.moveTo(c.x, c.y);
      let x = c.x, y = c.y;
      for (const g of c.segs) {
        if (g.t === 'L') outline.lineTo(g.x, g.y);
        else if (g.t === 'C') outline.bezierCurveTo(g.x1, g.y1, g.x2, g.y2, g.x, g.y);
        else if (g.t === 'X') {
          // Canvas has no x-splines: short lines, fine enough on this target.
          const f = flattenContour({ x, y, closed: false, segs: [g] }, A, TOL);
          for (let i = 2; i < f.pts.length; i += 2) outline.lineTo(f.pts[i], f.pts[i + 1]);
        } else outline.ellipse(g.cx, g.cy, Math.abs(g.rx), Math.abs(g.ry), 0, g.a0, g.a1, g.a1 < g.a0);
        if (g.t !== 'A') [x, y] = [g.x, g.y];
        else [x, y] = [g.cx + g.rx * Math.cos(g.a1), g.cy + g.ry * Math.sin(g.a1)];
      }
      if (c.closed) outline.closePath();
    }
    return {
      m: A,
      outline,
      stroke: () => {
        ctx.lineWidth = band;
        ctx.lineCap = s.cap;
        ctx.lineJoin = s.join;
        ctx.miterLimit = MITER_LIMIT;
        ctx.stroke(outline);
      },
    };
  }

  /** Polygons in target pixels, built and cut in double precision. Null: nothing shows here. */
  function exactPaths(cs: Contour[], A: Affine, band: number, s: Shape, w: number, h: number) {
    const box: Box = [-PAD, -PAD, w + PAD, h + PAD];
    const outline = new Path2D();
    const strokePath = new Path2D();
    let any = false;
    const addPoly = (path: Path2D, p: number[]) => {
      path.moveTo(p[0], p[1]);
      for (let i = 2; i < p.length; i += 2) path.lineTo(p[i], p[i + 1]);
      path.closePath();
      any = true;
    };
    for (const c of cs) {
      const f = flattenContour(c, A, TOL, box, band / 2);
      // A path fills an open contour as if it were closed (as SVG does).
      if (f.closed || s.kind === 'path') {
        const p: number[] = [];
        for (let i = 0; i < f.pts.length; i += 2) {
          p.push(A[0] * f.pts[i] + A[2] * f.pts[i + 1] + A[4], A[1] * f.pts[i] + A[3] * f.pts[i + 1] + A[5]);
        }
        const cut = clipPolygon(p, box);
        if (cut.length >= 6) addPoly(outline, cut);
      }
      if (band > 0) for (const p of strokePolygons(f, band / 2, s.cap, s.join, A, box, TOL)) addPoly(strokePath, p);
    }
    if (!any) return null;
    return { m: [1, 0, 0, 1, 0, 0] as Affine, outline, stroke: () => ctx.fill(strokePath, 'nonzero') };
  }
}

/** Canvases for compound shapes (the result mask, the stroke, the fill), reused. */
const scratch: OffscreenCanvas[] = [];
function canvasFor(i: number, w: number, h: number): OffscreenCanvasRenderingContext2D {
  let c = scratch[i];
  if (!c) scratch[i] = c = new OffscreenCanvas(w, h);
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  const ctx = c.getContext('2d')!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, w, h);
  return ctx;
}

const COMPOSITE: Record<string, GlobalCompositeOperation> = { unite: 'source-over', subtract: 'destination-out', intersect: 'destination-in', exclude: 'xor' };

/**
 * A compound shape on a target. The fill: the parts combined on a mask by Canvas compositing (the
 * first part, then each next one by its op). The stroke: the result's outline (shared/boolean.ts),
 * built in double precision in target pixels, as the exact path of plain shapes. The parts are
 * cut to a box around the target that the stroke band cannot cross from outside; the sides of
 * that box are not outline.
 */
function drawCompound(ctx: Ctx2D, s: Shape, A: Affine, w: number, h: number, fill: string | null, stroke: string | null, align: string, band: number): void {
  const k = Math.sqrt(Math.abs(A[0] * A[3] - A[1] * A[2]));
  const hw = (band / 2) * k; // half the band, in target pixels
  const reach = hw * (s.join === 'miter' ? MITER_LIMIT : 1);
  const box: Box = [-PAD, -PAD, w + PAD, h + PAD];
  const P = reach + PAD + 2;
  const big: Box = [-P, -P, w + P, h + P];
  const parts: BoolPart[] = compoundRings(s, A, TOL, box, band / 2).map((p) => ({ op: p.op, rings: p.rings.map((r) => clipPolygon(r, big)).filter((r) => r.length >= 6) }));
  const poly = (rings: number[][]) => {
    const path = new Path2D();
    for (const r of rings) {
      path.moveTo(r[0], r[1]);
      for (let i = 2; i < r.length; i += 2) path.lineTo(r[i], r[i + 1]);
      path.closePath();
    }
    return path;
  };
  // The result as a mask.
  const mask = canvasFor(0, w, h);
  parts.forEach((p, i) => {
    mask.globalCompositeOperation = i === 0 ? 'source-over' : COMPOSITE[p.op];
    if (!p.rings.length) {
      // Nothing of this part here: an intersection leaves nothing; the other ops change nothing.
      if (i > 0 && p.op === 'intersect') mask.clearRect(0, 0, w, h);
      return;
    }
    mask.fill(poly(p.rings), 'nonzero');
  });
  mask.globalCompositeOperation = 'source-over';
  // The stroke band along the result's outline.
  let strokePath: Path2D | null = null;
  if (stroke && hw > 0) {
    const onBox = (ax: number, ay: number, bx: number, by: number) =>
      (ax === bx && (ax === big[0] || ax === big[2])) || (ay === by && (ay === big[1] || ay === big[3]));
    strokePath = new Path2D();
    for (const ch of joinPieces(outlinePieces(parts, onBox))) {
      const pts: number[] = [];
      for (const pc of ch.pieces) pts.push(pc.ax, pc.ay);
      if (!ch.closed) pts.push(ch.pieces[ch.pieces.length - 1].bx, ch.pieces[ch.pieces.length - 1].by);
      // A turn under 25° is a flattened curve, not a corner.
      const n = pts.length / 2;
      const smooth: boolean[] = [];
      for (let i = 0; i < n; i++) {
        const a = (i - 1 + n) % n, b = (i + 1) % n;
        const ux = pts[2 * i] - pts[2 * a], uy = pts[2 * i + 1] - pts[2 * a + 1], vx = pts[2 * b] - pts[2 * i], vy = pts[2 * b + 1] - pts[2 * i + 1];
        const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
        smooth.push(lu > 0 && lv > 0 && (ux * vx + uy * vy) / (lu * lv) > Math.cos(0.44));
      }
      for (const p of strokePolygons({ pts, smooth, closed: ch.closed }, hw, s.cap, s.join, [1, 0, 0, 1, 0, 0], box, TOL)) {
        strokePath.moveTo(p[0], p[1]);
        for (let i = 2; i < p.length; i += 2) strokePath.lineTo(p[i], p[i + 1]);
        strokePath.closePath();
      }
    }
  }
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const drawStroke = () => {
    if (!strokePath) return;
    if (align === 'center' || (align === 'outside' && fill)) {
      ctx.fillStyle = stroke!;
      ctx.fill(strokePath, 'nonzero');
      return;
    }
    // Inside: only within the result; outside without a fill: only outside it.
    const st = canvasFor(1, w, h);
    st.fillStyle = stroke!;
    st.fill(strokePath, 'nonzero');
    st.globalCompositeOperation = align === 'inside' ? 'destination-in' : 'destination-out';
    st.drawImage(mask.canvas, 0, 0);
    ctx.drawImage(st.canvas, 0, 0);
  };
  if (align === 'outside' && fill) drawStroke();
  if (fill) {
    // The color, cut to the mask. (A mask colored with source-in came out black on a reused canvas in Chrome.)
    const f = canvasFor(2, w, h);
    f.fillStyle = fill;
    f.fillRect(0, 0, w, h);
    f.globalCompositeOperation = 'destination-in';
    f.drawImage(mask.canvas, 0, 0);
    ctx.drawImage(f.canvas, 0, 0);
  }
  if (!(align === 'outside' && fill)) drawStroke();
  ctx.restore();
}
