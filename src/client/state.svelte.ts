// Reactive editor state shared by the Svelte UI and the engine.

import { DEFAULT_BRUSH } from '../shared/brush';
import type { Brush, CanvasInfo, DeniedReason, Layer, LineCap, Role, Shape, ShapeKind, StrokeAlign } from '../shared/types';
import type { NetStatus } from './engine/net';
import type { Marker } from './engine/navigator';

/**
 * strokeEraser: removes whole strokes whose path the circle touches. zoom: the magnifier (click
 * zooms in, Alt+click or right-click zooms out, a sideways drag zooms smoothly). See engine.ts.
 * select: selects, moves, scales and rotates shapes; on a paint layer or a group, it transforms
 * the layer. shape: draws a new shape of `ed.shapeKind`. See shapeTool.ts.
 */
export type Tool = 'brush' | 'eraser' | 'strokeEraser' | 'eyedropper' | 'select' | 'shape' | 'hand' | 'zoom';

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
  shapeKind: 'rect' as ShapeKind,
  shapeStyle: {} as Partial<ShapeStyle>,
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
  shapeKind = $state<ShapeKind>(prefs.shapeKind);
  shapeStyle = $state<ShapeStyle>({ ...SHAPE_STYLE, ...prefs.shapeStyle });
  keepSelection = $state(prefs.keepSelection);
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
