// JSON calls to the server. The web app authenticates with its session cookie, the desktop app
// with a bearer token (its page lives on another origin, so cookies would be third-party).

import { API_BASE, IS_TAURI } from './config';
import { desktopToken } from './identity';
import { ed, type User } from './state.svelte';

export interface ApiResult<T> {
  status: number;
  ok: boolean;
  data: T & { error?: string };
}

export async function api<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = desktopToken.get();
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: IS_TAURI ? 'omit' : 'same-origin',
    });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    return { status: res.status, ok: res.ok, data };
  } catch {
    return { status: 0, ok: false, data: { error: 'network' } as T & { error?: string } };
  }
}

/**
 * Reloads the account. When it changed (login, logout, or another tab did that), open canvases
 * get a 'draw:auth' event and reconnect with the new identity.
 */
export async function loadMe(): Promise<void> {
  const before = ed.user?.id ?? null;
  const r = await api<{ user: User | null }>('GET', '/api/auth/me');
  if (r.status === 0) return; // offline: keep what we have
  ed.user = r.ok ? r.data.user : null;
  if (before !== (ed.user?.id ?? null)) window.dispatchEvent(new Event('draw:auth'));
}

const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('draw-auth') : null;

/** Tells this tab and every other open Draw tab that the login changed. */
export function announceAuth(): void {
  window.dispatchEvent(new Event('draw:auth'));
  channel?.postMessage('changed');
}

/** Other tabs logged in or out: reload the account. Also re-check when a tab comes back. */
export function watchAuth(): void {
  if (channel) channel.onmessage = () => void loadMe();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void loadMe();
  });
}

export async function logout(): Promise<void> {
  await api('POST', '/api/auth/logout', {});
  desktopToken.set(null);
  ed.user = null;
}

/** Readable text for an API error code. */
export function errorText(code: string | undefined): string {
  switch (code) {
    case 'bad_email':
      return 'Enter a valid email address.';
    case 'bad_name':
      return 'Enter a display name (up to 40 characters).';
    case 'bad_password':
      return 'Use at least 8 characters for the password.';
    case 'bad_login':
      return 'Wrong email or password.';
    case 'unverified':
      return 'Confirm your email first. Check your inbox for the link.';
    case 'rate_limited':
      return 'Too many tries. Wait a few minutes and try again.';
    case 'bad_token':
      return 'This link expired or was already used. Ask for a new one.';
    case 'no_such_user':
      return 'No verified Draw account has that email.';
    case 'is_owner':
      return 'That account already owns this canvas.';
    case 'login_required':
      return 'Log in first.';
    case 'mail_unavailable':
      return 'Email is not set up on this server yet, so accounts cannot be confirmed. Try again later.';
    case 'network':
      return 'Cannot reach the server.';
    default:
      return 'Something went wrong. Try again.';
  }
}
