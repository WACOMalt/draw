// The Select tool (V) and the Shapes tool (U).
//
// Select, on shapes (Figma-like). The rules keep the selection from changing by accident:
// - Hover outlines the shape a click would select, with its name.
// - With a selection, a press anywhere inside its box moves it, even over other shapes. Handles
//   scale; a press just outside a corner rotates; the dots inside a rectangle's corners change
//   its radius. The cursor shows which.
// - A click on a shape outside the box selects it; Shift+click adds or removes it. A drag on empty
//   canvas selects by rectangle. A click on empty canvas deselects, unless "Keep selection" is on.
//   Esc deselects. A double-click (or Enter) is kept for point editing (phase 2).
// On a paint layer or a group, Select shows the layer transform instead (engine.ts).
//
// Shapes: a drag draws a shape of ed.shapeKind (Shift: square or upright; Alt: from the center),
// a click makes one 100 px shape. It goes into the active shape layer, or a new one above.
//
// While a shape changes, the change is a draft: the renderer draws it (renderer.ts
// setShapeDrafts), other people see it through shape.live messages, and one op per shape goes
// out when the pointer lifts. One drag is one undo step.

import { newId } from '../../shared/ids';
import { compose, effectivelyVisible, invert } from '../../shared/layers';
import { byZ, clipPolygon, compoundToPath, cornerPoints, fitPathFrame, hitShape, outlinePolys, shapeBounds, stripForKind, toPath, type Box } from '../../shared/shapes';
import { OP_NAME, fitCompoundFrame, partOf, partShape, splitPartId, withPart } from '../../shared/compound';
import {
  LIMITS,
  POINT_STRIDE,
  type Affine,
  type ClientMsg,
  type CompoundOp,
  type CompoundPart,
  type CustomShape,
  type Layer,
  type Op,
  type PathContour,
  type Shape,
  type ShapeInput,
  type ShapeKind,
  type ShapeProps,
  type ShapeUpdate,
} from '../../shared/types';
import {
  CORNER,
  SMOOTH,
  SYMMETRIC,
  bezierToSpline,
  clonePath,
  setSmoothness,
  smoothOf,
  toggleSplinePoint,
  allKeys,
  count,
  getPt,
  insertPoint,
  keyOf,
  moveAnchors,
  nearestOnPath,
  parseKey,
  removePoints,
  setHandle,
  setType,
  toggleSmooth,
  type PKey,
} from './pathEdit';
import { ed, showToast, type SelectOverlay } from '../state.svelte';
import type { Doc } from './doc';
import type { Renderer } from './renderer';

export const SHAPE_LABEL: Record<ShapeKind, string> = { rect: 'Rectangle', ellipse: 'Ellipse', polygon: 'Polygon', star: 'Star', line: 'Line', path: 'Path', compound: 'Compound', custom: 'Custom shape' };
export const CUSTOM_LABEL: Record<CustomShape, string> = {
  heart: 'Heart',
  bubble: 'Speech bubble',
  arrow: 'Block arrow',
  cloud: 'Cloud',
  check: 'Check',
  bolt: 'Lightning',
  moon: 'Moon',
  drop: 'Drop',
  plus: 'Plus',
  banner: 'Banner',
  burst: 'Burst',
  frame: 'Frame',
};
/** A shape's kind as people call it (a custom shape: its outline). */
export const shapeLabel = (s: Pick<Shape, 'kind' | 'preset'>) => (s.kind === 'custom' && s.preset ? CUSTOM_LABEL[s.preset] : SHAPE_LABEL[s.kind]);
const partLabel = (k: ShapeKind) => SHAPE_LABEL[k];

/** What the shape tools need from the engine. */
export interface ShapeHost {
  comp: Renderer;
  doc: Doc;
  canvas: HTMLCanvasElement;
  sendOp(op: Op): void;
  pushUndo(e: { undo: Op[]; redo: Op[] }): void;
  send(msg: ClientMsg): void;
  /** Where a new layer goes (above the active layer). */
  newLayerPlace(): { order: number; parent?: string };
  nextName(prefix: string): string;
  activeLayer(): Layer | undefined;
  setActiveLayer(id: string): void;
}

type Pt = [number, number];

/** The props a gesture or an edit may change, compared to make the ops. */
const PROP_KEYS: (keyof ShapeUpdate)[] = ['kind', 'name', 'z', 'w', 'h', 'm', 'radii', 'radiiLinked', 'sides', 'points', 'innerRatio', 'rounding', 'line', 'path', 'curve', 'parts', 'arc', 'hole', 'preset', 'dash', 'arrows', 'fill', 'stroke', 'strokeWidth', 'align', 'cap', 'join'];

const LIVE_MS = 40;
/** Movement (CSS px) before a press counts as a drag: smaller jitters change nothing. */
const DRAG_PX = 3;
const DRAG_PX_TOUCH = 7;
/** A second click within this time and distance is a double-click. */
const DOUBLE_MS = 350;
/** How far outside a corner a press rotates (CSS px). */
const ROTATE_PX = 26;

const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'><g fill='none' stroke-linecap='round'><path d='M6 15a7 7 0 0 1 11-9' stroke='white' stroke-width='4'/><path d='M6 15a7 7 0 0 1 11-9' stroke='black' stroke-width='1.6'/></g><path d='M14 2.5l5 3.5-5.5 2.5z' fill='black' stroke='white' stroke-width='1'/></svg>",
)}") 12 12, alias`;

type Zone =
  | { kind: 'scale'; hx: number; hy: number }
  | { kind: 'rotate' }
  | { kind: 'radius'; corner: number }
  | { kind: 'endpoint'; end: 0 | 1 }
  | { kind: 'move' };

interface Edit {
  pointerId: number;
  touch: boolean;
  kind: 'move' | 'scale' | 'rotate' | 'radius' | 'endpoint';
  /** World and screen point of the press. */
  p0: Pt;
  s0: Pt;
  orig: Map<string, Shape>;
  moved: boolean;
  hx: number;
  hy: number;
  corner: number;
  end: 0 | 1;
  /** Several shapes: their world box (x0, y0, x1, y1). */
  box: Box | null;
}

interface Create {
  pointerId: number;
  touch: boolean;
  p0: Pt;
  s0: Pt;
  id: string;
  layerId: string;
  /** The shape layer this press made (undo removes it with the shape). */
  createdLayer: string | null;
  z: number;
  moved: boolean;
}

/** A press in point editing: on a handle, on points, or a selection rectangle. */
interface PointDrag {
  pointerId: number;
  touch: boolean;
  kind: 'handle' | 'anchor' | 'marquee' | 'ring';
  s0: Pt;
  s1: Pt;
  p0: Pt;
  /** The shape and its path at the press. */
  shape: Shape;
  path: PathContour[];
  keys: PKey[];
  which: 'in' | 'out';
  add: boolean;
  moved: boolean;
}

/** The Pen's path in progress: points in world units relative to `o` (the first point). */
interface PenPath {
  id: string;
  curve: 'bezier' | 'spline';
  layerId: string;
  createdLayer: string | null;
  z: number;
  o: Pt;
  c: PathContour;
}

interface Marquee {
  pointerId: number;
  touch: boolean;
  s0: Pt;
  s1: Pt;
  add: boolean;
  moved: boolean;
}

export class ShapeTool {
  /** Shapes being changed by this client's gesture or slider, by id. */
  private drafts = new Map<string, Shape>();
  private edit: Edit | null = null;
  private create: Create | null = null;
  private marquee: Marquee | null = null;
  private pdrag: PointDrag | null = null;
  private pen: PenPath | null = null;
  private penDrag: { pointerId: number; s0: Pt; idx: number; moved: boolean; closing: boolean } | null = null;
  /** The point whose ring knob is dragged (point editing of a spline). */
  private ringKey: PKey | null = null;
  /** The shapes before an options bar drag started (editSelected). */
  private editOrig: Map<string, Shape> | null = null;
  private hover: Shape | null = null;
  private pointer: Pt | null = null;
  private liveAt = 0;
  private liveTimer: number | undefined;
  private overlayRaf = 0;
  private lastClick = { t: 0, x: 0, y: 0 };
  /** Shapes as the user sees them, cached until the document or the drafts change. */
  private viewCache: Map<string, Shape> | null = null;
  /** Touch screen: bigger targets (the smoothness ring). */
  private coarse = matchMedia('(pointer: coarse)').matches;
  /** Peers' drafts: when each last arrived (stale ones are dropped). */
  private remote = new Map<string, number>();

  constructor(private host: ShapeHost) {}

  // --- the document as the user sees it -------------------------------------------------------

  /** Confirmed shapes with pending ops applied (deleted ones too). */
  private view(): Map<string, Shape> {
    if (this.viewCache) return this.viewCache;
    const v = new Map(this.host.doc.shapes);
    for (const [id, s] of this.host.doc.pendingShapes()) v.set(id, s);
    return (this.viewCache = v);
  }

  /** A shape as it shows now: a draft, else the view. */
  current(id: string): Shape | undefined {
    const pid = splitPartId(id);
    if (pid) {
      // A part of a compound: a shape of its own, made from the compound as it shows now.
      const c = this.drafts.get(pid[0]) ?? this.view().get(pid[0]);
      return c && !c.deleted ? partShape(c, pid[1], partLabel) : undefined;
    }
    return this.drafts.get(id) ?? this.view().get(id);
  }

  /** Shapes with the parts put back into their compounds (the compounds as the view has them). */
  private toReal(list: Shape[]): Shape[] {
    const out = new Map<string, Shape>();
    for (const s of list) {
      const pid = splitPartId(s.id);
      if (!pid) {
        out.set(s.id, s);
        continue;
      }
      const c = out.get(pid[0]) ?? this.view().get(pid[0]);
      if (c && !c.deleted) out.set(c.id, withPart(c, pid[1], s));
    }
    return [...out.values()];
  }

  /** The selected shapes as they show now. */
  selected(): Shape[] {
    const out: Shape[] = [];
    for (const id of ed.selection) {
      const s = this.current(id);
      if (s && !s.deleted) out.push(s);
    }
    return out;
  }

  /** The document or the pending ops changed: refresh the panels, the drafts and the overlay. */
  docChanged(): void {
    this.viewCache = null;
    const v = this.view();
    const byId = new Map(ed.layers.map((l) => [l.id, l]));
    ed.shapes = [...v.values()].filter((s) => !s.deleted && byId.has(s.layerId)).sort(byZ);
    if (ed.partsOf) {
      const c = v.get(ed.partsOf);
      if (!c || c.deleted || c.kind !== 'compound' || !byId.has(c.layerId)) ed.partsOf = null;
    }
    const keep = ed.selection.filter((id) => {
      const pid = splitPartId(id);
      const s = v.get(pid ? pid[0] : id);
      return s && !s.deleted && byId.has(s.layerId) && (!pid || (pid[0] === ed.partsOf && pid[1] < (s.parts?.length ?? 0)));
    });
    if (keep.length !== ed.selection.length) ed.selection = keep;
    if (ed.pointEdit && !keep.includes(ed.pointEdit.id)) ed.pointEdit = null;
    this.pushDrafts();
    this.scheduleOverlay();
  }

  /** Sends this client's drafts (pending ops and the gesture) to the renderer. */
  private pushDrafts(): void {
    const all = new Map(this.host.doc.pendingShapes());
    for (const [id, s] of this.drafts) all.set(id, s);
    this.host.comp.setShapeDrafts('local', [...all.values()]);
  }

  private setDrafts(list: Shape[]): void {
    this.drafts = new Map(this.toReal(list).map((s) => [s.id, s]));
    this.pushDrafts();
    this.sendLive();
    this.scheduleOverlay();
  }

  private clearDrafts(): void {
    const had = this.drafts.size > 0;
    this.drafts.clear();
    window.clearTimeout(this.liveTimer);
    this.liveTimer = undefined;
    this.pushDrafts();
    if (had) this.host.send({ t: 'shape.live', shapes: [] });
    this.scheduleOverlay();
  }

  /** Other people see the drafts, at most every LIVE_MS. */
  private sendLive(): void {
    if (this.liveTimer !== undefined) return;
    const wait = Math.max(0, this.liveAt + LIVE_MS - performance.now());
    this.liveTimer = window.setTimeout(() => {
      this.liveTimer = undefined;
      if (!this.drafts.size) return;
      this.liveAt = performance.now();
      this.host.send({ t: 'shape.live', shapes: [...this.drafts.values()].slice(0, LIMITS.maxLiveShapes).map(toInput) });
    }, wait);
  }

  /** A peer's drafts arrived (an empty list ends them). */
  remoteDrafts(by: string, shapes: ShapeInput[]): void {
    this.host.comp.setShapeDrafts(by, shapes.map((s) => ({ ...s, author: by, seq: 0 })));
    if (shapes.length) this.remote.set(by, performance.now());
    else this.remote.delete(by);
  }

  /** Drops drafts of peers that went quiet (they left, or their connection dropped). */
  sweep(): void {
    const now = performance.now();
    for (const [by, t] of this.remote) if (now - t > 10000) this.remoteDrafts(by, []);
  }

  dropRemote(by: string): void {
    if (this.remote.has(by)) this.remoteDrafts(by, []);
  }

  // --- geometry helpers -----------------------------------------------------------------------

  private get zoom(): number {
    return this.host.comp.view.zoom;
  }

  private toScreen(x: number, y: number): Pt {
    return this.host.comp.toScreen(x, y);
  }

  private toWorld(x: number, y: number): Pt {
    return this.host.comp.toWorld(x, y);
  }

  /** Screen pixels per local unit of a shape (its average scale). */
  pxPerUnit(s: Shape): number {
    return Math.sqrt(Math.abs(s.m[0] * s.m[3] - s.m[1] * s.m[2])) * this.zoom;
  }

  /** Shape layers that show, top first. */
  private visibleShapeLayers(): Layer[] {
    const byId = new Map(ed.layers.map((l) => [l.id, l]));
    return ed.layers.filter((l) => l.kind === 'shape' && effectivelyVisible(byId, l)).reverse();
  }

  /** The topmost shape under a screen point, on a visible shape layer. */
  shapeAt(x: number, y: number, touch: boolean): Shape | null {
    const [wx, wy] = this.toWorld(x, y);
    const tol = (touch ? 10 : 4) / this.zoom;
    const c = ed.partsOf ? this.current(ed.partsOf) : undefined;
    if (c?.kind === 'compound' && !c.deleted) {
      // Parts mode: the topmost part under the point, by its own area (filled or not).
      for (let i = (c.parts?.length ?? 0) - 1; i >= 0; i--) {
        const p = partShape(c, i, partLabel)!;
        if (hitShape({ ...p, fill: p.fill ?? '#000000' }, wx, wy, tol)) return p;
      }
    }
    const by = new Map<string, Shape[]>();
    for (const s of this.view().values()) {
      if (s.deleted) continue;
      const d = this.drafts.get(s.id) ?? s;
      let list = by.get(d.layerId);
      if (!list) by.set(d.layerId, (list = []));
      list.push(d);
    }
    for (const l of this.visibleShapeLayers()) {
      const list = (by.get(l.id) ?? []).sort(byZ);
      for (let i = list.length - 1; i >= 0; i--) if (hitShape(list[i], wx, wy, tol)) return list[i];
    }
    return null;
  }

  /** The selection box in the world: one shape's frame, or the box around several shapes. */
  private boxOf(shapes: Shape[]): { corners: Pt[]; single: Shape | null } | null {
    if (shapes.length === 0) return null;
    if (shapes.length === 1 && shapes[0].kind !== 'line') {
      const s = shapes[0];
      const c = [apply(s.m, 0, 0), apply(s.m, s.w, 0), apply(s.m, s.w, s.h), apply(s.m, 0, s.h)];
      return { corners: c, single: s };
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of shapes) {
      const local = s.kind === 'line' && s.line ? s.line : [0, 0, s.w, 0, s.w, s.h, 0, s.h];
      for (let i = 0; i < local.length; i += 2) {
        const [x, y] = apply(s.m, local[i], local[i + 1]);
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
    }
    return { corners: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], single: null };
  }

  /** The handle positions of a box, in the box's own 0..1 frame: corners, then edges. */
  private static HANDLES: Pt[] = [
    [0, 0], [1, 0], [1, 1], [0, 1],
    [0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5],
  ];

  private boxPoint(c: Pt[], hx: number, hy: number): Pt {
    // Bilinear on the parallelogram: top edge c0→c1, left edge c0→c3.
    return [c[0][0] + (c[1][0] - c[0][0]) * hx + (c[3][0] - c[0][0]) * hy, c[0][1] + (c[1][1] - c[0][1]) * hx + (c[3][1] - c[0][1]) * hy];
  }

  /** Which part of the selection a screen point is on, or null. */
  private zoneAt(x: number, y: number, touch: boolean): Zone | null {
    const sel = this.selected();
    if (!sel.length) return null;
    const r = touch ? 16 : 7;
    if (sel.length === 1 && sel[0].kind === 'line') {
      const s = sel[0];
      const l = s.line!;
      const a = this.toScreen(...apply(s.m, l[0], l[1])), b = this.toScreen(...apply(s.m, l[2], l[3]));
      if (Math.hypot(x - a[0], y - a[1]) <= r) return { kind: 'endpoint', end: 0 };
      if (Math.hypot(x - b[0], y - b[1]) <= r) return { kind: 'endpoint', end: 1 };
      return distSeg(x, y, a, b) <= Math.max(r, (s.strokeWidth * this.pxPerUnit(s)) / 2 + 3) ? { kind: 'move' } : null;
    }
    const box = this.boxOf(sel)!;
    const c = box.corners.map(([wx, wy]) => this.toScreen(wx, wy));
    for (const [hx, hy] of ShapeTool.HANDLES) {
      const [px, py] = this.boxPoint(c, hx, hy);
      if (Math.abs(x - px) <= r && Math.abs(y - py) <= r) return { kind: 'scale', hx, hy };
    }
    const single = box.single;
    if (single && hasRadiusDots(single)) {
      const dots = this.radiusDots(single);
      for (let i = 0; i < dots.length; i++) if (Math.hypot(x - dots[i][0], y - dots[i][1]) <= r) return { kind: 'radius', corner: i };
    }
    if (insidePoly(x, y, c)) return { kind: 'move' };
    for (const p of c) if (Math.hypot(x - p[0], y - p[1]) <= ROTATE_PX + r) return { kind: 'rotate' };
    return null;
  }

  /**
   * Where the radius dots of a rectangle, polygon or star are on screen; none when it is too
   * small to hold them. A rectangle has one per corner. A polygon or star has one per outer
   * corner, all for its one rounding radius: each sits on its corner's arc center, at least 14 px
   * in from the corner so it can be grabbed at radius 0.
   */
  private radiusDots(s: Shape): Pt[] {
    const k = this.pxPerUnit(s);
    if (s.w * k < 44 || s.h * k < 44) return [];
    if (s.kind === 'polygon' || s.kind === 'star') {
      const out: Pt[] = [];
      for (let i = 0; i < outerCorners(s); i++) {
        const c = polyCorner(s, i);
        if (!c) continue;
        const d = Math.min(Math.max((s.rounding ?? 0) / c.sinHalf, 14 / k), c.reach);
        out.push(this.toScreen(...apply(s.m, c.v[0] + c.u[0] * d, c.v[1] + c.u[1] * d)));
      }
      return out;
    }
    const r = s.radii ?? [0, 0, 0, 0];
    const at = (i: number, x: number, y: number, sx: number, sy: number) => {
      const d = Math.min(Math.max(r[i], 14 / k), Math.min(s.w, s.h) / 2);
      return this.toScreen(...apply(s.m, x + sx * d, y + sy * d));
    };
    return [at(0, 0, 0, 1, 1), at(1, s.w, 0, -1, 1), at(2, s.w, s.h, -1, -1), at(3, 0, s.h, 1, -1)];
  }

  // --- pointer ---------------------------------------------------------------------------------

  /** True while a press of this tool is in progress. */
  busy(pointerId?: number): boolean {
    const g = this.edit ?? this.create ?? this.marquee ?? this.pdrag ?? this.penDrag;
    return !!g && (pointerId === undefined || g.pointerId === pointerId);
  }

  down(e: PointerEvent, x: number, y: number): void {
    const touch = e.pointerType === 'touch';
    if (ed.tool === 'pen') return this.penDown(e, x, y);
    if (ed.tool === 'shape') return this.beginCreate(e, x, y, touch);
    const now = performance.now();
    const dbl = now - this.lastClick.t < DOUBLE_MS && Math.hypot(x - this.lastClick.x, y - this.lastClick.y) < (touch ? 16 : 8);
    this.lastClick = { t: dbl ? 0 : now, x, y };
    if (ed.pointEdit) return this.pointDown(e, x, y, dbl);
    // Double-click (a double tap) on a shape: its points.
    const zone = this.zoneAt(x, y, touch);
    if (dbl && (zone || this.shapeAt(x, y, touch))) {
      // A compound: its parts first. A part, or any other shape: its points.
      const target = zone && ed.selection.length === 1 ? ed.selection[0] : this.shapeAt(x, y, touch)?.id;
      if (target && this.current(target)?.kind === 'compound') this.enterParts(target, [x, y]);
      else if (target) this.enterPoints(target);
      return;
    }
    if (zone) {
      if (!ed.canEdit) return showToast('View only: you can look around but not change shapes');
      return this.beginEdit(e, x, y, zone.kind === 'move' ? 'move' : zone.kind, zone);
    }
    let hit = this.shapeAt(x, y, touch);
    if (ed.partsOf && !zone && splitPartId(hit?.id ?? '')?.[0] !== ed.partsOf) {
      // Parts mode ends at a press outside the parts.
      this.exitParts();
      hit = this.shapeAt(x, y, touch);
    }
    // Keep selection: a press outside the box neither swaps nor drops the selection, and starts
    // no selection rectangle. Shift+click still adds or removes; Esc and Deselect still clear.
    const locked = this.locked() && !e.shiftKey;
    if (hit) {
      if (e.shiftKey) {
        this.select(ed.selection.includes(hit.id) ? ed.selection.filter((id) => id !== hit.id) : [...ed.selection, hit.id]);
        return;
      }
      if (locked) return;
      this.select([hit.id]);
      if (ed.canEdit) this.beginEdit(e, x, y, 'move', { kind: 'move' });
      return;
    }
    if (locked) return;
    this.marquee = { pointerId: e.pointerId, touch, s0: [x, y], s1: [x, y], add: e.shiftKey, moved: false };
  }

  /** Keep selection is on and something is selected: clicks outside the box change nothing. */
  private locked(): boolean {
    return ed.keepSelection && ed.selection.length > 0;
  }

  move(e: PointerEvent, x: number, y: number): void {
    this.pointer = [x, y];
    const shift = e.shiftKey, alt = e.altKey;
    if (this.penDrag?.pointerId === e.pointerId) return this.penMove(x, y, alt);
    if (this.pdrag?.pointerId === e.pointerId) return this.pointMove(x, y, shift, alt);
    if (this.create?.pointerId === e.pointerId) return this.moveCreate(x, y, shift, alt);
    if (this.edit?.pointerId === e.pointerId) return this.moveEdit(x, y, shift, alt);
    const mq = this.marquee;
    if (mq?.pointerId === e.pointerId) {
      mq.s1 = [x, y];
      if (Math.hypot(x - mq.s0[0], y - mq.s0[1]) > (mq.touch ? DRAG_PX_TOUCH : DRAG_PX)) mq.moved = true;
      this.scheduleOverlay();
      return;
    }
    if (e.pointerType !== 'touch' && !this.busy()) this.hoverAt(x, y);
  }

  up(e: PointerEvent): void {
    if (this.penDrag?.pointerId === e.pointerId) return this.penUp();
    if (this.pdrag?.pointerId === e.pointerId) return this.pointUp(e);
    if (this.create?.pointerId === e.pointerId) return this.endCreate(e.type === 'pointercancel');
    if (this.edit?.pointerId === e.pointerId) return this.endEdit(e.type === 'pointercancel');
    const mq = this.marquee;
    if (mq?.pointerId === e.pointerId) {
      this.marquee = null;
      if (mq.moved) {
        const [ax, ay] = this.toWorld(...mq.s0), [bx, by] = this.toWorld(...mq.s1);
        const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx), y0 = Math.min(ay, by), y1 = Math.max(ay, by);
        const layers = new Set(this.visibleShapeLayers().map((l) => l.id));
        const hits: string[] = [];
        for (const s of this.view().values()) {
          if (s.deleted || !layers.has(s.layerId)) continue;
          const b = shapeBounds(s);
          if (b.x1 >= x0 && b.x0 <= x1 && b.y1 >= y0 && b.y0 <= y1) hits.push(s.id);
        }
        this.select(mq.add ? [...new Set([...ed.selection, ...hits])] : hits);
      } else if (!mq.add && !this.locked() && e.type === 'pointerup') this.select([]);
      this.scheduleOverlay();
    }
  }

  /** Stops what a press started, without changing anything (a second finger, Esc). */
  cancel(): void {
    if (this.create) this.endCreate(true);
    if (this.edit) this.endEdit(true);
    this.cancelPointDrag();
    if (this.penDrag) {
      // A pinch while placing a point: that point goes, the path stays.
      this.penDrag = null;
      this.penUndoPoint();
    }
    if (this.marquee) {
      this.marquee = null;
      this.scheduleOverlay();
    }
  }

  leave(): void {
    this.pointer = null;
    if (this.hover) {
      this.hover = null;
      this.scheduleOverlay();
    }
  }

  /** Hover: outline what a click would select; the cursor shows what a press would do. */
  hoverAt(x: number, y: number): void {
    this.pointer = [x, y];
    const c = this.host.canvas;
    if (ed.tool === 'shape') {
      c.style.cursor = 'crosshair';
      return;
    }
    if (ed.tool === 'pen') {
      c.style.cursor = 'crosshair';
      this.scheduleOverlay(); // the rubber band follows the pointer
      return;
    }
    if (ed.pointEdit) {
      const h = this.pointHit(x, y, false);
      c.style.cursor = h?.kind === 'handle' || h?.kind === 'anchor' ? 'move' : h?.kind === 'segment' ? 'copy' : 'default';
      if (this.hover) this.hover = null;
      this.scheduleOverlay();
      return;
    }
    const zone = this.zoneAt(x, y, false);
    let hover: Shape | null = null;
    if (zone) {
      if (zone.kind === 'move') c.style.cursor = 'move';
      else if (zone.kind === 'rotate') c.style.cursor = ROTATE_CURSOR;
      else if (zone.kind === 'radius' || zone.kind === 'endpoint') c.style.cursor = 'pointer';
      else c.style.cursor = this.resizeCursor(zone.hx, zone.hy);
    } else {
      // With Keep selection on, a click would not select it: no outline, no label.
      hover = this.locked() ? null : this.shapeAt(x, y, false);
      c.style.cursor = 'default';
    }
    if (hover?.id !== this.hover?.id || hover !== this.hover) {
      this.hover = hover;
      this.scheduleOverlay();
    }
  }

  /** A resize cursor along the handle's direction on screen (boxes can be rotated). */
  private resizeCursor(hx: number, hy: number): string {
    const box = this.boxOf(this.selected());
    if (!box) return 'default';
    const c = box.corners.map(([wx, wy]) => this.toScreen(wx, wy));
    const mid = this.boxPoint(c, 0.5, 0.5), h = this.boxPoint(c, hx, hy);
    const deg = ((Math.atan2(h[1] - mid[1], h[0] - mid[0]) * 180) / Math.PI + 360) % 180;
    return ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][Math.round(deg / 45) % 4];
  }

  // --- selection ----------------------------------------------------------------------------------

  /** Selects shapes. The active layer follows the last one, so the panels show its layer. */
  select(ids: string[]): void {
    ed.selection = ids;
    const last = ids.length ? this.current(ids[ids.length - 1]) : null;
    if (last && last.layerId !== ed.activeLayerId) this.host.setActiveLayer(last.layerId);
    this.editOrig = null;
    this.scheduleOverlay();
  }

  deselect(): void {
    if (ed.selection.length) this.select([]);
  }

  /** The layers panel made `layerId` active: a selection on other layers goes. */
  layerPicked(layerId: string): void {
    if (ed.selection.some((id) => this.current(id)?.layerId !== layerId)) {
      ed.selection = [];
      this.scheduleOverlay();
    }
  }

  /** Esc: ends a press in progress, else deselects. */
  escape(): boolean {
    if (this.busy()) {
      this.cancel();
      return true;
    }
    if (ed.partsOf) {
      this.exitParts();
      return true;
    }
    if (!ed.selection.length) return false;
    this.select([]);
    return true;
  }

  // --- creating ---------------------------------------------------------------------------------

  private beginCreate(e: PointerEvent, x: number, y: number, touch: boolean): void {
    if (!ed.canEdit) return showToast('View only: you can look around but not draw');
    const target = this.shapeLayerFor();
    if (!target) return;
    const { layerId, created: createdLayer } = target;
    let z = 0;
    for (const s of this.view().values()) if (s.layerId === layerId && !s.deleted) z = Math.max(z, s.z);
    this.create = { pointerId: e.pointerId, touch, p0: this.toWorld(x, y), s0: [x, y], id: newId(), layerId, createdLayer, z: z + 1, moved: false };
    ed.selection = [];
    this.hover = null;
  }

  /**
   * The layer for a new shape: the active layer when it is a visible shape layer, else a new
   * shape layer above it. The press makes it at once, so the drag already shows on it (and to
   * other people). Null: no room for a layer.
   */
  private shapeLayerFor(): { layerId: string; created: string | null } | null {
    const active = this.host.activeLayer();
    const byId = new Map(ed.layers.map((l) => [l.id, l]));
    if (active?.kind === 'shape' && effectivelyVisible(byId, active)) return { layerId: active.id, created: null };
    if (ed.layers.length >= LIMITS.maxLayers) {
      showToast('Too many layers');
      return null;
    }
    const id = newId();
    this.host.sendOp({
      type: 'layer.add',
      layer: { id, kind: 'shape', name: this.host.nextName('Shapes'), ...this.host.newLayerPlace(), blend: 'normal', opacity: 1, visible: true },
    });
    this.host.setActiveLayer(id);
    return { layerId: id, created: id };
  }

  /** A new shape from the press point `a` to `b` (world). */
  private makeShape(c: Create, a: Pt, b: Pt, shift: boolean, alt: boolean): Shape {
    const kind = ed.shapeKind;
    const st = ed.shapeStyle;
    const z = this.zoom;
    let dx = b[0] - a[0], dy = b[1] - a[1];
    if (shift) {
      if (kind === 'line') {
        // Upright: the angle snaps to 45° steps.
        const len = Math.hypot(dx, dy);
        const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
        dx = Math.cos(ang) * len;
        dy = Math.sin(ang) * len;
      } else {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        dx = Math.sign(dx || 1) * d;
        dy = Math.sign(dy || 1) * d;
      }
    }
    // Alt: the press point is the center.
    const p: Pt = alt ? [a[0] - dx, a[1] - dy] : a;
    const q: Pt = [a[0] + dx, a[1] + dy];
    const x0 = Math.min(p[0], q[0]), y0 = Math.min(p[1], q[1]);
    const w = Math.abs(q[0] - p[0]), h = Math.abs(q[1] - p[1]);
    const px = (v: number) => v / z;
    const base: Shape = {
      id: c.id,
      layerId: c.layerId,
      kind,
      name: '',
      z: c.z,
      w,
      h,
      m: [1, 0, 0, 1, x0, y0],
      fill: kind === 'line' ? null : st.fill,
      stroke: kind === 'line' ? (st.stroke ?? st.fill ?? ed.fg) : st.stroke,
      strokeWidth: px(kind === 'line' ? Math.max(1, st.strokeWidth) : st.strokeWidth),
      align: kind === 'line' ? 'center' : st.align,
      cap: st.cap,
      join: 'miter',
      author: '',
      seq: Infinity,
    };
    if (kind === 'rect') {
      base.radii = st.radii.map(px) as Shape['radii'];
      base.radiiLinked = st.radiiLinked;
    } else if (kind === 'polygon') {
      base.sides = st.sides;
      base.rounding = px(st.rounding);
    } else if (kind === 'star') {
      base.points = st.points;
      base.innerRatio = st.innerRatio;
      base.rounding = px(st.rounding);
    } else if (kind === 'line') {
      base.line = [p[0] - x0, p[1] - y0, q[0] - x0, q[1] - y0];
      if (st.arrows[0] !== 'none' || st.arrows[1] !== 'none') base.arrows = [...st.arrows];
    } else if (kind === 'ellipse') {
      if (st.arc[0] !== st.arc[1]) base.arc = [...st.arc];
      if (st.hole > 0) base.hole = st.hole;
    } else if (kind === 'custom') base.preset = st.preset;
    if (st.dash.some((d) => d > 0)) base.dash = [...st.dash];
    return base;
  }

  private moveCreate(x: number, y: number, shift: boolean, alt: boolean): void {
    const c = this.create!;
    if (!c.moved && Math.hypot(x - c.s0[0], y - c.s0[1]) <= (c.touch ? DRAG_PX_TOUCH : DRAG_PX)) return;
    c.moved = true;
    const s = this.makeShape(c, c.p0, this.toWorld(x, y), shift, alt);
    this.setDrafts([s]);
  }

  private endCreate(cancel: boolean): void {
    const c = this.create!;
    this.create = null;
    if (cancel) {
      this.clearDrafts();
      if (c.createdLayer) this.host.sendOp({ type: 'layer.remove', id: c.createdLayer });
      return;
    }
    let s = this.drafts.get(c.id);
    if (!s || !c.moved) {
      // A click: a 100 px shape centered there (a line starts there).
      const d = 100 / this.zoom;
      s = ed.shapeKind === 'line'
        ? this.makeShape(c, c.p0, [c.p0[0] + d, c.p0[1]], false, false)
        : this.makeShape(c, [c.p0[0] - d / 2, c.p0[1] - d / 2], [c.p0[0] + d / 2, c.p0[1] + d / 2], false, false);
    }
    // Too small to see or to grab: at least 2 screen pixels.
    const min = 2 / this.zoom;
    if (s.kind !== 'line') {
      s.w = Math.max(s.w, min);
      s.h = Math.max(s.h, min);
    }
    s.name = this.nextShapeName(s.kind, shapeLabel(s));
    this.clearDrafts();
    const op: Op = { type: 'shape.add', shape: toInput(s) };
    this.host.sendOp(op);
    this.host.pushUndo({
      undo: [{ type: 'shape.remove', id: s.id }, ...(c.createdLayer ? [{ type: 'layer.remove', id: c.createdLayer } as Op] : [])],
      redo: [...(c.createdLayer ? [{ type: 'layer.restore', id: c.createdLayer } as Op] : []), { type: 'shape.restore', id: s.id }],
    });
    this.select([s.id]);
  }

  private nextShapeName(kind: ShapeKind, prefix = SHAPE_LABEL[kind]): string {
    let n = 1;
    const re = new RegExp(`^${prefix} (\\d+)$`);
    for (const s of this.view().values()) {
      const m = re.exec(s.name);
      if (m) n = Math.max(n, +m[1] + 1);
    }
    return `${prefix} ${n}`;
  }

  // --- changing -----------------------------------------------------------------------------------

  private beginEdit(e: PointerEvent, x: number, y: number, kind: Edit['kind'], zone: Zone): void {
    const sel = this.selected();
    if (!sel.length) return;
    const orig = new Map(sel.map((s) => [s.id, s]));
    const box = this.boxOf(sel);
    let bb: Box | null = null;
    if (box && !box.single) {
      const xs = box.corners.map((c) => c[0]), ys = box.corners.map((c) => c[1]);
      bb = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    }
    this.edit = {
      pointerId: e.pointerId,
      touch: e.pointerType === 'touch',
      kind,
      p0: this.toWorld(x, y),
      s0: [x, y],
      orig,
      moved: false,
      hx: zone.kind === 'scale' ? zone.hx : 0,
      hy: zone.kind === 'scale' ? zone.hy : 0,
      corner: zone.kind === 'radius' ? zone.corner : 0,
      end: zone.kind === 'endpoint' ? zone.end : 0,
      box: bb,
    };
    this.hover = null;
  }

  private moveEdit(x: number, y: number, shift: boolean, alt: boolean): void {
    const g = this.edit!;
    if (!g.moved && Math.hypot(x - g.s0[0], y - g.s0[1]) <= (g.touch ? DRAG_PX_TOUCH : DRAG_PX)) return;
    g.moved = true;
    const p = this.toWorld(x, y);
    const out: Shape[] = [];
    const orig = [...g.orig.values()];
    switch (g.kind) {
      case 'move': {
        let dx = p[0] - g.p0[0], dy = p[1] - g.p0[1];
        if (shift) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        for (const s of orig) out.push({ ...s, m: [s.m[0], s.m[1], s.m[2], s.m[3], s.m[4] + dx, s.m[5] + dy] });
        break;
      }
      case 'rotate': {
        const box = this.boxOf(orig)!;
        const c = box.single ? apply(box.single.m, box.single.w / 2, box.single.h / 2) : mid(box.corners[0], box.corners[2]);
        let a = Math.atan2(p[1] - c[1], p[0] - c[0]) - Math.atan2(g.p0[1] - c[1], g.p0[0] - c[0]);
        if (shift) {
          // 15° steps of the shape's own angle (one shape), or of the turn (several).
          const base = box.single ? Math.atan2(box.single.m[1], box.single.m[0]) : 0;
          a = Math.round((base + a) / (Math.PI / 12)) * (Math.PI / 12) - base;
        }
        const cos = Math.cos(a), sin = Math.sin(a);
        const R: Affine = [cos, sin, -sin, cos, c[0] - cos * c[0] + sin * c[1], c[1] - sin * c[0] - cos * c[1]];
        for (const s of orig) out.push({ ...s, m: compose(R, s.m) });
        break;
      }
      case 'scale':
        if (orig.length === 1 && orig[0].kind !== 'line') out.push(this.resizeOne(orig[0], p, g.hx, g.hy, shift, alt));
        else out.push(...this.scaleMany(orig, g.box!, p, g.hx, g.hy, shift, alt));
        break;
      case 'radius': {
        const s = orig[0];
        const inv = invert(s.m);
        if (!inv) return;
        const [qx, qy] = apply(inv, p[0], p[1]);
        if (s.kind === 'polygon' || s.kind === 'star') {
          // The pointer's distance along the corner's bisector is the arc center's; the radius
          // follows from the corner angle. One radius for every corner, as in the options bar.
          const c = polyCorner(s, g.corner);
          if (!c) return;
          const t = Math.max(0, Math.min((qx - c.v[0]) * c.u[0] + (qy - c.v[1]) * c.u[1], c.reach));
          out.push({ ...s, rounding: Math.min(t * c.sinHalf, Math.min(s.w, s.h) / 2) });
          break;
        }
        const dx = [qx, s.w - qx, s.w - qx, qx][g.corner], dy = [qy, qy, s.h - qy, s.h - qy][g.corner];
        const r = Math.max(0, Math.min((dx + dy) / 2, Math.min(s.w, s.h) / 2));
        const radii = [...(s.radii ?? [0, 0, 0, 0])] as Shape['radii'] & number[];
        if (s.radiiLinked !== false && !alt) radii.fill(r);
        else radii[g.corner] = r;
        out.push({ ...s, radii });
        break;
      }
      case 'endpoint': {
        const s = orig[0];
        const inv = invert(s.m);
        if (!inv) return;
        const l = s.line!;
        let q: Pt = p;
        if (shift) {
          // Upright: 45° steps around the other end.
          const o = apply(s.m, g.end ? l[0] : l[2], g.end ? l[1] : l[3]);
          const len = Math.hypot(p[0] - o[0], p[1] - o[1]);
          const ang = Math.round(Math.atan2(p[1] - o[1], p[0] - o[0]) / (Math.PI / 4)) * (Math.PI / 4);
          q = [o[0] + Math.cos(ang) * len, o[1] + Math.sin(ang) * len];
        }
        const ql = apply(inv, q[0], q[1]);
        const pts = g.end ? [l[0], l[1], ql[0], ql[1]] : [ql[0], ql[1], l[2], l[3]];
        out.push(normalizeLine(s, pts));
        break;
      }
    }
    this.setDrafts(out);
  }

  /** One shape, resized by a handle: the frame changes, the matrix keeps its rotation. */
  private resizeOne(s: Shape, p: Pt, hx: number, hy: number, shift: boolean, alt: boolean): Shape {
    const inv = invert(s.m);
    if (!inv) return s;
    const [qx, qy] = apply(inv, p[0], p[1]);
    const k = Math.sqrt(Math.abs(s.m[0] * s.m[3] - s.m[1] * s.m[2]));
    const min = 2 / (this.zoom * k); // a few screen pixels, in local units
    // Each axis: the new edges, with the opposite one fixed (or the center with Alt).
    const axis = (h: number, q: number, size: number): [number, number] => {
      if (h === 0.5) return [0, size];
      if (alt) {
        const half = Math.max(min / 2, Math.abs(q - size / 2));
        return [size / 2 - half, size / 2 + half];
      }
      return h === 1 ? [0, Math.max(min, q)] : [Math.min(size - min, q), size];
    };
    let [x0, x1] = axis(hx, qx, s.w);
    let [y0, y1] = axis(hy, qy, s.h);
    if (shift && s.w > 0 && s.h > 0) {
      // Keep the proportions: the axis that grew most leads.
      const kx = (x1 - x0) / s.w, ky = (y1 - y0) / s.h;
      const f = hx === 0.5 ? ky : hy === 0.5 ? kx : Math.max(kx, ky);
      const fit = (h: number, a: number, b: number, size: number): [number, number] => {
        const len = size * f;
        if (h === 0.5 || alt) {
          const c = h === 0.5 ? size / 2 : (a + b) / 2;
          return [c - len / 2, c + len / 2];
        }
        return h === 1 ? [a, a + len] : [b - len, b];
      };
      [x0, x1] = fit(hx, x0, x1, s.w);
      [y0, y1] = fit(hy, y0, y1, s.h);
    }
    const out = { ...s, w: x1 - x0, h: y1 - y0, m: compose(s.m, [1, 0, 0, 1, x0, y0]) };
    if (s.kind === 'path' && s.path) {
      // The path stretches with its frame.
      const kx = s.w > 0 ? (x1 - x0) / s.w : 1, ky = s.h > 0 ? (y1 - y0) / s.h : 1;
      out.path = s.path.map((c) => {
        const pts = c.pts.slice();
        for (let i = 0; i < pts.length; i++) {
          const f = i % POINT_STRIDE;
          if (f < 6) pts[i] *= f % 2 ? ky : kx;
        }
        return { closed: c.closed, pts };
      });
    }
    if (s.kind === 'compound' && s.parts) {
      // The parts stretch with the frame.
      const kx = s.w > 0 ? (x1 - x0) / s.w : 1, ky = s.h > 0 ? (y1 - y0) / s.h : 1;
      out.parts = s.parts.map((p) => ({ ...p, m: compose([kx, 0, 0, ky, 0, 0], p.m) }));
    }
    return out;
  }

  /** Several shapes (or a line), scaled by a handle of their world box: the matrices change. */
  private scaleMany(list: Shape[], b: Box, p: Pt, hx: number, hy: number, shift: boolean, alt: boolean): Shape[] {
    const w = b[2] - b[0], h = b[3] - b[1];
    const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
    // The fixed point, and the scale on each axis.
    const fx = alt ? cx : b[0] + (1 - hx) * w, fy = alt ? cy : b[1] + (1 - hy) * h;
    const hxw = b[0] + hx * w, hyw = b[1] + hy * h;
    let kx = hx === 0.5 || w === 0 ? 1 : (p[0] - fx) / (hxw - fx);
    let ky = hy === 0.5 || h === 0 ? 1 : (p[1] - fy) / (hyw - fy);
    const min = 1e-6;
    kx = Math.max(min, kx);
    ky = Math.max(min, ky);
    if (shift) {
      const k = hx === 0.5 ? ky : hy === 0.5 ? kx : Math.max(kx, ky);
      kx = ky = k;
    }
    const ox = hx === 0.5 && !alt ? cx : fx, oy = hy === 0.5 && !alt ? cy : fy;
    const S: Affine = [kx, 0, 0, ky, ox - kx * ox, oy - ky * oy];
    return list.map((s) => ({ ...s, m: compose(S, s.m) }));
  }

  private endEdit(cancel: boolean): void {
    const g = this.edit!;
    this.edit = null;
    if (cancel || !g.moved) {
      this.clearDrafts();
      return;
    }
    this.commit(g.orig, [...this.drafts.values()]);
  }

  /** Sends one update per changed shape and one undo step for all; ends the drafts. */
  private commit(orig: Map<string, Shape>, next: Shape[]): void {
    // A changed part changes its compound: compare the compounds.
    const before = new Map<string, Shape>();
    for (const [id, s] of orig) {
      const pid = splitPartId(id);
      const c = pid ? this.view().get(pid[0]) : s;
      if (c) before.set(c.id, c);
    }
    orig = before;
    next = this.toReal(next);
    const undo: Op[] = [], redo: Op[] = [];
    for (const n of next) {
      const o = orig.get(n.id);
      if (!o) continue;
      const props: ShapeUpdate = {}, old: ShapeUpdate = {};
      for (const k of PROP_KEYS) {
        if (JSON.stringify(n[k]) === JSON.stringify(o[k])) continue;
        (props as Record<string, unknown>)[k] = n[k];
        (old as Record<string, unknown>)[k] = o[k];
      }
      if (!Object.keys(props).length) continue;
      redo.push({ type: 'shape.update', id: n.id, props });
      undo.push({ type: 'shape.update', id: n.id, props: old });
    }
    for (const op of redo) this.host.sendOp(op);
    this.clearDrafts();
    if (redo.length) this.host.pushUndo({ undo, redo });
  }

  /**
   * Changes the selected shapes from the options bar. `fn` gives the props for each (null: leave
   * it). `live`: a slider drag in progress (a draft); without it the change is one undo step,
   * counted from where the drag started.
   */
  editSelected(fn: (s: Shape) => Partial<ShapeProps> | null, live: boolean): void {
    if (!ed.canEdit || this.busy()) return;
    const base = this.editOrig ?? new Map(this.selected().map((s) => [s.id, s]));
    if (!base.size) return;
    const next: Shape[] = [];
    for (const s of base.values()) {
      const p = fn(s);
      next.push(p ? { ...s, ...p } : s);
    }
    if (live) {
      this.editOrig = base;
      this.setDrafts(next);
    } else {
      this.editOrig = null;
      this.commit(base, next);
    }
  }

  /** Renames a shape (layers panel). */
  rename(id: string, name: string): void {
    const s = this.current(id);
    if (!s || !ed.canEdit || s.name === name) return;
    this.commit(new Map([[id, s]]), [{ ...s, name }]);
  }

  /** Removes shapes (the selection by default). Undo brings them back. */
  remove(ids = ed.selection): void {
    if (!ed.canEdit || !ids.length) return;
    const live: string[] = [];
    const cut = new Map<string, Set<number>>();
    for (const id of ids) {
      const pid = splitPartId(id);
      if (pid) {
        let set = cut.get(pid[0]);
        if (!set) cut.set(pid[0], (set = new Set()));
        set.add(pid[1]);
      } else if (this.current(id) && !this.current(id)!.deleted) live.push(id);
    }
    // Parts: out of their compound (a compound without parts goes).
    const undo: Op[] = [], redo: Op[] = [];
    for (const [cid, set] of cut) {
      const c = this.view().get(cid);
      if (!c || c.deleted || !c.parts || live.includes(cid)) continue;
      const parts = c.parts.filter((_, i) => !set.has(i));
      if (!parts.length) {
        live.push(cid);
        continue;
      }
      const n = fitCompoundFrame({ ...c, parts });
      redo.push({ type: 'shape.update', id: cid, props: { parts: n.parts, w: n.w, h: n.h, m: n.m } });
      undo.push({ type: 'shape.update', id: cid, props: { parts: c.parts, w: c.w, h: c.h, m: c.m } });
    }
    for (const id of live) {
      redo.push({ type: 'shape.remove', id });
      undo.push({ type: 'shape.restore', id });
    }
    if (!redo.length) return;
    for (const op of redo) this.host.sendOp(op);
    this.host.pushUndo({ undo, redo });
    ed.selection = ed.selection.filter((id) => !live.includes(id) && !cut.has(splitPartId(id)?.[0] ?? ''));
    if (ed.partsOf && live.includes(ed.partsOf)) ed.partsOf = null;
    this.scheduleOverlay();
  }

  // --- compound shapes ------------------------------------------------------------------------------
  //
  // Combine makes one compound shape of the selected shapes: the bottom one gives the style, the
  // others combine with it by the op. The parts stay live: a double-click shows them (parts mode),
  // and each one moves, scales and edits its points as a shape of its own. Release makes them
  // shapes again; Flatten makes the result one path.

  /** Why the selection cannot be combined, or null. */
  combineProblem(): string | null {
    const sel = this.selected();
    if (sel.length < 2) return 'Select two or more shapes';
    if (sel.some((s) => splitPartId(s.id))) return 'Select whole shapes';
    if (sel.some((s) => s.kind === 'line')) return 'Lines cannot be combined: they have no area';
    if (new Set(sel.map((s) => s.layerId)).size > 1) return 'Select shapes on one layer';
    if (sel.length > LIMITS.maxParts) return `At most ${LIMITS.maxParts} shapes`;
    return null;
  }

  /** Combines the selected shapes into one compound shape, by `op`. One undo step. */
  combine(op: CompoundOp): void {
    if (!ed.canEdit || this.busy()) return;
    const why = this.combineProblem();
    if (why) return showToast(why);
    const list = [...this.selected()].sort(byZ);
    let x0 = Infinity, y0 = Infinity;
    for (const s of list) {
      const b = shapeBounds(s);
      x0 = Math.min(x0, b.x0);
      y0 = Math.min(y0, b.y0);
    }
    const T: Affine = [1, 0, 0, 1, -x0, -y0];
    const base = list[0];
    const c = fitCompoundFrame<Shape>({
      id: newId(),
      layerId: base.layerId,
      kind: 'compound',
      name: this.nextShapeName('compound', OP_NAME[op]),
      z: list[list.length - 1].z,
      w: 0,
      h: 0,
      m: [1, 0, 0, 1, x0, y0],
      parts: list.map((s) => partOf(s, op, T)),
      fill: base.fill,
      stroke: base.stroke,
      strokeWidth: base.strokeWidth * Math.sqrt(Math.abs(base.m[0] * base.m[3] - base.m[1] * base.m[2])),
      align: base.align,
      cap: base.cap,
      join: base.join,
      author: '',
      seq: 0,
    });
    this.host.sendOp({ type: 'shape.add', shape: toInput(c) });
    for (const s of list) this.host.sendOp({ type: 'shape.remove', id: s.id });
    this.host.pushUndo({
      undo: [{ type: 'shape.remove', id: c.id }, ...list.map((s) => ({ type: 'shape.restore', id: s.id }) as Op)],
      redo: [{ type: 'shape.restore', id: c.id }, ...list.map((s) => ({ type: 'shape.remove', id: s.id }) as Op)],
    });
    this.select([c.id]);
  }

  /** The selected compound shapes (whole). */
  private selectedCompounds(): Shape[] {
    return this.selected().filter((s) => s.kind === 'compound' && !splitPartId(s.id));
  }

  /** Makes the parts of the selected compounds shapes again, with the compound's style. One undo step. */
  release(): void {
    if (!ed.canEdit || this.busy()) return;
    const list = this.selectedCompounds();
    if (!list.length) return;
    this.exitParts(false);
    const undo: Op[] = [], redo: Op[] = [];
    const made: string[] = [];
    for (const c of list) {
      const n = c.parts!.length;
      c.parts!.forEach((_, i) => {
        const p = partShape(c, i, partLabel)!;
        const s: Shape = stripForKind({ ...p, id: newId(), z: c.z + i / n });
        this.host.sendOp({ type: 'shape.add', shape: toInput(s) });
        made.push(s.id);
        undo.push({ type: 'shape.remove', id: s.id });
        redo.push({ type: 'shape.restore', id: s.id });
      });
      this.host.sendOp({ type: 'shape.remove', id: c.id });
      undo.push({ type: 'shape.restore', id: c.id });
      redo.push({ type: 'shape.remove', id: c.id });
    }
    this.host.pushUndo({ undo, redo });
    this.select(made);
  }

  /** Makes the selected compounds one path each: the result's outline. One undo step. */
  flatten(): void {
    if (!ed.canEdit || this.busy()) return;
    const list = this.selectedCompounds();
    if (!list.length) return;
    const next: Shape[] = [];
    for (const c of list) {
      const path = compoundToPath(c);
      if (!path.length) {
        showToast(`${c.name || 'The compound'} is empty: nothing to flatten`);
        continue;
      }
      if (path.reduce((n, p) => n + p.pts.length / POINT_STRIDE, 0) > LIMITS.maxPathPoints) {
        showToast(`${c.name || 'The compound'} has too many points to flatten`);
        continue;
      }
      next.push(stripForKind(fitPathFrame({ ...c, kind: 'path', path })));
    }
    this.exitParts(false);
    this.commit(new Map(list.map((c) => [c.id, c])), next);
  }

  /** Sets the op of every part of the selected compounds. */
  setCompoundOp(op: CompoundOp): void {
    this.editSelected((s) => (s.kind === 'compound' && !splitPartId(s.id) ? { parts: s.parts!.map((p) => ({ ...p, op })) } : null), false);
  }

  /** Sets the op of the selected parts. */
  setPartOp(op: CompoundOp): void {
    if (!ed.canEdit || this.busy()) return;
    const by = new Map<string, Set<number>>();
    for (const id of ed.selection) {
      const pid = splitPartId(id);
      if (!pid) continue;
      let set = by.get(pid[0]);
      if (!set) by.set(pid[0], (set = new Set()));
      set.add(pid[1]);
    }
    const orig = new Map<string, Shape>(), next: Shape[] = [];
    for (const [cid, set] of by) {
      const c = this.view().get(cid);
      if (!c?.parts) continue;
      orig.set(cid, c);
      next.push({ ...c, parts: c.parts.map((p, i): CompoundPart => (set.has(i) ? { ...p, op } : p)) });
    }
    this.commit(orig, next);
  }

  /** Parts mode: the parts of a compound can be selected and changed. `at`: select the part there. */
  enterParts(id: string, at?: Pt): void {
    const c = this.current(id);
    if (!c || c.deleted || c.kind !== 'compound') return;
    if (!ed.canEdit) return showToast('View only: you can look around but not change shapes');
    this.exitPoints();
    ed.partsOf = id;
    const hit = at ? this.shapeAt(at[0], at[1], false) : null;
    this.select(hit && splitPartId(hit.id)?.[0] === id ? [hit.id] : []);
    this.hover = null;
  }

  /** Back from parts mode to the whole compound (`select`: select it). */
  exitParts(select = true): void {
    const id = ed.partsOf;
    if (!id) return;
    this.exitPoints();
    ed.partsOf = null;
    const c = this.current(id);
    if (select) this.select(c && !c.deleted ? [id] : []);
    else ed.selection = ed.selection.filter((s) => !splitPartId(s));
    this.scheduleOverlay();
  }

  /** Arrow keys: moves the selection by one screen pixel (Shift: ten). */
  nudge(dx: number, dy: number): void {
    const sel = this.selected();
    if (!sel.length || !ed.canEdit || this.busy()) return;
    const d = 1 / this.zoom;
    this.commit(new Map(sel.map((s) => [s.id, s])), sel.map((s) => ({ ...s, m: [s.m[0], s.m[1], s.m[2], s.m[3], s.m[4] + dx * d, s.m[5] + dy * d] as Affine })));
  }

  // --- point editing ----------------------------------------------------------------------------
  //
  // A double-click on a shape (or Enter) shows its points. A shape that is not a path becomes one
  // at the first change (one op: kind, path, frame; undo turns it back). The path edits in the
  // local units of the shape as it was at the press; the frame then fits the curve again.

  /** The shape in point editing, as it shows now, and its path. */
  private pointShape(): { s: Shape; path: PathContour[] } | null {
    const pe = ed.pointEdit;
    const s = pe ? this.current(pe.id) : undefined;
    if (!pe || !s || s.deleted) return null;
    return { s, path: editPath(s) };
  }

  /** Local units of a shape to screen pixels. */
  private localToScreen(s: Shape): (x: number, y: number) => Pt {
    return (x, y) => this.toScreen(...apply(s.m, x, y));
  }

  enterPoints(id: string): void {
    const s = this.current(id);
    if (!s || s.deleted) return;
    if (!ed.canEdit) return showToast('View only: you can look around but not change shapes');
    if (ed.selection.length !== 1 || ed.selection[0] !== id) this.select([id]);
    ed.pointEdit = { id, points: [] };
    this.hover = null;
    this.scheduleOverlay();
  }

  /** Back from point editing to the whole shape. */
  exitPoints(): void {
    if (!ed.pointEdit) return;
    this.cancelPointDrag();
    ed.pointEdit = null;
    this.scheduleOverlay();
  }

  private setPoints(keys: string[]): void {
    if (ed.pointEdit) ed.pointEdit = { ...ed.pointEdit, points: keys };
    this.scheduleOverlay();
  }

  /** The path shape for a new path (local units of `s`): the frame fits the curve. */
  private withPath(s: Shape, path: PathContour[]): Shape {
    return stripForKind(fitPathFrame({ ...s, kind: 'path', path }));
  }

  /** What is under a screen point in point editing: a handle of a selected point, a point, or a segment. */
  private pointHit(
    x: number,
    y: number,
    touch: boolean,
  ): { kind: 'handle'; key: PKey; which: 'in' | 'out' } | { kind: 'ring'; key: PKey } | { kind: 'anchor'; key: PKey } | { kind: 'segment'; c: number; seg: number; t: number } | null {
    const ps = this.pointShape();
    if (!ps) return null;
    const r = touch ? 16 : 6;
    const sc = this.localToScreen(ps.s);
    const spline = ps.s.kind === 'path' && ps.s.curve === 'spline';
    for (const ks of ed.pointEdit!.points) {
      const k = parseKey(ks);
      if (!ps.path[k.c] || k.i >= count(ps.path[k.c])) continue;
      const v = getPt(ps.path, k);
      if (spline) {
        // The smoothness ring's knob.
        const [ax, ay] = sc(v.x, v.y);
        const [kx, ky] = ringKnob(ax, ay, smoothOf(ps.path, k), this.coarse);
        if (Math.hypot(x - kx, y - ky) <= r) return { kind: 'ring', key: k };
        continue;
      }
      for (const which of ['out', 'in'] as const) {
        const [hx, hy] = which === 'in' ? [v.ix, v.iy] : [v.ox, v.oy];
        if (hx === v.x && hy === v.y) continue;
        const [sx, sy] = sc(hx, hy);
        if (Math.hypot(x - sx, y - sy) <= r) return { kind: 'handle', key: k, which };
      }
    }
    for (const k of allKeys(ps.path)) {
      const v = getPt(ps.path, k);
      const [sx, sy] = sc(v.x, v.y);
      if (Math.hypot(x - sx, y - sy) <= r) return { kind: 'anchor', key: k };
    }
    const near = nearestOnPath(ps.path, sc, x, y, curveOf(ps.s));
    if (near && near.d <= r) return { kind: 'segment', c: near.c, seg: near.seg, t: near.t };
    return null;
  }

  private pointDown(e: PointerEvent, x: number, y: number, dbl: boolean): void {
    const ps = this.pointShape();
    if (!ps) return this.exitPoints();
    const touch = e.pointerType === 'touch';
    const hit = this.pointHit(x, y, touch);
    const pe = ed.pointEdit!;
    if (dbl && hit?.kind === 'anchor') {
      // Double-click a point: corner ↔ smooth (a spline point: corner ↔ through).
      const next = curveOf(ps.s) === 'spline' ? toggleSplinePoint(ps.path, hit.key) : toggleSmooth(ps.path, hit.key);
      this.commit(new Map([[ps.s.id, ps.s]]), [this.withPath(ps.s, next)]);
      return;
    }
    if (dbl && hit?.kind === 'segment') {
      // Double-click a segment: a new point there.
      const { path, key } = insertPoint(ps.path, hit.c, hit.seg, hit.t, curveOf(ps.s));
      this.commit(new Map([[ps.s.id, ps.s]]), [this.withPath(ps.s, path)]);
      this.setPoints([keyOf(key)]);
      return;
    }
    const base = { pointerId: e.pointerId, touch, s0: [x, y] as Pt, p0: this.toWorld(x, y), shape: ps.s, path: ps.path, moved: false };
    if (hit?.kind === 'handle') {
      this.pdrag = { ...base, kind: 'handle', keys: [hit.key], which: hit.which, s1: [x, y], add: false };
      return;
    }
    if (hit?.kind === 'ring') {
      // The ring's knob sets the smoothness of every selected point.
      this.pdrag = { ...base, kind: 'ring', keys: pe.points.map(parseKey), which: 'out', s1: [x, y], add: false };
      this.ringKey = hit.key;
      return;
    }
    if (hit?.kind === 'anchor') {
      const ks = keyOf(hit.key);
      let sel = pe.points;
      if (e.shiftKey) sel = sel.includes(ks) ? sel.filter((k) => k !== ks) : [...sel, ks];
      else if (!sel.includes(ks)) sel = [ks];
      this.setPoints(sel);
      if (sel.includes(ks)) this.pdrag = { ...base, kind: 'anchor', keys: sel.map(parseKey), which: 'out', s1: [x, y], add: false };
      return;
    }
    // Elsewhere: a drag selects points by rectangle; a click outside the shape goes back to it.
    this.pdrag = { ...base, kind: 'marquee', keys: [], which: 'out', s1: [x, y], add: e.shiftKey };
  }

  private pointMove(x: number, y: number, shift: boolean, alt: boolean): void {
    const g = this.pdrag!;
    if (!g.moved && Math.hypot(x - g.s0[0], y - g.s0[1]) <= (g.touch ? DRAG_PX_TOUCH : DRAG_PX)) return;
    g.moved = true;
    g.s1 = [x, y];
    if (g.kind === 'marquee') return this.scheduleOverlay();
    const inv = invert(g.shape.m);
    if (!inv) return;
    let p = this.toWorld(x, y);
    if (g.kind === 'anchor') {
      if (shift) {
        // Along one axis (on screen).
        if (Math.abs(p[0] - g.p0[0]) > Math.abs(p[1] - g.p0[1])) p = [p[0], g.p0[1]];
        else p = [g.p0[0], p[1]];
      }
      const a = apply(inv, ...g.p0), b = apply(inv, ...p);
      this.setDrafts([this.withPath(g.shape, moveAnchors(g.path, g.keys, b[0] - a[0], b[1] - a[1]))]);
      return;
    }
    if (g.kind === 'ring') {
      // The knob's angle from the top: clockwise is soft, counterclockwise goes through.
      const v = getPt(g.path, this.ringKey!);
      const [ax, ay] = this.localToScreen(g.shape)(v.x, v.y);
      let sm = Math.max(-1, Math.min(1, Math.atan2(x - ax, -(y - ay)) / Math.PI));
      if (shift) sm = Math.round(sm * 4) / 4;
      if (Math.abs(sm) < 0.04) sm = 0; // a corner is easy to hit
      this.setDrafts([this.withPath(g.shape, setSmoothness(g.path, g.keys, sm))]);
      return;
    }
    const k = g.keys[0];
    const v = getPt(g.path, k);
    let q = apply(inv, ...p);
    if (shift) {
      // 45° steps around the anchor, on screen.
      const [ax, ay] = apply(g.shape.m, v.x, v.y);
      const len = Math.hypot(p[0] - ax, p[1] - ay);
      const ang = Math.round(Math.atan2(p[1] - ay, p[0] - ax) / (Math.PI / 4)) * (Math.PI / 4);
      q = apply(inv, ax + Math.cos(ang) * len, ay + Math.sin(ang) * len);
    }
    this.setDrafts([this.withPath(g.shape, setHandle(g.path, k, g.which, q[0], q[1], alt))]);
  }

  private pointUp(e: PointerEvent): void {
    const g = this.pdrag!;
    this.pdrag = null;
    if (e.type === 'pointercancel') return void this.clearDrafts();
    if (g.kind === 'marquee') {
      if (g.moved) {
        const x0 = Math.min(g.s0[0], g.s1[0]), x1 = Math.max(g.s0[0], g.s1[0]), y0 = Math.min(g.s0[1], g.s1[1]), y1 = Math.max(g.s0[1], g.s1[1]);
        const sc = this.localToScreen(g.shape);
        const inside = allKeys(g.path).filter((k) => {
          const v = getPt(g.path, k);
          const [sx, sy] = sc(v.x, v.y);
          return sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1;
        });
        const keys = inside.map(keyOf);
        this.setPoints(g.add ? [...new Set([...ed.pointEdit!.points, ...keys])] : keys);
      } else if (!g.add) {
        // A click on the shape clears the points; outside it, back to the whole shape.
        const [wx, wy] = this.toWorld(...g.s0);
        if (hitShape(g.shape, wx, wy, (g.touch ? 10 : 4) / this.zoom)) this.setPoints([]);
        else this.exitPoints();
      }
      this.scheduleOverlay();
      return;
    }
    if (!g.moved) return;
    this.commit(new Map([[g.shape.id, g.shape]]), [...this.drafts.values()]);
  }

  private cancelPointDrag(): void {
    if (!this.pdrag) return;
    this.pdrag = null;
    this.clearDrafts();
  }

  /**
   * The type of the selected points (the point bar): corner, smooth or symmetric. On a spline:
   * CORNER is a sharp point (0), SMOOTH goes through it round (-1).
   */
  setPointType(t: number): void {
    const ps = this.pointShape();
    if (!ps || !ed.canEdit) return;
    const keys = ed.pointEdit!.points.map(parseKey);
    if (!keys.length) return showToast('Select points first');
    const next = curveOf(ps.s) === 'spline' ? setSmoothness(ps.path, keys, t === CORNER ? 0 : -1) : setType(ps.path, keys, t);
    this.commit(new Map([[ps.s.id, ps.s]]), [this.withPath(ps.s, next)]);
  }

  /** The smoothness of the selected spline points (the point bar: Soft is 1). */
  setPointSmoothness(v: number): void {
    const ps = this.pointShape();
    if (!ps || !ed.canEdit || curveOf(ps.s) !== 'spline') return;
    const keys = ed.pointEdit!.points.map(parseKey);
    if (!keys.length) return showToast('Select points first');
    this.commit(new Map([[ps.s.id, ps.s]]), [this.withPath(ps.s, setSmoothness(ps.path, keys, v))]);
  }

  /**
   * The curve of a path (point editing, or one selected shape): Bezier points become spline
   * points through the same anchors; a spline becomes Bezier curves that follow it closely.
   */
  setCurve(curve: 'bezier' | 'spline'): void {
    const id = ed.pointEdit?.id ?? (ed.selection.length === 1 ? ed.selection[0] : null);
    const s = id ? this.current(id) : null;
    if (!s || !ed.canEdit || curveOf(s) === curve) return;
    const path = curve === 'spline' ? bezierToSpline(toPath(s)) : toPath(s);
    this.commit(new Map([[s.id, s]]), [stripForKind(fitPathFrame({ ...s, kind: 'path', path, curve }))]);
    if (ed.pointEdit) this.setPoints([]);
  }

  /** Removes the selected points; a shape left without a segment goes. */
  deletePoints(): void {
    const ps = this.pointShape();
    if (!ps || !ed.canEdit) return;
    const keys = ed.pointEdit!.points.map(parseKey);
    if (!keys.length) return;
    const path = removePoints(ps.path, keys);
    if (!path.length) {
      this.exitPoints();
      this.remove([ps.s.id]);
      return;
    }
    this.commit(new Map([[ps.s.id, ps.s]]), [this.withPath(ps.s, path)]);
    this.setPoints([]);
  }

  /** Arrow keys in point editing: the selected points move one screen pixel (Shift: ten). */
  private nudgePoints(dx: number, dy: number): void {
    const ps = this.pointShape();
    if (!ps || !ed.canEdit || this.busy()) return;
    const keys = ed.pointEdit!.points.map(parseKey);
    const inv = invert(ps.s.m);
    if (!keys.length || !inv) return;
    const d = 1 / this.zoom;
    const a = apply(inv, 0, 0), b = apply(inv, dx * d, dy * d);
    this.commit(new Map([[ps.s.id, ps.s]]), [this.withPath(ps.s, moveAnchors(ps.path, keys, b[0] - a[0], b[1] - a[1]))]);
  }

  // --- the Pen ----------------------------------------------------------------------------------
  //
  // Click: a corner point. Drag: a point with handles (Alt: only the outgoing one). Click the first
  // point: the path closes and ends. Enter, Esc or Done: the open path ends. Backspace: the last
  // point goes. With a path selected and the Pen not drawing, a click on its outline adds a point,
  // and a click on a point removes it. The path is a draft until it ends: then one shape.add.

  private penDown(e: PointerEvent, x: number, y: number): void {
    const touch = e.pointerType === 'touch';
    if (!ed.canEdit) return showToast('View only: you can look around but not draw');
    const r = touch ? 16 : 7;
    const p = this.toWorld(x, y);
    const pen = this.pen;
    if (pen) {
      const n = count(pen.c);
      const [fx, fy] = this.toScreen(pen.o[0] + pen.c.pts[0], pen.o[1] + pen.c.pts[1]);
      if (n >= 2 && Math.hypot(x - fx, y - fy) <= r) {
        pen.c.closed = true;
        this.penDrag = { pointerId: e.pointerId, s0: [x, y], idx: 0, moved: false, closing: true };
        this.penDraft();
        return;
      }
      const lx = p[0] - pen.o[0], ly = p[1] - pen.o[1];
      pen.c.pts.push(lx, ly, lx, ly, lx, ly, pen.curve === 'spline' ? ed.penStyle.smooth : CORNER);
      this.penDrag = { pointerId: e.pointerId, s0: [x, y], idx: n, moved: false, closing: false };
      this.penDraft();
      return;
    }
    // Not drawing: a click on the selected shape's outline or points edits it.
    const sel = this.selected();
    if (sel.length === 1) {
      const s = sel[0], path = editPath(s);
      const sc = this.localToScreen(s);
      for (const k of allKeys(path)) {
        const v = getPt(path, k);
        const [sx, sy] = sc(v.x, v.y);
        if (Math.hypot(x - sx, y - sy) <= r) {
          const left = removePoints(path, [k]);
          if (!left.length) this.remove([s.id]);
          else this.commit(new Map([[s.id, s]]), [this.withPath(s, left)]);
          return;
        }
      }
      const near = nearestOnPath(path, sc, x, y, curveOf(s));
      if (near && near.d <= r) {
        const { path: next, key } = insertPoint(path, near.c, near.seg, near.t, curveOf(s));
        this.commit(new Map([[s.id, s]]), [this.withPath(s, next)]);
        ed.pointEdit = { id: s.id, points: [keyOf(key)] };
        this.scheduleOverlay();
        return;
      }
    }
    // A new path, on the active shape layer or a new one above the active layer.
    const target = this.shapeLayerFor();
    if (!target) return;
    let z = 0;
    for (const s of this.view().values()) if (s.layerId === target.layerId && !s.deleted) z = Math.max(z, s.z);
    const curve = ed.penStyle.curve === 'spline' ? 'spline' : 'bezier';
    this.pen = { id: newId(), layerId: target.layerId, createdLayer: target.created, z: z + 1, o: p, curve, c: { closed: false, pts: [0, 0, 0, 0, 0, 0, curve === 'spline' ? ed.penStyle.smooth : CORNER] } };
    ed.penDrawing = true;
    ed.selection = [];
    ed.pointEdit = null;
    this.penDrag = { pointerId: e.pointerId, s0: [x, y], idx: 0, moved: false, closing: false };
    this.penDraft();
  }

  private penMove(x: number, y: number, alt: boolean): void {
    const d = this.penDrag!, pen = this.pen!;
    if (!d.moved && Math.hypot(x - d.s0[0], y - d.s0[1]) <= DRAG_PX) return;
    d.moved = true;
    // The drag pulls the outgoing handle; the incoming one mirrors it (Alt: it stays).
    const p = this.toWorld(x, y);
    const lx = p[0] - pen.o[0], ly = p[1] - pen.o[1];
    const o = d.idx * POINT_STRIDE, a = pen.c.pts;
    if (pen.curve === 'spline') {
      // A spline point has no handles: the drag moves it (not the first one, when closing).
      if (!d.closing) a.splice(o, 6, lx, ly, lx, ly, lx, ly);
      this.penDraft();
      return;
    }
    const px = a[o], py = a[o + 1];
    if (d.closing) {
      // Closing: the drag shapes the curve into the first point (its incoming handle).
      a[o + 2] = px - (lx - px);
      a[o + 3] = py - (ly - py);
      if (!alt) {
        a[o + 4] = lx;
        a[o + 5] = ly;
      }
      a[o + 6] = alt ? CORNER : SYMMETRIC;
    } else {
      a[o + 4] = lx;
      a[o + 5] = ly;
      if (!alt) {
        a[o + 2] = px - (lx - px);
        a[o + 3] = py - (ly - py);
      }
      a[o + 6] = alt ? CORNER : SYMMETRIC;
    }
    this.penDraft();
  }

  private penUp(): void {
    const d = this.penDrag;
    this.penDrag = null;
    if (d?.closing) this.finishPen();
  }

  /** The path in progress as a shape (a draft until it ends). */
  private penShape(): Shape | null {
    const pen = this.pen;
    if (!pen) return null;
    const st = ed.penStyle;
    const z = this.zoom;
    return this.withPath(
      {
        id: pen.id,
        layerId: pen.layerId,
        kind: 'path',
        name: '',
        z: pen.z,
        w: 0,
        h: 0,
        m: [1, 0, 0, 1, pen.o[0], pen.o[1]],
        fill: st.fill,
        stroke: st.stroke ?? (st.fill ? null : ed.fg),
        strokeWidth: Math.max(0.5, st.strokeWidth) / z,
        align: st.align,
        cap: st.cap,
        join: 'round',
        ...(pen.curve === 'spline' ? { curve: 'spline' as const } : {}),
        ...(st.dash?.some((d) => d > 0) ? { dash: [...st.dash] } : {}),
        ...(st.arrows && (st.arrows[0] !== 'none' || st.arrows[1] !== 'none') ? { arrows: [...st.arrows] as Shape['arrows'] } : {}),
        author: '',
        seq: Infinity,
      },
      [{ closed: pen.c.closed, pts: pen.c.pts.slice() }],
    );
  }

  private penDraft(): void {
    const s = this.penShape();
    if (s) this.setDrafts([s]);
  }

  /** Ends the path: a shape of at least two points is added (one undo step). */
  finishPen(): void {
    const pen = this.pen;
    if (!pen) return;
    this.penDrag = null;
    const s = this.penShape()!;
    this.pen = null;
    ed.penDrawing = false;
    this.clearDrafts();
    if (count(pen.c) < 2) {
      if (pen.createdLayer) this.host.sendOp({ type: 'layer.remove', id: pen.createdLayer });
      return;
    }
    s.name = this.nextShapeName('path');
    this.host.sendOp({ type: 'shape.add', shape: toInput(s) });
    this.host.pushUndo({
      undo: [{ type: 'shape.remove', id: s.id }, ...(pen.createdLayer ? [{ type: 'layer.remove', id: pen.createdLayer } as Op] : [])],
      redo: [...(pen.createdLayer ? [{ type: 'layer.restore', id: pen.createdLayer } as Op] : []), { type: 'shape.restore', id: s.id }],
    });
    this.select([s.id]);
  }

  /** Backspace while drawing: the last point goes (the first one ends the path). */
  penUndoPoint(): void {
    const pen = this.pen;
    if (!pen) return;
    if (pen.c.closed) pen.c.closed = false;
    else pen.c.pts.length -= POINT_STRIDE;
    if (!pen.c.pts.length) return this.finishPen();
    this.penDraft();
  }

  /** The Pen bar's Close button: the path closes and ends. */
  penClose(): void {
    if (!this.pen || count(this.pen.c) < 2) return;
    this.pen.c.closed = true;
    this.finishPen();
  }

  /** Keys of the shape tools. Returns true when the key was used. */
  key(e: KeyboardEvent): boolean {
    if (this.pen) {
      if (e.key === 'Enter' || e.key === 'Escape') this.finishPen();
      else if (e.key === 'Backspace' || e.key === 'Delete') this.penUndoPoint();
      else return false;
      return true;
    }
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const a = arrows[e.key];
    const k = e.shiftKey ? 10 : 1;
    if (ed.pointEdit) {
      if (e.key === 'Escape' || e.key === 'Enter') {
        if (this.busy()) this.cancel();
        else this.exitPoints();
      } else if (e.key === 'Delete' || e.key === 'Backspace') this.deletePoints();
      else if (a) this.nudgePoints(a[0] * k, a[1] * k);
      else return false;
      return true;
    }
    if (e.key === 'Escape') return this.escape();
    if (!ed.selection.length) return false;
    if (e.key === 'Delete' || e.key === 'Backspace') this.remove();
    else if (e.key === 'Enter' && ed.selection.length === 1 && ed.tool === 'select') {
      if (this.current(ed.selection[0])?.kind === 'compound') this.enterParts(ed.selection[0]);
      else this.enterPoints(ed.selection[0]);
    }
    else if (a) this.nudge(a[0] * k, a[1] * k);
    else return false;
    return true;
  }

  // --- overlay -----------------------------------------------------------------------------------

  scheduleOverlay(): void {
    if (this.overlayRaf) return;
    this.overlayRaf = requestAnimationFrame(() => {
      this.overlayRaf = 0;
      this.updateOverlay();
    });
  }

  destroy(): void {
    cancelAnimationFrame(this.overlayRaf);
    window.clearTimeout(this.liveTimer);
    ed.overlay = null;
  }

  /** Outlines as SVG path data, cut to the stage (huge coordinates break SVG at deep zoom). */
  private outline(s: Shape): string[] {
    const { w, h } = this.host.comp.size;
    const v = this.host.comp.view;
    const z = v.zoom;
    const A: Affine = [s.m[0] * z, s.m[1] * z, s.m[2] * z, s.m[3] * z, (s.m[4] - v.x) * z, (s.m[5] - v.y) * z];
    const box: Box = [-40, -40, w + 40, h + 40];
    return outlinePolys(s, A, 0.5, box).map(({ pts, closed }) => polyPath(pts, closed, box));
  }

  private updateOverlay(): void {
    const tool = ed.tool;
    // Another tool: a path in progress ends, point editing ends.
    if (this.pen && tool !== 'pen') this.finishPen();
    if (ed.pointEdit && tool !== 'select') this.exitPoints();
    if (ed.partsOf && tool !== 'select') this.exitParts();
    if ((tool !== 'select' && tool !== 'shape' && tool !== 'pen') || ed.transform) {
      if (ed.overlay) ed.overlay = null;
      return;
    }
    const o: SelectOverlay = {
      hover: null,
      outlines: [],
      box: null,
      handles: [],
      dots: [],
      ends: [],
      marquee: null,
      readout: null,
      anchors: [],
      knobs: [],
      rings: [],
      rubber: null,
      tip: null,
      bar: null,
      parts: [],
    };
    // Parts mode: every part's outline (dashed), and a bar to go back.
    const pc = ed.partsOf ? this.current(ed.partsOf) : undefined;
    if (pc?.kind === 'compound' && tool === 'select') {
      for (let i = 0; i < (pc.parts?.length ?? 0); i++) o.parts.push(...this.outline(partShape(pc, i, partLabel)!));
      if (!ed.pointEdit) o.bar = { kind: 'parts', points: pc.parts!.length, selected: ed.selection.length, curve: 'bezier', label: pc.name || 'Compound' };
    }
    if (tool === 'pen' && this.pen) return void (ed.overlay = this.penOverlay(o));
    if (ed.pointEdit) return void (ed.overlay = this.pointOverlay(o));
    const sel = this.selected();
    for (const s of sel) o.outlines.push(...this.outline(s));
    const busy = !!this.edit?.moved || !!this.create;
    if (sel.length && tool === 'select') {
      if (sel.length === 1 && sel[0].kind === 'line') {
        const s = sel[0], l = s.line!;
        o.ends = [this.toScreen(...apply(s.m, l[0], l[1])), this.toScreen(...apply(s.m, l[2], l[3]))];
      } else {
        const box = this.boxOf(sel)!;
        const c = box.corners.map(([wx, wy]) => this.toScreen(wx, wy));
        o.box = c;
        if (!(busy && this.edit?.kind === 'move')) o.handles = ShapeTool.HANDLES.map(([hx, hy]) => this.boxPoint(c, hx, hy));
        if (box.single && hasRadiusDots(box.single) && !busy) o.dots = this.radiusDots(box.single);
      }
    }
    if (this.hover && !sel.some((s) => s.id === this.hover!.id) && !busy) {
      const s = this.current(this.hover.id);
      if (s && !s.deleted && this.pointer) {
        o.hover = { outline: this.outline(s), label: s.name || shapeLabel(s), x: this.pointer[0], y: this.pointer[1] };
      }
    }
    const mq = this.marquee;
    if (mq?.moved) o.marquee = [Math.min(mq.s0[0], mq.s1[0]), Math.min(mq.s0[1], mq.s1[1]), Math.abs(mq.s1[0] - mq.s0[0]), Math.abs(mq.s1[1] - mq.s0[1])];
    o.readout = this.readout();
    ed.overlay = o;
  }

  /** Anchors and handles of a path on screen; `sel` are selected points (their handles show). */
  private pathMarks(o: SelectOverlay, path: PathContour[], sc: (x: number, y: number) => Pt, sel: Set<string>, handlesOf: Set<string>, spline = false): void {
    const { w, h } = this.host.comp.size;
    const on = ([x, y]: Pt) => x > -60 && y > -60 && x < w + 60 && y < h + 60;
    for (const k of allKeys(path)) {
      const v = getPt(path, k);
      const a = sc(v.x, v.y);
      const ks = keyOf(k);
      if (handlesOf.has(ks)) {
        for (const [hx, hy] of [[v.ix, v.iy], [v.ox, v.oy]]) {
          if (hx === v.x && hy === v.y) continue;
          const kn = sc(hx, hy);
          if (on(kn) || on(a)) o.knobs.push({ x: kn[0], y: kn[1], ax: a[0], ay: a[1] });
        }
      }
      if (on(a)) o.anchors.push({ x: a[0], y: a[1], smooth: v.t !== CORNER, sel: sel.has(ks) });
      if (spline && sel.has(ks) && on(a)) {
        const [kx, ky] = ringKnob(a[0], a[1], v.t, this.coarse);
        o.rings.push({ x: a[0], y: a[1], s: v.t, kx, ky, r: ringRadius(this.coarse) });
      }
    }
  }

  private pointOverlay(o: SelectOverlay): SelectOverlay {
    const ps = this.pointShape();
    if (!ps) return o;
    const shown = this.drafts.get(ps.s.id) ?? ps.s;
    const path = editPath(shown);
    o.outlines = this.outline(shown);
    const sel = new Set(ed.pointEdit!.points);
    this.pathMarks(o, path, this.localToScreen(shown), sel, sel, curveOf(shown) === 'spline');
    const g = this.pdrag;
    if (g?.kind === 'marquee' && g.moved) o.marquee = [Math.min(g.s0[0], g.s1[0]), Math.min(g.s0[1], g.s1[1]), Math.abs(g.s1[0] - g.s0[0]), Math.abs(g.s1[1] - g.s0[1])];
    o.bar = { kind: 'points', points: allKeys(path).length, selected: sel.size, curve: curveOf(shown) ?? 'bezier' };
    return o;
  }

  private penOverlay(o: SelectOverlay): SelectOverlay {
    const pen = this.pen!;
    const s = this.drafts.get(pen.id);
    const n = count(pen.c);
    const sc = (x: number, y: number) => this.toScreen(pen.o[0] + x, pen.o[1] + y);
    if (s) o.outlines = this.outline(s);
    const last = new Set([keyOf({ c: 0, i: n - 1 })]);
    if (this.penDrag?.closing) last.add('0:0');
    this.pathMarks(o, [pen.c], sc, pen.curve === 'spline' ? new Set() : last, last, pen.curve === 'spline');
    // The next segment, from the last point to the pointer (it bends with the last out handle).
    if (this.pointer && !this.penDrag && !pen.c.closed) {
      const v = getPt([pen.c], { c: 0, i: n - 1 });
      const [ax, ay] = sc(v.x, v.y), [bx, by] = sc(v.ox, v.oy);
      const [px, py] = this.pointer;
      const f = (x: number) => Math.round(x * 10) / 10;
      o.rubber = `M${f(ax)} ${f(ay)}C${f(bx)} ${f(by)} ${f(px)} ${f(py)} ${f(px)} ${f(py)}`;
      const [fx, fy] = sc(pen.c.pts[0], pen.c.pts[1]);
      if (n >= 2 && Math.hypot(px - fx, py - fy) <= 10) o.tip = { text: 'Click the first point to close the shape', x: fx + 16, y: fy + 18 };
    }
    o.bar = { kind: 'pen', points: n, selected: 0, curve: pen.curve };
    return o;
  }

  /** Live numbers while drawing or changing: size, radius, angle (screen pixels, degrees). */
  private readout(): SelectOverlay['readout'] {
    const kind = this.create ? 'create' : this.edit?.moved ? this.edit.kind : null;
    if (!kind || !this.pointer || kind === 'move') return null;
    // The shapes the gesture changes (a part shows its own numbers, not its compound's).
    const list = this.edit ? [...this.edit.orig.keys()].map((id) => this.current(id)).filter((s): s is Shape => !!s) : [...this.drafts.values()];
    if (!list.length) return null;
    const s = list[0];
    const n = (v: number) => (v >= 100 ? Math.round(v) : Math.round(v * 10) / 10);
    const sx = Math.hypot(s.m[0], s.m[1]) * this.zoom, sy = Math.hypot(s.m[2], s.m[3]) * this.zoom;
    const deg = Math.round(((Math.atan2(s.m[1], s.m[0]) * 180) / Math.PI + 360) % 360);
    let text: string;
    if (kind === 'rotate') text = list.length > 1 ? `${Math.round(((Math.atan2(s.m[1], s.m[0]) - Math.atan2(this.edit!.orig.get(s.id)!.m[1], this.edit!.orig.get(s.id)!.m[0])) * 180) / Math.PI)}°` : `${deg}°`;
    else if (s.kind === 'line') {
      const l = s.line!;
      const a = apply(s.m, l[0], l[1]), b = apply(s.m, l[2], l[3]);
      text = `${n(Math.hypot(b[0] - a[0], b[1] - a[1]) * this.zoom)} px · ${Math.round(((Math.atan2(b[1] - a[1], b[0] - a[0]) * -180) / Math.PI + 360) % 360)}°`;
    } else if (list.length > 1) {
      const b = this.boxOf(list)!.corners;
      text = `${n((b[1][0] - b[0][0]) * this.zoom)} × ${n((b[3][1] - b[0][1]) * this.zoom)}`;
    } else {
      text = `${n(s.w * sx)} × ${n(s.h * sy)}`;
      if (s.kind === 'rect') {
        const r = s.radii ?? [0, 0, 0, 0];
        const k = this.pxPerUnit(s);
        text += r.every((v) => v === r[0]) ? ` · radius ${n(r[0] * k)}` : ` · radius ${r.map((v) => n(v * k)).join(' ')}`;
      } else if (s.kind === 'polygon' || s.kind === 'star') {
        text += ` · rounding ${n((s.rounding ?? 0) * this.pxPerUnit(s))}`;
      }
    }
    return { text, x: this.pointer[0] + 16, y: this.pointer[1] + 16 };
  }
}

// --- helpers ---------------------------------------------------------------------------------------

/** The curve of a shape's path (non-path shapes become Bezier paths). */
const curveOf = (s: Shape) => (s.kind === 'path' ? s.curve : undefined);

/** The path that point editing changes: a path's own points, or any other shape as a Bezier path. */
function editPath(s: Shape): PathContour[] {
  return s.kind === 'path' ? clonePath(s.path ?? []) : toPath(s);
}

/** Radius of the smoothness ring around a selected spline point (CSS px). */
export const ringRadius = (touch: boolean) => (touch ? 30 : 20);

/** Where the ring's knob is: at the top for a corner, clockwise up to the bottom for soft (1), counterclockwise for through (-1). */
export function ringKnob(x: number, y: number, smooth: number, touch: boolean): Pt {
  const a = smooth * Math.PI, r = ringRadius(touch);
  return [x + r * Math.sin(a), y - r * Math.cos(a)];
}

/** Shapes with radius dots: rectangles (a radius per corner), polygons and stars (one rounding). */
const hasRadiusDots = (s: Shape) => s.kind === 'rect' || s.kind === 'polygon' || s.kind === 'star';

/** Outer corners: every corner of a polygon, the points of a star (its inner corners have no dot). */
const outerCorners = (s: Shape) => (s.kind === 'star' ? (s.points ?? 5) : (s.sides ?? 6));

/**
 * Outer corner i of a polygon or star, in the shape's own units: the corner `v`, the unit
 * bisector `u` into the shape, sin of half the corner angle (the arc center lies at
 * rounding / sinHalf along `u`), and how far along `u` a dot may go (the center of the shape).
 */
function polyCorner(s: Shape, i: number): { v: Pt; u: Pt; sinHalf: number; reach: number } | null {
  const p = cornerPoints(s);
  const n = p.length / 2;
  const at = s.kind === 'star' ? 2 * i : i;
  const v: Pt = [p[2 * at], p[2 * at + 1]];
  const j = (at + n - 1) % n, k = (at + 1) % n;
  let ax = p[2 * j] - v[0], ay = p[2 * j + 1] - v[1], bx = p[2 * k] - v[0], by = p[2 * k + 1] - v[1];
  const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
  if (!la || !lb) return null;
  ax /= la;
  ay /= la;
  bx /= lb;
  by /= lb;
  const ux = ax + bx, uy = ay + by, lu = Math.hypot(ux, uy);
  if (lu < 1e-9) return null;
  const half = Math.acos(Math.max(-1, Math.min(1, ax * bx + ay * by))) / 2;
  return { v, u: [ux / lu, uy / lu], sinHalf: Math.sin(half), reach: Math.hypot(s.w / 2 - v[0], s.h / 2 - v[1]) };
}

/** The props a shape op carries (no author, seq or deleted flag). */
export function toInput(s: Shape): ShapeInput {
  const { author: _a, seq: _s, deleted: _d, ...input } = s;
  return input;
}

function apply(m: Affine, x: number, y: number): Pt {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

const mid = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

/** A line with new end points (local units): the frame becomes their box again. */
function normalizeLine(s: Shape, pts: number[]): Shape {
  const x0 = Math.min(pts[0], pts[2]), y0 = Math.min(pts[1], pts[3]);
  return {
    ...s,
    w: Math.abs(pts[2] - pts[0]),
    h: Math.abs(pts[3] - pts[1]),
    m: compose(s.m, [1, 0, 0, 1, x0, y0]),
    line: [pts[0] - x0, pts[1] - y0, pts[2] - x0, pts[3] - y0],
  };
}

function insidePoly(x: number, y: number, c: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = c.length - 1; i < c.length; j = i++) {
    const [xi, yi] = c[i], [xj, yj] = c[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distSeg(x: number, y: number, a: Pt, b: Pt): number {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const l = vx * vx + vy * vy;
  const t = l > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * vx + (y - a[1]) * vy) / l)) : 0;
  return Math.hypot(a[0] + t * vx - x, a[1] + t * vy - y);
}

/** SVG path data of a polyline, cut to `box` (a closed one stays closed). */
function polyPath(pts: number[], closed: boolean, box: Box): string {
  const f = (v: number) => Math.round(v * 10) / 10;
  if (closed) {
    const c = clipPolygon(pts, box);
    if (c.length < 6) return '';
    let d = `M${f(c[0])} ${f(c[1])}`;
    for (let i = 2; i < c.length; i += 2) d += `L${f(c[i])} ${f(c[i + 1])}`;
    return d + 'Z';
  }
  // Open: each segment cut to the box on its own.
  let d = '';
  for (let i = 2; i < pts.length; i += 2) {
    const s = clipSeg(pts[i - 2], pts[i - 1], pts[i], pts[i + 1], box);
    if (s) d += `M${f(s[0])} ${f(s[1])}L${f(s[2])} ${f(s[3])}`;
  }
  return d;
}

function clipSeg(ax: number, ay: number, bx: number, by: number, box: Box): [number, number, number, number] | null {
  // Liang–Barsky.
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dy = by - ay;
  const edges: [number, number][] = [[-dx, ax - box[0]], [dx, box[2] - ax], [-dy, ay - box[1]], [dy, box[3] - ay]];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null;
    } else {
      const r = q / p;
      if (p < 0) t0 = Math.max(t0, r);
      else t1 = Math.min(t1, r);
    }
  }
  if (t0 > t1) return null;
  return [ax + t0 * dx, ay + t0 * dy, ax + t1 * dx, ay + t1 * dy];
}

