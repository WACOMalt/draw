// Dev page (dev/render-test.html, served by `vite`): renders .bdraw files as the image export
// does, and checks the result. Drive it from the console through `window.rt`:
//
//   const d = await rt.load('/dev/files/x.bdraw')
//   const b = rt.bounds(d)                                   // what the drawing covers, copies too
//   const a = await rt.exportRender(d, b, 2048)              // as the export: pieces, timed
//   const r = await rt.exportRender(rt.expand(d), b, 2048)   // reference: kaleidoscopes as strokes
//   rt.compare(r.canvas, a.canvas)                           // areas the export misses
//
// The reference turns every kaleidoscope copy into transformed strokes (in an isolated group,
// with the layer's blend and opacity), so it needs no frames: what the export leaves out shows
// as missing coverage. Colors can differ a little (brush dabs scale instead of pixels).

import { RegionRenderer, PIECE } from '../export/region';
import { kaleidoscopeStep, transformLayerLengths } from '../../shared/effects';
import { compose, transformStroke } from '../../shared/layers';
import { LIMITS, type Affine, type Layer, type MixMode, type Paper, type Shape, type Stroke } from '../../shared/types';
import { GLRenderer } from '../engine/gl/glRenderer';
import { FULL_PROFILE, type PerfProfile } from '../engine/perf';

interface Doc {
  layers: Layer[];
  strokes: Stroke[];
  shapes: Shape[];
  paper?: Paper;
  mix?: MixMode;
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

// A hidden page gets no animation frames (the renderer runs on them): timers stand in for them.
if (document.visibilityState === 'hidden') {
  window.requestAnimationFrame = (cb) => window.setTimeout(() => cb(performance.now()), 16);
  window.cancelAnimationFrame = (id) => window.clearTimeout(id);
}

const ID: Affine = [1, 0, 0, 1, 0, 0];
const out = document.getElementById('out')!;

async function load(url: string): Promise<Doc> {
  const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const gz = buf[0] === 0x1f && buf[1] === 0x8b;
  const text = gz ? await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).text() : new TextDecoder().decode(buf);
  const f = JSON.parse(text);
  return { layers: f.layers, strokes: f.strokes, shapes: f.shapes ?? [], paper: f.paper, mix: f.mix };
}

/** The kaleidoscope copies of a layer: their transforms, copy 1 first. */
function steps(l: Layer): Affine[] {
  const e = l.effects?.find((x) => x.type === 'kaleidoscope' && x.enabled && (x.count ?? 0) >= 1);
  if (!e) return [];
  const step = kaleidoscopeStep(e);
  const list: Affine[] = [];
  let m = ID;
  for (let i = 0; i < Math.min(LIMITS.maxKaleidoscope, e.count ?? 0); i++) list.push((m = compose(step, m)));
  return list;
}

/** The document with every kaleidoscope copy made of strokes (see the top). */
function expand(d: Doc): Doc {
  if (d.shapes.length) console.warn('shapes are not expanded');
  const kids = new Map<string | undefined, Layer[]>();
  for (const l of d.layers) {
    if (l.deleted) continue;
    const list = kids.get(l.parent ?? undefined) ?? [];
    list.push(l);
    kids.set(l.parent ?? undefined, list);
  }
  for (const list of kids.values()) list.sort((a, b) => a.order - b.order);
  const byLayer = new Map<string, Stroke[]>();
  for (const s of d.strokes) {
    const list = byLayer.get(s.layerId) ?? [];
    list.push(s);
    byLayer.set(s.layerId, list);
  }
  const layers: Layer[] = [];
  const strokes: Stroke[] = [];
  const range: [number, number] = [LIMITS.minBrushWorld, LIMITS.maxBrushWorld];
  const noKal = (l: Layer) => l.effects?.filter((e) => e.type !== 'kaleidoscope');
  // One instance of `l` (and what it holds) moved by M, as a child of `parent` at `order`.
  const instance = (l: Layer, M: Affine, id: string, parent: string | undefined, order: number, plain: boolean) => {
    const fx = noKal(l);
    const base = { ...l, id, order, parent, effects: fx?.length ? fx : undefined } as Layer;
    if (!parent) delete base.parent;
    const copy = transformLayerLengths(base, M);
    if (plain) Object.assign(copy, { blend: l.kind === 'group' ? 'pass' : 'normal', opacity: 1, clip: false });
    layers.push(copy);
    for (const s of byLayer.get(l.id) ?? []) {
      const t = transformStroke(s, M, LIMITS.maxCoord, range);
      if (t) strokes.push({ ...s, ...t, id: `${s.id}${id.slice(l.id.length)}`, layerId: id });
    }
    children(l.id, id, M);
  };
  // The children of `from`, moved by M, under `to`.
  const children = (from: string | undefined, to: string | undefined, M: Affine) => {
    let order = 0;
    for (const l of kids.get(from) ?? []) {
      const id = to === from ? l.id : `${l.id}${to!.slice(from!.length)}`;
      const s = steps(l);
      if (!s.length) {
        instance(l, M, id, to, ++order, false);
        continue;
      }
      // The layer and its copies, in an isolated group with its blend and opacity.
      const g = `${id}~K`;
      layers.push({ id: g, name: `${l.name} (kaleidoscope)`, kind: 'group', order: ++order, blend: l.blend === 'pass' ? 'normal' : l.blend, opacity: l.opacity, visible: l.visible, ...(to ? { parent: to } : {}) } as Layer);
      const e = l.effects!.find((x) => x.type === 'kaleidoscope')!;
      const list = [{ k: 0, m: ID }, ...s.map((m, i) => ({ k: i + 1, m }))];
      // Bottom first: behind puts copy 1 nearest the layer, the last copy at the bottom.
      if (e.order === 'behind') list.reverse();
      list.forEach(({ k, m }, j) => instance(l, compose(M, m), `${id}~${k}`, g, j + 1, true));
    }
  };
  children(undefined, undefined, ID);
  strokes.sort((a, b) => a.seq - b.seq);
  return { ...d, layers, strokes };
}

/** World bounds of the strokes (with their brush), of visible layers. */
function bounds(d: Doc): Box {
  const e = expand(d);
  const vis = new Set(e.layers.filter((l) => l.visible).map((l) => l.id));
  let b: Box | null = null;
  for (const s of e.strokes) {
    if (!vis.has(s.layerId) || s.mask) continue;
    const r = s.brush.size / 2;
    for (let i = 0; i < s.pts.length; i += 3) {
      const x = s.pts[i], y = s.pts[i + 1];
      b = b ? { x0: Math.min(b.x0, x - r), y0: Math.min(b.y0, y - r), x1: Math.max(b.x1, x + r), y1: Math.max(b.y1, y + r) } : { x0: x - r, y0: y - r, x1: x + r, y1: y + r };
    }
  }
  return b!;
}

/**
 * Renders `b` at `width` px wide as the export does: pieces PIECE wide and `pieceH` high (the PNG
 * export uses 256-row strips, the TIFF export PIECE). Transparent. Returns the image and times.
 */
let verbose = false;
async function exportRender(d: Doc, b: Box, width: number, pieceH = 256, label = '', pieceW = PIECE): Promise<{ canvas: HTMLCanvasElement; ms: number; pieces: number; worst: number }> {
  const scale = width / (b.x1 - b.x0);
  const height = Math.max(1, Math.round((b.y1 - b.y0) * scale));
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d')!;
  const rr = new RegionRenderer(d.layers, d.strokes, 0, d.shapes, true, d.paper, d.mix ?? 'normal');
  const t0 = performance.now();
  let pieces = 0, worst = 0;
  try {
    for (let y = 0; y < height; y += pieceH)
      for (let x = 0; x < width; x += pieceW) {
        const w = Math.min(pieceW, width - x), h = Math.min(pieceH, height - y);
        const t = performance.now();
        const px = rr.render(b.x0 + x / scale, b.y0 + y / scale, scale, w, h);
        worst = Math.max(worst, performance.now() - t);
        const dbg = (rr as unknown as { r: { dbg?: object } }).r.dbg;
        if (dbg && verbose) console.log(`piece ${x},${y}`, (performance.now() - t).toFixed(0), JSON.stringify(dbg));
        if (dbg) for (const k of Object.keys(dbg)) (dbg as Record<string, number>)[k] = 0;
        ctx.putImageData(new ImageData(px, w, h), x, y);
        pieces++;
        await new Promise((r) => setTimeout(r, 0));
      }
  } finally {
    rr.destroy();
  }
  const ms = performance.now() - t0;
  show(c, `${label} export ${width}×${height}, ${pieces} pieces of ≤${pieceW}×${pieceH}: ${(ms / 1000).toFixed(1)} s (worst piece ${worst.toFixed(0)} ms)`);
  return { canvas: c, ms, pieces, worst };
}

/**
 * As the screen draws it: an on-screen renderer (not offline: frame budgets, prefetch, coarser
 * levels) of w × h px showing world (x, y) at `zoom`, left to run on animation frames as on
 * screen until it has no work left (or `maxMs`). `main`: an older renderer, for comparison
 * (glRendererMain.ts, when present: see below).
 */
async function viewport(d: Doc, x: number, y: number, zoom: number, w: number, h: number, opts: { profile?: PerfProfile; label?: string; main?: boolean; maxMs?: number } = {}): Promise<{ canvas: HTMLCanvasElement; ms: number; frame: number; frames: number; settled: boolean }> {
  const { profile = FULL_PROFILE, label = '', main = false, maxMs = 60000 } = opts;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const gl = c.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: true })!;
  // An older renderer to compare with: copy one (git show <ref>:src/client/engine/gl/glRenderer.ts)
  // to glRendererMain.ts and rename its class GLRendererMain. Not kept in the repository.
  const older = import.meta.glob<{ GLRendererMain: typeof GLRenderer }>('../engine/gl/glRendererMain.ts');
  const load = Object.values(older)[0];
  if (main && !load) throw new Error('no glRendererMain.ts to compare with');
  const Main = main ? (await load()).GLRendererMain : null;
  const r = new (Main ?? GLRenderer)(c, gl, false, profile) as GLRenderer;
  const ri = r as unknown as { lastPending: boolean; raf: number; frame: number };
  r.transparent = true;
  r.setMix(d.mix ?? 'normal');
  r.setLayers(d.layers);
  r.resetStrokes(d.strokes, 0);
  r.resetShapes(d.shapes);
  r.resize(w, h, 1);
  r.setView(x, y, zoom);
  const t0 = performance.now();
  // The renderer runs itself (requestAnimationFrame) while it has work: wait until it stops.
  let settled = false;
  const one = new Uint8Array(4);
  while (performance.now() - t0 < maxMs) {
    await new Promise((res) => requestAnimationFrame(res));
    // Wait for the GPU (a screen's frames cannot run ahead of it either).
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, one);
    if (!ri.raf && !ri.lastPending) {
      settled = true;
      break;
    }
  }
  const ms = performance.now() - t0;
  const frames = ri.frame;
  // One more frame, with every tile in: what a frame costs once the view is still.
  const dbg = (r as unknown as { dbg?: Record<string, unknown> }).dbg;
  if (dbg) for (const k of Object.keys(dbg)) dbg[k] = Array.isArray(dbg[k]) ? [] : 0;
  const t1 = performance.now();
  r.renderNow();
  const px = r.readRGBA(true)!;
  const frame = performance.now() - t1;
  if (dbg) console.log(`${label} last frame`, JSON.stringify({ ...dbg, hist: undefined }));
  r.destroy();
  const img = document.createElement('canvas');
  img.width = w;
  img.height = h;
  img.getContext('2d')!.putImageData(new ImageData(px, w, h), 0, 0);
  show(img, `${label}${main ? ' (main)' : ''} viewport ${w}×${h} at zoom ${zoom} (${profile.name}): ${settled ? '' : 'NOT '}settled after ${(ms / 1000).toFixed(1)} s (${frames} frames), then ${frame.toFixed(0)} ms a frame`);
  return { canvas: img, ms, frame, frames, settled };
}

/**
 * Coverage of `test` against `ref` (same size), in cells of `cell` px (the most alpha in a cell):
 * missing where the reference covers a cell (alpha ≥ 64) and the test does not (< 16), extra the
 * other way. A diff image shows missing cells red and extra ones blue over the reference.
 */
function compare(ref: HTMLCanvasElement, test: HTMLCanvasElement, cell = 4, label = ''): { missing: number; extra: number; covered: number } {
  const w = ref.width, h = ref.height;
  if (test.width !== w || test.height !== h) throw new Error('sizes differ');
  const a = ref.getContext('2d')!.getImageData(0, 0, w, h).data;
  const b = test.getContext('2d')!.getImageData(0, 0, w, h).data;
  const cw = Math.ceil(w / cell), ch = Math.ceil(h / cell);
  const ma = new Uint8Array(cw * ch), mb = new Uint8Array(cw * ch);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4 + 3, c = Math.floor(y / cell) * cw + Math.floor(x / cell);
      if (a[i] > ma[c]) ma[c] = a[i];
      if (b[i] > mb[c]) mb[c] = b[i];
    }
  const diff = document.createElement('canvas');
  diff.width = cw;
  diff.height = ch;
  const dctx = diff.getContext('2d')!;
  const img = dctx.createImageData(cw, ch);
  let covered = 0, missing = 0, extra = 0;
  for (let c = 0; c < cw * ch; c++) {
    const o = c * 4;
    const ref1 = ma[c] >= 64, test1 = mb[c] >= 16;
    if (ref1) covered++;
    if (ref1 && !test1) {
      missing++;
      img.data.set([255, 40, 40, 255], o);
    } else if (mb[c] >= 64 && ma[c] < 16) {
      extra++;
      img.data.set([60, 120, 255, 255], o);
    } else img.data.set([ma[c] >> 1, ma[c] >> 1, ma[c] >> 1, 255], o);
  }
  dctx.putImageData(img, 0, 0);
  const r = { missing: covered ? missing / covered : 0, extra: covered ? extra / covered : 0, covered };
  show(diff, `${label} diff (red: missing ${(r.missing * 100).toFixed(2)}%, blue: extra ${(r.extra * 100).toFixed(2)}%)`);
  return r;
}

/**
 * Largest and mean color difference (0..255, premultiplied by alpha) between two images of the
 * same size, and the share of pixels that differ by more than `tol`: piece seams and the like.
 */
function pixelDiff(a: HTMLCanvasElement, b: HTMLCanvasElement, tol = 24, label = ''): { max: number; mean: number; over: number } {
  const w = a.width, h = a.height;
  const p = a.getContext('2d')!.getImageData(0, 0, w, h).data, q = b.getContext('2d')!.getImageData(0, 0, w, h).data;
  const diff = document.createElement('canvas');
  diff.width = w;
  diff.height = h;
  const img = diff.getContext('2d')!.createImageData(w, h);
  let max = 0, sum = 0, over = 0;
  for (let i = 0; i < p.length; i += 4) {
    let m = 0;
    for (let c = 0; c < 4; c++) {
      const x = c < 3 ? (p[i + c] * p[i + 3]) / 255 : p[i + 3], y = c < 3 ? (q[i + c] * q[i + 3]) / 255 : q[i + 3];
      m = Math.max(m, Math.abs(x - y));
    }
    max = Math.max(max, m);
    sum += m;
    if (m > tol) over++;
    const v = Math.min(255, m * 4);
    img.data.set([v, m > tol ? 0 : v, m > tol ? 0 : v, 255], i);
  }
  diff.getContext('2d')!.putImageData(img, 0, 0);
  const r = { max: Math.round(max), mean: +(sum / (w * h)).toFixed(3), over: +((over / (w * h)) * 100).toFixed(3) };
  show(diff, `${label} pixel diff ×4 (red: > ${tol}): max ${r.max}, mean ${r.mean}, over ${r.over}%`);
  return r;
}

/**
 * The checks of the render test, on .bdraw files in /dev/files: for each, the whole drawing in one
 * piece against small pieces (seams), and for drawings with kaleidoscopes, the export against the
 * reference (copies as strokes: missing coverage), whole and in crops at three zoom levels. Also
 * each kaleidoscope file with all its layer effects turned on (`+fx`). Results as table rows.
 */
async function suite(files: string[], width = 1024): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  const docs: [string, Doc][] = [];
  for (const f of files) {
    const d = await load(`/dev/files/${f}.bdraw`);
    docs.push([f, d]);
    if (d.layers.some((l) => steps(l).length) && d.layers.some((l) => l.effects?.some((e) => e.type !== 'kaleidoscope'))) {
      const fx = structuredClone(d);
      for (const l of fx.layers) for (const e of l.effects ?? []) e.enabled = true;
      docs.push([`${f}+fx`, fx]);
    }
  }
  for (const [f, d] of docs) {
    clear();
    const b = bounds(d);
    const whole = await exportRender(d, b, width, PIECE, `${f} whole`);
    const parts = await exportRender(d, b, width, 256, `${f} pieces`, 256);
    const seam = pixelDiff(whole.canvas, parts.canvas, 24, `${f} seams`);
    rows.push({ file: f, test: 'seams', ms: Math.round(whole.ms), seamMax: seam.max, seamOver: seam.over });
    if (!d.layers.some((l) => steps(l).length)) continue;
    const e = expand(d);
    const W = b.x1 - b.x0, H = b.y1 - b.y0;
    const boxes: [string, Box][] = [['whole', b]];
    for (const [fx, fy] of [[0.12, 0.62], [0.5, 0.5], [0.8, 0.3]])
      for (const k of [0.2, 0.04, 0.008]) {
        const cx = b.x0 + fx * W, cy = b.y0 + fy * H, r = (Math.max(W, H) * k) / 2;
        boxes.push([`crop ${fx},${fy} ×${Math.round(1 / k)}`, { x0: cx - r, y0: cy - r, x1: cx + r, y1: cy + r }]);
      }
    for (const [name, box] of boxes) {
      const a = await exportRender(d, box, width, PIECE, `${f} ${name}`);
      const r = await exportRender(e, box, width, PIECE, `${f} ${name} ref`);
      const c = compare(r.canvas, a.canvas, 8, `${f} ${name}`);
      rows.push({ file: f, test: name, ms: Math.round(a.ms), covered: c.covered, missing: +(c.missing * 100).toFixed(2), extra: +(c.extra * 100).toFixed(2) });
    }
  }
  console.table(rows);
  return rows;
}

/**
 * The real export (exportImage, adaptive pieces, the PNG or TIFF writer) into memory, timed, with
 * its progress and status events; a PNG is decoded back into a canvas. `lose`: the first `lose`
 * pieces of more than 256 px act as if the GPU reset (a lost context), to try the splitting.
 */
async function exportFile(d: Doc, b: Box, width: number, format: 'png' | 'tiff' = 'png', lose = 0): Promise<{ ms: number; bytes: number; events: string[]; canvas: HTMLCanvasElement | null }> {
  const { exportImage } = await import('../export/exportImage');
  const chunks: Uint8Array[] = [];
  let size = 0;
  const sink = {
    name: 'test',
    get size() {
      return size;
    },
    async write(data: Uint8Array) {
      chunks.push(data.slice());
      size += data.length;
    },
    async patch(position: number, data: Uint8Array) {
      // Rare (headers): rewrite in place across the chunks.
      let o = 0;
      for (const c of chunks) {
        for (let i = 0; i < data.length; i++) {
          const k = position + i - o;
          if (k >= 0 && k < c.length) c[k] = data[i];
        }
        o += c.length;
      }
    },
    async close() {},
    async abort() {},
  };
  const height = Math.max(1, Math.round(((b.y1 - b.y0) * width) / (b.x1 - b.x0)));
  const events: string[] = [];
  const proto = RegionRenderer.prototype as unknown as { renderAsync: (...a: unknown[]) => Promise<unknown> };
  const real = proto.renderAsync;
  let lost = 0;
  if (lose)
    proto.renderAsync = function (this: unknown, ...a: unknown[]) {
      if (lost < lose && ((a[3] as number) > 256 || (a[4] as number) > 256)) {
        lost++;
        events.push(`lost context on a ${a[3]}×${a[4]} piece`);
        return Promise.reject(new Error('The graphics context was lost'));
      }
      return real.apply(this, a);
    };
  const t0 = performance.now();
  try {
    await exportImage({
      layers: d.layers, strokes: d.strokes, shapes: d.shapes, seq: 0, bounds: b, width, height, format,
      transparent: true, paper: d.paper ?? { color: '#ffffff', alpha: 1 }, mix: d.mix ?? 'normal', sink,
      onPrepare: () => events.push(`${(performance.now() - t0).toFixed(0)} ms: preparing`),
      onTiles: (n) => n % 50 === 0 && events.push(`${(performance.now() - t0).toFixed(0)} ms: ${n} tiles`),
      onProgress: (p, i, n) => events.push(`${(performance.now() - t0).toFixed(0)} ms: piece ${i} of about ${n} (${Math.round(p * 100)}%)`),
      signal: new AbortController().signal,
    });
  } finally {
    proto.renderAsync = real;
  }
  const ms = performance.now() - t0;
  let canvas: HTMLCanvasElement | null = null;
  if (format === 'png') {
    const bmp = await createImageBitmap(new Blob(chunks as BlobPart[], { type: 'image/png' }));
    canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    canvas.getContext('2d')!.drawImage(bmp, 0, 0);
    show(canvas, `exportImage ${format} ${width}×${height}: ${(ms / 1000).toFixed(1)} s, ${size} bytes`);
  }
  return { ms, bytes: size, events, canvas };
}

function show(c: HTMLCanvasElement, caption: string): void {
  const f = document.createElement('figure');
  const cap = document.createElement('figcaption');
  cap.textContent = caption;
  f.append(c, cap);
  out.prepend(f);
  console.log(caption);
}

function clear(): void {
  out.replaceChildren();
}

(window as unknown as { rt: unknown }).rt = { verbose: (v: boolean) => (verbose = v), suite, exportFile, pixelDiff, load, expand, bounds, exportRender, viewport, compare, clear, steps };
