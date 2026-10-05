// Brush preset thumbnails: the preset drawn along a squiggle with a pressure curve (light at both
// ends, full in the middle). Made in the browser from the settings, with the same dab walker and
// stamps as real strokes, so a thumbnail always matches how the brush draws. Cached by settings.

import { DabWalker } from '../shared/brush';
import type { Brush, BrushSettings } from '../shared/types';
import { DabPainter, StampCache } from './engine/stamp';
import { GRAIN_SIZE, grainMap } from './engine/tips';

const stamps = new StampCache(64);
const cache = new Map<string, string>();
const INK = '#e6e6e6';

/** A PNG data URL of w × h CSS pixels. */
export function presetThumb(settings: BrushSettings, w = 160, h = 56): string {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const key = `${JSON.stringify(settings)}|${w}|${h}|${dpr}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const W = Math.round(w * dpr), H = Math.round(h * dpr);
  const layer = new OffscreenCanvas(W, H);
  const ctx = layer.getContext('2d', { willReadFrequently: true })!;
  // Big brushes are scaled down: the full-pressure dab takes at most 55% of the height.
  const size = Math.max(1, Math.min(settings.size * dpr, H * 0.55));
  const brush: Brush = { ...settings, size, tool: 'paint', color: INK };
  const walker = new DabWalker(brush, 7);
  const painter = new DabPainter(ctx, stamps, brush, 0, 0, 1);
  const sink = (x: number, y: number, r: number, a: number, rot: number) => painter.dab(x, y, r, a, rot);

  const margin = size / 2 + 3 * dpr;
  const amp = Math.max(0, H / 2 - margin) * 0.7;
  const N = 96;
  let ox = 0, oy = 0;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const x = margin + t * (W - 2 * margin);
    const y = H / 2 - Math.sin(t * Math.PI * 2) * amp;
    const p = 0.08 + 0.92 * Math.sin(Math.PI * t) ** 0.8; // pressure: taper in, full, taper out
    if (i === 0) [ox, oy] = [x, y];
    walker.push(x, y, p, sink);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  // Grain in stroke space, as the WebGL2 shader does (on the whole stroke, not per dab).
  const strength = settings.grain ? (settings.grainStrength ?? 0.5) : 0;
  if (settings.grain && strength > 0) {
    const period = size * (settings.grainScale ?? 1);
    const map = grainMap(settings.grain);
    const img = ctx.getImageData(0, 0, W, H);
    const d = img.data;
    const frac = (v: number) => v - Math.floor(v);
    for (let y = 0; y < H; y++) {
      const gy = Math.floor(frac((y + 0.5 - oy) / period) * GRAIN_SIZE) * GRAIN_SIZE;
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4 + 3;
        if (!d[o]) continue;
        const g = map[gy + Math.floor(frac((x + 0.5 - ox) / period) * GRAIN_SIZE)] / 255;
        d[o] = Math.round(d[o] * (1 - strength + strength * g));
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  // Flow builds up inside the stroke; opacity caps the whole stroke.
  const out = document.createElement('canvas');
  out.width = W;
  out.height = H;
  const octx = out.getContext('2d')!;
  octx.globalAlpha = settings.opacity;
  octx.drawImage(layer, 0, 0);
  const url = out.toDataURL('image/png');
  cache.set(key, url);
  if (cache.size > 400) cache.delete(cache.keys().next().value!);
  return url;
}
