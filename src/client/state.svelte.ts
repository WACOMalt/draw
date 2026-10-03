// Reactive editor state shared by the Svelte UI and the engine.

import { DEFAULT_BRUSH } from '../shared/brush';
import type { Brush, Layer } from '../shared/types';
import type { NetStatus } from './engine/net';
import type { Marker } from './engine/navigator';

export type Tool = 'brush' | 'eraser' | 'eyedropper' | 'hand';
export type BrushSettings = Omit<Brush, 'tool' | 'color'>;

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
const prefs = load('draw.prefs', {
  name: `${pick(ADJ)} ${pick(NOUN)}`,
  color: pick(PEER_COLORS),
  brush: brushDefaults as BrushSettings,
  eraser: { ...brushDefaults, hardness: 0.6, size: 40, pressureSize: false } as BrushSettings,
  smoothing: 0.25,
  showMarkers: true,
  fg: '#1e1e1e',
  bg: '#ffffff',
  swatches: [] as string[],
});

class EditorState {
  tool = $state<Tool>('brush');
  brush = $state<BrushSettings>({ ...brushDefaults, ...prefs.brush });
  eraser = $state<BrushSettings>({ ...brushDefaults, ...prefs.eraser });
  smoothing = $state(prefs.smoothing);
  showMarkers = $state(prefs.showMarkers);
  markers = $state<Marker[]>([]);
  fg = $state(prefs.fg);
  bg = $state(prefs.bg);
  swatches = $state<string[]>(prefs.swatches);
  name = $state(prefs.name);
  color = $state(prefs.color);

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
      fg: this.fg,
      bg: this.bg,
      swatches: $state.snapshot(this.swatches),
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
