// Committed shapes by layer, in drawing order, with world bounds for culling. Used by the WebGL
// renderer (main thread) and the Canvas 2D tile worker.

import { byZ, shapeBounds } from '../../shared/shapes';
import type { Shape } from '../../shared/types';

export interface ShapeRec {
  shape: Shape;
  /** World bounds, the stroke included. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function shapeRec(shape: Shape): ShapeRec {
  const b = shapeBounds(shape);
  return { shape, x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 };
}

/** True when the record comes within `pad` of the box (pad: one target pixel, for anti-aliasing). */
export const shapeTouches = (r: ShapeRec, x0: number, y0: number, x1: number, y1: number, pad = 0) =>
  r.x1 > x0 - pad && r.x0 < x1 + pad && r.y1 > y0 - pad && r.y0 < y1 + pad;

export class ShapeIndex {
  readonly recs = new Map<string, ShapeRec>();
  /** By layer, bottom to top. Sorted on first use after a change. */
  private byLayer = new Map<string, ShapeRec[]>();
  private unsorted = new Set<string>();

  clear(): void {
    this.recs.clear();
    this.byLayer.clear();
    this.unsorted.clear();
  }

  /** Adds or replaces a shape (deleted shapes are removed). Returns the old and the new record. */
  put(shape: Shape): { old: ShapeRec | null; rec: ShapeRec | null } {
    const old = this.remove(shape.id);
    if (shape.deleted) return { old, rec: null };
    const rec = shapeRec(shape);
    this.recs.set(shape.id, rec);
    let list = this.byLayer.get(shape.layerId);
    if (!list) this.byLayer.set(shape.layerId, (list = []));
    list.push(rec);
    this.unsorted.add(shape.layerId);
    return { old, rec };
  }

  remove(id: string): ShapeRec | null {
    const rec = this.recs.get(id);
    if (!rec) return null;
    this.recs.delete(id);
    const list = this.byLayer.get(rec.shape.layerId);
    if (list) {
      const i = list.indexOf(rec);
      if (i >= 0) list.splice(i, 1);
    }
    return rec;
  }

  /** The shapes of a layer, bottom to top. */
  layer(id: string): ShapeRec[] {
    const list = this.byLayer.get(id);
    if (!list) return [];
    if (this.unsorted.delete(id)) list.sort((a, b) => byZ(a.shape, b.shape));
    return list;
  }
}
