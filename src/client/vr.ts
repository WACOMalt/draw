// "Open in VR": the desktop app starts vdraw (the VR app, vr/) on the open canvas and talks to it
// over its stdin and stdout (`vdraw --bridge`). Two shells carry it:
// - Tauri (Windows): Rust commands in src-tauri/src/vr.rs, vdraw bundled as a sidecar
// - Electron (Linux): electron/vr.cjs, exposed by preload.cjs as drawDesktop.vr
// Both pass the same JSON lines: this module hides which one it is. The web and the other
// platforms have no bridge (available = false). Credentials only travel in the hello line.

import { ELECTRON, IS_TAURI } from './config';

/** The first line vdraw reads: which canvas, as whom, and where the 2D view is. */
export interface VrHello {
  server: string;
  canvas: string;
  link: string | null;
  name: string;
  color: string;
  anon: string;
  token: string | null;
  /** The view center and the width it shows, in canvas units. */
  view: VrView;
}

export interface VrView {
  x: number;
  y: number;
  width: number;
}

/** `vdraw --probe`: an OpenXR runtime is installed (it does not start it). */
export type VrProbe = { ok: true; runtime: string } | { ok: false; reason: string };

/**
 * From vdraw: ready (open in the headset), closed (ended; where the VR user last looked),
 * error (it failed and exits). exit: the process ended (the bridge adds it, always last).
 */
export type VrEvent = { t: 'ready' } | { t: 'closed'; view: VrView | null } | { t: 'error'; message: string } | { t: 'exit'; code: number | null };

/** What each shell gives the page. Lines are JSON text, as vdraw writes them. */
export interface VrBridge {
  probe(): Promise<VrProbe>;
  /** Starts `vdraw --bridge` and writes the hello line. Rejects if it cannot start. */
  open(hello: string): Promise<void>;
  /** Asks vdraw to end ({"t":"close"}); the shell kills it if it has not exited a few seconds later. */
  close(): Promise<void>;
  /** vdraw's stdout lines and the exit line. Returns the unsubscribe. */
  onLine(callback: (line: string) => void): () => void;
}

/** The Tauri commands (src-tauri/src/vr.rs). The core API is loaded only in the app. */
function tauriBridge(): VrBridge {
  const core = import('@tauri-apps/api/core');
  const event = import('@tauri-apps/api/event');
  return {
    probe: async () => (await core).invoke<VrProbe>('vr_probe'),
    open: async (hello) => (await core).invoke<void>('vr_open', { hello }),
    close: async () => (await core).invoke<void>('vr_close'),
    onLine(callback) {
      let off: (() => void) | null = null;
      let dropped = false;
      void event
        .then((e) => e.listen<string>('vr-line', (ev) => callback(ev.payload)))
        .then((un) => {
          if (dropped) un();
          else off = un;
        });
      return () => {
        dropped = true;
        off?.();
      };
    },
  };
}

/** A pretend bridge for trying the UI in a browser: localStorage draw.fakeVr = '1' (dev builds only). */
function fakeBridge(): VrBridge {
  const listeners = new Set<(line: string) => void>();
  const emit = (o: object) => setTimeout(() => listeners.forEach((f) => f(JSON.stringify(o))), 0);
  let last: VrView | null = null;
  let running = false;
  return {
    probe: async () => ({ ok: true, runtime: 'Fake runtime' }),
    async open(hello) {
      if (running) throw new Error('VR is already open');
      running = true;
      last = (JSON.parse(hello) as VrHello).view;
      console.info('fake vdraw: hello', JSON.parse(hello));
      setTimeout(() => emit({ t: 'ready' }), 800);
    },
    async close() {
      if (!running) return;
      running = false;
      // Where the pretend VR user looked: a little to the right, zoomed out.
      emit({ t: 'closed', view: last && { x: last.x + last.width / 4, y: last.y, width: last.width * 2 } });
      emit({ t: 'exit', code: 0 });
    },
    onLine(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  };
}

function pickBridge(): VrBridge | null {
  if (ELECTRON?.vr) return ELECTRON.vr;
  // Tauri: VR is a Windows thing (macOS, Android and iOS have no OpenXR); vr_probe says so too.
  if (IS_TAURI && /Windows/.test(navigator.userAgent)) return tauriBridge();
  try {
    if (import.meta.env.DEV && localStorage.getItem('draw.fakeVr') === '1') return fakeBridge();
  } catch {
    // no storage
  }
  return null;
}

const bridge = pickBridge();

/** A desktop app that can start vdraw (the probe still decides whether to offer it). */
export const VR_BRIDGE = bridge !== null;

const isView = (v: unknown): v is VrView => {
  const o = v as VrView | null;
  return !!o && typeof o === 'object' && [o.x, o.y, o.width].every((n) => typeof n === 'number' && Number.isFinite(n)) && o.width > 0;
};

/** One line from the bridge as an event, or null when it is not one of ours. */
export function parseVrLine(line: string): VrEvent | null {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(line);
  } catch {
    return null;
  }
  if (!m || typeof m !== 'object') return null;
  switch (m.t) {
    case 'ready':
      return { t: 'ready' };
    case 'closed':
      return { t: 'closed', view: isView(m.view) ? m.view : null };
    case 'error':
      return { t: 'error', message: typeof m.message === 'string' && m.message ? m.message.slice(0, 300) : 'VR failed' };
    case 'exit':
      return { t: 'exit', code: typeof m.code === 'number' ? m.code : null };
    default:
      return null;
  }
}

/** The probe (cached: it reads a file or the registry, but there is no need to ask often). */
let probed: { at: number; result: Promise<VrProbe> } | null = null;
const PROBE_AGAIN_MS = 60_000;

export function probeVr(): Promise<VrProbe> {
  if (!bridge) return Promise.resolve({ ok: false, reason: 'not available' });
  if (!probed || performance.now() - probed.at > PROBE_AGAIN_MS) {
    const result = bridge.probe().catch((e): VrProbe => ({ ok: false, reason: String(e) }));
    probed = { at: performance.now(), result };
  }
  return probed.result;
}

export function openVr(hello: VrHello): Promise<void> {
  if (!bridge) return Promise.reject(new Error('VR is not available'));
  return bridge.open(JSON.stringify(hello));
}

export function closeVr(): Promise<void> {
  return bridge ? bridge.close() : Promise.resolve();
}

/** vdraw's events (ready, closed, error, exit). Returns the unsubscribe. */
export function onVrEvent(callback: (e: VrEvent) => void): () => void {
  if (!bridge) return () => {};
  return bridge.onLine((line) => {
    const e = parseVrLine(line);
    if (e) callback(e);
  });
}
