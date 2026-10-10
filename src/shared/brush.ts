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

/**
 * True when a dab of this brush can have an alpha below 1/2 (low flow, pressure flow, opacity
 * jitter). In an 8-bit buffer, such a dab stops changing a pixel once the change rounds to zero.
 * Straight onto existing paint, this stops the color at a fixed floor (19/255 at about 3% flow).
 * In an empty stroke buffer, as the stroke in progress draws, only the alpha stops near 1.
 */
export function lowFlow(brush: Brush): boolean {
  return brush.flow < 0.5 || brush.pressureFlow || (brush.opacityJitter ?? 0) > 0;
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

/** One dab: center, radius, alpha, and the tip rotation in radians. */
export type DabSink = (x: number, y: number, r: number, a: number, rot: number) => void;

/** Seed for the random dynamics of a stroke, from its id: the same on every client and replay. */
export function strokeSeed(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Random number in [0, 1) for dab `i`, channel `c`. Stateless: a tile that renders only a part
 * of a stroke gets the same values as every other tile, client and replay.
 */
export function dabRandom(seed: number, i: number, c: number): number {
  let h = (seed ^ Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(c + 1, 0x85ebca77)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** The brush tip and dynamics with their defaults filled in. */
export function brushShape(b: Brush) {
  return {
    tip: b.tip ?? 'round',
    angle: ((b.angle ?? 0) * Math.PI) / 180,
    roundness: b.roundness ?? 1,
    follow: b.followDirection ?? false,
    sizeJitter: b.sizeJitter ?? 0,
    angleJitter: b.angleJitter ?? 0,
    scatter: b.scatter ?? 0,
    opacityJitter: b.opacityJitter ?? 0,
  };
}

/**
 * Walks a polyline and emits a dab each time the walked distance reaches spacing × diameter.
 * Feed points incrementally with push(); state carries across calls. The dab positions along
 * the path never depend on the random dynamics, which only change each emitted dab.
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
  /** Dabs emitted so far: the index for the random dynamics. */
  private n = 0;
  /** Direction of the last segment, radians. */
  private dir = 0;
  private shape: ReturnType<typeof brushShape>;
  private plain: boolean;

  constructor(
    private brush: Brush,
    private seed = 0,
  ) {
    this.shape = brushShape(brush);
    const s = this.shape;
    this.plain = !s.follow && !s.sizeJitter && !s.angleJitter && !s.scatter && !s.opacityJitter;
  }

  /** Applies the dynamics of dab n and emits it. */
  private dab(x: number, y: number, r: number, a: number, emit: DabSink): void {
    const s = this.shape;
    const i = this.n++;
    if (this.plain) return emit(x, y, r, a, s.angle);
    const seed = this.seed;
    let rot = s.angle + (s.follow ? this.dir : 0);
    if (s.angleJitter) rot += (dabRandom(seed, i, 2) - 0.5) * 2 * Math.PI * s.angleJitter;
    if (s.scatter) {
      // Across the stroke direction, up to `scatter` diameters to each side.
      const off = (dabRandom(seed, i, 3) * 2 - 1) * s.scatter * 2 * r;
      x -= Math.sin(this.dir) * off;
      y += Math.cos(this.dir) * off;
    }
    if (s.sizeJitter) r *= 1 - s.sizeJitter * dabRandom(seed, i, 0);
    if (s.opacityJitter) a *= 1 - s.opacityJitter * dabRandom(seed, i, 1);
    emit(x, y, r, a, rot);
  }

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
      this.dab(x, y, dabRadius(b, p), dabAlpha(b, p), emit);
      return;
    }
    const dx = x - this.lx;
    const dy = y - this.ly;
    const len = Math.hypot(dx, dy);
    if (len === 0) {
      if (b.buildup) {
        this.dabP = p;
        this.carry = 0;
        this.dab(x, y, dabRadius(b, p), dabAlpha(b, p), emit);
      }
      this.lp = p;
      return;
    }
    this.dir = Math.atan2(dy, dx);
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
      this.dab(this.lx + dx * f, this.ly + dy * f, dabRadius(b, pp), dabAlpha(b, pp), emit);
    }
    this.lx = x;
    this.ly = y;
    this.lp = p;
  }
}

/** Floats per dab in a DabList: x, y, r, a, rot. */
export const DAB_STRIDE = 5;

/** Dabs of a full stroke, packed as x, y, r, a, rot, plus bounding boxes of 64-dab chunks for culling. */
export interface DabList {
  dabs: Float64Array;
  count: number;
  /** minX, minY, maxX, maxY per chunk */
  chunks: Float64Array;
  bbox: [number, number, number, number];
}

export const DAB_CHUNK = 64;

export function computeDabs(brush: Brush, pts: number[], seed = 0): DabList {
  const S = DAB_STRIDE;
  let cap = 256;
  let dabs = new Float64Array(cap * S);
  let n = 0;
  const walker = new DabWalker(brush, seed);
  const sink: DabSink = (x, y, r, a, rot) => {
    if (n === cap) {
      cap *= 2;
      const next = new Float64Array(cap * S);
      next.set(dabs);
      dabs = next;
    }
    const o = n * S;
    dabs[o] = x;
    dabs[o + 1] = y;
    dabs[o + 2] = r;
    dabs[o + 3] = a;
    dabs[o + 4] = rot;
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
      const o = i * S;
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
  return { dabs: dabs.subarray(0, n * S), count: n, chunks, bbox: [bx0, by0, bx1, by1] };
}
