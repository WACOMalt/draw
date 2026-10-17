// Renders any world rectangle at any resolution, in pieces, with an off-screen WebGL2
// renderer that holds its own copy of the document. Used by the large image export, the
// .bdraw preview, and the link preview image.

import { FULL_PROFILE } from '../engine/perf';
import { DEFAULT_PAPER, type Layer, type MixMode, type Paper, type Shape, type Stroke } from '../../shared/types';
import type { Bounds } from '../engine/doc';
import { GLRenderer } from '../engine/gl/glRenderer';

/** Largest piece, in pixels per side. */
export const PIECE = 2048;
/** Tile work per step of renderAsync (ms), between pauses for the page. */
const SLICE = 100;

export class RegionRenderer {
  private canvas = document.createElement('canvas');
  private r: GLRenderer;
  private w = 0;
  private h = 0;

  /** The pixels keep their alpha (straight, not premultiplied): no paper, or a see-through one. */
  private alpha: boolean;

  /** Throws when WebGL2 is not available. `transparent`: no paper. */
  constructor(
    layers: Layer[],
    strokes: Stroke[],
    seq: number,
    shapes: Shape[] = [],
    transparent = false,
    paper: Paper = DEFAULT_PAPER,
    mix: MixMode = 'normal',
  ) {
    this.alpha = transparent || paper.alpha < 1;
    const gl = this.canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL2 is not available');
    this.r = new GLRenderer(this.canvas, gl, true, FULL_PROFILE);
    this.r.transparent = transparent;
    this.r.setPaper(paper);
    this.r.setMix(mix);
    this.r.setLayers(layers);
    this.r.resetStrokes(strokes, seq);
    this.r.resetShapes(shapes);
  }

  /**
   * RGBA pixels (top row first) of a w × h piece whose top left corner is world (x, y), at
   * `scale` pixels per world unit. w and h are at most PIECE.
   */
  render(x: number, y: number, scale: number, w: number, h: number): Uint8ClampedArray<ArrayBuffer> {
    if (w !== this.w || h !== this.h) {
      this.r.resize(w, h, 1);
      this.w = w;
      this.h = h;
    }
    this.r.setView(x, y, scale);
    this.r.renderSync();
    const px = this.r.readRGBA(this.alpha);
    if (!px) throw new Error('The graphics context was lost');
    return px;
  }

  /**
   * As render, in slices of SLICE ms of tile work with a pause between them, so the page can paint
   * and take a Cancel: a phone needs long to draw the tiles of a first piece. `onTiles`: the tiles
   * drawn for this piece so far. `signal` stops it (an AbortError).
   */
  async renderAsync(x: number, y: number, scale: number, w: number, h: number, opts: { onTiles?: (n: number) => void; signal?: AbortSignal } = {}): Promise<Uint8ClampedArray<ArrayBuffer>> {
    if (w !== this.w || h !== this.h) {
      this.r.resize(w, h, 1);
      this.w = w;
      this.h = h;
    }
    this.r.setView(x, y, scale);
    const t0 = this.r.tilesDrawn;
    this.r.offlineSlice = SLICE;
    try {
      while (this.r.renderStep()) {
        opts.onTiles?.(this.r.tilesDrawn - t0);
        await new Promise((r) => setTimeout(r, 0));
        if (opts.signal?.aborted) throw new DOMException('cancelled', 'AbortError');
      }
    } finally {
      this.r.offlineSlice = Infinity;
    }
    const px = this.r.contextLost() ? null : this.r.readRGBA(this.alpha);
    if (!px) throw new Error('The graphics context was lost');
    return px;
  }

  destroy(): void {
    this.r.destroy();
  }
}

/**
 * The paper for a preview image: opaque, a see-through paper shown over white. `p` can come from
 * a file: anything that is not a paper gives the default paper.
 */
export function flatPaper(p: unknown): Paper {
  const q = p as Partial<Paper> | null | undefined;
  if (typeof q?.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(q.color) || typeof q.alpha !== 'number' || !(q.alpha >= 0 && q.alpha <= 1)) return DEFAULT_PAPER;
  const n = parseInt(q.color.slice(1), 16), a = q.alpha;
  const mix = (c: number) => Math.round(255 - (255 - c) * a);
  const hex = [mix((n >> 16) & 255), mix((n >> 8) & 255), mix(n & 255)].map((c) => c.toString(16).padStart(2, '0')).join('');
  return { color: '#' + hex, alpha: 1 };
}

/**
 * A PNG of `b` fitted into at most maxW × maxH pixels (aspect kept), on the paper (see flatPaper:
 * link previews and thumbnails are opaque).
 */
export async function renderPng(layers: Layer[], strokes: Stroke[], seq: number, b: Bounds, maxW: number, maxH: number, shapes: Shape[] = [], paper?: unknown, mix?: unknown): Promise<Blob | null> {
  const bw = b.x1 - b.x0, bh = b.y1 - b.y0;
  if (!(bw > 0 && bh > 0)) return null;
  const scale = Math.min(maxW / bw, maxH / bh);
  const w = Math.max(1, Math.min(PIECE, Math.round(bw * scale)));
  const h = Math.max(1, Math.min(PIECE, Math.round(bh * scale)));
  const rr = new RegionRenderer(layers, strokes, seq, shapes, false, flatPaper(paper), mix === 'pigment' ? 'pigment' : 'normal');
  try {
    const px = rr.render(b.x0, b.y0, scale, w, h);
    const c = new OffscreenCanvas(w, h);
    c.getContext('2d')!.putImageData(new ImageData(px, w, h), 0, 0);
    return await c.convertToBlob({ type: 'image/png' });
  } finally {
    rr.destroy();
  }
}

/** `b` grown by `pad` (a fraction of its larger side) on each side. */
export function padded(b: Bounds, pad: number): Bounds {
  const m = Math.max(b.x1 - b.x0, b.y1 - b.y0) * pad;
  return { x0: b.x0 - m, y0: b.y0 - m, x1: b.x1 + m, y1: b.y1 + m };
}

/** `b` grown to the aspect w / h, centered: renderPng then fills exactly w × h. */
export function toAspect(b: Bounds, w: number, h: number): Bounds {
  const bw = b.x1 - b.x0, bh = b.y1 - b.y0;
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
  const tw = Math.max(bw, (bh * w) / h), th = Math.max(bh, (bw * h) / w);
  return { x0: cx - tw / 2, y0: cy - th / 2, x1: cx + tw / 2, y1: cy + th / 2 };
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
