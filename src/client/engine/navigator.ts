// Markers that keep content findable on an infinite, deep-zoom canvas.
//
// Every stroke on a visible layer ends up in exactly one of three states:
//  - big enough to see on screen: no marker
//  - on screen but too small to see: grouped with nearby tiny strokes into one "here" marker
//  - off screen: counted in one of 8 "edge" markers that point toward it
// Markers merge by screen distance, so the view never gets dense, and nothing is unaccounted for.

import type { Bounds, Doc } from './doc';
import type { ViewState } from './renderer';

export interface Marker {
  key: string;
  kind: 'here' | 'edge';
  /** Position in CSS px within the canvas. */
  x: number;
  y: number;
  /** Edge markers: direction toward the content, radians (0 = right, y down). */
  angle: number;
  count: number;
  /** World bounds to fly to. */
  target: Bounds;
}

/** A stroke smaller than this on screen (px) counts as not visible. */
const TINY = 10;
/** First grid cell for grouping tiny strokes (px). It doubles until the pins fit MAX_HERE. */
const CELL = 48;
const MAX_HERE = 20;
/** Groups closer than this (px) merge, as long as the result stays within 2 cells. */
const LINK = 28;
/** A group this big (px) whose strokes cover this share of its area reads as a shape: no pin. */
const VISIBLE_GROUP = 36;
const VISIBLE_COVERAGE = 0.05;
/** Edge markers sit this far inside the canvas edge (px). */
const EDGE_INSET = 30;
/** Bottom-right corner kept free for the viewport buttons (px, coarse pointers included). */
const CONTROLS_W = 68;
const CONTROLS_H = 120;

interface Tiny {
  b: Bounds; // world
  s: Bounds; // screen
}

interface Group {
  b: Bounds; // world
  s: Bounds; // screen
  n: number;
  /** Sum of member screen areas, for the coverage test. */
  ink: number;
  members: Tiny[];
  parent: Group | null;
}

function union(a: Bounds, b: Bounds): Bounds {
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

function root(g: Group): Group {
  while (g.parent) g = g.parent;
  return g;
}

function gap(a: Bounds, b: Bounds): number {
  const dx = Math.max(0, a.x0 - b.x1, b.x0 - a.x1);
  const dy = Math.max(0, a.y0 - b.y1, b.y0 - a.y1);
  return Math.hypot(dx, dy);
}

export function computeMarkers(doc: Doc, visibleLayers: Set<string>, view: ViewState, w: number, h: number): Marker[] {
  const z = view.zoom;
  const tiny: Tiny[] = [];
  const sectors = Array.from({ length: 8 }, () => ({ n: 0, nearest: Infinity, items: [] as Bounds[], dists: [] as number[] }));

  for (const [id, s] of doc.strokes) {
    if (!visibleLayers.has(s.layerId)) continue;
    const b = doc.bounds.get(id);
    if (!b) continue;
    const sx0 = (b.x0 - view.x) * z, sx1 = (b.x1 - view.x) * z;
    const sy0 = (b.y0 - view.y) * z, sy1 = (b.y1 - view.y) * z;
    if (sx1 >= 0 && sx0 <= w && sy1 >= 0 && sy0 <= h) {
      if (Math.max(sx1 - sx0, sy1 - sy0) >= TINY) continue;
      tiny.push({ b, s: { x0: sx0, y0: sy0, x1: sx1, y1: sy1 } });
    } else {
      const mx = (sx0 + sx1) / 2 - w / 2, my = (sy0 + sy1) / 2 - h / 2;
      const sector = ((Math.round(Math.atan2(my, mx) / (Math.PI / 4)) % 8) + 8) % 8;
      const dist = Math.hypot(Math.max(0, sx0 - w, -sx1), Math.max(0, sy0 - h, -sy1));
      const sec = sectors[sector];
      sec.n++;
      sec.items.push(b);
      sec.dists.push(dist);
      if (dist < sec.nearest) sec.nearest = dist;
    }
  }

  const markers: Marker[] = [];
  // Decide what is visible once, at the finest grid: dense shapes there need no pin. Then only
  // coarsen what is left, so dust next to a drawing can never hide inside it.
  const hidden = groupTiny(tiny, CELL, true).flatMap((g) => g.members);
  let cell = CELL;
  for (;;) {
    const groups = groupTiny(hidden, cell, false);
    if (groups.length <= MAX_HERE || cell > Math.max(w, h)) {
      for (const [i, g] of groups.entries()) {
        markers.push({ key: `h${cell}-${i}-${g.n}`, kind: 'here', x: (g.s.x0 + g.s.x1) / 2, y: (g.s.y0 + g.s.y1) / 2, angle: 0, count: g.n, target: g.b });
      }
      break;
    }
    cell *= 2;
  }

  sectors.forEach((sec, i) => {
    if (!sec.n) return;
    // Fly to the nearest content that way, not to everything in that half of the world.
    const limit = sec.nearest * 2 + 120;
    let target: Bounds | null = null;
    for (let k = 0; k < sec.items.length; k++) if (sec.dists[k] <= limit) target = target ? union(target, sec.items[k]) : sec.items[k];
    const t = target!;
    const tx = ((t.x0 + t.x1) / 2 - view.x) * z - w / 2;
    const ty = ((t.y0 + t.y1) / 2 - view.y) * z - h / 2;
    const angle = Math.atan2(ty, tx);
    const c = Math.cos(angle), s = Math.sin(angle);
    const reach = Math.min((w / 2 - EDGE_INSET) / Math.max(Math.abs(c), 1e-9), (h / 2 - EDGE_INSET) / Math.max(Math.abs(s), 1e-9));
    let x = w / 2 + c * reach, y = h / 2 + s * reach;
    if (x > w - CONTROLS_W && y > h - CONTROLS_H) {
      // Slide out of the button corner, along whichever edge the arrow sits on.
      if (y >= h - EDGE_INSET - 1) x = w - CONTROLS_W - 16;
      else y = h - CONTROLS_H - 16;
    }
    markers.push({ key: `e${i}`, kind: 'edge', x, y, angle, count: sec.n, target: t });
  });
  return markers;
}

/** Groups tiny strokes on a grid of `cell` px and merges close neighbors. With `dropVisible`,
 *  groups that read as a shape on screen (big and dense) are left out. */
function groupTiny(tiny: Tiny[], cell: number, dropVisible: boolean): Group[] {
  const cells = new Map<string, Group>();
  for (const t of tiny) {
    const key = `${Math.floor((t.s.x0 + t.s.x1) / 2 / cell)},${Math.floor((t.s.y0 + t.s.y1) / 2 / cell)}`;
    // True screen area: sub-pixel strokes add almost nothing, so dust never reads as a shape.
    const area = (t.s.x1 - t.s.x0) * (t.s.y1 - t.s.y0);
    const g = cells.get(key);
    if (g) {
      g.b = union(g.b, t.b);
      g.s = union(g.s, t.s);
      g.n++;
      g.ink += area;
      g.members.push(t);
    } else cells.set(key, { b: t.b, s: t.s, n: 1, ink: area, members: [t], parent: null });
  }
  // Merge neighbor cells whose content is close on screen, so a cluster on a cell border is
  // one pin. The size cap stops merges from chaining across the whole view.
  for (const [key, g] of cells) {
    const [cx, cy] = key.split(',').map(Number);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const o = cells.get(`${cx + dx},${cy + dy}`);
        if (!o) continue;
        const ra = root(g), rb = root(o);
        if (ra === rb || gap(ra.s, rb.s) >= LINK) continue;
        const s = union(ra.s, rb.s);
        if (Math.max(s.x1 - s.x0, s.y1 - s.y0) > cell * 2) continue;
        rb.parent = ra;
        ra.b = union(ra.b, rb.b);
        ra.s = s;
        ra.n += rb.n;
        ra.ink += rb.ink;
        for (const m of rb.members) ra.members.push(m);
      }
    }
  }
  const out: Group[] = [];
  for (const g of cells.values()) {
    if (g.parent) continue;
    const gw = g.s.x1 - g.s.x0, gh = g.s.y1 - g.s.y0;
    const coverage = g.ink / Math.max(1, gw * gh);
    // Big and dense: the strokes read as a shape on screen. Scattered dust always keeps a pin.
    if (dropVisible && Math.max(gw, gh) >= VISIBLE_GROUP && coverage >= VISIBLE_COVERAGE) continue;
    out.push(g);
  }
  return out;
}

export function unionAll(doc: Doc, visibleLayers: Set<string>): Bounds | null {
  let all: Bounds | null = null;
  for (const [id, s] of doc.strokes) {
    if (!visibleLayers.has(s.layerId)) continue;
    const b = doc.bounds.get(id);
    if (b) all = all ? union(all, b) : b;
  }
  return all;
}
