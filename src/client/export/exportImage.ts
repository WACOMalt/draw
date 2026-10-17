// The large image export: a world rectangle at a chosen pixel size, rendered in pieces by an
// off-screen renderer and streamed into a PNG or a tiled (Big)TIFF file.

import type { Layer, MixMode, Paper, Shape, Stroke } from '../../shared/types';
import type { Bounds } from '../engine/doc';
import { PngWriter } from './png';
import { PIECE, RegionRenderer } from './region';
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
  /** done: 0..1; piece: pieces rendered so far, of `pieces`. */
  onProgress: (done: number, piece: number, pieces: number) => void;
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

/** Tries per piece: a lost graphics context (the GPU reset) gets a new renderer and another go. */
const TRIES = 3;

/** Lets the page paint (progress bar, cancel button) between pieces. */
const breathe = () => new Promise((r) => setTimeout(r, 0));

/** The file keeps an alpha channel: no paper, or a see-through paper. */
export const hasAlpha = (transparent: boolean, paper: Paper) => transparent || paper.alpha < 1;

export async function exportImage(job: ExportJob): Promise<void> {
  const { bounds, width, height, sink, signal } = job;
  const scale = width / (bounds.x1 - bounds.x0);
  const make = () => new RegionRenderer(job.layers, job.strokes, job.seq, job.shapes, job.transparent, job.paper, job.mix);
  let rr = make();
  /** A piece; after a lost context (a very heavy piece can make the GPU reset), with a new renderer. */
  const render = (x: number, y: number, w: number, h: number) => {
    for (let i = 1; ; i++) {
      try {
        return rr.render(...at(x, y), scale, w, h);
      } catch (e) {
        if (i >= TRIES || !/context was lost/.test((e as Error).message)) throw e;
        rr.destroy();
        rr = make();
      }
    }
  };
  const alpha = hasAlpha(job.transparent, job.paper);
  const at = (px: number, py: number): [number, number] => [bounds.x0 + px / scale, bounds.y0 + py / scale];
  let piece = 0;
  try {
    if (job.format === 'png') {
      const band = bandRows(width);
      const pieces = Math.ceil(height / band) * Math.ceil(width / PIECE);
      const png = new PngWriter(sink, width, height, alpha);
      await png.begin();
      const strip = new Uint8ClampedArray(width * band * 4);
      for (let y = 0; y < height; y += band) {
        const h = Math.min(band, height - y);
        for (let x = 0; x < width; x += PIECE) {
          if (signal.aborted) throw new DOMException('cancelled', 'AbortError');
          const w = Math.min(PIECE, width - x);
          const px = render(x, y, w, h);
          for (let r = 0; r < h; r++) strip.set(px.subarray(r * w * 4, (r + 1) * w * 4), (r * width + x) * 4);
          job.onProgress((y * width + (x + w) * h) / (width * height), ++piece, pieces);
          await breathe();
        }
        await png.addRows(strip, h);
      }
      job.onFinishing?.();
      await png.end();
    } else {
      const pieces = Math.ceil(height / PIECE) * Math.ceil(width / PIECE);
      const tiff = new TiffWriter(sink, width, height, alpha);
      await tiff.begin();
      // Pieces are whole tiles (PIECE is a multiple of TIFF_TILE).
      for (let y = 0; y < height; y += PIECE) {
        const h = Math.min(PIECE, height - y);
        for (let x = 0; x < width; x += PIECE) {
          if (signal.aborted) throw new DOMException('cancelled', 'AbortError');
          const w = Math.min(PIECE, width - x);
          const px = render(x, y, w, h);
          await tiff.addPiece(px, x, y, w, h);
          job.onProgress((y * width + (x + w) * h) / (width * height), ++piece, pieces);
          await breathe();
        }
      }
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

