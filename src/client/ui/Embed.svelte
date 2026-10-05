<script lang="ts">
  // The embed page (/e/CODE): only the drawing, live and view only, framed on the rectangle in
  // the address. Drag or pinch to pan and zoom; the wheel zooms after a click inside. The
  // buttons zoom, go back to the framed view, go full screen, and open the canvas in Draw.
  import { onMount } from 'svelte';
  import type { Bounds } from '../engine/doc';
  import { Engine } from '../engine/engine';
  import { ed } from '../state.svelte';
  import Icon from './Icon.svelte';

  let { code, frame }: { code: string; frame: Bounds } = $props();

  let canvas = $state<HTMLCanvasElement>()!;
  let brushCursor = $state<HTMLDivElement>()!;
  let engine = $state<Engine | null>(null);
  let fullscreen = $state(false);
  const canFullscreen = document.fullscreenEnabled;

  const k = new URLSearchParams(location.search).get('k');
  const openUrl = $derived(`${location.origin}/s/${encodeURIComponent(code)}${k ? `?k=${encodeURIComponent(k)}` : ''}`);

  const DENIED: Record<string, string> = {
    password_required: 'This drawing needs a password.',
    password_wrong: 'This drawing needs a password.',
    deleted: 'This drawing no longer exists.',
    expired: 'This drawing no longer exists.',
  };

  onMount(() => {
    const e = (engine = new Engine(code, canvas, brushCursor, frame));
    // Console handle for debugging, as in the editor: __draw.ed (state), __draw.engine.
    (window as unknown as { __draw: unknown }).__draw = { ed, engine: e };
    const onFs = () => (fullscreen = !!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    return () => {
      document.removeEventListener('fullscreenchange', onFs);
      e.destroy();
    };
  });

  function toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.().catch(() => {});
  }
</script>

<div class="embed">
  <canvas bind:this={canvas}></canvas>
  <div class="brush-cursor" bind:this={brushCursor}></div>

  {#if ed.denied}
    <div class="cover">
      <p>{DENIED[ed.denied] ?? 'This drawing is private.'}</p>
      <a href={openUrl} target="_blank" rel="noopener">Open in Draw</a>
    </div>
  {:else if ed.status !== 'online'}
    <div class="status">{ed.status === 'connecting' ? 'Loading…' : 'Offline, reconnecting…'}</div>
  {/if}

  <div class="controls">
    <button title="Zoom in" aria-label="Zoom in" onclick={() => engine?.zoomBy(1.4)}><Icon name="plus" /></button>
    <button title="Zoom out" aria-label="Zoom out" onclick={() => engine?.zoomBy(1 / 1.4)}><Icon name="minus" /></button>
    <button title="Back to the framed view" aria-label="Back to the framed view" onclick={() => engine?.resetFrame()}><Icon name="fit" /></button>
    {#if canFullscreen}
      <button title={fullscreen ? 'Exit full screen' : 'Full screen'} aria-label={fullscreen ? 'Exit full screen' : 'Full screen'} onclick={toggleFullscreen}>
        <Icon name={fullscreen ? 'shrink' : 'expand'} />
      </button>
    {/if}
    <a class="open" href={openUrl} target="_blank" rel="noopener" title="Open in Draw" aria-label="Open in Draw"><Icon name="external" /></a>
  </div>

  {#if ed.toast}<div class="toast" role="status">{ed.toast}</div>{/if}
</div>

<style>
  .embed {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: var(--bg-0);
  }
  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
    touch-action: none;
  }
  .brush-cursor {
    display: none;
  }
  .controls {
    position: absolute;
    right: 8px;
    bottom: 8px;
    display: flex;
    gap: 4px;
    padding: 3px;
    border-radius: 8px;
    background: rgba(30, 30, 30, 0.82);
    border: 1px solid var(--line);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .controls button,
  .controls a {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    padding: 0;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--text-dim);
  }
  .controls button:hover,
  .controls a:hover {
    background: var(--bg-3);
    color: var(--text);
  }
  .controls :global(svg.i) {
    width: 16px;
    height: 16px;
  }
  @media (pointer: coarse) {
    .controls button,
    .controls a {
      width: 38px;
      height: 38px;
    }
  }
  /* A very small embed: only the essentials. */
  @media (max-width: 220px), (max-height: 120px) {
    .controls button:not(:nth-child(3)) {
      display: none;
    }
  }
  .status {
    position: absolute;
    left: 8px;
    top: 8px;
    padding: 3px 10px;
    border-radius: 10px;
    font-size: 11px;
    background: rgba(30, 30, 30, 0.85);
    color: var(--text-dim);
  }
  .cover {
    position: absolute;
    inset: 0;
    display: grid;
    place-content: center;
    gap: 8px;
    text-align: center;
    padding: 16px;
    background: var(--bg-0);
    color: var(--text-dim);
  }
  .cover p {
    margin: 0;
  }
  .cover a {
    color: var(--accent);
  }
  .toast {
    position: absolute;
    left: 50%;
    top: 10px;
    transform: translateX(-50%);
    max-width: calc(100% - 24px);
    padding: 5px 12px;
    border-radius: 14px;
    background: rgba(20, 20, 20, 0.92);
    border: 1px solid var(--line);
    pointer-events: none;
    text-align: center;
    font-size: 11.5px;
  }
</style>
