// Reactive editor state shared by the Svelte UI and the engine.

import { DEFAULT_BRUSH } from '../shared/brush';
import type { ArrowKind, Brush, CanvasInfo, CustomShape, DeniedReason, Layer, LineCap, Role, Shape, ShapeKind, StrokeAlign } from '../shared/types';
import type { NetStatus } from './engine/net';
import type { Marker } from './engine/navigator';

/**
 * strokeEraser: removes whole strokes whose path the circle touches. zoom: the magnifier (click
 * zooms in, Alt+click or right-click zooms out, a sideways drag zooms smoothly). See engine.ts.
 * select: selects, moves, scales and rotates shapes (a double-click edits their points); on a
 * paint layer or a group, it transforms the layer. shape: draws a new shape of `ed.shapeKind`.
 * pen: draws a path point by point. See shapeTool.ts.
 */
export type Tool = 'brush' | 'eraser' | 'strokeEraser' | 'eyedropper' | 'select' | 'pen' | 'shape' | 'hand' | 'zoom';

/**
 * The style of new Pen paths (lengths in screen pixels, as ShapeStyle), their curve, and the
 * smoothness of new spline points (-1 through, 0 corner, 1 soft).
 */
export type PenStyle = Pick<ShapeStyle, 'fill' | 'stroke' | 'strokeWidth' | 'align' | 'cap' | 'dash' | 'arrows'> & { curve: 'bezier' | 'spline'; smooth: number };
const PEN_STYLE: PenStyle = { fill: null, stroke: '#1d3557', strokeWidth: 3, align: 'center', cap: 'round', dash: [], arrows: ['none', 'none'], curve: 'bezier', smooth: 0.5 };

/** The kinds the Shapes tool draws (paths come from the Pen, compounds from Combine). */
export const DRAW_KINDS = ['rect', 'ellipse', 'polygon', 'star', 'line', 'custom'] as const satisfies readonly ShapeKind[];
export type DrawKind = (typeof DRAW_KINDS)[number];

/**
 * Settings for new shapes (the options bar edits the selected shapes instead, when there are
 * any). Lengths are screen pixels at the zoom where the shape is drawn, as brush sizes are.
 */
export interface ShapeStyle {
  fill: string | null;
  stroke: string | null;
  strokeWidth: number;
  align: StrokeAlign;
  cap: LineCap;
  /** Rectangle corners: top left, top right, bottom right, bottom left. */
  radii: [number, number, number, number];
  radiiLinked: boolean;
  sides: number;
  points: number;
  innerRatio: number;
  /** Polygon and star corners. */
  rounding: number;
  /** Ellipse: the start and end angle of a pie slice in degrees (the same: the whole ellipse), and the hole (0 to 0.99). */
  arc: [number, number];
  hole: number;
  /** Custom shape: its outline. */
  preset: CustomShape;
  /** Dash pattern in stroke widths (empty: solid). */
  dash: number[];
  /** Lines: what the start and the end show. */
  arrows: [ArrowKind, ArrowKind];
}

/** What the Select tool shows over the canvas (CSS px in the stage). shapeTool.ts makes it. */
export interface SelectOverlay {
  /** The shape a click would select, and its name. */
  hover: { outline: string[]; label: string; x: number; y: number } | null;
  /** Outlines of the selected shapes, as SVG path data. */
  outlines: string[];
  /** The selection box: four corners. */
  box: [number, number][] | null;
  /** Scale handles, rotation stems are not drawn (rotation is "just outside a corner"). */
  handles: [number, number][];
  /** Corner radius dots (one rectangle selected). */
  dots: [number, number][];
  /** End points of one selected line. */
  ends: [number, number][];
  marquee: [number, number, number, number] | null;
  /** Live numbers while drawing or changing a shape. */
  readout: { text: string; x: number; y: number } | null;
  /** Point editing and the Pen: the anchors (square: corner, round: smooth) and the handles. */
  anchors: { x: number; y: number; smooth: boolean; sel: boolean }[];
  /** A handle knob at (x, y) and its anchor at (ax, ay). */
  knobs: { x: number; y: number; ax: number; ay: number }[];
  /** The Pen: the next segment, from the last point to the pointer (SVG path data). */
  rubber: string | null;
  /** A hint near the pointer, as "Click the first point to close the shape". */
  tip: { text: string; x: number; y: number } | null;
  /** The smoothness rings of selected spline points: the point, its smoothness, the knob. */
  rings: { x: number; y: number; s: number; kx: number; ky: number; r: number }[];
  /** The floating bar of point editing or of the Pen; `curve`: the path's curve. */
  bar: { kind: 'points' | 'pen' | 'parts'; points: number; selected: number; curve: 'bezier' | 'spline'; label?: string } | null;
  /** Parts mode: the outlines of the compound's parts. */
  parts: string[];
}
export type { BrushSettings } from '../shared/types';
import type { BrushSettings } from '../shared/types';

export interface User {
  id: string;
  email: string;
  name: string;
  admin: boolean;
}

/** Which account dialog is open. */
export type AuthView = 'login' | 'register' | 'forgot' | 'reset' | 'sent';

export interface PeerView {
  id: string;
  name: string;
  color: string;
  x: number | null;
  y: number | null;
  layerId: string | null;
}

const ADJ = ['Brisk', 'Calm', 'Dusky', 'Eager', 'Fuzzy', 'Gentle', 'Hazy', 'Jolly', 'Lucky', 'Misty', 'Nimble', 'Quiet', 'Rusty', 'Sunny', 'Witty'];
const NOUN = ['Otter', 'Heron', 'Lynx', 'Moth', 'Finch', 'Badger', 'Koi', 'Fox', 'Wren', 'Newt', 'Yak', 'Gecko', 'Puffin', 'Hare', 'Owl'];
const PEER_COLORS = ['#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c', '#38d9a9', '#4dabf7', '#748ffc', '#da77f2', '#f783ac'];
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? { ...fallback, ...JSON.parse(v) } : fallback;
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage may be unavailable
  }
}

const { tool: _t, color: _c, ...brushDefaults } = DEFAULT_BRUSH;

const SHAPE_STYLE: ShapeStyle = {
  fill: '#7c3aed',
  stroke: null,
  strokeWidth: 4,
  align: 'inside',
  cap: 'round',
  radii: [0, 0, 0, 0],
  radiiLinked: true,
  sides: 6,
  points: 5,
  innerRatio: 0.45,
  rounding: 0,
  arc: [0, 0],
  hole: 0,
  preset: 'heart',
  dash: [],
  arrows: ['none', 'none'],
};
const prefs = load('draw.prefs', {
  name: `${pick(ADJ)} ${pick(NOUN)}`,
  color: pick(PEER_COLORS),
  brush: brushDefaults as BrushSettings,
  eraser: { ...brushDefaults, hardness: 0.6, size: 40, pressureSize: false } as BrushSettings,
  smoothing: 0.25,
  showMarkers: true,
  touchPressure: true,
  /** Stroke eraser: circle diameter in screen pixels, and which strokes it removes. */
  strokeEraserSize: 30,
  strokeEraserAll: true,
  fg: '#1e1e1e',
  bg: '#ffffff',
  swatches: [] as string[],
  shapeKind: 'rect' as DrawKind,
  shapeStyle: {} as Partial<ShapeStyle>,
  penStyle: {} as Partial<PenStyle>,
  /** Clicks on empty canvas keep the selection (only Esc and Deselect clear it). */
  keepSelection: false,
});

class EditorState {
  tool = $state<Tool>('brush');
  brush = $state<BrushSettings>({ ...brushDefaults, ...prefs.brush });
  eraser = $state<BrushSettings>({ ...brushDefaults, ...prefs.eraser });
  smoothing = $state(prefs.smoothing);
  showMarkers = $state(prefs.showMarkers);
  /** Finger strokes take their pressure from the contact size (where the browser reports it). */
  touchPressure = $state(prefs.touchPressure);
  /** Stroke eraser: circle diameter (screen px); true: all visible layers, false: the active layer. */
  strokeEraserSize = $state(prefs.strokeEraserSize);
  strokeEraserAll = $state(prefs.strokeEraserAll);
  markers = $state<Marker[]>([]);
  fg = $state(prefs.fg);
  bg = $state(prefs.bg);
  swatches = $state<string[]>(prefs.swatches);
  name = $state(prefs.name);
  color = $state(prefs.color);
  // Kinds that are not drawn (saved by an older version) fall back to the rectangle.
  shapeKind = $state<DrawKind>((DRAW_KINDS as readonly string[]).includes(prefs.shapeKind) ? prefs.shapeKind : 'rect');
  shapeStyle = $state<ShapeStyle>({ ...SHAPE_STYLE, ...prefs.shapeStyle });
  penStyle = $state<PenStyle>({ ...PEN_STYLE, ...prefs.penStyle });
  keepSelection = $state(prefs.keepSelection);
  /** Height of the floating options bar over the canvas (CSS px from the canvas top; 0: none). */
  optsHeight = $state(0);
  /** Point editing of a shape (a double-click or Enter with the Select tool): its id and the selected points ("contour:index"). */
  pointEdit = $state<{ id: string; points: string[] } | null>(null);
  /** Parts mode: the compound shape whose parts can be selected (their ids: "<compound id>~<index>"). */
  partsOf = $state<string | null>(null);
  /** The Pen is drawing a path (Enter or Done ends it). */
  penDrawing = $state(false);
  /** Selected shapes (ids). */
  selection = $state<string[]>([]);
  /** Live shapes as the user sees them (pending changes included), for the panels. */
  shapes = $state<Shape[]>([]);
  overlay = $state<SelectOverlay | null>(null);

  layers = $state<Layer[]>([]); // bottom to top
  activeLayerId = $state<string | null>(null);
  peers = $state<PeerView[]>([]);
  clientId = $state<string | null>(null);
  status = $state<NetStatus>('connecting');
  view = $state({ x: 0, y: 0, zoom: 1 });
  cursor = $state<{ x: number; y: number } | null>(null);
  strokeCount = $state(0);
  canUndo = $state(false);
  canRedo = $state(false);
  toast = $state<string | null>(null);
  renderer = $state('');

  /** Logged-in account, or null. Undefined until the first /api/auth/me answers. */
  user = $state<User | null | undefined>(undefined);
  auth = $state<AuthView | null>(null);
  /** Email the last verification or reset mail went to (for the "check your email" view). */
  authEmail = $state('');
  resetToken = $state('');
  /** This client's role and what it knows about the open canvas. */
  role = $state<Role | null>(null);
  canvas = $state<CanvasInfo | null>(null);
  /** Why the canvas cannot be shown (no access, password, expired, ...), or null. */
  denied = $state<DeniedReason | null>(null);
  shareOpen = $state(false);
  /** The large image export dialog. */
  exportOpen = $state(false);
  /** The layer or group being transformed (free transform: the overlay shows its handles). */
  transform = $state<{ id: string } | null>(null);
  /** Groups closed in the layers panel (this device only). */
  collapsed = $state<Set<string>>(new Set());
  /** The brush paints the active layer's mask instead of the layer. */
  maskTarget = $state(false);
  /** The canvas uses features this client does not know (welcome.features). */
  outdated = $state(false);
  /** A .bdraw file waiting for "open as a new canvas" (picker, drop, OS file association). */
  openFile = $state<{ name: string; blob: Blob } | null>(null);

  get canEdit(): boolean {
    return this.role === 'owner' || this.role === 'editor';
  }
  get displayName(): string {
    return this.user?.name ?? this.name;
  }

  /** Settings of the tool that paints now (brush or eraser). */
  get activeBrush(): BrushSettings {
    return this.tool === 'eraser' ? this.eraser : this.brush;
  }

  persist(): void {
    save('draw.prefs', {
      name: this.name,
      color: this.color,
      brush: $state.snapshot(this.brush),
      eraser: $state.snapshot(this.eraser),
      smoothing: this.smoothing,
      showMarkers: this.showMarkers,
      touchPressure: this.touchPressure,
      strokeEraserSize: this.strokeEraserSize,
      strokeEraserAll: this.strokeEraserAll,
      fg: this.fg,
      bg: this.bg,
      swatches: $state.snapshot(this.swatches),
      shapeKind: this.shapeKind,
      shapeStyle: $state.snapshot(this.shapeStyle),
      penStyle: $state.snapshot(this.penStyle),
      keepSelection: this.keepSelection,
    });
  }
}

export const ed = new EditorState();

let toastTimer: number | undefined;
export function showToast(msg: string): void {
  ed.toast = msg;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (ed.toast = null), 2500);
}
