<script lang="ts">
  // Export an image: the current view or everything, in its own shape or a common aspect ratio
  // (the area is centered and widened to it, never cut), at a chosen pixel count ("Screen" is
  // the resolution of the screen now), as PNG or tiled TIFF (BigTIFF past 4 GB). Pieces render
  // off screen and stream to the file, so the size is limited by the format and the disk, not
  // by memory. The settings are kept for next time.
  import type { Engine } from '../engine/engine';
  import { exportImage, rawSize, type ImageFormat } from '../export/exportImage';
  import { toAspect } from '../export/region';
  import { PNG_MAX_SIDE } from '../export/png';
  import { MEMORY_LIMIT, NotSavedError, openSink, sinkKind } from '../export/sink';
  import { TIFF_MAX_SIDE, needsBigTiff } from '../export/tiff';
  import { ed, showToast } from '../state.svelte';
  import Modal from './Modal.svelte';

  let { engine, code }: { engine: Engine; code: string } = $props();

  // Read once: the dialog covers the canvas, so the view does not move while it is open.
  const view = (() => engine.viewRect())();
  const content = (() => engine.contentBounds())();
  const density = (() => engine.deviceScale)(); // device px per world unit at 1×
  const memoryOnly = sinkKind() === 'memory';
  /** Without WebGL2 there is no off-screen renderer: only a snapshot of the screen. */
  const gl = (() => engine.comp.kind === 'webgl2')();

  /** Megapixels of the current view at the screen's resolution: the "Screen" preset. */
  const screenMp = (view.w * view.h * (window.devicePixelRatio || 1) ** 2) / 1e6;

  const KEY = 'draw.export';
  const saved = (() => {
    try {
      return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<{ area: string; mp: number | 'screen'; aspect: string; format: string }>;
    } catch {
      return {};
    }
  })();

  let area = $state<'view' | 'all'>(saved.area === 'all' && content ? 'all' : 'view');
  /** Target size in megapixels, or the screen's resolution. */
  let size = $state<number | 'screen'>(saved.mp === 'screen' || (typeof saved.mp === 'number' && saved.mp > 0) ? saved.mp : 'screen');
  let aspect = $state(saved.aspect ?? 'area');
  let format = $state<ImageFormat>(saved.format === 'tiff' ? 'tiff' : 'png');
  $effect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ area, mp: size, aspect, format }));
    } catch {
      // storage may be unavailable
    }
  });
  const mp = $derived(size === 'screen' ? screenMp : size);
  /** idle → choosing (save dialog) → rendering → finishing → done | failed (back to idle). */
  let phase = $state<'idle' | 'choosing' | 'rendering' | 'finishing' | 'done'>('idle');
  const running = $derived(phase === 'choosing' || phase === 'rendering' || phase === 'finishing');
  let progress = $state(0);
  let piece = $state(0);
  let pieces = $state(0);
  /** Result of the last export: shown until the next one. */
  let result = $state<{ name: string; bytes: number; seconds: number; width: number; height: number } | null>(null);
  /** The browser claimed to save but the file was wrong: offer a plain download. */
  let notSaved = $state<string | null>(null);
  let startedAt = $state(0);
  let now = $state(0);
  let controller: AbortController | null = null;

  // While an export runs: a clock for the time readout, and a warning before leaving the page
  // (closing it cuts the file off).
  $effect(() => {
    if (!running) return;
    const t = setInterval(() => (now = performance.now()), 500);
    const leave = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', leave);
    return () => {
      clearInterval(t);
      window.removeEventListener('beforeunload', leave);
    };
  });

  function fmtTime(s: number): string {
    if (!Number.isFinite(s)) return '…';
    s = Math.round(s);
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} min ${s % 60} s`;
    return `${Math.floor(m / 60)} h ${m % 60} min`;
  }
  const elapsed = $derived(running ? Math.max(0, now - startedAt) / 1000 : 0);
  /** Time left from the pace so far; shown after a few seconds, when it means something. */
  const left = $derived(progress > 0.01 && elapsed > 3 ? (elapsed * (1 - progress)) / progress : NaN);

  /** Megapixel presets: camera sizes up to gigapixel panoramas. */
  const PRESETS = [4, 12, 24, 50, 100, 250, 500, 1000, 2500, 10_000, 50_000];
  /** Width : height. "area" keeps the shape of the view or of the drawing. */
  const ASPECTS: [id: string, w: number, h: number][] = [
    ['1:1', 1, 1],
    ['4:3', 4, 3],
    ['3:2', 3, 2],
    ['16:9', 16, 9],
    ['21:9', 21, 9],
    ['4:5', 4, 5],
    ['2:3', 2, 3],
    ['9:16', 9, 16],
  ];
  const label = (m: number) => (m >= 1000 ? `${m / 1000} GP` : `${m} MP`);
  /** PNG strips hold width × 256 rows in memory; keep that under about 512 MB. */
  const PNG_MAX_WIDTH = 500_000;

  const areaBounds = $derived(area === 'all' && content ? content : view.bounds);
  /** The area centered and widened to the chosen shape. */
  const bounds = $derived.by(() => {
    const a = ASPECTS.find(([id]) => id === aspect);
    return a ? toAspect(areaBounds, a[1], a[2]) : areaBounds;
  });
  // width × height = mp × 10^6, with the shape of the frame.
  const ratio = $derived((bounds.x1 - bounds.x0) / (bounds.y1 - bounds.y0));
  const width = $derived(Math.max(1, Math.round(Math.sqrt(Math.max(0, mp) * 1e6 * ratio))));
  const height = $derived(Math.max(1, Math.round(width / ratio)));
  /** The same size as a multiple of the screen's resolution (1× = what the screen shows now). */
  const screens = $derived(width / ((bounds.x1 - bounds.x0) * density));
  const raw = $derived(rawSize(width, height));
  const big = $derived(format === 'tiff' && needsBigTiff(width, height));

  /** Why this export cannot run, or null. */
  const problem = $derived.by(() => {
    if (!(mp > 0) || !Number.isFinite(mp)) return 'Enter a size above 0 megapixels.';
    if (format === 'png' && (width > PNG_MAX_WIDTH || height > PNG_MAX_SIDE)) return `PNG export goes up to ${PNG_MAX_WIDTH.toLocaleString()} px wide here. Use TIFF for larger images.`;
    if (format === 'tiff' && (width > TIFF_MAX_SIDE || height > TIFF_MAX_SIDE)) return 'TIFF goes up to 4 294 967 295 px per side.';
    if (memoryOnly && raw > MEMORY_LIMIT * 4) return 'This browser keeps the whole file in memory. Use Chrome, Edge or the Draw app for an image this large.';
    return null;
  });

  function fmtBytes(n: number): string {
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) {
      n /= 1024;
      i++;
    }
    return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
  }
  const megapixels = $derived((width * height) / 1e6);

  /** `download`: skip the save dialog and download the file (the fallback after NotSaved). */
  async function run(download = false) {
    if (!gl) {
      await engine.exportPng();
      ed.exportOpen = false;
      return;
    }
    if (problem || running) return;
    const ext = format === 'png' ? 'png' : 'tif';
    result = null;
    notSaved = null;
    phase = 'choosing';
    const sink = await openSink(`${code}-${width}x${height}.${ext}`, format === 'png' ? 'image/png' : 'image/tiff', ext, format === 'png' ? 'PNG image' : 'TIFF image', download).catch(() => null);
    if (!sink) {
      phase = 'idle';
      return;
    }
    phase = 'rendering';
    progress = piece = pieces = 0;
    controller = new AbortController();
    const started = (startedAt = now = performance.now());
    const size = { width, height };
    try {
      await exportImage({
        ...engine.snapshot(),
        bounds: $state.snapshot(bounds),
        ...size,
        format,
        sink,
        onProgress: (p, i, n) => ((progress = p), (piece = i), (pieces = n)),
        onFinishing: () => (phase = 'finishing'),
        signal: controller.signal,
      });
      result = { name: sink.name, bytes: sink.size, seconds: (performance.now() - started) / 1000, ...size };
      phase = 'done';
    } catch (e) {
      const err = e as Error;
      phase = 'idle';
      if (err.name === 'AbortError') showToast('Export cancelled');
      else if (err instanceof NotSavedError) notSaved = err.message.replace(/^not_saved: /, '');
      else if (err.message === 'too_big_for_memory') showToast('The file got too large for browser memory. Use Chrome, Edge or the Draw app.');
      else showToast(`Export failed: ${err.message}`);
    } finally {
      controller = null;
    }
  }
</script>

<Modal title="Export image" onClose={() => (running ? controller?.abort() : (ed.exportOpen = false))}>
  {#if !gl}
    <p class="warn">This device has no WebGL2, so Draw can only save a snapshot of the screen (PNG, as you see it).</p>
  {:else}
  <div class="field">
    <span class="label">Area</span>
    <div class="seg">
      <button class:on={area === 'view'} disabled={running} onclick={() => (area = 'view')}>Current view</button>
      <button class:on={area === 'all'} disabled={running || !content} onclick={() => (area = 'all')}>Everything</button>
    </div>
  </div>

  <div class="field">
    <span class="label">Shape</span>
    <div class="seg wrap">
      <button class:on={aspect === 'area'} disabled={running} onclick={() => (aspect = 'area')}>{area === 'view' ? 'As on screen' : 'As drawn'}</button>
      {#each ASPECTS as [id] (id)}
        <button class:on={aspect === id} disabled={running} onclick={() => (aspect = id)}>{id}</button>
      {/each}
    </div>
  </div>
  {#if aspect !== 'area'}<p class="muted note">The area is centered and widened to this shape, never cut. Paper fills the rest.</p>{/if}

  <div class="field">
    <span class="label">Size</span>
    <div class="seg wrap">
      <button class:on={size === 'screen'} disabled={running} title="The resolution of your screen now" onclick={() => (size = 'screen')}>Screen</button>
      {#each PRESETS as m (m)}
        <button class:on={size === m} disabled={running} onclick={() => (size = m)}>{label(m)}</button>
      {/each}
      <label class="custom"
        ><input
          type="number"
          min="0.01"
          max="10000000"
          step="any"
          disabled={running}
          value={size === 'screen' ? +screenMp.toFixed(2) : size}
          oninput={(e) => {
            const v = +e.currentTarget.value;
            if (v > 0) size = v;
          }}
          aria-label="Megapixels"
        /> MP</label
      >
    </div>
  </div>

  <div class="field">
    <span class="label">Format</span>
    <div class="seg">
      <button class:on={format === 'png'} disabled={running} onclick={() => (format = 'png')}>PNG</button>
      <button class:on={format === 'tiff'} disabled={running} onclick={() => (format = 'tiff')}>TIFF</button>
    </div>
  </div>
  <p class="muted note">
    {#if format === 'png'}PNG opens everywhere. Very large PNGs are slow to open in most apps.
    {:else}Tiled TIFF: apps load only the part they show, so it suits very large images.{big ? ' This one is over 4 GB uncompressed, so it is BigTIFF (GIMP 2.10.32+, Photoshop, Krita, QGIS).' : ''}{/if}
  </p>

  <div class="size">
    <b>{width.toLocaleString()} × {height.toLocaleString()} px</b>
    <span class="muted"
      >{megapixels >= 1000 ? `${(megapixels / 1000).toFixed(1)} gigapixels` : `${megapixels.toFixed(1)} megapixels`} · {screens >= 10
        ? Math.round(screens)
        : screens.toFixed(1)}× the detail on your screen · up to {fmtBytes(raw)} uncompressed</span
    >
  </div>

  {/if}

  {#if problem && gl}<p class="error">{problem}</p>
  {:else if memoryOnly && raw > MEMORY_LIMIT}<p class="warn">This browser keeps the file in memory before the download. A large image can fail; Chrome, Edge and the Draw app write straight to disk.</p>{/if}

  {#if notSaved}
    <div class="status bad">
      <b>The file was not saved correctly.</b>
      <span>This browser reported success, but the file on disk is wrong ({notSaved}). Download it as a normal download instead, or use Chrome, Edge or the Draw app.</span>
    </div>
  {/if}

  {#if phase === 'choosing'}
    <div class="status"><b>Choose where to save…</b><span>Draw renders the image after you pick the file.</span></div>
  {:else if phase === 'rendering' || phase === 'finishing'}
    <div class="bar"><div style:width="{Math.round(progress * 100)}%"></div></div>
    <div class="actions">
      <span class="muted"
        >{phase === 'finishing' ? 'Finishing and checking the file…' : `Rendering piece ${piece} of ${pieces || '…'} · ${Math.floor(progress * 100)}%`} · {fmtTime(elapsed)}{phase ===
          'rendering' && Number.isFinite(left)
          ? ` · about ${fmtTime(left)} left`
          : ''}</span
      >
      <button onclick={() => controller?.abort()}>Cancel</button>
    </div>
  {:else}
    {#if phase === 'done' && result}
      <div class="status good">
        <b>Saved {result.name}</b>
        <span>{result.width.toLocaleString()} × {result.height.toLocaleString()} px · {fmtBytes(result.bytes)} · {fmtTime(result.seconds)}</span>
      </div>
    {/if}
    <div class="actions">
      {#if notSaved && raw <= MEMORY_LIMIT}<button class="primary" onclick={() => run(true)}>Download instead</button>{/if}
      <button class={notSaved && raw <= MEMORY_LIMIT ? '' : 'primary'} disabled={gl && !!problem} onclick={() => run()}
        >{gl ? (phase === 'done' ? 'Export again…' : 'Export…') : 'Save snapshot…'}</button
      >
      <button onclick={() => (ed.exportOpen = false)}>Close</button>
    </div>
  {/if}
</Modal>

<style>
  .field {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 10px;
  }
  .label {
    width: 52px;
    align-self: flex-start;
    padding-top: 4px;
    color: var(--text-dim);
    flex: none;
  }
  .seg {
    display: flex;
    gap: 4px;
    min-width: 0;
  }
  .seg.wrap {
    flex-wrap: wrap;
  }
  .seg button {
    padding: 4px 9px;
  }
  .seg button.on {
    color: var(--text);
    border-color: var(--accent-dim);
    background: #24394c;
  }
  .custom {
    display: flex;
    align-items: center;
    gap: 4px;
    margin: 0;
    color: var(--text-dim);
  }
  .custom input {
    width: 76px;
  }
  .note {
    margin: 4px 0 0 62px;
    font-size: 11px;
  }
  .size {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 14px 0 0;
    padding: 8px 10px;
    border-radius: 6px;
    background: var(--bg-0);
  }
  .size b {
    font-variant-numeric: tabular-nums;
  }
  .error,
  .warn {
    margin: 10px 0 0;
    font-size: 12px;
  }
  .error {
    color: var(--danger);
  }
  .warn {
    color: #e8b04a;
  }
  .status {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-top: 12px;
    padding: 8px 10px;
    border-radius: 6px;
    background: var(--bg-0);
    border-left: 3px solid var(--accent);
  }
  .status span {
    color: var(--text-dim);
    font-size: 11.5px;
  }
  .status.good {
    border-left-color: #51cf66;
  }
  .status.bad {
    border-left-color: var(--danger);
  }
  .bar {
    height: 6px;
    margin-top: 14px;
    border-radius: 3px;
    background: var(--bg-0);
    overflow: hidden;
  }
  .bar div {
    height: 100%;
    background: var(--accent);
    transition: width 0.2s;
  }
  .actions {
    align-items: center;
  }
  @media (max-width: 420px) {
    .field {
      flex-direction: column;
      align-items: flex-start;
      gap: 4px;
    }
    .note {
      margin-left: 0;
    }
  }
</style>
