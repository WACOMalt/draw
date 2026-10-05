// Shared brush presets: list, save, delete, apply. Anyone can save. The creator (an account, or
// this browser through its anonymous secret) and admins can delete.

import { DEFAULT_BRUSH } from '../shared/brush';
import type { BrushPreset, BrushSettings } from '../shared/types';
import { api, errorText } from './api';
import { anonSecret } from './identity';
import { ed } from './state.svelte';

export async function loadPresets(): Promise<BrushPreset[] | { error: string }> {
  const r = await api<{ presets: BrushPreset[] }>('GET', '/api/presets');
  return r.ok ? r.data.presets : { error: errorText(r.data.error) };
}

export async function savePreset(name: string, settings: BrushSettings): Promise<BrushPreset | { error: string }> {
  const r = await api<{ preset: BrushPreset }>('POST', '/api/presets', { name, settings, anon: anonSecret(), creatorName: ed.displayName });
  if (r.ok) return r.data.preset;
  const code = r.data.error;
  return {
    error:
      code === 'bad_name' ? 'Give the preset a name.'
      : code === 'too_many_presets' ? 'There are too many presets. Delete some first.'
      : code === 'rate_limited' ? 'Too many saves. Wait a while and try again.'
      : errorText(code),
  };
}

export async function deletePreset(id: string): Promise<string | null> {
  const r = await api('POST', `/api/presets/${encodeURIComponent(id)}/delete`, { anon: anonSecret() });
  return r.ok ? null : r.data.error === 'not_yours' ? 'Only its creator or an admin can delete this preset.' : errorText(r.data.error);
}

let anonKey: Promise<string> | null = null;

/** The creator key the server gives this browser's presets when no account is logged in. */
function anonCreator(): Promise<string> {
  anonKey ??= crypto.subtle.digest('SHA-256', new TextEncoder().encode(anonSecret())).then((buf) => {
    const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return `a:${hex.slice(0, 16)}`;
  });
  return anonKey;
}

/** Creator keys that count as "mine": the account, and this browser's anonymous presets. */
export async function myCreators(): Promise<Set<string>> {
  const keys = new Set<string>();
  try {
    keys.add(await anonCreator());
  } catch {
    // crypto.subtle needs a secure context; without it, only account presets count as mine.
  }
  if (ed.user) keys.add(`u:${ed.user.id}`);
  return keys;
}

/**
 * Makes the preset the active brush (or eraser, while the eraser is the tool). Settings that the
 * preset does not hold go back to their defaults, so no tip or jitter stays from before.
 */
export function applyPreset(p: BrushPreset): void {
  const { tool: _t, color: _c, ...defaults } = DEFAULT_BRUSH;
  const next: BrushSettings = { ...defaults, ...p.settings };
  if (ed.tool === 'eraser') ed.eraser = next;
  else {
    if (ed.tool !== 'brush') ed.tool = 'brush';
    ed.brush = next;
  }
}
