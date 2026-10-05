<script lang="ts">
  // Export a large image: the current view or everything, at a multiple of the screen's
  // resolution, as PNG or tiled TIFF (BigTIFF past 4 GB). Pieces render off screen and stream to
  // the file, so the size is limited by the format and the disk, not by memory.
  import type { Engine } from '../engine/engine';
  import { exportImage, rawSize, type ImageFormat } from '../export/exportImage';
  import { PNG_MAX_SIDE } from '../export/png';
  import { MEMORY_LIMIT, openSink, sinkKind } from '../export/sink';
  import { TIFF_MAX_SIDE, needsBigTiff } from '../export/tiff';
  import { ed, showToast } from '../state.svelte';
  import Modal from './Modal.svelte';

  let { engine, code }: { engine: Engine; code: string } = $props();

  // Read once: the dialog covers the canvas, so the view does not move while it is open.
  const view = (() => engine.viewRect())();
  const content = (() => engine.contentBounds())();
  const density = (() => engine.deviceScale)(); // device px per world unit at 1×
  const memoryOnly = sinkKind() === 'memory';

  let area = $state<'view' | 'all'>('view');
  let scale = $state(2);
  let format = $state<ImageFormat>('png');
  let running = $state(false);
  let progress = $state(0);
  let controller: AbortController | null = null;

  const SCALES = [1, 2, 4, 8, 16, 32, 64];
  /** PNG strips hold width × 256 rows in memory; keep that under about 512 MB. */
  const PNG_MAX_WIDTH = 500_000;

  const bounds = $derived(area === 'all' && content ? content : view.bounds);
  const width = $derived(Math.max(1, Math.round((bounds.x1 - bounds.x0) * density * scale)));
  const height = $derived(Math.max(1, Math.round((bounds.y1 - bounds.y0) * density * scale)));
  const raw = $derived(rawSize(width, height));
  const big = $derived(format === 'tiff' && needsBigTiff(width, height));

  /** Why this export cannot run, or null. */
  const problem = $derived.by(() => {
    if (!(scale > 0) || !Number.isFinite(scale)) return 'Enter a scale above 0.';
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

  async function run() {
    if (problem || running) return;
    const ext = format === 'png' ? 'png' : 'tif';
    const sink = await openSink(`${code}-${width}x${height}.${ext}`, format === 'png' ? 'image/png' : 'image/tiff', ext, format === 'png' ? 'PNG image' : 'TIFF image');
    if (!sink) return;
    running = true;
    progress = 0;
    controller = new AbortController();
    const started = performance.now();
    try {
      await exportImage({
        ...engine.snapshot(),
        bounds: $state.snapshot(bounds),
        width,
        height,
        format,
        sink,
        onProgress: (p) => (progress = p),
        signal: controller.signal,
      });
      showToast(`Exported ${width} × ${height} (${fmtBytes(sink.size)}) in ${Math.round((performance.now() - started) / 1000)} s`);
      ed.exportOpen = false;
    } catch (e) {
      const err = e as Error;
      if (err.name === 'AbortError') showToast('Export cancelled');
      else if (err.message === 'too_big_for_memory') showToast('The file got too large for browser memory. Use Chrome, Edge or the Draw app.');
      else showToast(`Export failed: ${err.message}`);
    } finally {
      running = false;
      controller = null;
    }
  }
</script>

<Modal title="Export image" onClose={() => (running ? controller?.abort() : (ed.exportOpen = false))}>
  <div class="field">
    <span class="label">Area</span>
    <div class="seg">
      <button class:on={area === 'view'} disabled={running} onclick={() => (area = 'view')}>Current view</button>
      <button class:on={area === 'all'} disabled={running || !content} onclick={() => (area = 'all')}>Everything</button>
    </div>
  </div>

  <div class="field">
    <span class="label">Scale</span>
    <div class="seg wrap">
      {#each SCALES as s (s)}
        <button class:on={scale === s} disabled={running} onclick={() => (scale = s)}>{s}×</button>
      {/each}
      <input type="number" min="0.1" max="100000" step="any" disabled={running} bind:value={scale} aria-label="Scale" />
    </div>
  </div>
  <p class="muted note">1× is the resolution of your screen now. 2× has twice the detail in each direction.</p>

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
    <span class="muted">{megapixels >= 1000 ? `${(megapixels / 1000).toFixed(1)} gigapixels` : `${megapixels.toFixed(1)} megapixels`} · up to {fmtBytes(raw)} uncompressed</span>
  </div>

  {#if problem}<p class="error">{problem}</p>
  {:else if memoryOnly && raw > MEMORY_LIMIT}<p class="warn">This browser keeps the file in memory before the download. A large image can fail; Chrome, Edge and the Draw app write straight to disk.</p>{/if}

  {#if running}
    <div class="bar"><div style:width="{Math.round(progress * 100)}%"></div></div>
    <div class="actions">
      <span class="muted">{Math.floor(progress * 100)}%</span>
      <button onclick={() => controller?.abort()}>Cancel</button>
    </div>
  {:else}
    <div class="actions">
      <button class="primary" disabled={!!problem} onclick={run}>Export…</button>
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
  .seg input {
    width: 70px;
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
