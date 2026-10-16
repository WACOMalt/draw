// Shared color palettes: list, save, change, delete. Anyone can save. Only the creator (an account,
// or this browser through its anonymous secret) changes a palette; the creator or an admin deletes.

import type { Palette, PaletteColor } from '../shared/types';
import { api, errorText } from './api';
import { anonSecret } from './identity';
import { ed } from './state.svelte';

function message(code: string | undefined): string {
  return code === 'bad_name' ? 'Give the palette a name.'
    : code === 'bad_colors' ? 'A palette holds at most 128 colors.'
    : code === 'too_many_palettes' ? 'There are too many palettes. Delete some first.'
    : code === 'rate_limited' ? 'Too many changes. Wait a while and try again.'
    : code === 'not_yours' ? 'Only its creator can change this palette.'
    : errorText(code);
}

export async function loadPalettes(): Promise<Palette[] | { error: string }> {
  const r = await api<{ palettes: Palette[] }>('GET', '/api/palettes');
  if (r.ok) return r.data.palettes;
  // A server from before palettes has no such route.
  return { error: r.status === 404 ? 'This server does not keep palettes yet.' : errorText(r.data.error) };
}

export async function savePalette(name: string, colors: PaletteColor[]): Promise<Palette | { error: string }> {
  const r = await api<{ palette: Palette }>('POST', '/api/palettes', { name, colors, anon: anonSecret(), creatorName: ed.displayName });
  return r.ok ? r.data.palette : { error: message(r.data.error) };
}

export async function updatePalette(id: string, change: { name?: string; colors?: PaletteColor[] }): Promise<Palette | { error: string }> {
  const r = await api<{ palette: Palette }>('POST', `/api/palettes/${encodeURIComponent(id)}`, { ...change, anon: anonSecret() });
  return r.ok ? r.data.palette : { error: message(r.data.error) };
}

export async function deletePalette(id: string): Promise<string | null> {
  const r = await api('POST', `/api/palettes/${encodeURIComponent(id)}/delete`, { anon: anonSecret() });
  return r.ok ? null : r.data.error === 'not_yours' ? 'Only its creator or an admin can delete this palette.' : message(r.data.error);
}
