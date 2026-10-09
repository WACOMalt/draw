// Brush tip stamps and dab drawing. Runs on the main thread and inside the tile worker.

import { brushShape } from '../../shared/brush';
import type { Brush, BrushTip } from '../../shared/types';
import { TIP_SIZE, tipMask } from './tips';

/** Above this diameter in pixels, an axis-aligned dab draws only its visible part (see dab). */
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
    const bucket = stampBucket(d);
    if (bucket !== this.lastBucket) {
      this.lastBucket = bucket;
      this.lastStamp =
        this.tip === 'round'
          ? this.stamps.get(this.brush.color, this.brush.hardness, bucket)
          : this.stamps.getTip(this.tip, this.brush.color, bucket);
    }
    const ctx = this.ctx;
    ctx.globalAlpha = Math.min(1, a);
    const cx = (x - this.ox) * this.scale, cy = (y - this.oy) * this.scale;
    if ((this.tip === 'round' && this.roundness >= 1) || d <= 1) {
      const img = this.lastStamp!;
      if (d <= HUGE_STAMP) {
        ctx.drawImage(img, cx - d / 2, cy - d / 2, d, d);
        return;
      }
      // A huge dab (deep zoom): draw only the part of the stamp over the canvas. Destination
      // rectangles of millions of pixels lose precision, and the dab vanished.
      const x0 = Math.max(0, cx - d / 2), y0 = Math.max(0, cy - d / 2);
      const x1 = Math.min(ctx.canvas.width, cx + d / 2), y1 = Math.min(ctx.canvas.height, cy + d / 2);
      if (x1 <= x0 || y1 <= y0) return;
      const k = img.width / d;
      let sx = (x0 - (cx - d / 2)) * k, sy = (y0 - (cy - d / 2)) * k, sw = (x1 - x0) * k, sh = (y1 - y0) * k;
      // At extreme zoom the visible part of the stamp is a billionth of a pixel: float32 makes
      // that an empty rectangle. Read at least 1/64 pixel around the same point (one color there).
      const MIN = 1 / 64;
      if (sw < MIN) [sx, sw] = [sx + sw / 2 - MIN / 2, MIN];
      if (sh < MIN) [sy, sh] = [sy + sh / 2 - MIN / 2, MIN];
      ctx.drawImage(img, sx, sy, sw, sh, x0, y0, x1 - x0, y1 - y0);
      return;
    }
    // Rotate, then squash along the tip height.
    const c = Math.cos(rot), s = Math.sin(rot), k = this.roundness;
    ctx.setTransform(c, s, -s * k, c * k, cx, cy);
    ctx.drawImage(this.lastStamp!, -d / 2, -d / 2, d, d);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
}
