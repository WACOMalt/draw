// WebGL2 renderer. Brush dabs, tiles, strokes in progress and the layer stack all live in
// half-float (RGBA16F) buffers when the device supports it, else RGBA8. Blend modes run in a
// shader. Tiles render on the main thread in small time slices; the GPU does the pixel work.

import { DAB_CHUNK, DAB_STRIDE, DabWalker, brushShape, strokeSeed } from '../../../shared/brush';
import { BLEND_MODES, BRUSH_TIPS, GRAINS, type BlendMode, type Brush, type Layer, type Stroke } from '../../../shared/types';
import { LUT_SIZE, toneLut } from '../adjust';
import type { Renderer, ViewState } from '../renderer';
import { StrokeIndex, intersects, maskKey, strokeDabs, strokeKey, type StrokeRec } from '../strokeIndex';
import { MAX_LOD, TILE, lodFor, tileKey, tileWorld } from '../tiles';
import { GRAIN_SIZE, TIP_SIZE, grainIndex, grainMap, tipIndex, tipMask } from '../tips';
import { createPrograms, type Program, type Programs } from './programs';

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

/** Floats per dab instance on the GPU: cx, cy, rv, a, r, rot. */
const INST = 6;

interface Target {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  w: number;
  h: number;
}

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
const TILE_BUDGET_MS = 6;
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
  private extra = new Map<'mask' | 'groupA' | 'groupB', Target>();
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
  private cleanup: (() => void)[] = [];

  constructor(
    private canvas: HTMLCanvasElement,
    private gl: WebGL2RenderingContext,
  ) {
    this.maxTiles = matchMedia('(pointer: coarse)').matches ? 192 : 512;
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
    const floatOk = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
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
  private screen(name: 'mask' | 'groupA' | 'groupB'): Target {
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
    if (!this.raf) this.raf = requestAnimationFrame(() => this.render());
  }

  // --- document ------------------------------------------------------------------------------

  setLayers(layers: Layer[]): void {
    this.layers = layers;
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
      if (t.layer !== key || t.stale) continue;
      const [x0, y0, x1, y1] = this.tileBounds(t);
      if (!intersects(rec, x0, y0, x1, y1)) continue;
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
    if (rp > HUGE_PX) {
      // Move the center toward the target so the edge stays put but the numbers stay small.
      const tcx = w / 2, tcy = h / 2;
      const dx = tcx - cx, dy = tcy - cy;
      const dist = Math.hypot(dx, dy);
      const inside = rp - dist; // edge distance at the target center
      const ux = dist > 0 ? dx / dist : 1, uy = dist > 0 ? dy / dist : 0;
      rv = HUGE_PX;
      cx = tcx - ux * (rv - inside);
      cy = tcy - uy * (rv - inside);
    }
    const o = i * INST;
    const f = this.inst;
    f[o] = cx;
    f[o + 1] = cy;
    f[o + 2] = rv;
    f[o + 3] = Math.min(1, a);
    f[o + 4] = rp;
    f[o + 5] = rot;
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

  /** Draws n prepared instances into the bound target. The caller sets the blend state. */
  private drawDabs(n: number, brush: Brush, w: number, h: number, grain: [number, number, number] | null): void {
    if (n === 0) return;
    const gl = this.gl;
    const p = this.progs.dab;
    gl.useProgram(p.prog);
    gl.uniform2f(p.u.uTarget, w, h);
    const [r, g, b] = hexToRgb(brush.color);
    gl.uniform3f(p.u.uColor, r, g, b);
    gl.uniform1f(p.u.uHardness, brush.hardness);
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

  /** Draws one stroke into a tile target. */
  private drawStroke(target: Target, rec: StrokeRec, wx0: number, wy0: number, scale: number): void {
    const b = rec.stroke.brush;
    const w = target.w, h = target.h;
    let n = 0;
    const sw = (rec.x1 - rec.x0) * scale;
    const sh = (rec.y1 - rec.y0) * scale;
    if (sw < 2 && sh < 2) {
      // The whole stroke covers about one pixel here: one dot instead of every dab.
      this.reserve(1);
      const r = Math.max(rec.x1 - rec.x0, rec.y1 - rec.y0) / 2;
      if (this.putDab(0, (rec.x0 + rec.x1) / 2, (rec.y0 + rec.y1) / 2, r, 1, 0, wx0, wy0, scale, w, h)) n = 1;
    } else {
      const { dabs, chunks, count } = strokeDabs(rec);
      const wx1 = wx0 + w / scale, wy1 = wy0 + h / scale;
      this.reserve(count);
      for (let c = 0; c * DAB_CHUNK < count; c++) {
        const co = c * 4;
        if (chunks[co + 2] <= wx0 || chunks[co] >= wx1 || chunks[co + 3] <= wy0 || chunks[co + 1] >= wy1) continue;
        const end = Math.min(count, (c + 1) * DAB_CHUNK);
        for (let i = c * DAB_CHUNK; i < end; i++) {
          const o = i * DAB_STRIDE;
          if (this.putDab(n, dabs[o], dabs[o + 1], dabs[o + 2], dabs[o + 3], dabs[o + 4], wx0, wy0, scale, w, h)) n++;
        }
      }
    }
    if (n === 0) return;
    const erase = b.tool === 'erase';
    // The one-dot shortcut has no tip, rotation or grain: it stands for a whole tiny stroke.
    const dot = sw < 2 && sh < 2;
    const brush = dot ? { ...b, tip: undefined, roundness: undefined } : b;
    const grain = dot ? null : this.grainFor(b, rec.stroke.pts[0], rec.stroke.pts[1], wx0, wy0, scale);
    if (b.opacity >= 1) {
      // Source-over and destination-out are associative: at full opacity the dabs can go
      // straight onto the tile with the same result as a separate stroke buffer.
      this.bindTarget(target);
      this.blendFor(erase);
      this.drawDabs(n, brush, w, h, grain);
    } else {
      this.bindTarget(this.strokeT);
      this.clear();
      this.blendFor(false);
      this.drawDabs(n, brush, w, h, grain);
      this.bindTarget(target);
      this.blendFor(erase);
      this.copy(this.strokeT.tex, target, [0, 0, w, h], b.opacity);
    }
  }

  /** Brings one tile up to date. Full render when stale or new, else draws appended strokes. */
  private renderTile(t: Tile): void {
    const [wx0, wy0, wx1, wy1] = this.tileBounds(t);
    const scale = TILE / (wx1 - wx0);
    if (t.stale) {
      const list = (this.index.byLayer.get(t.layer) ?? []).filter((r) => intersects(r, wx0, wy0, wx1, wy1));
      if (list.length === 0) {
        if (t.target) this.tilePool.push(t.target);
        t.target = null;
      } else {
        t.target ??= this.allocTile();
        this.bindTarget(t.target);
        this.clear();
        for (const rec of list) this.drawStroke(t.target, rec, wx0, wy0, scale);
      }
    } else {
      if (!t.target) {
        t.target = this.allocTile();
        this.bindTarget(t.target);
        this.clear();
      }
      for (const rec of t.append) this.drawStroke(t.target, rec, wx0, wy0, scale);
    }
    t.stale = false;
    t.append = [];
    t.maxSeq = this.index.topSeq(t.layer);
    t.rendered = true;
  }

  private needsWork(t: Tile | undefined): boolean {
    return !t || t.stale || t.append.length > 0;
  }

  private evictTiles(): void {
    let count = 0;
    for (const t of this.tiles.values()) if (t.target) count++;
    if (count <= this.maxTiles && this.tiles.size <= 20000) return;
    const old = [...this.tiles.entries()].filter(([, t]) => t.used < this.frame).sort((a, b) => a[1].used - b[1].used);
    for (const [key, t] of old) {
      if (count <= this.maxTiles * 0.85 && this.tiles.size <= 16000) break;
      if (t.target) {
        if (this.tilePool.length < 32) this.tilePool.push(t.target);
        else this.freeTarget(t.target);
        count--;
      }
      this.tiles.delete(key);
    }
  }

  // --- frame ---------------------------------------------------------------------------------------

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
    const visible = this.layers.filter((l) => l.visible && !l.deleted);
    // Tile sets to keep current, topmost first: each paint layer, and each enabled layer mask.
    const keys: string[] = [];
    for (let li = visible.length - 1; li >= 0; li--) {
      const l = visible[li];
      if (l.kind !== 'adjust') keys.push(l.id);
      if (l.mask?.enabled) keys.push(maskKey(l.id, l.mask.id));
    }

    // 1. Bring tiles up to date, center first, within a time budget.
    const start = performance.now();
    let pending = false;
    const cx = (tx0 + tx1) / 2, cy = (ty0 + ty1) / 2;
    const order: [number, number][] = [];
    for (let ty = ty0 - PREFETCH; ty <= ty1 + PREFETCH; ty++)
      for (let tx = tx0 - PREFETCH; tx <= tx1 + PREFETCH; tx++) order.push([tx, ty]);
    order.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy));
    outer: for (const [tx, ty] of order) {
      for (const layer of keys) {
        const key = tileKey(layer, lod, tx, ty);
        let t = this.tiles.get(key);
        if (!this.needsWork(t)) continue;
        if (performance.now() - start > TILE_BUDGET_MS) {
          pending = true;
          break outer;
        }
        if (!t) {
          t = { layer, lod, tx, ty, target: null, stale: true, append: [], maxSeq: -1, rendered: false, used: this.frame };
          this.tiles.set(key, t);
        }
        t.used = this.frame;
        this.renderTile(t);
      }
    }
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
    for (let i = 0; i < visible.length; ) {
      const base = visible[i];
      let j = i + 1;
      while (j < visible.length && visible[j].clip) j++;
      const clipped = visible.slice(i + 1, j);
      if (clipped.length === 0 || base.kind === 'adjust') {
        // Nothing clips to this layer, or it has no pixels to clip to: each layer on its own.
        main = this.compositeLayer(base, main, grid, false);
        for (const c of clipped) main = this.compositeLayer(c, main, grid, false);
      } else {
        let group: Pair = { a: this.screen('groupA'), b: this.screen('groupB') };
        this.renderLayer(base, grid);
        this.bindTarget(group.a);
        gl.disable(gl.BLEND);
        this.copy(this.layerT.tex, group.a, [0, 0, group.a.w, group.a.h]);
        for (const c of clipped) group = this.compositeLayer(c, group, grid, true);
        main = this.blendOnto(group.a, base.blend, base.opacity, main, false);
      }
      i = j;
    }
    this.compA = main.a;
    this.compB = main.b;

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
    this.evictTiles();
    if (pending) this.invalidate();
    else if (this.tail > 0 && !this.raf) this.raf = requestAnimationFrame(() => this.render());
  }

  /** Strokes in progress on a layer (or on a layer mask key), in commit order. */
  private livesFor(key: string): Live[] {
    return [...this.live.values()]
      .filter((l) => l.layerId === key && l.target)
      .sort((a, b) => (a.commitSeq ?? Infinity) - (b.commitSeq ?? Infinity) || a.started - b.started);
  }

  /** Draws one layer onto `pair.a`. Returns the pair with the result in `a`. */
  private compositeLayer(layer: Layer, pair: Pair, g: Grid, atop: boolean): Pair {
    if (layer.kind === 'adjust') return this.applyAdjust(layer, pair, g);
    const mode = BLEND_MODES.indexOf(layer.blend);
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
  private blendOnto(src: Target, blend: BlendMode, opacity: number, pair: Pair, atop: boolean): Pair {
    const gl = this.gl;
    const mode = BLEND_MODES.indexOf(blend);
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
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d')!.putImageData(new ImageData(px, w, h), 0, 0);
    return new Promise((resolve) => c.toBlob(resolve, 'image/png'));
  }
}
