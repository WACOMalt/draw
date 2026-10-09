// The large image export: a world rectangle at a chosen pixel size, rendered in pieces by an
// off-screen renderer and streamed into a PNG or a tiled (Big)TIFF file.

import type { Layer, Shape, Stroke } from '../../shared/types';
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
  sink: Sink;
  /** done: 0..1; piece: pieces rendered so far, of `pieces`. */
  onProgress: (done: number, piece: number, pieces: number) => void;
  /** Called once all pieces are in, while the file is finished and checked. */
  onFinishing?: () => void;
  signal: AbortSignal;
}

/** Rows per PNG strip: a strip is width × STRIP × 4 bytes in memory. */
const STRIP = 256;

/** Lets the page paint (progress bar, cancel button) between pieces. */
const breathe = () => new Promise((r) => setTimeout(r, 0));

export async function exportImage(job: ExportJob): Promise<void> {
  const { bounds, width, height, sink, signal } = job;
  const scale = width / (bounds.x1 - bounds.x0);
  const rr = new RegionRenderer(job.layers, job.strokes, job.seq, job.shapes);
  const at = (px: number, py: number): [number, number] => [bounds.x0 + px / scale, bounds.y0 + py / scale];
  let piece = 0;
  try {
    if (job.format === 'png') {
      const pieces = Math.ceil(height / STRIP) * Math.ceil(width / PIECE);
      const png = new PngWriter(sink, width, height);
      await png.begin();
      const strip = new Uint8ClampedArray(width * STRIP * 4);
      for (let y = 0; y < height; y += STRIP) {
        const h = Math.min(STRIP, height - y);
        for (let x = 0; x < width; x += PIECE) {
          if (signal.aborted) throw new DOMException('cancelled', 'AbortError');
          const w = Math.min(PIECE, width - x);
          const px = rr.render(...at(x, y), scale, w, h);
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
      const tiff = new TiffWriter(sink, width, height);
      await tiff.begin();
      // Pieces are whole tiles (PIECE is a multiple of TIFF_TILE).
      for (let y = 0; y < height; y += PIECE) {
        const h = Math.min(PIECE, height - y);
        for (let x = 0; x < width; x += PIECE) {
          if (signal.aborted) throw new DOMException('cancelled', 'AbortError');
          const w = Math.min(PIECE, width - x);
          const px = rr.render(...at(x, y), scale, w, h);
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
export function rawSize(width: number, height: number): number {
  return width * height * 3;
}

