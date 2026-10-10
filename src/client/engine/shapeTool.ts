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
import { byZ, clipPolygon, cornerPoints, hitShape, outlinePolys, shapeBounds, type Box } from '../../shared/shapes';
import { LIMITS, type Affine, type ClientMsg, type Layer, type Op, type Shape, type ShapeInput, type ShapeKind, type ShapeProps } from '../../shared/types';
import { ed, showToast, type SelectOverlay } from '../state.svelte';
import type { Doc } from './doc';
import type { Renderer } from './renderer';

export const SHAPE_LABEL: Record<ShapeKind, string> = { rect: 'Rectangle', ellipse: 'Ellipse', polygon: 'Polygon', star: 'Star', line: 'Line' };

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
const PROP_KEYS: (keyof ShapeProps)[] = ['name', 'z', 'w', 'h', 'm', 'radii', 'radiiLinked', 'sides', 'points', 'innerRatio', 'rounding', 'line', 'fill', 'stroke', 'strokeWidth', 'align', 'cap', 'join'];

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
    return this.drafts.get(id) ?? this.view().get(id);
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
    const keep = ed.selection.filter((id) => {
      const s = v.get(id);
      return s && !s.deleted && byId.has(s.layerId);
    });
    if (keep.length !== ed.selection.length) ed.selection = keep;
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
    this.drafts = new Map(list.map((s) => [s.id, s]));
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
    const g = this.edit ?? this.create ?? this.marquee;
    return !!g && (pointerId === undefined || g.pointerId === pointerId);
  }

  down(e: PointerEvent, x: number, y: number): void {
    const touch = e.pointerType === 'touch';
    if (ed.tool === 'shape') return this.beginCreate(e, x, y, touch);
    // Double-click: kept for point editing (phase 2).
    const now = performance.now();
    const dbl = now - this.lastClick.t < DOUBLE_MS && Math.hypot(x - this.lastClick.x, y - this.lastClick.y) < 8;
    this.lastClick = { t: dbl ? 0 : now, x, y };
    const zone = this.zoneAt(x, y, touch);
    if (dbl && (zone || this.shapeAt(x, y, touch))) {
      showToast('Point editing comes in a later version');
      return;
    }
    if (zone) {
      if (!ed.canEdit) return showToast('View only: you can look around but not change shapes');
      return this.beginEdit(e, x, y, zone.kind === 'move' ? 'move' : zone.kind, zone);
    }
    const hit = this.shapeAt(x, y, touch);
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
    if (!ed.selection.length) return false;
    this.select([]);
    return true;
  }

  // --- creating ---------------------------------------------------------------------------------

  private beginCreate(e: PointerEvent, x: number, y: number, touch: boolean): void {
    if (!ed.canEdit) return showToast('View only: you can look around but not draw');
    const active = this.host.activeLayer();
    let layerId: string;
    let createdLayer: string | null = null;
    const byId = new Map(ed.layers.map((l) => [l.id, l]));
    if (active?.kind === 'shape' && effectivelyVisible(byId, active)) layerId = active.id;
    else {
      // A new shape layer above the active layer. The press makes it now, so the drag already
      // shows on it (and to other people).
      if (ed.layers.length >= LIMITS.maxLayers) return showToast('Too many layers');
      layerId = createdLayer = newId();
      this.host.sendOp({
        type: 'layer.add',
        layer: { id: layerId, kind: 'shape', name: this.host.nextName('Shapes'), ...this.host.newLayerPlace(), blend: 'normal', opacity: 1, visible: true },
      });
      this.host.setActiveLayer(layerId);
    }
    let z = 0;
    for (const s of this.view().values()) if (s.layerId === layerId && !s.deleted) z = Math.max(z, s.z);
    this.create = { pointerId: e.pointerId, touch, p0: this.toWorld(x, y), s0: [x, y], id: newId(), layerId, createdLayer, z: z + 1, moved: false };
    ed.selection = [];
    this.hover = null;
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
    }
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
    s.name = this.nextShapeName(s.kind);
    this.clearDrafts();
    const op: Op = { type: 'shape.add', shape: toInput(s) };
    this.host.sendOp(op);
    this.host.pushUndo({
      undo: [{ type: 'shape.remove', id: s.id }, ...(c.createdLayer ? [{ type: 'layer.remove', id: c.createdLayer } as Op] : [])],
      redo: [...(c.createdLayer ? [{ type: 'layer.restore', id: c.createdLayer } as Op] : []), { type: 'shape.restore', id: s.id }],
    });
    this.select([s.id]);
  }

  private nextShapeName(kind: ShapeKind): string {
    const prefix = SHAPE_LABEL[kind];
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
    return { ...s, w: x1 - x0, h: y1 - y0, m: compose(s.m, [1, 0, 0, 1, x0, y0]) };
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
    const undo: Op[] = [], redo: Op[] = [];
    for (const n of next) {
      const o = orig.get(n.id);
      if (!o) continue;
      const props: Partial<ShapeProps> = {}, old: Partial<ShapeProps> = {};
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
    const live = ids.filter((id) => {
      const s = this.current(id);
      return s && !s.deleted;
    });
    for (const id of live) this.host.sendOp({ type: 'shape.remove', id });
    this.host.pushUndo({
      undo: live.map((id) => ({ type: 'shape.restore', id }) as Op),
      redo: live.map((id) => ({ type: 'shape.remove', id }) as Op),
    });
    ed.selection = ed.selection.filter((id) => !live.includes(id));
    this.scheduleOverlay();
  }

  /** Arrow keys: moves the selection by one screen pixel (Shift: ten). */
  nudge(dx: number, dy: number): void {
    const sel = this.selected();
    if (!sel.length || !ed.canEdit || this.busy()) return;
    const d = 1 / this.zoom;
    this.commit(new Map(sel.map((s) => [s.id, s])), sel.map((s) => ({ ...s, m: [s.m[0], s.m[1], s.m[2], s.m[3], s.m[4] + dx * d, s.m[5] + dy * d] as Affine })));
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
    if ((tool !== 'select' && tool !== 'shape') || ed.transform) {
      if (ed.overlay) ed.overlay = null;
      return;
    }
    const o: SelectOverlay = { hover: null, outlines: [], box: null, handles: [], dots: [], ends: [], marquee: null, readout: null };
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
        o.hover = { outline: this.outline(s), label: s.name || SHAPE_LABEL[s.kind], x: this.pointer[0], y: this.pointer[1] };
      }
    }
    const mq = this.marquee;
    if (mq?.moved) o.marquee = [Math.min(mq.s0[0], mq.s1[0]), Math.min(mq.s0[1], mq.s1[1]), Math.abs(mq.s1[0] - mq.s0[0]), Math.abs(mq.s1[1] - mq.s0[1])];
    o.readout = this.readout();
    ed.overlay = o;
  }

  /** Live numbers while drawing or changing: size, radius, angle (screen pixels, degrees). */
  private readout(): SelectOverlay['readout'] {
    const kind = this.create ? 'create' : this.edit?.moved ? this.edit.kind : null;
    if (!kind || !this.pointer || kind === 'move') return null;
    const list = [...this.drafts.values()];
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

