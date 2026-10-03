// Main-thread compositor: draws layer tiles from the worker plus strokes in progress, with
// layer opacity and blend modes, onto the visible canvas.

import { DabWalker } from '../../shared/brush';
import type { BlendMode, Brush, Layer, Stroke } from '../../shared/types';
import type { Renderer, ViewState } from './renderer';
import { DabPainter, StampCache } from './stamp';
import TileWorker from './tile.worker?worker';
import {
  MAX_LOD,
  TILE,
  lodFor,
  tileKey,
  tileWorld,
  type FromWorker,
  type TileView,
  type ToWorker,
} from './tiles';

const BLEND_OP: Record<BlendMode, GlobalCompositeOperation> = {
  normal: 'source-over',
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  darken: 'darken',
  lighten: 'lighten',
  'color-dodge': 'color-dodge',
  'color-burn': 'color-burn',
  'hard-light': 'hard-light',
  'soft-light': 'soft-light',
  difference: 'difference',
  exclusion: 'exclusion',
  hue: 'hue',
  saturation: 'saturation',
  color: 'color',
  luminosity: 'luminosity',
  add: 'lighter',
};

const MAX_BITMAPS = 700;
const KEEP_BITMAPS = 500;
const MAX_ENTRIES = 8000;
const PREFETCH = 1;
/**
 * WebKit (the Linux desktop app, Safari) can show a canvas frame only at the next compositor
 * update. After the view settles, a few identical frames push the last real one to the screen.
 */
const TAIL_FRAMES = /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Edg\//.test(navigator.userAgent) ? 2 : 0;

interface TileEntry {
  bmp: ImageBitmap | null;
  used: number;
  layer: string;
  lod: number;
  tx: number;
  ty: number;
}

interface Live {
  id: string;
  layerId: string;
  brush: Brush;
  pts: number[];
  canvas: OffscreenCanvas;
  ctx: OffscreenCanvasRenderingContext2D;
  walker: DabWalker;
  painter: DabPainter;
  viewVersion: number;
  commitSeq: number | null;
  remote: boolean;
  ended: boolean;
  updated: number;
  started: number;
}

export class Canvas2DRenderer implements Renderer {
  readonly kind = 'canvas2d';
  readonly precision = 8;
  readonly view: ViewState = { x: 0, y: 0, zoom: 1 };
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private cssW = 1;
  private cssH = 1;
  private worker: Worker;
  private tiles = new Map<string, TileEntry>();
  private bitmapCount = 0;
  private layers: Layer[] = [];
  private live = new Map<string, Live>();
  private pool: OffscreenCanvas[] = [];
  private scratch: OffscreenCanvas;
  private scratchCtx: OffscreenCanvasRenderingContext2D;
  private stamps = new StampCache(32);
  private frame = 0;
  private viewVersion = 0;
  private raf = 0;
  private dirty = false;
  private tail = 0;
  private lastViewMsg = '';
  private current: TileView | null = null;
  paper = '#ffffff';
  onFrame: (() => void) | null = null;

  constructor(private canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) {
    this.ctx = ctx;
    this.scratch = new OffscreenCanvas(1, 1);
    this.scratchCtx = this.scratch.getContext('2d')!;
    this.worker = new TileWorker();
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.onWorker(e.data);
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.worker.terminate();
    for (const t of this.tiles.values()) t.bmp?.close();
    this.tiles.clear();
  }

  private toWorker(msg: ToWorker): void {
    this.worker.postMessage(msg);
  }

  // --- geometry -------------------------------------------------------------------------

  resize(cssW: number, cssH: number, dpr: number): void {
    this.cssW = Math.max(1, cssW);
    this.cssH = Math.max(1, cssH);
    this.dpr = dpr;
    this.canvas.width = Math.round(this.cssW * dpr);
    this.canvas.height = Math.round(this.cssH * dpr);
    this.scratch.width = this.canvas.width;
    this.scratch.height = this.canvas.height;
    this.pool = [];
    for (const l of this.live.values()) {
      l.canvas.width = this.canvas.width;
      l.canvas.height = this.canvas.height;
    }
    this.viewChanged();
  }

  get size(): { w: number; h: number } {
    return { w: this.cssW, h: this.cssH };
  }

  setView(x: number, y: number, zoom: number): void {
    this.view.x = x;
    this.view.y = y;
    this.view.zoom = zoom;
    this.viewChanged();
  }

  private viewChanged(): void {
    this.viewVersion++;
    this.invalidate();
  }

  toWorld(cssX: number, cssY: number): [number, number] {
    return [this.view.x + cssX / this.view.zoom, this.view.y + cssY / this.view.zoom];
  }

  toScreen(wx: number, wy: number): [number, number] {
    return [(wx - this.view.x) * this.view.zoom, (wy - this.view.y) * this.view.zoom];
  }

  // --- document -------------------------------------------------------------------------

  setLayers(layers: Layer[]): void {
    this.layers = layers;
    this.invalidate();
  }

  resetStrokes(strokes: Stroke[], seq: number): void {
    this.toWorker({ t: 'reset', strokes, seq });
  }

  addStroke(stroke: Stroke, seq: number): void {
    this.toWorker({ t: 'add', stroke, seq });
  }

  removeStroke(id: string, seq: number): void {
    this.toWorker({ t: 'remove', id, seq });
  }

  advanceSeq(seq: number): void {
    this.toWorker({ t: 'seq', seq });
  }

  // --- strokes in progress -------------------------------------------------------------

  private makePainter(ctx: OffscreenCanvasRenderingContext2D, brush: Brush): DabPainter {
    const ds = this.view.zoom * this.dpr;
    return new DabPainter(ctx, this.stamps, brush, this.view.x, this.view.y, ds);
  }

  liveBegin(id: string, layerId: string, brush: Brush, remote: boolean): void {
    if (this.live.has(id)) return;
    const canvas = this.pool.pop() ?? new OffscreenCanvas(this.canvas.width, this.canvas.height);
    const ctx = canvas.getContext('2d')!;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const now = performance.now();
    this.live.set(id, {
      id,
      layerId,
      brush,
      pts: [],
      canvas,
      ctx,
      walker: new DabWalker(brush),
      painter: this.makePainter(ctx, brush),
      viewVersion: this.viewVersion,
      commitSeq: null,
      remote,
      ended: false,
      updated: now,
      started: now,
    });
  }

  hasLive(id: string): boolean {
    return this.live.has(id);
  }

  liveAppend(id: string, pts: number[]): void {
    const l = this.live.get(id);
    if (!l) return;
    for (let i = 0; i < pts.length; i++) l.pts.push(pts[i]);
    l.updated = performance.now();
    if (l.viewVersion !== this.viewVersion) {
      this.redrawLive(l);
    } else {
      const sink = (x: number, y: number, r: number, a: number) => l.painter.dab(x, y, r, a);
      for (let i = 0; i + 2 < pts.length; i += 3) l.walker.push(pts[i], pts[i + 1], pts[i + 2], sink);
    }
    this.invalidate();
  }

  private redrawLive(l: Live): void {
    l.ctx.globalAlpha = 1;
    l.ctx.clearRect(0, 0, l.canvas.width, l.canvas.height);
    l.walker = new DabWalker(l.brush);
    l.painter = this.makePainter(l.ctx, l.brush);
    l.viewVersion = this.viewVersion;
    const sink = (x: number, y: number, r: number, a: number) => l.painter.dab(x, y, r, a);
    const p = l.pts;
    for (let i = 0; i + 2 < p.length; i += 3) l.walker.push(p[i], p[i + 1], p[i + 2], sink);
  }

  /** The stroke is in the document at this seq. Its buffer stays until the worker shows it. */
  liveCommit(id: string, seq: number): void {
    const l = this.live.get(id);
    if (l) {
      l.commitSeq = seq;
      l.ended = true;
    }
  }

  liveEnd(id: string): void {
    const l = this.live.get(id);
    if (l) {
      l.ended = true;
      l.updated = performance.now();
    }
  }

  liveCancel(id: string): void {
    const l = this.live.get(id);
    if (!l) return;
    this.live.delete(id);
    if (l.canvas.width === this.canvas.width && l.canvas.height === this.canvas.height) this.pool.push(l.canvas);
    this.invalidate();
  }

  /** Drops remote strokes that stopped without a commit (peer left, op rejected). */
  sweepLive(): void {
    const now = performance.now();
    for (const l of this.live.values()) {
      if (l.commitSeq !== null || !l.remote) continue;
      if ((l.ended && now - l.updated > 3000) || now - l.updated > 15000) this.liveCancel(l.id);
    }
  }

  // --- worker -----------------------------------------------------------------------------

  private onWorker(m: FromWorker): void {
    if (m.t === 'tile') {
      const old = this.tiles.get(m.key);
      if (old?.bmp) {
        old.bmp.close();
        this.bitmapCount--;
      }
      const [layer, lod, tx, ty] = m.key.split('|');
      this.tiles.set(m.key, { bmp: m.bmp, used: this.frame, layer, lod: +lod, tx: +tx, ty: +ty });
      if (m.bmp) this.bitmapCount++;
      this.invalidate();
      this.evict();
    } else if (m.t === 'rendered') {
      for (const l of this.live.values()) if (l.commitSeq !== null && l.commitSeq <= m.seq) this.liveCancel(l.id);
    }
  }

  private evict(): void {
    if (this.bitmapCount <= MAX_BITMAPS && this.tiles.size <= MAX_ENTRIES) return;
    const v = this.current;
    const candidates: [string, TileEntry][] = [];
    for (const kv of this.tiles) {
      const t = kv[1];
      const inView = v && t.lod === v.lod && t.tx >= v.tx0 && t.tx <= v.tx1 && t.ty >= v.ty0 && t.ty <= v.ty1;
      if (!inView) candidates.push(kv);
    }
    candidates.sort((a, b) => a[1].used - b[1].used);
    const forget: string[] = [];
    for (const [key, t] of candidates) {
      if (this.bitmapCount <= KEEP_BITMAPS && this.tiles.size <= MAX_ENTRIES * 0.8) break;
      if (t.bmp) {
        t.bmp.close();
        this.bitmapCount--;
      }
      this.tiles.delete(key);
      forget.push(key);
    }
    if (forget.length) this.toWorker({ t: 'forget', keys: forget });
  }

  // --- drawing ----------------------------------------------------------------------------

  invalidate(): void {
    this.dirty = true;
    if (!this.raf) this.raf = requestAnimationFrame(() => this.render());
  }

  private render(): void {
    this.raf = 0;
    if (this.dirty) {
      this.dirty = false;
      this.tail = TAIL_FRAMES;
    } else this.tail--;
    this.frame++;
    const ctx = this.ctx;
    const ds = this.view.zoom * this.dpr;
    const lod = lodFor(ds);
    const tw = tileWorld(lod);
    const vx = this.view.x;
    const vy = this.view.y;
    const wx1 = vx + this.cssW / this.view.zoom;
    const wy1 = vy + this.cssH / this.view.zoom;
    const tx0 = Math.floor(vx / tw), ty0 = Math.floor(vy / tw);
    const tx1 = Math.floor(wx1 / tw), ty1 = Math.floor(wy1 / tw);

    const visible = this.layers.filter((l) => l.visible && !l.deleted);
    this.current = {
      lod,
      tx0: tx0 - PREFETCH,
      ty0: ty0 - PREFETCH,
      tx1: tx1 + PREFETCH,
      ty1: ty1 + PREFETCH,
      // Topmost layers first: they are the most likely to be covering what is below.
      layers: visible.map((l) => l.id).reverse(),
    };
    const msg = JSON.stringify(this.current);
    if (msg !== this.lastViewMsg) {
      this.lastViewMsg = msg;
      this.toWorker({ t: 'view', view: this.current });
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = this.paper;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    const X = (tx: number) => Math.round((tx * tw - vx) * ds);
    const Y = (ty: number) => Math.round((ty * tw - vy) * ds);

    for (const layer of visible) {
      const lives = [...this.live.values()]
        .filter((l) => l.layerId === layer.id)
        .sort((a, b) => (a.commitSeq ?? Infinity) - (b.commitSeq ?? Infinity) || a.started - b.started);
      let target: Ctx = ctx;
      if (lives.length) {
        target = this.scratchCtx;
        target.globalCompositeOperation = 'source-over';
        target.globalAlpha = 1;
        target.clearRect(0, 0, this.scratch.width, this.scratch.height);
      } else {
        ctx.globalAlpha = layer.opacity;
        ctx.globalCompositeOperation = BLEND_OP[layer.blend] ?? 'source-over';
      }
      for (let ty = ty0; ty <= ty1; ty++) {
        const y0 = Y(ty), y1 = Y(ty + 1);
        for (let tx = tx0; tx <= tx1; tx++) {
          const x0 = X(tx), x1 = X(tx + 1);
          this.drawTile(target, layer.id, lod, tx, ty, x0, y0, x1 - x0, y1 - y0);
        }
      }
      if (lives.length) {
        const s = this.scratchCtx;
        for (const l of lives) {
          if (l.viewVersion !== this.viewVersion) this.redrawLive(l);
          s.globalAlpha = l.brush.opacity;
          s.globalCompositeOperation = l.brush.tool === 'erase' ? 'destination-out' : 'source-over';
          s.drawImage(l.canvas, 0, 0);
        }
        ctx.globalAlpha = layer.opacity;
        ctx.globalCompositeOperation = BLEND_OP[layer.blend] ?? 'source-over';
        ctx.drawImage(this.scratch, 0, 0);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    this.onFrame?.();
    if (this.tail > 0 && !this.raf) this.raf = requestAnimationFrame(() => this.render());
  }

  private drawTile(c: Ctx, layer: string, lod: number, tx: number, ty: number, dx: number, dy: number, dw: number, dh: number): void {
    const own = this.tiles.get(tileKey(layer, lod, tx, ty));
    if (own) {
      own.used = this.frame;
      if (own.bmp) c.drawImage(own.bmp, dx, dy, dw, dh);
      return;
    }
    // Missing: stretch a coarser parent tile while the worker renders this one.
    for (let up = 1; up <= 3 && lod + up <= MAX_LOD; up++) {
      const f = 2 ** up;
      const ptx = Math.floor(tx / f), pty = Math.floor(ty / f);
      const parent = this.tiles.get(tileKey(layer, lod + up, ptx, pty));
      if (!parent) continue;
      parent.used = this.frame;
      if (parent.bmp) {
        const sub = TILE / f;
        c.drawImage(parent.bmp, (tx - ptx * f) * sub, (ty - pty * f) * sub, sub, sub, dx, dy, dw, dh);
      }
      return;
    }
    // Or the four finer children (after a zoom out).
    const hw = dw / 2, hh = dh / 2;
    for (let j = 0; j < 2; j++) {
      for (let i = 0; i < 2; i++) {
        const child = this.tiles.get(tileKey(layer, lod - 1, tx * 2 + i, ty * 2 + j));
        if (!child) continue;
        child.used = this.frame;
        if (child.bmp) c.drawImage(child.bmp, dx + i * hw, dy + j * hh, hw, hh);
      }
    }
  }

  // --- readback ---------------------------------------------------------------------------

  /** Composited color under a CSS-pixel position, as #rrggbb. */
  sample(cssX: number, cssY: number): string {
    const x = Math.max(0, Math.min(this.canvas.width - 1, Math.round(cssX * this.dpr)));
    const y = Math.max(0, Math.min(this.canvas.height - 1, Math.round(cssY * this.dpr)));
    const [r, g, b] = this.ctx.getImageData(x, y, 1, 1).data;
    return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
  }

  exportPng(): Promise<Blob | null> {
    return new Promise((resolve) => this.canvas.toBlob(resolve, 'image/png'));
  }
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
