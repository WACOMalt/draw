// Strokes' dab lists in GPU memory (float textures), for the tile renderer (glRenderer.ts). A
// tile used to put every dab of its strokes into an instance buffer: a transform per dab on the
// CPU (with a cosine and a sine), then 68 bytes per dab to the GPU. A dense canvas sent 225 MB to
// export 4096 px, and the CPU took three times the GPU's time. Now each stroke's dabs go to the
// GPU once, and a tile sends one record per 64-dab chunk (DAB_CHUNK): where the chunk is in the
// tile, its color, and where its dabs are (DAB_GPU_VS reads them).
//
// A chunk keeps its dabs relative to the center of its box, in float32: small numbers, so the
// transform is exact on the GPU as long as the chunk is not too large in tile pixels (fits).
// Strokes that do not fit, or do not get room, are staged on the CPU as before.

import { DAB_CHUNK, DAB_STRIDE, type DabList } from '../../../shared/brush';

/** Page size in texels (RGBA32F: 16 MB a page). */
export const PAGE_W = 2048;
const PAGE_H = 512;
/** Space is given in units of 32 texels. */
const UNIT = 32;
const PAGE_UNITS = (PAGE_W * PAGE_H) / UNIT;
/** Texels per chunk: 64 dabs (x, y, r, a), then for a stroke that turns its tip 32 texels of (cos, sin) pairs. */
const PLAIN = DAB_CHUNK;
const TURNED = DAB_CHUNK + DAB_CHUNK / 2;
/**
 * The largest chunk (its box, in tile px) the GPU transforms: float32 keeps a dab within about
 * 1e-7 of this (0.01 px), as the CPU's double precision does. Larger chunks go on the CPU.
 */
export const GPU_CHUNK_PX = 1e5;
/** An entry used within this long (ms) keeps its room. */
const KEEP_MS = 2000;

export interface StoreEntry {
  page: number;
  /** First unit, units. */
  start: number;
  units: number;
  /** The stroke turns its tip (not round, or not a circle): its chunks carry cos and sin. */
  turned: boolean;
  /** Per chunk: the sum of r² (world units), for the fill estimate. */
  r2: Float32Array;
  /** The largest chunk box side (world units). */
  extent: number;
  /** When it was last used (performance.now). */
  used: number;
  /** Evicted: its room is someone else's now. */
  dead?: boolean;
}

export class DabStore {
  readonly pages: WebGLTexture[] = [];
  private free: [number, number][][] = [];
  private byList = new WeakMap<DabList, StoreEntry>();
  /** Every entry, least recently used first. An entry whose list is gone stays until evicted. */
  private lru = new Set<StoreEntry>();

  uploadedBytes = 0;

  constructor(
    private gl: WebGL2RenderingContext,
    readonly maxPages: number,
  ) {}

  /** Texel of chunk `c` of an entry, and its texel stride. */
  static chunkTexel(e: StoreEntry, c: number): number {
    return e.start * UNIT + c * (e.turned ? TURNED : PLAIN);
  }

  /** The largest chunk box side of a list (world units). */
  static extent(list: DabList): number {
    const ch = list.chunks;
    let m = 0;
    for (let o = 0; o < ch.length; o += 4) m = Math.max(m, ch[o + 2] - ch[o], ch[o + 3] - ch[o + 1]);
    return m;
  }

  /** The list's entry, uploaded now if it was not; null: no room (or nothing to upload). */
  get(list: DabList, turned: boolean): StoreEntry | null {
    let e = this.byList.get(list);
    if (e?.dead) e = undefined;
    if (e && e.turned === turned) {
      this.lru.delete(e);
      this.lru.add(e);
      e.used = performance.now();
      return e;
    }
    if (e) this.drop(e);
    if (!list.count) return null;
    const nc = Math.ceil(list.count / DAB_CHUNK);
    const units = Math.ceil((nc * (turned ? TURNED : PLAIN)) / UNIT);
    if (units > PAGE_UNITS) return null;
    const at = this.alloc(units);
    if (!at) return null;
    e = { page: at[0], start: at[1], units, turned, r2: new Float32Array(nc), extent: DabStore.extent(list), used: performance.now() };
    this.upload(e, list);
    this.byList.set(list, e);
    this.lru.add(e);
    return e;
  }

  /** Forgets every entry (the textures stay). */
  clear(): void {
    this.byList = new WeakMap();
    this.lru.clear();
    this.free = this.pages.map(() => [[0, PAGE_UNITS]]);
  }

  destroy(): void {
    for (const t of this.pages) this.gl.deleteTexture(t);
    this.pages.length = 0;
    this.free = [];
    this.byList = new WeakMap();
    this.lru.clear();
  }

  /** Bytes the pages take. */
  get bytes(): number {
    return this.pages.length * PAGE_W * PAGE_H * 16;
  }

  private drop(e: StoreEntry): void {
    e.dead = true;
    this.lru.delete(e);
    const fl = this.free[e.page];
    // Back into the sorted free list, joined with its neighbors.
    let i = 0;
    while (i < fl.length && fl[i][0] < e.start) i++;
    fl.splice(i, 0, [e.start, e.units]);
    if (i + 1 < fl.length && fl[i][0] + fl[i][1] === fl[i + 1][0]) {
      fl[i][1] += fl[i + 1][1];
      fl.splice(i + 1, 1);
    }
    if (i > 0 && fl[i - 1][0] + fl[i - 1][1] === fl[i][0]) {
      fl[i - 1][1] += fl[i][1];
      fl.splice(i, 1);
    }
  }

  /** First fit in the pages there are, then a new page, then room from the least recently used. */
  private alloc(units: number): [number, number] | null {
    const fit = (): [number, number] | null => {
      for (let p = 0; p < this.free.length; p++) {
        const fl = this.free[p];
        for (let i = 0; i < fl.length; i++) {
          if (fl[i][1] < units) continue;
          const start = fl[i][0];
          fl[i][0] += units;
          fl[i][1] -= units;
          if (!fl[i][1]) fl.splice(i, 1);
          return [p, start];
        }
      }
      return null;
    };
    let at = fit();
    if (at) return at;
    if (this.pages.length < this.maxPages) {
      this.addPage();
      return fit();
    }
    // Only entries unused for KEEP_MS make room: strokes the view (or an export) keeps using stay,
    // and the ones that do not fit go on the CPU, as all strokes did before. Evicting those
    // instead uploaded the same strokes again tile after tile: a store too small for a canvas
    // took more than twice as long as the CPU.
    const old = performance.now() - KEEP_MS;
    for (const e of this.lru) {
      if (e.used > old) break; // the rest were used later
      this.drop(e);
      if ((at = fit())) return at;
    }
    return null;
  }

  private addPage(): void {
    const gl = this.gl;
    const t = gl.createTexture()!;
    this.bind(this.pages.length, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, PAGE_W, PAGE_H);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.activeTexture(gl.TEXTURE0);
    this.pages.push(t);
    this.free.push([[0, PAGE_UNITS]]);
  }

  /**
   * Binds page `p` on the unit the dab program reads it from (glRenderer drawChunks: unit 3 + p),
   * so an upload changes no other unit's texture. The caller sets unit 0 active again after.
   */
  private bind(p: number, t: WebGLTexture): void {
    this.gl.activeTexture(this.gl.TEXTURE3 + p);
    this.gl.bindTexture(this.gl.TEXTURE_2D, t);
  }

  /** The entry's texels: per chunk, its dabs relative to the center of its box (and cos, sin). */
  private upload(e: StoreEntry, list: DabList): void {
    const { dabs, chunks, count } = list;
    const texels = e.units * UNIT;
    const f = new Float32Array(texels * 4);
    const nc = e.r2.length;
    for (let c = 0; c < nc; c++) {
      const ox = (chunks[c * 4] + chunks[c * 4 + 2]) / 2, oy = (chunks[c * 4 + 1] + chunks[c * 4 + 3]) / 2;
      const t0 = DabStore.chunkTexel(e, c) - e.start * UNIT;
      const end = Math.min(count, (c + 1) * DAB_CHUNK);
      let r2 = 0;
      for (let i = c * DAB_CHUNK, k = 0; i < end; i++, k++) {
        const s = i * DAB_STRIDE, o = (t0 + k) * 4;
        const r = dabs[s + 2];
        f[o] = dabs[s] - ox;
        f[o + 1] = dabs[s + 1] - oy;
        f[o + 2] = r;
        f[o + 3] = dabs[s + 3];
        r2 += r * r;
        if (e.turned) {
          // Double precision cos and sin (see putDab): two dabs a texel.
          const q = (t0 + PLAIN) * 4 + k * 2, rot = dabs[s + 4];
          f[q] = Math.cos(rot);
          f[q + 1] = Math.sin(rot);
        }
      }
      e.r2[c] = r2;
    }
    // Into the page, row by row segments.
    const gl = this.gl;
    this.bind(e.page, this.pages[e.page]);
    let t = e.start * UNIT, done = 0;
    while (done < texels) {
      const x = t % PAGE_W, y = Math.floor(t / PAGE_W);
      if (x === 0 && texels - done >= PAGE_W) {
        const rows = Math.floor((texels - done) / PAGE_W);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y, PAGE_W, rows, gl.RGBA, gl.FLOAT, f, done * 4);
        done += rows * PAGE_W;
        t += rows * PAGE_W;
        continue;
      }
      const n = Math.min(PAGE_W - x, texels - done);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, n, 1, gl.RGBA, gl.FLOAT, f, done * 4);
      done += n;
      t += n;
    }
    gl.activeTexture(gl.TEXTURE0);
    this.uploadedBytes += texels * 16;
  }
}
