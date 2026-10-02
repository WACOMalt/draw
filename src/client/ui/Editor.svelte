<script lang="ts">
  import { onMount } from 'svelte';
  import { Engine } from '../engine/engine';
  import { ed } from '../state.svelte';
  import TopBar from './TopBar.svelte';
  import OptionsBar from './OptionsBar.svelte';
  import Toolbar from './Toolbar.svelte';
  import ColorPanel from './ColorPanel.svelte';
  import LayersPanel from './LayersPanel.svelte';
  import StatusBar from './StatusBar.svelte';

  let { code, onLeave }: { code: string; onLeave: () => void } = $props();

  let canvas = $state<HTMLCanvasElement>()!;
  let brushCursor = $state<HTMLDivElement>()!;
  let engine = $state<Engine | null>(null);
  let missing = $state(false);

  onMount(() => {
    let e: Engine | null = null;
    let dead = false;
    fetch(`/api/sessions/${code}`)
      .then((r) => r.json())
      .then((body) => {
        if (dead) return;
        if (!body.exists) return void (missing = true);
        e = engine = new Engine(code, canvas, brushCursor);
        e.updateCursor();
        // Console handle for debugging: __draw.ed (state), __draw.engine.
        (window as unknown as { __draw: unknown }).__draw = { ed, engine: e };
      })
      .catch(() => {
        if (!dead) e = engine = new Engine(code, canvas, brushCursor);
      });
    return () => {
      dead = true;
      e?.destroy();
    };
  });

  // Keep preferences across visits.
  $effect(() => {
    JSON.stringify([ed.brush, ed.eraser, ed.smoothing, ed.fg, ed.bg, ed.swatches, ed.name]);
    const t = setTimeout(() => ed.persist(), 400);
    return () => clearTimeout(t);
  });

  // The brush outline follows size changes from the options bar and shortcuts.
  $effect(() => {
    void ed.activeBrush.size;
    void ed.tool;
    engine?.updateCursor();
  });

  const peerCursors = $derived(
    ed.peers
      .filter((p) => p.x !== null && p.y !== null)
      .map((p) => ({ ...p, sx: (p.x! - ed.view.x) * ed.view.zoom, sy: (p.y! - ed.view.y) * ed.view.zoom })),
  );
</script>

{#if missing}
  <div class="missing">
    <p>No canvas has the code <b>{code}</b>.</p>
    <button class="primary" onclick={onLeave}>Back</button>
  </div>
{:else}
  <div class="editor">
    <TopBar {engine} {code} {onLeave} />
    <OptionsBar />
    <Toolbar {engine} />
    <div class="stage">
      <canvas bind:this={canvas}></canvas>
      <div class="brush-cursor" bind:this={brushCursor}></div>
      {#each peerCursors as p (p.id)}
        <div class="peer" style:transform="translate({p.sx}px, {p.sy}px)" style:--c={p.color}>
          <svg viewBox="0 0 12 12"><path d="M0 0L11 4.5 6 6 4.5 11z" /></svg>
          <span>{p.name}</span>
        </div>
      {/each}
      {#if ed.status !== 'online'}
        <div class="conn">{ed.status === 'connecting' ? 'Connecting…' : 'Offline, reconnecting…'}</div>
      {/if}
      {#if ed.toast}<div class="toast">{ed.toast}</div>{/if}
    </div>
    <aside>
      <ColorPanel {engine} />
      <LayersPanel {engine} />
    </aside>
    <StatusBar />
  </div>
{/if}

<style>
  .editor {
    height: 100%;
    display: grid;
    grid-template-rows: 36px 38px 1fr 24px;
    grid-template-columns: 44px 1fr 264px;
    grid-template-areas:
      'top top top'
      'opts opts opts'
      'tools stage panels'
      'status status status';
  }
  .stage {
    grid-area: stage;
    position: relative;
    overflow: hidden;
    background: var(--bg-0);
  }
  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    touch-action: none;
    display: block;
  }
  aside {
    grid-area: panels;
    background: var(--bg-2);
    border-left: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .brush-cursor {
    position: absolute;
    left: 0;
    top: 0;
    display: none;
    border-radius: 50%;
    border: 1px solid #fff;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6);
    pointer-events: none;
    mix-blend-mode: difference;
  }
  .peer {
    position: absolute;
    left: 0;
    top: 0;
    pointer-events: none;
    display: flex;
    align-items: flex-start;
    gap: 2px;
    transition: transform 60ms linear;
  }
  .peer svg {
    width: 14px;
    height: 14px;
    fill: var(--c);
    stroke: #000;
    stroke-width: 0.8;
  }
  .peer span {
    margin-top: 10px;
    background: var(--c);
    color: #111;
    font-size: 11px;
    font-weight: 600;
    padding: 1px 6px;
    border-radius: 8px;
    white-space: nowrap;
  }
  .conn,
  .toast {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(20, 20, 20, 0.92);
    border: 1px solid var(--line);
    padding: 6px 14px;
    border-radius: 14px;
    pointer-events: none;
  }
  .conn {
    top: 12px;
    color: #ffd43b;
  }
  .toast {
    bottom: 16px;
  }
  .missing {
    height: 100%;
    display: grid;
    place-content: center;
    text-align: center;
    gap: 8px;
    font-size: 14px;
  }
</style>
