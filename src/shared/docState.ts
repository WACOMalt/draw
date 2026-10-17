// A canvas document and the rules of its ops: what an op may do to the current state, and what
// it changes. The server (session.ts) and offline canvases on the device (client/local) both
// use it, so an op means the same in both places.

import {
  DEFAULT_PAPER,
  LIMITS,
  type AppliedOp,
  type Affine3,
  type Paper,
  type MixMode,
  type Layer,
  type Op,
  type Shape,
  type ShapeInput,
  type Stroke,
} from './types';
import { ValidationError, validateOp, validateShapeInput } from './validate';
import { transformShapeMatrix } from './shapes';
import { planFromPaint, planToPaint } from './flatten';
import { depthOf, duplicateOf, effectivelyDeleted, flatAffine, subtreeHeight, subtreeIds, transformStroke, transformStroke3 } from './layers';
import { takesEffects, transformLayerLengths } from './effects';

/** An op that does not make sense for the current state (the client is told why). */
export class OpError extends Error {}

export class DocState {
  layers = new Map<string, Layer>();
  strokes = new Map<string, Stroke>();
  shapes = new Map<string, Shape>();
  paper: Paper = { ...DEFAULT_PAPER };
  mix: MixMode = 'normal';

  /** Replays a persisted op. No checks: the op passed them when it was first accepted. */
  applyStored(op: AppliedOp, by: string, seq: number): void {
    try {
      this.apply(op as Op, by, seq);
    } catch {
      // A bad historic op must not make the whole session unloadable.
    }
  }

  /** Mutates state. Throws OpError when the op does not make sense for the current state. */
  apply(op: Op, by: string, seq: number): AppliedOp {
    switch (op.type) {
      case 'stroke.add': {
        const layer = this.layers.get(op.stroke.layerId);
        if (!layer || effectivelyDeleted(this.layers, layer)) throw new OpError('no such layer');
        if (layer.kind === 'group') throw new OpError('groups hold no paint');
        if (layer.kind === 'adjust' && !op.stroke.mask) throw new OpError('adjustment layers hold no paint');
        if (layer.kind === 'shape' && !op.stroke.mask) throw new OpError('shape layers hold shapes, not paint');
        if (this.strokes.has(op.stroke.id)) throw new OpError('duplicate stroke');
        const stroke: Stroke = { ...op.stroke, seq, author: by };
        this.strokes.set(stroke.id, stroke);
        return { type: 'stroke.add', stroke };
      }
      case 'stroke.remove': {
        const s = this.strokes.get(op.id);
        if (!s || s.deleted) throw new OpError('no such stroke');
        s.deleted = true;
        return op;
      }
      case 'stroke.restore': {
        const s = this.strokes.get(op.id);
        if (!s || !s.deleted) throw new OpError('stroke not deleted');
        delete s.deleted;
        return { type: 'stroke.restore', id: op.id, stroke: s };
      }
      case 'layer.add': {
        if (this.layers.has(op.layer.id)) throw new OpError('duplicate layer');
        if (this.liveLayers() >= LIMITS.maxLayers) throw new OpError('too many layers');
        this.checkParent(op.layer.parent ?? null, op.layer.kind === 'group' ? 1 : 0);
        const { effects, ...layer } = op.layer;
        if (effects?.length && !takesEffects(layer.kind)) throw new OpError('adjustment layers take no effects');
        this.layers.set(op.layer.id, { ...layer, ...(effects?.length ? { effects } : {}), deleted: false });
        return op;
      }
      case 'layer.update': {
        const l = this.layers.get(op.id);
        if (!l) throw new OpError('no such layer');
        if (op.props.blend === 'pass' && l.kind !== 'group') throw new OpError('pass through is for groups');
        if (op.props.parent !== undefined && op.props.parent !== (l.parent ?? null)) {
          if (op.props.parent && subtreeIds(this.layers.values(), l.id).has(op.props.parent)) throw new OpError('a group cannot go into itself');
          this.checkParent(op.props.parent, subtreeHeight(this.layers.values(), l.id));
        }
        if (op.props.effects && !takesEffects(l.kind)) throw new OpError('adjustment layers take no effects');
        if (op.props.vr && (l.kind ?? 'paint') !== 'paint') throw new OpError('vr layers are paint layers');
        Object.assign(l, op.props);
        if (l.parent === null) delete l.parent;
        if (!l.effects?.length) delete l.effects;
        if (!l.vr) delete l.vr;
        return op;
      }
      case 'layer.transform': {
        const l = this.layers.get(op.id);
        if (!l || effectivelyDeleted(this.layers, l)) throw new OpError('no such layer');
        if ('m3' in op) {
          this.transform3(l, op.m3);
          return op;
        }
        const ids = subtreeIds(this.layers.values(), l.id);
        const changes: [Stroke, Pick<Stroke, 'pts' | 'brush' | 'vector' | 'vr'>][] = [];
        for (const st of this.strokes.values()) {
          if (!ids.has(st.layerId)) continue;
          const t = transformStroke(st, op.m, LIMITS.maxCoord, [LIMITS.minBrushWorld, LIMITS.maxBrushWorld]);
          if (!t) throw new OpError('the transform goes out of range');
          changes.push([st, t]);
        }
        const moved: [Shape, Shape['m']][] = [];
        for (const sh of this.shapes.values()) {
          if (!ids.has(sh.layerId)) continue;
          const m = transformShapeMatrix(sh, op.m, LIMITS.maxCoord);
          if (!m) throw new OpError('the transform goes out of range');
          moved.push([sh, m]);
        }
        for (const [st, t] of changes) Object.assign(st, t);
        for (const [sh, m] of moved) sh.m = m;
        // Effect lengths and blur radii scale with the layers.
        for (const lid of ids) {
          const x = this.layers.get(lid);
          if (x) this.layers.set(lid, transformLayerLengths(x, op.m));
        }
        return op;
      }
      case 'layer.duplicate': {
        const src = this.layers.get(op.id);
        if (!src || effectivelyDeleted(this.layers, src)) throw new OpError('no such layer');
        if (this.layers.has(op.newId)) throw new OpError('duplicate layer');
        this.checkParent(op.parent, subtreeHeight(this.layers.values(), src.id));
        const copy = duplicateOf(this.layers, this.strokes.values(), op, this.shapes.values());
        if (this.liveLayers() + copy.layers.length > LIMITS.maxLayers) throw new OpError('too many layers');
        if (this.liveShapes() + copy.shapes.length > LIMITS.maxShapes) throw new OpError('too many shapes');
        if (copy.layers.some((l) => this.layers.has(l.id)) || copy.strokes.some((st) => this.strokes.has(st.id)) || copy.shapes.some((sh) => this.shapes.has(sh.id))) {
          throw new OpError('duplicate ids');
        }
        for (const l of copy.layers) this.layers.set(l.id, l);
        for (const st of copy.strokes) this.strokes.set(st.id, st);
        for (const sh of copy.shapes) this.shapes.set(sh.id, sh);
        return op;
      }
      case 'shape.add': {
        this.shapeLayer(op.shape.layerId);
        if (this.shapes.has(op.shape.id)) throw new OpError('duplicate shape');
        if (this.liveShapes() >= LIMITS.maxShapes) throw new OpError('too many shapes');
        const shape: Shape = { ...op.shape, author: by, seq };
        this.shapes.set(shape.id, shape);
        return { type: 'shape.add', shape };
      }
      case 'shape.update': {
        const old = this.shapes.get(op.id);
        if (!old || old.deleted) throw new OpError('no such shape');
        const { author, seq: added, deleted: _d, ...input } = old;
        // The result must be a whole, valid shape of its kind (throws ValidationError if not).
        const next = validateShapeInput({ ...input, ...op.props } satisfies ShapeInput);
        this.shapes.set(op.id, { ...next, author, seq: added });
        return op;
      }
      case 'shape.remove': {
        const sh = this.shapes.get(op.id);
        if (!sh || sh.deleted) throw new OpError('no such shape');
        sh.deleted = true;
        return op;
      }
      case 'shape.restore': {
        const sh = this.shapes.get(op.id);
        if (!sh || !sh.deleted) throw new OpError('shape not deleted');
        if (this.liveShapes() >= LIMITS.maxShapes) throw new OpError('too many shapes');
        delete sh.deleted;
        return { type: 'shape.restore', id: op.id, shape: sh };
      }
      case 'shapes.toPaint': {
        const plan = planToPaint(this.layers, this.strokes, this.shapes, op, seq, by);
        if ('error' in plan) throw new OpError(plan.error);
        for (const st of plan.strokes) this.strokes.set(st.id, st);
        for (const id of plan.shapes) this.shapes.get(id)!.deleted = true;
        if (plan.kind) this.layers.get(op.layerId)!.kind = plan.kind;
        return op;
      }
      case 'shapes.fromPaint': {
        const plan = planFromPaint(this.layers, this.strokes, this.shapes, op);
        if ('error' in plan) throw new OpError(plan.error);
        if (this.liveShapes() + plan.shapes.length > LIMITS.maxShapes) throw new OpError('too many shapes');
        for (const id of plan.strokes) this.strokes.get(id)!.deleted = true;
        for (const id of plan.shapes) delete this.shapes.get(id)!.deleted;
        if (plan.kind) this.layers.get(op.layerId)!.kind = plan.kind;
        return op;
      }
      case 'mix.set':
        this.mix = op.mix;
        return op;
      case 'paper.set':
        this.paper = { ...op.paper };
        return op;
      case 'layer.remove': {
        const l = this.layers.get(op.id);
        if (!l || l.deleted) throw new OpError('no such layer');
        l.deleted = true;
        return op;
      }
      case 'layer.restore': {
        const l = this.layers.get(op.id);
        if (!l || !l.deleted) throw new OpError('layer not deleted');
        l.deleted = false;
        return op;
      }
    }
  }

  /**
   * A 3D transform of the VR layer `l` (layer.transform with m3): every stroke of it moves in
   * 3D, masks and deleted ones too. Throws when the layer is not a VR layer or holds vector
   * strokes or shapes, or when the result goes out of range.
   */
  private transform3(l: Layer, m3: Affine3): void {
    if (!l.vr) throw new OpError('3D transforms are for VR layers');
    const changes: [Stroke, Pick<Stroke, 'pts' | 'brush' | 'vr'>][] = [];
    for (const st of this.strokes.values()) {
      if (st.layerId !== l.id) continue;
      if (st.vector) throw new OpError('a 3D transform cannot move vector strokes');
      const t = transformStroke3(st, m3, LIMITS.maxCoord, [LIMITS.minBrushWorld, LIMITS.maxBrushWorld]);
      if (!t) throw new OpError('the transform goes out of range');
      changes.push([st, t]);
    }
    for (const sh of this.shapes.values()) if (sh.layerId === l.id) throw new OpError('a 3D transform cannot move shapes');
    for (const [st, t] of changes) Object.assign(st, t);
    // Effect lengths scale with the layer (as the paper sees the transform).
    this.layers.set(l.id, transformLayerLengths(l, flatAffine(m3)));
  }

  /** Throws unless `id` is a live shape layer. */
  private shapeLayer(id: string): void {
    const l = this.layers.get(id);
    if (!l || effectivelyDeleted(this.layers, l)) throw new OpError('no such layer');
    if (l.kind !== 'shape') throw new OpError('shapes go on shape layers');
  }

  /** Shapes that count against the limit (deleted ones do not). */
  private liveShapes(): number {
    let n = 0;
    for (const sh of this.shapes.values()) if (!sh.deleted) n++;
    return n;
  }

  /** Layers that count against the limit: not deleted, and not inside a deleted group. */
  private liveLayers(): number {
    let n = 0;
    for (const l of this.layers.values()) if (!effectivelyDeleted(this.layers, l)) n++;
    return n;
  }

  /**
   * A layer that needs `height` levels below its place (subtreeHeight) may go into `parent`: a
   * live group, with everything within LIMITS.maxGroupDepth.
   */
  private checkParent(parent: string | null, height: number): void {
    if (!parent) return;
    const g = this.layers.get(parent);
    if (!g || g.kind !== 'group' || effectivelyDeleted(this.layers, g)) throw new OpError('no such group');
    if (depthOf(this.layers, g) + 1 + height > LIMITS.maxGroupDepth) throw new OpError('groups nested too deep');
  }

}

/**
 * Fills an empty document from a .bdraw file's arrays: layer.add (groups before the layers in
 * them), stroke.add in their order, then shape.add, each through validateOp and `commit`.
 * Entries that fail are skipped and counted.
 */
export function importOps(
  doc: DocState,
  layers: unknown[],
  strokes: unknown[],
  shapes: unknown[],
  commit: (op: Op, by: string) => void,
  paper?: unknown,
  mix?: unknown,
): { layers: number; strokes: number; shapes: number; skipped: number } {
  const n = { layers: 0, strokes: 0, shapes: 0, skipped: 0 };
  const tryCommit = (op: () => Op, by: string, kind: 'layers' | 'strokes' | 'shapes') => {
    try {
      commit(op(), by);
      n[kind]++;
    } catch (e) {
      if (e instanceof ValidationError || e instanceof OpError) n.skipped++;
      else throw e;
    }
  };
  const field = (v: unknown, k: string) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  // Groups before the layers in them: add what has its parent in place, round by round.
  let todo = layers.filter((l) => field(l, 'deleted') !== true);
  for (let round = 0; todo.length && round <= LIMITS.maxGroupDepth + 1; round++) {
    const later: unknown[] = [];
    for (const l of todo) {
      const parent = field(l, 'parent');
      if (typeof parent === 'string' && !doc.layers.has(parent) && todo.some((x) => field(x, 'id') === parent)) later.push(l);
      else tryCommit(() => validateOp({ type: 'layer.add', layer: l }), 'import', 'layers');
    }
    todo = later;
  }
  const ordered = [...strokes].sort((a, b) => num(field(a, 'seq')) - num(field(b, 'seq')));
  for (const st of ordered) {
    if (field(st, 'deleted') === true) continue;
    const author = field(st, 'author');
    const by = typeof author === 'string' && /^[\w-]{1,40}$/.test(author) ? author : 'import';
    tryCommit(() => validateOp({ type: 'stroke.add', stroke: st }), by, 'strokes');
  }
  for (const sh of shapes) {
    if (field(sh, 'deleted') === true) continue;
    const author = field(sh, 'author');
    const by = typeof author === 'string' && /^[\w-]{1,40}$/.test(author) ? author : 'import';
    tryCommit(() => validateOp({ type: 'shape.add', shape: sh }), by, 'shapes');
  }
  // The paper and the mix mode: a bad one is left out (the canvas keeps the default), not counted.
  const setting = (op: unknown) => {
    try {
      commit(validateOp(op), 'import');
    } catch (e) {
      if (!(e instanceof ValidationError || e instanceof OpError)) throw e;
    }
  };
  if (paper !== undefined) setting({ type: 'paper.set', paper });
  if (mix !== undefined && mix !== 'normal') setting({ type: 'mix.set', mix });
  return n;
}
