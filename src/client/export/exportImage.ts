// The large image export: a world rectangle at a chosen pixel size, rendered in pieces by an
// off-screen renderer and streamed into a PNG or a tiled (Big)TIFF file.

import type { Layer, MixMode, Paper, Shape, Stroke } from '../../shared/types';
import type { Bounds } from '../engine/doc';
import { PngWriter } from './png';
import { PIECE, RegionRenderer } from './region';
import { perfProfile } from '../engine/perf';
import type { Sink } from './sink';
import { TiffWriter } from './tiff';

export type ImageFormat = 'png' | 'tiff';

export interface ExportJob {
  layers: Layer[];
  strokes: Stroke[];
  shapes: Shape[];
  seq: number;
  bounds: Bounds;
  width: number;
  height: number;
  format: ImageFormat;
  /** No paper: the file keeps an alpha channel (RGBA PNG, or TIFF with unassociated alpha). */
  transparent: boolean;
  /** The canvas paper. A see-through paper also gives the file an alpha channel. */
  paper: Paper;
  /** How paint mixes (pigment: as real paint). */
  mix: MixMode;
  sink: Sink;
  /** done: 0..1; piece: pieces rendered so far, of about `pieces` (their size adapts). */
  onProgress: (done: number, piece: number, pieces: number) => void;
  /** The renderer is about to take in the drawing (before any piece). */
  onPrepare?: () => void;
  /** Tiles drawn so far for the piece in progress (a first piece draws many). */
  onTiles?: (tiles: number) => void;
  /** Called once all pieces are in, while the file is finished and checked. */
  onFinishing?: () => void;
  signal: AbortSignal;
}

/**
 * Rows per PNG band: as many as fit in BAND_BYTES (width × rows × 4 bytes in memory, and about as
 * much again while the band compresses), from 256 up to PIECE. Tall bands mean few pieces: every
 * piece renders its kaleidoscope copies and effect frames again, so 256-row strips made a large
 * export many times slower.
 */
const BAND_BYTES = 64 * 2 ** 20;
const bandRows = (width: number) => Math.max(256, Math.min(PIECE, Math.floor(BAND_BYTES / (width * 4) / 256) * 256));

/** Smallest piece: a heavy piece halves down to this (a multiple of the TIFF tile). */
const MIN_PIECE = 256;
/** Tries of a smallest piece after lost contexts. */
const TRIES = 3;

/**
 * The piece size a device starts with, and how long a piece may take before the next ones get
 * smaller (ms). A slow device starts small: its first piece also draws every tile.
 */
function pieceBudget(): { start: number; slowMs: number } {
  const p = perfProfile(null).name;
  if (p === 'full') return { start: PIECE, slowMs: 4000 };
  if (p === 'phone') return { start: 1024, slowMs: 2000 };
  return { start: 512, slowMs: 1500 };
}

/** Lets the page paint (progress bar, cancel button) between pieces. */
const breathe = () => new Promise((r) => setTimeout(r, 0));

/** Waits until the page has painted (a status shown before heavy work), or 100 ms when hidden. */
const painted = () =>
  new Promise<void>((r) => {
    const t = setTimeout(r, 100);
    requestAnimationFrame(() => setTimeout(() => (clearTimeout(t), r()), 0));
  });

/** The file keeps an alpha channel: no paper, or a see-through paper. */
export const hasAlpha = (transparent: boolean, paper: Paper) => transparent || paper.alpha < 1;

export async function exportImage(job: ExportJob): Promise<void> {
  const { bounds, width, height, sink, signal } = job;
  const scale = width / (bounds.x1 - bounds.x0);
  // "Preparing" shows before the renderer takes in the drawing.
  job.onPrepare?.();
  await painted();
  const make = () => new RegionRenderer(job.layers, job.strokes, job.seq, job.shapes, job.transparent, job.paper, job.mix);
  let rr = make();
  const alpha = hasAlpha(job.transparent, job.paper);
  const at = (px: number, py: number): [number, number] => [bounds.x0 + px / scale, bounds.y0 + py / scale];

  // Pieces adapt to the device: a piece slower than slowMs makes the next ones half the size (down
  // to MIN_PIECE), a fast one lets them grow back. A piece that loses the graphics context (the
  // GPU reset: too much work at once) renders again as four, with a new renderer. Pieces start at
  // multiples of their size, so they stay whole TIFF tiles.
  const budget = pieceBudget();
  let size = Math.min(PIECE, budget.start);
  let done = 0, count = 0;
  const total = width * height;
  type Put = (px: Uint8ClampedArray, x: number, y: number, w: number, h: number) => Promise<void> | void;
  const piece = async (x: number, y: number, w: number, h: number, put: Put, tries = 1): Promise<void> => {
    const t = performance.now();
    let px: Uint8ClampedArray;
    try {
      px = await rr.renderAsync(...at(x, y), scale, w, h, { signal, onTiles: (n) => job.onTiles?.(n) });
    } catch (e) {
      if (!/context was lost/.test((e as Error).message)) throw e;
      rr.destroy();
      rr = make();
      if (w > MIN_PIECE || h > MIN_PIECE) {
        // Halves (sizes stay powers of 2 times MIN_PIECE) until the piece splits.
        do size = Math.max(MIN_PIECE, size / 2);
        while (size >= Math.max(w, h) && size > MIN_PIECE);
        return area(x, y, w, h, put);
      }
      if (tries >= TRIES) throw e;
      return piece(x, y, w, h, put, tries + 1);
    }
    const ms = performance.now() - t;
    if (ms > budget.slowMs) size = Math.max(MIN_PIECE, size / 2);
    else if (ms < budget.slowMs / 8 && w >= size && h >= size) size = Math.min(budget.start, size * 2);
    await put(px, x, y, w, h);
    done += w * h;
    count++;
    job.onProgress(done / total, count, count + Math.ceil((total - done) / (size * size)));
    await breathe();
    if (signal.aborted) throw new DOMException('cancelled', 'AbortError');
  };
  /** Renders the w × h px at (x, y) of the image in pieces of the size at that moment. */
  const area = async (x: number, y: number, w: number, h: number, put: Put): Promise<void> => {
    if (w <= size && h <= size) return piece(x, y, w, h, put);
    for (let yy = y; yy < y + h; ) {
      const hh = Math.min(size, y + h - yy);
      for (let xx = x; xx < x + w; ) {
        const ww = Math.min(size, x + w - xx);
        await area(xx, yy, ww, hh, put);
        xx += ww;
      }
      yy += hh;
    }
  };

  try {
    if (job.format === 'png') {
      const band = bandRows(width);
      const png = new PngWriter(sink, width, height, alpha);
      await png.begin();
      const strip = new Uint8ClampedArray(width * band * 4);
      for (let y = 0; y < height; y += band) {
        const h = Math.min(band, height - y);
        // Pieces go into the band; the band into the file.
        await area(0, y, width, h, (px, x, py, w, ph) => {
          for (let r = 0; r < ph; r++) strip.set(px.subarray(r * w * 4, (r + 1) * w * 4), ((py - y + r) * width + x) * 4);
        });
        await png.addRows(strip, h);
      }
      job.onFinishing?.();
      await png.end();
    } else {
      const tiff = new TiffWriter(sink, width, height, alpha);
      await tiff.begin();
      // Pieces are whole TIFF tiles (their sizes and corners are multiples of TIFF_TILE).
      await area(0, 0, width, height, (px, x, y, w, h) => tiff.addPiece(px, x, y, w, h));
      job.onFinishing?.();
      await tiff.end();
    }
    await sink.close();
  } catch (e) {
    if ((e as Error).name !== 'NotSavedError') await sink.abort();
    throw e;
  } finally {
    rr.destroy();
  }
}

/** A rough upper bound of the file size (drawings compress far better than this). */
export function rawSize(width: number, height: number, alpha = false): number {
  return width * height * (alpha ? 4 : 3);
}
