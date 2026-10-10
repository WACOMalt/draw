// Draws brush preset thumbnails off the main thread: a preset with a rotating tip took most of a
// second on a phone, and the brush sheet froze while it opened.

import { drawThumb } from './presetThumbDraw';
import type { BrushSettings } from '../shared/types';

export interface ThumbJob {
  id: number;
  settings: BrushSettings;
  w: number;
  h: number;
  dpr: number;
}
export type ThumbResult = { id: number; blob: Blob } | { id: number; error: string };

self.onmessage = async (e: MessageEvent<ThumbJob>) => {
  const { id, settings, w, h, dpr } = e.data;
  try {
    (self as unknown as Worker).postMessage({ id, blob: await drawThumb(settings, w, h, dpr) } satisfies ThumbResult);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err) } satisfies ThumbResult);
  }
};
