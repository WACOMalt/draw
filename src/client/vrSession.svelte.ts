// The editor's side of "Open in VR" (vr.ts is the bridge): whether to offer it, the hello for
// vdraw, and what its events do. While VR runs, this window stays connected but marks itself as
// in VR (engine.setInVr), so other people see one person: the VR one.

import type { Engine } from './engine/engine';
import { API_BASE } from './config';
import { anonSecret, desktopToken } from './identity';
import { ed, showToast } from './state.svelte';
import { closeVr, onVrEvent, openVr, probeVr, VR_BRIDGE, type VrHello } from './vr';

export const vr = $state({
  /** The desktop app can start vdraw and an OpenXR runtime is installed. */
  available: false,
  /** vdraw is starting (no "ready" yet). */
  starting: false,
  /** The canvas is open in the headset. */
  inVr: false,
});

/** The editor VR runs for, and its canvas. */
let current: { engine: Engine; code: string } | null = null;
/** vdraw reported an error before it exited (no second message for the exit). */
let failed = false;

/** Asks the bridge whether VR can run (cached; again after a while). Nothing on the web. */
export function checkVr(): void {
  if (!VR_BRIDGE) return;
  void probeVr().then((p) => (vr.available = p.ok));
}

function hello(engine: Engine, code: string): VrHello {
  return {
    server: API_BASE || location.origin,
    canvas: code,
    link: engine.shareLink ?? null,
    name: ed.displayName,
    color: ed.color,
    anon: anonSecret(),
    token: desktopToken.get(),
    view: engine.viewCenter(),
  };
}

/** Opens this canvas in VR. */
export async function startVr(engine: Engine, code: string): Promise<void> {
  if (vr.starting || vr.inVr) return;
  current = { engine, code };
  failed = false;
  vr.starting = true;
  try {
    await openVr(hello(engine, code));
  } catch (e) {
    vr.starting = false;
    current = null;
    showToast(e instanceof Error ? e.message : String(e));
  }
}

/** Asks vdraw to end ("closed" and the exit follow). */
export function stopVr(): void {
  if (vr.starting || vr.inVr) void closeVr();
}

/** The editor closes (left the canvas): VR ends with it. */
export function detachVr(engine: Engine): void {
  if (current?.engine !== engine) return;
  stopVr();
  engine.setInVr(false);
  current = null;
}

if (VR_BRIDGE) {
  checkVr();
  onVrEvent((e) => {
    const engine = current?.engine;
    switch (e.t) {
      case 'ready':
        vr.starting = false;
        vr.inVr = true;
        engine?.setInVr(true);
        break;
      case 'closed':
        // Show where the VR user last looked.
        if (engine && e.view) engine.showView(e.view);
        break;
      case 'error':
        failed = true;
        showToast(`VR: ${e.message}`);
        break;
      case 'exit':
        if (!failed && vr.starting && e.code !== 0) showToast('VR closed before it opened');
        vr.starting = false;
        vr.inVr = false;
        engine?.setInVr(false);
        current = null;
        break;
    }
  });
}
