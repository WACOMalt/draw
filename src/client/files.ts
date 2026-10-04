// Files on disk: .bdraw save and open, PNG export, and the ways a file reaches the app
// (file picker, drag and drop, the desktop app's file association, the installed PWA).

import { BDRAW_EXT, type BdrawFile } from '../shared/bdraw';
import { api, errorText } from './api';
import { IS_TAURI } from './config';
import { anonSecret } from './identity';
import { ed, showToast } from './state.svelte';

/** Saves a blob: the native save dialog in the desktop app, a download in the browser. */
export async function saveBlob(blob: Blob, name: string, filter: { name: string; extensions: string[] }): Promise<void> {
  if (IS_TAURI) {
    // Webviews do not handle <a download>: ask for a path and write the file natively.
    const [{ save }, { writeFile }] = await Promise.all([import('@tauri-apps/plugin-dialog'), import('@tauri-apps/plugin-fs')]);
    const path = await save({ defaultPath: name, filters: [filter] });
    if (path) {
      await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
      showToast('Saved');
    }
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** gzip-compressed JSON. Browsers without CompressionStream write plain JSON (also valid). */
export async function encodeBdraw(file: BdrawFile): Promise<Blob> {
  const json = new Blob([JSON.stringify(file)], { type: 'application/json' });
  if (typeof CompressionStream === 'undefined') return json;
  return new Response(json.stream().pipeThrough(new CompressionStream('gzip'))).blob();
}

export const isBdrawName = (name: string) => name.toLowerCase().endsWith(`.${BDRAW_EXT}`);

/** Puts a file in front of the "open as a new canvas" dialog. */
export function offerFile(name: string, blob: Blob): void {
  if (!isBdrawName(name)) return void showToast(`Draw opens .${BDRAW_EXT} files only`);
  ed.openFile = { name, blob };
}

/** The file picker. A plain <input type=file> works in browsers and in all desktop webviews. */
export function pickFile(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = `.${BDRAW_EXT}`;
  input.onchange = () => {
    const f = input.files?.[0];
    if (f) offerFile(f.name, f);
  };
  input.click();
}

export interface CreateOptions {
  name?: string;
  /** Accounts: what the canvas link gives. 'editor' public, 'none' private. */
  access?: 'editor' | 'none';
}

export interface Created {
  key: string;
  link: string | null;
}

/** Makes a canvas, empty or from a .bdraw file. Returns the error text on failure. */
export async function createCanvas(o: CreateOptions, file?: Blob): Promise<Created | { error: string; code?: string; taken?: string }> {
  // The anonymous secret marks this browser as the creator, so it alone may claim the canvas.
  const opts = { ...o, anon: anonSecret() };
  const r = file
    ? await api<Created & { skipped: number }>('POST', '/api/import', file, { 'X-Draw-Options': encodeURIComponent(JSON.stringify(opts)) })
    : await api<Created>('POST', '/api/sessions', opts);
  if (r.ok) {
    const skipped = (r.data as { skipped?: number }).skipped;
    if (skipped) showToast(`${skipped} damaged ${skipped === 1 ? 'item was' : 'items were'} left out`);
    return r.data;
  }
  const code = r.data.error;
  const error =
    code === 'name_taken' ? 'taken'
    : code === 'bad_name' ? 'Use 3 to 40 letters, digits or dashes for the name.'
    : code === 'rate_limited' ? 'Too many new canvases. Wait a minute and try again.'
    : code === 'bad_file' ? 'This is not a Draw file, or it is damaged.'
    : code === 'file_too_new' ? 'This file is from a newer Draw. Update the app.'
    : code === 'file_too_big' ? 'The file is too big (32 MB at most).'
    : errorText(code);
  return { error, code, taken: (r.data as { key?: string }).key };
}

/**
 * Files the operating system gave the app: the desktop app's file association (Rust command,
 * macOS also sends an event while running), or an installed PWA's file handler (Chromium).
 */
export function watchOpenedFiles(): void {
  if (IS_TAURI) {
    void (async () => {
      const [{ invoke }, { listen }] = await Promise.all([import('@tauri-apps/api/core'), import('@tauri-apps/api/event')]);
      const take = async () => {
        const paths = await invoke<string[]>('take_opened_files');
        const path = paths[0];
        if (!path) return;
        const bytes = await invoke<ArrayBuffer>('read_opened_file', { path });
        offerFile(path.split(/[\\/]/).pop() ?? path, new Blob([bytes]));
      };
      await take();
      await listen('opened-files', () => void take());
    })().catch((e) => console.warn('opened files', e));
    return;
  }
  const lq = (window as unknown as { launchQueue?: { setConsumer(cb: (p: { files: FileSystemFileHandle[] }) => void): void } }).launchQueue;
  lq?.setConsumer(async ({ files }) => {
    const f = await files[0]?.getFile();
    if (f) offerFile(f.name, f);
  });
}
