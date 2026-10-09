// Glue between input, the document, the network and the compositor.

import { pointDecimals, quantizePoint } from '../../shared/brush';
import { newId } from '../../shared/ids';
import {
  DEFAULT_ADJUST,
  DOC_FEATURES,
  LIMITS,
  PREVIEW_LIMITS,
  type Adjust,
  type Affine,
  type AdjustType,
  type Brush,
  type Layer,
  type LayerProps,
  type Op,
  type ServerMsg,
  type Stroke,
} from '../../shared/types';
import { maskKey } from './strokeIndex';
import { ed, save, showToast, type Tool } from '../state.svelte';
import { createRenderer } from './createRenderer';
import type { Renderer } from './renderer';
import { Doc, type Bounds } from './doc';
import { computeMarkers, unionAll } from './navigator';
import { PUBLIC_ORIGIN } from '../config';
import { BDRAW_EXT, makeBdraw } from '../../shared/bdraw';
import { encodeBdraw, pickFile, saveBlob } from '../files';
import { anonSecret, desktopToken, followRename, grants, links } from '../identity';
import { Net } from './net';
import { blobToDataUrl, padded, renderPng, toAspect } from '../export/region';
import { effectivelyVisible, invert, sortLayers, subtreeIds } from '../../shared/layers';
import { nativePenFor, takePenSamples, type PenSample } from './nativePen';
import { takeDismissed } from '../dismiss';
import { slowDevice } from './perf';

// Float64 keeps about 15 significant digits, so zoom is limited, not truly infinite.
// This range stays precise for drawings within about 1e4 world units of where you work.
const MIN_ZOOM = 1e-9;
const MAX_ZOOM = 1e11;
const LIVE_FLUSH_MS = 40;
const BUILDUP_MS = 30;
const CURSOR_MS = 50;
const MARKERS_MS = 120;
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
  /**
   * Desktop app with a native pen (nativePen.ts): points come from the native samples. dx, dy
   * map sample positions to client coordinates; trail keeps the last few for a sanity check.
   */
  native: { dx: number; dy: number; trail: [number, number][] } | null;
  /** Painting on a layer mask: its id. */
  mask?: string;
}

/** Drops tip and dynamics fields that hold their default: plain strokes stay as small as before. */
function cleanBrush(b: Brush): Brush {
  const o = { ...b };
  if (!o.tip || o.tip === 'round') delete o.tip;
  if (o.roundness === undefined || o.roundness >= 1) delete o.roundness;
  if (!o.angle || (!o.tip && o.roundness === undefined)) delete o.angle;
  if (!o.followDirection) delete o.followDirection;
  for (const k of ['sizeJitter', 'angleJitter', 'scatter', 'opacityJitter'] as const) if (!o[k]) delete o[k];
  if (!o.grain) {
    delete o.grain;
    delete o.grainScale;
    delete o.grainStrength;
  }
  return o;
}

/** A color as the grey of its luminance: what a layer mask stores. */
function greyOf(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const l = Math.round(0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255));
  const h = l.toString(16).padStart(2, '0');
  return `#${h}${h}${h}`;
}

/** What a layer property is when it is not set: undo must send a value, not undefined. */
const PROP_DEFAULTS: Partial<LayerProps> = { clip: false, mask: null };

/** Squared distance between the segments a–b and c–d (zero when they cross). */
function segDist2(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): number {
  const cross = (ox: number, oy: number, px: number, py: number, qx: number, qy: number) => (px - ox) * (qy - oy) - (py - oy) * (qx - ox);
  const d1 = cross(cx, cy, dx, dy, ax, ay), d2 = cross(cx, cy, dx, dy, bx, by);
  const d3 = cross(ax, ay, bx, by, cx, cy), d4 = cross(ax, ay, bx, by, dx, dy);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  const pt = (px: number, py: number, sx: number, sy: number, ex: number, ey: number) => {
    const vx = ex - sx, vy = ey - sy;
    const len = vx * vx + vy * vy;
    const t = len > 0 ? Math.max(0, Math.min(1, ((px - sx) * vx + (py - sy) * vy) / len)) : 0;
    const qx = sx + t * vx - px, qy = sy + t * vy - py;
    return qx * qx + qy * qy;
  };
  return Math.min(pt(ax, ay, cx, cy, dx, dy), pt(bx, by, cx, cy, dx, dy), pt(cx, cy, ax, ay, bx, by), pt(dx, dy, ax, ay, bx, by));
}

export class Engine {
  readonly comp: Renderer;
  private doc = new Doc();
  private net: Net;
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private stroke: ActiveStroke | null = null;
  private pan: { pointerId: number; x: number; y: number } | null = null;
  private picking: number | null = null;
  /** Magnifier press: a click zooms in or out at x0,y0, a sideways drag zooms smoothly. */
  private zooming: { pointerId: number; x0: number; y0: number; zoom0: number; out: boolean; moved: boolean } | null = null;
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
  /** Increments to cancel a running fly-to animation. */
  private flight = 0;
  private markersAt = 0;
  private markersCost = 0;
  private markersTimer: number | undefined;
  private flying = false;
  /** Embed mode: the world rectangle the embed frames. Null in the editor. */
  private frame: Bounds | null;
  /** Embed: the viewer moved the view, so a resize keeps it (else it refits the frame). */
  private moved = false;
  /** Embed: the wheel zooms only after a click inside (or with Ctrl), so the page scrolls. */
  private engaged = false;
  private wheelHintAt = 0;
  /** Seq the server's link preview shows (null: none). Editors send a newer one. */
  private previewSeq: number | null = null;
  private previewAt = 0;
  private previewTimer: number | undefined;

  /**
   * `frame` turns on embed mode: view only, no presence and no cursor, pan and zoom only, and
   * the view starts on (and resets to) that rectangle. Nothing is saved in the browser.
   */
  constructor(
    private code: string,
    private canvas: HTMLCanvasElement,
    private brushCursor: HTMLElement,
    frame: Bounds | null = null,
  ) {
    this.frame = frame;
    const k = new URLSearchParams(location.search).get('k');
    if (k && !frame) links.set(code, k);
    this.link = k ?? (frame ? undefined : links.get(code));
    this.comp = createRenderer(canvas);
    this.scaleCap = this.comp.profile.maxScale;
    if (!frame) this.comp.onSlow = () => this.slowFrames();
    ed.renderer = `${this.comp.kind === 'webgl2' ? 'WebGL2' : 'Canvas 2D'} · ${this.comp.precision}-bit`;
    this.rect = canvas.getBoundingClientRect();
    this.restoreView();

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(canvas);
    this.cleanup.push(() => ro.disconnect());
    this.watchPixelRatio();
    this.resize();

    this.net = new Net(
      code,
      (m) => this.onServer(m),
      (s) => (ed.status = s),
      () => this.hello(),
    );

    this.listen(canvas, 'pointerdown', (e) => this.onPointerDown(e as PointerEvent));
    this.listen(canvas, 'pointermove', (e) => this.onPointerMove(e as PointerEvent));
    this.listen(canvas, 'pointerup', (e) => this.onPointerUp(e as PointerEvent));
    this.listen(canvas, 'pointercancel', (e) => this.onPointerUp(e as PointerEvent));
    this.listen(canvas, 'pointerleave', () => this.onPointerLeave());
    this.listen(canvas, 'wheel', (e) => this.onWheel(e as WheelEvent), { passive: false });
    this.listen(canvas, 'contextmenu', (e) => e.preventDefault());
    if (!frame) {
      // Ctrl+wheel and trackpad pinches over a panel or popup zoom the canvas, not the page. A
      // plain wheel over a popup that floats on the canvas zooms too, when the popup cannot scroll.
      this.listen(window, 'wheel', (e) => this.onPageWheel(e as WheelEvent), { passive: false });
      this.listen(window, 'keydown', (e) => this.onKey(e as KeyboardEvent, true));
      this.listen(window, 'keyup', (e) => this.onKey(e as KeyboardEvent, false));
    }
    this.listen(window, 'blur', () => {
      this.spaceDown = this.altDown = false;
      this.updateCursor();
    });
    const sweep = window.setInterval(() => this.comp.sweepLive(), 1000);
    this.cleanup.push(() => window.clearInterval(sweep));
    if (frame) this.updateCursor();
  }

  /** Share-link token: from the URL (?k=), else the one this canvas was opened with before. */
  private link: string | undefined;

  private hello(password?: string): void {
    if (this.frame) {
      this.net.send({ t: 'hello', name: '', color: '#000000', link: this.link, embed: true });
      return;
    }
    this.net.send({
      t: 'hello',
      name: ed.name,
      color: ed.color,
      anon: anonSecret(),
      token: desktopToken.get() ?? undefined,
      link: this.link,
      grant: grants.get(this.code),
      password,
    });
  }

  /** Answer to a join-password prompt. The socket is still open; the server waits for it. */
  submitPassword(password: string): void {
    this.hello(password);
  }

  /** Reconnects with the current identity (after login, logout, or to retry access). */
  reconnect(): void {
    ed.denied = null;
    this.net.reconnect();
  }

  destroy(): void {
    window.clearTimeout(this.previewTimer);
    cancelAnimationFrame(this.pathsRaf);
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

  /**
   * Highest canvas pixel ratio: the profile's (perf.ts), lowered step by step while panning and
   * zooming stay slow (onSlow). The screen's own ratio still sets the CSS layout.
   */
  private scaleCap = Infinity;

  /** The renderer says frames are slow while the view moves: render fewer pixels. */
  private slowFrames(): void {
    const now = Math.min(window.devicePixelRatio || 1, this.scaleCap);
    const next = [2, 1.5, 1.25, 1].find((s) => s < now - 0.01);
    if (!next) return;
    this.scaleCap = next;
    slowDevice(); // the next start uses the light profile (8-bit tiles too)
    console.info(`draw: slow frames, render scale ${now} -> ${next}`);
    this.resize();
  }

  private resize(): void {
    this.rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, this.scaleCap);
    this.comp.resize(this.rect.width, this.rect.height, dpr);
    ed.renderer = `${this.comp.kind === 'webgl2' ? 'WebGL2' : 'Canvas 2D'} · ${this.comp.precision}-bit · ${+dpr.toFixed(2)}×${this.comp.profile.name === 'full' ? '' : ` · ${this.comp.profile.name}`}`;
    // An embed keeps its frame filling the box until the viewer moves the view.
    if (this.frame && !this.moved) return this.showFrame();
    this.syncView();
  }

  /**
   * Moving the window to a monitor with another scale (say 1 to 1.35) changes devicePixelRatio
   * but often not the CSS size, so the ResizeObserver stays quiet and the canvas would keep
   * the old resolution, stretched. A resolution media query reports the change.
   */
  private watchPixelRatio(): void {
    const mq = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    const onChange = () => {
      mq.removeEventListener('change', onChange);
      this.resize();
      this.watchPixelRatio();
    };
    mq.addEventListener('change', onChange);
    this.cleanup.push(() => mq.removeEventListener('change', onChange));
  }

  private restoreView(): void {
    if (this.frame) return this.showFrame();
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
    if (this.frame) return; // no markers, and nothing saved for an embed
    this.updateBrushCursor();
    this.scheduleMarkers();
    this.schedulePaths();
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
    this.moved = true;
    const { w, h } = this.comp.size;
    this.zoomAt(w / 2, h / 2, this.comp.view.zoom * factor);
  }

  /** The magnifier's zoom animation in progress: where it ends. */
  private glide: { x: number; y: number; zoom: number; token: number } | null = null;

  /** A short animated zoom about a point (the magnifier's click). */
  private glideZoom(cssX: number, cssY: number, zoom: number): void {
    const token = ++this.flight;
    const z0 = this.comp.view.zoom;
    const z1 = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
    this.glide = { x: cssX, y: cssY, zoom: z1, token };
    const start = performance.now();
    const step = () => {
      if (token !== this.flight) return;
      const t = Math.min(1, (performance.now() - start) / 160);
      const e = 1 - (1 - t) ** 3;
      this.zoomAt(cssX, cssY, z0 * (z1 / z0) ** e);
      if (t < 1) requestAnimationFrame(step);
      else this.glide = null;
    };
    requestAnimationFrame(step);
  }

  /** Ends a magnifier animation at its target at once (quick clicks add up exactly). */
  private finishGlide(): void {
    const g = this.glide;
    this.glide = null;
    if (g && g.token === this.flight) {
      this.flight++;
      this.zoomAt(g.x, g.y, g.zoom);
    }
  }

  /** Embed: scales the frame to fit the box, centered (no animation). */
  private showFrame(): void {
    const f = this.frame!;
    const { w, h } = this.comp.size;
    const fw = Math.max(f.x1 - f.x0, 1e-300), fh = Math.max(f.y1 - f.y0, 1e-300);
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(w / fw, h / fh)));
    this.setView((f.x0 + f.x1) / 2 - w / 2 / z, (f.y0 + f.y1) / 2 - h / 2 / z, z);
  }

  /** Embed: flies back to the framed view; a resize then refits it again. */
  resetFrame(): void {
    if (!this.frame) return;
    this.moved = false;
    this.flyTo(this.frame, 1);
  }

  /** The world rectangle on screen, and the screen size in CSS pixels (for an embed code). */
  viewRect(): { bounds: Bounds; w: number; h: number } {
    const { w, h } = this.comp.size;
    const v = this.comp.view;
    return { bounds: { x0: v.x, y0: v.y, x1: v.x + w / v.zoom, y1: v.y + h / v.zoom }, w, h };
  }

  /** Confirmed document state for an off-screen render (exports, previews). */
  snapshot(): { layers: Layer[]; strokes: Stroke[]; seq: number } {
    return {
      layers: this.doc.displayLayers(),
      strokes: [...this.doc.strokes.values()].filter((st) => !st.deleted),
      seq: this.doc.seq,
    };
  }

  /** Bounds of everything on the visible layers; null when nothing is drawn. */
  contentBounds(): Bounds | null {
    return unionAll(this.doc, this.visibleLayerIds());
  }

  /** Device pixels per world unit on screen now. */
  get deviceScale(): number {
    return this.comp.view.zoom * (window.devicePixelRatio || 1);
  }

  resetView(): void {
    const { w, h } = this.comp.size;
    const [wx, wy] = this.comp.toWorld(w / 2, h / 2);
    this.setView(wx - w / 2, wy - h / 2, 1);
  }

  // --- finding content ---------------------------------------------------------------------

  /** Paint layers that show (visible, in groups that are all visible). */
  private visibleLayerIds(): Set<string> {
    const byId = new Map(ed.layers.map((l) => [l.id, l]));
    return new Set(ed.layers.filter((l) => l.kind !== 'group' && effectivelyVisible(byId, l)).map((l) => l.id));
  }

  /**
   * Recomputes markers, throttled, with a trailing update after motion stops. The interval
   * grows with the cost of the last run (big documents), so panning stays smooth. During a
   * fly-to only the final position counts.
   */
  scheduleMarkers(): void {
    window.clearTimeout(this.markersTimer);
    if (this.flying || this.frame) return;
    const run = () => {
      const t0 = performance.now();
      this.markersAt = t0;
      if (!ed.showMarkers) {
        if (ed.markers.length) ed.markers = [];
        return;
      }
      const { w, h } = this.comp.size;
      ed.markers = computeMarkers(this.doc, this.visibleLayerIds(), this.comp.view, w, h);
      this.markersCost = performance.now() - t0;
    };
    const interval = Math.max(MARKERS_MS, this.markersCost * 10);
    const wait = interval - (performance.now() - this.markersAt);
    if (wait <= 0) run();
    this.markersTimer = window.setTimeout(run, Math.max(wait, interval));
  }

  private stopFlight(): void {
    this.flight++;
    if (this.flying) {
      this.flying = false;
      this.scheduleMarkers();
    }
  }

  /** Zooms out (or in) to show everything on the visible layers. */
  fitAll(): void {
    const all = unionAll(this.doc, this.visibleLayerIds());
    if (!all) return showToast('Nothing drawn yet');
    this.flyTo(all, 0.85);
  }

  /**
   * Animates the view to show `b`. Long trips zoom out, travel, then zoom in, so you can see
   * where you go. Zoom moves in log space, so a 1e9x change takes about as long as a 10x one.
   */
  flyTo(b: Bounds, fill = 0.6): void {
    const { w, h } = this.comp.size;
    const v = this.comp.view;
    const bw = Math.max(b.x1 - b.x0, 1e-300);
    const bh = Math.max(b.y1 - b.y0, 1e-300);
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min((w * fill) / bw, (h * fill) / bh)));
    type Key = { cx: number; cy: number; span: number }; // span = world width of the view
    const from: Key = { cx: v.x + w / 2 / v.zoom, cy: v.y + h / 2 / v.zoom, span: w / v.zoom };
    const to: Key = { cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2, span: w / zoom };
    const dist = Math.hypot(to.cx - from.cx, to.cy - from.cy);
    const legs: [Key, Key][] = [];
    if (dist > 1.5 * Math.max(from.span, to.span)) {
      const mid: Key = { cx: (from.cx + to.cx) / 2, cy: (from.cy + to.cy) / 2, span: dist * 1.3 };
      legs.push([from, mid], [mid, to]);
    } else legs.push([from, to]);

    const token = ++this.flight;
    this.flying = true;
    ed.markers = [];
    const done = () => {
      if (token !== this.flight) return;
      this.flying = false;
      this.scheduleMarkers();
    };
    const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
    const runLeg = (i: number) => {
      if (i >= legs.length || token !== this.flight) return done();
      const [a, c] = legs[i];
      const ratio = Math.abs(Math.log2(c.span / a.span));
      const duration = Math.min(900, 220 + ratio * 45 + (ratio < 0.5 ? 200 : 0));
      const start = performance.now();
      const step = () => {
        if (token !== this.flight) return;
        const t = Math.min(1, (performance.now() - start) / duration);
        const e = ease(t);
        const span = a.span * (c.span / a.span) ** e;
        // Move the center in step with the zoom: early when zooming in, late when zooming out.
        const f = Math.abs(a.span - c.span) > a.span * 1e-9 ? (a.span - span) / (a.span - c.span) : e;
        const cx = a.cx + (c.cx - a.cx) * f;
        const cy = a.cy + (c.cy - a.cy) * f;
        const z = w / span;
        this.setView(cx - w / 2 / z, cy - h / 2 / z, z);
        if (t < 1) requestAnimationFrame(step);
        else runLeg(i + 1);
      };
      requestAnimationFrame(step);
    };
    runLeg(0);
  }

  // --- tools and cursor ---------------------------------------------------------------------

  private effectiveTool(): Tool {
    // While a transform is open, the canvas only pans: the overlay has the handles.
    if (this.frame || ed.transform || this.spaceDown || this.pan) return 'hand';
    if (this.altDown && (ed.tool === 'brush' || ed.tool === 'eraser')) return 'eyedropper';
    return ed.tool;
  }

  updateCursor(): void {
    const tool = this.effectiveTool();
    this.canvas.style.cursor =
      tool === 'hand'
        ? this.pan
          ? 'grabbing'
          : 'grab'
        : tool === 'eyedropper'
          ? 'crosshair'
          : tool === 'zoom'
            ? this.altDown
              ? 'zoom-out'
              : 'zoom-in'
            : 'none';
    this.updateBrushCursor();
    this.schedulePaths(); // the path overlay shows with the stroke eraser only
  }

  updateBrushCursor(): void {
    const el = this.brushCursor;
    const tool = this.effectiveTool();
    if (!this.pointer || (tool !== 'brush' && tool !== 'eraser' && tool !== 'strokeEraser')) {
      el.style.display = 'none';
      return;
    }
    const d = Math.max(3, tool === 'strokeEraser' ? ed.strokeEraserSize : ed.activeBrush.size);
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
    this.finishGlide(); // a magnifier zoom in progress ends at its target
    this.stopFlight(); // any touch stops a fly-to
    if (e.pointerType === 'pen' || nativePenFor(e)) this.penSeen = true;
    if (e.pointerType === 'touch' && this.onTouchDown(e, x, y)) return;
    if (takeDismissed(e.pointerId)) {
      // This press closed a popup: it does not paint. A finger pans (a second one pinches).
      if (e.pointerType === 'touch' && !this.stroke && !this.pan) this.pan = { pointerId: e.pointerId, x, y };
      return;
    }
    if (this.stroke || this.pan || this.picking !== null || this.zooming) return;
    this.engaged = true;
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
    if (tool === 'zoom' && (e.button === 0 || e.button === 2) && !this.isEraserEnd(e)) {
      e.preventDefault();
      this.zooming = { pointerId: e.pointerId, x0: x, y0: y, zoom0: this.comp.view.zoom, out: e.button === 2 || e.altKey, moved: false };
      return;
    }
    // The eraser end of a pen erases, whatever tool is selected.
    const eraserEnd = this.isEraserEnd(e);
    if (e.button !== 0 && !eraserEnd) return;
    if (tool === 'eyedropper' && !eraserEnd) {
      this.picking = e.pointerId;
      this.pick(x, y);
      return;
    }
    if (tool === 'strokeEraser' && !eraserEnd) return this.beginSweep(e, x, y);
    this.beginStroke(e, x, y, eraserEnd);
  }

  private onPointerMove(e: PointerEvent): void {
    const [x, y] = this.local(e);
    if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, [x, y]);
      if (this.gesture) return this.updateGesture();
      if (this.ignoredTouches.has(e.pointerId) || this.touchLock) return;
    }
    // Only a hovering mouse or pen shows the brush outline.
    if (this.sweep && e.pointerId === this.sweep.pointerId) {
      const events = e.getCoalescedEvents?.() ?? [];
      for (const ce of events.length ? events : [e]) this.sweepTo(...this.local(ce));
      this.pointer = { x, y };
      this.updateBrushCursor();
      return;
    }
    if (!this.frame) {
      this.pointer = e.pointerType === 'touch' ? null : { x, y };
      if (this.effectiveTool() === 'strokeEraser') this.hoverAt(x, y);
      const [wx, wy] = this.comp.toWorld(x, y);
      ed.cursor = { x: wx, y: wy };
      this.updateBrushCursor();
      this.sendCursor(wx, wy);
    }

    if (this.zooming && e.pointerId === this.zooming.pointerId) {
      const zm = this.zooming;
      const dx = x - zm.x0;
      if (!zm.moved && Math.abs(dx) < 4) return;
      zm.moved = this.moved = true;
      // Right zooms in, left zooms out: 100 px is about 2.7x.
      this.zoomAt(zm.x0, zm.y0, zm.zoom0 * Math.exp(dx * 0.01));
      return;
    }
    if (this.pan && e.pointerId === this.pan.pointerId) {
      this.moved = true;
      const v = this.comp.view;
      this.setView(v.x - (x - this.pan.x) / v.zoom, v.y - (y - this.pan.y) / v.zoom, v.zoom);
      this.pan.x = x;
      this.pan.y = y;
      return;
    }
    if (this.picking === e.pointerId) return this.pick(x, y);
    const st = this.stroke;
    if (st && e.pointerId === st.pointerId) {
      if (st.native && this.addNativeSamples(st, e)) return;
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
    if (this.zooming && e.pointerId === this.zooming.pointerId) {
      const zm = this.zooming;
      this.zooming = null;
      if (!zm.moved && e.type === 'pointerup') {
        this.moved = true;
        this.glideZoom(zm.x0, zm.y0, zm.zoom0 * (zm.out ? 0.5 : 2));
      }
    }
    if (this.sweep && e.pointerId === this.sweep.pointerId) this.endSweep();
    if (this.stroke && e.pointerId === this.stroke.pointerId) {
      // The last pen samples before the release (the release itself has no pressure).
      if (this.stroke.native) this.addNativeSamples(this.stroke, null);
      this.endStroke();
    }
  }

  private onPointerLeave(): void {
    if (this.frame) {
      this.engaged = false; // back to page scrolling once the pointer is outside
      return;
    }
    if (this.stroke || this.sweep) return;
    this.pointer = null;
    ed.cursor = null;
    if (this.hover.size) {
      this.hover = new Set();
      this.schedulePaths();
    }
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
      this.zooming = null;
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
    this.moved = true;
    this.setView(g.world0[0] - mx / z, g.world0[1] - my / z, z);
  }

  private endGesture(): void {
    const g = this.gesture!;
    this.gesture = null;
    this.touchLock = false;
    if (this.frame || g.moved || performance.now() - g.t0 > TAP_MS) return;
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

  private onPageWheel(e: WheelEvent): void {
    const t = e.target as Element | null;
    if (!t || t === this.canvas || t.closest('[aria-modal]')) return; // the canvas has its own listener
    if (e.ctrlKey || e.metaKey) return this.onWheel(e);
    const pop = t.closest('[data-over-canvas]');
    if (!pop) return;
    for (let el: Element | null = t; el; el = el === pop ? null : el.parentElement) {
      const y = getComputedStyle(el).overflowY;
      if ((y === 'auto' || y === 'scroll') && el.scrollHeight > el.clientHeight + 1) {
        const room = e.deltaY < 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1;
        if (room) return; // the popup scrolls
      }
    }
    this.onWheel(e);
  }

  private onWheel(e: WheelEvent): void {
    if (this.frame && !this.engaged && !e.ctrlKey && !e.metaKey) {
      // The page scrolls past the embed. Trackpad pinch arrives with ctrlKey and still zooms.
      const now = performance.now();
      if (now - this.wheelHintAt > 4000) {
        this.wheelHintAt = now;
        showToast('Click the drawing first to zoom with the wheel');
      }
      return;
    }
    this.moved = true;
    e.preventDefault();
    this.stopFlight();
    const [x, y] = this.local(e);
    let dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
    if (e.ctrlKey) dy *= 4; // trackpad pinch reports small deltas
    dy = Math.max(-300, Math.min(300, dy));
    this.zoomAt(x, y, this.comp.view.zoom * Math.exp(-dy * 0.0015));
  }

  private pressure(e: PointerEvent): number {
    // Mice report 0.5 while pressed. Only pens give a real pressure: from the engine, or from
    // the desktop app's native layer when the engine calls the pen a mouse (nativePen.ts).
    if (e.pointerType === 'pen') return e.pressure;
    if (e.pointerType === 'touch') return this.touchPressure(e);
    return nativePenFor(e)?.pressure ?? 1;
  }

  /** Smallest and largest finger contact diameter seen (CSS px): the range for touch pressure. */
  private touchSize = { lo: 0, hi: 0 };
  /** Largest touch pressure the screen reported, once it reported a real one (else 0). */
  private touchPrsMax = 0;

  /**
   * Finger pressure. First choice: the pressure the screen reports (Android's "Prs" in Pointer
   * location, MotionEvent.getPressure), which Chromium and the Android WebView pass as
   * PointerEvent.pressure. A browser without it reports exactly 0.5 while touching, so a value
   * other than 0.5 turns this on. Some screens go above 1: the value is scaled by the largest
   * seen. Else: the contact size. Android and some other browsers report the contact ellipse as
   * width × height: a light touch is small, a firm press is wide. That range adapts to this
   * finger and screen: it starts around the first contact and grows with every size seen.
   * Without either (width and height 1), the pressure is full.
   */
  private touchPressure(e: PointerEvent): number {
    if (!ed.touchPressure) return 1;
    const prs = e.pressure;
    if (prs > 0 && prs !== 0.5) this.touchPrsMax = Math.max(this.touchPrsMax, prs, 1);
    if (this.touchPrsMax > 0 && prs > 0) return Math.min(1, Math.max(0.02, prs / this.touchPrsMax));
    if (!(e.width > 1 && e.height > 1)) return 1;
    const d = Math.sqrt(e.width * e.height);
    const s = this.touchSize;
    if (s.hi === 0) {
      s.lo = d * 0.75;
      s.hi = d * 1.5;
    }
    s.lo = Math.min(s.lo, d);
    s.hi = Math.max(s.hi, d);
    return Math.min(1, Math.max(0.05, (d - s.lo) / (s.hi - s.lo)));
  }

  /** Chromium and Firefox send the eraser end as button 5 (buttons bit 32); see also nativePen.ts. */
  private isEraserEnd(e: PointerEvent): boolean {
    if (e.pointerType === 'pen') return e.button === 5 || (e.buttons & 32) !== 0;
    return !!nativePenFor(e)?.eraser;
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

  private beginStroke(e: PointerEvent, x: number, y: number, eraserEnd = false): void {
    if (!ed.canEdit) return showToast('View only: you can look around but not draw');
    const layer = this.activeLayer();
    if (!layer) return showToast('Add a layer first');
    if (layer.kind === 'group') return showToast('A group holds no paint: select a layer in it');
    if (!effectivelyVisible(new Map(ed.layers.map((l) => [l.id, l])), layer)) return showToast('The active layer is hidden');
    const mask = ed.maskTarget && layer.mask ? layer.mask : null;
    if (layer.kind === 'adjust' && !mask) {
      return showToast(layer.mask ? 'Select the mask to paint on an adjustment layer' : 'An adjustment layer has no paint. Add a mask to paint where it applies.');
    }
    const tool = eraserEnd ? 'eraser' : this.effectiveTool();
    const settings = tool === 'eraser' ? ed.eraser : ed.brush;
    // Size is in screen pixels: what you see is what you draw, at any zoom.
    const zoom = this.comp.view.zoom;
    const brush: Brush = cleanBrush({
      ...settings,
      size: Math.min(LIMITS.maxBrushWorld, Math.max(LIMITS.minBrushWorld, settings.size / zoom)),
      tool: tool === 'eraser' ? 'erase' : 'paint',
      // A mask stores grey: black hides, white shows.
      color: mask ? greyOf(ed.fg) : ed.fg,
    });
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
      native: this.nativeStart(e),
      ...(mask ? { mask: mask.id } : {}),
    };
    this.stroke = st;
    this.comp.liveBegin(st.id, mask ? maskKey(layer.id, mask.id) : st.layerId, brush, false);
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

  /** A stroke from a native pen starts here: the press sample gives the offset to client coordinates. */
  private nativeStart(e: PointerEvent): ActiveStroke['native'] {
    if (!nativePenFor(e)) return null;
    const samples = takePenSamples(); // hover samples before the press are not part of the stroke
    // The last press sample, else the newest sample.
    let down: PenSample | undefined = samples[samples.length - 1];
    for (const s of samples) if (s.kind === 1) down = s;
    if (!down) return null;
    return { dx: e.clientX - down.x, dy: e.clientY - down.y, trail: [[e.clientX, e.clientY]] };
  }

  /**
   * Adds the native pen samples that arrived since the last event. Returns true when the event
   * is handled (also when no new sample arrived: the samples run ahead of the engine's merged
   * pointer moves). Returns false, and stops using samples for this stroke, when the event does
   * not lie on the sampled path: then the positions do not match and pointer events take over.
   */
  private addNativeSamples(st: ActiveStroke, e: PointerEvent | null): boolean {
    const n = st.native!;
    const moves = takePenSamples().filter((s) => s.kind === 0);
    for (const s of moves) {
      const cx = s.x + n.dx;
      const cy = s.y + n.dy;
      n.trail.push([cx, cy]);
      this.addPoint(cx - this.rect.left, cy - this.rect.top, s.pressure);
    }
    if (n.trail.length > 512) n.trail.splice(0, n.trail.length - 512);
    if (e && !n.trail.some(([x, y]) => Math.hypot(x - e.clientX, y - e.clientY) <= 24)) {
      st.native = null;
      return false;
    }
    return true;
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
    if (this.net.send({ t: 'live', id: st.id, layerId: st.layerId, mask: st.mask, brush: st.brush, pts: st.unsent, start: !st.started })) {
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
      this.net.send({ t: 'live', id: st.id, layerId: st.layerId, mask: st.mask, brush: st.brush, pts: st.unsent, start: !st.started });
      st.unsent = [];
    }
    if (st.pts.length === 0) {
      this.comp.liveCancel(st.id);
      return;
    }
    this.sendOp({ type: 'stroke.add', stroke: { id: st.id, layerId: st.layerId, brush: st.brush, pts: st.pts, ...(st.mask ? { mask: st.mask } : {}) } });
    this.pushUndo({ undo: [{ type: 'stroke.remove', id: st.id }], redo: [{ type: 'stroke.restore', id: st.id }] });
    if (st.brush.tool === 'paint' && !st.mask) this.addSwatch(st.brush.color);
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
    if (!ed.canEdit) return;
    if (this.stroke) return;
    if (ed.transform) return this.cancelTransform();
    const e = this.undoStack.pop();
    if (!e) return;
    e.undo.forEach((op) => this.sendOp(op));
    this.redoStack.push(e);
    this.syncUndo();
  }

  redo(): void {
    if (!ed.canEdit) return;
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
    if (ed.maskTarget && !layers.find((l) => l.id === ed.activeLayerId)?.mask) this.setMaskTarget(false);
    this.scheduleMarkers();
    this.schedulePaths();
  }

  /** Live layers in the group `parent` (null: the top level), bottom to top. */
  private siblings(parent: string | null): Layer[] {
    return ed.layers.filter((l) => (l.parent ?? null) === parent).sort(sortLayers);
  }

  /** An order value right above `l` among its siblings. */
  private orderAbove(l: Layer): number {
    const sib = this.siblings(l.parent ?? null);
    const above = sib[sib.findIndex((x) => x.id === l.id) + 1];
    return above ? (l.order + above.order) / 2 : l.order + 1;
  }

  /**
   * Where a new layer goes: right above the active layer, in its group; inside the active group,
   * at its top.
   */
  private newLayerPlace(): { order: number; parent?: string } {
    const active = this.activeLayer();
    if (!active) return { order: 1 };
    if (active.kind === 'group') {
      const top = this.siblings(active.id).at(-1);
      return { order: top ? top.order + 1 : 1, parent: active.id };
    }
    return { order: this.orderAbove(active), ...(active.parent ? { parent: active.parent } : {}) };
  }

  private nextName(prefix: string): string {
    let n = 1;
    const re = new RegExp(`^${prefix} (\\d+)$`);
    for (const l of this.doc.layers.values()) {
      const m = re.exec(l.name);
      if (m) n = Math.max(n, +m[1] + 1);
    }
    return `${prefix} ${n}`;
  }

  addLayer(): void {
    if (!ed.canEdit) return;
    const id = newId();
    this.sendOp({
      type: 'layer.add',
      layer: { id, name: this.nextName('Layer'), ...this.newLayerPlace(), blend: 'normal', opacity: 1, visible: true },
    });
    this.pushUndo({ undo: [{ type: 'layer.remove', id }], redo: [{ type: 'layer.restore', id }] });
    this.setMaskTarget(false);
    ed.activeLayerId = id;
  }

  static readonly ADJUST_NAMES: Record<AdjustType, string> = {
    levels: 'Levels',
    curves: 'Curves',
    hueSat: 'Hue/Saturation',
    brightContrast: 'Brightness/Contrast',
  };

  /** An adjustment layer above the active layer. It changes everything below it. */
  addAdjustmentLayer(type: AdjustType): void {
    if (!ed.canEdit) return;
    const id = newId();
    this.sendOp({
      type: 'layer.add',
      layer: {
        id,
        kind: 'adjust',
        name: this.nextName(Engine.ADJUST_NAMES[type]),
        ...this.newLayerPlace(),
        blend: 'normal',
        opacity: 1,
        visible: true,
        adjust: DEFAULT_ADJUST[type],
      },
    });
    this.pushUndo({ undo: [{ type: 'layer.remove', id }], redo: [{ type: 'layer.restore', id }] });
    this.setMaskTarget(false);
    ed.activeLayerId = id;
  }

  /** Changes adjustment settings. Changes within 2 s merge into one undo step. */
  setAdjust(id: string, adjust: Adjust): void {
    this.updateLayer(id, { adjust }, 'adjust');
  }

  /** Adds an empty (all white) mask and selects it for painting. */
  addMask(id: string): void {
    const l = this.doc.layer(id);
    if (!l || l.mask) return;
    this.updateLayer(id, { mask: { id: newId(), enabled: true } });
    this.refreshLayers();
    this.setMaskTarget(true);
  }

  /** Removes the mask. Undo brings it back with its strokes. */
  deleteMask(id: string): void {
    if (!this.doc.layer(id)?.mask) return;
    this.updateLayer(id, { mask: null });
    this.setMaskTarget(false);
  }

  setMaskEnabled(id: string, enabled: boolean): void {
    const m = this.doc.layer(id)?.mask;
    if (m) this.updateLayer(id, { mask: { ...m, enabled } });
  }

  /** Clips the layer to the nearest unclipped layer below it, or releases it. */
  setClip(id: string, clip: boolean): void {
    this.updateLayer(id, { clip });
  }

  /** Colors from before the mask was selected: back when painting the layer again. */
  private layerColors: [string, string] | null = null;

  /**
   * Paint on the active layer's mask (true) or on the layer itself (false). As in Photoshop, the
   * colors become black and white for the mask, and come back for the layer.
   */
  setMaskTarget(on: boolean): void {
    const next = on && !!this.activeLayer()?.mask;
    if (next === ed.maskTarget) return;
    ed.maskTarget = next;
    if (next) {
      this.layerColors = [ed.fg, ed.bg];
      ed.fg = '#000000';
      ed.bg = '#ffffff';
    } else if (this.layerColors) {
      [ed.fg, ed.bg] = this.layerColors;
      this.layerColors = null;
    }
  }

  /** Deletes a layer, or a group with everything in it. Undo brings it all back. */
  deleteLayer(id: string): void {
    if (!ed.canEdit) return;
    const layers = this.doc.displayLayers();
    const gone = subtreeIds(layers, id);
    const rest = layers.filter((l) => !gone.has(l.id) && l.kind !== 'group');
    if (rest.length === 0) return showToast('A canvas needs at least one layer');
    const i = layers.findIndex((l) => l.id === id);
    if (i < 0) return;
    if (ed.activeLayerId && gone.has(ed.activeLayerId)) {
      const below = layers.slice(0, i).reverse().find((l) => !gone.has(l.id));
      ed.activeLayerId = (below ?? layers.find((l) => !gone.has(l.id)))!.id;
    }
    if (ed.transform && gone.has(ed.transform.id)) this.cancelTransform();
    this.sendOp({ type: 'layer.remove', id });
    this.pushUndo({ undo: [{ type: 'layer.restore', id }], redo: [{ type: 'layer.remove', id }] });
  }

  /** Sets layer properties. Calls with the same `key` within 2 s merge into one undo step. */
  updateLayer(id: string, props: Partial<LayerProps>, key?: string): void {
    if (!ed.canEdit) return;
    const old = this.doc.layer(id);
    if (!old) return;
    const oldProps: Partial<LayerProps> = {};
    let changed = false;
    for (const k of Object.keys(props) as (keyof LayerProps)[]) {
      (oldProps as Record<string, unknown>)[k] = old[k] ?? PROP_DEFAULTS[k];
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

  /** dir +1 moves the layer up (toward the top) among the layers of its group, -1 down. */
  moveLayer(id: string, dir: 1 | -1): void {
    if (!ed.canEdit) return;
    const l = this.doc.layer(id);
    if (!l) return;
    const sib = this.siblings(l.parent ?? null);
    const i = sib.findIndex((x) => x.id === id);
    const neighbor = sib[i + dir];
    if (i < 0 || !neighbor) return;
    const beyond = sib[i + 2 * dir];
    let order = beyond ? (neighbor.order + beyond.order) / 2 : neighbor.order + dir;
    if (order === neighbor.order) order = neighbor.order + dir * 1e-9;
    this.updateLayer(id, { order });
  }

  /** Whether a move up (+1) or down (-1) is possible: a layer above or below in its group. */
  canMove(id: string, dir: 1 | -1): boolean {
    const l = ed.layers.find((x) => x.id === id);
    if (!l) return false;
    const sib = this.siblings(l.parent ?? null);
    return !!sib[sib.findIndex((x) => x.id === id) + dir];
  }

  /**
   * Moves a layer (or group) into `parent` (null: the top level) between the siblings `below` and
   * `above` (null: at that end). Drag and drop in the layers panel.
   */
  moveTo(id: string, parent: string | null, below: string | null, above: string | null): void {
    if (!ed.canEdit) return;
    const l = this.doc.layer(id);
    if (!l) return;
    if (parent && subtreeIds(this.doc.displayLayers(), id).has(parent)) return showToast('A group cannot go into itself');
    const sib = this.siblings(parent).filter((x) => x.id !== id);
    const b = below ? sib.find((x) => x.id === below) : undefined;
    const a = above ? sib.find((x) => x.id === above) : undefined;
    const order = b && a ? (b.order + a.order) / 2 : b ? b.order + 1 : a ? a.order - 1 : 1;
    const props: Partial<LayerProps> = { order };
    if ((l.parent ?? null) !== parent) props.parent = parent;
    this.updateLayer(id, props);
  }

  /** Puts the layer (or group) into a new group in its place (Ctrl+G). */
  groupLayer(id: string): void {
    if (!ed.canEdit) return;
    const l = this.doc.layer(id);
    if (!l) return;
    const gid = newId();
    const group: Op = {
      type: 'layer.add',
      layer: { id: gid, kind: 'group', name: this.nextName('Group'), order: l.order, blend: 'pass', opacity: 1, visible: true, ...(l.parent ? { parent: l.parent } : {}) },
    };
    const into: Op = { type: 'layer.update', id, props: { parent: gid, order: 1 } };
    const back: Op = { type: 'layer.update', id, props: { parent: l.parent ?? null, order: l.order } };
    this.sendOp(group);
    this.sendOp(into);
    this.pushUndo({ undo: [back, { type: 'layer.remove', id: gid }], redo: [{ type: 'layer.restore', id: gid }, into] });
    ed.activeLayerId = gid;
  }

  /** A new empty group above the active layer (or at the top of the active group). */
  addGroup(): void {
    if (!ed.canEdit) return;
    const id = newId();
    this.sendOp({ type: 'layer.add', layer: { id, kind: 'group', name: this.nextName('Group'), ...this.newLayerPlace(), blend: 'pass', opacity: 1, visible: true } });
    this.pushUndo({ undo: [{ type: 'layer.remove', id }], redo: [{ type: 'layer.restore', id }] });
    ed.activeLayerId = id;
  }

  /** Takes the layers out of a group, in its place and order, and deletes the group (Ctrl+Shift+G). */
  ungroup(id: string): void {
    if (!ed.canEdit) return;
    const g = this.doc.layer(id);
    if (!g || g.kind !== 'group') return;
    const kids = this.siblings(id);
    const parent = g.parent ?? null;
    const sib = this.siblings(parent);
    const below = sib[sib.findIndex((x) => x.id === id) - 1];
    const lo = below ? below.order : g.order - 1;
    const out: Op[] = kids.map((k, i) => ({ type: 'layer.update', id: k.id, props: { parent, order: lo + ((g.order - lo) * (i + 1)) / (kids.length + 1) } }));
    const back: Op[] = kids.map((k) => ({ type: 'layer.update', id: k.id, props: { parent: id, order: k.order } }));
    for (const op of out) this.sendOp(op);
    this.sendOp({ type: 'layer.remove', id });
    this.pushUndo({ undo: [{ type: 'layer.restore', id }, ...back], redo: [...out, { type: 'layer.remove', id }] });
    ed.activeLayerId = kids.at(-1)?.id ?? ed.activeLayerId;
  }

  /** Copies a layer, or a group with everything in it, right above it. One op: see layer.duplicate. */
  duplicate(id: string): void {
    if (!ed.canEdit) return;
    const l = this.doc.layer(id);
    if (!l) return;
    const nid = newId();
    const name = `${l.name} copy`.slice(0, LIMITS.maxLayerName);
    this.sendOp({ type: 'layer.duplicate', id, newId: nid, name, order: this.orderAbove(l), parent: l.parent ?? null });
    this.pushUndo({ undo: [{ type: 'layer.remove', id: nid }], redo: [{ type: 'layer.restore', id: nid }] });
    this.setMaskTarget(false);
    ed.activeLayerId = nid;
  }

  // --- stroke eraser -------------------------------------------------------------------------------
  //
  // Removes whole strokes: every stroke whose path (its center line) the circle touches while it
  // moves. One drag is one undo step (restore brings the strokes back). With the tool selected, an
  // overlay shows the paths as thin lines, and the ones under the circle in red.

  /** The drag in progress: the last point (world) and the strokes it removed, in order. */
  private sweep: { pointerId: number; last: [number, number]; removed: string[]; gone: Set<string> } | null = null;
  /** Strokes under the circle while it hovers (drawn red in the overlay). */
  private hover = new Set<string>();
  private pathsCanvas: HTMLCanvasElement | null = null;
  private pathsRaf = 0;

  /** Which strokes the stroke eraser may remove: on visible layers, or on the active layer only. */
  private sweepTargets(): (st: Stroke) => boolean {
    if (!ed.strokeEraserAll) {
      const a = this.activeLayer();
      if (!a || a.kind === 'group') return () => false;
      const mask = ed.maskTarget && a.mask ? a.mask.id : null;
      return (st) => st.layerId === a.id && (mask ? st.mask === mask : !st.mask);
    }
    const shown = this.visibleLayerIds();
    return (st) => shown.has(st.layerId) && !st.mask;
  }

  /** Strokes removed by this client and not yet confirmed by the server. */
  private pendingRemovals(): Set<string> {
    const out = new Set<string>();
    for (const p of this.doc.pending) if (p.op.type === 'stroke.remove') out.add(p.op.id);
    return out;
  }

  /**
   * Strokes whose path comes within `r` (world) of the segment a–b. Stroke bounds (which include
   * the brush radius) reject most strokes before the exact segment-to-segment test.
   */
  private strokesNear(ax: number, ay: number, bx: number, by: number, r: number): string[] {
    const want = this.sweepTargets();
    const skip = this.pendingRemovals();
    const x0 = Math.min(ax, bx) - r, x1 = Math.max(ax, bx) + r;
    const y0 = Math.min(ay, by) - r, y1 = Math.max(ay, by) + r;
    const r2 = r * r;
    const out: string[] = [];
    for (const [id, b] of this.doc.bounds) {
      if (b.x1 < x0 || b.x0 > x1 || b.y1 < y0 || b.y0 > y1 || skip.has(id) || this.sweep?.gone.has(id)) continue;
      const st = this.doc.strokes.get(id);
      if (!st || !want(st)) continue;
      const p = st.pts;
      if (p.length === 3) {
        if (segDist2(ax, ay, bx, by, p[0], p[1], p[0], p[1]) <= r2) out.push(id);
        continue;
      }
      for (let i = 3; i < p.length; i += 3) {
        const cx = p[i - 3], cy = p[i - 2], dx = p[i], dy = p[i + 1];
        // Quick reject per segment, then the exact distance.
        if (Math.max(cx, dx) < x0 || Math.min(cx, dx) > x1 || Math.max(cy, dy) < y0 || Math.min(cy, dy) > y1) continue;
        if (segDist2(ax, ay, bx, by, cx, cy, dx, dy) <= r2) {
          out.push(id);
          break;
        }
      }
    }
    return out;
  }

  private beginSweep(e: PointerEvent, x: number, y: number): void {
    if (!ed.canEdit) return showToast('View only: you can look around but not erase');
    const w = this.comp.toWorld(x, y);
    this.sweep = { pointerId: e.pointerId, last: w, removed: [], gone: new Set() };
    this.pointer = { x, y };
    this.hover = new Set();
    this.sweepTo(x, y);
    this.updateBrushCursor();
  }

  /** Moves the circle to (x, y) on screen: removes what the path from the last point touches. */
  private sweepTo(x: number, y: number): void {
    const sw = this.sweep;
    if (!sw) return;
    const [wx, wy] = this.comp.toWorld(x, y);
    const r = ed.strokeEraserSize / 2 / this.comp.view.zoom;
    for (const id of this.strokesNear(sw.last[0], sw.last[1], wx, wy, r)) {
      sw.gone.add(id);
      sw.removed.push(id);
      this.sendOp({ type: 'stroke.remove', id });
    }
    sw.last = [wx, wy];
    this.schedulePaths();
  }

  private endSweep(): void {
    const sw = this.sweep;
    this.sweep = null;
    if (!sw || sw.removed.length === 0) return;
    this.pushUndo({
      undo: sw.removed.map((id) => ({ type: 'stroke.restore', id }) as Op),
      redo: sw.removed.map((id) => ({ type: 'stroke.remove', id }) as Op),
    });
    showToast(`Removed ${sw.removed.length} stroke${sw.removed.length === 1 ? '' : 's'}`);
  }

  /** Hovering: the strokes under the circle turn red in the overlay. */
  private hoverAt(x: number, y: number): void {
    const [wx, wy] = this.comp.toWorld(x, y);
    const next = new Set(this.strokesNear(wx, wy, wx, wy, ed.strokeEraserSize / 2 / this.comp.view.zoom));
    if (next.size === this.hover.size && [...next].every((id) => this.hover.has(id))) return;
    this.hover = next;
    this.schedulePaths();
  }

  /** The canvas over the stage where the stroke eraser draws the paths (Editor gives it). */
  setPathsCanvas(c: HTMLCanvasElement | null): void {
    this.pathsCanvas = c;
    this.schedulePaths();
  }

  private schedulePaths(): void {
    if (!this.pathsCanvas || this.pathsRaf) return;
    this.pathsRaf = requestAnimationFrame(() => {
      this.pathsRaf = 0;
      this.drawPaths();
    });
  }

  /**
   * The paths of the strokes the stroke eraser can remove, as thin lines (red under the circle).
   * Only strokes in view, each thinned to points at least about a pixel apart; a stroke smaller
   * than two pixels is a dot. Thus the cost follows what the screen can show, not the canvas size.
   */
  private drawPaths(): void {
    const c = this.pathsCanvas;
    if (!c) return;
    const on = ed.tool === 'strokeEraser' && !ed.transform && !this.frame;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(this.rect.width * dpr), h = Math.round(this.rect.height * dpr);
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    c.style.display = on ? 'block' : 'none';
    if (!on) return;
    const v = this.comp.view;
    const ds = v.zoom * dpr;
    const vx1 = v.x + w / ds, vy1 = v.y + h / ds;
    const want = this.sweepTargets();
    const skip = this.pendingRemovals();
    const normal = new Path2D(), hot = new Path2D();
    for (const [id, b] of this.doc.bounds) {
      if (b.x1 < v.x || b.x0 > vx1 || b.y1 < v.y || b.y0 > vy1 || skip.has(id) || this.sweep?.gone.has(id)) continue;
      const st = this.doc.strokes.get(id);
      if (!st || !want(st)) continue;
      const path = this.hover.has(id) ? hot : normal;
      const p = st.pts;
      if ((b.x1 - b.x0) * ds < 2 && (b.y1 - b.y0) * ds < 2) {
        const x = (p[0] - v.x) * ds, y = (p[1] - v.y) * ds;
        path.rect(x - 0.75, y - 0.75, 1.5, 1.5);
        continue;
      }
      let lx = (p[0] - v.x) * ds, ly = (p[1] - v.y) * ds;
      path.moveTo(lx, ly);
      if (p.length === 3) path.lineTo(lx + 0.01, ly);
      for (let i = 3; i < p.length; i += 3) {
        const x = (p[i] - v.x) * ds, y = (p[i + 1] - v.y) * ds;
        if (i + 3 < p.length && Math.abs(x - lx) < 1 && Math.abs(y - ly) < 1) continue;
        path.lineTo(x, y);
        lx = x;
        ly = y;
      }
    }
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // A dark halo under a light line: readable on light and dark paint.
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.lineWidth = 2.5 * dpr;
    ctx.stroke(normal);
    ctx.strokeStyle = 'rgba(80, 190, 255, 0.95)';
    ctx.lineWidth = 1 * dpr;
    ctx.stroke(normal);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.lineWidth = 3.5 * dpr;
    ctx.stroke(hot);
    ctx.strokeStyle = '#ff4d4f';
    ctx.lineWidth = 2 * dpr;
    ctx.stroke(hot);
  }

  // --- transform ---------------------------------------------------------------------------------

  /** World bounds of what a layer or group draws (paint strokes; mask strokes if there is no paint). */
  contentOf(id: string): Bounds | null {
    const ids = subtreeIds(this.doc.displayLayers(), id);
    let paint: Bounds | null = null, masks: Bounds | null = null;
    for (const [sid, st] of this.doc.strokes) {
      if (!ids.has(st.layerId)) continue;
      const b = this.doc.bounds.get(sid);
      if (!b) continue;
      const acc: Bounds | null = st.mask ? masks : paint;
      const u: Bounds = acc ? { x0: Math.min(acc.x0, b.x0), y0: Math.min(acc.y0, b.y0), x1: Math.max(acc.x1, b.x1), y1: Math.max(acc.y1, b.y1) } : b;
      if (st.mask) masks = u;
      else paint = u;
    }
    return paint ?? masks;
  }

  /** Free transform of the active layer or group (Ctrl+T): the overlay shows handles. */
  startTransform(): void {
    if (!ed.canEdit) return;
    const l = this.activeLayer();
    if (!l) return;
    if (!this.contentOf(l.id)) return showToast('Nothing to transform on this layer');
    ed.transform = { id: l.id };
  }

  /** Live preview while the handles move (no op until apply). */
  previewTransform(m: Affine): void {
    if (ed.transform) this.comp.setTransformPreview({ id: ed.transform.id, m });
  }

  cancelTransform(): void {
    ed.transform = null;
    this.comp.setTransformPreview(null);
  }

  /** Applies the transform: one op; undo applies the inverse. The preview stays until the tiles catch up. */
  applyTransform(m: Affine): void {
    const t = ed.transform;
    ed.transform = null;
    const inv = invert(m);
    const identity = m.every((v, i) => Math.abs(v - [1, 0, 0, 1, 0, 0][i]) < 1e-12);
    if (!t || !inv || identity || !ed.canEdit) {
      this.comp.setTransformPreview(null);
      return;
    }
    this.comp.setTransformPreview({ id: t.id, m });
    this.transformOp = t.id;
    this.sendOp({ type: 'layer.transform', id: t.id, m });
    this.pushUndo({ undo: [{ type: 'layer.transform', id: t.id, m: inv }], redo: [{ type: 'layer.transform', id: t.id, m }] });
  }

  /** Layer of this client's transform op waiting for its echo (the preview shows until then). */
  private transformOp: string | null = null;

  setActiveLayer(id: string): void {
    if (id !== ed.activeLayerId) this.setMaskTarget(false);
    ed.activeLayerId = id;
  }

  // --- server messages ----------------------------------------------------------------------------

  private onServer(m: ServerMsg): void {
    switch (m.t) {
      case 'welcome': {
        ed.clientId = m.clientId;
        // A server from before accounts sends no role: everyone there could edit.
        ed.role = m.role ?? 'editor';
        ed.canvas = m.canvas ?? null;
        ed.denied = null;
        if (m.grant) grants.set(this.code, m.grant);
        ed.outdated = (m.features ?? []).some((f) => !(DOC_FEATURES as readonly string[]).includes(f));
        this.doc.reset(m.seq, m.layers, m.strokes);
        this.comp.resetStrokes(m.strokes, m.seq);
        ed.peers = m.peers.map((p) => ({ ...p, x: null, y: null, layerId: null }));
        ed.strokeCount = this.doc.strokes.size;
        // Ops from before a reconnect have no echo yet. The server drops duplicates.
        for (const p of this.doc.pending) this.net.send({ t: 'op', opId: p.opId, op: p.op });
        this.refreshLayers();
        ed.status = 'online';
        this.previewSeq = m.previewSeq ?? null;
        this.schedulePreview(5000);
        break;
      }
      case 'preview.saved':
        this.previewSeq = Math.max(this.previewSeq ?? -1, m.seq);
        break;
      case 'op': {
        const changes = this.doc.apply(m.seq, m.op);
        if (m.by === ed.clientId) this.doc.dropPending(m.opId);
        const op = m.op;
        if (changes) {
          // A transform or a duplicate: strokes changed in place, or new copies.
          for (const st of changes.changed) {
            this.comp.removeStroke(st.id, m.seq);
            this.comp.addStroke(st, m.seq);
          }
          for (const st of changes.added) this.comp.addStroke(st, m.seq);
          this.comp.advanceSeq(m.seq);
          this.refreshLayers();
          if (op.type === 'layer.transform' && m.by === ed.clientId && this.transformOp === op.id) {
            this.transformOp = null;
            this.comp.settleTransformPreview();
          }
          this.scheduleMarkers();
        } else if (op.type === 'stroke.add' || op.type === 'stroke.restore') {
          this.comp.addStroke(op.stroke, m.seq);
          this.comp.liveCommit(op.stroke.id, m.seq);
        } else if (op.type === 'stroke.remove') {
          this.comp.removeStroke(op.id, m.seq);
        } else {
          this.comp.advanceSeq(m.seq);
          this.refreshLayers();
        }
        ed.strokeCount = this.doc.strokes.size;
        if (op.type.startsWith('stroke.')) {
          this.scheduleMarkers();
          this.schedulePaths();
        }
        this.schedulePreview(8000);
        break;
      }
      case 'reject': {
        const p = this.doc.dropPending(m.opId);
        if (p?.op.type === 'stroke.add') {
          this.comp.liveCancel(p.op.stroke.id);
          this.net.send({ t: 'live.end', id: p.op.stroke.id });
        }
        if (p?.op.type === 'layer.transform' && this.transformOp === p.op.id) {
          this.transformOp = null;
          this.comp.setTransformPreview(null);
        }
        if (!/duplicate|no such stroke|not deleted/.test(m.reason)) showToast(`Change rejected: ${m.reason}`);
        this.refreshLayers();
        break;
      }
      case 'live': {
        if (!this.comp.hasLive(m.id)) {
          this.comp.liveBegin(m.id, m.mask ? maskKey(m.layerId, m.mask) : m.layerId, m.brush, true);
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
      case 'access':
        if (m.role !== ed.role) showToast(m.role === 'viewer' ? 'You can now only view this canvas' : m.role === 'owner' ? 'You own this canvas now' : 'You can now edit this canvas');
        ed.role = m.role;
        ed.canvas = m.canvas;
        if (m.canvas.key !== this.code && !this.frame) followRename(this.code, m.canvas.key);
        break;
      case 'denied':
        ed.denied = m.reason;
        // A password prompt keeps the socket open; anything else ends this connection.
        if (m.reason !== 'password_required' && m.reason !== 'password_wrong') this.net.close();
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
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    // Zoom keys also work from a number field or a list (in a popup, say): there they mean
    // nothing, and the browser would zoom the whole page instead.
    const zoomKey = mod && (key === '=' || key === '+' || key === '-' || key === '0' || key === '1');
    const textField = t && (t.tagName === 'TEXTAREA' || t.isContentEditable || (t instanceof HTMLInputElement && t.type !== 'number'));
    if (!down || (typing && !(zoomKey && !textField))) return;
    if (mod) {
      if (key === 'z') {
        e.preventDefault();
        if (e.shiftKey) this.redo();
        else this.undo();
      } else if (key === 's') {
        e.preventDefault();
        void this.saveBdraw();
      } else if (key === 'o') {
        e.preventDefault();
        pickFile();
      } else if (key === 'y') {
        e.preventDefault();
        this.redo();
      } else if (key === 't') {
        // Ctrl+T (browsers keep it for a new tab; the desktop apps and V work everywhere).
        e.preventDefault();
        this.startTransform();
      } else if (key === 'g') {
        e.preventDefault();
        const a = this.activeLayer();
        if (a && e.shiftKey) this.ungroup(a.id);
        else if (a) this.groupLayer(a.id);
      } else if (key === 'j') {
        e.preventDefault();
        if (ed.activeLayerId) this.duplicate(ed.activeLayerId);
      } else if (key === '=' || key === '+') {
        e.preventDefault();
        this.zoomBy(1.25);
      } else if (key === '-') {
        e.preventDefault();
        this.zoomBy(0.8);
      } else if (key === '0') {
        e.preventDefault();
        this.fitAll();
      } else if (key === '1') {
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
    const tools: Record<string, Tool> = { b: 'brush', e: e.shiftKey ? 'strokeEraser' : 'eraser', i: 'eyedropper', h: 'hand', z: 'zoom' };
    if (key === 'v') {
      this.startTransform();
    } else if (tools[key]) {
      ed.tool = tools[key];
      this.updateCursor();
    } else if (key === 'x') {
      [ed.fg, ed.bg] = [ed.bg, ed.fg];
    } else if (key === 'm') {
      ed.showMarkers = !ed.showMarkers;
      this.scheduleMarkers();
    } else if (e.key === 'Home') {
      this.fitAll();
    } else if (key === 'd') {
      ed.fg = '#000000';
      ed.bg = '#ffffff';
    }
  }

  /**
   * Link preview (Discord, X, ...): editors render everything on the visible layers into a
   * PREVIEW_LIMITS image and send it, `delay` ms after the last change, at most every 90 s, and
   * only when the server's preview is older. The server keeps the newest (session.ts). Not on
   * phones and tablets: rendering the whole canvas froze a phone for seconds. Desktop editors
   * keep the preview current.
   */
  private schedulePreview(delay: number): void {
    if (this.frame || !ed.canEdit || this.comp.kind !== 'webgl2' || this.comp.profile.name !== 'full') return;
    window.clearTimeout(this.previewTimer);
    const wait = Math.max(delay, this.previewAt + 90_000 - Date.now());
    this.previewTimer = window.setTimeout(() => void this.sendPreview(), wait);
  }

  private async sendPreview(): Promise<void> {
    if (!ed.canEdit || this.doc.seq <= (this.previewSeq ?? -1)) return;
    const all = this.contentBounds();
    if (!all) return;
    const { width: W, height: H, maxBytes } = PREVIEW_LIMITS;
    const frame = toAspect(padded(all, 0.06), W, H);
    const seq = this.doc.seq;
    this.previewAt = Date.now();
    try {
      const { layers, strokes } = this.snapshot();
      const png = await renderPng(layers, strokes, seq, frame, W, H);
      if (!png || png.size > maxBytes) return;
      const bmp = await createImageBitmap(png);
      const ok = bmp.width === W && bmp.height === H;
      bmp.close();
      if (!ok) return;
      const data = (await blobToDataUrl(png)).replace(/^data:image\/png;base64,/, '');
      this.net.send({ t: 'preview', png: data, seq, frame: [frame.x0, frame.y0, frame.x1 - frame.x0, frame.y1 - frame.y0] });
    } catch (e) {
      console.warn('link preview', e);
    }
  }

  async exportPng(): Promise<void> {
    const blob = await this.comp.exportPng();
    if (!blob) return;
    await saveBlob(blob, `draw-${this.code}.png`, { name: 'PNG image', extensions: ['png'] });
  }

  /**
   * Saves the canvas (confirmed state, as the server sent it) to a .bdraw file, with a preview
   * image for file manager thumbnails (left out if it cannot be made, e.g. without WebGL2).
   */
  async saveBdraw(): Promise<void> {
    let preview: string | undefined;
    const all = this.contentBounds();
    if (all) {
      try {
        const { layers, strokes, seq } = this.snapshot();
        const png = await renderPng(layers, strokes, seq, padded(all, 0.04), 512, 512);
        if (png) preview = await blobToDataUrl(png);
      } catch (e) {
        console.warn('bdraw preview', e);
      }
    }
    const source = { key: this.code, url: `${PUBLIC_ORIGIN}/s/${this.code}` };
    const file = makeBdraw(this.doc.layers.values(), this.doc.strokes.values(), __APP_VERSION__, source, preview);
    await saveBlob(await encodeBdraw(file), `${this.code}.${BDRAW_EXT}`, { name: 'Draw canvas', extensions: [BDRAW_EXT] });
  }
}
