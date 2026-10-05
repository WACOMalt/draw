// Embeds: a live, view-only copy of a canvas on another site, in an <iframe>.
// The address is /e/<code>?k=<view token>&r=<x>,<y>,<w>,<h>: the world rectangle to frame.

import type { Bounds } from './engine/doc';

/** Formats the frame with enough digits for its size: x and y to 1/10000 of the width. */
function frameParam(b: Bounds): string {
  const w = b.x1 - b.x0, h = b.y1 - b.y0;
  const d = Math.min(20, Math.max(0, Math.ceil(-Math.log10(w / 1e4))));
  return [b.x0.toFixed(d), b.y0.toFixed(d), +w.toPrecision(6), +h.toPrecision(6)].join(',');
}

/** Parses r=x,y,w,h. Null when it is missing or not four finite numbers with w, h > 0. */
export function parseFrame(r: string | null): Bounds | null {
  const n = (r ?? '').split(',').map(Number);
  if (n.length !== 4 || !n.every(Number.isFinite) || n[2] <= 0 || n[3] <= 0) return null;
  return { x0: n[0], y0: n[1], x1: n[0] + n[2], y1: n[1] + n[3] };
}

export function embedUrl(origin: string, key: string, token: string | null, frame: Bounds): string {
  const k = token ? `k=${encodeURIComponent(token)}&` : '';
  return `${origin}/e/${encodeURIComponent(key)}?${k}r=${frameParam(frame)}`;
}

/** The HTML to paste: full width at the aspect of the view, or a fixed width. */
export function embedCode(url: string, w: number, h: number, width: number | null): string {
  const aw = Math.max(1, Math.round(w)), ah = Math.max(1, Math.round(h));
  const size = width ? `width:${width}px;max-width:100%` : 'width:100%';
  return `<iframe src="${url}" title="Drawing on Draw" style="${size};aspect-ratio:${aw} / ${ah};border:0;border-radius:8px" loading="lazy" allow="fullscreen" allowfullscreen></iframe>`;
}
