// Draws vector shapes with Canvas 2D paths into a target: a 256 px tile (both renderers, the
// tile worker), or the screen while a shape layer is being edited.
//
// Exact at any zoom. The local → target matrix is built in double precision with the target
// origin subtracted first, as the brush dabs do (putDab in gl/glRenderer.ts). When the whole
// shape lies within ±SAFE target pixels, Canvas draws its path directly (with the matrix, so the
// stroke follows a skew exactly). Further out, float32 inside Canvas would move the edges: then
// the outline and the stroke are built here as polygons in double precision, cut to the target,
// and Canvas only fills small numbers.

import { MITER_LIMIT, centerOnly, clipPolygon, flattenContour, maxScale, shapeContours, strokePolygons, type Box, type Contour } from '../../shared/shapes';
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
      for (const g of c.segs) {
        if (g.t === 'L') outline.lineTo(g.x, g.y);
        else if (g.t === 'C') outline.bezierCurveTo(g.x1, g.y1, g.x2, g.y2, g.x, g.y);
        else outline.ellipse(g.cx, g.cy, Math.abs(g.rx), Math.abs(g.ry), 0, g.a0, g.a1, g.a1 < g.a0);
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
