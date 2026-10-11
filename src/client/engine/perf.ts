// How much rendering work this device gets: the canvas resolution, the tile format and how many
// tiles stay in GPU memory. A phone's GPU has far less fill rate and memory than a desktop's, and
// a phone screen's pixel ratio (2.5 to 3.5) multiplies the pixels to fill.
//
// - full: desktops and laptops. The screen's own pixel ratio, 16-bit tiles.
// - phone: touch screens. At most 2× resolution, 16-bit tiles, a smaller tile cache.
// - light: weak touch devices (little memory, few cores, or an older GPU), or a phone that was too
//   slow before (see slowDevice). At most 1.5×, 8-bit tiles (half the memory and bandwidth),
//   fewer tiles, one coarser level instead of two.
//
// Override in Settings (localStorage 'draw.perf'), or with ?perf=full|phone|light in the URL. 'auto'
// or nothing: detect.

export type PerfName = 'full' | 'phone' | 'light';

export interface PerfProfile {
  name: PerfName;
  /** Highest canvas pixel ratio. The CSS layout keeps the screen's own. */
  maxScale: number;
  /** Tile and buffer precision: 16 when the GPU can, else 8. */
  bits: 8 | 16;
  /** Tiles kept without pressure, and the hard limit (with the ranges the view needs). */
  maxTiles: number;
  hardMaxTiles: number;
  /** Starting GPU fill budget per frame (adapts to the frame rate). */
  fill: number;
  /** Coarser tile levels kept around the view (fast zoom out, no blank tiles while panning). */
  coarseLevels: number;
}

const PROFILES: Record<PerfName, PerfProfile> = {
  full: { name: 'full', maxScale: Infinity, bits: 16, maxTiles: 512, hardMaxTiles: 1200, fill: 8e6, coarseLevels: 2 },
  phone: { name: 'phone', maxScale: 2, bits: 16, maxTiles: 160, hardMaxTiles: 320, fill: 1.5e6, coarseLevels: 2 },
  light: { name: 'light', maxScale: 1.5, bits: 8, maxTiles: 128, hardMaxTiles: 256, fill: 8e5, coarseLevels: 1 },
};

/** Exports and previews: full quality on every device. */
export const FULL_PROFILE = PROFILES.full;

const SLOW_KEY = 'draw.perf.slow';

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Older mobile GPUs: Adreno 2xx to 5xx, Mali-4xx, Mali-T, the small Mali-G (G31 to G52), PowerVR. */
const WEAK_GPU = /Adreno \(TM\) [2-5]\d\d|Mali-(4\d\d|T\d+|G(31|51|52|57)\b)|PowerVR/i;

function gpuName(gl: WebGL2RenderingContext | null): string {
  if (!gl) return '';
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  } catch {
    return '';
  }
}

/** The profile for this device. `gl`: the context the renderer will use (to name its GPU). */
export function perfProfile(gl: WebGL2RenderingContext | null): PerfProfile {
  lastAuto = detect(gl);
  const forced = new URLSearchParams(location.search).get('perf') ?? stored(PERF_KEY);
  if (forced && forced in PROFILES) return PROFILES[forced as PerfName];
  return PROFILES[lastAuto.name];
}

/** What detection picks, and why (Settings shows it). */
function detect(gl: WebGL2RenderingContext | null): { name: PerfName; why: string } {
  if (!matchMedia('(pointer: coarse)').matches) return { name: 'full', why: 'a mouse or a pen' };
  const nav = navigator as Navigator & { deviceMemory?: number };
  const mem = nav.deviceMemory ?? 8, cores = navigator.hardwareConcurrency ?? 8;
  if (stored(SLOW_KEY) === '1') return { name: 'light', why: 'this device was too slow before' };
  if (mem <= 3) return { name: 'light', why: `${mem} GB of memory` };
  if (cores <= 4) return { name: 'light', why: `${cores} cores` };
  if (WEAK_GPU.test(gpuName(gl))) return { name: 'light', why: 'an older GPU' };
  return { name: 'phone', why: 'a touch screen' };
}

let lastAuto: { name: PerfName; why: string } | null = null;

/** What detection picked at the last renderer start, and why. Null before the first start. */
export function autoPerf(): { name: PerfName; why: string } | null {
  return lastAuto;
}

const PERF_KEY = 'draw.perf';

/** The profile chosen in Settings, or 'auto' (detect). The renderer reads it at its start. */
export function perfSetting(): PerfName | 'auto' {
  const v = stored(PERF_KEY);
  return v && v in PROFILES ? (v as PerfName) : 'auto';
}

export function setPerfSetting(v: PerfName | 'auto'): void {
  try {
    if (v === 'auto') localStorage.removeItem(PERF_KEY);
    else localStorage.setItem(PERF_KEY, v);
  } catch {
    // not kept: the next start detects again
  }
}

/** Remembers that this device was too slow, so the next start uses the light profile. */
export function slowDevice(): void {
  try {
    localStorage.setItem(SLOW_KEY, '1');
  } catch {
    // not remembered: detection runs again next time
  }
}
