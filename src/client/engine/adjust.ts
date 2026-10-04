// Adjustment layer math, shared by both renderers. Levels, curves and brightness/contrast are
// one tone curve per channel (a lookup table). Hue/saturation works in HSL.

import type { Adjust } from '../../shared/types';

export const LUT_SIZE = 1024;

/** Monotone cubic (Fritsch–Carlson) through sorted points: no overshoot between points. */
function monotoneCurve(points: [number, number][]): (x: number) => number {
  const n = points.length;
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  const m: number[] = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i], b = m[i + 1] / d[i], h = a * a + b * b;
    if (h > 9) {
      const t = 3 / Math.sqrt(h);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h;
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}

/** The tone function of a levels, curves or brightness/contrast adjustment. */
export function toneFunction(a: Adjust): ((x: number) => number) | null {
  switch (a.type) {
    case 'levels': {
      const span = Math.max(1e-6, a.inWhite - a.inBlack);
      return (x) => {
        const t = Math.min(1, Math.max(0, (x - a.inBlack) / span)) ** (1 / a.gamma);
        return a.outBlack + t * (a.outWhite - a.outBlack);
      };
    }
    case 'curves':
      return monotoneCurve(a.points);
    case 'brightContrast': {
      // Contrast turns the slope around mid grey (tan of 0..90°). Brightness bends the curve and
      // keeps black and white in place.
      const k = Math.tan(((Math.max(-0.999, Math.min(0.999, a.contrast)) + 1) * Math.PI) / 4);
      const b = a.brightness;
      return (x) => {
        const c = Math.min(1, Math.max(0, (x - 0.5) * k + 0.5));
        return b >= 0 ? 1 - (1 - c) ** (1 + b * 2) : c ** (1 - b * 2);
      };
    }
    case 'hueSat':
      return null;
  }
}

/** Lookup table for the GPU: LUT_SIZE samples of the tone function over 0..1. */
export function toneLut(a: Adjust): Float32Array {
  const f = toneFunction(a);
  const out = new Float32Array(LUT_SIZE);
  for (let i = 0; i < LUT_SIZE; i++) {
    const x = i / (LUT_SIZE - 1);
    out[i] = f ? Math.min(1, Math.max(0, f(x))) : x;
  }
  return out;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2, d = mx - mn;
  if (d < 1e-6) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}

function hue2rgb(p: number, q: number, t: number): number {
  t -= Math.floor(t);
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

/** Hue/saturation on one unpremultiplied pixel (0..1 channels). Same formulas as the shader. */
export function hueSat(a: Extract<Adjust, { type: 'hueSat' }>, r: number, g: number, b: number): [number, number, number] {
  let [h, s, l] = rgbToHsl(r, g, b);
  h += a.hue / 360;
  s = a.saturation >= 0 ? s + (1 - s) * a.saturation : s * (1 + a.saturation);
  l = a.lightness >= 0 ? l + (1 - l) * a.lightness : l * (1 + a.lightness);
  if (s <= 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2rgb(p, q, h + 1 / 3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1 / 3)];
}
