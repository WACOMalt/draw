// Which newer document features a canvas uses. The server lists them in `welcome`; a client
// that does not know one of them asks for an update instead of drawing the canvas wrong.

import type { Brush, DocFeature, Layer, Stroke } from './types';

/** True when the brush draws differently from the plain round brush of older clients. */
export function brushHasDynamics(b: Brush): boolean {
  return (
    (b.tip !== undefined && b.tip !== 'round') ||
    (b.roundness !== undefined && b.roundness < 1) ||
    !!b.sizeJitter ||
    !!b.angleJitter ||
    !!b.scatter ||
    !!b.opacityJitter ||
    !!b.grain
  );
}

export function docFeatures(layers: Iterable<Layer>, strokes: Iterable<Stroke>): DocFeature[] {
  const f = new Set<DocFeature>();
  for (const l of layers) {
    if (l.deleted) continue;
    if (l.kind === 'adjust') f.add('adjust');
    if (l.clip) f.add('clip');
    if (l.mask) f.add('mask');
    if (l.kind === 'group' || l.parent) f.add('groups');
  }
  for (const s of strokes) {
    if (s.deleted) continue;
    if (s.mask) f.add('mask');
    if (brushHasDynamics(s.brush)) f.add('tips');
    if (f.size === 5) break;
  }
  return [...f];
}
