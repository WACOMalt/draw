// Where the server lives. Empty = the origin that served the page (web and PWA).
// The app build (`vite build --mode tauri`, for the Tauri apps and the Linux Electron app) sets
// VITE_SERVER_ORIGIN (see .env.tauri), because its page comes with the app.

const env = (import.meta.env.VITE_SERVER_ORIGIN as string | undefined)?.replace(/\/+$/, '') ?? '';

/** Prefix for fetch() calls: '' (same origin) or https://draw.bsums.xyz. */
export const API_BASE = env;

/** Origin for links people share. Never the app's internal origin. */
export const PUBLIC_ORIGIN = env || location.origin;

export const IS_TAURI = '__TAURI_INTERNALS__' in window;

/**
 * The page comes with the app (every desktop and mobile app), not from the server: the server is
 * another origin, so it signs in with a bearer token instead of a cookie.
 */
export const BUNDLED = API_BASE !== '';

/** The Linux desktop app: Electron, with the page bundled (electron/main.cjs, preload.cjs). */
export interface DrawDesktop {
  kind: 'electron';
  onOpenFile(callback: (name: string, bytes: Uint8Array) => void): void;
  /** Updates from the GitHub releases (electron/update.cjs). Missing in apps before v0.2.35. */
  updates?: {
    check(): Promise<{
      current: string;
      update: { version: string; page: string; install: 'appimage' | 'manual'; size: number; installed: boolean } | null;
    }>;
    download(onProgress: (fraction: number) => void): Promise<void>;
    restart(): Promise<void>;
  };
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
