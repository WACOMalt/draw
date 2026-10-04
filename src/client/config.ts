// Where the server lives. Empty = the origin that served the page (web and PWA).
// The Tauri build sets VITE_SERVER_ORIGIN (see .env.tauri), because its page comes from the app.

const env = (import.meta.env.VITE_SERVER_ORIGIN as string | undefined)?.replace(/\/+$/, '') ?? '';

/** Prefix for fetch() calls: '' (same origin) or https://draw.bsums.xyz. */
export const API_BASE = env;

/** Origin for links people share. Never the app's internal origin. */
export const PUBLIC_ORIGIN = env || location.origin;

export const IS_TAURI = '__TAURI_INTERNALS__' in window;

/** The Linux desktop app: the hosted site in Electron (electron/preload.cjs). */
export interface DrawDesktop {
  kind: 'electron';
  onOpenFile(callback: (name: string, bytes: Uint8Array) => void): void;
}
export const ELECTRON = (window as unknown as { drawDesktop?: DrawDesktop }).drawDesktop ?? null;

/** Any desktop app (Tauri on Windows and macOS, Electron on Linux). */
export const IS_DESKTOP = IS_TAURI || ELECTRON !== null;

/** Desktop installers: the newest GitHub release. */
export const DOWNLOAD_URL = 'https://github.com/WACOMalt/draw/releases/latest';

export function wsUrl(key: string): string {
  const base = env || location.origin;
  return `${base.replace(/^http/, 'ws')}/ws?code=${encodeURIComponent(key)}`;
}
