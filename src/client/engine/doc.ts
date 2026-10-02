// Client document: the confirmed state from the server, plus this client's ops that the
// server has not echoed yet. The UI shows confirmed state with pending layer ops on top.

import type { AppliedOp, Layer, Op, Stroke } from '../../shared/types';

export interface PendingOp {
  opId: string;
  op: Op;
}

function applyLayerOp(layers: Map<string, Layer>, op: Op | AppliedOp): boolean {
  switch (op.type) {
    case 'layer.add':
      layers.set(op.layer.id, { ...op.layer, deleted: false });
      return true;
    case 'layer.update': {
      const l = layers.get(op.id);
      if (l) layers.set(op.id, { ...l, ...op.props });
      return true;
    }
    case 'layer.remove':
    case 'layer.restore': {
      const l = layers.get(op.id);
      if (l) layers.set(op.id, { ...l, deleted: op.type === 'layer.remove' });
      return true;
    }
    default:
      return false;
  }
}

export function sortLayers(a: Layer, b: Layer): number {
  return a.order - b.order || (a.id < b.id ? -1 : 1);
}

export class Doc {
  seq = 0;
  layers = new Map<string, Layer>();
  strokes = new Map<string, Stroke>();
  pending: PendingOp[] = [];

  reset(seq: number, layers: Layer[], strokes: Stroke[]): void {
    this.seq = seq;
    this.layers = new Map(layers.map((l) => [l.id, l]));
    this.strokes = new Map(strokes.map((s) => [s.id, s]));
  }

  addPending(opId: string, op: Op): void {
    this.pending.push({ opId, op });
  }

  dropPending(opId: string): PendingOp | null {
    const i = this.pending.findIndex((p) => p.opId === opId);
    if (i < 0) return null;
    return this.pending.splice(i, 1)[0];
  }

  /** Applies a server op to the confirmed state. */
  apply(seq: number, op: AppliedOp): void {
    this.seq = seq;
    switch (op.type) {
      case 'stroke.add':
      case 'stroke.restore':
        this.strokes.set(op.stroke.id, { ...op.stroke, deleted: false });
        break;
      case 'stroke.remove':
        this.strokes.delete(op.id);
        break;
      default:
        applyLayerOp(this.layers, op);
    }
  }

  /** Layers as the user sees them, bottom to top, without deleted ones. */
  displayLayers(): Layer[] {
    const view = new Map(this.layers);
    for (const p of this.pending) applyLayerOp(view, p.op);
    return [...view.values()].filter((l) => !l.deleted).sort(sortLayers);
  }

  /** Every layer including deleted ones, with pending ops applied. Used for undo bookkeeping. */
  layer(id: string): Layer | undefined {
    const view = new Map<string, Layer>();
    const base = this.layers.get(id);
    if (base) view.set(id, base);
    for (const p of this.pending) if ('id' in p.op ? p.op.id === id : p.op.type === 'layer.add' && p.op.layer.id === id) applyLayerOp(view, p.op);
    return view.get(id);
  }
}
