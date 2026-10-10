// Brush preset thumbnails, for the presets list. A worker draws them (presetThumb.worker.ts), so
// the page never stops for them, and IndexedDB keeps them, so each preset is drawn once per
// device and look (settings, size, pixel ratio), not every time the app starts.

import type { BrushSettings } from '../shared/types';
import type { ThumbJob, ThumbResult } from './presetThumb.worker';
import ThumbWorker from './presetThumb.worker?worker';
import { drawThumb } from './presetThumbDraw';

/** Change it when the drawing changes: older stored thumbnails are then not used. */
const VERSION = 1;
const DB = 'draw-thumbs';
const STORE = 'thumbs';
/** More stored thumbnails than this: the store starts over (presets rarely change). */
const MAX_STORED = 400;

/** Object URLs by key, for this page's life. */
const urls = new Map<string, Promise<string>>();

let dbOpen: Promise<IDBDatabase | null> | null = null;
function db(): Promise<IDBDatabase | null> {
  dbOpen ??= new Promise((resolve) => {
    try {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(null);
    } catch {
      resolve(null); // no IndexedDB (a private window): draw every time
    }
  });
  return dbOpen;
}

function stored(key: string): Promise<Blob | null> {
  return db().then(
    (d) =>
      new Promise((resolve) => {
        if (!d) return resolve(null);
        try {
          const r = d.transaction(STORE).objectStore(STORE).get(key);
          r.onsuccess = () => resolve(r.result instanceof Blob ? r.result : null);
          r.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

function store(key: string, blob: Blob): void {
  void db().then((d) => {
    if (!d) return;
    try {
      const os = d.transaction(STORE, 'readwrite').objectStore(STORE);
      const count = os.count();
      count.onsuccess = () => {
        if (count.result >= MAX_STORED) os.clear();
        os.put(blob, key);
      };
    } catch {
      // storage full or unavailable: the thumbnail still shows
    }
  });
}

let worker: Worker | null = null;
let nextId = 1;
const waiting = new Map<number, { resolve: (b: Blob) => void; reject: (e: Error) => void }>();

function drawInWorker(job: Omit<ThumbJob, 'id'>): Promise<Blob> {
  if (!worker) {
    try {
      worker = new ThumbWorker();
    } catch {
      return drawThumb(job.settings, job.w, job.h, job.dpr); // no workers: draw here
    }
    worker.onmessage = (e: MessageEvent<ThumbResult>) => {
      const w = waiting.get(e.data.id);
      waiting.delete(e.data.id);
      if ('blob' in e.data) w?.resolve(e.data.blob);
      else w?.reject(new Error(e.data.error));
    };
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    worker!.postMessage({ ...job, id } satisfies ThumbJob);
  });
}

/** An object URL of the preset's thumbnail, w × h CSS pixels. */
export function presetThumb(settings: BrushSettings, w = 160, h = 56): Promise<string> {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const key = `${VERSION}|${JSON.stringify(settings)}|${w}|${h}|${dpr}`;
  let url = urls.get(key);
  if (!url) {
    url = (async () => {
      let blob = await stored(key);
      if (!blob) {
        blob = await drawInWorker({ settings, w, h, dpr });
        store(key, blob);
      }
      return URL.createObjectURL(blob);
    })();
    urls.set(key, url);
    // A failed one is tried again next time.
    url.catch(() => urls.delete(key));
  }
  return url;
}
