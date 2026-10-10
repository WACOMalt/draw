// Brush tip stamps and dab drawing. Runs on the main thread and inside the tile worker.

import { brushShape } from '../../shared/brush';
import type { Brush, BrushTip } from '../../shared/types';
import { TIP_SIZE, tipMask } from './tips';

/** Above this diameter in target pixels, a dab is drawn from its exact shape (see hugeRound, hugeTip). */
const HUGE_STAMP = 8192;

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const MIN_STAMP = 4;
const MAX_STAMP = 1024;

/** Stamp side length for a dab of `d` device pixels: next power of two, so stamps only scale down. */
export function stampBucket(d: number): number {
  const s = 2 ** Math.ceil(Math.log2(Math.max(1, d)));
  return Math.min(MAX_STAMP, Math.max(MIN_STAMP, s));
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function makeStamp(color: string, hardness: number, size: number): OffscreenCanvas {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const [r, g, b] = hexToRgb(color);
  const R = size / 2;
  const core = hardness * R;
  const falloff = R - core;
  const data = img.data;
  for (let j = 0; j < size; j++) {
    const dy = j + 0.5 - R;
    for (let i = 0; i < size; i++) {
      const dx = i + 0.5 - R;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d >= R) continue;
      let a = 1;
      if (d > core && falloff > 1e-6) {
        const x = (d - core) / falloff;
        a = 0.5 + 0.5 * Math.cos(Math.PI * x);
      }
      a *= Math.min(1, R - d); // one pixel of antialiasing on the outer edge
      const o = (j * size + i) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** A textured tip in one color at full TIP_SIZE resolution. */
function makeTipBase(tip: BrushTip, color: string): OffscreenCanvas {
  const N = TIP_SIZE;
  const canvas = new OffscreenCanvas(N, N);
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(N, N);
  const [r, g, b] = hexToRgb(color);
  const m = tipMask(tip);
  for (let i = 0; i < N * N; i++) {
    const o = i * 4;
    img.data[o] = r;
    img.data[o + 1] = g;
    img.data[o + 2] = b;
    img.data[o + 3] = m[i];
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

export class StampCache {
  private map = new Map<string, OffscreenCanvas>();
  constructor(private max = 48) {}

  /** A textured tip stamp of side `size`, scaled down from the full-size tip. */
  getTip(tip: BrushTip, color: string, size: number): OffscreenCanvas {
    const key = `tip|${tip}|${color}|${size}`;
    let s = this.map.get(key);
    if (s) {
      this.map.delete(key);
      this.map.set(key, s);
      return s;
    }
    const baseKey = `tipbase|${tip}|${color}`;
    let base = this.map.get(baseKey);
    if (!base) this.map.set(baseKey, (base = makeTipBase(tip, color)));
    if (size >= TIP_SIZE) s = base;
    else {
      s = new OffscreenCanvas(size, size);
      const ctx = s.getContext('2d')!;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(base, 0, 0, size, size);
    }
    this.map.set(key, s);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
    return s;
  }

  get(color: string, hardness: number, size: number): OffscreenCanvas {
    const h = Math.round(hardness * 100) / 100;
    const key = `${color}|${h}|${size}`;
    let s = this.map.get(key);
    if (s) {
      this.map.delete(key);
      this.map.set(key, s);
      return s;
    }
    s = makeStamp(color, h, size);
    this.map.set(key, s);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
    return s;
  }
}

/**
 * Draws one dab. (ox, oy) is the world position of the device origin, scale is device px per
 * world unit. The caller sets globalCompositeOperation.
 */
export class DabPainter {
  private lastBucket = -1;
  private lastStamp: OffscreenCanvas | null = null;
  private tip: BrushTip;
  private roundness: number;
  private patch: OffscreenCanvas | null = null;

  constructor(
    private ctx: Ctx2D,
    private stamps: StampCache,
    private brush: Brush,
    private ox: number,
    private oy: number,
    private scale: number,
  ) {
    const shape = brushShape(brush);
    this.tip = shape.tip;
    this.roundness = shape.roundness;
  }

  /** `rot` is the tip rotation in radians. Grain is not drawn here (WebGL2 only). */
  dab(x: number, y: number, r: number, a: number, rot = 0): void {
    let d = 2 * r * this.scale;
    if (d < 1) {
      // Sub-pixel dab: draw one pixel and scale alpha by the covered area.
      a *= d * d;
      d = 1;
    }
    if (a <= 0.0005) return;
    const ctx = this.ctx;
    const cx = (x - this.ox) * this.scale, cy = (y - this.oy) * this.scale;
    if (d > HUGE_STAMP) {
      // Deep zoom: a stamp pixel would cover thousands of target pixels, and the float32
      // transform of the canvas loses the dab position.
      if (this.tip === 'round') this.hugeRound(cx, cy, d / 2, Math.min(1, a), rot);
      else this.hugeTip(cx, cy, d / 2, Math.min(1, a), rot);
      return;
    }
    const bucket = stampBucket(d);
    if (bucket !== this.lastBucket) {
      this.lastBucket = bucket;
      this.lastStamp =
        this.tip === 'round'
          ? this.stamps.get(this.brush.color, this.brush.hardness, bucket)
          : this.stamps.getTip(this.tip, this.brush.color, bucket);
    }
    ctx.globalAlpha = Math.min(1, a);
    if ((this.tip === 'round' && this.roundness >= 1) || d <= 1) {
      ctx.drawImage(this.lastStamp!, cx - d / 2, cy - d / 2, d, d);
      return;
    }
    // Rotate, then squash along the tip height.
    const c = Math.cos(rot), s = Math.sin(rot), k = this.roundness;
    ctx.setTransform(c, s, -s * k, c * k, cx, cy);
    ctx.drawImage(this.lastStamp!, -d / 2, -d / 2, d, d);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /**
   * A huge round dab (radius R target pixels, center cx, cy), drawn analytically as the WebGL
   * shader does. All math is in double precision in the dab space (rotated by -rot, y divided by
   * the roundness, so the dab is a circle of radius R) relative to the target center. Only
   * small numbers go to the canvas: the outline is the part of the circle over the target, as a
   * polygon with vertices on the true edge, and the canvas antialiases it.
   */
  private hugeRound(cx: number, cy: number, R: number, alpha: number, rot: number): void {
    const ctx = this.ctx;
    const W = ctx.canvas.width, H = ctx.canvas.height;
    const hx = W / 2, hy = H / 2;
    const c = Math.cos(rot), s = Math.sin(rot), k = this.roundness;
    // Target offset -> dab space. The inverse of the canvas transform set below.
    const inv = (px: number, py: number): [number, number] => [c * px + s * py, (-s * px + c * py) / k];
    // The target center relative to the dab center, its distance, and its depth to the edge.
    const [vx, vy] = inv(hx - cx, hy - cy);
    const vl = Math.hypot(vx, vy);
    const D = vl - R; // > 0: the target center is outside the dab
    const ux = vl > 0 ? vx / vl : 1, uy = vl > 0 ? vy / vl : 0;
    const tx = -uy, ty = ux; // along the edge at the point nearest the target center
    // The target with a 2 px margin (the antialiased edges of the quad stay off the target).
    const M = 2;
    const quad = [inv(-hx - M, -hy - M), inv(hx + M, -hy - M), inv(hx + M, hy + M), inv(-hx - M, hy + M)];
    let L = 0;
    for (const [ex, ey] of quad) L = Math.max(L, Math.hypot(ex, ey));
    if (D >= L) return;
    // Proportional to |e + v|² - R², without the cancellation of huge numbers: < 0 inside.
    const den = vl + R;
    const S = (ex: number, ey: number) => (ex * ex + ey * ey + 2 * vl * (ex * ux + ey * uy)) / den + D;
    // 0 at the dab center, 1 on its edge.
    const tOf = (ex: number, ey: number) => Math.hypot(ex + vx, ey + vy) / R;
    const centerIn = this.insideQuad(quad, -vx, -vy);

    // The hardness falloff over the target: from tmin (nearest the dab center) to tmax.
    let tmax = 0;
    for (const [ex, ey] of quad) tmax = Math.max(tmax, tOf(ex, ey));
    tmax = Math.min(1, tmax);
    let tmin = Infinity;
    if (centerIn) tmin = 0;
    else {
      for (let i = 0; i < 4; i++) {
        const [ax, ay] = quad[i], [bx, by] = quad[(i + 1) % 4];
        const wx = bx - ax, wy = by - ay;
        const t = Math.min(1, Math.max(0, (-(vx * wx + vy * wy) - (ax * wx + ay * wy)) / (wx * wx + wy * wy)));
        tmin = Math.min(tmin, tOf(ax + t * wx, ay + t * wy));
      }
    }
    const h = this.brush.hardness;
    const prof = (t: number) => (t <= h ? 1 : t >= 1 ? 0 : 0.5 + 0.5 * Math.cos((Math.PI * (t - h)) / Math.max(1 - h, 1e-6)));
    const pHi = prof(tmin), pLo = prof(tmax);
    const band = (1 - h) * R * k; // width of the falloff in target pixels, where it is narrowest

    if (pHi - pLo >= 1 / 1024 && band >= 64) {
      // A wide falloff: it ends at 0 with no slope, so it needs no outline. Sample it on a grid
      // of g pixels; the canvas filter between samples keeps the error below half a level.
      const g = Math.min(16, band / 20);
      const nx = Math.ceil(W / g) + 2, ny = Math.ceil(H / g) + 2;
      const img = this.patchData(nx, ny);
      const data = img.data;
      for (let j = 0; j < ny; j++) {
        const dy = (j - 0.5) * g - hy;
        for (let i = 0; i < nx; i++) {
          const dx = (i - 0.5) * g - hx;
          data[(j * nx + i) * 4 + 3] = Math.round(255 * prof(tOf(c * dx + s * dy, (-s * dx + c * dy) / k)));
        }
      }
      this.drawPatch(img, g, 0, 0, g, -g, -g, alpha);
      return;
    }
    // The outline: the quad clipped to the circle. Arcs follow the circle between the points
    // where the quad edges leave and enter it.
    const pts: number[] = [];
    let full = false;
    if (-D >= L) {
      for (const [ex, ey] of quad) pts.push(ex, ey);
    } else {
      const ring: { x: number; y: number; cross: 0 | 1 | -1 }[] = []; // cross 1: enters, -1: leaves
      for (let i = 0; i < 4; i++) {
        const [ax, ay] = quad[i], [bx, by] = quad[(i + 1) % 4];
        const wx = bx - ax, wy = by - ay;
        const ga = S(ax, ay);
        if (ga < 0) ring.push({ x: ax, y: ay, cross: 0 });
        // S along the edge: al t² + be t + ga.
        const al = (wx * wx + wy * wy) / den;
        const be = (2 * (ax * wx + ay * wy) + 2 * vl * (wx * ux + wy * uy)) / den;
        const disc = be * be - 4 * al * ga;
        if (disc <= 0 || al <= 0) continue;
        const q = -0.5 * (be + Math.sign(be || 1) * Math.sqrt(disc));
        const roots = [q / al, ga / q].sort((p, r) => p - r);
        for (const t of roots) {
          if (!(t >= 0 && t < 1)) continue;
          ring.push({ x: ax + t * wx, y: ay + t * wy, cross: 2 * al * t + be < 0 ? 1 : -1 });
        }
      }
      const start = ring.findIndex((p) => p.cross === 1);
      if (start < 0) {
        // No crossing: the circle is inside the quad (its center is), or the quad is outside it.
        if (ring.length === 4) for (const p of ring) pts.push(p.x, p.y);
        else if (centerIn) full = true;
        else return;
      } else {
        // The quad corners go around in the same direction as the angle phi below.
        const area = (quad[1][0] - quad[0][0]) * (quad[2][1] - quad[0][1]) - (quad[2][0] - quad[0][0]) * (quad[1][1] - quad[0][1]);
        const dir = area >= 0 ? 1 : -1;
        const n = ring.length;
        for (let j = 0; j < n; j++) {
          const p = ring[(start + j) % n];
          pts.push(p.x, p.y);
          if (p.cross !== -1) continue;
          const e = ring[(start + j + 1) % n];
          let da = this.phi(e.x, e.y, ux, uy, vl) - this.phi(p.x, p.y, ux, uy, vl);
          if (dir > 0) da = da < 0 ? da + 2 * Math.PI : da;
          else da = da > 0 ? da - 2 * Math.PI : da;
          this.arc(pts, this.phi(p.x, p.y, ux, uy, vl), da, R, D, ux, uy, tx, ty, false);
        }
      }
    }
    if (full) this.arc(pts, 0, 2 * Math.PI, R, D, ux, uy, tx, ty, true);


    ctx.setTransform(c, s, -s * k, c * k, hx, hy);
    if (pHi - pLo < 1 / 1024) {
      ctx.globalAlpha = alpha * (pHi + pLo) / 2;
      ctx.fillStyle = this.brush.color;
    } else {
      // A thin falloff along the edge: a radial gradient from the core (h R) to the edge, so
      // the stops spread over the whole gradient (the canvas resolves a gradient through a
      // table, and a falloff in 0.5% of it became a hard step). Its float32 error is relative
      // to R, as the falloff width is.
      ctx.globalAlpha = alpha;
      const g = ctx.createRadialGradient(-vx, -vy, h * R, -vx, -vy, R);
      const [r, gr, b] = hexToRgb(this.brush.color);
      const STEPS = 32;
      for (let i = 0; i <= STEPS; i++) {
        const a = (0.5 + 0.5 * Math.cos((Math.PI * i) / STEPS)).toFixed(4); // no exponent: CSS rejects 6e-17
        g.addColorStop(i / STEPS, `rgba(${r},${gr},${b},${a})`);
      }
      ctx.fillStyle = g;
    }
    ctx.beginPath();
    ctx.moveTo(pts[0], pts[1]);
    for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
    ctx.closePath();
    ctx.fill();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** Angle of a point on the circle around the dab center, from the direction to the target. */
  private phi(ex: number, ey: number, ux: number, uy: number, vl: number): number {
    return Math.atan2(ex * -uy + ey * ux, vl + ex * ux + ey * uy);
  }

  /**
   * Adds points of the circle from angle a0 over da (not a0 itself unless `first`), relative to
   * the target center. The form with sin²(phi/2) keeps the numbers small for a huge radius.
   */
  private arc(pts: number[], a0: number, da: number, R: number, D: number, ux: number, uy: number, tx: number, ty: number, first: boolean): void {
    const step = Math.sqrt((8 * 0.01) / R); // the chords stay within 0.01 px of the circle
    const n = Math.min(8192, Math.max(1, Math.ceil(Math.abs(da) / step)));
    for (let i = first ? 0 : 1; i < n; i++) {
      const f = a0 + (da * i) / n;
      const sh = Math.sin(f / 2);
      const along = -(D + 2 * R * sh * sh), side = R * Math.sin(f);
      pts.push(along * ux + side * tx, along * uy + side * ty);
    }
  }

  private insideQuad(quad: [number, number][], px: number, py: number): boolean {
    let pos = 0, neg = 0;
    for (let i = 0; i < 4; i++) {
      const [ax, ay] = quad[i], [bx, by] = quad[(i + 1) % 4];
      const cr = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
      if (cr > 0) pos++;
      else if (cr < 0) neg++;
    }
    return pos === 0 || neg === 0;
  }

  /**
   * A huge textured dab. The target maps into tip space in double precision, relative to the
   * tip point under the target origin, and only the part of the tip over the target is drawn,
   * with a transform whose offset stays near the target.
   */
  private hugeTip(cx: number, cy: number, R: number, alpha: number, rot: number): void {
    const ctx = this.ctx;
    const W = ctx.canvas.width, H = ctx.canvas.height;
    const c = Math.cos(rot), s = Math.sin(rot), k = this.roundness;
    const N = TIP_SIZE;
    const ts = (2 * R) / N; // target pixels per texel along the tip width (ts × k along its height)
    // Tip space (texels) of a target point, relative to the tip point under the target origin.
    const rel = (px: number, py: number): [number, number] => [(c * px + s * py) / ts, (-s * px + c * py) / (k * ts)];
    const [ox, oy] = rel(-cx, -cy);
    const refX = N / 2 + ox, refY = N / 2 + oy; // that point, absolute
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [px, py] of [[0, 0], [W, 0], [W, H], [0, H]]) {
      const [tx, ty] = rel(px, py);
      x0 = Math.min(x0, tx); x1 = Math.max(x1, tx);
      y0 = Math.min(y0, ty); y1 = Math.max(y1, ty);
    }
    // The tip covers 0..N.
    x0 = Math.max(x0, -refX); x1 = Math.min(x1, N - refX);
    y0 = Math.max(y0, -refY); y1 = Math.min(y1, N - refY);
    if (x1 <= x0 || y1 <= y0) return;
    ctx.globalAlpha = alpha;
    if (ts <= 1024) {
      // A texel is at most 1024 px: the canvas samples the tip image precisely enough. Draw the
      // texels over the target with one texel of margin for the bilinear filter.
      const i0 = Math.max(0, Math.floor(refX + x0) - 1), i1 = Math.min(N, Math.ceil(refX + x1) + 1);
      const j0 = Math.max(0, Math.floor(refY + y0) - 1), j1 = Math.min(N, Math.ceil(refY + y1) + 1);
      if (i1 <= i0 || j1 <= j0) return;
      const img = this.stamps.getTip(this.tip, this.brush.color, N);
      const ex = (i0 - refX) * ts, ey = (j0 - refY) * ts * k;
      ctx.setTransform(c * ts, s * ts, -s * k * ts, c * k * ts, c * ex - s * ey, s * ex + c * ey);
      ctx.drawImage(img, i0, j0, i1 - i0, j1 - j0, 0, 0, i1 - i0, j1 - j0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      return;
    }
    // Larger texels: sample the tip here (bilinear, as the WebGL texture) on a grid along the
    // tip axes, gx, gy target pixels apart. The tip is piecewise linear between texel centers,
    // so the canvas filter between grid samples is exact to about 1/255.
    const gx = Math.min(16, ts / 64), gy = Math.max(1, Math.min(16, (ts * k) / 64));
    const sx = gx / ts, sy = gy / (ts * k); // grid step in texels
    const nx = Math.min(8192, Math.ceil((x1 - x0) / sx) + 3), ny = Math.min(8192, Math.ceil((y1 - y0) / sy) + 3);
    const bx = x0 - sx, by = y0 - sy; // tip position of grid sample 0, relative
    const img = this.patchData(nx, ny);
    const mask = tipMask(this.tip);
    const at = (i: number, j: number) => mask[Math.min(N - 1, Math.max(0, j)) * N + Math.min(N - 1, Math.max(0, i))];
    const data = img.data;
    for (let j = 0; j < ny; j++) {
      const ty = refY + by + j * sy;
      const fy = ty - 0.5, jy = Math.floor(fy), wy = fy - jy;
      for (let i = 0; i < nx; i++) {
        const tx = refX + bx + i * sx;
        if (tx < 0 || tx > N || ty < 0 || ty > N) continue;
        const fx = tx - 0.5, ix = Math.floor(fx), wx = fx - ix;
        const top = at(ix, jy) + (at(ix + 1, jy) - at(ix, jy)) * wx;
        const bot = at(ix, jy + 1) + (at(ix + 1, jy + 1) - at(ix, jy + 1)) * wx;
        data[(j * nx + i) * 4 + 3] = Math.round(top + (bot - top) * wy);
      }
    }
    // Grid sample (i, j) is at the center of patch pixel (i, j).
    const ex = (bx - 0.5 * sx) * ts, ey = (by - 0.5 * sy) * ts * k;
    this.drawPatch(img, c * gx, s * gx, -s * gy, c * gy, c * ex - s * ey, s * ex + c * ey, alpha);
  }

  /** Pixels for a patch of nx × ny samples in the brush color, all transparent. */
  private patchData(nx: number, ny: number): ImageData {
    const patch = (this.patch ??= new OffscreenCanvas(1, 1));
    if (patch.width !== nx || patch.height !== ny) {
      patch.width = nx;
      patch.height = ny;
    }
    const img = patch.getContext('2d')!.createImageData(nx, ny);
    const [r, g, b] = hexToRgb(this.brush.color);
    const d = img.data;
    for (let o = 0; o < d.length; o += 4) {
      d[o] = r;
      d[o + 1] = g;
      d[o + 2] = b;
    }
    return img;
  }

  /** Draws the patch with the transform (a..f); patch pixel centers are the samples. */
  private drawPatch(img: ImageData, a: number, b: number, c: number, d: number, e: number, f: number, alpha: number): void {
    const patch = this.patch!;
    patch.getContext('2d')!.putImageData(img, 0, 0);
    const ctx = this.ctx;
    ctx.globalAlpha = alpha;
    ctx.setTransform(a, b, c, d, e, f);
    ctx.drawImage(patch, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
}
