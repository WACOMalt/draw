// WebGL2 renderer. Brush dabs, tiles, strokes in progress and the layer stack all live in
// half-float (RGBA16F) buffers when the device supports it, else RGBA8. Blend modes run in a
// shader. Tiles render on the main thread in small time slices; the GPU does the pixel work.

import { DAB_CHUNK, DAB_STRIDE, DabWalker, brushShape, strokeSeed } from '../../../shared/brush';
import { BLEND_MODES, BRUSH_TIPS, GRAINS, type Affine, type Brush, type Layer, type LayerBlend, type Stroke } from '../../../shared/types';
import { compose, effectivelyVisible, layerTree, subtreeIds, type LayerNode } from '../../../shared/layers';
import { LUT_SIZE, toneLut } from '../adjust';
import type { Renderer, ViewState } from '../renderer';
import { StrokeIndex, intersects, maskKey, strokeDabs, strokeKey, type StrokeRec } from '../strokeIndex';
import { MAX_LOD, TILE, lodFor, tileKey, tileWorld } from '../tiles';
import { GRAIN_SIZE, TIP_SIZE, grainIndex, grainMap, tipIndex, tipMask } from '../tips';
import { createPrograms, type Program, type Programs } from './programs';
import { perfProfile, type PerfProfile } from '../perf';

/** Two screen buffers: `a` holds the composite so far, `b` receives the next blend pass. */
interface Pair {
  a: Target;
  b: Target;
}

/** The tile grid of the current frame. */
interface Grid {
  lod: number;
  tx0: number;
  ty0: number;
  tx1: number;
  ty1: number;
  X: (tx: number) => number;
  Y: (ty: number) => number;
}

/**
 * Floats per dab instance on the GPU: cx, cy, rv, a, r, rot, then r, g, b, hardness (paintDabs),
 * then the stand-in data of a huge dab (putDab): edge offset, true center x, y. Color and
 * hardness per dab let a run of strokes share one draw call (drawStrokes).
 */
const INST = 13;
/** Most dabs in one batched draw call. */
const MAX_BATCH = 65536;

interface Target {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  w: number;
  h: number;
}

interface TransformPreview {
  /** The layer or group. */
  id: string;
  /** World transform not applied yet. */
  m: Affine;
  /** Applied: waiting for the tiles (settlePreview). */
  settle: boolean;
  settleAt: number;
  /** What the layer showed on screen at the start, and the view then. */
  snap: Target | null;
  capture: { x: number; y: number; ds: number } | null;
}

/** The blend mode a shader knows: pass through draws like normal once a group is isolated. */
const modeOf = (b: LayerBlend) => (b === 'pass' ? 'normal' : b);

interface Tile {
  layer: string;
  lod: number;
  tx: number;
  ty: number;
  /** null: no stroke touches the tile. */
  target: Target | null;
  /** Needs a full re-render (a stroke was removed or inserted below the top). */
  stale: boolean;
  /** Strokes added on top since the last render; they draw over the existing pixels. */
  append: StrokeRec[];
  /** Top seq of the layer when the tile was rendered. */
  maxSeq: number;
  /** Rendered at least once: it may be drawn while stale, so updates never flash. */
  rendered: boolean;
  used: number;
  /**
   * A full render that spans frames: the strokes draw into a fresh target, a few per frame,
   * and the target replaces the old one when all are drawn. Until then the old pixels (or a
   * stretched parent tile) stay on screen.
   */
  job: { target: Target; list: StrokeRec[]; next: number } | null;
}

interface Live {
  id: string;
  /** Layer id, or maskKey(layer, mask) for a stroke on a layer mask. */
  layerId: string;
  brush: Brush;
  walker: DabWalker;
  /** All dabs so far, world units: x, y, r, a, rot (DAB_STRIDE). */
  dabs: number[];
  /** First point of the stroke: the grain origin. */
  ox: number | null;
  oy: number | null;
  /** Dabs already drawn into the target at viewVersion. */
  drawn: number;
  viewVersion: number;
  target: Target | null;
  commitSeq: number | null;
  remote: boolean;
  ended: boolean;
  updated: number;
  started: number;
}

const PREFETCH = 1;
/** Slow-device check: frames while the view moves, and the median interval that is too slow. */
const SPEED_FRAMES = 60;
const SLOW_MS = 34;

/** Tiles from (tx0, ty0) to (tx1, ty1), inclusive, at one level of detail. */
interface TileRange {
  lod: number;
  tx0: number;
  ty0: number;
  tx1: number;
  ty1: number;
}
/** JavaScript time for tiles per frame: while the view moves or a stroke is drawn, and when still. */
const TILE_BUDGET_MS = 6;
const TILE_BUDGET_STILL_MS = 12;
/**
 * GPU work for tiles per frame, in device pixels of dab area (plus a fixed cost per dab and per
 * draw call). JavaScript time does not show GPU cost: a phone can queue far more fill than fits
 * in a frame, and then Chromium blocks the page until its GPU command buffer drains (the whole
 * UI freezes). Two budgets adapt to the measured frame interval: one while the view moves or a
 * stroke is drawn (aims at 60 fps), one while all is still (aims at 25 fps: tiles finish sooner,
 * and nothing moves that could stutter). A slow GPU that cannot reach 60 fps even without tiles
 * used to cut the only budget to the minimum, and a phone took minutes to draw a canvas.
 */
const FILL_MIN = 2e5;
const FILL_MAX = 6e7;
const MOVING_TARGET_MS = 20;
const STILL_TARGET_MS = 40;
/** The view counts as moving this long after a change. */
const MOVING_MS = 150;
/** Radius in px above which dabs are virtualized to keep float32 exact. */
const HUGE_PX = 1e6;
const MAX_APPEND = 64;
/**
 * WebKit (the Linux desktop app, Safari) can show a canvas frame only at the next compositor
 * update. After the view settles, a few identical frames push the last real one to the screen.
 */
const TAIL_FRAMES = /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Edg\//.test(navigator.userAgent) ? 2 : 0;

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export class GLRenderer implements Renderer {
  readonly kind = 'webgl2';
  precision: 8 | 16 = 8;
  readonly view: ViewState = { x: 0, y: 0, zoom: 1 };
  paper = '#ffffff';

  private progs!: Programs;
  private quadVbo!: WebGLBuffer;
  private quadVao!: WebGLVertexArrayObject;
  private dabVao!: WebGLVertexArrayObject;
  private dabVbo!: WebGLBuffer;
  private dabCap = 0;
  private inst = new Float32Array(INST * 4096);
  private fmt!: { internal: number; format: number; type: number };

  private compA!: Target;
  private compB!: Target;
  private layerT!: Target;
  private strokeT!: Target; // tile-sized buffer for strokes with opacity < 1
  private pickT!: Target;
  /** Screen buffers made only when a frame needs them: layer masks and clipping groups. */
  /** Screen-sized buffers some frames need (masks, clipping and group buffers per depth). */
  private extra = new Map<string, Target>();
  private tipTex!: WebGLTexture;
  private grainTex!: WebGLTexture;
  private tipsReady = new Set<number>();
  private grainsReady = new Set<number>();
  /** Tone lookup textures of adjustment layers, by layer id. */
  private luts = new Map<string, { key: string; tex: WebGLTexture }>();
  private tilePool: Target[] = [];
  private livePool: Target[] = [];

  private tiles = new Map<string, Tile>();
  private index = new StrokeIndex();
  private layers: Layer[] = [];
  /** The layer tree of `layers` (groups with their layers), and the layers by id. */
  private tree: LayerNode[] = [];
  private byId = new Map<string, Layer>();
  /** A layer or group drawn moved by a transform that is not applied yet (see setTransformPreview). */
  private preview: TransformPreview | null = null;
  private live = new Map<string, Live>();
  private appliedSeq = 0;

  private dpr = 1;
  private cssW = 1;
  private cssH = 1;
  private frame = 0;
  private viewVersion = 0;
  private raf = 0;
  private dirty = false;
  private tail = 0;
  private lost = false;
  private maxTiles: number;
  private hardMaxTiles: number;
  private fillBudget: number;
  private fillMoving: number;
  private lastFrameAt = 0;
  private lastViewChange = 0;
  /** The previous frame drew tiles: its interval says how much GPU work fits. */
  private tileWorkLastFrame = false;
  private cleanup: (() => void)[] = [];

  /**
   * `offline`: a renderer for exports, on a canvas that is not on screen. It renders only when
   * asked (renderSync), each time to completion: no frame budget, no prefetch ring, no coarser
   * levels.
   */
  constructor(
    private canvas: HTMLCanvasElement,
    private gl: WebGL2RenderingContext,
    private offline = false,
    readonly profile: PerfProfile = perfProfile(gl),
  ) {
    // A 256 px tile is 512 KB in RGBA16F, 256 KB in RGBA8.
    this.maxTiles = profile.maxTiles;
    this.hardMaxTiles = profile.hardMaxTiles;
    this.fillBudget = profile.fill;
    this.fillMoving = profile.fill * 0.35;
    this.initGL();
    const lost = (e: Event) => {
      e.preventDefault();
      this.lost = true;
    };
    const restored = () => {
      this.lost = false;
      this.initGL();
      this.invalidate();
    };
    canvas.addEventListener('webglcontextlost', lost);
    canvas.addEventListener('webglcontextrestored', restored);
    this.cleanup.push(() => {
      canvas.removeEventListener('webglcontextlost', lost);
      canvas.removeEventListener('webglcontextrestored', restored);
    });
  }

  // --- GL setup ------------------------------------------------------------------------------

  /** Creates every GL resource. Runs at start and after a lost context comes back. */
  private initGL(): void {
    const gl = this.gl;
    // The light profile asks for 8-bit buffers: half the memory and bandwidth.
    const floatOk = this.profile.bits === 16 && !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
    this.fmt = floatOk
      ? { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT }
      : { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE };
    this.precision = floatOk ? 16 : 8;
    // Some drivers list the extension but cannot render to RGBA16F. Check once.
    if (floatOk) {
      const probe = this.makeTarget(4, 4);
      const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      this.freeTarget(probe);
      if (!ok) {
        this.fmt = { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE };
        this.precision = 8;
      }
    }

    this.progs = createPrograms(gl);

    this.quadVbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    this.quadVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.quadVao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.dabVbo = gl.createBuffer()!;
    this.dabCap = 0;
    this.dabVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.dabVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dabVbo);
    const stride = INST * 4;
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 16);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 20);
    gl.vertexAttribDivisor(3, 1);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 4, gl.FLOAT, false, stride, 24);
    gl.vertexAttribDivisor(4, 1);
    gl.enableVertexAttribArray(5);
    gl.vertexAttribPointer(5, 3, gl.FLOAT, false, stride, 40);
    gl.vertexAttribDivisor(5, 1);
    gl.bindVertexArray(null);

    // Tips and grains upload on first use (tips.ts generates them on the CPU).
    this.tipTex = this.makeArray(TIP_SIZE, BRUSH_TIPS.length, false);
    this.grainTex = this.makeArray(GRAIN_SIZE, GRAINS.length, true);
    this.tipsReady.clear();
    this.grainsReady.clear();
    this.luts.clear();

    this.strokeT = this.makeTarget(TILE, TILE);
    this.pickT = this.makeTarget(1, 1, true);
    this.tilePool = [];
    this.livePool = [];
    // Old textures died with the context: forget every tile, redraw live strokes.
    this.tiles.clear();
    this.preview = null;
    for (const l of this.live.values()) {
      l.target = null;
      l.viewVersion = -1;
    }
    this.allocScreenTargets();
  }

  private makeTarget(w: number, h: number, rgba8 = false): Target {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (rgba8) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, this.fmt.internal, w, h, 0, this.fmt.format, this.fmt.type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fbo, w, h };
  }

  /** A mipmapped single-channel texture array for tips or grains. */
  private makeArray(size: number, layers: number, repeat: boolean): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, Math.log2(size) + 1, gl.R8, size, size, layers);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const wrap = repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, wrap);
    return tex;
  }

  private uploadLayer(tex: WebGLTexture, size: number, layer: number, data: Uint8Array): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, size, size, 1, gl.RED, gl.UNSIGNED_BYTE, data);
    gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
  }

  /** A screen-sized buffer that only some frames need, made on first use. */
  private screen(name: string): Target {
    let t = this.extra.get(name);
    if (!t) this.extra.set(name, (t = this.makeTarget(this.canvas.width || 1, this.canvas.height || 1)));
    return t;
  }

  private freeTarget(t: Target): void {
    this.gl.deleteFramebuffer(t.fbo);
    this.gl.deleteTexture(t.tex);
  }

  private allocScreenTargets(): void {
    const w = this.canvas.width || 1;
    const h = this.canvas.height || 1;
    for (const t of [this.compA, this.compB, this.layerT]) if (t) this.freeTarget(t);
    for (const t of this.extra.values()) this.freeTarget(t);
    this.extra.clear();
    for (const t of this.livePool) this.freeTarget(t);
    this.livePool = [];
    this.compA = this.makeTarget(w, h);
    this.compB = this.makeTarget(w, h);
    this.layerT = this.makeTarget(w, h);
    for (const l of this.live.values()) {
      if (l.target) this.freeTarget(l.target);
      l.target = null;
      l.viewVersion = -1;
    }
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.cleanup.forEach((f) => f());
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  // --- geometry ------------------------------------------------------------------------------

  resize(cssW: number, cssH: number, dpr: number): void {
    this.cssW = Math.max(1, cssW);
    this.cssH = Math.max(1, cssH);
    this.dpr = dpr;
    this.canvas.width = Math.round(this.cssW * dpr);
    this.canvas.height = Math.round(this.cssH * dpr);
    if (!this.lost) this.allocScreenTargets();
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
    this.lastViewChange = performance.now();
    this.invalidate();
  }

  toWorld(cssX: number, cssY: number): [number, number] {
    return [this.view.x + cssX / this.view.zoom, this.view.y + cssY / this.view.zoom];
  }

  toScreen(wx: number, wy: number): [number, number] {
    return [(wx - this.view.x) * this.view.zoom, (wy - this.view.y) * this.view.zoom];
  }

  invalidate(): void {
    this.dirty = true;
    if (!this.raf && !this.offline) this.raf = requestAnimationFrame(() => this.render());
  }

  /** Offline: brings every tile of the view up to date and composites it. */
  renderSync(): void {
    for (let i = 0; i < 1000; i++) {
      this.render();
      if (!this.lastPending) return;
    }
  }

  /** The composited view as 8-bit RGBA, top row first (alpha is always 255). */
  readRGBA(): Uint8ClampedArray<ArrayBuffer> | null {
    if (this.lost) return null;
    const gl = this.gl;
    const w = this.compA.w, h = this.compA.h;
    const out = this.makeTarget(w, h, true);
    this.bindTarget(out);
    gl.disable(gl.BLEND);
    this.copy(this.compA.tex, out, [0, 0, w, h]);
    const px = new Uint8ClampedArray(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    this.freeTarget(out);
    for (let i = 3; i < px.length; i += 4) px[i] = 255;
    return px;
  }

  // --- document ------------------------------------------------------------------------------

  setLayers(layers: Layer[]): void {
    this.layers = layers;
    this.tree = layerTree(layers);
    this.byId = new Map(layers.map((l) => [l.id, l]));
    for (const [id, l] of this.luts) {
      if (!layers.some((x) => x.id === id && x.kind === 'adjust')) {
        this.gl.deleteTexture(l.tex);
        this.luts.delete(id);
      }
    }
    this.invalidate();
  }

  resetStrokes(strokes: Stroke[], seq: number): void {
    this.index.clear();
    for (const s of strokes) this.index.add(s);
    for (const t of this.tiles.values()) {
      t.stale = true;
      t.append = [];
    }
    this.appliedSeq = seq;
    this.invalidate();
  }

  addStroke(stroke: Stroke, seq: number): void {
    const rec = this.index.add(stroke);
    const key = strokeKey(stroke);
    for (const t of this.tiles.values()) {
      if (t.layer !== key) continue;
      const [x0, y0, x1, y1] = this.tileBounds(t);
      if (!intersects(rec, x0, y0, x1, y1)) continue;
      // A render in progress has its stroke list already: start it again with this stroke.
      if (t.job) this.dropJob(t);
      if (t.stale) continue;
      // On top of everything the tile shows: draw it over the existing pixels.
      if (stroke.seq > t.maxSeq && t.append.length < MAX_APPEND) t.append.push(rec);
      else {
        t.stale = true;
        t.append = [];
      }
    }
    this.appliedSeq = seq;
    this.invalidate();
  }

  removeStroke(id: string, seq: number): void {
    const rec = this.index.remove(id);
    if (rec) {
      const key = strokeKey(rec.stroke);
      for (const t of this.tiles.values()) {
        if (t.layer !== key) continue;
        const [x0, y0, x1, y1] = this.tileBounds(t);
        if (intersects(rec, x0, y0, x1, y1)) {
          if (t.job) this.dropJob(t);
          t.stale = true;
          t.append = [];
        }
      }
    }
    this.appliedSeq = seq;
    this.invalidate();
  }

  advanceSeq(seq: number): void {
    this.appliedSeq = seq;
    this.invalidate();
  }

  // --- strokes in progress -------------------------------------------------------------------

  liveBegin(id: string, layerId: string, brush: Brush, remote: boolean): void {
    if (this.live.has(id)) return;
    const now = performance.now();
    this.live.set(id, {
      id,
      layerId,
      brush,
      walker: new DabWalker(brush, strokeSeed(id)),
      dabs: [],
      ox: null,
      oy: null,
      drawn: 0,
      viewVersion: -1,
      target: null,
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
    if (l.ox === null && pts.length >= 2) {
      l.ox = pts[0];
      l.oy = pts[1];
    }
    const sink = (x: number, y: number, r: number, a: number, rot: number) => l.dabs.push(x, y, r, a, rot);
    for (let i = 0; i + 2 < pts.length; i += 3) l.walker.push(pts[i], pts[i + 1], pts[i + 2], sink);
    l.updated = performance.now();
    this.invalidate();
  }

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
    if (l.target) {
      if (l.target.w === this.canvas.width && l.target.h === this.canvas.height && this.livePool.length < 3) {
        this.livePool.push(l.target);
      } else this.freeTarget(l.target);
    }
    this.invalidate();
  }

  sweepLive(): void {
    const now = performance.now();
    for (const l of this.live.values()) {
      if (l.commitSeq !== null || !l.remote) continue;
      if ((l.ended && now - l.updated > 3000) || now - l.updated > 15000) this.liveCancel(l.id);
    }
  }

  // --- dab drawing -----------------------------------------------------------------------------

  /** Ensures room for n instances in the CPU array. */
  private reserve(n: number): void {
    if (this.inst.length >= n * INST) return;
    let cap = this.inst.length;
    while (cap < n * INST) cap *= 2;
    const next = new Float32Array(cap);
    next.set(this.inst);
    this.inst = next;
  }

  /**
   * Writes one dab into the instance array, in target pixels relative to (ox, oy).
   * All position math is double precision; only the small results go to float32.
   * Returns false when the dab is culled.
   */
  private putDab(i: number, x: number, y: number, r: number, a: number, rot: number, ox: number, oy: number, scale: number, w: number, h: number): boolean {
    let rp = r * scale;
    let cx = (x - ox) * scale;
    let cy = (y - oy) * scale;
    if (cx + rp + 1 < 0 || cx - rp - 1 > w || cy + rp + 1 < 0 || cy - rp - 1 > h) return false;
    if (rp < 0.5) {
      // Sub-pixel dab: one pixel, alpha scaled by the covered area.
      a *= 4 * rp * rp;
      rp = 0.5;
    }
    if (a <= 1e-5) return false;
    let rv = rp;
    let off = 0, tx = 0, ty = 0;
    if (rp > HUGE_PX) {
      // A stand-in circle of radius HUGE_PX, placed so that its edge lies along the true edge
      // near the target: float32 keeps the edge exact there. Its center goes no deeper than
      // half its radius inside; `off` adds the rest of the true depth to the edge distance.
      // Without it, a target deeper than 2 × HUGE_PX inside the dab fell outside the stand-in,
      // and a big stroke vanished when zoomed far into it. (tx, ty) is the true center relative
      // to the stand-in's, for textured tips.
      const tcx = w / 2, tcy = h / 2;
      const dx = tcx - cx, dy = tcy - cy;
      const dist = Math.hypot(dx, dy);
      const inside = rp - dist; // true edge distance at the target center
      const ux = dist > 0 ? dx / dist : 1, uy = dist > 0 ? dy / dist : 0;
      rv = HUGE_PX;
      const keep = Math.min(inside, rv / 2);
      off = inside - keep;
      const vx = tcx - ux * (rv - keep), vy = tcy - uy * (rv - keep);
      tx = cx - vx;
      ty = cy - vy;
      cx = vx;
      cy = vy;
    }
    const o = i * INST;
    const f = this.inst;
    f[o] = cx;
    f[o + 1] = cy;
    f[o + 2] = rv;
    f[o + 3] = Math.min(1, a);
    f[o + 4] = rp;
    f[o + 5] = rot;
    f[o + 10] = off;
    f[o + 11] = tx;
    f[o + 12] = ty;
    return true;
  }

  /**
   * Grain placement in target pixels: the origin (the first point of the stroke, reduced modulo
   * one period so the numbers stay small at any zoom) and the period. Null: no grain.
   */
  private grainFor(b: Brush, sx: number, sy: number, ox: number, oy: number, scale: number): [number, number, number] | null {
    if (!b.grain || !(b.grainStrength ?? 0.5)) return null;
    const period = b.size * (b.grainScale ?? 1) * scale;
    if (!(period > 1e-6) || !Number.isFinite(period)) return null;
    const m = (v: number) => ((v % period) + period) % period;
    return [m((sx - ox) * scale), m((sy - oy) * scale), period];
  }

  /** Sets the color and hardness of instances from..to-1 (see INST). */
  private paintDabs(from: number, to: number, brush: Brush): void {
    const [r, g, b] = hexToRgb(brush.color);
    const f = this.inst;
    for (let i = from; i < to; i++) {
      const o = i * INST;
      f[o + 6] = r;
      f[o + 7] = g;
      f[o + 8] = b;
      f[o + 9] = brush.hardness;
    }
  }

  /**
   * Draws n prepared instances into the bound target. The caller sets the blend state. `painted`:
   * the instances have their own color and hardness already (a batch); else the brush's apply.
   */
  private drawDabs(n: number, brush: Brush, w: number, h: number, grain: [number, number, number] | null, painted = false): void {
    if (n === 0) return;
    if (!painted) this.paintDabs(0, n, brush);
    const gl = this.gl;
    const p = this.progs.dab;
    gl.useProgram(p.prog);
    gl.uniform2f(p.u.uTarget, w, h);
    const shape = brushShape(brush);
    const tip = shape.tip === 'round' ? -1 : tipIndex(shape.tip);
    if (tip >= 0 && !this.tipsReady.has(tip)) {
      this.uploadLayer(this.tipTex, TIP_SIZE, tip, tipMask(shape.tip));
      this.tipsReady.add(tip);
    }
    gl.uniform1i(p.u.uTip, tip);
    gl.uniform1f(p.u.uRoundness, shape.roundness);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tipTex);
    gl.uniform1i(p.u.uTips, 1);
    const gi = grain && brush.grain ? grainIndex(brush.grain) : -1;
    if (gi >= 0 && !this.grainsReady.has(gi)) {
      this.uploadLayer(this.grainTex, GRAIN_SIZE, gi, grainMap(brush.grain!));
      this.grainsReady.add(gi);
    }
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.grainTex);
    gl.uniform1i(p.u.uGrains, 2);
    gl.uniform1i(p.u.uGrain, gi);
    if (gi >= 0) {
      gl.uniform1f(p.u.uGrainStrength, brush.grainStrength ?? 0.5);
      gl.uniform2f(p.u.uGrainOrigin, grain![0], grain![1]);
      gl.uniform1f(p.u.uGrainPx, grain![2]);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dabVbo);
    const bytes = n * INST * 4;
    if (bytes > this.dabCap) {
      this.dabCap = Math.max(bytes, this.dabCap * 2, 65536);
      gl.bufferData(gl.ARRAY_BUFFER, this.dabCap, gl.DYNAMIC_DRAW);
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.inst, 0, n * INST);
    gl.bindVertexArray(this.dabVao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
    gl.bindVertexArray(null);
  }

  private bindTarget(t: Target | null): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fbo : null);
    gl.viewport(0, 0, t ? t.w : this.canvas.width, t ? t.h : this.canvas.height);
  }

  private clear(r = 0, g = 0, b = 0, a = 0): void {
    const gl = this.gl;
    gl.disable(gl.BLEND);
    gl.clearColor(r, g, b, a);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** Premultiplied source-over for paint, destination-out for erase. */
  private blendFor(erase: boolean): void {
    const gl = this.gl;
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    if (erase) gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
    else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  private quad(p: Program, target: Target | null, dst: [number, number, number, number], src: [number, number, number, number] = [0, 0, 1, 1]): void {
    const gl = this.gl;
    const w = target ? target.w : this.canvas.width;
    const h = target ? target.h : this.canvas.height;
    gl.uniform4f(p.u.uDst, dst[0], dst[1], dst[2], dst[3]);
    gl.uniform4f(p.u.uSrc, src[0], src[1], src[2], src[3]);
    gl.uniform2f(p.u.uTarget, w, h);
    gl.uniform1f(p.u.uFlipY, target ? 0 : 1);
    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private copy(tex: WebGLTexture, target: Target | null, dst: [number, number, number, number], opacity = 1, src?: [number, number, number, number]): void {
    const gl = this.gl;
    const p = this.progs.copy;
    gl.useProgram(p.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(p.u.uTex, 0);
    gl.uniform1f(p.u.uOpacity, opacity);
    this.quad(p, target, dst, src);
  }

  // --- tiles -------------------------------------------------------------------------------------

  private tileBounds(t: { lod: number; tx: number; ty: number }): [number, number, number, number] {
    const tw = tileWorld(t.lod);
    return [t.tx * tw, t.ty * tw, (t.tx + 1) * tw, (t.ty + 1) * tw];
  }

  private allocTile(): Target {
    return this.tilePool.pop() ?? this.makeTarget(TILE, TILE);
  }

  /**
   * Puts the dabs of a stroke that touch a w × h target at instances from `at` on, with their
   * color and hardness. A stroke that covers about one pixel here becomes one dot instead of
   * every dab (that dot has no tip, rotation or grain: it stands for a whole tiny stroke).
   * Returns the instances added, a fill estimate (the quad of each dab, true radius capped at the
   * tile, at least 16 px), and the brush that draws them.
   */
  private stageStroke(rec: StrokeRec, at: number, wx0: number, wy0: number, scale: number, w: number, h: number): { n: number; fill: number; brush: Brush; dot: boolean } {
    const b = rec.stroke.brush;
    const dot = (rec.x1 - rec.x0) * scale < 2 && (rec.y1 - rec.y0) * scale < 2;
    let n = 0;
    if (dot) {
      this.reserve(at + 1);
      const r = Math.max(rec.x1 - rec.x0, rec.y1 - rec.y0) / 2;
      if (this.putDab(at, (rec.x0 + rec.x1) / 2, (rec.y0 + rec.y1) / 2, r, 1, 0, wx0, wy0, scale, w, h)) n = 1;
    } else {
      const { dabs, chunks, count } = strokeDabs(rec);
      const wx1 = wx0 + w / scale, wy1 = wy0 + h / scale;
      this.reserve(at + count);
      for (let c = 0; c * DAB_CHUNK < count; c++) {
        const co = c * 4;
        if (chunks[co + 2] <= wx0 || chunks[co] >= wx1 || chunks[co + 3] <= wy0 || chunks[co + 1] >= wy1) continue;
        const end = Math.min(count, (c + 1) * DAB_CHUNK);
        for (let i = c * DAB_CHUNK; i < end; i++) {
          const o = i * DAB_STRIDE;
          if (this.putDab(at + n, dabs[o], dabs[o + 1], dabs[o + 2], dabs[o + 3], dabs[o + 4], wx0, wy0, scale, w, h)) n++;
        }
      }
    }
    const brush = dot ? { ...b, tip: undefined, roundness: undefined } : b;
    if (n === 0) return { n, fill: 0, brush, dot };
    let fill = 0;
    const f = this.inst;
    for (let i = at; i < at + n; i++) {
      const r = Math.min(f[i * INST + 4], TILE) + 1;
      fill += Math.max(16, 4 * r * r);
    }
    this.paintDabs(at, at + n, brush);
    return { n, fill, brush, dot };
  }

  /**
   * Strokes with the same key draw the same way apart from color and hardness, so a run of them
   * shares one draw call. Null: the stroke needs a call of its own (below full opacity it goes
   * through a stroke buffer; grain has a per-stroke origin).
   */
  private batchKey(rec: StrokeRec, scale: number): string | null {
    const b = rec.stroke.brush;
    if (b.opacity < 1 || (b.grain && (b.grainStrength ?? 0.5))) return null;
    const erase = b.tool === 'erase' ? 'e' : 'p';
    if ((rec.x1 - rec.x0) * scale < 2 && (rec.y1 - rec.y0) * scale < 2) return `${erase}|round|1`;
    const s = brushShape(b);
    return `${erase}|${s.tip}|${s.roundness}`;
  }

  /**
   * Draws list[from], list[from + 1], ... into a tile target until `budget` is spent (at least
   * one stroke). Runs of strokes with the same batchKey go in one draw call: a tile crossed by
   * hundreds of strokes took hundreds of calls, and on a phone the cost per call, not the pixels,
   * set the speed. The dabs keep their order, so the result is the same. Returns the work spent
   * and the next index.
   */
  private drawStrokes(target: Target, list: StrokeRec[], from: number, wx0: number, wy0: number, scale: number, budget: number): { work: number; next: number } {
    let work = 0;
    let i = from;
    const w = target.w, h = target.h;
    do {
      const key = this.batchKey(list[i], scale);
      if (key === null) {
        work += this.drawStroke(target, list[i++], wx0, wy0, scale);
        continue;
      }
      let n = 0;
      let brush: Brush | null = null;
      while (i < list.length && (n === 0 || (work < budget && n < MAX_BATCH)) && this.batchKey(list[i], scale) === key) {
        const s = this.stageStroke(list[i++], n, wx0, wy0, scale, w, h);
        if (!s.n) continue;
        n += s.n;
        work += s.fill;
        brush ??= s.brush;
      }
      if (n === 0) continue;
      work += 2000; // the draw call
      this.bindTarget(target);
      this.blendFor(key[0] === 'e');
      this.drawDabs(n, brush!, w, h, null, true);
    } while (i < list.length && work < budget);
    return { work, next: i };
  }

  /** Draws one stroke into a tile target, in a call of its own. Returns the work spent. */
  private drawStroke(target: Target, rec: StrokeRec, wx0: number, wy0: number, scale: number): number {
    const b = rec.stroke.brush;
    const w = target.w, h = target.h;
    const { n, fill, brush, dot } = this.stageStroke(rec, 0, wx0, wy0, scale, w, h);
    if (n === 0) return 0;
    let work = 2000 + fill; // the draw call and the dabs
    const erase = b.tool === 'erase';
    const grain = dot ? null : this.grainFor(b, rec.stroke.pts[0], rec.stroke.pts[1], wx0, wy0, scale);
    if (b.opacity >= 1) {
      // Source-over and destination-out are associative: at full opacity the dabs can go
      // straight onto the tile with the same result as a separate stroke buffer.
      this.bindTarget(target);
      this.blendFor(erase);
      this.drawDabs(n, brush, w, h, grain, true);
    } else {
      this.bindTarget(this.strokeT);
      this.clear();
      this.blendFor(false);
      this.drawDabs(n, brush, w, h, grain, true);
      this.bindTarget(target);
      this.blendFor(erase);
      this.copy(this.strokeT.tex, target, [0, 0, w, h], b.opacity);
      work += 3 * w * h; // clear, copy
    }
    return work;
  }

  /** Stops a render in progress and returns its target to the pool. */
  private dropJob(t: Tile): void {
    if (!t.job) return;
    this.tilePool.push(t.job.target);
    t.job = null;
  }

  /**
   * Brings one tile up to date, or moves it closer. A full render (stale or new) draws into a
   * fresh target and may span frames: it stops once `budget` is spent and goes on next frame.
   * Appended strokes draw at once (they are few). Returns the work spent.
   */
  private renderTile(t: Tile, budget: number): number {
    const [wx0, wy0, wx1, wy1] = this.tileBounds(t);
    const scale = TILE / (wx1 - wx0);
    let work = 0;
    if (t.stale) {
      if (!t.job) {
        const list = (this.index.byLayer.get(t.layer) ?? []).filter((r) => intersects(r, wx0, wy0, wx1, wy1));
        if (list.length === 0) {
          if (t.target) this.tilePool.push(t.target);
          t.target = null;
          this.finishTile(t);
          return 1000;
        }
        const target = this.allocTile();
        this.bindTarget(target);
        this.clear();
        t.job = { target, list, next: 0 };
        work += TILE * TILE;
      }
      const job = t.job;
      // At least one stroke per call, so a tile always moves forward.
      const done = this.drawStrokes(job.target, job.list, job.next, wx0, wy0, scale, budget - work);
      work += done.work;
      job.next = done.next;
      if (job.next < job.list.length) return work;
      if (t.target) this.tilePool.push(t.target);
      t.target = job.target;
      t.job = null;
    } else {
      if (!t.target) {
        t.target = this.allocTile();
        this.bindTarget(t.target);
        this.clear();
      }
      if (t.append.length) work += this.drawStrokes(t.target, t.append, 0, wx0, wy0, scale, Infinity).work;
    }
    this.finishTile(t);
    return work;
  }

  private finishTile(t: Tile): void {
    t.stale = false;
    t.append = [];
    t.maxSeq = this.index.topSeq(t.layer);
    t.rendered = true;
  }

  private needsWork(t: Tile | undefined): boolean {
    return !t || t.stale || t.append.length > 0;
  }

  /**
   * Frees the least recently used tiles when there are too many. Tiles in the ranges that render
   * keeps current are never freed: a tile that is done but not on screen (the prefetch ring, the
   * coarser level) would otherwise be freed and rendered again, over and over. The limit grows to
   * fit those ranges for every visible layer.
   */
  private evictTiles(ranges: TileRange[], needed: number): void {
    const inView = (t: Tile) => ranges.some((r) => t.lod === r.lod && t.tx >= r.tx0 && t.tx <= r.tx1 && t.ty >= r.ty0 && t.ty <= r.ty1);
    const max = Math.min(this.hardMaxTiles, Math.max(this.maxTiles, Math.ceil(needed * 1.25)));
    let count = 0;
    for (const t of this.tiles.values()) count += (t.target ? 1 : 0) + (t.job ? 1 : 0);
    if (count <= max && this.tiles.size <= 20000) return;
    const old = [...this.tiles.entries()].filter(([, t]) => t.used < this.frame && !inView(t)).sort((a, b) => a[1].used - b[1].used);
    for (const [key, t] of old) {
      if (count <= max * 0.85 && this.tiles.size <= 16000) break;
      if (t.target) {
        if (this.tilePool.length < 32) this.tilePool.push(t.target);
        else this.freeTarget(t.target);
        count--;
      }
      if (t.job) {
        this.freeTarget(t.job.target);
        t.job = null;
        count--;
      }
      this.tiles.delete(key);
    }
  }

  // --- frame ---------------------------------------------------------------------------------------

  /** Called when panning and zooming run under 30 fps (see watchSpeed). */
  onSlow: (() => void) | null = null;
  private moveFrames: number[] = [];

  /**
   * Collects the frame intervals while the view moves (tiles get a small share then, so these
   * frames are mostly compositing). A median above SLOW_MS over SPEED_FRAMES frames calls onSlow.
   */
  private watchSpeed(interval: number, now: number): void {
    if (this.offline || !this.onSlow || interval > 250 || now - this.lastViewChange > MOVING_MS) return;
    this.moveFrames.push(interval);
    if (this.moveFrames.length < SPEED_FRAMES) return;
    const sorted = this.moveFrames.sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    this.moveFrames = [];
    if (median > SLOW_MS) this.onSlow();
  }

  /** For performance checks (__draw.engine.comp.stats() in the console): tiles in GPU memory, pending work. */
  stats(): { frames: number; tiles: number; viewPending: boolean; pending: boolean; fill: number; fillMoving: number; scale: number; bits: number; profile: string } {
    let tiles = 0;
    for (const t of this.tiles.values()) tiles += t.target ? 1 : 0;
    return {
      frames: this.frame,
      tiles,
      viewPending: this.lastViewPending,
      pending: this.lastPendingWork,
      fill: Math.round(this.fillBudget),
      fillMoving: Math.round(this.fillMoving),
      scale: this.dpr,
      bits: this.precision,
      profile: this.profile.name,
    };
  }
  private lastPendingWork = true;
  private lastViewPending = true;

  /** Offline: the last render stopped before all tiles were done. */
  private lastPending = false;

  private render(): void {
    this.raf = 0;
    if (this.dirty) {
      this.dirty = false;
      this.tail = TAIL_FRAMES;
    } else this.tail--;
    if (this.lost || this.gl.isContextLost()) return;
    this.frame++;
    const gl = this.gl;
    const ds = this.view.zoom * this.dpr;
    const lod = lodFor(ds);
    const tw = tileWorld(lod);
    const vx = this.view.x, vy = this.view.y;
    const tx0 = Math.floor(vx / tw), ty0 = Math.floor(vy / tw);
    const tx1 = Math.floor((vx + this.cssW / this.view.zoom) / tw);
    const ty1 = Math.floor((vy + this.cssH / this.view.zoom) / tw);
    // Paint and adjustment layers that show: visible, in groups that are all visible.
    const visible = this.layers.filter((l) => l.kind !== 'group' && effectivelyVisible(this.byId, l));
    // Tile sets to keep current, topmost first: each paint layer, and each enabled layer mask.
    const keys: string[] = [];
    for (let li = visible.length - 1; li >= 0; li--) {
      const l = visible[li];
      if (l.kind !== 'adjust') keys.push(l.id);
      if (l.mask?.enabled) keys.push(maskKey(l.id, l.mask.id));
    }

    // 1. Bring tiles up to date, center first, within a time budget (JavaScript) and a fill
    //    budget (GPU). The fill budget follows the frame interval: shorter frames raise it,
    //    longer ones cut it. While the view moves, tiles get a smaller share.
    const start = performance.now();
    const interval = start - this.lastFrameAt;
    this.lastFrameAt = start;
    this.watchSpeed(interval, start);
    // Moving: the view changed just now, or this device draws a stroke (it must stay smooth).
    let drawing = false;
    for (const l of this.live.values()) if (!l.remote && !l.ended) drawing = true;
    const moving = start - this.lastViewChange < MOVING_MS || drawing;
    const target = moving ? MOVING_TARGET_MS : STILL_TARGET_MS;
    if (this.tileWorkLastFrame && interval < 150) {
      const b = moving ? this.fillMoving : this.fillBudget;
      const next = interval > target * 1.15 ? Math.max(FILL_MIN, b * 0.75) : interval < target * 0.85 ? Math.min(FILL_MAX, b * 1.1) : b;
      if (moving) this.fillMoving = next;
      else this.fillBudget = next;
    }
    const fill = moving ? this.fillMoving : this.fillBudget;
    const jsBudget = moving ? TILE_BUDGET_MS : TILE_BUDGET_STILL_MS;
    let spent = 0;
    let pending = false;
    /** Work left in the view and its prefetch ring (not just in the coarser levels). */
    let viewPending = false;
    // First the view and a ring of PREFETCH tiles. Then COARSE_LEVELS coarser levels, centered:
    // one level up over 2× the view, two levels up over 4×. After a zoom out by 2 or 4 that is
    // the whole screen, and a pan shows stretched content at once instead of blank tiles. Each
    // level costs about one view of tiles, and renders only when the view is done.
    const vw = this.cssW / this.view.zoom, vh = this.cssH / this.view.zoom;
    const area = (r: TileRange) => (r.tx1 - r.tx0 + 1) * (r.ty1 - r.ty0 + 1) * keys.length;
    const ring = this.offline ? 0 : PREFETCH;
    const ranges: TileRange[] = [{ lod, tx0: tx0 - ring, ty0: ty0 - ring, tx1: tx1 + ring, ty1: ty1 + ring }];
    let total = area(ranges[0]);
    for (let up = 1; up <= (this.offline ? 0 : this.profile.coarseLevels) && lod + up <= MAX_LOD; up++) {
      const ctw = tileWorld(lod + up);
      const m = (2 ** up - 1) / 2; // margin on each side, in views: 2× the view, then 4×
      const coarse = {
        lod: lod + up,
        tx0: Math.floor((vx - vw * m) / ctw),
        ty0: Math.floor((vy - vh * m) / ctw),
        tx1: Math.floor((vx + vw * (1 + m)) / ctw),
        ty1: Math.floor((vy + vh * (1 + m)) / ctw),
      };
      // Many layers: GPU memory goes to the view first.
      if (total + area(coarse) > this.hardMaxTiles) break;
      total += area(coarse);
      ranges.push(coarse);
    }
    outer: for (const r of ranges) {
      const rtw = tileWorld(r.lod);
      const cx = (vx + vw / 2) / rtw - 0.5, cy = (vy + vh / 2) / rtw - 0.5;
      const order: [number, number][] = [];
      for (let ty = r.ty0; ty <= r.ty1; ty++) for (let tx = r.tx0; tx <= r.tx1; tx++) order.push([tx, ty]);
      order.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy));
      for (const [tx, ty] of order) {
        for (const layer of keys) {
          const key = tileKey(layer, r.lod, tx, ty);
          let t = this.tiles.get(key);
          if (!this.needsWork(t)) continue;
          if (!this.offline && (spent >= fill || performance.now() - start > jsBudget)) {
            pending = true;
            if (r === ranges[0]) viewPending = true;
            break outer;
          }
          if (!t) {
            t = { layer, lod: r.lod, tx, ty, target: null, stale: true, append: [], maxSeq: -1, rendered: false, used: this.frame, job: null };
            this.tiles.set(key, t);
          }
          t.used = this.frame;
          spent += this.renderTile(t, this.offline ? Infinity : fill - spent);
        }
      }
    }
    this.tileWorkLastFrame = spent > 0;
    this.lastPendingWork = pending;
    this.lastViewPending = viewPending;
    // A committed stroke's buffer can go once the tiles show it.
    if (!pending) {
      for (const l of [...this.live.values()]) if (l.commitSeq !== null && l.commitSeq <= this.appliedSeq) this.liveCancel(l.id);
    }

    // 2. Update the buffers of strokes in progress.
    for (const l of this.live.values()) this.updateLive(l);

    // 3. Composite the layers, bottom to top. A layer with clipped layers right above it is the
    //    base of a clipping group: the group draws in its own buffer, each clipped layer only where
    //    the base has alpha ("atop"), then goes onto the composite with the base's blend and opacity.
    const grid: Grid = {
      lod,
      tx0,
      ty0,
      tx1,
      ty1,
      X: (tx) => Math.round((tx * tw - vx) * ds),
      Y: (ty) => Math.round((ty * tw - vy) * ds),
    };
    let main: Pair = { a: this.compA, b: this.compB };
    this.bindTarget(main.a);
    const [pr, pg, pb] = hexToRgb(this.paper);
    this.clear(pr, pg, pb, 1);
    main = this.compositeNodes(this.tree, main, grid, 0);
    this.compA = main.a;
    this.compB = main.b;
    this.settlePreview(grid);

    // 4. Present with dither.
    this.bindTarget(null);
    gl.disable(gl.BLEND);
    const p = this.progs.present;
    gl.useProgram(p.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.compA.tex);
    gl.uniform1i(p.u.uTex, 0);
    gl.uniform1f(p.u.uDither, this.precision === 16 ? 1 : 0);
    this.quad(p, null, [0, 0, this.canvas.width, this.canvas.height]);

    gl.flush();
    this.evictTiles(ranges, ranges.reduce((n, r) => n + area(r), 0));
    this.lastPending = pending;
    if (pending) this.invalidate();
    else if (this.tail > 0 && !this.raf) this.raf = requestAnimationFrame(() => this.render());
  }

  /** Strokes in progress on a layer (or on a layer mask key), in commit order. */
  private livesFor(key: string): Live[] {
    return [...this.live.values()]
      .filter((l) => l.layerId === key && l.target)
      .sort((a, b) => (a.commitSeq ?? Infinity) - (b.commitSeq ?? Infinity) || a.started - b.started);
  }

  /**
   * Composites sibling layers (bottom to top) onto `pair.a`. A layer with clipped layers right above
   * it is the base of a clipping group: the group draws in its own buffer, each clipped layer only
   * where the base has alpha ("atop"), then goes onto the composite with the base's blend and
   * opacity. `depth` picks the buffers, so groups inside groups do not share them.
   */
  private compositeNodes(nodes: LayerNode[], pair: Pair, g: Grid, depth: number): Pair {
    const list = nodes.filter((n) => n.layer.visible);
    for (let i = 0; i < list.length; ) {
      const base = list[i];
      let j = i + 1;
      while (j < list.length && list[j].layer.clip) j++;
      const clipped = list.slice(i + 1, j);
      if (clipped.length === 0 || base.layer.kind === 'adjust') {
        // Nothing clips to this layer, or it has no pixels to clip to: each layer on its own.
        pair = this.compositeNode(base, pair, g, false, depth);
        for (const c of clipped) pair = this.compositeNode(c, pair, g, false, depth);
      } else {
        const gl = this.gl;
        let group: Pair = { a: this.screen(`clipA${depth}`), b: this.screen(`clipB${depth}`) };
        const src = this.nodePixels(base, g, depth);
        this.bindTarget(group.a);
        gl.disable(gl.BLEND);
        this.copy(src.tex, group.a, [0, 0, group.a.w, group.a.h]);
        for (const c of clipped) group = this.compositeNode(c, group, g, true, depth);
        pair = this.blendOnto(group.a, base.layer.blend, base.layer.opacity, pair, false);
      }
      i = j;
    }
    return pair;
  }

  /** One layer or group onto `pair.a` (`atop`: only where `pair.a` has alpha, for clipping). */
  private compositeNode(node: LayerNode, pair: Pair, g: Grid, atop: boolean, depth: number): Pair {
    const l = node.layer;
    if (this.preview?.id === l.id) return this.drawPreview(node, pair, g, atop, depth);
    if (l.kind !== 'group') return this.compositeLayer(l, pair, g, atop);
    if (l.blend === 'pass' && !atop) {
      // Pass through: the group's layers blend straight onto what is below, as if not grouped.
      if (l.opacity >= 1) return this.compositeNodes(node.children, pair, g, depth + 1);
      // With less opacity: composite them, then mix the result with the backdrop by the opacity.
      const gl = this.gl;
      const save = this.screen(`pass${depth}`);
      this.bindTarget(save);
      gl.disable(gl.BLEND);
      this.copy(pair.a.tex, save, [0, 0, save.w, save.h]);
      pair = this.compositeNodes(node.children, pair, g, depth + 1);
      this.bindTarget(pair.a);
      this.blendFor(false);
      this.copy(save.tex, pair.a, [0, 0, pair.a.w, pair.a.h], 1 - l.opacity);
      return pair;
    }
    return this.blendOnto(this.renderGroup(node, g, depth), l.blend, l.opacity, pair, atop);
  }

  /** An isolated group: its layers composited onto a clear buffer. Returns that buffer. */
  private renderGroup(node: LayerNode, g: Grid, depth: number): Target {
    let p: Pair = { a: this.screen(`isoA${depth}`), b: this.screen(`isoB${depth}`) };
    this.bindTarget(p.a);
    this.clear();
    p = this.compositeNodes(node.children, p, g, depth + 1);
    return p.a;
  }

  /** A layer's or group's own pixels, before its blend and opacity. */
  private nodePixels(node: LayerNode, g: Grid, depth: number): Target {
    if (node.layer.kind === 'group') return this.renderGroup(node, g, depth);
    this.renderLayer(node.layer, g);
    return this.layerT;
  }

  // --- transform preview ----------------------------------------------------------------------

  /**
   * Draws the layer or group `p.id` moved by the world transform `p.m`, instead of its tiles, until
   * cleared: the live preview of a transform. The first frame keeps a copy of what the layer
   * shows on screen; later frames draw that copy through the transform (fast, so dragging the
   * handles stays smooth; parts that were off screen are missing until the transform is applied).
   * Null clears it.
   */
  setTransformPreview(p: { id: string; m: Affine } | null): void {
    const old = this.preview;
    if (p && old && old.id === p.id && !old.settle) old.m = p.m;
    else {
      this.dropPreview();
      if (p) this.preview = { id: p.id, m: p.m, settle: false, settleAt: 0, snap: null, capture: null };
    }
    this.invalidate();
  }

  /**
   * The transform is applied (its strokes changed): keep the preview until the tiles of the
   * layer show the new strokes, so the layer does not flash back to where it was.
   */
  settleTransformPreview(): void {
    if (!this.preview) return;
    this.preview.settle = true;
    this.preview.settleAt = performance.now();
    this.invalidate();
  }

  private dropPreview(): void {
    if (this.preview?.snap) this.freeTarget(this.preview.snap);
    this.preview = null;
  }

  private drawPreview(node: LayerNode, pair: Pair, g: Grid, atop: boolean, depth: number): Pair {
    const pv = this.preview!;
    const gl = this.gl;
    if (pv.snap && (pv.snap.w !== this.canvas.width || pv.snap.h !== this.canvas.height)) {
      this.freeTarget(pv.snap);
      pv.snap = null;
    }
    if (!pv.snap) {
      if (pv.settle) {
        // The screen changed size after the transform was applied: the tiles are right now.
        this.dropPreview();
        return this.compositeNode(node, pair, g, atop, depth);
      }
      const src = this.nodePixels(node, g, depth);
      pv.snap = this.makeTarget(src.w, src.h);
      this.bindTarget(pv.snap);
      gl.disable(gl.BLEND);
      this.copy(src.tex, pv.snap, [0, 0, src.w, src.h]);
      pv.capture = { x: this.view.x, y: this.view.y, ds: this.view.zoom * this.dpr };
    }
    // Device pixels now ← world ← device pixels at capture time.
    const c = pv.capture!;
    const ds = this.view.zoom * this.dpr;
    const toNow: Affine = [ds, 0, 0, ds, -this.view.x * ds, -this.view.y * ds];
    const fromCapture: Affine = [1 / c.ds, 0, 0, 1 / c.ds, c.x, c.y];
    const S = compose(toNow, compose(pv.m, fromCapture));
    const t = this.screen(`xform${depth}`);
    this.bindTarget(t);
    this.clear();
    gl.disable(gl.BLEND);
    const p = this.progs.xform;
    gl.useProgram(p.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, pv.snap.tex);
    gl.uniform1i(p.u.uTex, 0);
    gl.uniform1f(p.u.uOpacity, 1);
    gl.uniformMatrix3fv(p.u.uM, false, [S[0], S[1], 0, S[2], S[3], 0, S[4], S[5], 1]);
    gl.uniform2f(p.u.uSrcSize, pv.snap.w, pv.snap.h);
    gl.uniform2f(p.u.uTarget, t.w, t.h);
    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    const blend = node.layer.kind === 'group' && node.layer.blend === 'pass' ? 'normal' : node.layer.blend;
    return this.blendOnto(t, blend, node.layer.kind === 'adjust' ? 1 : node.layer.opacity, pair, atop);
  }

  /** After a frame: a settling preview ends once every tile of the layer in view is current. */
  private settlePreview(g: Grid): void {
    const pv = this.preview;
    if (!pv?.settle) return;
    let done = performance.now() - pv.settleAt > 4000;
    if (!done) {
      const ids = subtreeIds(this.layers, pv.id);
      const keys: string[] = [];
      for (const l of this.layers) {
        if (!ids.has(l.id)) continue;
        if (l.kind === 'paint' || l.kind === undefined) keys.push(l.id);
        if (l.mask?.enabled) keys.push(maskKey(l.id, l.mask.id));
      }
      done = true;
      outer: for (const key of keys)
        for (let ty = g.ty0; ty <= g.ty1; ty++)
          for (let tx = g.tx0; tx <= g.tx1; tx++) {
            const t = this.tiles.get(tileKey(key, g.lod, tx, ty));
            if (t ? !t.rendered || this.needsWork(t) : this.index.byLayer.get(key)?.length) {
              done = false;
              break outer;
            }
          }
    }
    if (done) {
      this.dropPreview();
      this.invalidate();
    }
  }

  /** Draws one layer onto `pair.a`. Returns the pair with the result in `a`. */
  private compositeLayer(layer: Layer, pair: Pair, g: Grid, atop: boolean): Pair {
    if (layer.kind === 'adjust') return this.applyAdjust(layer, pair, g);
    const mode = BLEND_MODES.indexOf(modeOf(layer.blend));
    if (mode <= 0 && !atop && !layer.mask?.enabled && this.livesFor(layer.id).length === 0) {
      // Normal layer, no mask, nothing in progress: tiles go straight onto the composite.
      this.bindTarget(pair.a);
      this.blendFor(false);
      this.drawLayerTiles(layer.id, g.lod, g.tx0, g.ty0, g.tx1, g.ty1, g.X, g.Y, pair.a, layer.opacity);
      return pair;
    }
    this.renderLayer(layer, g);
    return this.blendOnto(this.layerT, layer.blend, layer.opacity, pair, atop);
  }

  /** Blends a screen-sized buffer onto `pair.a` with a blend mode and opacity. */
  private blendOnto(src: Target, blend: LayerBlend, opacity: number, pair: Pair, atop: boolean): Pair {
    const gl = this.gl;
    const mode = BLEND_MODES.indexOf(modeOf(blend));
    if (mode <= 0 && !atop) {
      this.bindTarget(pair.a);
      this.blendFor(false);
      this.copy(src.tex, pair.a, [0, 0, pair.a.w, pair.a.h], opacity);
      return pair;
    }
    this.bindTarget(pair.b);
    gl.disable(gl.BLEND);
    const p = this.progs.blend;
    gl.useProgram(p.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, pair.a.tex);
    gl.uniform1i(p.u.uBack, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.uniform1i(p.u.uLayer, 1);
    gl.uniform1f(p.u.uOpacity, opacity);
    gl.uniform1i(p.u.uMode, Math.max(0, mode));
    gl.uniform1i(p.u.uAtop, atop ? 1 : 0);
    this.quad(p, pair.b, [0, 0, pair.b.w, pair.b.h]);
    gl.activeTexture(gl.TEXTURE0);
    return { a: pair.b, b: pair.a };
  }

  /** A layer's pixels, with its strokes in progress and its mask, into layerT (opacity 1). */
  private renderLayer(layer: Layer, g: Grid): void {
    const gl = this.gl;
    this.bindTarget(this.layerT);
    this.clear();
    gl.disable(gl.BLEND);
    this.drawLayerTiles(layer.id, g.lod, g.tx0, g.ty0, g.tx1, g.ty1, g.X, g.Y, this.layerT, 1);
    for (const l of this.livesFor(layer.id)) {
      this.blendFor(l.brush.tool === 'erase');
      this.copy(l.target!.tex, this.layerT, [0, 0, this.layerT.w, this.layerT.h], l.brush.opacity);
    }
    if (!layer.mask?.enabled) return;
    const mask = this.renderMask(layer, g);
    // Multiply the layer by the mask visibility: dst * (1 - src.a), src.a = 1 - visibility.
    this.bindTarget(this.layerT);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
    const p = this.progs.mask;
    gl.useProgram(p.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, mask.tex);
    gl.uniform1i(p.u.uMask, 0);
    this.quad(p, this.layerT, [0, 0, this.layerT.w, this.layerT.h]);
  }

  /** The grey mask paint of a layer (tiles and strokes in progress) in the mask buffer. */
  private renderMask(layer: Layer, g: Grid): Target {
    const gl = this.gl;
    const key = maskKey(layer.id, layer.mask!.id);
    const t = this.screen('mask');
    this.bindTarget(t);
    this.clear();
    gl.disable(gl.BLEND);
    this.drawLayerTiles(key, g.lod, g.tx0, g.ty0, g.tx1, g.ty1, g.X, g.Y, t, 1);
    for (const l of this.livesFor(key)) {
      this.blendFor(l.brush.tool === 'erase');
      this.copy(l.target!.tex, t, [0, 0, t.w, t.h], l.brush.opacity);
    }
    return t;
  }

  /** Tone lookup texture of an adjustment layer, rebuilt when its settings change. */
  private lutFor(layer: Layer): WebGLTexture {
    const gl = this.gl;
    const key = JSON.stringify(layer.adjust);
    let e = this.luts.get(layer.id);
    if (e?.key === key) return e.tex;
    if (!e) {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.luts.set(layer.id, (e = { key: '', tex }));
    }
    gl.bindTexture(gl.TEXTURE_2D, e.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, LUT_SIZE, 1, 0, gl.RED, gl.FLOAT, toneLut(layer.adjust!));
    e.key = key;
    return e.tex;
  }

  /** An adjustment layer: changes everything in `pair.a`, by its opacity and mask. */
  private applyAdjust(layer: Layer, pair: Pair, g: Grid): Pair {
    const a = layer.adjust;
    if (!a || layer.opacity <= 0) return pair;
    const gl = this.gl;
    const mask = layer.mask?.enabled ? this.renderMask(layer, g) : null;
    const lut = a.type === 'hueSat' ? null : this.lutFor(layer);
    this.bindTarget(pair.b);
    gl.disable(gl.BLEND);
    const p = this.progs.adjust;
    gl.useProgram(p.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, pair.a.tex);
    gl.uniform1i(p.u.uBack, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, lut ?? pair.a.tex);
    gl.uniform1i(p.u.uLut, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, mask ? mask.tex : pair.a.tex);
    gl.uniform1i(p.u.uMask, 2);
    gl.uniform1i(p.u.uMaskOn, mask ? 1 : 0);
    gl.uniform1i(p.u.uType, a.type === 'hueSat' ? 1 : 0);
    if (a.type === 'hueSat') gl.uniform3f(p.u.uHsl, a.hue / 360, a.saturation, a.lightness);
    gl.uniform1f(p.u.uOpacity, layer.opacity);
    this.quad(p, pair.b, [0, 0, pair.b.w, pair.b.h]);
    gl.activeTexture(gl.TEXTURE0);
    return { a: pair.b, b: pair.a };
  }

  private drawLayerTiles(
    layer: string,
    lod: number,
    tx0: number,
    ty0: number,
    tx1: number,
    ty1: number,
    X: (tx: number) => number,
    Y: (ty: number) => number,
    target: Target,
    opacity: number,
  ): void {
    for (let ty = ty0; ty <= ty1; ty++) {
      const y0 = Y(ty), y1 = Y(ty + 1);
      for (let tx = tx0; tx <= tx1; tx++) {
        const x0 = X(tx), x1 = X(tx + 1);
        this.drawTile(layer, lod, tx, ty, target, [x0, y0, x1 - x0, y1 - y0], opacity);
      }
    }
  }

  private drawTile(layer: string, lod: number, tx: number, ty: number, target: Target, dst: [number, number, number, number], opacity: number): void {
    const own = this.tiles.get(tileKey(layer, lod, tx, ty));
    // A tile that has rendered once is drawn even while stale: no flash during updates.
    if (own?.rendered) {
      own.used = this.frame;
      if (own.target) this.copy(own.target.tex, target, dst, opacity);
      return;
    }
    // Missing: stretch a coarser parent tile while this one renders.
    for (let up = 1; up <= 3 && lod + up <= MAX_LOD; up++) {
      const f = 2 ** up;
      const ptx = Math.floor(tx / f), pty = Math.floor(ty / f);
      const parent = this.tiles.get(tileKey(layer, lod + up, ptx, pty));
      if (!parent?.rendered) continue;
      parent.used = this.frame;
      if (parent.target) {
        const u0 = (tx - ptx * f) / f, v0 = (ty - pty * f) / f;
        this.copy(parent.target.tex, target, dst, opacity, [u0, v0, u0 + 1 / f, v0 + 1 / f]);
      }
      return;
    }
    // Or the four finer children (after a zoom out).
    const hw = dst[2] / 2, hh = dst[3] / 2;
    for (let j = 0; j < 2; j++) {
      for (let i = 0; i < 2; i++) {
        const child = this.tiles.get(tileKey(layer, lod - 1, tx * 2 + i, ty * 2 + j));
        if (!child?.rendered) continue;
        child.used = this.frame;
        if (child.target) this.copy(child.target.tex, target, [dst[0] + i * hw, dst[1] + j * hh, hw, hh], opacity);
      }
    }
  }

  /** Draws new dabs of a stroke in progress, or all of them after a view change. */
  private updateLive(l: Live): void {
    const w = this.canvas.width, h = this.canvas.height;
    if (!l.target) {
      l.target = this.livePool.pop() ?? this.makeTarget(w, h);
      l.viewVersion = -1;
    }
    if (l.viewVersion !== this.viewVersion) {
      this.bindTarget(l.target);
      this.clear();
      l.drawn = 0;
      l.viewVersion = this.viewVersion;
    }
    const total = l.dabs.length / DAB_STRIDE;
    if (l.drawn >= total) return;
    const ds = this.view.zoom * this.dpr;
    this.reserve(total - l.drawn);
    let n = 0;
    for (let i = l.drawn; i < total; i++) {
      const o = i * DAB_STRIDE;
      const d = l.dabs;
      if (this.putDab(n, d[o], d[o + 1], d[o + 2], d[o + 3], d[o + 4], this.view.x, this.view.y, ds, w, h)) n++;
    }
    l.drawn = total;
    this.bindTarget(l.target);
    this.blendFor(false); // erase strokes build a mask; the layer pass applies destination-out
    const grain = l.ox === null ? null : this.grainFor(l.brush, l.ox, l.oy!, this.view.x, this.view.y, ds);
    this.drawDabs(n, l.brush, w, h, grain);
  }

  // --- readback ------------------------------------------------------------------------------------

  sample(cssX: number, cssY: number): string {
    if (this.lost) return '#ffffff';
    const gl = this.gl;
    const x = Math.max(0, Math.min(this.compA.w - 1, Math.floor(cssX * this.dpr)));
    const y = Math.max(0, Math.min(this.compA.h - 1, Math.floor(cssY * this.dpr)));
    this.bindTarget(this.pickT);
    gl.disable(gl.BLEND);
    const u = (x + 0.5) / this.compA.w, v = (y + 0.5) / this.compA.h;
    this.copy(this.compA.tex, this.pickT, [0, 0, 1, 1], 1, [u, v, u, v]);
    const px = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return '#' + [px[0], px[1], px[2]].map((c) => c.toString(16).padStart(2, '0')).join('');
  }

  async exportPng(): Promise<Blob | null> {
    const px = this.readRGBA();
    if (!px) return null;
    const w = this.compA.w, h = this.compA.h;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d')!.putImageData(new ImageData(px, w, h), 0, 0);
    return new Promise((resolve) => c.toBlob(resolve, 'image/png'));
  }
}
