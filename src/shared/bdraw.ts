// .bdraw: a canvas saved to a file.
//
// The body is the document exactly as the server sends it in `welcome` (Layer[] and Stroke[],
// the types in types.ts), plus a small header. The file is gzip-compressed JSON; plain JSON is
// accepted too. Saving writes the client's confirmed state; loading makes a new online canvas
// and replays the file as layer.add and stroke.add ops, through the same checks as live ops.

import type { Layer, Stroke } from './types';

export const BDRAW_EXT = 'bdraw';
export const BDRAW_MIME = 'application/x-bdraw';
export const BDRAW_VERSION = 1;

export interface BdrawFile {
  format: 'bdraw';
  version: number;
  /** Draw version that wrote the file. */
  app: string;
  savedAt: string; // ISO 8601
  /** The online canvas the file came from. Information only: loading always makes a new canvas. */
  source?: { key: string; url: string };
  /** Bottom to top by `order`. Deleted layers are left out. */
  layers: Layer[];
  /** In draw order (`seq`). Erased strokes and strokes on deleted layers are left out. */
  strokes: Stroke[];
}

export function makeBdraw(layers: Iterable<Layer>, strokes: Iterable<Stroke>, app: string, source?: BdrawFile['source']): BdrawFile {
  const live = [...layers].filter((l) => !l.deleted).sort((a, b) => a.order - b.order);
  const ids = new Set(live.map((l) => l.id));
  return {
    format: 'bdraw',
    version: BDRAW_VERSION,
    app,
    savedAt: new Date().toISOString(),
    ...(source ? { source } : {}),
    layers: live,
    strokes: [...strokes].filter((s) => !s.deleted && ids.has(s.layerId)).sort((a, b) => a.seq - b.seq),
  };
}

export const isGzip = (b: Uint8Array) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;
