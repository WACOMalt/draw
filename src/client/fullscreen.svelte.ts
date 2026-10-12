// Full screen, on every platform the app runs on:
// - browsers and the Linux app (Electron): the Fullscreen API of the page;
// - Windows and macOS (Tauri): the window's own full screen;
// - Android: the app hides the status and navigation bars (window.DrawFullScreen, FullScreen.kt).
// iPhone Safari has no full screen for a page: no button there.

import { IS_TAURI } from './config';

interface AndroidFullScreen {
  set(full: boolean): void;
  get(): boolean;
}
const android = (window as unknown as { DrawFullScreen?: AndroidFullScreen }).DrawFullScreen ?? null;

/** Tauri on a desktop (Android has its own bridge). */
const tauriDesktop = IS_TAURI && !android;

export const fullScreen = $state({ on: false });

/** This platform can go full screen. */
export const canFullScreen = !!android || tauriDesktop || !!document.fullscreenEnabled;

async function tauriWindow() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  return getCurrentWindow();
}

/** Reads the state again (a window can leave full screen by itself: Esc, a system gesture). */
export async function syncFullScreen(): Promise<void> {
  if (android) fullScreen.on = android.get();
  else if (tauriDesktop) fullScreen.on = await (await tauriWindow()).isFullscreen().catch(() => fullScreen.on);
  else fullScreen.on = !!document.fullscreenElement;
}

export async function setFullScreen(on: boolean): Promise<void> {
  try {
    if (android) android.set(on);
    else if (tauriDesktop) await (await tauriWindow()).setFullscreen(on);
    else if (on) await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    else if (document.fullscreenElement) await document.exitFullscreen();
  } catch (e) {
    console.warn('full screen', e);
  }
  await syncFullScreen();
}

export const toggleFullScreen = () => setFullScreen(!fullScreen.on);

if (!android && !tauriDesktop) document.addEventListener('fullscreenchange', () => void syncFullScreen());
// Tauri: Esc or the window's own controls can change it; a resize follows every change.
if (tauriDesktop) window.addEventListener('resize', () => void syncFullScreen());
