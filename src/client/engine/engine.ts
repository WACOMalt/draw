// Glue between input, the document, the network and the compositor.

import { pointDecimals, quantizePoint } from '../../shared/brush';
import { newId } from '../../shared/ids';
import { LIMITS, type Brush, type Layer, type LayerProps, type Op, type ServerMsg } from '../../shared/types';
import { ed, save, showToast, type Tool } from '../state.svelte';
import { Compositor } from './compositor';
import { Doc } from './doc';
import { Net } from './net';

// Float64 keeps about 15 significant digits, so zoom is limited, not truly infinite.
// This range stays precise for drawings within about 1e4 world units of where you work.
const MIN_ZOOM = 1e-9;
const MAX_ZOOM = 1e11;
const LIVE_FLUSH_MS = 40;
const BUILDUP_MS = 30;
const CURSOR_MS = 50;
/** A second finger within this time after the first cancels the first finger's stroke. */
const GESTURE_GRACE_MS = 300;
/** Max duration and movement of a two/three-finger tap (undo/redo). */
const TAP_MS = 300;
const TAP_SLOP = 12;

interface UndoEntry {
  undo: Op[];
  redo: Op[];
  key?: string;
  t: number;
}

interface Gesture {
  count: number; // fingers at the last rebase
  maxTouches: number;
  mid0: [number, number];
  dist0: number;
  zoom0: number;
  world0: [number, number];
  t0: number;
  moved: boolean;
}

interface ActiveStroke {
  id: string;
  layerId: string;
  brush: Brush;
  pointerId: number;
  pointerType: string;
  startedAt: number;
  count: number;
  pts: number[];
  unsent: number[];
  started: boolean;
  sx: number; // smoothed position
  sy: number;
  last: [number, number, number] | null; // last quantized point
  raw: [number, number, number];
  decimals: number; // point precision, fixed for the stroke from the zoom at its start
  lastMove: number;
  timers: number[];
}

export class Engine {
  readonly comp: Compositor;
  private doc = new Doc();
  private net: Net;
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private stroke: ActiveStroke | null = null;
  private pan: { pointerId: number; x: number; y: number } | null = null;
  private picking: number | null = null;
  private spaceDown = false;
  private altDown = false;
  private rect: DOMRect;
  private lastCursorSent = 0;
  private livesByPeer = new Map<string, Set<string>>();
  private cleanup: (() => void)[] = [];
  private pointer: { x: number; y: number } | null = null;
  private touches = new Map<number, [number, number]>();
  /** Extra fingers that landed during a stroke and must not do anything. */
  private ignoredTouches = new Set<number>();
  private gesture: Gesture | null = null;
  /** After a gesture, fingers do nothing until all of them are lifted. */
  private touchLock = false;
  /** Once a pen is used, a finger navigates instead of drawing (palm rejection). */
  private penSeen = false;

  constructor(
    private code: string,
    private canvas: HTMLCanvasElement,
    private brushCursor: HTMLElement,
  ) {
    this.comp = new Compositor(canvas);
    this.rect = canvas.getBoundingClientRect();
    this.restoreView();

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(canvas);
    this.cleanup.push(() => ro.disconnect());
    this.resize();

    this.net = new Net(
      code,
      (m) => this.onServer(m),
      (s) => (ed.status = s),
      () => this.net.send({ t: 'hello', name: ed.name, color: ed.color }),
    );

    this.listen(canvas, 'pointerdown', (e) => this.onPointerDown(e as PointerEvent));
    this.listen(canvas, 'pointermove', (e) => this.onPointerMove(e as PointerEvent));
    this.listen(canvas, 'pointerup', (e) => this.onPointerUp(e as PointerEvent));
    this.listen(canvas, 'pointercancel', (e) => this.onPointerUp(e as PointerEvent));
    this.listen(canvas, 'pointerleave', () => this.onPointerLeave());
    this.listen(canvas, 'wheel', (e) => this.onWheel(e as WheelEvent), { passive: false });
    this.listen(canvas, 'contextmenu', (e) => e.preventDefault());
    this.listen(window, 'keydown', (e) => this.onKey(e as KeyboardEvent, true));
    this.listen(window, 'keyup', (e) => this.onKey(e as KeyboardEvent, false));
    this.listen(window, 'blur', () => {
      this.spaceDown = this.altDown = false;
      this.updateCursor();
    });
    const sweep = window.setInterval(() => this.comp.sweepLive(), 1000);
    this.cleanup.push(() => window.clearInterval(sweep));
  }

  destroy(): void {
    this.endStroke();
    this.cleanup.forEach((f) => f());
    this.net.close();
    this.comp.destroy();
  }

  private listen(t: EventTarget, type: string, fn: (e: Event) => void, opts?: AddEventListenerOptions): void {
    t.addEventListener(type, fn, opts);
    this.cleanup.push(() => t.removeEventListener(type, fn, opts));
  }

  // --- view -------------------------------------------------------------------------------

  private resize(): void {
    this.rect = this.canvas.getBoundingClientRect();
    this.comp.resize(this.rect.width, this.rect.height, window.devicePixelRatio || 1);
    this.syncView();
  }

  private restoreView(): void {
    try {
      const v = JSON.parse(localStorage.getItem(`draw.view.${this.code}`) ?? 'null');
      if (v && Number.isFinite(v.x) && Number.isFinite(v.y) && v.zoom > 0) {
        this.comp.setView(v.x, v.y, v.zoom);
        return;
      }
    } catch {
      // ignore
    }
    // Center the world origin.
    this.comp.setView(-this.rect.width / 2, -this.rect.height / 2, 1);
  }

  private saveTimer: number | undefined;
  private syncView(): void {
    const v = this.comp.view;
    ed.view = { x: v.x, y: v.y, zoom: v.zoom };
    this.updateBrushCursor();
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => save(`draw.view.${this.code}`, ed.view), 300);
  }

  setView(x: number, y: number, zoom: number): void {
    this.comp.setView(x, y, zoom);
    this.syncView();
  }

  zoomAt(cssX: number, cssY: number, zoom: number): void {
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
    const [wx, wy] = this.comp.toWorld(cssX, cssY);
    this.setView(wx - cssX / z, wy - cssY / z, z);
  }

  zoomBy(factor: number): void {
    const { w, h } = this.comp.size;
    this.zoomAt(w / 2, h / 2, this.comp.view.zoom * factor);
  }

  resetView(): void {
    const { w, h } = this.comp.size;
    const [wx, wy] = this.comp.toWorld(w / 2, h / 2);
    this.setView(wx - w / 2, wy - h / 2, 1);
  }

  // --- tools and cursor ---------------------------------------------------------------------

  private effectiveTool(): Tool {
    if (this.spaceDown || this.pan) return 'hand';
    if (this.altDown && (ed.tool === 'brush' || ed.tool === 'eraser')) return 'eyedropper';
    return ed.tool;
  }

  updateCursor(): void {
    const tool = this.effectiveTool();
    this.canvas.style.cursor =
      tool === 'hand' ? (this.pan ? 'grabbing' : 'grab') : tool === 'eyedropper' ? 'crosshair' : 'none';
    this.updateBrushCursor();
  }

  updateBrushCursor(): void {
    const el = this.brushCursor;
    const tool = this.effectiveTool();
    if (!this.pointer || (tool !== 'brush' && tool !== 'eraser')) {
      el.style.display = 'none';
      return;
    }
    const d = Math.max(3, ed.activeBrush.size);
    el.style.display = 'block';
    el.style.width = el.style.height = `${d}px`;
    el.style.transform = `translate(${this.pointer.x - d / 2}px, ${this.pointer.y - d / 2}px)`;
  }

  private local(e: PointerEvent | WheelEvent): [number, number] {
    return [e.clientX - this.rect.left, e.clientY - this.rect.top];
  }

  // --- pointer --------------------------------------------------------------------------------

  private onPointerDown(e: PointerEvent): void {
    const [x, y] = this.local(e);
    if (e.pointerType === 'pen') this.penSeen = true;
    if (e.pointerType === 'touch' && this.onTouchDown(e, x, y)) return;
    if (this.stroke || this.pan || this.picking !== null) return;
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // The pointer is already gone (or synthetic). Drawing still works without capture.
    }
    const tool = this.effectiveTool();
    if (e.button === 1 || tool === 'hand') {
      e.preventDefault();
      this.pan = { pointerId: e.pointerId, x, y };
      this.updateCursor();
      return;
    }
    if (e.button !== 0) return;
    if (tool === 'eyedropper') {
      this.picking = e.pointerId;
      this.pick(x, y);
      return;
    }
    this.beginStroke(e, x, y);
  }

  private onPointerMove(e: PointerEvent): void {
    const [x, y] = this.local(e);
    if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, [x, y]);
      if (this.gesture) return this.updateGesture();
      if (this.ignoredTouches.has(e.pointerId) || this.touchLock) return;
    }
    // Only a hovering mouse or pen shows the brush outline.
    this.pointer = e.pointerType === 'touch' ? null : { x, y };
    const [wx, wy] = this.comp.toWorld(x, y);
    ed.cursor = { x: wx, y: wy };
    this.updateBrushCursor();
    this.sendCursor(wx, wy);

    if (this.pan && e.pointerId === this.pan.pointerId) {
      const v = this.comp.view;
      this.setView(v.x - (x - this.pan.x) / v.zoom, v.y - (y - this.pan.y) / v.zoom, v.zoom);
      this.pan.x = x;
      this.pan.y = y;
      return;
    }
    if (this.picking === e.pointerId) return this.pick(x, y);
    const st = this.stroke;
    if (st && e.pointerId === st.pointerId) {
      const events = e.getCoalescedEvents?.() ?? [];
      for (const ce of events.length ? events : [e]) {
        const [cx, cy] = this.local(ce);
        this.addPoint(cx, cy, this.pressure(ce));
      }
    }
  }

  private onPointerUp(e: PointerEvent): void {
    if (e.pointerType === 'touch') {
      this.touches.delete(e.pointerId);
      this.ignoredTouches.delete(e.pointerId);
      if (this.gesture) {
        if (this.touches.size === 0) this.endGesture();
        return;
      }
      if (this.touches.size === 0) this.touchLock = false;
    }
    if (this.pan && e.pointerId === this.pan.pointerId) {
      this.pan = null;
      this.updateCursor();
    }
    if (this.picking === e.pointerId) {
      this.picking = null;
      this.addSwatch(ed.fg);
    }
    if (this.stroke && e.pointerId === this.stroke.pointerId) this.endStroke();
  }

  private onPointerLeave(): void {
    if (this.stroke) return;
    this.pointer = null;
    ed.cursor = null;
    this.updateBrushCursor();
    this.net.send({ t: 'cursor', x: null, y: null, layerId: ed.activeLayerId });
  }

  // --- touch gestures ----------------------------------------------------------------------

  /** Returns true when the touch is used for navigation and must not draw. */
  private onTouchDown(e: PointerEvent, x: number, y: number): boolean {
    this.touches.set(e.pointerId, [x, y]);
    if (this.gesture) {
      this.startGesture(); // another finger joins: new baseline, finger count goes up
      return true;
    }
    if (this.touchLock) return true;
    if (this.touches.size >= 2) {
      const st = this.stroke;
      if (st && st.pointerType === 'touch') {
        if (performance.now() - st.startedAt > GESTURE_GRACE_MS) {
          // A real stroke is in progress: a resting finger must not interrupt it.
          this.ignoredTouches.add(e.pointerId);
          return true;
        }
        this.cancelStroke();
      }
      if (this.stroke) {
        this.ignoredTouches.add(e.pointerId); // pen is drawing; ignore the hand
        return true;
      }
      this.pan = null;
      this.picking = null;
      this.startGesture();
      return true;
    }
    if (this.penSeen && !this.stroke && !this.pan) {
      this.pan = { pointerId: e.pointerId, x, y };
      return true;
    }
    return false;
  }

  private startGesture(): void {
    const pts = [...this.touches.values()];
    const mid: [number, number] = [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
    const dist = Math.max(1, Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]));
    const prev = this.gesture;
    this.gesture = {
      count: pts.length,
      maxTouches: Math.max(prev?.maxTouches ?? 0, pts.length),
      mid0: mid,
      dist0: dist,
      zoom0: this.comp.view.zoom,
      world0: this.comp.toWorld(mid[0], mid[1]),
      t0: prev?.t0 ?? performance.now(),
      moved: prev?.moved ?? false,
    };
    this.touchLock = true;
  }

  private updateGesture(): void {
    const g = this.gesture!;
    if (this.touches.size < 2) return;
    if (this.touches.size !== g.count) return this.startGesture(); // finger added: new baseline
    const pts = [...this.touches.values()];
    const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
    const my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    const dist = Math.max(1, Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]));
    if (Math.hypot(mx - g.mid0[0], my - g.mid0[1]) > TAP_SLOP || Math.abs(dist - g.dist0) > TAP_SLOP) g.moved = true;
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, (g.zoom0 * dist) / g.dist0));
    this.setView(g.world0[0] - mx / z, g.world0[1] - my / z, z);
  }

  private endGesture(): void {
    const g = this.gesture!;
    this.gesture = null;
    this.touchLock = false;
    if (g.moved || performance.now() - g.t0 > TAP_MS) return;
    if (g.maxTouches === 2) this.undo();
    else if (g.maxTouches === 3) this.redo();
  }

  /** Drops the stroke in progress without committing it. */
  private cancelStroke(): void {
    const st = this.stroke;
    if (!st) return;
    this.stroke = null;
    st.timers.forEach((t) => window.clearInterval(t));
    this.comp.liveCancel(st.id);
    if (st.started) this.net.send({ t: 'live.end', id: st.id });
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const [x, y] = this.local(e);
    let dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
    if (e.ctrlKey) dy *= 4; // trackpad pinch reports small deltas
    dy = Math.max(-300, Math.min(300, dy));
    this.zoomAt(x, y, this.comp.view.zoom * Math.exp(-dy * 0.0015));
  }

  private pressure(e: PointerEvent): number {
    // Mice report 0.5 while pressed. Only pens give a real pressure.
    return e.pointerType === 'pen' ? e.pressure : 1;
  }

  private sendCursor(wx: number, wy: number): void {
    const now = performance.now();
    if (now - this.lastCursorSent < CURSOR_MS) return;
    this.lastCursorSent = now;
    const d = pointDecimals(this.comp.view.zoom);
    const [qx, qy] = quantizePoint(wx, wy, 0, d);
    this.net.send({ t: 'cursor', x: qx, y: qy, layerId: ed.activeLayerId });
  }

  private pick(x: number, y: number): void {
    ed.fg = this.comp.sample(x, y);
  }

  addSwatch(color: string): void {
    ed.swatches = [color, ...ed.swatches.filter((c) => c !== color)].slice(0, 18);
  }

  // --- strokes --------------------------------------------------------------------------------

  private beginStroke(e: PointerEvent, x: number, y: number): void {
    const layer = this.activeLayer();
    if (!layer) return showToast('Add a layer first');
    if (!layer.visible) return showToast('The active layer is hidden');
    const tool = this.effectiveTool();
    const settings = tool === 'eraser' ? ed.eraser : ed.brush;
    // Size is in screen pixels: what you see is what you draw, at any zoom.
    const zoom = this.comp.view.zoom;
    const brush: Brush = {
      ...settings,
      size: Math.min(LIMITS.maxBrushWorld, Math.max(LIMITS.minBrushWorld, settings.size / zoom)),
      tool: tool === 'eraser' ? 'erase' : 'paint',
      color: ed.fg,
    };
    const st: ActiveStroke = {
      id: newId(),
      layerId: layer.id,
      brush,
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      startedAt: performance.now(),
      count: 0,
      pts: [],
      unsent: [],
      started: false,
      sx: x,
      sy: y,
      last: null,
      raw: [x, y, this.pressure(e)],
      decimals: pointDecimals(zoom * (window.devicePixelRatio || 1)),
      lastMove: performance.now(),
      timers: [],
    };
    this.stroke = st;
    this.comp.liveBegin(st.id, st.layerId, brush, false);
    this.addPoint(x, y, this.pressure(e));
    st.timers.push(window.setInterval(() => this.flushLive(), LIVE_FLUSH_MS));
    if (brush.buildup) {
      st.timers.push(
        window.setInterval(() => {
          if (st.last && performance.now() - st.lastMove >= BUILDUP_MS) this.pushPoint(st, st.last, true);
        }, BUILDUP_MS),
      );
    }
  }

  private addPoint(x: number, y: number, p: number): void {
    const st = this.stroke;
    if (!st) return;
    st.raw = [x, y, p];
    if (st.count === 0) {
      st.sx = x;
      st.sy = y;
    } else {
      const k = 1 - Math.min(0.95, ed.smoothing) * 0.9;
      st.sx += (x - st.sx) * k;
      st.sy += (y - st.sy) * k;
    }
    const [wx, wy] = this.comp.toWorld(st.sx, st.sy);
    const q = quantizePoint(wx, wy, p, st.decimals);
    if (st.last) {
      // Skip moves under about a third of a device pixel.
      const minDist = 0.35 / (this.comp.view.zoom * (window.devicePixelRatio || 1));
      if (Math.hypot(q[0] - st.last[0], q[1] - st.last[1]) < minDist) return;
    }
    st.lastMove = performance.now();
    this.pushPoint(st, q, false);
  }

  private pushPoint(st: ActiveStroke, q: [number, number, number], _buildup: boolean): void {
    if (st.count >= LIMITS.maxStrokePoints) return;
    st.last = q;
    st.count++;
    st.pts.push(q[0], q[1], q[2]);
    st.unsent.push(q[0], q[1], q[2]);
    this.comp.liveAppend(st.id, q);
    if (st.count >= LIMITS.maxStrokePoints && this.stroke === st) this.endStroke();
  }

  private flushLive(): void {
    const st = this.stroke;
    if (!st || st.unsent.length === 0) return;
    if (this.net.send({ t: 'live', id: st.id, layerId: st.layerId, brush: st.brush, pts: st.unsent, start: !st.started })) {
      st.started = true;
    }
    st.unsent = [];
  }

  private endStroke(): void {
    const st = this.stroke;
    if (!st) return;
    this.stroke = null;
    st.timers.forEach((t) => window.clearInterval(t));
    // Smoothing trails the pen. Finish at the real end point.
    if (ed.smoothing > 0 && st.count > 1) {
      const [x, y, p] = st.raw;
      const [wx, wy] = this.comp.toWorld(x, y);
      const q = quantizePoint(wx, wy, p, st.decimals);
      if (!st.last || q[0] !== st.last[0] || q[1] !== st.last[1]) this.pushPoint(st, q, false);
    }
    if (st.unsent.length) {
      this.net.send({ t: 'live', id: st.id, layerId: st.layerId, brush: st.brush, pts: st.unsent, start: !st.started });
      st.unsent = [];
    }
    if (st.pts.length === 0) {
      this.comp.liveCancel(st.id);
      return;
    }
    this.sendOp({ type: 'stroke.add', stroke: { id: st.id, layerId: st.layerId, brush: st.brush, pts: st.pts } });
    this.pushUndo({ undo: [{ type: 'stroke.remove', id: st.id }], redo: [{ type: 'stroke.restore', id: st.id }] });
    if (st.brush.tool === 'paint') this.addSwatch(st.brush.color);
  }

  // --- ops, undo ------------------------------------------------------------------------------

  private sendOp(op: Op): void {
    const opId = newId();
    this.doc.addPending(opId, op);
    this.net.send({ t: 'op', opId, op });
    if (op.type.startsWith('layer.')) this.refreshLayers();
  }

  private pushUndo(e: Omit<UndoEntry, 't'>): void {
    this.undoStack.push({ ...e, t: Date.now() });
    if (this.undoStack.length > 300) this.undoStack.shift();
    this.redoStack = [];
    this.syncUndo();
  }

  private syncUndo(): void {
    ed.canUndo = this.undoStack.length > 0;
    ed.canRedo = this.redoStack.length > 0;
  }

  undo(): void {
    if (this.stroke) return;
    const e = this.undoStack.pop();
    if (!e) return;
    e.undo.forEach((op) => this.sendOp(op));
    this.redoStack.push(e);
    this.syncUndo();
  }

  redo(): void {
    if (this.stroke) return;
    const e = this.redoStack.pop();
    if (!e) return;
    e.redo.forEach((op) => this.sendOp(op));
    this.undoStack.push(e);
    this.syncUndo();
  }

  // --- layers ---------------------------------------------------------------------------------

  private activeLayer(): Layer | undefined {
    return ed.layers.find((l) => l.id === ed.activeLayerId);
  }

  private refreshLayers(): void {
    const layers = this.doc.displayLayers();
    ed.layers = layers;
    this.comp.setLayers(layers);
    if (!layers.some((l) => l.id === ed.activeLayerId)) ed.activeLayerId = layers.at(-1)?.id ?? null;
  }

  addLayer(): void {
    const layers = this.doc.displayLayers();
    const i = layers.findIndex((l) => l.id === ed.activeLayerId);
    const active = layers[i];
    const above = layers[i + 1];
    const order = active ? (above ? (active.order + above.order) / 2 : active.order + 1) : 1;
    let n = 1;
    for (const l of this.doc.layers.values()) {
      const m = /^Layer (\d+)$/.exec(l.name);
      if (m) n = Math.max(n, +m[1] + 1);
    }
    const id = newId();
    this.sendOp({
      type: 'layer.add',
      layer: { id, name: `Layer ${n}`, order, blend: 'normal', opacity: 1, visible: true },
    });
    this.pushUndo({ undo: [{ type: 'layer.remove', id }], redo: [{ type: 'layer.restore', id }] });
    ed.activeLayerId = id;
  }

  deleteLayer(id: string): void {
    const layers = this.doc.displayLayers();
    if (layers.length <= 1) return showToast('A canvas needs at least one layer');
    const i = layers.findIndex((l) => l.id === id);
    if (i < 0) return;
    if (ed.activeLayerId === id) ed.activeLayerId = (layers[i - 1] ?? layers[i + 1]).id;
    this.sendOp({ type: 'layer.remove', id });
    this.pushUndo({ undo: [{ type: 'layer.restore', id }], redo: [{ type: 'layer.remove', id }] });
  }

  /** Sets layer properties. Calls with the same `key` within 2 s merge into one undo step. */
  updateLayer(id: string, props: Partial<LayerProps>, key?: string): void {
    const old = this.doc.layer(id);
    if (!old) return;
    const oldProps: Partial<LayerProps> = {};
    let changed = false;
    for (const k of Object.keys(props) as (keyof LayerProps)[]) {
      (oldProps as Record<string, unknown>)[k] = old[k];
      if (old[k] !== props[k]) changed = true;
    }
    if (!changed) return;
    this.sendOp({ type: 'layer.update', id, props });
    const top = this.undoStack.at(-1);
    const now = Date.now();
    if (key && top && top.key === `${id}:${key}` && now - top.t < 2000 && this.redoStack.length === 0) {
      top.redo = [{ type: 'layer.update', id, props }];
      top.t = now;
      return;
    }
    this.pushUndo({
      undo: [{ type: 'layer.update', id, props: oldProps }],
      redo: [{ type: 'layer.update', id, props }],
      key: key ? `${id}:${key}` : undefined,
    });
  }

  /** dir +1 moves the layer up (toward the top), -1 moves it down. */
  moveLayer(id: string, dir: 1 | -1): void {
    const layers = this.doc.displayLayers();
    const i = layers.findIndex((l) => l.id === id);
    const neighbor = layers[i + dir];
    if (i < 0 || !neighbor) return;
    const beyond = layers[i + 2 * dir];
    let order = beyond ? (neighbor.order + beyond.order) / 2 : neighbor.order + dir;
    if (order === neighbor.order) order = neighbor.order + dir * 1e-9;
    this.updateLayer(id, { order });
  }

  setActiveLayer(id: string): void {
    ed.activeLayerId = id;
  }

  // --- server messages ----------------------------------------------------------------------------

  private onServer(m: ServerMsg): void {
    switch (m.t) {
      case 'welcome': {
        ed.clientId = m.clientId;
        this.doc.reset(m.seq, m.layers, m.strokes);
        this.comp.resetStrokes(m.strokes, m.seq);
        ed.peers = m.peers.map((p) => ({ ...p, x: null, y: null, layerId: null }));
        ed.strokeCount = this.doc.strokes.size;
        // Ops from before a reconnect have no echo yet. The server drops duplicates.
        for (const p of this.doc.pending) this.net.send({ t: 'op', opId: p.opId, op: p.op });
        this.refreshLayers();
        ed.status = 'online';
        break;
      }
      case 'op': {
        this.doc.apply(m.seq, m.op);
        if (m.by === ed.clientId) this.doc.dropPending(m.opId);
        const op = m.op;
        if (op.type === 'stroke.add' || op.type === 'stroke.restore') {
          this.comp.addStroke(op.stroke, m.seq);
          this.comp.liveCommit(op.stroke.id, m.seq);
        } else if (op.type === 'stroke.remove') {
          this.comp.removeStroke(op.id, m.seq);
        } else {
          this.comp.advanceSeq(m.seq);
          this.refreshLayers();
        }
        ed.strokeCount = this.doc.strokes.size;
        break;
      }
      case 'reject': {
        const p = this.doc.dropPending(m.opId);
        if (p?.op.type === 'stroke.add') {
          this.comp.liveCancel(p.op.stroke.id);
          this.net.send({ t: 'live.end', id: p.op.stroke.id });
        }
        if (!/duplicate|no such stroke|not deleted/.test(m.reason)) showToast(`Change rejected: ${m.reason}`);
        this.refreshLayers();
        break;
      }
      case 'live': {
        if (!this.comp.hasLive(m.id)) {
          this.comp.liveBegin(m.id, m.layerId, m.brush, true);
          let set = this.livesByPeer.get(m.by);
          if (!set) this.livesByPeer.set(m.by, (set = new Set()));
          set.add(m.id);
        }
        this.comp.liveAppend(m.id, m.pts);
        break;
      }
      case 'live.end':
        this.comp.liveEnd(m.id);
        break;
      case 'cursor': {
        const peer = ed.peers.find((p) => p.id === m.by);
        if (peer) {
          peer.x = m.x;
          peer.y = m.y;
          peer.layerId = m.layerId;
        }
        break;
      }
      case 'peer.join':
        ed.peers = [...ed.peers.filter((p) => p.id !== m.peer.id), { ...m.peer, x: null, y: null, layerId: null }];
        break;
      case 'peer.leave':
        ed.peers = ed.peers.filter((p) => p.id !== m.id);
        for (const id of this.livesByPeer.get(m.id) ?? []) this.comp.liveEnd(id);
        this.livesByPeer.delete(m.id);
        break;
      case 'error':
        showToast(m.message);
        break;
    }
  }

  // --- keyboard ------------------------------------------------------------------------------------

  private onKey(e: KeyboardEvent, down: boolean): void {
    const t = e.target as HTMLElement | null;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    if (e.code === 'Space' && !typing) {
      e.preventDefault();
      if (this.spaceDown !== down) {
        this.spaceDown = down;
        this.updateCursor();
      }
      return;
    }
    if (e.key === 'Alt') {
      e.preventDefault();
      this.altDown = down;
      this.updateCursor();
      return;
    }
    if (!down || typing) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod) {
      if (key === 'z') {
        e.preventDefault();
        if (e.shiftKey) this.redo();
        else this.undo();
      } else if (key === 'y') {
        e.preventDefault();
        this.redo();
      } else if (key === '=' || key === '+') {
        e.preventDefault();
        this.zoomBy(1.25);
      } else if (key === '-') {
        e.preventDefault();
        this.zoomBy(0.8);
      } else if (key === '0') {
        e.preventDefault();
        this.resetView();
      }
      return;
    }
    const b = ed.activeBrush;
    switch (e.code) {
      case 'BracketLeft':
      case 'BracketRight': {
        const dir = e.code === 'BracketRight' ? 1 : -1;
        if (e.shiftKey) b.hardness = Math.round(Math.min(1, Math.max(0, b.hardness + dir * 0.1)) * 100) / 100;
        else b.size = Math.round(Math.min(LIMITS.maxBrushPx, Math.max(1, b.size * (dir > 0 ? 1.15 : 1 / 1.15) + dir)));
        this.updateBrushCursor();
        return;
      }
    }
    if (/^[0-9]$/.test(e.key)) {
      const v = e.key === '0' ? 1 : +e.key / 10;
      if (e.shiftKey) b.flow = v;
      else b.opacity = v;
      return;
    }
    const tools: Record<string, Tool> = { b: 'brush', e: 'eraser', i: 'eyedropper', h: 'hand' };
    if (tools[key]) {
      ed.tool = tools[key];
      this.updateCursor();
    } else if (key === 'x') {
      [ed.fg, ed.bg] = [ed.bg, ed.fg];
    } else if (key === 'd') {
      ed.fg = '#000000';
      ed.bg = '#ffffff';
    }
  }

  async exportPng(): Promise<void> {
    const blob = await this.comp.exportPng();
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `draw-${this.code}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
}
