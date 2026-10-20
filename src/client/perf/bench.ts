// The profiler's benchmark (Settings → Performance profiler): drives the open canvas through set
// steps with the profiler on, and times each one: a cold view of the whole drawing (as a fresh
// load), zooms in, a pan and a fast zoom out as fingers make them, a cold close view, and an
// export. Each step: when the view first showed (its tiles done), when it was complete, and when
// its exact tiles showed (glRenderer EXACT_TAG).

import { profiler, type StepRec } from './profiler';
import type { Engine } from '../engine/engine';
import type { GLRenderer } from '../engine/gl/glRenderer';

/** The longest a step waits for its view (ms). */
const STEP_LIMIT = 60_000;

const frame = () => new Promise<number>((r) => requestAnimationFrame(r));

export async function runBenchmark(engine: Engine, onStatus: (s: string) => void): Promise<void> {
  const comp = engine.comp as unknown as GLRenderer;
  if (engine.comp.kind !== 'webgl2') throw new Error('The benchmark needs the WebGL 2 renderer');
  const b = engine.contentBounds();
  if (!b) throw new Error('The canvas is empty');
  const { w: W, h: H } = (engine.comp as unknown as { size: { w: number; h: number } }).size;
  const start = { ...comp.view };
  const fit = Math.min(W / (b.x1 - b.x0), H / (b.y1 - b.y0)) * 0.95;
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
  const at = (zoom: number, px = cx, py = cy) => engine.setView(px - W / 2 / zoom, py - H / 2 / zoom, zoom);
  const doc = engine.snapshot();

  if (!profiler.on) profiler.start();
  profiler.env = {
    ...profiler.env,
    userAgent: navigator.userAgent,
    devicePixelRatio: devicePixelRatio,
    screen: [screen.width, screen.height],
    cores: navigator.hardwareConcurrency,
    memoryGB: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
    renderer: comp.profInfo(),
    canvas: {
      layers: doc.layers.filter((l) => !l.deleted).length,
      strokes: doc.strokes.filter((s) => !s.deleted).length,
      shapes: doc.shapes.filter((s) => !s.deleted).length,
      points: doc.strokes.reduce((n, s) => n + (s.deleted ? 0 : s.pts.length / 3), 0),
      mix: doc.mix,
      kaleidoscopes: doc.layers.filter((l) => !l.deleted && l.effects?.some((e) => e.type === 'kaleidoscope' && e.enabled)).length,
      effects: doc.layers.filter((l) => !l.deleted && l.effects?.some((e) => e.type !== 'kaleidoscope' && e.enabled)).length,
      bounds: [b.x0, b.y0, b.x1, b.y1].map(Math.round),
    },
  };

  /** One step: `go` changes the view; then the times until it shows, is complete, is exact. */
  const step = async (name: string, go: () => void | Promise<void>, cold = false) => {
    onStatus(`${name}…`);
    profiler.phase = `step: ${name}`;
    profiler.event('step', name);
    if (cold) comp.profDropCaches();
    const t0 = performance.now();
    await go();
    const rec: StepRec = { name, t0: Math.round(profiler.now()), t1: 0 };
    // The view's state counts only from a frame rendered after the change.
    const from = comp.profState().frame;
    let quiet = 0, lastFrame = from, lastNew = performance.now();
    while (performance.now() - t0 < STEP_LIMIT) {
      await frame();
      const s = comp.profState();
      const t = performance.now() - t0;
      if (s.frame !== lastFrame) {
        lastFrame = s.frame;
        lastNew = performance.now();
      } else if (performance.now() - lastNew > 5000 && s.pending) throw new Error('the view stopped rendering (is the app in the background?)');
      if (s.frame <= from) continue;
      if (rec.viewMs === undefined && !s.viewPending) rec.viewMs = Math.round(t);
      if (rec.doneMs === undefined) {
        if (!s.pending) quiet++;
        else quiet = 0;
        if (quiet >= 3) rec.doneMs = Math.round(t);
      }
      if (rec.exactMs === undefined && s.exact) rec.exactMs = Math.round(t);
      // Complete, and exact (or exact never comes: at most 3 s after complete).
      if (rec.doneMs !== undefined && (rec.exactMs !== undefined || t - rec.doneMs > 3000)) break;
    }
    if (rec.doneMs === undefined) rec.note = `not complete after ${STEP_LIMIT / 1000} s`;
    rec.t1 = Math.round(profiler.now());
    profiler.step(rec);
  };

  /** A gesture: `n` frames, the view moved by `f(i)` each frame. */
  const gesture = async (n: number, f: (i: number) => void) => {
    for (let i = 1; i <= n; i++) {
      f(i);
      await frame();
    }
  };

  try {
    await step('whole drawing, cold', () => at(fit), true);
    await step('zoom 2×', () => at(fit * 2));
    await step('zoom 4×', () => at(fit * 4));
    await step('zoom 8×', () => at(fit * 8));
    await step('pan at 4× (60 frames)', async () => {
      at(fit * 4);
      await gesture(60, (i) => at(fit * 4, cx + ((i / 60) * W) / (fit * 4), cy));
    });
    await step('zoom out to the whole drawing (30 frames)', async () => {
      await gesture(30, (i) => at(fit * 4 * Math.pow(1 / 4, i / 30)));
    });
    await step('zoom 4×, cold', () => at(fit * 4), true);
    // The export: the whole drawing 2048 px wide, as the image export renders it.
    onStatus('export 2048 px…');
    profiler.phase = 'step: export';
    profiler.event('step', 'export 2048 px');
    const t0 = performance.now();
    const { RegionRenderer } = await import('../export/region');
    const rr = new RegionRenderer(doc.layers, doc.strokes, doc.seq, doc.shapes, false, doc.paper, doc.mix);
    try {
      const s = 2048 / (b.x1 - b.x0), w = 2048, h = Math.max(1, Math.round((b.y1 - b.y0) * s));
      for (let y = 0; y < h; y += 2048) for (let x = 0; x < w; x += 2048) await rr.renderAsync(b.x0 + x / s, b.y0 + y / s, s, Math.min(2048, w - x), Math.min(2048, h - y));
    } finally {
      rr.destroy();
    }
    profiler.step({ name: 'export 2048 px', t0: Math.round(profiler.now() - (performance.now() - t0)), t1: Math.round(profiler.now()), doneMs: Math.round(performance.now() - t0) });
  } finally {
    profiler.phase = 'idle';
    engine.setView(start.x, start.y, start.zoom);
    onStatus('done');
  }
}
