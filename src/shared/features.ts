// Which newer document features a canvas uses. The server lists them in `welcome`; a client
// that does not know one of them asks for an update instead of drawing the canvas wrong.

import { isDefaultPaper, type Brush, type DocFeature, type Layer, type MixMode, type Paper, type Shape, type Stroke } from './types';

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

/** Features of a shape's geometry and style (also of a part, or of a vector stroke). */
function shapeFeatures(s: Partial<Pick<Shape, 'kind' | 'arc' | 'hole' | 'dash' | 'arrows' | 'curve' | 'fillOpacity' | 'strokeOpacity'>>, f: Set<DocFeature>): void {
  if (s.kind === 'path') f.add('paths');
  if (s.curve === 'spline') f.add('splines');
  if (s.kind === 'custom') f.add('custom');
  if (s.arc || s.hole) f.add('arcs');
  if (s.dash?.some((d) => d > 0)) f.add('dashes');
  if (s.arrows?.some((a) => a !== 'none')) f.add('arrows');
  if ((s.fillOpacity ?? 1) < 1 || (s.strokeOpacity ?? 1) < 1) f.add('shapeAlpha');
}

export function docFeatures(layers: Iterable<Layer>, strokes: Iterable<Stroke>, shapes: Iterable<Shape> = [], paper?: Paper, mix?: MixMode): DocFeature[] {
  const f = new Set<DocFeature>();
  if (paper && !isDefaultPaper(paper)) f.add('paper');
  if (mix === 'pigment') f.add('pigment');
  for (const l of layers) {
    if (l.deleted) continue;
    if (l.kind === 'adjust') f.add('adjust');
    if (l.clip) f.add('clip');
    if (l.mask) f.add('mask');
    if (l.kind === 'group' || l.parent) f.add('groups');
    if (l.kind === 'shape') f.add('shapes');
    if (l.effects?.length) f.add('effects');
    if (l.adjust?.type === 'blur') f.add('blur');
    if (l.threed) f.add('threed');
  }
  for (const s of strokes) {
    if (s.deleted) continue;
    if (s.mask) f.add('mask');
    if (brushHasDynamics(s.brush)) f.add('tips');
    if (s.threed) f.add('threed');
    if (!s.vector) continue;
    f.add('vectors');
    for (const g of [s.vector, ...(s.vector.parts ?? [])]) shapeFeatures(g, f);
    if (s.vector.kind === 'compound') f.add('compounds');
  }
  for (const s of shapes) {
    if (s.deleted) continue;
    if (s.kind === 'compound') f.add('compounds');
    for (const g of [s, ...(s.parts ?? [])]) shapeFeatures(g, f);
  }
  return [...f];
}
