// WebGL2 renderer. Brush dabs, tiles, strokes in progress and the layer stack all live in
// half-float (RGBA16F) buffers when the device supports it, else RGBA8. Blend modes run in a
// shader. Tiles render on the main thread in small time slices; the GPU does the pixel work.

import { DAB_CHUNK, DAB_STRIDE, DabWalker, brushShape, lowFlow, strokeSeed } from '../../../shared/brush';
import { BLEND_MODES, BRUSH_TIPS, EFFECT_TYPES, GRAINS, LIMITS, type Affine, type Affine3, type Brush, type Layer, type LayerBlend, type LayerEffect, type MixMode, type Paper, type Shape, type Stroke, DEFAULT_PAPER } from '../../../shared/types';
import { kaleidoscopeCopies, kaleidoscopeCopies3, kaleidoscopeTilts, takesEffects } from '../../../shared/effects';
import { MARGIN, blurLevel, kernel } from '../blur';
import { byZ } from '../../../shared/shapes';
import { compose, effectivelyVisible, invert, layerTree, subtreeIds, transformStroke3, type LayerNode } from '../../../shared/layers';
import { LUT_SIZE, toneLut } from '../adjust';
import type { Renderer, ViewState } from '../renderer';
import { StrokeIndex, intersects, maskKey, strokeDabs, strokeKey, type StrokeRec } from '../strokeIndex';
import { MAX_LOD, TILE, lodFor, tileKey, tileWorld } from '../tiles';
import { GRAIN_SIZE, TIP_SIZE, grainIndex, grainMap, tipIndex, tipMask } from '../tips';
import { createPrograms, type Program, type Programs } from './programs';
import { perfProfile, type PerfProfile } from '../perf';
import { ShapeIndex, shapeRec, shapeTouches, type ShapeRec } from '../shapeIndex';
import { drawShapes } from '../shapeRaster';
import { vectorShape } from '../../../shared/flatten';

/** Two screen buffers: `a` holds the composite so far, `b` receives the next blend pass. */
interface Pair {
  a: Target;
  b: Target;
}

/**
 * A frame to composite into: the screen, or an effect frame (a blur source at a coarser level,
 * with a margin around the view; see fxGrid). Its tiles, where they go, and its buffers.
 */
interface Grid {
  lod: number;
  tx0: number;
  ty0: number;
  tx1: number;
  ty1: number;
  X: (tx: number) => number;
  Y: (ty: number) => number;
  /** Buffer size in px, and the prefix of the buffer names ('' for the screen frame). */
  w: number;
  h: number;
  ns: string;
  /** The world point at px (0, 0), and px per world unit. */
  wx: number;
  wy: number;
  s: number;
}

/** A world rectangle. */
interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const apply = (m: Affine, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/**
 * A tilted kaleidoscope's copies (GLRenderer.tilted): the step's copies, the paint layers whose
 * strokes it copies, and whether the copies go into those layers' own tiles (`merged`).
 */
interface Tilted {
  sig: string;
  copies: Affine3[];
  members: Set<string>;
  merged: boolean;
  behind: boolean;
}
/** Merged copies: copy i of a stroke draws after (in front) or before (behind) every stroke of copy i - 1. */
const COPY_SEQ = 1e12;
/** A stroke's copy i for the tilted kaleidoscope of `node` (GLRenderer.tilted). */
const copyId = (id: string, node: string, i: number) => `${id}@${node}:${i}`;
/** The layer of such copies: the layer's id with the node and the copy. */
const copyKey = (layer: string, node: string, i: number) => `${layer}@${node}:${i}`;

/** Thrown to end the backdrop render of a blur adjustment layer when it reaches that layer. */
const STOP = Symbol('stop');

/** The enabled effects of a paint or shape layer, in the order they draw. */
function activeEffects(l: Layer): LayerEffect[] {
  if (!l.effects?.length || !takesEffects(l.kind)) return [];
  return EFFECT_TYPES.map((t) => l.effects!.find((e) => e.type === t && e.enabled)).filter(
    (e): e is LayerEffect => !!e && (e.type === 'kaleidoscope' ? (e.count ?? 0) >= 1 : e.type !== 'blur' || e.radius > 0),
  );
}

/** The blur an effect needs: glows and the shadow come from the blurred layer when it has a blur. */
function effectSigma(e: LayerEffect, fx: LayerEffect[]): number {
  if (e.type === 'blur') return e.radius;
  return Math.hypot(e.radius, fx.find((x) => x.type === 'blur')?.radius ?? 0);
}

/**
 * Floats per dab instance on the GPU: cx, cy, rv, a, r, cos and sin of the rotation, then r, g,
 * b, hardness (paintDabs), then the data of a huge dab (putDab): D, true center x, y, w x, y, b.
 * Color and hardness per dab let a run of strokes share one draw call (drawStrokes).
 */
const INST = 17;
/** Most kaleidoscope frames shared by the copies at one level of detail, per kaleidoscope. */
const LEVEL_FRAMES = 4;
/** Most frame buffers kept for reuse (see putSpare). */
const SPARE = 24;
/** Most dabs in one batched draw call. */
const MAX_BATCH = 65536;

/**
 * A 3D transform not applied yet (setStrokePreview): the strokes of these keys (layers and layer
 * masks) draw from these records, moved, instead of from their tiles. `settle`: applied, shown
 * until the tiles show the moved strokes.
 */
interface StrokePreview {
  byKey: Map<string, StrokeRec[]>;
  settle: boolean;
  settleAt: number;
}

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
  /** Its tiles were not all drawn yet at the capture: capture again next frame. */
  partial?: boolean;
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

/**
 * A shape layer being edited (it has drafts, or they just ended): drawn straight to the screen
 * each frame instead of from its tiles, so a drag shows at once. `rect`: where the buffer goes
 * on the screen (device px); null: nothing of the layer is on screen.
 */
interface Hot {
  tex: WebGLTexture;
  rect: [number, number, number, number] | null;
  /** draftVersion and viewVersion the buffer shows. */
  version: number;
  viewVersion: number;
  /** The drafts ended at this time: the buffer stays until the tiles are current. */
  settleAt: number | null;
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
/** Radius in px above which the shader gets the edge of a dab relative to the target (putDab). */
const HUGE_PX = 1e6;
const MAX_APPEND = 64;
/** The most of a frame's fill a tile still rendering from earlier frames gets (tileShare). */
const HEAVY_SHARE = 0.5;
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
  /** The bottom of the stack. Where its alpha is below 1, the screen shows a checkerboard. */
  private paper: Paper = { ...DEFAULT_PAPER };
  /** Exports with a transparent background: the stack starts empty instead of with the paper. */
  transparent = false;
  /** One frame for the eyedropper: no paper, no present. */
  private pickPass = false;

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
  private strokeT!: Target; // tile-sized buffer for strokes with opacity < 1
  /** Tile-sized buffer for a pigment mix (pigmentOnto). */
  private mixT!: Target;
  /** How paint strokes mix with the paint below (setMix). */
  private mix: MixMode = 'normal';
  private pickT!: Target;
  /** Screen buffers made only when a frame needs them: layer masks and clipping groups. */
  /** Screen-sized buffers some frames need (masks, clipping and group buffers per depth). */
  private extra = new Map<string, Target>();
  /** Screen-frame buffers no longer in use, by size, for the next buffer of that size (see screen). */
  private spare = new Map<string, Target[]>();
  /**
   * Tiles a frame drew that were missing or out of date and that no range covers (kaleidoscope
   * frames): the next frame renders them (render, step 1), coarse ones first.
   */
  private wanted = new Map<string, { layer: string; lod: number; tx: number; ty: number }>();
  /**
   * Kaleidoscopes whose step tilts (kaleidoscopeTilts) on a 3D layer, or on a group whose paint
   * layers are all 3D: a picture moved in the paper cannot show a tilt, so their copies come from
   * the strokes, moved in 3D and seen straight on. By the layer or group: the copies' 3D
   * transforms, the 3D layers whose strokes it copies, and the step's signature. The copied
   * strokes live in the index like any (copyId, copyKey), and keep up with their originals.
   */
  private tilted = new Map<string, Tilted>();
  /** While a tilted kaleidoscope copy renders: its members' layer and mask keys → the copy's. */
  private keyMap: ((key: string) => string) | null = null;
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
  private shapes = new ShapeIndex();
  /** Ids of the shape layers: their tiles draw shapes, not strokes. */
  private shapeLayers = new Set<string>();
  /** Shapes being changed, by who changes them ('local' or a peer): they replace committed ones. */
  private drafts = new Map<string, Map<string, Shape>>();
  private draftVersion = 0;
  private hot = new Map<string, Hot>();
  /** Canvas where shapes are drawn before they go to a tile texture (made on first use). */
  private shapeCanvas: OffscreenCanvas | null = null;
  /** Canvas for the screen buffers of hot layers (one at a time). */
  private hotCanvas: OffscreenCanvas | null = null;
  private shapeTex!: WebGLTexture;
  private layers: Layer[] = [];
  /** The layer tree of `layers` (groups with their layers), and the layers by id. */
  private tree: LayerNode[] = [];
  private byId = new Map<string, Layer>();
  /** A layer or group drawn moved by a transform that is not applied yet (see setTransformPreview). */
  /** Transform previews, by layer or group (setTransformPreviews). */
  private previews = new Map<string, TransformPreview>();
  private strokePreview: StrokePreview | null = null;
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
  /**
   * Offline: the most time one render() spends on tiles (ms) before it returns with work left,
   * so a caller can let the page paint between calls (the export, renderAsync). Infinity: all at once.
   */
  offlineSlice = Infinity;
  /**
   * Offline in slices: also the GPU work (fill, as `fill` on screen) of one slice. A slice of a
   * few ms of JavaScript can queue seconds of GPU work, and the screen's frames wait for it.
   */
  offlineFill = Infinity;
  /** Tiles drawn so far (a count for progress). */
  tilesDrawn = 0;
  /** How long the last frame's compositing took (ms; JavaScript time, the GPU may add to it). */
  private compositeMs = 0;
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
    gl.vertexAttribPointer(3, 2, gl.FLOAT, false, stride, 20);
    gl.vertexAttribDivisor(3, 1);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 4, gl.FLOAT, false, stride, 28);
    gl.vertexAttribDivisor(4, 1);
    gl.enableVertexAttribArray(5);
    gl.vertexAttribPointer(5, 3, gl.FLOAT, false, stride, 44);
    gl.vertexAttribDivisor(5, 1);
    gl.enableVertexAttribArray(6);
    gl.vertexAttribPointer(6, 3, gl.FLOAT, false, stride, 56);
    gl.vertexAttribDivisor(6, 1);
    gl.bindVertexArray(null);

    // Tips and grains upload on first use (tips.ts generates them on the CPU).
    this.tipTex = this.makeArray(TIP_SIZE, BRUSH_TIPS.length, false);
    this.grainTex = this.makeArray(GRAIN_SIZE, GRAINS.length, true);
    this.tipsReady.clear();
    this.grainsReady.clear();
    this.luts.clear();

    this.strokeT = this.makeTarget(TILE, TILE);
    this.mixT = this.makeTarget(TILE, TILE);
    this.pickT = this.makeTarget(1, 1, true);
    this.shapeTex = this.makeTexture();
    this.hot.clear();
    this.tilePool = [];
    this.livePool = [];
    // Old textures died with the context: forget every tile, redraw live strokes.
    this.tiles.clear();
    this.previews.clear();
    this.strokePreview = null;
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

  /** An RGBA8 texture that canvases are uploaded into (uploadCanvas). */
  private makeTexture(): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  /**
   * Copies a canvas into a texture (and clears the canvas). Canvas rows go top first, as image
   * space wants. The copy goes through an ImageBitmap: several tiles draw on the same canvas in
   * one frame, and a direct upload of the canvas could get the pixels of a later tile.
   */
  private uploadCanvas(tex: WebGLTexture, c: OffscreenCanvas): void {
    const gl = this.gl;
    const bmp = c.transferToImageBitmap();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // Premultiplied colors, as the buffers here hold.
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    bmp.close();
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

  /** A buffer that only some frames need, made on first use (screen-sized unless w and h say). */
  private screen(name: string, w = this.canvas.width || 1, h = this.canvas.height || 1): Target {
    let t = this.extra.get(name);
    if (t && (t.w !== w || t.h !== h)) {
      // Frames one after the other change size (kaleidoscope copies): keep it for the next one.
      this.putSpare(t);
      t = undefined;
    }
    if (!t) this.extra.set(name, (t = this.spare.get(`${w}x${h}`)?.pop() ?? this.makeTarget(w, h)));
    return t;
  }

  /** At most SPARE buffers wait in `spare`; past that the oldest kind goes. */
  private putSpare(t: Target): void {
    const key = `${t.w}x${t.h}`;
    const list = this.spare.get(key) ?? [];
    this.spare.delete(key);
    list.push(t);
    this.spare.set(key, list);
    let n = 0;
    for (const l of this.spare.values()) n += l.length;
    for (const [k, l] of this.spare) {
      if (n <= SPARE) break;
      for (const x of l) this.freeTarget(x);
      n -= l.length;
      this.spare.delete(k);
    }
  }

  /** A buffer of a frame (the screen, or an effect frame). */
  private buf(g: Grid, name: string): Target {
    return this.screen(g.ns + name, g.w, g.h);
  }

  /** Where the screen (device px) lies in a frame: x, y, w, h in the frame's px. */
  private screenRect(g: Grid): [number, number, number, number] {
    const f = g.s / (this.view.zoom * this.dpr);
    return [(this.view.x - g.wx) * g.s, (this.view.y - g.wy) * g.s, this.canvas.width * f, this.canvas.height * f];
  }

  /** The paper (premultiplied) into the bound buffer; none for a transparent export or a pick. */
  private clearPaper(): void {
    const [pr, pg, pb] = hexToRgb(this.paper.color);
    const pa = this.transparent || this.pickPass ? 0 : this.paper.alpha;
    this.clear(pr * pa, pg * pa, pb * pa, pa);
  }

  private freeTarget(t: Target): void {
    this.gl.deleteFramebuffer(t.fbo);
    this.gl.deleteTexture(t.tex);
  }

  private allocScreenTargets(): void {
    const w = this.canvas.width || 1;
    const h = this.canvas.height || 1;
    for (const t of [this.compA, this.compB]) if (t) this.freeTarget(t);
    for (const t of this.extra.values()) this.freeTarget(t);
    this.extra.clear();
    for (const l of this.spare.values()) for (const t of l) this.freeTarget(t);
    this.spare.clear();
    for (const t of this.livePool) this.freeTarget(t);
    this.livePool = [];
    this.compA = this.makeTarget(w, h);
    this.compB = this.makeTarget(w, h);
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

  /** True during renderNow: a frame out of the animation-frame rhythm (no speed measures). */
  private outOfBand = false;

  renderNow(): void {
    if (this.offline) return;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.dirty = true;
    this.outOfBand = true;
    try {
      this.render();
    } finally {
      this.outOfBand = false;
    }
  }

  /** Offline: brings every tile of the view up to date and composites it. */
  renderSync(): void {
    for (let i = 0; i < 1000; i++) {
      this.render();
      if (!this.lastPending) return;
    }
  }

  /** Offline: one render() (see offlineSlice). True: work is left, call again. */
  renderStep(): boolean {
    this.render();
    return this.lastPending && !this.contextLost();
  }

  /** The graphics context is gone (the GPU reset): nothing renders any more. */
  contextLost(): boolean {
    return this.lost || this.gl.isContextLost();
  }

  /**
   * The composite as 8-bit RGBA, top row first. `alpha`: keep the alpha channel (a transparent
   * export), with the colors un-premultiplied; otherwise the pixels are opaque.
   */
  readRGBA(alpha = false): Uint8ClampedArray<ArrayBuffer> | null {
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
    if (!alpha) {
      // Opaque: over white where the paper is see-through (the colors are premultiplied).
      for (let i = 0; i < px.length; i += 4) {
        const k = 255 - px[i + 3];
        px[i] += k;
        px[i + 1] += k;
        px[i + 2] += k;
        px[i + 3] = 255;
      }
      return px;
    }
    for (let i = 0; i < px.length; i += 4) {
      const a = px[i + 3];
      if (a === 0 || a === 255) continue;
      px[i] = (px[i] * 255) / a;
      px[i + 1] = (px[i + 1] * 255) / a;
      px[i + 2] = (px[i + 2] * 255) / a;
    }
    return px;
  }

  // --- document ------------------------------------------------------------------------------

  setLayers(layers: Layer[]): void {
    this.layers = layers;
    this.tree = layerTree(layers);
    this.byId = new Map(layers.map((l) => [l.id, l]));
    const next = new Set(layers.filter((l) => l.kind === 'shape').map((l) => l.id));
    // A layer that became paint (or shapes again) draws its tiles the other way now.
    for (const t of this.tiles.values()) {
      if (next.has(t.layer) === this.shapeLayers.has(t.layer)) continue;
      if (t.job) this.dropJob(t);
      t.stale = true;
      t.append = [];
    }
    this.shapeLayers = next;
    this.updateTilted();
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
    // The copies of tilted kaleidoscopes went with the index: made again.
    this.tilted.clear();
    this.updateTilted();
    this.appliedSeq = seq;
    this.invalidate();
  }

  addStroke(stroke: Stroke, seq: number): void {
    this.addRec(stroke);
    // An eraser in a layer whose copies are merged: they go back to frames of their own.
    if (stroke.brush.tool === 'erase' && [...this.tilted.values()].some((k) => k.merged && k.members.has(stroke.layerId))) this.updateTilted();
    else for (const [node, k] of this.tilted) if (k.members.has(stroke.layerId)) k.copies.forEach((m, i) => this.addCopy(stroke, node, i, m, k));
    this.appliedSeq = seq;
    this.invalidate();
  }

  /** Puts a stroke in the index; the tiles it touches draw it (on top) or render again. */
  private addRec(stroke: Stroke): void {
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
  }

  removeStroke(id: string, seq: number): void {
    const rec = this.removeRec(id);
    if (rec) for (const [node, k] of this.tilted) if (k.members.has(rec.stroke.layerId)) k.copies.forEach((_, i) => this.removeRec(copyId(id, node, i)));
    // The last eraser of a layer gone: its copies may merge again.
    if (rec?.stroke.brush.tool === 'erase' && [...this.tilted.values()].some((k) => k.members.has(rec.stroke.layerId))) this.updateTilted();
    this.appliedSeq = seq;
    this.invalidate();
  }

  /** Takes a stroke out of the index; the tiles it touched render again. */
  private removeRec(id: string): StrokeRec | null {
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
    return rec;
  }

  // --- tilted kaleidoscopes: copies from the strokes -----------------------------------------------

  /** Brings `tilted` up to date with the layers: copies made, or dropped, where a step changed. */
  private updateTilted(): void {
    const next = new Map<string, Tilted>();
    for (const l of this.layers) {
      const fx = activeEffects(l);
      const e = fx.find((x) => x.type === 'kaleidoscope');
      if (!e || !kaleidoscopeTilts(e)) continue;
      // The paint layers whose strokes it copies; all must be 3D (else the copies are a picture,
      // seen straight on: kaleidoscopeCopies).
      const ids = l.kind === 'group' ? subtreeIds(this.layers, l.id) : new Set([l.id]);
      const members = this.layers.filter((x) => ids.has(x.id) && x.kind !== 'group' && x.kind !== 'adjust');
      if (!members.length || members.some((x) => !x.threed || (x.kind ?? 'paint') !== 'paint')) continue;
      const ms = new Set(members.map((x) => x.id));
      // A layer's copies go into its own tiles (one set of tiles, not one per copy) where that
      // looks the same as copies drawn one over the other: one paint layer, no other effects (a
      // copy's glow or shadow would fall on the copies below), no mask (it would cover the
      // copies' union), no eraser (it would take paint from the copies below), no pigment (the
      // copies would mix as paint).
      const merged =
        l.kind !== 'group' && fx.length === 1 && !l.mask?.enabled && this.mix !== 'pigment' && !(this.index.byLayer.get(l.id) ?? []).some((r) => r.stroke.brush.tool === 'erase');
      const sig = JSON.stringify([e.count, e.turn, e.angle, e.scale, e.cx, e.cy, e.cz, e.dx, e.dy, e.dz, e.order, merged, [...ms].sort()]);
      next.set(l.id, { sig, copies: kaleidoscopeCopies3(e), members: ms, merged, behind: e.order === 'behind' });
    }
    for (const [node, k] of this.tilted) if (next.get(node)?.sig !== k.sig) this.dropCopies(node, k);
    for (const [node, k] of next) {
      if (this.tilted.get(node)?.sig === k.sig) continue;
      for (const id of k.members)
        for (const [key, list] of [...this.index.byLayer]) {
          if (key !== id && !key.startsWith(`${id}#`)) continue;
          // (Not the merged copies already in the list.)
          for (const r of [...list]) if (!r.stroke.id.includes('@')) k.copies.forEach((m, i) => this.addCopy(r.stroke, node, i, m, k));
        }
    }
    this.tilted = next;
  }

  /**
   * Copy i of a stroke for a tilted kaleidoscope of `node`: moved in 3D (none if it cannot be). In
   * a layer of its own for the copy, or merged into the stroke's layer, after (in front) or before
   * (behind) the copies nearer the layer.
   */
  private addCopy(st: Stroke, node: string, i: number, m: Affine3, k: Tilted): void {
    const t = transformStroke3(st, m, LIMITS.maxCoord, [LIMITS.minBrushWorld, LIMITS.maxBrushWorld]);
    if (!t) return;
    if (k.merged) this.addRec({ ...st, ...t, id: copyId(st.id, node, i), seq: st.seq + (k.behind ? -1 : 1) * (i + 1) * COPY_SEQ });
    else this.addRec({ ...st, ...t, id: copyId(st.id, node, i), layerId: copyKey(st.layerId, node, i) });
  }

  /** Drops the copied strokes of a tilted kaleidoscope, and their tiles. */
  private dropCopies(node: string, k: Tilted): void {
    if (k.merged) {
      // In the layers' own lists: out one by one (the tiles they touched draw again).
      const tag = `@${node}:`;
      for (const id of k.members)
        for (const [key, list] of [...this.index.byLayer]) if (key === id || key.startsWith(`${id}#`)) for (const r of [...list]) if (r.stroke.id.includes(tag)) this.removeRec(r.stroke.id);
      return;
    }
    const of = (key: string) => [...k.members].some((id) => key.startsWith(`${id}@${node}:`));
    for (const [key, list] of [...this.index.byLayer]) if (of(key)) for (const r of [...list]) this.index.remove(r.stroke.id);
    for (const [key, t] of [...this.tiles]) {
      if (!of(t.layer)) continue;
      if (t.job) this.dropJob(t);
      if (t.target) this.tilePool.push(t.target);
      this.tiles.delete(key);
    }
  }

  advanceSeq(seq: number): void {
    this.appliedSeq = seq;
    this.invalidate();
  }

  // --- shapes --------------------------------------------------------------------------------

  resetShapes(shapes: Shape[]): void {
    this.shapes.clear();
    for (const s of shapes) this.shapes.put(s);
    for (const t of this.tiles.values()) {
      if (!this.shapeLayers.has(t.layer) && !shapes.some((s) => s.layerId === t.layer)) continue;
      if (t.job) this.dropJob(t);
      t.stale = true;
    }
    this.draftVersion++;
    this.invalidate();
  }

  putShape(shape: Shape, seq: number): void {
    const { old, rec } = this.shapes.put(shape);
    if (old) this.shapeTilesStale(old);
    if (rec) this.shapeTilesStale(rec);
    this.draftVersion++;
    this.appliedSeq = seq;
    this.invalidate();
  }

  removeShape(id: string, seq: number): void {
    const old = this.shapes.remove(id);
    if (old) this.shapeTilesStale(old);
    this.draftVersion++;
    this.appliedSeq = seq;
    this.invalidate();
  }

  setShapeDrafts(owner: string, shapes: Shape[]): void {
    if (shapes.length) this.drafts.set(owner, new Map(shapes.map((s) => [s.id, s])));
    else if (!this.drafts.delete(owner)) return;
    this.draftVersion++;
    this.invalidate();
  }

  /** Marks the tiles of the shape's layer under it for a new render. */
  private shapeTilesStale(rec: ShapeRec): void {
    for (const t of this.tiles.values()) {
      if (t.layer !== rec.shape.layerId) continue;
      const [x0, y0, x1, y1] = this.tileBounds(t);
      if (!shapeTouches(rec, x0, y0, x1, y1, (x1 - x0) / TILE)) continue;
      if (t.job) this.dropJob(t);
      t.stale = true;
      t.append = [];
    }
  }

  /** A layer's shapes as they show now: committed ones, with every draft over them. */
  private liveShapes(layer: string): Shape[] {
    const over = new Map<string, Shape>();
    for (const d of this.drafts.values()) for (const [id, s] of d) over.set(id, s);
    const out: Shape[] = [];
    for (const r of this.shapes.layer(layer)) if (!over.has(r.shape.id)) out.push(r.shape);
    for (const s of over.values()) if (s.layerId === layer && !s.deleted) out.push(s);
    return out.sort(byZ);
  }

  /** Renders a shape layer's tile in one go: shapes on a canvas, then into the tile texture. */
  private renderShapeTile(t: Tile): number {
    const [wx0, wy0, wx1, wy1] = this.tileBounds(t);
    const scale = TILE / (wx1 - wx0);
    const list = this.shapes.layer(t.layer).filter((r) => shapeTouches(r, wx0, wy0, wx1, wy1, 1 / scale));
    if (t.job) this.dropJob(t);
    if (list.length === 0) {
      if (t.target) this.tilePool.push(t.target);
      t.target = null;
      this.finishTile(t);
      return 1000;
    }
    const c = (this.shapeCanvas ??= new OffscreenCanvas(TILE, TILE));
    const ctx = c.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, TILE, TILE);
    drawShapes(ctx, list.map((r) => r.shape), wx0, wy0, scale, TILE, TILE);
    this.uploadCanvas(this.shapeTex, c);
    t.target ??= this.allocTile();
    this.bindTarget(t.target);
    this.gl.disable(this.gl.BLEND);
    this.copy(this.shapeTex, t.target, [0, 0, TILE, TILE]);
    this.finishTile(t);
    return 3 * TILE * TILE + list.length * 2000;
  }

  /**
   * Brings the screen buffers of edited shape layers up to date. A layer is hot while it has
   * drafts, and after they end until its tiles in view are current again (no flash back).
   */
  private updateHot(g: Grid): void {
    const want = new Set<string>();
    for (const d of this.drafts.values()) {
      for (const s of d.values()) {
        want.add(s.layerId);
        const old = this.shapes.recs.get(s.id);
        if (old) want.add(old.shape.layerId);
      }
    }
    const now = performance.now();
    for (const [id, h] of this.hot) {
      if (want.has(id)) {
        h.settleAt = null;
        continue;
      }
      h.settleAt ??= now;
      let done = now - h.settleAt > 3000;
      if (!done) {
        done = true;
        for (let ty = g.ty0; done && ty <= g.ty1; ty++)
          for (let tx = g.tx0; tx <= g.tx1; tx++) {
            const t = this.tiles.get(tileKey(id, g.lod, tx, ty));
            if (!t || !t.rendered || this.needsWork(t)) {
              done = false;
              break;
            }
          }
      }
      if (done) {
        this.gl.deleteTexture(h.tex);
        this.hot.delete(id);
      }
      this.invalidate(); // gone: draw the tiles; else check again next frame
    }
    for (const id of want) {
      if (!this.hot.has(id)) this.hot.set(id, { tex: this.makeTexture(), rect: null, version: -1, viewVersion: -1, settleAt: null });
    }
    const W = this.canvas.width, H = this.canvas.height;
    const ds = this.view.zoom * this.dpr;
    for (const [id, h] of this.hot) {
      if (h.version === this.draftVersion && h.viewVersion === this.viewVersion) continue;
      h.version = this.draftVersion;
      h.viewVersion = this.viewVersion;
      const list = this.liveShapes(id);
      // Only the part of the screen the shapes cover.
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
      const c = (this.hotCanvas ??= new OffscreenCanvas(w, hh));
      if (c.width !== w || c.height !== hh) {
        c.width = w;
        c.height = hh;
      }
      const ctx = c.getContext('2d')!;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, w, hh);
      drawShapes(ctx, list, this.view.x + rx0 / ds, this.view.y + ry0 / ds, ds, w, hh);
      this.uploadCanvas(h.tex, c);
      h.rect = [rx0, ry0, w, hh];
    }
  }

  /**
   * A layer's own content onto `target` (blend state set by the caller): its tiles, or the screen
   * buffer of a shape layer being edited.
   */
  private drawLayerContent(layer: string, g: Grid, target: Target, opacity: number): void {
    if (this.keyMap) layer = this.keyMap(layer);
    const pv = this.strokePreview?.byKey.get(layer);
    if (pv) return this.drawPreviewStrokes(pv, g, target);
    const h = this.hot.get(layer);
    if (h) {
      if (h.rect) {
        // The buffer covers part of the screen: into an effect frame, through the screen's place.
        const [ox, oy, sw] = this.screenRect(g), f = sw / this.canvas.width;
        const [x, y, w, hh] = h.rect;
        this.copy(h.tex, target, [ox + x * f, oy + y * f, w * f, hh * f], opacity);
      }
      return;
    }
    this.drawLayerTiles(layer, g.lod, g.tx0, g.ty0, g.tx1, g.ty1, g.X, g.Y, target, opacity);
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
   * `k`: the roundness of the tip (the shader divides the height by it).
   * Returns false when the dab is culled.
   */
  private putDab(i: number, x: number, y: number, r: number, a: number, rot: number, ox: number, oy: number, scale: number, w: number, h: number, k = 1): boolean {
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
    // In double precision: float32 sin and cos on a GPU can be off by 1e-5 rad and more, which
    // moved the edge of a 10^6 px dab by tens of pixels.
    const c = Math.cos(rot), s = Math.sin(rot);
    let rv = rp;
    let D = 0, tx = 0, ty = 0, wx = 0, wy = 0, b = 0;
    if (rp > HUGE_PX) {
      // The quad covers only the target, and the shader gets the edge from small numbers (see
      // DAB_FS), as the Canvas 2D renderer does (stamp.ts, hugeRound). All in dab space (rotated
      // by -rot, height divided by k: the dab is a circle of radius rp), relative to the target
      // center: v, the target center relative to the dab center, D = |v| - rp, the depth
      // outside the edge, w = v / (|v| + rp), b = 1 / (|v| + rp). Float32 cannot hold the edge
      // relative to a center 10^6 px away or more. A stand-in circle near the edge kept it exact
      // only on the axes of an elliptical dab, and its curvature put kinks at tile edges.
      const tcx = w / 2, tcy = h / 2;
      const px = tcx - cx, py = tcy - cy;
      const vx = c * px + s * py, vy = (-s * px + c * py) / k;
      const vl = Math.hypot(vx, vy);
      D = vl - rp;
      // The edge is further from the target than half its diagonal (dab space stretches by at
      // most 1 / k): nothing to draw.
      if (D > Math.hypot(tcx, tcy) / k + 2) return false;
      b = 1 / (vl + rp);
      wx = vx * b;
      wy = vy * b;
      // (tx, ty): the true center relative to the quad center, for textured tips.
      tx = cx - tcx;
      ty = cy - tcy;
      cx = tcx;
      cy = tcy;
      rv = Math.max(tcx, tcy);
    }
    const o = i * INST;
    const f = this.inst;
    f[o] = cx;
    f[o + 1] = cy;
    f[o + 2] = rv;
    f[o + 3] = Math.min(1, a);
    f[o + 4] = rp;
    f[o + 5] = c;
    f[o + 6] = s;
    f[o + 11] = D;
    f[o + 12] = tx;
    f[o + 13] = ty;
    f[o + 14] = wx;
    f[o + 15] = wy;
    f[o + 16] = b;
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
      f[o + 7] = r;
      f[o + 8] = g;
      f[o + 9] = b;
      f[o + 10] = brush.hardness;
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
      const k = brushShape(b).roundness;
      const wx1 = wx0 + w / scale, wy1 = wy0 + h / scale;
      this.reserve(at + count);
      for (let c = 0; c * DAB_CHUNK < count; c++) {
        const co = c * 4;
        if (chunks[co + 2] <= wx0 || chunks[co] >= wx1 || chunks[co + 3] <= wy0 || chunks[co + 1] >= wy1) continue;
        const end = Math.min(count, (c + 1) * DAB_CHUNK);
        for (let i = c * DAB_CHUNK; i < end; i++) {
          const o = i * DAB_STRIDE;
          if (this.putDab(at + n, dabs[o], dabs[o + 1], dabs[o + 2], dabs[o + 3], dabs[o + 4], wx0, wy0, scale, w, h, k)) n++;
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
   * The stroke builds up in the stroke buffer (strokeT) first, as a stroke in progress does: below
   * full opacity, and with low-flow dabs in 8-bit buffers (see lowFlow). Else its dabs go straight
   * onto the tile. In 8-bit buffers, low-flow dabs straight on paint stopped at a lighter floor
   * than the stroke in progress showed, and the stroke got lighter when the pen lifted. `dot`: the
   * stroke draws as one dot here (stageStroke), which cannot build up.
   */
  private viaBuffer(b: Brush, dot: boolean): boolean {
    return this.pigmentFor(b) || b.opacity < 1 || (!dot && this.precision === 8 && lowFlow(b));
  }

  /** The stroke mixes as pigment with the paint below (the canvas mix mode; not an eraser). */
  private pigmentFor(b: Brush): boolean {
    return this.mix === 'pigment' && b.tool !== 'erase';
  }

  /**
   * How paint strokes mix with the paint below them. A change draws every tile again: the paint
   * already there mixes the new way too.
   */
  setMix(mix: MixMode): void {
    if (mix === this.mix) return;
    this.mix = mix;
    for (const t of this.tiles.values()) {
      if (t.job) this.dropJob(t);
      t.stale = true;
    }
    // Pigment copies mix as paint when merged: they go to frames of their own (and back).
    this.updateTilted();
    this.invalidate();
  }

  /**
   * Pigment mix (PIGMENT_FS) of `src` into `dst` inside `rect` (dst px), with `uv` the same area
   * in `src`: through `tmp` (the size of `dst`), since a pass cannot read the target it writes.
   */
  private pigmentOnto(dst: Target, src: WebGLTexture, rect: [number, number, number, number], uv: [number, number, number, number], opacity: number, tmp: Target): void {
    const gl = this.gl;
    this.bindTarget(tmp);
    gl.disable(gl.BLEND);
    const p = this.progs.pigment;
    gl.useProgram(p.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, dst.tex);
    gl.uniform1i(p.u.uBack, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, src);
    gl.uniform1i(p.u.uPaint, 1);
    gl.uniform1f(p.u.uOpacity, opacity);
    this.quad(p, tmp, rect, uv);
    gl.activeTexture(gl.TEXTURE0);
    // Back into dst: only the rectangle.
    this.bindTarget(dst);
    gl.disable(gl.BLEND);
    this.copy(tmp.tex, dst, rect, 1, [rect[0] / tmp.w, rect[1] / tmp.h, (rect[0] + rect[2]) / tmp.w, (rect[1] + rect[3]) / tmp.h]);
  }

  /**
   * Strokes with the same key draw the same way apart from color and hardness, so a run of them
   * shares one draw call. Null: the stroke needs a call of its own (below full opacity it goes
   * through a stroke buffer; grain has a per-stroke origin).
   */
  private batchKey(rec: StrokeRec, scale: number): string | null {
    if (rec.stroke.vector) return null;
    const b = rec.stroke.brush;
    const dot = (rec.x1 - rec.x0) * scale < 2 && (rec.y1 - rec.y0) * scale < 2;
    if (this.viaBuffer(b, dot) || (b.grain && (b.grainStrength ?? 0.5))) return null;
    const erase = b.tool === 'erase' ? 'e' : 'p';
    if (dot) return `${erase}|round|1`;
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
    if (rec.stroke.vector) return this.drawVectorStroke(target, rec, wx0, wy0, scale);
    const b = rec.stroke.brush;
    const w = target.w, h = target.h;
    const { n, fill, brush, dot } = this.stageStroke(rec, 0, wx0, wy0, scale, w, h);
    if (n === 0) return 0;
    let work = 2000 + fill; // the draw call and the dabs
    const erase = b.tool === 'erase';
    const grain = dot ? null : this.grainFor(b, rec.stroke.pts[0], rec.stroke.pts[1], wx0, wy0, scale);
    if (!this.viaBuffer(b, dot)) {
      // Source-over and destination-out are associative: at full opacity the dabs can go
      // straight onto the tile with the same result as a separate stroke buffer.
      this.bindTarget(target);
      this.blendFor(erase);
      this.drawDabs(n, brush, w, h, grain, true);
    } else {
      // Only the box of the stroke on the tile: zoomed out, one tile holds hundreds of strokes.
      const x0 = Math.max(0, Math.floor((rec.x0 - wx0) * scale) - 1), y0 = Math.max(0, Math.floor((rec.y0 - wy0) * scale) - 1);
      const x1 = Math.min(w, Math.ceil((rec.x1 - wx0) * scale) + 1), y1 = Math.min(h, Math.ceil((rec.y1 - wy0) * scale) + 1);
      const bw = x1 - x0, bh = y1 - y0;
      if (bw <= 0 || bh <= 0) return work;
      const gl = this.gl;
      this.bindTarget(this.strokeT);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(x0, y0, bw, bh);
      this.clear();
      gl.disable(gl.SCISSOR_TEST);
      this.blendFor(false);
      this.drawDabs(n, brush, w, h, grain, true);
      const sw = this.strokeT.w, sh = this.strokeT.h;
      const uv: [number, number, number, number] = [x0 / sw, y0 / sh, x1 / sw, y1 / sh];
      if (this.pigmentFor(b)) {
        this.pigmentOnto(target, this.strokeT.tex, [x0, y0, bw, bh], uv, b.opacity, this.mixT);
        work += 120 * bw * bh; // the spectral mix (7 Kubelka-Munk passes) costs far more than a copy
      } else {
        this.bindTarget(target);
        this.blendFor(erase);
        this.copy(this.strokeT.tex, target, [x0, y0, bw, bh], b.opacity, uv);
      }
      work += 3 * bw * bh; // clear, copy
    }
    return work;
  }

  /**
   * A vector stroke (a shape made paint) onto a tile target: drawn as the shape on the shape
   * canvas, then over the tile's pixels, in its stroke order.
   */
  private drawVectorStroke(target: Target, rec: StrokeRec, wx0: number, wy0: number, scale: number): number {
    const w = target.w, h = target.h;
    const c = (this.shapeCanvas ??= new OffscreenCanvas(TILE, TILE));
    const ctx = c.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    drawShapes(ctx, [vectorShape(rec.stroke)], wx0, wy0, scale, w, h);
    this.uploadCanvas(this.shapeTex, c);
    if (this.mix === 'pigment') {
      this.pigmentOnto(target, this.shapeTex, [0, 0, w, h], [0, 0, 1, 1], 1, this.mixT);
      return 2000 + 43 * w * h;
    }
    this.bindTarget(target);
    this.blendFor(false);
    this.copy(this.shapeTex, target, [0, 0, w, h]);
    return 2000 + 3 * w * h;
  }

  /** Stops a render in progress and returns its target to the pool. */
  private dropJob(t: Tile): void {
    if (!t.job) return;
    this.tilePool.push(t.job.target);
    t.job = null;
  }

  /**
   * The fill a tile may spend this frame: what is left of the frame's, but a tile that is still
   * rendering from earlier frames (a heavy one) gets at most half of the frame's, so the tiles
   * after it in this frame's order get their turn. One heavy tile in the view used to take every
   * frame until it was done, and nothing else on screen filled in meanwhile.
   */
  private tileShare(t: Tile, fill: number, spent: number): number {
    const left = fill - spent;
    return t.job ? Math.min(left, fill * HEAVY_SHARE) : left;
  }

  /**
   * Brings one tile up to date, or moves it closer. A full render (stale or new) draws into a
   * fresh target and may span frames: it stops once `budget` is spent and goes on next frame.
   * Appended strokes draw at once (they are few). Returns the work spent.
   */
  private renderTile(t: Tile, budget: number): number {
    if (this.shapeLayers.has(t.layer)) return this.renderShapeTile(t);
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
    let count = 0, used = 0;
    for (const t of this.tiles.values()) {
      count += (t.target ? 1 : 0) + (t.job ? 1 : 0);
      if (t.used === this.frame) used++;
    }
    // The tiles this frame drew stay too (kaleidoscope frames need them again next frame).
    const max = Math.min(this.hardMaxTiles, Math.max(this.maxTiles, Math.ceil(Math.max(needed, used) * 1.25)));
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
    if (!this.outOfBand) {
      this.lastFrameAt = start;
      this.watchSpeed(interval, start);
    }
    // Moving: the view changed just now, or this device draws a stroke (it must stay smooth).
    let drawing = false;
    for (const l of this.live.values()) if (!l.remote && !l.ended) drawing = true;
    const moving = start - this.lastViewChange < MOVING_MS || drawing;
    const target = moving ? MOVING_TARGET_MS : STILL_TARGET_MS;
    // The frame's own compositing is not the tiles' doing: a heavy composite (many kaleidoscope
    // copies) would else cut their budget to a tile a frame, and they would take minutes.
    const tileTime = interval - this.compositeMs;
    if (this.tileWorkLastFrame && tileTime < 150 && !this.outOfBand) {
      const b = moving ? this.fillMoving : this.fillBudget;
      const next = tileTime > target * 1.15 ? Math.max(FILL_MIN, b * 0.75) : tileTime < target * 0.85 ? Math.min(FILL_MAX, b * 1.1) : b;
      if (moving) this.fillMoving = next;
      else this.fillBudget = next;
    }
    // A slow composite: the tiles get at least half as much time again.
    const slow = Math.max(1, this.compositeMs / 2 / target);
    const fill = (moving ? this.fillMoving : this.fillBudget) * slow;
    const jsBudget = Math.max(moving ? TILE_BUDGET_MS : TILE_BUDGET_STILL_MS, this.compositeMs / 2);
    let spent = 0;
    // Tile work stops here: on screen at the frame's budgets, offline at the slice (if any).
    const over = () => (this.offline ? performance.now() - start > this.offlineSlice || spent >= this.offlineFill : spent >= fill || performance.now() - start > jsBudget);
    let pending = false;
    /** Tiles still rendering that were held to their share this frame (tileShare). */
    const capped: { t: Tile; view: boolean }[] = [];
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
    // Effect frames (blurs, glows, shadows) read these tiles: their level, with their margin.
    for (const r of this.effectRanges()) ranges.push(r);
    let total = ranges.reduce((n, r) => n + area(r), 0);
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
          if (over()) {
            pending = true;
            if (r === ranges[0]) viewPending = true;
            break outer;
          }
          if (!t) {
            t = { layer, lod: r.lod, tx, ty, target: null, stale: true, append: [], maxSeq: -1, rendered: false, used: this.frame, job: null };
            this.tiles.set(key, t);
          }
          t.used = this.frame;
          const left = fill - spent, share = this.offline ? this.offlineFill - spent : this.tileShare(t, fill, spent);
          spent += this.renderTile(t, share);
          if (!this.offline && t.job && share < left) capped.push({ t, view: r === ranges[0] });
          this.tilesDrawn++;
        }
      }
    }
    // Then the tiles the last frame drew missing or out of date (kaleidoscope frames), coarse first.
    if (this.wanted.size && !pending) {
      const list = [...this.wanted.values()].sort((a, b) => b.lod - a.lod);
      this.wanted.clear();
      for (let i = 0; i < list.length; i++) {
        const w = list[i];
        const key = tileKey(w.layer, w.lod, w.tx, w.ty);
        let t = this.tiles.get(key);
        if (!this.needsWork(t)) continue;
        if (over()) {
          // The rest stay asked for.
          for (const x of list.slice(i)) this.wanted.set(tileKey(x.layer, x.lod, x.tx, x.ty), x);
          pending = true;
          break;
        }
        if (!t) {
          t = { layer: w.layer, lod: w.lod, tx: w.tx, ty: w.ty, target: null, stale: true, append: [], maxSeq: -1, rendered: false, used: this.frame, job: null };
          this.tiles.set(key, t);
        }
        t.used = this.frame;
        const left = fill - spent, share = this.offline ? this.offlineFill - spent : this.tileShare(t, fill, spent);
        spent += this.renderTile(t, share);
        if (!this.offline && t.job && share < left) capped.push({ t, view: false });
        this.tilesDrawn++;
      }
    }
    // The heavy tiles held to their share (tileShare) get what the frame has left: alone, a heavy
    // tile renders as fast as before.
    for (const c of capped) {
      if (!c.t.job) continue;
      if (over()) break;
      spent += this.renderTile(c.t, fill - spent);
    }
    for (const c of capped) {
      if (!c.t.job) continue;
      pending = true;
      if (c.view) viewPending = true;
    }
    this.tileWorkLastFrame = spent > 0;
    // Offline in slices (offlineSlice): while tiles are left, no composite (it would be thrown
    // away); the caller lets the page breathe and calls again.
    if (this.offline && pending) {
      this.lastPending = true;
      return;
    }
    const c0 = performance.now();
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
      w: this.canvas.width,
      h: this.canvas.height,
      ns: '',
      wx: vx,
      wy: vy,
      s: ds,
    };
    if (this.hot.size || this.drafts.size) this.updateHot(grid);
    let main: Pair = { a: this.compA, b: this.compB };
    this.bindTarget(main.a);
    this.clearPaper();
    main = this.compositeNodes(this.tree, main, grid, 0);
    this.compA = main.a;
    this.compB = main.b;
    this.settlePreview(grid);
    this.settleStrokes(grid);

    // 4. Present with dither.
    if (this.pickPass) return;
    this.bindTarget(null);
    gl.disable(gl.BLEND);
    const p = this.progs.present;
    gl.useProgram(p.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.compA.tex);
    gl.uniform1i(p.u.uTex, 0);
    gl.uniform1f(p.u.uDither, this.precision === 16 ? 1 : 0);
    gl.uniform1f(p.u.uCell, Math.max(1, Math.round(8 * this.dpr)));
    this.quad(p, null, [0, 0, this.canvas.width, this.canvas.height]);

    gl.flush();
    this.compositeMs = performance.now() - c0;
    // Tiles drawn missing or out of date: another frame renders them.
    if (this.wanted.size) pending = true;
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
        let group: Pair = { a: this.buf(g, `clipA${depth}`), b: this.buf(g, `clipB${depth}`) };
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
    // The transform preview shows on screen only (an effect frame draws the tiles as they are).
    const pv = g.ns === '' ? this.previews.get(l.id) : undefined;
    if (pv) return this.drawPreview(pv, node, pair, g, atop, depth);
    if (l.kind !== 'group') return this.compositeLayer(l, pair, g, atop);
    // A group with effects draws its layers together first (as if isolated), then the effects.
    if (activeEffects(l).length) return this.blendOnto(this.groupPixels(node, g, depth), modeOf(l.blend), l.opacity, pair, atop);
    if (l.blend === 'pass' && !atop) {
      // Pass through: the group's layers blend straight onto what is below, as if not grouped.
      if (l.opacity >= 1) return this.compositeNodes(node.children, pair, g, depth + 1);
      // With less opacity: composite them, then mix the result with the backdrop by the opacity.
      const gl = this.gl;
      const save = this.buf(g, `pass${depth}`);
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
    let p: Pair = { a: this.buf(g, `isoA${depth}`), b: this.buf(g, `isoB${depth}`) };
    this.bindTarget(p.a);
    this.clear();
    p = this.compositeNodes(node.children, p, g, depth + 1);
    return p.a;
  }

  /**
   * Where a stroke in progress is in frame g (px, from its dabs, on screen), and the same area
   * in its screen buffer (texture coordinates). Null: nothing on screen.
   */
  private liveRect(l: Live, g: Grid): { rect: [number, number, number, number]; uv: [number, number, number, number] } | null {
    const W = this.canvas.width || 1, H = this.canvas.height || 1, ds = this.view.zoom * this.dpr;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i + 2 < l.dabs.length; i += DAB_STRIDE) {
      const r = l.dabs[i + 2];
      x0 = Math.min(x0, l.dabs[i] - r);
      y0 = Math.min(y0, l.dabs[i + 1] - r);
      x1 = Math.max(x1, l.dabs[i] + r);
      y1 = Math.max(y1, l.dabs[i + 1] + r);
    }
    // Screen px, a pixel of margin for the edge, inside the screen.
    const sx0 = Math.max(0, Math.floor((x0 - this.view.x) * ds) - 1), sy0 = Math.max(0, Math.floor((y0 - this.view.y) * ds) - 1);
    const sx1 = Math.min(W, Math.ceil((x1 - this.view.x) * ds) + 1), sy1 = Math.min(H, Math.ceil((y1 - this.view.y) * ds) + 1);
    if (!(sx1 > sx0 && sy1 > sy0)) return null;
    const [ox, oy, sw] = this.screenRect(g), f = sw / W;
    return { rect: [ox + sx0 * f, oy + sy0 * f, (sx1 - sx0) * f, (sy1 - sy0) * f], uv: [sx0 / W, sy0 / H, sx1 / W, sy1 / H] };
  }

  /** A layer's or group's own pixels with its effects, before its blend and opacity. */
  private nodePixels(node: LayerNode, g: Grid, depth: number): Target {
    if (node.layer.kind === 'group') return this.groupPixels(node, g, depth);
    return this.layerPixels(node.layer, g);
  }

  /** A layer's pixels (renderLayer) with its effects. */
  private layerPixels(layer: Layer, g: Grid, kaleidoscope = true): Target {
    this.renderLayer(layer, g);
    const fx = activeEffects(layer).filter((e) => kaleidoscope || e.type !== 'kaleidoscope');
    if (!fx.length) return this.buf(g, 'layer');
    // Only a kaleidoscope, and the layer is its tiles (no mask, nothing in progress or edited):
    // its copies can draw the tiles themselves (kaleidoscope, drawThrough).
    const plain = fx.length === 1 && !layer.mask?.enabled && !this.hot.has(layer.id) && !this.strokePreview?.byKey.has(layer.id) && this.livesFor(layer.id).length === 0;
    return this.applyEffects(
      fx,
      g,
      this.buf(g, 'layer'),
      (fg) => {
        this.renderLayer(layer, fg);
        return this.buf(fg, 'layer');
      },
      (kg) => this.layerPixels(layer, kg, false),
      () => this.nodeBounds(layer, false),
      plain ? layer.id : null,
      layer.id,
    );
  }

  /** An isolated group's pixels (renderGroup) with its effects. */
  private groupPixels(node: LayerNode, g: Grid, depth: number, kaleidoscope = true): Target {
    const own = this.renderGroup(node, g, depth);
    const fx = activeEffects(node.layer).filter((e) => kaleidoscope || e.type !== 'kaleidoscope');
    if (!fx.length) return own;
    return this.applyEffects(
      fx,
      g,
      own,
      (fg) => this.renderGroup(node, fg, depth),
      (kg) => this.groupPixels(node, kg, depth, false),
      () => this.nodeBounds(node.layer, false),
      null,
      node.layer.id,
    );
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
    this.setTransformPreviews(p ? [p] : null);
  }

  setTransformPreviews(list: { id: string; m: Affine }[] | null): void {
    const keep = new Set(list?.map((p) => p.id));
    for (const [id, pv] of this.previews) if (!keep.has(id) || pv.settle) this.dropPreview(id);
    for (const p of list ?? []) {
      const old = this.previews.get(p.id);
      if (old) old.m = p.m;
      else this.previews.set(p.id, { id: p.id, m: p.m, settle: false, settleAt: 0, snap: null, capture: null });
    }
    this.invalidate();
  }

  /**
   * The transforms are applied (their strokes changed): keep the previews until the tiles of the
   * layers show the new strokes, so the layers do not flash back to where they were.
   */
  settleTransformPreview(): void {
    if (!this.previews.size) return;
    for (const pv of this.previews.values()) {
      pv.settle = true;
      pv.settleAt = performance.now();
    }
    this.invalidate();
  }

  private dropPreview(id: string): void {
    const pv = this.previews.get(id);
    if (pv?.snap) this.freeTarget(pv.snap);
    this.previews.delete(id);
  }

  private drawPreview(pv: TransformPreview, node: LayerNode, pair: Pair, g: Grid, atop: boolean, depth: number): Pair {
    const gl = this.gl;
    if (pv.snap && ((pv.partial && !pv.settle) || pv.snap.w !== this.canvas.width || pv.snap.h !== this.canvas.height)) {
      this.freeTarget(pv.snap);
      pv.snap = null;
    }
    if (!pv.snap) {
      if (pv.settle) {
        // The screen changed size after the transform was applied: the tiles are right now.
        this.dropPreview(pv.id);
        return this.compositeNode(node, pair, g, atop, depth);
      }
      const src = this.nodePixels(node, g, depth);
      pv.snap = this.makeTarget(src.w, src.h);
      this.bindTarget(pv.snap);
      gl.disable(gl.BLEND);
      this.copy(src.tex, pv.snap, [0, 0, src.w, src.h]);
      pv.capture = { x: this.view.x, y: this.view.y, ds: this.view.zoom * this.dpr };
      pv.partial = !this.tilesCurrent(this.previewKeys(pv.id), g);
      if (pv.partial) this.invalidate();
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

  /** After a frame: a settling preview ends once every tile of its layers in view is current. */
  private settlePreview(g: Grid): void {
    for (const pv of [...this.previews.values()]) if (pv.settle) this.settleOne(pv, g);
  }

  private settleOne(pv: TransformPreview, g: Grid): void {
    const done = performance.now() - pv.settleAt > 4000 || this.tilesCurrent(this.previewKeys(pv.id), g);
    if (done) {
      this.dropPreview(pv.id);
      this.invalidate();
    }
  }

  /** The tile keys of a layer or group: its paint and shape layers, and their enabled masks. */
  private previewKeys(id: string): string[] {
    const ids = subtreeIds(this.layers, id);
    const keys: string[] = [];
    for (const l of this.layers) {
      if (!ids.has(l.id)) continue;
      if (l.kind === 'paint' || l.kind === undefined || l.kind === 'shape') keys.push(l.id);
      if (l.mask?.enabled) keys.push(maskKey(l.id, l.mask.id));
    }
    return keys;
  }

  /** Every tile of these keys in view shows their strokes now. */
  private tilesCurrent(keys: Iterable<string>, g: Grid): boolean {
    for (const key of keys)
      for (let ty = g.ty0; ty <= g.ty1; ty++)
        for (let tx = g.tx0; tx <= g.tx1; tx++) {
          const t = this.tiles.get(tileKey(key, g.lod, tx, ty));
          const content = this.shapeLayers.has(key) ? this.shapes.layer(key).length : this.index.byLayer.get(key)?.length;
          if (t ? !t.rendered || this.needsWork(t) : content) return false;
        }
    return true;
  }

  // --- stroke preview (3D transforms) -----------------------------------------------------------

  /**
   * Draws `strokes` instead of the strokes of their layers and layer masks (by strokeKey), with
   * their brushes, in their layers' blend modes, masks and effects: the live preview of a 3D
   * transform, whose strokes move each in its own way (a picture of the layer cannot show that).
   * Every key of the list draws only from the list, again every frame at the resolution of the
   * frame. Null clears it.
   */
  setStrokePreview(strokes: Stroke[] | null): void {
    if (!strokes) {
      if (this.strokePreview) {
        this.strokePreview = null;
        this.invalidate();
      }
      return;
    }
    const byKey = new Map<string, StrokeRec[]>();
    for (const st of strokes) {
      const key = strokeKey(st);
      let list = byKey.get(key);
      if (!list) byKey.set(key, (list = []));
      list.push(StrokeIndex.makeRec(st));
    }
    for (const list of byKey.values()) list.sort((a, b) => a.stroke.seq - b.stroke.seq);
    this.strokePreview = { byKey, settle: false, settleAt: 0 };
    this.invalidate();
  }

  /** The dabs of these strokes as this renderer has them (cached with their tiles). */
  previewDabs(strokes: Stroke[]): number {
    let n = 0;
    for (const st of strokes) {
      const rec = this.index.recs.get(st.id);
      if (rec && !rec.stroke.vector) n += strokeDabs(rec).count;
    }
    return n;
  }

  /** The transform is applied: keep the preview until the tiles show the moved strokes. */
  settleStrokePreview(): void {
    if (!this.strokePreview) return;
    this.strokePreview.settle = true;
    this.strokePreview.settleAt = performance.now();
    this.invalidate();
  }

  private settleStrokes(g: Grid): void {
    const pv = this.strokePreview;
    if (!pv?.settle) return;
    if (performance.now() - pv.settleAt > 4000 || this.tilesCurrent(pv.byKey.keys(), g)) {
      this.strokePreview = null;
      this.invalidate();
    }
  }

  /**
   * Preview strokes into an empty layer or mask buffer of the frame `g`, as tiles draw them. A
   * stroke that builds up in a buffer (viaBuffer) uses one the size of the frame here.
   */
  private drawPreviewStrokes(list: StrokeRec[], g: Grid, target: Target): void {
    const x1 = g.wx + target.w / g.s, y1 = g.wy + target.h / g.s;
    const shown = list.filter((r) => intersects(r, g.wx, g.wy, x1, y1));
    if (!shown.length) return;
    const tile = [this.strokeT, this.mixT];
    this.strokeT = this.buf(g, 'pvStroke');
    this.mixT = this.buf(g, 'pvMix');
    try {
      this.drawStrokes(target, shown, 0, g.wx, g.wy, g.s, Infinity);
    } finally {
      [this.strokeT, this.mixT] = tile;
    }
  }

  /** Draws one layer onto `pair.a`. Returns the pair with the result in `a`. */
  private compositeLayer(layer: Layer, pair: Pair, g: Grid, atop: boolean): Pair {
    if (layer.kind === 'adjust') return this.applyAdjust(layer, pair, g);
    if (activeEffects(layer).length) return this.blendOnto(this.layerPixels(layer, g), layer.blend, layer.opacity, pair, atop);
    const mode = BLEND_MODES.indexOf(modeOf(layer.blend));
    if (mode <= 0 && !atop && !layer.mask?.enabled && this.livesFor(layer.id).length === 0 && !this.strokePreview?.byKey.has(layer.id)) {
      // Normal layer, no mask, nothing in progress: tiles go straight onto the composite.
      this.bindTarget(pair.a);
      this.blendFor(false);
      this.drawLayerContent(layer.id, g, pair.a, layer.opacity);
      return pair;
    }
    this.renderLayer(layer, g);
    return this.blendOnto(this.buf(g, 'layer'), layer.blend, layer.opacity, pair, atop);
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

  /**
   * A layer's pixels, with its strokes in progress and its mask, into the frame's 'layer' buffer
   * (opacity 1). Strokes in progress are screen buffers: an effect frame gets the part on screen.
   */
  private renderLayer(layer: Layer, g: Grid): void {
    const gl = this.gl;
    const t = this.buf(g, 'layer');
    this.bindTarget(t);
    this.clear();
    gl.disable(gl.BLEND);
    this.drawLayerContent(layer.id, g, t, 1);
    const scr = this.screenRect(g);
    // (Strokes in progress are not in a tilted kaleidoscope's copies: keyMap.)
    for (const l of this.keyMap ? [] : this.livesFor(layer.id)) {
      if (this.pigmentFor(l.brush)) {
        // Only where the stroke is: the mix is a heavy shader.
        const r = this.liveRect(l, g);
        if (r) this.pigmentOnto(t, l.target!.tex, r.rect, r.uv, l.brush.opacity, this.buf(g, 'pigment'));
        this.bindTarget(t);
        continue;
      }
      this.blendFor(l.brush.tool === 'erase');
      this.copy(l.target!.tex, t, scr, l.brush.opacity);
    }
    if (!layer.mask?.enabled) return;
    const mask = this.renderMask(layer, g);
    // Multiply the layer by the mask visibility: dst * (1 - src.a), src.a = 1 - visibility.
    this.bindTarget(t);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
    const p = this.progs.mask;
    gl.useProgram(p.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, mask.tex);
    gl.uniform1i(p.u.uMask, 0);
    this.quad(p, t, [0, 0, t.w, t.h]);
  }

  /** The grey mask paint of a layer (tiles and strokes in progress) in the mask buffer. */
  private renderMask(layer: Layer, g: Grid): Target {
    const gl = this.gl;
    const key = maskKey(layer.id, layer.mask!.id);
    const t = this.buf(g, 'mask');
    this.bindTarget(t);
    this.clear();
    gl.disable(gl.BLEND);
    this.drawLayerContent(key, g, t, 1);
    const scr = this.screenRect(g);
    for (const l of this.keyMap ? [] : this.livesFor(key)) {
      this.blendFor(l.brush.tool === 'erase');
      this.copy(l.target!.tex, t, scr, l.brush.opacity);
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

  // --- effects: blur, shadow and glows ------------------------------------------------------------
  //
  // A blur needs the pixels around what it shows: up to 3 standard deviations off screen. On the
  // screen frame, each effect gets its own effect frame (fxGrid): the view plus a margin, at the
  // coarser level where the blur is at most MAX_SIGMA px (blur.ts). Its source renders there from
  // the tiles of that level (cheap: a big blur needs only coarse tiles), it blurs at that size, and
  // the result is read back on the screen with bilinear filtering. Thus a blur costs about the
  // same at 2 px and at 2000 px, and pixels off screen blur in at the edges.
  //
  // Inside an effect frame (the backdrop of a blur adjustment), effects of the layers below blur
  // that frame's own buffers (with a pyramid when they are wide): no frames within frames.

  /** The backdrop render of a blur adjustment stops at that layer (renderBackdrop). */
  private stopAt: { id: string; ns: string; result: Target | null } | null = null;

  /**
   * The effect frame for a blur of `sigma` world units whose source is offset by (dx, dy) world
   * units (a shadow): the view moved back by the offset, with a margin of MARGIN px, at 2^-k of
   * the screen's resolution. `sigma` in the result: what is left to blur, in px of the frame.
   */
  private fxGrid(sigma: number, dx: number, dy: number): { g: Grid; sigma: number } {
    const ds = this.view.zoom * this.dpr;
    const lv = blurLevel(sigma * ds, false);
    const s = ds / 2 ** lv.k;
    const w = Math.ceil((this.canvas.width || 1) / 2 ** lv.k) + 2 * MARGIN;
    const h = Math.ceil((this.canvas.height || 1) / 2 ** lv.k) + 2 * MARGIN;
    const wx = this.view.x - dx - MARGIN / s, wy = this.view.y - dy - MARGIN / s;
    const lod = lodFor(s);
    const tw = tileWorld(lod);
    const g: Grid = {
      lod,
      tx0: Math.floor(wx / tw),
      ty0: Math.floor(wy / tw),
      tx1: Math.floor((wx + w / s) / tw),
      ty1: Math.floor((wy + h / s) / tw),
      X: (tx) => Math.round((tx * tw - wx) * s),
      Y: (ty) => Math.round((ty * tw - wy) * s),
      w,
      h,
      ns: `fx${lv.k}:`,
      wx,
      wy,
      s,
    };
    return { g, sigma: lv.sigma };
  }

  /** The tiles the effect frames of this frame read (render keeps them current). */
  private effectRanges(): TileRange[] {
    const out: TileRange[] = [];
    const add = (sigma: number, dx = 0, dy = 0) => {
      const { g } = this.fxGrid(sigma, dx, dy);
      out.push({ lod: g.lod, tx0: g.tx0, ty0: g.ty0, tx1: g.tx1, ty1: g.ty1 });
    };
    for (const l of this.layers) {
      if (!effectivelyVisible(this.byId, l)) continue;
      if (l.kind === 'adjust' && l.adjust?.type === 'blur' && l.adjust.radius > 0 && l.opacity > 0) add(l.adjust.radius);
      // (Kaleidoscope frames ask for their tiles as they draw: drawTile, wanted.)
      const fx = activeEffects(l);
      for (const e of fx) if (e.type !== 'kaleidoscope') add(effectSigma(e, fx), e.dx, e.dy);
    }
    return out;
  }

  /**
   * A Gaussian blur of `src` by `sigma` of its px. Wide blurs halve the image first (a box filter
   * per halving), so the kernel stays small. Returns a buffer that may be smaller than `src`; read
   * it over the same texture coordinates (bilinear filtering scales it back). `ns` names the
   * buffers.
   */
  private gaussian(src: Target, sigma: number, ns: string): Target {
    const gl = this.gl;
    const lv = blurLevel(sigma, true);
    let cur = src;
    for (let i = 1; i <= lv.k; i++) {
      const d = this.screen(`${ns}d${i}`, Math.max(1, Math.ceil(cur.w / 2)), Math.max(1, Math.ceil(cur.h / 2)));
      this.bindTarget(d);
      gl.disable(gl.BLEND);
      this.copy(cur.tex, d, [0, 0, d.w, d.h]);
      cur = d;
    }
    const k = kernel(lv.sigma);
    if (k.n === 1) return cur;
    const across = this.screen(`${ns}x`, cur.w, cur.h);
    const down = this.screen(`${ns}y`, cur.w, cur.h);
    this.blurPass(cur, across, [1 / cur.w, 0], k);
    this.blurPass(across, down, [0, 1 / cur.h], k);
    return down;
  }

  private blurPass(src: Target, dst: Target, step: [number, number], k: { n: number; off: Float32Array; w: Float32Array }): void {
    const gl = this.gl;
    this.bindTarget(dst);
    gl.disable(gl.BLEND);
    const p = this.progs.blur;
    gl.useProgram(p.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.uniform1i(p.u.uTex, 0);
    gl.uniform2f(p.u.uStep, step[0], step[1]);
    gl.uniform1i(p.u.uN, k.n);
    gl.uniform1fv(p.u.uOff, k.off);
    gl.uniform1fv(p.u.uW, k.w);
    this.quad(p, dst, [0, 0, dst.w, dst.h]);
  }

  /**
   * Effects onto a layer's or group's own pixels (`own`, in frame g). `source` renders those
   * pixels in another frame (an effect frame). Each effect reads its own blurred source (the
   * pixels before effects; glows and the shadow with the blur of a blur effect added) and draws
   * onto the result so far. Returns the result.
   */
  private applyEffects(fx: LayerEffect[], g: Grid, own: Target, source: (fg: Grid) => Target, whole: (kg: Grid) => Target, content: () => Box | null, plain: string | null, id: string): Target {
    const gl = this.gl;
    let cur = own;
    let flip = false;
    for (const e of fx) {
      if (e.type === 'kaleidoscope') continue; // last, on the result (below)
      const sigma = effectSigma(e, fx);
      const dx = e.dx ?? 0, dy = e.dy ?? 0;
      let src: Target;
      let map: [number, number, number, number];
      if (g.ns === '') {
        // Screen: from an effect frame, with the pixels around the view.
        const f = this.fxGrid(sigma, dx, dy);
        src = this.gaussian(source(f.g), f.sigma, `${f.g.ns}g`);
        // Frame position (0..1) → world → the source point (moved back by the offset) → its texture.
        const fg = f.g;
        map = [(g.w / g.s) * (fg.s / fg.w), (g.h / g.s) * (fg.s / fg.h), (g.wx - dx - fg.wx) * (fg.s / fg.w), (g.wy - dy - fg.wy) * (fg.s / fg.h)];
      } else {
        // Inside an effect frame: blur this frame's buffer.
        src = this.gaussian(own, sigma * g.s, `${g.ns}g`);
        map = [1, 1, (-dx * g.s) / g.w, (-dy * g.s) / g.h];
      }
      const out = this.buf(g, flip ? 'fxA' : 'fxB');
      flip = !flip;
      this.bindTarget(out);
      gl.disable(gl.BLEND);
      const p = this.progs.fx;
      gl.useProgram(p.prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, cur.tex);
      gl.uniform1i(p.u.uLayer, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform1i(p.u.uFx, 1);
      gl.uniform4f(p.u.uFxMap, map[0], map[1], map[2], map[3]);
      gl.uniform1i(p.u.uMode, e.type === 'blur' ? 0 : e.type === 'innerGlow' ? 2 : 1);
      const [r, gg, b] = hexToRgb(e.color ?? '#000000');
      gl.uniform3f(p.u.uColor, r, gg, b);
      gl.uniform1f(p.u.uOpacity, e.opacity ?? 1);
      gl.uniform1f(p.u.uSpread, Math.min(0.99, e.spread ?? 0));
      this.quad(p, out, [0, 0, out.w, out.h]);
      gl.activeTexture(gl.TEXTURE0);
      cur = out;
    }
    const kal = fx.find((e) => e.type === 'kaleidoscope');
    if (!kal) return cur;
    // What the other effects add around the layer: a copy's frame takes that much more.
    let pad = 0;
    for (const e of fx) if (e.type !== 'kaleidoscope') pad = Math.max(pad, 3 * effectSigma(e, fx) + Math.hypot(e.dx ?? 0, e.dy ?? 0));
    // A tilt on 3D layers: the copies from the strokes (not inside such a copy: there they are
    // seen straight on, as a picture).
    const geo = this.keyMap ? undefined : this.tilted.get(id);
    // Merged: the copies are in the layer's own tiles already.
    if (geo?.merged) return cur;
    if (geo) return this.kaleidoscope3(kal, g, cur, whole, id, geo);
    return this.kaleidoscope(kal, g, cur, whole, content, pad, plain);
  }

  /**
   * Copy i of a kaleidoscope as the paper sees it (world to world), i = 1..count: the step
   * applied i times; a 3D step seen straight on (kaleidoscopeCopies).
   */
  private kaleidoscopeSteps(e: LayerEffect): Affine[] {
    return kaleidoscopeCopies(e);
  }

  /**
   * World bounds of what a layer or group draws: its strokes, shapes (with drafts) and strokes in
   * progress, its children for a group, grown by its blur, glows and shadow, and with its
   * kaleidoscope copies unless `kaleidoscope` is false. Null: nothing.
   */
  private nodeBounds(l: Layer, kaleidoscope = true): Box | null {
    const acc: { b: Box | null } = { b: null };
    const add = (x0: number, y0: number, x1: number, y1: number) => {
      if (!(x1 >= x0 && y1 >= y0)) return;
      const b = acc.b;
      acc.b = b ? { x0: Math.min(b.x0, x0), y0: Math.min(b.y0, y0), x1: Math.max(b.x1, x1), y1: Math.max(b.y1, y1) } : { x0, y0, x1, y1 };
    };
    if (l.kind === 'group') {
      for (const c of this.layers) {
        if (c.parent !== l.id || !c.visible) continue;
        if (c.kind === 'adjust') {
          // A blur inside the group spreads what is below it.
          const q = acc.b;
          if (q && c.adjust?.type === 'blur') {
            const p = 3 * c.adjust.radius;
            add(q.x0 - p, q.y0 - p, q.x1 + p, q.y1 + p);
          }
          continue;
        }
        const cb = this.nodeBounds(c);
        if (cb) add(cb.x0, cb.y0, cb.x1, cb.y1);
      }
    } else if (l.kind !== 'adjust') {
      if (this.shapeLayers.has(l.id)) for (const s of this.liveShapes(l.id)) {
        const r = shapeRec(s);
        add(r.x0, r.y0, r.x1, r.y1);
      }
      else for (const r of this.index.byLayer.get(l.id) ?? []) add(r.x0, r.y0, r.x1, r.y1);
      for (const lv of this.livesFor(l.id)) {
        for (let i = 0; i + 2 < lv.dabs.length; i += DAB_STRIDE) add(lv.dabs[i] - lv.dabs[i + 2], lv.dabs[i + 1] - lv.dabs[i + 2], lv.dabs[i] + lv.dabs[i + 2], lv.dabs[i + 1] + lv.dabs[i + 2]);
      }
    }
    const own = acc.b;
    if (!own) return null;
    const fx = activeEffects(l);
    for (const e of fx) {
      if (e.type === 'kaleidoscope') continue;
      const p = 3 * effectSigma(e, fx), dx = e.dx ?? 0, dy = e.dy ?? 0;
      add(own.x0 + dx - p, own.y0 + dy - p, own.x1 + dx + p, own.y1 + dy + p);
    }
    const kal = kaleidoscope ? fx.find((e) => e.type === 'kaleidoscope') : undefined;
    const geo = kal && !this.keyMap ? this.tilted.get(l.id) : undefined;
    if (geo?.merged) {
      // The copies are among the layer's strokes: in its bounds already.
    } else if (geo) {
      // The copied strokes themselves (their boxes, moved in 3D, seen straight on).
      for (const id of geo.members)
        for (const [key, list] of this.index.byLayer) if (key.startsWith(`${id}@${l.id}:`) && !key.includes('#')) for (const r of list) add(r.x0, r.y0, r.x1, r.y1);
    } else if (kal) {
      const one: Box = acc.b!;
      for (const m of this.kaleidoscopeSteps(kal)) {
        const pts = [apply(m, one.x0, one.y0), apply(m, one.x1, one.y0), apply(m, one.x0, one.y1), apply(m, one.x1, one.y1)];
        add(Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1])));
      }
    }
    return acc.b;
  }

  /** A frame of w × h px whose top left is world (wx, wy), at s px per world unit. */
  private frameGrid(wx: number, wy: number, w: number, h: number, s: number, ns: string): Grid {
    const lod = lodFor(s);
    const tw = tileWorld(lod);
    return {
      lod,
      tx0: Math.floor(wx / tw),
      ty0: Math.floor(wy / tw),
      tx1: Math.floor((wx + w / s) / tw),
      ty1: Math.floor((wy + h / s) / tw),
      X: (tx) => Math.round((tx * tw - wx) * s),
      Y: (ty) => Math.round((ty * tw - wy) * s),
      w,
      h,
      ns,
      wx,
      wy,
      s,
    };
  }

  /**
   * A kaleidoscope whose step tilts, on 3D layers (see `tilted`): copy i is the layer (or group)
   * rendered from its strokes' copy i (moved in 3D, seen straight on), with its mask and other
   * effects, in frame g itself; the copies and `cur` go into one buffer, in the order as the
   * flat kaleidoscope's.
   */
  private kaleidoscope3(e: LayerEffect, g: Grid, cur: Target, whole: (kg: Grid) => Target, id: string, geo: Tilted): Target {
    const out = this.buf(g, 'kalOut');
    const kg: Grid = { ...g, ns: `${g.ns}k3:` };
    const copy = (i: number) => {
      this.keyMap = (key) => {
        const [l, mask] = key.split('#');
        return geo.members.has(l) ? copyKey(l, id, i) + (mask ? `#${mask}` : '') : key;
      };
      let src: Target;
      try {
        src = whole(kg);
      } finally {
        this.keyMap = null;
      }
      this.bindTarget(out);
      this.blendFor(false);
      this.copy(src.tex, out, [0, 0, out.w, out.h]);
    };
    this.bindTarget(out);
    this.clear();
    const n = geo.copies.length;
    // Behind: copy 1 nearest the layer, so the last copy goes down first.
    if (e.order === 'behind') for (let i = n - 1; i >= 0; i--) copy(i);
    this.bindTarget(out);
    this.blendFor(false);
    this.copy(cur.tex, out, [0, 0, out.w, out.h]);
    if (e.order !== 'behind') for (let i = 0; i < n; i++) copy(i);
    return out;
  }

  /**
   * Kaleidoscope: `cur` (the layer with its other effects, in frame g) and its copies, behind it
   * or in front of it, into one buffer. Copy i is the layer moved by steps[i]: what it shows in g
   * is the part of the layer that g undone by the copy's move covers (within `content`). A copy
   * whose part lies in g and that does not grow comes from `cur`; any other from a frame of its
   * own, at the detail the copy needs (`whole` renders the layer there, with the kaleidoscopes of
   * its layers: copies of copies have frames of their own too). The frames render one after the
   * other into the same buffers (`${g.ns}k:`), so memory does not grow with the copies, and a
   * frame never has to be coarser than g because other copies share it. Copies at one level of
   * detail share a frame when it is small enough (see below). `plain`: the layer is only its
   * tiles; its copies draw them (drawThrough), with no frame at all.
   */
  private kaleidoscope(e: LayerEffect, g: Grid, cur: Target, whole: (kg: Grid) => Target, content: () => Box | null, pad: number, plain: string | null): Target {
    const steps = this.kaleidoscopeSteps(e);
    const to: Affine = [g.s, 0, 0, g.s, -g.wx * g.s, -g.wy * g.s]; // world → frame px
    const fromG: Affine = [1 / g.s, 0, 0, 1 / g.s, g.wx, g.wy]; // frame px → world
    const gx1 = g.wx + g.w / g.s, gy1 = g.wy + g.h / g.s;
    const c = content();
    const out = this.buf(g, 'kalOut');
    // Where each copy comes from: `cur` (its part lies in g and it does not grow), the tiles
    // (plain), a frame shared by the copies at its level of detail, or a frame of its own.
    type Plan = { m: Affine; box: Box; grow: number; via: 'cur' | 'tiles' | 'level' | 'own'; level: number };
    const plans: (Plan | null)[] = steps.map((m) => {
      const inv = c && invert(m);
      if (!inv) return null;
      const pts = [apply(inv, g.wx, g.wy), apply(inv, gx1, g.wy), apply(inv, g.wx, gy1), apply(inv, gx1, gy1)];
      const box = {
        x0: Math.max(c.x0, Math.min(...pts.map((p) => p[0]))),
        y0: Math.max(c.y0, Math.min(...pts.map((p) => p[1]))),
        x1: Math.min(c.x1, Math.max(...pts.map((p) => p[0]))),
        y1: Math.min(c.y1, Math.max(...pts.map((p) => p[1]))),
      };
      if (!(box.x1 > box.x0 && box.y1 > box.y0)) return null;
      const grow = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
      const inG = box.x0 >= g.wx && box.y0 >= g.wy && box.x1 <= gx1 && box.y1 <= gy1;
      const via = grow <= 1.01 && inG ? 'cur' : plain ? 'tiles' : 'level';
      return { m, box, grow, via, level: Math.ceil(Math.log2(g.s * grow)) };
    });
    // Copies at the same level of detail (the detail they need rounded up to a power of 2) mostly
    // show the same parts of the layer: one frame over the union of their parts, rendered once
    // (with the layer's effects), when it stays within the pixels of a copy's own frame (2.5× g)
    // and 4096 px a side. At most LEVEL_FRAMES of them, the levels with the most copies; the
    // other copies get frames of their own.
    const unions = new Map<number, { box: Box; n: number }>();
    for (const p of plans) {
      if (p?.via !== 'level') continue;
      const u = unions.get(p.level);
      if (u) {
        u.box = { x0: Math.min(u.box.x0, p.box.x0), y0: Math.min(u.box.y0, p.box.y0), x1: Math.max(u.box.x1, p.box.x1), y1: Math.max(u.box.y1, p.box.y1) };
        u.n++;
      } else unions.set(p.level, { box: { ...p.box }, n: 1 });
    }
    const fits = (b: Box, sl: number) => {
      const bw = b.x1 - b.x0 + 2 * pad, bh = b.y1 - b.y0 + 2 * pad;
      return bw * sl <= 4096 && bh * sl <= 4096 && bw * bh * sl * sl <= 2.5 * g.w * g.h;
    };
    const levels = [...unions].filter(([l, u]) => u.n > 1 && fits(u.box, 2 ** l)).sort((a, b) => b[1].n - a[1].n).slice(0, LEVEL_FRAMES);
    const frames = new Map<number, { kg: Grid; src: Target }>();
    for (const [l, u] of levels) {
      const kg = this.copyFrame({ x0: u.box.x0 - pad, y0: u.box.y0 - pad, x1: u.box.x1 + pad, y1: u.box.y1 + pad }, 2 ** l, g, `${g.ns}k${l}:`);
      frames.set(l, { kg, src: whole(kg) });
    }
    this.bindTarget(out);
    this.clear();
    const copy = (p: Plan | null) => {
      if (!p) return;
      const { m, box } = p;
      if (p.via === 'cur') return this.drawXform(cur, out, compose(to, compose(m, fromG)));
      if (p.via === 'tiles') return this.drawThrough(plain!, box, g.s * p.grow, out, compose(to, m));
      const f = frames.get(p.level);
      const kg = f?.kg ?? this.copyFrame({ x0: box.x0 - pad, y0: box.y0 - pad, x1: box.x1 + pad, y1: box.y1 + pad }, g.s * p.grow, g, `${g.ns}k:`);
      const src = f?.src ?? whole(kg);
      this.drawXform(src, out, compose(to, compose(m, [1 / kg.s, 0, 0, 1 / kg.s, kg.wx, kg.wy])));
      // Hand the GPU its work frame by frame: hundreds of frames with effects in one go can run
      // long enough for the browser to reset the GPU (a lost context).
      if (!f) this.gl.flush();
    };
    // Behind: copy 1 nearest the layer, so the last copy goes down first.
    if (e.order === 'behind') for (let i = plans.length - 1; i >= 0; i--) copy(plans[i]);
    this.bindTarget(out);
    this.blendFor(false);
    this.copy(cur.tex, out, [0, 0, out.w, out.h]);
    if (e.order !== 'behind') for (const p of plans) copy(p);
    return out;
  }

  /**
   * The tiles of `key` over world box `b`, at the level for `s` px per world unit, onto `out`
   * through M (world → out px, source-over): a kaleidoscope copy of a layer that is only its
   * tiles. All from one level, so they do not overlap: the finest whose tiles are all drawn (up to
   * 4× coarser while they render; the missing ones are asked for: wanted).
   */
  private drawThrough(key: string, b: Box, s: number, out: Target, M: Affine): void {
    if (this.keyMap) key = this.keyMap(key);
    let lod = lodFor(s);
    // At most about 256 tiles: coarser past that (a copy that shrinks to a few pixels).
    while (lod < MAX_LOD && ((b.x1 - b.x0) / tileWorld(lod) + 1) * ((b.y1 - b.y0) / tileWorld(lod) + 1) > 256) lod++;
    const range = (l: number) => {
      const tw = tileWorld(l);
      return { tw, tx0: Math.floor(b.x0 / tw), ty0: Math.floor(b.y0 / tw), tx1: Math.floor(b.x1 / tw), ty1: Math.floor(b.y1 / tw) };
    };
    const has = this.shapeLayers.has(key) ? this.shapes.layer(key).length > 0 : (this.index.byLayer.get(key)?.length ?? 0) > 0;
    if (!has) return;
    // The finest level whose tiles are all drawn; the tiles of the wanted level and, while it is
    // not ready, of the level 4× coarser are asked for (all of them at once).
    let use: number | null = null;
    for (let l = lod; l <= Math.min(MAX_LOD, lod + 2) && use === null; l++) {
      const r = range(l);
      const ask = l === lod || l === lod + 2;
      let ready = true;
      for (let ty = r.ty0; ty <= r.ty1; ty++)
        for (let tx = r.tx0; tx <= r.tx1; tx++) {
          const t = this.tiles.get(tileKey(key, l, tx, ty));
          if (ask && this.needsWork(t)) this.wanted.set(tileKey(key, l, tx, ty), { layer: key, lod: l, tx, ty });
          // Kept while the level fills in (else the cache frees them as unused, again and again).
          if (t && ask) t.used = this.frame;
          if (!t?.rendered) ready = false;
        }
      if (ready) use = l;
    }
    if (use === null) return;
    const r = range(use);
    const k = r.tw / TILE; // tile px → world
    // As drawXform, with the state set once: a copy can draw a few hundred tiles.
    const gl = this.gl;
    this.bindTarget(out);
    this.blendFor(false);
    const p = this.progs.xform;
    gl.useProgram(p.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(p.u.uTex, 0);
    gl.uniform1f(p.u.uOpacity, 1);
    gl.uniform2f(p.u.uSrcSize, TILE, TILE);
    gl.uniform2f(p.u.uTarget, out.w, out.h);
    gl.bindVertexArray(this.quadVao);
    for (let ty = r.ty0; ty <= r.ty1; ty++)
      for (let tx = r.tx0; tx <= r.tx1; tx++) {
        const t = this.tiles.get(tileKey(key, use, tx, ty))!;
        t.used = this.frame;
        if (!t.target) continue;
        const S = compose(M, [k, 0, 0, k, tx * r.tw, ty * r.tw]);
        gl.bindTexture(gl.TEXTURE_2D, t.target.tex);
        gl.uniformMatrix3fv(p.u.uM, false, [S[0], S[1], 0, S[2], S[3], 0, S[4], S[5], 1]);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
  }

  /**
   * The frame of a kaleidoscope copy: world box `b` at `s` px per unit (the detail the copy
   * needs), at most 2.5 times the pixels of the frame `g` it shows in (its part of g, turned, fits
   * in twice its area) and 4096 px per side: coarser when that is too much. Sizes go up in steps,
   * so the buffers of frames one after the other can be the same ones.
   */
  private copyFrame(b: Box, s: number, g: Grid, ns: string): Grid {
    const bw = b.x1 - b.x0, bh = b.y1 - b.y0;
    s = Math.min(s, 4096 / bw, 4096 / bh, Math.sqrt((2.5 * g.w * g.h) / (bw * bh)));
    // A pixel of margin, so the edge of the content is not cut by the filter.
    const m = 2 / s;
    const step = (v: number) => Math.max(128, Math.ceil(v / 128) * 128);
    const w = Math.min(4096, step((bw + 2 * m) * s)), h = Math.min(4096, step((bh + 2 * m) * s));
    return this.frameGrid(b.x0 - m, b.y0 - m, w, h, s, ns);
  }

  /** `src` onto `dst` through S (source px → target px), source-over. */
  private drawXform(src: Target, dst: Target, S: Affine): void {
    const gl = this.gl;
    this.bindTarget(dst);
    this.blendFor(false);
    const p = this.progs.xform;
    gl.useProgram(p.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.uniform1i(p.u.uTex, 0);
    gl.uniform1f(p.u.uOpacity, 1);
    gl.uniformMatrix3fv(p.u.uM, false, [S[0], S[1], 0, S[2], S[3], 0, S[4], S[5], 1]);
    gl.uniform2f(p.u.uSrcSize, src.w, src.h);
    gl.uniform2f(p.u.uTarget, dst.w, dst.h);
    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /**
   * What a blur adjustment layer has below it, in an effect frame: the frame composites the
   * layers as the screen does and stops at that layer (in a group or a clipping group, the
   * backdrop is that group's buffer). Null if the layer is not reached.
   */
  private renderBackdrop(layer: Layer, fg: Grid): Target | null {
    const pair: Pair = { a: this.buf(fg, 'compA'), b: this.buf(fg, 'compB') };
    this.bindTarget(pair.a);
    this.clearPaper();
    this.stopAt = { id: layer.id, ns: fg.ns, result: null };
    try {
      this.compositeNodes(this.tree, pair, fg, 0);
    } catch (e) {
      if (e !== STOP) throw e;
    }
    const r = this.stopAt.result;
    this.stopAt = null;
    return r;
  }

  /** The blurred backdrop of a blur adjustment, and how frame positions (0..1) map onto it. */
  private blurredBackdrop(layer: Layer, radius: number, pair: Pair, g: Grid): { t: Target; map: [number, number, number, number] } | null {
    if (g.ns !== '') return { t: this.gaussian(pair.a, radius * g.s, `${g.ns}g`), map: [1, 1, 0, 0] };
    const f = this.fxGrid(radius, 0, 0);
    const back = this.renderBackdrop(layer, f.g);
    if (!back) return null;
    const fg = f.g;
    const t = this.gaussian(back, f.sigma, `${fg.ns}g`);
    return { t, map: [(g.w / g.s) * (fg.s / fg.w), (g.h / g.s) * (fg.s / fg.h), (g.wx - fg.wx) * (fg.s / fg.w), (g.wy - fg.wy) * (fg.s / fg.h)] };
  }

  /** An adjustment layer: changes everything in `pair.a`, by its opacity and mask. */
  private applyAdjust(layer: Layer, pair: Pair, g: Grid): Pair {
    if (this.stopAt && this.stopAt.id === layer.id && this.stopAt.ns === g.ns) {
      // The backdrop render of this blur adjustment is done.
      this.stopAt.result = pair.a;
      throw STOP;
    }
    const a = layer.adjust;
    if (!a || layer.opacity <= 0) return pair;
    const gl = this.gl;
    let blur: { t: Target; map: [number, number, number, number] } | null = null;
    if (a.type === 'blur') {
      if (!(a.radius > 0)) return pair;
      blur = this.blurredBackdrop(layer, a.radius, pair, g);
      if (!blur) return pair;
    }
    const mask = layer.mask?.enabled ? this.renderMask(layer, g) : null;
    const lut = a.type === 'hueSat' || blur ? null : this.lutFor(layer);
    this.bindTarget(pair.b);
    gl.disable(gl.BLEND);
    const p = this.progs.adjust;
    gl.useProgram(p.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, pair.a.tex);
    gl.uniform1i(p.u.uBack, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, blur ? blur.t.tex : (lut ?? pair.a.tex));
    gl.uniform1i(p.u.uLut, 1);
    const m = blur?.map ?? [1, 1, 0, 0];
    gl.uniform4f(p.u.uFxMap, m[0], m[1], m[2], m[3]);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, mask ? mask.tex : pair.a.tex);
    gl.uniform1i(p.u.uMask, 2);
    gl.uniform1i(p.u.uMaskOn, mask ? 1 : 0);
    gl.uniform1i(p.u.uType, blur ? 2 : a.type === 'hueSat' ? 1 : 0);
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
    const key = tileKey(layer, lod, tx, ty);
    const own = this.tiles.get(key);
    // Missing or out of date: the next frame renders it (a range may cover it too). Kept meanwhile.
    if (this.needsWork(own)) this.wanted.set(key, { layer, lod, tx, ty });
    if (own) own.used = this.frame;
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
    let found = false;
    for (let j = 0; j < 2; j++) {
      for (let i = 0; i < 2; i++) {
        const child = this.tiles.get(tileKey(layer, lod - 1, tx * 2 + i, ty * 2 + j));
        if (!child?.rendered) continue;
        found = true;
        child.used = this.frame;
        if (child.target) this.copy(child.target.tex, target, [dst[0] + i * hw, dst[1] + j * hh, hw, hh], opacity);
      }
    }
    // Nothing to stretch: ask for the tile 4× coarser too (one for 16, ready first).
    if (!found && lod + 2 <= MAX_LOD) {
      const ptx = Math.floor(tx / 4), pty = Math.floor(ty / 4);
      this.wanted.set(tileKey(layer, lod + 2, ptx, pty), { layer, lod: lod + 2, tx: ptx, ty: pty });
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
    const k = brushShape(l.brush).roundness;
    let n = 0;
    for (let i = l.drawn; i < total; i++) {
      const o = i * DAB_STRIDE;
      const d = l.dabs;
      if (this.putDab(n, d[o], d[o + 1], d[o + 2], d[o + 3], d[o + 4], this.view.x, this.view.y, ds, w, h, k)) n++;
    }
    l.drawn = total;
    this.bindTarget(l.target);
    this.blendFor(false); // erase strokes build a mask; the layer pass applies destination-out
    const grain = l.ox === null ? null : this.grainFor(l.brush, l.ox, l.oy!, this.view.x, this.view.y, ds);
    this.drawDabs(n, l.brush, w, h, grain);
  }

  // --- readback ------------------------------------------------------------------------------------

  setPaper(p: Paper): void {
    if (p.color === this.paper.color && p.alpha === this.paper.alpha) return;
    this.paper = { ...p };
    this.invalidate();
  }

  /**
   * The color of the drawing under a CSS-pixel position, without the paper: a frame composited
   * on an empty stack, un-premultiplied. Null where nothing is drawn.
   */
  sample(cssX: number, cssY: number): string | null {
    if (this.lost) return null;
    const gl = this.gl;
    this.pickPass = true;
    try {
      this.renderNow();
    } finally {
      this.pickPass = false;
    }
    const x = Math.max(0, Math.min(this.compA.w - 1, Math.floor(cssX * this.dpr)));
    const y = Math.max(0, Math.min(this.compA.h - 1, Math.floor(cssY * this.dpr)));
    this.bindTarget(this.pickT);
    gl.disable(gl.BLEND);
    const u = (x + 0.5) / this.compA.w, v = (y + 0.5) / this.compA.h;
    this.copy(this.compA.tex, this.pickT, [0, 0, 1, 1], 1, [u, v, u, v]);
    const px = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    // The screen again, with the paper.
    this.renderNow();
    const a = px[3];
    if (a === 0) return null;
    return '#' + [px[0], px[1], px[2]].map((c) => Math.min(255, Math.round((c * 255) / a)).toString(16).padStart(2, '0')).join('');
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
