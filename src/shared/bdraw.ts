// .bdraw: a canvas saved to a file.
//
// The body is the document exactly as the server sends it in `welcome` (Layer[], Stroke[] and
// Shape[], the types in types.ts), plus a small header. The file is gzip-compressed JSON; plain
// JSON is accepted too. Saving writes the client's confirmed state; loading makes a new online
// canvas and replays the file as layer.add, stroke.add and shape.add ops, through the same
// checks as live ops.

import type { Layer, Shape, Stroke } from './types';

export const BDRAW_EXT = 'bdraw';
export const BDRAW_MIME = 'application/x-bdraw';
/**
 * 2: layers may have adjust, clip and mask; strokes may have mask and brush dynamics.
 * 3: shape layers and `shapes`. 4: paths (kind 'path') and vector strokes (`vector`). A file is
 * written with the lowest version that holds it, so older servers accept what they can read.
 */
export const BDRAW_VERSION = 4;

export interface BdrawFile {
  format: 'bdraw';
  version: number;
  /** Draw version that wrote the file. */
  app: string;
  savedAt: string; // ISO 8601
  /**
   * A PNG data URL of the drawing (everything on the visible layers, fitted into 512 px), for
   * file manager thumbnails. Information only. It stays near the start of the file, so the
   * Linux thumbnailer finds it without reading the whole document.
   */
  preview?: string;
  /** The online canvas the file came from. Information only: loading always makes a new canvas. */
  source?: { key: string; url: string };
  /** Bottom to top by `order`. Deleted layers are left out. */
  layers: Layer[];
  /** In draw order (`seq`). Erased strokes and strokes on deleted layers are left out. */
  strokes: Stroke[];
  /** Version 3. Bottom to top by `z`. Deleted shapes and shapes on deleted layers are left out. */
  shapes?: Shape[];
}

export function makeBdraw(
  layers: Iterable<Layer>,
  strokes: Iterable<Stroke>,
  app: string,
  source?: BdrawFile['source'],
  preview?: string,
  shapes: Iterable<Shape> = [],
): BdrawFile {
  const live = [...layers].filter((l) => !l.deleted).sort((a, b) => a.order - b.order);
  const ids = new Set(live.map((l) => l.id));
  const liveShapes = [...shapes].filter((s) => !s.deleted && ids.has(s.layerId)).sort((a, b) => a.z - b.z);
  const liveStrokes = [...strokes].filter((s) => !s.deleted && ids.has(s.layerId)).sort((a, b) => a.seq - b.seq);
  return {
    format: 'bdraw',
    version: liveShapes.some((s) => s.kind === 'path') || liveStrokes.some((s) => s.vector) ? 4 : liveShapes.length || live.some((l) => l.kind === 'shape') ? 3 : 2,
    app,
    savedAt: new Date().toISOString(),
    ...(preview ? { preview } : {}),
    ...(source ? { source } : {}),
    layers: live,
    strokes: liveStrokes,
    ...(liveShapes.length ? { shapes: liveShapes } : {}),
  };
}

export const isGzip = (b: Uint8Array) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;
