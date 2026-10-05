<script lang="ts">
  import { onMount } from 'svelte';
  import { Engine } from '../engine/engine';
  import { ed } from '../state.svelte';
  import { addRecent, removeRecent } from '../recent';
  import { API_BASE } from '../config';
  import TopBar from './TopBar.svelte';
  import OptionsBar from './OptionsBar.svelte';
  import Toolbar from './Toolbar.svelte';
  import ColorPanel from './ColorPanel.svelte';
  import LayersPanel from './LayersPanel.svelte';
  import StatusBar from './StatusBar.svelte';
  import MobileBar, { type SheetName } from './MobileBar.svelte';
  import Sheet from './Sheet.svelte';
  import Icon from './Icon.svelte';
  import CanvasBanner from './CanvasBanner.svelte';
  import AccessScreen from './AccessScreen.svelte';
  import ShareDialog from './ShareDialog.svelte';

  let { code, onLeave }: { code: string; onLeave: () => void } = $props();

  let canvas = $state<HTMLCanvasElement>()!;
  let brushCursor = $state<HTMLDivElement>()!;
  let engine = $state<Engine | null>(null);
  let missing = $state(false);

  // Phone layout: full-screen canvas, bottom tool bar, settings in bottom sheets.
  const NARROW = '(max-width: 760px), (max-height: 520px) and (pointer: coarse)';
  let narrow = $state(matchMedia(NARROW).matches);
  let sheet = $state<SheetName | null>(null);
  $effect(() => {
    const mq = matchMedia(NARROW);
    const on = () => {
      narrow = mq.matches;
      if (!narrow) sheet = null;
    };
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  });
  const zoomLabel = $derived.by(() => {
    const z = ed.view.zoom;
    if (z >= 100 || z < 0.01) return `×${z.toExponential(0).replace('e+', 'e')}`;
    return `${Math.round(z * 100)}%`;
  });

  onMount(() => {
    let e: Engine | null = null;
    let dead = false;
    fetch(`${API_BASE}/api/sessions/${encodeURIComponent(code)}`)
      .then((r) => r.json())
      .then((body) => {
        if (dead) return;
        if (!body.exists || body.key !== code) {
          removeRecent(code);
          return void (missing = true);
        }
        addRecent(code);
        e = engine = new Engine(code, canvas, brushCursor);
        e.updateCursor();
        // Console handle for debugging: __draw.ed (state), __draw.engine.
        (window as unknown as { __draw: unknown }).__draw = { ed, engine: e };
      })
      .catch(() => {
        if (!dead) e = engine = new Engine(code, canvas, brushCursor);
      });
    // Log in or out while here: reconnect so the server sees the new identity.
    const reauth = () => engine?.reconnect();
    window.addEventListener('draw:auth', reauth);
    return () => {
      dead = true;
      window.removeEventListener('draw:auth', reauth);
      e?.destroy();
      ed.role = null;
      ed.canvas = null;
      ed.denied = null;
      ed.shareOpen = false;
    };
  });

  // Keep preferences across visits.
  $effect(() => {
    JSON.stringify([ed.brush, ed.eraser, ed.smoothing, ed.fg, ed.bg, ed.swatches, ed.name, ed.showMarkers, ed.touchPressure]);
    const t = setTimeout(() => ed.persist(), 400);
    return () => clearTimeout(t);
  });

  // Only owners manage sharing: close the dialog if ownership goes (logout, transfer).
  $effect(() => {
    if (ed.role !== 'owner' && ed.shareOpen) ed.shareOpen = false;
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
    <p>No canvas is called <b>{code}</b>.</p>
    <button class="primary" onclick={onLeave}>Back</button>
  </div>
{:else}
  <div class="editor" class:narrow>
    <TopBar {engine} {code} {narrow} {onLeave} />
    {#if !narrow}
      <OptionsBar />
      <Toolbar {engine} />
    {/if}
    <div class="stage">
      <canvas bind:this={canvas}></canvas>
      <div class="brush-cursor" bind:this={brushCursor}></div>
      {#each ed.markers as m (m.key)}
        <button
          class="marker {m.kind}"
          style:transform="translate({m.x}px, {m.y}px)"
          title={m.kind === 'edge' ? `${m.count} stroke${m.count === 1 ? '' : 's'} this way` : `${m.count} small stroke${m.count === 1 ? '' : 's'} here`}
          aria-label={m.kind === 'edge' ? `Go to ${m.count} strokes off screen` : `Zoom to ${m.count} small strokes`}
          onclick={() => engine?.flyTo(m.target)}
        >
          {#if m.kind === 'edge'}<svg viewBox="0 0 12 12" style:transform="rotate({m.angle}rad)"><path d="M2 3l7 3-7 3z" /></svg>{/if}
          <span>{m.count > 999 ? `${Math.round(m.count / 100) / 10}k` : m.count}</span>
        </button>
      {/each}
      {#each peerCursors as p (p.id)}
        <div class="peer" style:transform="translate({p.sx}px, {p.sy}px)" style:--c={p.color}>
          <svg viewBox="0 0 12 12"><path d="M0 0L11 4.5 6 6 4.5 11z" /></svg>
          <span>{p.name}</span>
        </div>
      {/each}
      {#if ed.status !== 'online'}
        <div class="conn">{ed.status === 'connecting' ? 'Connecting…' : 'Offline, reconnecting…'}</div>
      {/if}
      <CanvasBanner {code} />
      {#if ed.denied}<AccessScreen {engine} {onLeave} />{/if}
      <div class="viewctl">
        <button
          class:on={ed.showMarkers}
          title={ed.showMarkers ? 'Hide markers (M)' : 'Show markers for small and off-screen drawings (M)'}
          aria-label={ed.showMarkers ? 'Hide markers' : 'Show markers'}
          aria-pressed={ed.showMarkers}
          onclick={() => {
            ed.showMarkers = !ed.showMarkers;
            engine?.scheduleMarkers();
          }}><Icon name="pin" /></button>
        <button title="Fit everything (Ctrl+0)" aria-label="Fit everything" onclick={() => engine?.fitAll()}><Icon name="fit" /></button>
      </div>
      {#if narrow}
        <button class="zoom" title="Reset to 100%" onclick={() => engine?.resetView()}>{zoomLabel}</button>
        {#if sheet === 'brush'}
          <Sheet title={ed.tool === 'eraser' ? 'Eraser' : 'Brush'} onClose={() => (sheet = null)}><OptionsBar stacked /></Sheet>
        {:else if sheet === 'color'}
          <Sheet title="Color" onClose={() => (sheet = null)}><ColorPanel {engine} /></Sheet>
        {:else if sheet === 'layers'}
          <Sheet title="Layers" tall onClose={() => (sheet = null)}><LayersPanel {engine} /></Sheet>
        {/if}
      {/if}
    </div>
    {#if ed.shareOpen}<ShareDialog {code} onDeleted={onLeave} />{/if}
    {#if narrow}
      <MobileBar {engine} bind:sheet />
    {:else}
      <aside>
        <ColorPanel {engine} />
        <LayersPanel {engine} />
      </aside>
      <StatusBar />
    {/if}
  </div>
{/if}

<style>
  .editor {
    height: 100%;
    height: 100dvh;
    display: grid;
    /* The options bar wraps to more rows in a narrow window (minmax: one row of 38px). */
    grid-template-rows: 36px minmax(38px, auto) minmax(0, 1fr) 24px;
    grid-template-columns: 44px minmax(0, 1fr) 264px;
    grid-template-areas:
      'top top top'
      'opts opts opts'
      'tools stage panels'
      'status status status';
  }
  .editor.narrow {
    grid-template-rows: auto minmax(0, 1fr) auto;
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas:
      'top'
      'stage'
      'bottom';
  }
  /* Viewport controls, bottom right. navigator.ts keeps edge arrows out of this corner. */
  .viewctl {
    position: absolute;
    right: 12px;
    bottom: 12px;
    z-index: 6;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .viewctl button {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    padding: 0;
    border-radius: 50%;
    color: var(--text-dim);
    background: rgba(30, 30, 30, 0.85);
    border: 1px solid var(--line);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .viewctl button:hover {
    color: var(--text);
    background: rgba(50, 50, 50, 0.92);
  }
  .viewctl button.on {
    color: #fff;
    background: rgba(25, 113, 194, 0.92);
    border-color: rgba(255, 255, 255, 0.6);
  }
  .viewctl :global(svg.i) {
    width: 18px;
    height: 18px;
  }
  @media (pointer: coarse) {
    .viewctl button {
      width: 44px;
      height: 44px;
    }
  }
  .zoom {
    position: absolute;
    left: 10px;
    top: 10px;
    z-index: 5;
    padding: 3px 9px;
    border-radius: 12px;
    font-size: 11px;
    background: rgba(30, 30, 30, 0.85);
    border-color: var(--line);
    font-variant-numeric: tabular-nums;
  }
  .stage {
    grid-area: stage;
    position: relative;
    /* Overlays (the banner) fit themselves to the stage width, not the window width. */
    container-type: inline-size;
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
    /* A short window: the panels scroll as one, so the layer buttons stay reachable. */
    overflow-y: auto;
    overflow-x: hidden;
    scrollbar-width: thin;
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
  .marker {
    position: absolute;
    left: 0;
    top: 0;
    z-index: 4;
    display: flex;
    align-items: center;
    gap: 3px;
    padding: 0 7px;
    height: 24px;
    min-width: 24px;
    margin: -12px 0 0 -12px;
    border-radius: 12px;
    font-size: 11px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: #fff;
    background: rgba(25, 113, 194, 0.88);
    border: 2px solid rgba(255, 255, 255, 0.9);
    box-shadow: 0 1px 6px rgba(0, 0, 0, 0.35);
    justify-content: center;
  }
  .marker.here::after {
    content: '';
    position: absolute;
    inset: -6px;
    border-radius: 18px;
    border: 2px solid rgba(49, 168, 255, 0.55);
    animation: ping 1.8s ease-out infinite;
    pointer-events: none;
  }
  @keyframes ping {
    from {
      opacity: 0.9;
      transform: scale(0.8);
    }
    to {
      opacity: 0;
      transform: scale(1.5);
    }
  }
  .marker.edge {
    background: rgba(40, 40, 40, 0.85);
    border-color: rgba(255, 255, 255, 0.35);
    color: var(--text);
  }
  .marker svg {
    width: 11px;
    height: 11px;
    fill: currentColor;
  }
  .marker:hover {
    filter: brightness(1.15);
  }
  @media (pointer: coarse) {
    .marker {
      height: 32px;
      min-width: 32px;
      margin: -16px 0 0 -16px;
      border-radius: 16px;
      font-size: 12px;
    }
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
  .conn {
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
  .missing {
    height: 100%;
    display: grid;
    place-content: center;
    text-align: center;
    gap: 8px;
    font-size: 14px;
  }
</style>
