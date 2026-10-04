// Brush tips and grain textures, generated from code: no image files, and both renderers get the
// same pixels. Each generator is deterministic. Never change the output of a released tip or
// grain (old strokes would change): add a new id in BRUSH_TIPS or GRAINS instead.
//
// A tip is an alpha mask inside the unit circle, so a rotated dab never grows past its radius.
// A grain is a tileable value map in 0..1 (1 lets all paint through).

import { BRUSH_TIPS, GRAINS, type BrushTip, type GrainId } from '../../shared/types';

export const TIP_SIZE = 256;
export const GRAIN_SIZE = 256;

/** Integer hash to [0, 1). */
function hash(x: number, y: number, seed: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Small deterministic generator for placing bristles and drops. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Value noise, tileable with `period` cells. */
function noise(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const w = (i: number) => ((i % period) + period) % period;
  const a = hash(w(xi), w(yi), seed), b = hash(w(xi + 1), w(yi), seed);
  const c = hash(w(xi), w(yi + 1), seed), d = hash(w(xi + 1), w(yi + 1), seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** Fractal noise in 0..1, tileable over [0, 1) when `cells` divides each octave. */
function fbm(u: number, v: number, cells: number, octaves: number, seed: number): number {
  let sum = 0, amp = 0.5, total = 0, f = cells;
  for (let o = 0; o < octaves; o++) {
    sum += noise(u * f, v * f, f, seed + o * 17) * amp;
    total += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / total;
}

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Alpha mask of a tip, TIP_SIZE², row-major, 0..255. */
function makeTip(tip: BrushTip): Uint8Array {
  const N = TIP_SIZE;
  const out = new Uint8Array(N * N);
  const px = 2 / N; // one pixel in unit coordinates
  const put = (fn: (x: number, y: number, u: number, v: number) => number) => {
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const x = ((i + 0.5) / N) * 2 - 1, y = ((j + 0.5) / N) * 2 - 1;
        out[j * N + i] = Math.round(Math.min(1, Math.max(0, fn(x, y, i / N, j / N))) * 255);
      }
    }
  };
  switch (tip) {
    case 'round':
      put((x, y) => smooth(1, 1 - px, Math.hypot(x, y)));
      break;
    case 'square': {
      const h = 0.7; // half side: the corners stay inside the unit circle
      put((x, y) => smooth(h, h - px, Math.max(Math.abs(x), Math.abs(y))));
      break;
    }
    case 'chalk':
      // A disk with a rough edge and a dry, broken inside.
      put((x, y, u, v) => {
        const d = Math.hypot(x, y) + (fbm(u, v, 8, 4, 11) - 0.5) * 0.35;
        const body = smooth(0.92, 0.75, d);
        const dry = smooth(0.25, 0.6, fbm(u, v, 32, 3, 12));
        return body * (0.35 + 0.65 * dry);
      });
      break;
    case 'charcoal':
      // Streaky grain along x, soft rough edge.
      put((x, y, u, v) => {
        const d = Math.hypot(x, y * 1.15) + (fbm(u, v, 6, 3, 21) - 0.5) * 0.3;
        const body = smooth(0.95, 0.6, d);
        const streak = smooth(0.35, 0.75, fbm(u * 0.25, v * 3, 16, 3, 22));
        return body * (0.25 + 0.75 * streak);
      });
      break;
    case 'bristle': {
      // Many small hairs: soft dots of mixed size and strength, packed in the circle.
      const r = rng(31);
      const hairs: [number, number, number, number][] = [];
      for (let k = 0; k < 70; k++) {
        const ang = r() * Math.PI * 2, rad = Math.sqrt(r()) * 0.8;
        hairs.push([Math.cos(ang) * rad, Math.sin(ang) * rad, 0.05 + r() * 0.07, 0.45 + r() * 0.55]);
      }
      put((x, y) => {
        let a = 0;
        for (const [hx, hy, hr, ha] of hairs) {
          const t = smooth(hr, hr * 0.4, Math.hypot(x - hx, y - hy)) * ha;
          a = a + t - a * t;
        }
        return a;
      });
      break;
    }
    case 'splatter': {
      // Drops of mixed size, denser near the center.
      const r = rng(41);
      const drops: [number, number, number][] = [];
      for (let k = 0; k < 28; k++) {
        const ang = r() * Math.PI * 2, rad = r() ** 1.5 * 0.85;
        drops.push([Math.cos(ang) * rad, Math.sin(ang) * rad, 0.03 + r() ** 2 * 0.16]);
      }
      put((x, y) => {
        let a = 0;
        for (const [dx, dy, dr] of drops) a = Math.max(a, smooth(dr, dr - px * 1.5, Math.hypot(x - dx, y - dy)));
        return a;
      });
      break;
    }
    case 'pencil':
      // A firm small disk with fine graphite grain.
      put((x, y, u, v) => {
        const body = smooth(1, 0.85, Math.hypot(x, y));
        return body * (0.55 + 0.45 * smooth(0.3, 0.7, fbm(u, v, 64, 2, 51)));
      });
      break;
  }
  return out;
}

/** Tileable grain, GRAIN_SIZE², 0..255. */
function makeGrain(g: GrainId): Uint8Array {
  const N = GRAIN_SIZE;
  const out = new Uint8Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const u = i / N, v = j / N;
      let val = 0;
      switch (g) {
        case 'paper':
          val = smooth(0.25, 0.8, fbm(u, v, 8, 5, 61));
          break;
        case 'canvas': {
          // Over-under weave plus a little irregularity.
          const wx = 0.5 + 0.5 * Math.sin(u * Math.PI * 2 * 24);
          const wy = 0.5 + 0.5 * Math.sin(v * Math.PI * 2 * 24);
          const over = Math.floor(u * 24) + Math.floor(v * 24);
          val = (over % 2 ? wx : wy) * 0.75 + fbm(u, v, 16, 3, 71) * 0.25;
          break;
        }
        case 'noise':
          val = fbm(u, v, 64, 2, 81);
          break;
      }
      out[j * N + i] = Math.round(Math.min(1, Math.max(0, val)) * 255);
    }
  }
  return out;
}

const tipCache = new Map<BrushTip, Uint8Array>();
const grainCache = new Map<GrainId, Uint8Array>();

export function tipMask(tip: BrushTip): Uint8Array {
  let m = tipCache.get(tip);
  if (!m) tipCache.set(tip, (m = makeTip(tip)));
  return m;
}

export function grainMap(g: GrainId): Uint8Array {
  let m = grainCache.get(g);
  if (!m) grainCache.set(g, (m = makeGrain(g)));
  return m;
}

/** Layer index of a tip or grain in the GPU texture arrays. */
export const tipIndex = (t: BrushTip) => BRUSH_TIPS.indexOf(t);
export const grainIndex = (g: GrainId) => GRAINS.indexOf(g);
