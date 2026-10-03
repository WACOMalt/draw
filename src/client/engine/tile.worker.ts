/// <reference lib="webworker" />
// Rasterizes committed strokes into 256×256 layer tiles. Holds vector data only, no tile pixels.

import { computeDabs, DAB_CHUNK, type DabList } from '../../shared/brush';
import type { Stroke } from '../../shared/types';
import { DabPainter, StampCache } from './stamp';
import { TILE, tileKey, tileWorld, type FromWorker, type TileView, type ToWorker } from './tiles';

interface Rec {
  stroke: Stroke;
  /** World bbox from the points, grown by the max radius. Cheap, so culling never needs dabs. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  dabs: DabList | null;
}

interface TileRef {
  layer: string;
  lod: number;
  tx: number;
  ty: number;
}

const post = (msg: FromWorker, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

const recs = new Map<string, Rec>();
const byLayer = new Map<string, Rec[]>(); // sorted by seq
/** Tiles the main thread holds. */
const delivered = new Map<string, TileRef>();
/** Delivered tiles whose content is out of date. */
const stale = new Set<string>();

let view: TileView | null = null;
let order: [number, number][] = []; // view tiles, center first
let appliedSeq = 0;
let postedSeq = 0;
let scheduled = false;

const stamps = new StampCache(64);
const tileCanvas = new OffscreenCanvas(TILE, TILE);
const tileCtx = tileCanvas.getContext('2d')!;
const strokeCanvas = new OffscreenCanvas(TILE, TILE);
const strokeCtx = strokeCanvas.getContext('2d')!;

function makeRec(stroke: Stroke): Rec {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const p = stroke.pts;
  for (let i = 0; i < p.length; i += 3) {
    if (p[i] < x0) x0 = p[i];
    if (p[i] > x1) x1 = p[i];
    if (p[i + 1] < y0) y0 = p[i + 1];
    if (p[i + 1] > y1) y1 = p[i + 1];
  }
  const r = stroke.brush.size * 0.51; // max radius plus a margin, relative so it works at any zoom
  return { stroke, x0: x0 - r, y0: y0 - r, x1: x1 + r, y1: y1 + r, dabs: null };
}

function insertRec(rec: Rec): void {
  recs.set(rec.stroke.id, rec);
  let list = byLayer.get(rec.stroke.layerId);
  if (!list) byLayer.set(rec.stroke.layerId, (list = []));
  // Usually an append. Restored strokes go back to their original z position.
  let i = list.length;
  while (i > 0 && list[i - 1].stroke.seq > rec.stroke.seq) i--;
  list.splice(i, 0, rec);
}

function removeRec(id: string): Rec | null {
  const rec = recs.get(id);
  if (!rec) return null;
  recs.delete(id);
  const list = byLayer.get(rec.stroke.layerId);
  if (list) {
    const i = list.indexOf(rec);
    if (i >= 0) list.splice(i, 1);
  }
  return rec;
}

function tileBounds(lod: number, tx: number, ty: number): [number, number, number, number] {
  const tw = tileWorld(lod);
  return [tx * tw, ty * tw, (tx + 1) * tw, (ty + 1) * tw];
}

function invalidate(rec: Rec): void {
  for (const [key, t] of delivered) {
    if (t.layer !== rec.stroke.layerId) continue;
    const [x0, y0, x1, y1] = tileBounds(t.lod, t.tx, t.ty);
    if (rec.x1 > x0 && rec.x0 < x1 && rec.y1 > y0 && rec.y0 < y1) stale.add(key);
  }
}

function drawStroke(ctx: OffscreenCanvasRenderingContext2D, rec: Rec, wx0: number, wy0: number, wx1: number, wy1: number, scale: number): void {
  const painter = new DabPainter(ctx, stamps, rec.stroke.brush, wx0, wy0, scale);
  const w = (rec.x1 - rec.x0) * scale;
  const h = (rec.y1 - rec.y0) * scale;
  if (w < 2 && h < 2) {
    // The whole stroke covers about one pixel at this zoom: one dot instead of every dab.
    // This keeps far zoomed-out views fast with any number of strokes.
    painter.dab((rec.x0 + rec.x1) / 2, (rec.y0 + rec.y1) / 2, Math.max(rec.x1 - rec.x0, rec.y1 - rec.y0) / 2, 1);
    return;
  }
  const dl = (rec.dabs ??= computeDabs(rec.stroke.brush, rec.stroke.pts));
  const { dabs, chunks, count } = dl;
  for (let c = 0; c * DAB_CHUNK < count; c++) {
    const co = c * 4;
    if (chunks[co + 2] <= wx0 || chunks[co] >= wx1 || chunks[co + 3] <= wy0 || chunks[co + 1] >= wy1) continue;
    const end = Math.min(count, (c + 1) * DAB_CHUNK);
    for (let i = c * DAB_CHUNK; i < end; i++) {
      const o = i * 4;
      const x = dabs[o], y = dabs[o + 1], r = dabs[o + 2];
      if (x + r <= wx0 || x - r >= wx1 || y + r <= wy0 || y - r >= wy1) continue;
      painter.dab(x, y, r, dabs[o + 3]);
    }
  }
}

function renderTile(t: TileRef): ImageBitmap | null {
  const list = byLayer.get(t.layer);
  if (!list || list.length === 0) return null;
  const [wx0, wy0, wx1, wy1] = tileBounds(t.lod, t.tx, t.ty);
  const scale = TILE / (wx1 - wx0);
  let any = false;
  tileCtx.globalCompositeOperation = 'source-over';
  tileCtx.globalAlpha = 1;
  tileCtx.clearRect(0, 0, TILE, TILE);
  for (const rec of list) {
    if (rec.x1 <= wx0 || rec.x0 >= wx1 || rec.y1 <= wy0 || rec.y0 >= wy1) continue;
    any = true;
    const b = rec.stroke.brush;
    const mode = b.tool === 'erase' ? 'destination-out' : 'source-over';
    if (b.opacity >= 1) {
      // Source-over and destination-out are associative: at full opacity the dabs can go
      // straight onto the tile with the same result as a separate stroke buffer.
      tileCtx.globalCompositeOperation = mode;
      drawStroke(tileCtx, rec, wx0, wy0, wx1, wy1, scale);
    } else {
      strokeCtx.globalCompositeOperation = 'source-over';
      strokeCtx.globalAlpha = 1;
      strokeCtx.clearRect(0, 0, TILE, TILE);
      drawStroke(strokeCtx, rec, wx0, wy0, wx1, wy1, scale);
      tileCtx.globalCompositeOperation = mode;
      tileCtx.globalAlpha = b.opacity;
      tileCtx.drawImage(strokeCanvas, 0, 0);
    }
    tileCtx.globalAlpha = 1;
  }
  if (!any) return null;
  return tileCanvas.transferToImageBitmap();
}

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  setTimeout(loop, 0);
}

function loop(): void {
  scheduled = false;
  const start = performance.now();
  if (view) {
    for (const layer of view.layers) {
      for (const [tx, ty] of order) {
        const key = tileKey(layer, view.lod, tx, ty);
        if (delivered.has(key) && !stale.has(key)) continue;
        const ref: TileRef = { layer, lod: view.lod, tx, ty };
        const bmp = renderTile(ref);
        delivered.set(key, ref);
        stale.delete(key);
        post({ t: 'tile', key, bmp }, bmp ? [bmp] : []);
        if (performance.now() - start > 10) return schedule();
      }
    }
  }
  if (appliedSeq !== postedSeq) {
    postedSeq = appliedSeq;
    post({ t: 'rendered', seq: appliedSeq });
  }
}

function setView(v: TileView): void {
  view = v;
  const cx = (v.tx0 + v.tx1) / 2;
  const cy = (v.ty0 + v.ty1) / 2;
  order = [];
  for (let ty = v.ty0; ty <= v.ty1; ty++) for (let tx = v.tx0; tx <= v.tx1; tx++) order.push([tx, ty]);
  order.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy));
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  switch (m.t) {
    case 'reset':
      recs.clear();
      byLayer.clear();
      for (const s of m.strokes) insertRec(makeRec(s));
      for (const key of delivered.keys()) stale.add(key);
      appliedSeq = m.seq;
      break;
    case 'add': {
      removeRec(m.stroke.id);
      const rec = makeRec(m.stroke);
      insertRec(rec);
      invalidate(rec);
      appliedSeq = m.seq;
      break;
    }
    case 'remove': {
      const rec = removeRec(m.id);
      if (rec) invalidate(rec);
      appliedSeq = m.seq;
      break;
    }
    case 'seq':
      appliedSeq = m.seq;
      break;
    case 'view':
      setView(m.view);
      break;
    case 'forget':
      for (const key of m.keys) {
        delivered.delete(key);
        stale.delete(key);
      }
      break;
  }
  schedule();
};
