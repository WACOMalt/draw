// Where a large export goes: straight to a file on disk where the platform allows it, so the
// image never has to fit in memory. Order of preference:
// 1. Tauri apps: the native save dialog, then native file writes.
// 2. Browsers with the File System Access API (Chromium, Edge, the Electron app): a stream.
// 3. Elsewhere (Firefox, Safari): parts in memory, then a download. Size-limited.

import { IS_TAURI } from '../config';

export interface Sink {
  /** Appends bytes. */
  write(data: Uint8Array): Promise<void>;
  /** Overwrites bytes that were written before (call only at the end, before close). */
  patch(position: number, data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
  /** Bytes written so far. */
  readonly size: number;
  /** File name (as chosen in the save dialog, when the platform tells it). */
  readonly name: string;
}

/** The browser said the file was written, but the file on disk does not hold what was sent. */
export class NotSavedError extends Error {
  constructor(detail: string) {
    super(`not_saved: ${detail}`);
    this.name = 'NotSavedError';
  }
}

export type SinkKind = 'native' | 'stream' | 'memory';

/** How this platform can save. 'memory' means: the whole file must fit in the browser's memory. */
export function sinkKind(): SinkKind {
  if (IS_TAURI) return 'native';
  if ('showSaveFilePicker' in window) return 'stream';
  return 'memory';
}

/** Largest file a memory sink takes (the browser holds all of it before the download). */
export const MEMORY_LIMIT = 1.5 * 2 ** 30;

/** Writes go out in blocks of this size: one large write is much faster than many small ones. */
const BLOCK = 4 * 2 ** 20;

/** Asks where to save. Null: the person cancelled. `memory`: a plain download (the fallback). */
export async function openSink(name: string, mime: string, ext: string, label: string, memory = false): Promise<Sink | null> {
  const kind = memory ? 'memory' : sinkKind();
  if (kind === 'native') return openNative(name, ext, label);
  if (kind === 'stream') return openStream(name, mime, ext, label);
  return memorySink(name, mime);
}

/** Collects small writes into blocks. */
function blocked(flush: (b: Uint8Array) => Promise<void>) {
  let buf = new Uint8Array(BLOCK);
  let used = 0;
  return {
    async write(data: Uint8Array) {
      if (used + data.length > BLOCK) {
        if (used) await flush(buf.subarray(0, used));
        used = 0;
        if (data.length > BLOCK) return flush(data);
        buf = new Uint8Array(BLOCK);
      }
      buf.set(data, used);
      used += data.length;
    },
    async drain() {
      if (used) await flush(buf.subarray(0, used));
      used = 0;
      buf = new Uint8Array(BLOCK);
    },
  };
}

async function openStream(name: string, mime: string, ext: string, label: string): Promise<Sink | null> {
  let handle: FileSystemFileHandle;
  try {
    handle = await (window as unknown as { showSaveFilePicker: (o: unknown) => Promise<FileSystemFileHandle> }).showSaveFilePicker({
      suggestedName: name,
      types: [{ description: label, accept: { [mime]: [`.${ext}`] } }],
    });
  } catch {
    return null; // cancelled
  }
  const file = await handle.createWritable();
  let size = 0;
  // The first bytes as they must end up on disk (header patches included), to check the file.
  const head = new Uint8Array(64);
  let headLen = 0;
  const keep = (position: number, data: Uint8Array) => {
    for (let i = 0; i < data.length && position + i < head.length; i++) head[position + i] = data[i];
    headLen = Math.max(headLen, Math.min(head.length, position + data.length));
  };
  const out = blocked((b) => file.write(b.slice()));
  return {
    name: handle.name,
    get size() {
      return size;
    },
    async write(data) {
      if (size < head.length) keep(size, data);
      size += data.length;
      await out.write(data);
    },
    async patch(position, data) {
      keep(position, data);
      await out.drain();
      await file.write({ type: 'write', position, data: data.slice() });
    },
    async close() {
      await out.drain();
      await file.close();
      // Read it back: some browser shells report success without storing the data.
      const saved = await handle.getFile();
      if (saved.size !== size) throw new NotSavedError(`${saved.size} of ${size} bytes`);
      const got = new Uint8Array(await saved.slice(0, headLen).arrayBuffer());
      if (got.some((b, i) => b !== head[i])) throw new NotSavedError('the start of the file differs');
    },
    async abort() {
      await file.abort().catch(() => {});
    },
  };
}

async function openNative(name: string, ext: string, label: string): Promise<Sink | null> {
  const [{ save }, fs] = await Promise.all([import('@tauri-apps/plugin-dialog'), import('@tauri-apps/plugin-fs')]);
  const path = await save({ defaultPath: name, filters: [{ name: label, extensions: [ext] }] });
  if (!path) return null;
  const f = await fs.open(path, { write: true, create: true, truncate: true });
  let size = 0;
  const base = path.split(/[\\/]/).pop() ?? name;
  const writeAll = async (b: Uint8Array) => {
    for (let o = 0; o < b.length; ) o += await f.write(b.subarray(o));
  };
  const out = blocked(writeAll);
  return {
    name: base,
    get size() {
      return size;
    },
    async write(data) {
      size += data.length;
      await out.write(data);
    },
    async patch(position, data) {
      await out.drain();
      await f.seek(position, fs.SeekMode.Start);
      await writeAll(data);
      await f.seek(0, fs.SeekMode.End);
    },
    async close() {
      await out.drain();
      await f.close();
    },
    async abort() {
      await f.close().catch(() => {});
      await fs.remove(path).catch(() => {});
    },
  };
}

function memorySink(name: string, mime: string): Sink {
  const parts: Uint8Array[] = [];
  let size = 0;
  return {
    name,
    get size() {
      return size;
    },
    async write(data) {
      if (size + data.length > MEMORY_LIMIT) throw new Error('too_big_for_memory');
      parts.push(data.slice());
      size += data.length;
    },
    async patch(position, data) {
      // Find the parts that cover the range and overwrite in place.
      let at = 0;
      for (const p of parts) {
        const end = at + p.length;
        for (let i = Math.max(position, at); i < Math.min(position + data.length, end); i++) p[i - at] = data[i - position];
        at = end;
      }
    },
    async close() {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob(parts as BlobPart[], { type: mime }));
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    },
    async abort() {
      parts.length = 0;
    },
  };
}
