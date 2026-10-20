// Performance profiler (Settings → Performance profiler). Off by default. When on, the renderer
// (glRenderer) reports into it: each frame's CPU time for tiles and compositing, GPU time where the
// browser can measure it (else a sampled GPU sync), draw calls, changes of target, uploads, tiles
// drawn and evicted, dab walks waited for; the slowest tiles; the cost of each layer in the
// composite; long tasks on the main thread; notable events. A benchmark (bench.ts) drives the open
// canvas through set steps. The report is JSON, with a plain-text summary of the worst costs first.

export interface FrameRec {
  /** ms since the profiler started; the renderer's frame number; who rendered ('view' or 'export'). */
  t: number;
  frame: number;
  src: 'view' | 'export';
  interval: number;
  tilesCpu: number;
  compCpu: number;
  gpuTiles?: number;
  gpuComp?: number;
  /** A sampled GPU sync (no timer queries): ms the CPU waited for the GPU to finish the frame. */
  gpuSync?: number;
  tileCalls: number;
  tilesDone: number;
  dabs: number;
  fill: number;
  budget: number;
  draws: number;
  binds: number;
  uploadKB: number;
  walkWaits: number;
  evicted: number;
  cacheTiles: number;
  moving: boolean;
  pending: boolean;
  viewPending: boolean;
  exact: boolean;
  w: number;
  h: number;
  zoom: number;
}

export interface TileRec {
  t: number;
  frame: number;
  layer: string;
  lod: number;
  strokes: number;
  dabs: number;
  ms: number;
  done: boolean;
}

interface LayerCost {
  name: string;
  cpuMs: number;
  gpuMs: number;
  frames: number;
  maxCpuMs: number;
  maxGpuMs: number;
  effects: string;
}

export interface StepRec {
  name: string;
  t0: number;
  t1: number;
  /** ms from the step's start until the view showed (its tiles done), was complete, showed its exact tiles. */
  viewMs?: number;
  doneMs?: number;
  exactMs?: number;
  note?: string;
}

const MAX_FRAMES = 60000;
const MAX_EVENTS = 4000;
const TOP_TILES = 60;

function emptyFrame(): FrameRec {
  return { t: 0, frame: 0, src: 'view', interval: 0, tilesCpu: 0, compCpu: 0, tileCalls: 0, tilesDone: 0, dabs: 0, fill: 0, budget: 0, draws: 0, binds: 0, uploadKB: 0, walkWaits: 0, evicted: 0, cacheTiles: 0, moving: false, pending: false, viewPending: false, exact: false, w: 0, h: 0, zoom: 1 };
}

const pct = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
};
const r1 = (v: number) => Math.round(v * 10) / 10;

class Profiler {
  on = false;
  private t0 = 0;
  frames: FrameRec[] = [];
  private byFrame = new Map<string, FrameRec>();
  /** Counters of the frame being rendered (the renderer adds to them). */
  cur: FrameRec = emptyFrame();
  tiles: TileRec[] = [];
  private tileByLayer = new Map<string, { ms: number; calls: number; dabs: number }>();
  private layers = new Map<string, LayerCost>();
  events: { t: number; kind: string; detail: string }[] = [];
  longTasks: { t: number; ms: number; phase: string }[] = [];
  steps: StepRec[] = [];
  /** What the main thread is doing (for long tasks): a renderer phase or a benchmark step. */
  phase = 'idle';
  env: Record<string, unknown> = {};
  private observer: PerformanceObserver | null = null;

  now(): number {
    return performance.now() - this.t0;
  }

  start(): void {
    this.frames = [];
    this.byFrame.clear();
    this.tiles = [];
    this.tileByLayer.clear();
    this.layers.clear();
    this.events = [];
    this.longTasks = [];
    this.steps = [];
    this.t0 = performance.now();
    this.cur = emptyFrame();
    this.on = true;
    try {
      this.observer = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) this.longTasks.push({ t: r1(e.startTime - this.t0), ms: r1(e.duration), phase: this.phase });
      });
      this.observer.observe({ type: 'longtask', buffered: false });
    } catch {
      this.observer = null;
      this.event('note', 'long tasks cannot be observed in this browser');
    }
    this.event('start', '');
  }

  stop(): void {
    this.on = false;
    this.observer?.disconnect();
    this.observer = null;
    this.event('stop', '');
  }

  event(kind: string, detail: string): void {
    if (!this.on && kind !== 'stop') return;
    if (this.events.length < MAX_EVENTS) this.events.push({ t: r1(this.now()), kind, detail });
  }

  /** A frame begins: its counters start at zero. */
  frameBegin(): void {
    this.cur = emptyFrame();
  }

  /** A frame ends: its record, with what the renderer says of it. */
  frameEnd(f: Partial<FrameRec> & { frame: number; src: 'view' | 'export' }, id: string): void {
    const rec: FrameRec = { ...this.cur, ...f, t: r1(this.now()) };
    for (const k of ['interval', 'tilesCpu', 'compCpu', 'fill', 'budget'] as const) rec[k] = r1(rec[k]);
    rec.uploadKB = Math.round(rec.uploadKB);
    if (this.frames.length >= MAX_FRAMES) this.frames.shift();
    this.frames.push(rec);
    this.byFrame.set(`${id}:${rec.frame}`, rec);
    if (this.byFrame.size > 400) this.byFrame.delete(this.byFrame.keys().next().value!);
    if (rec.interval > 250 && rec.src === 'view') this.event('long frame', `${Math.round(rec.interval)} ms (tiles ${Math.round(rec.tilesCpu)} ms, composite ${Math.round(rec.compCpu)} ms CPU)`);
  }

  /** GPU time of a frame's phase, when its timer query comes back (frames later). */
  gpu(id: string, frame: number, phase: 'tiles' | 'comp' | 'sync', ms: number): void {
    const rec = this.byFrame.get(`${id}:${frame}`);
    if (!rec) return;
    if (phase === 'tiles') rec.gpuTiles = r1((rec.gpuTiles ?? 0) + ms);
    else if (phase === 'comp') rec.gpuComp = r1((rec.gpuComp ?? 0) + ms);
    else rec.gpuSync = r1(ms);
  }

  tile(t: TileRec): void {
    t.ms = r1(t.ms);
    t.t = r1(t.t);
    const a = this.tileByLayer.get(t.layer) ?? { ms: 0, calls: 0, dabs: 0 };
    a.ms += t.ms;
    a.calls++;
    a.dabs += t.dabs;
    this.tileByLayer.set(t.layer, a);
    if (this.tiles.length < TOP_TILES) this.tiles.push(t);
    else {
      let min = 0;
      for (let i = 1; i < this.tiles.length; i++) if (this.tiles[i].ms < this.tiles[min].ms) min = i;
      if (t.ms > this.tiles[min].ms) this.tiles[min] = t;
    }
  }

  /** A top-level layer (or group) in the composite: its CPU time, and its GPU time (later). */
  layer(id: string, name: string, effects: string, cpuMs: number, gpuMs?: number): void {
    const c = this.layers.get(id) ?? { name, cpuMs: 0, gpuMs: 0, frames: 0, maxCpuMs: 0, maxGpuMs: 0, effects };
    if (cpuMs > 0 || gpuMs === undefined) {
      c.cpuMs += cpuMs;
      c.frames++;
      c.maxCpuMs = Math.max(c.maxCpuMs, cpuMs);
    }
    if (gpuMs !== undefined) {
      c.gpuMs += gpuMs;
      c.maxGpuMs = Math.max(c.maxGpuMs, gpuMs);
    }
    this.layers.set(id, c);
  }

  step(s: StepRec): void {
    this.steps.push(s);
  }

  report(): Record<string, unknown> {
    const view = this.frames.filter((f) => f.src === 'view');
    const iv = view.map((f) => f.interval).filter((v) => v > 0 && v < 5000);
    const sum = (fs: FrameRec[], k: keyof FrameRec) => r1(fs.reduce((n, f) => n + ((f[k] as number) ?? 0), 0));
    const layers = [...this.layers.entries()].map(([id, c]) => ({ id, ...c, cpuMs: r1(c.cpuMs), gpuMs: r1(c.gpuMs), maxCpuMs: r1(c.maxCpuMs), maxGpuMs: r1(c.maxGpuMs) })).sort((a, b) => b.cpuMs + b.gpuMs - (a.cpuMs + a.gpuMs));
    const tileLayers = [...this.tileByLayer.entries()].map(([layer, a]) => ({ layer, ms: r1(a.ms), calls: a.calls, dabs: a.dabs })).sort((a, b) => b.ms - a.ms);
    const totals = {
      frames: view.length,
      exportFrames: this.frames.length - view.length,
      intervalP50: r1(pct(iv, 0.5)),
      intervalP95: r1(pct(iv, 0.95)),
      intervalMax: r1(Math.max(0, ...iv)),
      framesOver50ms: iv.filter((v) => v > 50).length,
      framesOver250ms: iv.filter((v) => v > 250).length,
      tilesCpuMs: sum(this.frames, 'tilesCpu'),
      compCpuMs: sum(this.frames, 'compCpu'),
      gpuTilesMs: sum(this.frames, 'gpuTiles'),
      gpuCompMs: sum(this.frames, 'gpuComp'),
      gpuSyncSamples: this.frames.filter((f) => f.gpuSync !== undefined).length,
      gpuSyncP95: r1(pct(this.frames.filter((f) => f.gpuSync !== undefined).map((f) => f.gpuSync!), 0.95)),
      tileCalls: sum(this.frames, 'tileCalls'),
      dabsM: r1(sum(this.frames, 'dabs') / 1e6),
      draws: sum(this.frames, 'draws'),
      binds: sum(this.frames, 'binds'),
      uploadMB: r1(sum(this.frames, 'uploadKB') / 1024),
      walkWaits: sum(this.frames, 'walkWaits'),
      evicted: sum(this.frames, 'evicted'),
      longTasks: this.longTasks.length,
      longTaskMs: r1(this.longTasks.reduce((n, l) => n + l.ms, 0)),
    };
    // Each step's frames: their intervals and costs.
    const steps = this.steps.map((st) => {
      const fs = this.frames.filter((f) => f.t >= st.t0 && f.t <= st.t1);
      const vs = fs.filter((f) => f.src === 'view').map((f) => f.interval);
      return {
        ...st,
        frames: fs.length,
        intervalP50: r1(pct(vs, 0.5)),
        intervalP95: r1(pct(vs, 0.95)),
        intervalMax: r1(Math.max(0, ...vs)),
        tilesCpuMs: sum(fs, 'tilesCpu'),
        compCpuMs: sum(fs, 'compCpu'),
        gpuTilesMs: sum(fs, 'gpuTiles'),
        gpuCompMs: sum(fs, 'gpuComp'),
        tileCalls: sum(fs, 'tileCalls'),
        dabsM: r1(sum(fs, 'dabs') / 1e6),
        walkWaits: sum(fs, 'walkWaits'),
        evicted: sum(fs, 'evicted'),
      };
    });
    return {
      format: 'draw-profile',
      version: 1,
      savedAt: new Date().toISOString(),
      env: this.env,
      summary: this.summary(totals, layers, tileLayers),
      totals,
      steps,
      layers,
      tileLayers,
      slowTiles: [...this.tiles].sort((a, b) => b.ms - a.ms),
      longTasks: this.longTasks,
      events: this.events,
      frames: this.frames,
    };
  }

  /** The findings, worst first, in plain words. */
  private summary(t: Record<string, number>, layers: { name: string; cpuMs: number; gpuMs: number; maxCpuMs: number; effects: string }[], tileLayers: { layer: string; ms: number; calls: number }[]): string[] {
    const out: string[] = [];
    const steps = [...this.steps].filter((s) => s.doneMs !== undefined).sort((a, b) => (b.doneMs ?? 0) - (a.doneMs ?? 0));
    for (const s of steps.slice(0, 4)) out.push(`Step "${s.name}": view in ${Math.round(s.viewMs ?? 0)} ms, complete in ${Math.round(s.doneMs ?? 0)} ms${s.exactMs ? `, exact in ${Math.round(s.exactMs)} ms` : ''}${s.note ? ` (${s.note})` : ''}.`);
    const cpu = t.tilesCpuMs + t.compCpuMs, gpu = t.gpuTilesMs + t.gpuCompMs;
    if (gpu > 0) out.push(`GPU time: tiles ${Math.round(t.gpuTilesMs)} ms, compositing ${Math.round(t.gpuCompMs)} ms. CPU time: tiles ${Math.round(t.tilesCpuMs)} ms, compositing ${Math.round(t.compCpuMs)} ms.`);
    else out.push(`CPU time: tiles ${Math.round(t.tilesCpuMs)} ms, compositing ${Math.round(t.compCpuMs)} ms. No GPU timer on this device${t.gpuSyncSamples ? `: sampled GPU waits p95 ${t.gpuSyncP95} ms` : ''}.`);
    if (cpu > 0 && t.longTaskMs > cpu * 0.5) out.push(`Long tasks: ${t.longTasks} (${Math.round(t.longTaskMs)} ms): the main thread was blocked outside the frame work too.`);
    out.push(`Frames: p50 ${t.intervalP50} ms, p95 ${t.intervalP95} ms, worst ${t.intervalMax} ms; ${t.framesOver250ms} over 250 ms.`);
    for (const l of layers.slice(0, 3)) if (l.cpuMs + l.gpuMs > 50) out.push(`Costliest layer in the composite: "${l.name}"${l.effects ? ` [${l.effects}]` : ''}: ${Math.round(l.cpuMs)} ms CPU, ${Math.round(l.gpuMs)} ms GPU (worst frame ${Math.round(l.maxCpuMs)} ms CPU).`);
    for (const l of tileLayers.slice(0, 3)) if (l.ms > 50) out.push(`Costliest tiles: layer ${l.layer}: ${Math.round(l.ms)} ms over ${l.calls} tile renders.`);
    if (t.walkWaits > 0) out.push(`Tiles waited for dab walks ${t.walkWaits} times.`);
    if (t.evicted > 500) out.push(`The tile cache evicted ${t.evicted} tiles: GPU memory is short for this canvas at these views.`);
    if (t.binds > 50000) out.push(`Changes of render target: ${t.binds}. Each one costs on a phone's GPU.`);
    for (const e of this.events.filter((e) => e.kind === 'context lost' || e.kind === 'error').slice(0, 3)) out.push(`Event: ${e.kind} at ${Math.round(e.t)} ms ${e.detail}`);
    return out;
  }
}

export const profiler = new Profiler();
