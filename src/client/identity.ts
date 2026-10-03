// Per-device identity that is not an account:
// - the anonymous secret proves "this browser created that temporary canvas" (claiming)
// - the desktop app keeps its bearer session token here (the web app uses an httpOnly cookie)
// - join-password grants and share-link tokens per canvas

import { IS_TAURI } from './config';

function get(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function set(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // storage may be unavailable
  }
}

/** Random 256-bit secret, made once per browser. Only its hash ever leaves the server's RAM. */
export function anonSecret(): string {
  let s = get('draw.anon');
  if (!s) {
    const b = crypto.getRandomValues(new Uint8Array(32));
    s = btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    set('draw.anon', s);
  }
  return s;
}

export const desktopToken = {
  get: (): string | null => (IS_TAURI ? get('draw.token') : null),
  set: (t: string | null) => IS_TAURI && set('draw.token', t),
};

export const grants = {
  get: (key: string) => get(`draw.grant.${key}`) ?? undefined,
  set: (key: string, g: string) => set(`draw.grant.${key}`, g),
};

/** The share-link token a canvas was opened with, so reopening from "recent" still works. */
export const links = {
  get: (key: string) => get(`draw.link.${key}`) ?? undefined,
  set: (key: string, k: string | null) => set(`draw.link.${key}`, k),
};
