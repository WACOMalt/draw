// Canvases on this device: drawn with no server (offline, or by choice), kept in IndexedDB as the
// server keeps its canvases: a row per canvas and the op log, replayed when the canvas opens.

import { newId } from '../../shared/ids';
import type { AppliedOp } from '../../shared/types';

export interface LocalCanvas {
  id: string;
  name: string;
  created: number;
  /** The last change. */
  updated: number;
  /** The last op's number. */
  seq: number;
}

export interface StoredOp {
  canvas: string;
  seq: number;
  /** The client that made it (the stroke and shape author). */
  by: string;
  op: AppliedOp;
}

const DB = 'draw-local';
const CANVASES = 'canvases';
const OPS = 'ops';

let opening: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    let r: IDBOpenDBRequest;
    try {
      r = indexedDB.open(DB, 1);
    } catch (e) {
      return reject(e instanceof Error ? e : new Error('no IndexedDB'));
    }
    r.onupgradeneeded = () => {
      r.result.createObjectStore(CANVASES, { keyPath: 'id' });
      r.result.createObjectStore(OPS, { keyPath: ['canvas', 'seq'] });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB failed'));
  });
  opening.catch(() => (opening = null));
  return opening;
}

const done = (t: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = t.onabort = () => reject(t.error ?? new Error('IndexedDB write failed'));
  });

const req = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB read failed'));
  });

/** The canvases on this device, the latest change first. Empty when storage is unavailable. */
export async function listLocal(): Promise<LocalCanvas[]> {
  try {
    const list = await req((await db()).transaction(CANVASES).objectStore(CANVASES).getAll() as IDBRequest<LocalCanvas[]>);
    return list.sort((a, b) => b.updated - a.updated);
  } catch {
    return [];
  }
}

export async function getLocal(id: string): Promise<LocalCanvas | null> {
  return (await req((await db()).transaction(CANVASES).objectStore(CANVASES).get(id) as IDBRequest<LocalCanvas | undefined>)) ?? null;
}

/** A new, empty canvas on this device (LocalNet adds its first layer when it opens). */
export async function createLocal(name: string): Promise<LocalCanvas> {
  const now = Date.now();
  const c: LocalCanvas = { id: newId(), name, created: now, updated: now, seq: 0 };
  const t = (await db()).transaction(CANVASES, 'readwrite');
  t.objectStore(CANVASES).put(c);
  await done(t);
  return c;
}

export async function renameLocal(id: string, name: string): Promise<void> {
  const d = await db();
  const t = d.transaction(CANVASES, 'readwrite');
  const s = t.objectStore(CANVASES);
  const c = await req(s.get(id) as IDBRequest<LocalCanvas | undefined>);
  if (c) s.put({ ...c, name });
  await done(t);
}

/** Deletes a canvas and its ops. */
export async function deleteLocal(id: string): Promise<void> {
  const t = (await db()).transaction([CANVASES, OPS], 'readwrite');
  t.objectStore(CANVASES).delete(id);
  t.objectStore(OPS).delete(IDBKeyRange.bound([id, 0], [id, Infinity]));
  await done(t);
}

/** The op log of a canvas, in order. */
export async function loadOps(id: string): Promise<StoredOp[]> {
  const s = (await db()).transaction(OPS).objectStore(OPS);
  return req(s.getAll(IDBKeyRange.bound([id, 0], [id, Infinity])) as IDBRequest<StoredOp[]>);
}

/** Writes ops (in order, one transaction) and moves the canvas's seq and time. */
export async function appendOps(id: string, ops: StoredOp[]): Promise<void> {
  if (!ops.length) return;
  const d = await db();
  const t = d.transaction([CANVASES, OPS], 'readwrite');
  const os = t.objectStore(OPS);
  for (const o of ops) os.put(o);
  const cs = t.objectStore(CANVASES);
  const c = await req(cs.get(id) as IDBRequest<LocalCanvas | undefined>);
  if (c) cs.put({ ...c, seq: ops[ops.length - 1].seq, updated: Date.now() });
  await done(t);
}
