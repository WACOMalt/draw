// Deterministic dab placement. The tile worker and the live (main thread) renderer both use
// this module, so the same points always produce the same dabs.

import type { Brush } from './types';

export const DEFAULT_BRUSH: Brush = {
  tool: 'paint',
  color: '#1e1e1e',
  size: 24,
  opacity: 1,
  flow: 1,
  hardness: 0.8,
  spacing: 0.1,
  pressureSize: true,
  pressureFlow: false,
  buildup: false,
};

/** Smallest dab step as a fraction of the diameter. Everything is relative to the brush size,
 *  so strokes behave the same at any zoom. */
const MIN_STEP = 0.005;
const MIN_PRESSURE = 0.02;

export function dabRadius(brush: Brush, p: number): number {
  return (brush.pressureSize ? brush.size * Math.max(MIN_PRESSURE, p) : brush.size) / 2;
}

export function dabAlpha(brush: Brush, p: number): number {
  return brush.pressureFlow ? brush.flow * Math.max(MIN_PRESSURE, p) : brush.flow;
}

/** Decimal places that keep about 0.1 device pixel of precision at this device scale
 *  (device px per world unit). Negative means rounding to tens, hundreds, ... */
export function pointDecimals(deviceScale: number): number {
  return Math.max(-15, Math.min(15, Math.ceil(Math.log10(deviceScale * 10))));
}

function roundTo(v: number, decimals: number): number {
  if (decimals >= 0) {
    const f = 10 ** decimals;
    return Math.round(v * f) / f;
  }
  const f = 10 ** -decimals;
  return Math.round(v / f) * f;
}

/** Rounds a point to the precision that goes over the wire. Only the payload size depends on
 *  this: local and remote renders both use the exact same rounded numbers. */
export function quantizePoint(x: number, y: number, p: number, decimals: number): [number, number, number] {
  return [roundTo(x, decimals), roundTo(y, decimals), Math.round(p * 1000) / 1000];
}

export type DabSink = (x: number, y: number, r: number, a: number) => void;

/**
 * Walks a polyline and emits a dab each time the walked distance reaches spacing × diameter.
 * Feed points incrementally with push(); state carries across calls.
 */
export class DabWalker {
  private lx = 0;
  private ly = 0;
  private lp = 0;
  private started = false;
  /** Distance walked since the last dab. */
  private carry = 0;
  /** Pressure at the last dab; it sets the step to the next dab. */
  private dabP = 0;

  constructor(private brush: Brush) {}

  private step(): number {
    return Math.max(MIN_STEP, this.brush.spacing) * dabRadius(this.brush, this.dabP) * 2;
  }

  push(x: number, y: number, p: number, emit: DabSink): void {
    const b = this.brush;
    if (!this.started) {
      this.started = true;
      this.lx = x;
      this.ly = y;
      this.lp = p;
      this.dabP = p;
      this.carry = 0;
      emit(x, y, dabRadius(b, p), dabAlpha(b, p));
      return;
    }
    const dx = x - this.lx;
    const dy = y - this.ly;
    const len = Math.hypot(dx, dy);
    if (len === 0) {
      if (b.buildup) {
        this.dabP = p;
        this.carry = 0;
        emit(x, y, dabRadius(b, p), dabAlpha(b, p));
      }
      this.lp = p;
      return;
    }
    let t = 0;
    for (;;) {
      const need = this.step() - this.carry;
      if (t + need > len) {
        this.carry += len - t;
        break;
      }
      t += need;
      this.carry = 0;
      const f = t / len;
      const pp = this.lp + (p - this.lp) * f;
      this.dabP = pp;
      emit(this.lx + dx * f, this.ly + dy * f, dabRadius(b, pp), dabAlpha(b, pp));
    }
    this.lx = x;
    this.ly = y;
    this.lp = p;
  }
}

/** Dabs of a full stroke, packed as x, y, r, a, plus bounding boxes of 64-dab chunks for culling. */
export interface DabList {
  dabs: Float64Array;
  count: number;
  /** minX, minY, maxX, maxY per chunk */
  chunks: Float64Array;
  bbox: [number, number, number, number];
}

export const DAB_CHUNK = 64;

export function computeDabs(brush: Brush, pts: number[]): DabList {
  let cap = 256;
  let dabs = new Float64Array(cap * 4);
  let n = 0;
  const walker = new DabWalker(brush);
  const sink: DabSink = (x, y, r, a) => {
    if (n === cap) {
      cap *= 2;
      const next = new Float64Array(cap * 4);
      next.set(dabs);
      dabs = next;
    }
    const o = n * 4;
    dabs[o] = x;
    dabs[o + 1] = y;
    dabs[o + 2] = r;
    dabs[o + 3] = a;
    n++;
  };
  for (let i = 0; i + 2 < pts.length; i += 3) walker.push(pts[i], pts[i + 1], pts[i + 2], sink);

  const nChunks = Math.ceil(n / DAB_CHUNK);
  const chunks = new Float64Array(nChunks * 4);
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (let c = 0; c < nChunks; c++) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const end = Math.min(n, (c + 1) * DAB_CHUNK);
    for (let i = c * DAB_CHUNK; i < end; i++) {
      const o = i * 4;
      const r = dabs[o + 2];
      x0 = Math.min(x0, dabs[o] - r);
      y0 = Math.min(y0, dabs[o + 1] - r);
      x1 = Math.max(x1, dabs[o] + r);
      y1 = Math.max(y1, dabs[o + 1] + r);
    }
    chunks.set([x0, y0, x1, y1], c * 4);
    bx0 = Math.min(bx0, x0);
    by0 = Math.min(by0, y0);
    bx1 = Math.max(bx1, x1);
    by1 = Math.max(by1, y1);
  }
  return { dabs: dabs.subarray(0, n * 4), count: n, chunks, bbox: [bx0, by0, bx1, by1] };
}
