// Main-thread compositor: draws layer tiles from the worker plus strokes in progress, with
// layer opacity and blend modes, onto the visible canvas.

import { DabWalker, strokeSeed } from '../../shared/brush';
import type { Affine, BlendMode, Brush, Layer, LayerBlend, Shape, Stroke } from '../../shared/types';
import { byZ } from '../../shared/shapes';
import { ShapeIndex, shapeRec } from './shapeIndex';
import { drawShapes } from './shapeRaster';
import { compose, effectivelyVisible, layerTree, type LayerNode } from '../../shared/layers';
import { LUT_SIZE, hueSat, toneLut } from './adjust';
import type { Renderer, ViewState } from './renderer';
import { perfProfile } from './perf';
import { DabPainter, StampCache } from './stamp';
import { maskKey } from './strokeIndex';
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

/** The composite operation of a blend mode (pass through draws like normal once isolated). */
const op = (b: LayerBlend): GlobalCompositeOperation => BLEND_OP[b === 'pass' ? 'normal' : b] ?? 'source-over';

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

/** A shape layer being edited, drawn on the main thread (see Hot in gl/glRenderer.ts). */
interface Hot {
  canvas: OffscreenCanvas;
  rect: [number, number] | null;
  version: number;
  viewVersion: number;
  /** The drafts ended: stay until the worker reports this seq rendered (or 3 s pass). */
  settleSeq: number | null;
  settleAt: number;
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
  readonly profile = perfProfile(null);
  onSlow: (() => void) | null = null;
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
  private tree: LayerNode[] = [];
  private byId = new Map<string, Layer>();
  /** A layer or group drawn moved by a transform not applied yet (see the WebGL2 renderer). */
  private preview: { id: string; m: Affine; settle: boolean; settleAt: number; snap: OffscreenCanvas | null; capture: { x: number; y: number; ds: number } | null } | null = null;
  private live = new Map<string, Live>();
  /** Committed shapes, kept here too: edited shape layers draw on the main thread. */
  private shapes = new ShapeIndex();
  private shapeLayers = '';
  private drafts = new Map<string, Map<string, Shape>>();
  private draftVersion = 0;
  private hot = new Map<string, Hot>();
  /** Highest seq sent with a shape change, and the highest the worker reported rendered. */
  private shapeSeq = 0;
  private renderedSeq = 0;
  private pool: OffscreenCanvas[] = [];
  private scratch: OffscreenCanvas;
  private scratchCtx: OffscreenCanvasRenderingContext2D;
  private buffers = new Map<string, { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D }>();
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
    this.tree = layerTree(layers);
    this.byId = new Map(layers.map((l) => [l.id, l]));
    const ids = layers.filter((l) => l.kind === 'shape').map((l) => l.id);
    if (ids.join() !== this.shapeLayers) {
      this.shapeLayers = ids.join();
      this.toWorker({ t: 'shapeLayers', ids });
    }
    this.invalidate();
  }

  // --- shapes -----------------------------------------------------------------------------

  resetShapes(shapes: Shape[]): void {
    this.shapes.clear();
    for (const s of shapes) this.shapes.put(s);
    this.toWorker({ t: 'shapes', shapes });
    this.draftVersion++;
    this.invalidate();
  }

  putShape(shape: Shape, seq: number): void {
    this.shapes.put(shape);
    this.shapeSeq = Math.max(this.shapeSeq, seq);
    this.toWorker({ t: 'shape', shape, seq });
    this.draftVersion++;
    this.invalidate();
  }

  removeShape(id: string, seq: number): void {
    this.shapes.remove(id);
    this.shapeSeq = Math.max(this.shapeSeq, seq);
    this.toWorker({ t: 'shape.remove', id, seq });
    this.draftVersion++;
    this.invalidate();
  }

  setShapeDrafts(owner: string, shapes: Shape[]): void {
    if (shapes.length) this.drafts.set(owner, new Map(shapes.map((s) => [s.id, s])));
    else if (!this.drafts.delete(owner)) return;
    this.draftVersion++;
    this.invalidate();
  }

  /** Redraws the screen buffers of edited shape layers; drops the ones that settled. */
  private updateHot(): void {
    const want = new Set<string>();
    const over = new Map<string, Shape>();
    for (const d of this.drafts.values()) {
      for (const s of d.values()) {
        over.set(s.id, s);
        want.add(s.layerId);
        const old = this.shapes.recs.get(s.id);
        if (old) want.add(old.shape.layerId);
      }
    }
    const now = performance.now();
    for (const [id, h] of this.hot) {
      if (want.has(id)) {
        h.settleSeq = null;
        continue;
      }
      if (h.settleSeq === null) {
        h.settleSeq = this.shapeSeq;
        h.settleAt = now;
      }
      if (this.renderedSeq >= h.settleSeq || now - h.settleAt > 3000) this.hot.delete(id);
      else this.invalidate(); // check again next frame
    }
    for (const id of want) {
      if (!this.hot.has(id)) this.hot.set(id, { canvas: new OffscreenCanvas(1, 1), rect: null, version: -1, viewVersion: -1, settleSeq: null, settleAt: 0 });
    }
    const W = this.canvas.width, H = this.canvas.height;
    const ds = this.view.zoom * this.dpr;
    for (const [id, h] of this.hot) {
      if (h.version === this.draftVersion && h.viewVersion === this.viewVersion) continue;
      h.version = this.draftVersion;
      h.viewVersion = this.viewVersion;
      const list: Shape[] = [];
      for (const r of this.shapes.layer(id)) if (!over.has(r.shape.id)) list.push(r.shape);
      for (const s of over.values()) if (s.layerId === id && !s.deleted) list.push(s);
      list.sort(byZ);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const s of list) {
        const r = shapeRec(s);
        x0 = Math.min(x0, (r.x0 - this.view.x) * ds);
        y0 = Math.min(y0, (r.y0 - this.view.y) * ds);
        x1 = Math.max(x1, (r.x1 - this.view.x) * ds);
        y1 = Math.max(y1, (r.y1 - this.view.y) * ds);
      }
      const rx0 = Math.max(0, Math.floor(x0) - 1), ry0 = Math.max(0, Math.floor(y0) - 1);
      const rx1 = Math.min(W, Math.ceil(x1) + 1), ry1 = Math.min(H, Math.ceil(y1) + 1);
      if (!(rx1 > rx0 && ry1 > ry0)) {
        h.rect = null;
        continue;
      }
      const w = rx1 - rx0, hh = ry1 - ry0;
      h.canvas.width = w;
      h.canvas.height = hh;
      drawShapes(h.canvas.getContext('2d')!, list, this.view.x + rx0 / ds, this.view.y + ry0 / ds, ds, w, hh);
      h.rect = [rx0, ry0];
    }
  }

  setTransformPreview(p: { id: string; m: Affine } | null): void {
    const old = this.preview;
    if (p && old && old.id === p.id && !old.settle) old.m = p.m;
    else this.preview = p ? { id: p.id, m: p.m, settle: false, settleAt: 0, snap: null, capture: null } : null;
    this.invalidate();
  }

  /** Tiles render in a worker here: the preview simply stays a moment after the transform. */
  settleTransformPreview(): void {
    if (!this.preview) return;
    this.preview.settle = true;
    this.preview.settleAt = performance.now();
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
      walker: new DabWalker(brush, strokeSeed(id)),
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
      const sink = (x: number, y: number, r: number, a: number, rot: number) => l.painter.dab(x, y, r, a, rot);
      for (let i = 0; i + 2 < pts.length; i += 3) l.walker.push(pts[i], pts[i + 1], pts[i + 2], sink);
    }
    this.invalidate();
  }

  private redrawLive(l: Live): void {
    l.ctx.globalAlpha = 1;
    l.ctx.clearRect(0, 0, l.canvas.width, l.canvas.height);
    l.walker = new DabWalker(l.brush, strokeSeed(l.id));
    l.painter = this.makePainter(l.ctx, l.brush);
    l.viewVersion = this.viewVersion;
    const sink = (x: number, y: number, r: number, a: number, rot: number) => l.painter.dab(x, y, r, a, rot);
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
      this.renderedSeq = m.seq;
      for (const l of this.live.values()) if (l.commitSeq !== null && l.commitSeq <= m.seq) this.liveCancel(l.id);
      if (this.hot.size) this.invalidate();
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

    const visible = this.layers.filter((l) => l.kind !== 'group' && effectivelyVisible(this.byId, l));
    this.current = {
      lod,
      tx0: tx0 - PREFETCH,
      ty0: ty0 - PREFETCH,
      tx1: tx1 + PREFETCH,
      ty1: ty1 + PREFETCH,
      // Topmost layers first: they are the most likely to be covering what is below. Each paint
      // layer, and each enabled layer mask.
      layers: visible
        .flatMap((l) => [...(l.kind !== 'adjust' ? [l.id] : []), ...(l.mask?.enabled ? [maskKey(l.id, l.mask.id)] : [])])
        .reverse(),
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

    const grid: Grid = { lod, tx0, ty0, tx1, ty1, X, Y };
    if (this.hot.size || this.drafts.size) this.updateHot();
    // Same order, groups and clipping groups as the WebGL2 renderer (gl/glRenderer.ts).
    this.drawNodes(ctx, this.tree, grid, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    const pv = this.preview;
    if (pv?.settle && performance.now() - pv.settleAt > 800) {
      this.preview = null;
      this.invalidate();
    }
    this.onFrame?.();
    if (this.tail > 0 && !this.raf) this.raf = requestAnimationFrame(() => this.render());
  }

  /** Sibling layers bottom to top onto `dst`, with clipping groups (see the WebGL2 renderer). */
  private drawNodes(dst: Ctx, nodes: LayerNode[], g: Grid, depth: number): void {
    const list = nodes.filter((n) => n.layer.visible);
    for (let i = 0; i < list.length; ) {
      const base = list[i];
      let j = i + 1;
      while (j < list.length && list[j].layer.clip) j++;
      const clipped = list.slice(i + 1, j);
      if (clipped.length === 0 || base.layer.kind === 'adjust') {
        for (const n of [base, ...clipped]) this.drawNode(dst, n, g, false, depth);
      } else {
        const b = this.clearBuffer(`clip${depth}`);
        b.ctx.drawImage(this.nodePixels(base, g, depth), 0, 0);
        // Clipped layers draw "atop" the base. Canvas 2D has no blend mode with atop: normal only.
        for (const c of clipped) this.drawNode(b.ctx, c, g, true, depth);
        this.put(dst, b.canvas, base.layer.opacity, op(base.layer.blend));
      }
      i = j;
    }
  }

  private drawNode(dst: Ctx, node: LayerNode, g: Grid, atop: boolean, depth: number): void {
    const l = node.layer;
    if (this.preview?.id === l.id) return this.drawPreview(dst, node, g, atop, depth);
    if (l.kind !== 'group') return this.drawLayerOnto(dst, l, g, atop);
    if (l.blend === 'pass' && !atop) {
      if (l.opacity >= 1) return this.drawNodes(dst, node.children, g, depth + 1);
      const save = this.clearBuffer(`pass${depth}`);
      save.ctx.drawImage(dst.canvas, 0, 0);
      this.drawNodes(dst, node.children, g, depth + 1);
      this.put(dst, save.canvas, 1 - l.opacity, 'source-over');
      return;
    }
    this.put(dst, this.renderGroup(node, g, depth), l.opacity, atop ? 'source-atop' : op(l.blend));
  }

  private renderGroup(node: LayerNode, g: Grid, depth: number): OffscreenCanvas {
    const b = this.clearBuffer(`iso${depth}`);
    this.drawNodes(b.ctx, node.children, g, depth + 1);
    return b.canvas;
  }

  private nodePixels(node: LayerNode, g: Grid, depth: number): OffscreenCanvas {
    if (node.layer.kind === 'group') return this.renderGroup(node, g, depth);
    this.renderLayer(node.layer, g);
    return this.scratch;
  }

  private drawPreview(dst: Ctx, node: LayerNode, g: Grid, atop: boolean, depth: number): void {
    const pv = this.preview!;
    if (!pv.snap || pv.snap.width !== this.canvas.width || pv.snap.height !== this.canvas.height) {
      if (pv.settle) {
        this.preview = null;
        return this.drawNode(dst, node, g, atop, depth);
      }
      const src = this.nodePixels(node, g, depth);
      pv.snap = new OffscreenCanvas(src.width, src.height);
      pv.snap.getContext('2d')!.drawImage(src, 0, 0);
      pv.capture = { x: this.view.x, y: this.view.y, ds: this.view.zoom * this.dpr };
    }
    const c = pv.capture!;
    const ds = this.view.zoom * this.dpr;
    const S = compose([ds, 0, 0, ds, -this.view.x * ds, -this.view.y * ds], compose(pv.m, [1 / c.ds, 0, 0, 1 / c.ds, c.x, c.y]));
    const t = this.clearBuffer(`xform${depth}`);
    t.ctx.setTransform(S[0], S[1], S[2], S[3], S[4], S[5]);
    t.ctx.drawImage(pv.snap, 0, 0);
    t.ctx.setTransform(1, 0, 0, 1, 0, 0);
    const l = node.layer;
    this.put(dst, t.canvas, l.kind === 'adjust' ? 1 : l.opacity, atop ? 'source-atop' : op(l.blend));
  }

  /** Draws a screen-sized canvas onto `dst` with an opacity and a composite operation. */
  private put(dst: Ctx, src: OffscreenCanvas, alpha: number, gco: GlobalCompositeOperation): void {
    dst.globalAlpha = alpha;
    dst.globalCompositeOperation = gco;
    dst.drawImage(src, 0, 0);
    dst.globalAlpha = 1;
    dst.globalCompositeOperation = 'source-over';
  }

  private clearBuffer(name: string): { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } {
    const b = this.buffer(name);
    b.ctx.setTransform(1, 0, 0, 1, 0, 0);
    b.ctx.globalCompositeOperation = 'source-over';
    b.ctx.globalAlpha = 1;
    b.ctx.clearRect(0, 0, b.canvas.width, b.canvas.height);
    return b;
  }

  /** A screen-sized offscreen canvas that only some frames need. */
  private buffer(name: string): { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } {
    let b = this.buffers.get(name);
    const w = this.canvas.width, h = this.canvas.height;
    if (!b) {
      const canvas = new OffscreenCanvas(w, h);
      b = { canvas, ctx: canvas.getContext('2d', { willReadFrequently: name === 'mask' })! };
      this.buffers.set(name, b);
    } else if (b.canvas.width !== w || b.canvas.height !== h) {
      b.canvas.width = w;
      b.canvas.height = h;
    }
    return b;
  }

  private livesFor(key: string): Live[] {
    return [...this.live.values()]
      .filter((l) => l.layerId === key)
      .sort((a, b) => (a.commitSeq ?? Infinity) - (b.commitSeq ?? Infinity) || a.started - b.started);
  }

  private drawTiles(target: Ctx, key: string, g: Grid): void {
    const hot = this.hot.get(key);
    if (hot) {
      // A shape layer being edited: its screen buffer instead of the tiles.
      if (hot.rect) target.drawImage(hot.canvas, hot.rect[0], hot.rect[1]);
      return;
    }
    for (let ty = g.ty0; ty <= g.ty1; ty++) {
      const y0 = g.Y(ty), y1 = g.Y(ty + 1);
      for (let tx = g.tx0; tx <= g.tx1; tx++) {
        const x0 = g.X(tx), x1 = g.X(tx + 1);
        this.drawTile(target, key, g.lod, tx, ty, x0, y0, x1 - x0, y1 - y0);
      }
    }
  }

  private drawLives(target: Ctx, key: string): void {
    for (const l of this.livesFor(key)) {
      if (l.viewVersion !== this.viewVersion) this.redrawLive(l);
      target.globalAlpha = l.brush.opacity;
      target.globalCompositeOperation = l.brush.tool === 'erase' ? 'destination-out' : 'source-over';
      target.drawImage(l.canvas, 0, 0);
    }
    target.globalAlpha = 1;
    target.globalCompositeOperation = 'source-over';
  }

  /** Draws one layer onto `dst` (the visible canvas or the group buffer). */
  private drawLayerOnto(dst: Ctx, layer: Layer, g: Grid, atop: boolean): void {
    if (layer.kind === 'adjust') return this.applyAdjust(dst, layer, g);
    if (!atop && !layer.mask?.enabled && this.livesFor(layer.id).length === 0) {
      dst.globalAlpha = layer.opacity;
      dst.globalCompositeOperation = op(layer.blend);
      this.drawTiles(dst, layer.id, g);
    } else {
      this.renderLayer(layer, g);
      dst.globalAlpha = layer.opacity;
      dst.globalCompositeOperation = atop ? 'source-atop' : op(layer.blend);
      dst.drawImage(this.scratch, 0, 0);
    }
    dst.globalAlpha = 1;
    dst.globalCompositeOperation = 'source-over';
  }

  /** A layer's pixels, with its strokes in progress and its mask, into the scratch canvas. */
  private renderLayer(layer: Layer, g: Grid): void {
    const s = this.scratchCtx;
    s.globalCompositeOperation = 'source-over';
    s.globalAlpha = 1;
    s.clearRect(0, 0, this.scratch.width, this.scratch.height);
    this.drawTiles(s, layer.id, g);
    this.drawLives(s, layer.id);
    if (!layer.mask?.enabled) return;
    const m = this.maskHidden(layer, g);
    s.globalCompositeOperation = 'destination-out';
    s.drawImage(m, 0, 0);
    s.globalCompositeOperation = 'source-over';
  }

  /**
   * The layer mask as "hidden" alpha: the grey paint over an implied white gives the visibility
   * v = grey·a + (1 − a), and hidden = 1 − v = a·(1 − grey). On the CPU: this is the fallback.
   */
  private maskHidden(layer: Layer, g: Grid): OffscreenCanvas {
    const m = this.buffer('mask');
    const key = maskKey(layer.id, layer.mask!.id);
    m.ctx.globalCompositeOperation = 'source-over';
    m.ctx.globalAlpha = 1;
    m.ctx.clearRect(0, 0, m.canvas.width, m.canvas.height);
    this.drawTiles(m.ctx, key, g);
    this.drawLives(m.ctx, key);
    const img = m.ctx.getImageData(0, 0, m.canvas.width, m.canvas.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const grey = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
      d[i + 3] = Math.round(d[i + 3] * (1 - grey));
      d[i] = d[i + 1] = d[i + 2] = 0;
    }
    m.ctx.putImageData(img, 0, 0);
    return m.canvas;
  }

  /** An adjustment layer, on the CPU: changes every pixel of `dst` by opacity and mask. */
  private applyAdjust(dst: Ctx, layer: Layer, g: Grid): void {
    const a = layer.adjust;
    if (!a || layer.opacity <= 0) return;
    const w = dst.canvas.width, h = dst.canvas.height;
    const hd = layer.mask?.enabled ? this.maskHidden(layer, g).getContext('2d')!.getImageData(0, 0, w, h).data : null;
    const img = dst.getImageData(0, 0, w, h);
    const d = img.data;
    const lut = a.type === 'hueSat' ? null : toneLut(a);
    const tone = (v: number) => lut![Math.round((v / 255) * (LUT_SIZE - 1))] * 255;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      const amount = layer.opacity * (hd ? 1 - hd[i + 3] / 255 : 1);
      if (amount <= 0) continue;
      let r: number, gg: number, b: number;
      if (lut) {
        r = tone(d[i]);
        gg = tone(d[i + 1]);
        b = tone(d[i + 2]);
      } else {
        const o = hueSat(a as Extract<typeof a, { type: 'hueSat' }>, d[i] / 255, d[i + 1] / 255, d[i + 2] / 255);
        r = o[0] * 255;
        gg = o[1] * 255;
        b = o[2] * 255;
      }
      d[i] += (r - d[i]) * amount;
      d[i + 1] += (gg - d[i + 1]) * amount;
      d[i + 2] += (b - d[i + 2]) * amount;
    }
    dst.putImageData(img, 0, 0);
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

interface Grid {
  lod: number;
  tx0: number;
  ty0: number;
  tx1: number;
  ty1: number;
  X: (tx: number) => number;
  Y: (ty: number) => number;
}
