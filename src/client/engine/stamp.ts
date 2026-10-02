// Brush tip stamps and dab drawing. Runs on the main thread and inside the tile worker.

import type { Brush } from '../../shared/types';

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

export class StampCache {
  private map = new Map<string, OffscreenCanvas>();
  constructor(private max = 48) {}

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

  constructor(
    private ctx: Ctx2D,
    private stamps: StampCache,
    private brush: Brush,
    private ox: number,
    private oy: number,
    private scale: number,
  ) {}

  dab(x: number, y: number, r: number, a: number): void {
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
      this.lastStamp = this.stamps.get(this.brush.color, this.brush.hardness, bucket);
    }
    const ctx = this.ctx;
    ctx.globalAlpha = Math.min(1, a);
    ctx.drawImage(this.lastStamp!, (x - this.ox) * this.scale - d / 2, (y - this.oy) * this.scale - d / 2, d, d);
  }
}
