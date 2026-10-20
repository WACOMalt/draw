// Walks strokes' dabs (brush.ts computeDabs) off the main thread: the dab lists of a canvas's
// strokes come from several cores at once, and the main thread keeps its frames (dabPool.ts).

import { computeDabs, type DabList } from '../../shared/brush';
import type { Brush } from '../../shared/types';

export interface DabJob {
  id: number;
  brush: Brush;
  pts: number[];
  seed: number;
}
export interface DabResult {
  id: number;
  list: DabList;
}

self.onmessage = (e: MessageEvent<DabJob[]>) => {
  const out: DabResult[] = [];
  const transfer: ArrayBuffer[] = [];
  for (const j of e.data) {
    const list = computeDabs(j.brush, j.pts, j.seed);
    out.push({ id: j.id, list });
    transfer.push(list.dabs.buffer as ArrayBuffer, list.chunks.buffer as ArrayBuffer);
  }
  (self as unknown as Worker).postMessage(out, transfer);
};
