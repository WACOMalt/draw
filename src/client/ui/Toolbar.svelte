<script lang="ts">
  import type { Engine } from '../engine/engine';
  import { ed, type Tool } from '../state.svelte';
  import Icon from './Icon.svelte';

  let { engine }: { engine: Engine | null } = $props();

  // Top: painting tools, the colors, the eyedropper and Transform. Bottom: navigation.
  type T = { id: Tool; icon: string; label: string; key: string };
  const PAINT: T[] = [
    { id: 'brush', icon: 'brush', label: 'Brush', key: 'B' },
    { id: 'eraser', icon: 'eraser', label: 'Eraser', key: 'E' },
    { id: 'strokeEraser', icon: 'strokeEraser', label: 'Stroke eraser: removes whole strokes', key: 'Shift+E' },
  ];
  const PICK: T = { id: 'eyedropper', icon: 'eyedropper', label: 'Eyedropper', key: 'I' };
  const VIEW: T[] = [
    { id: 'hand', icon: 'hand', label: 'Hand', key: 'H' },
    { id: 'zoom', icon: 'zoom', label: 'Zoom: click zooms in, Alt+click or right-click zooms out, drag sideways', key: 'Z' },
  ];

  const active = $derived(ed.layers.find((l) => l.id === ed.activeLayerId) ?? null);

  function select(t: Tool) {
    ed.tool = t;
    engine?.updateCursor();
  }
</script>

{#snippet tool(t: T)}
  <button class="icon tool" class:on={ed.tool === t.id} title="{t.label} ({t.key})" aria-label={t.label} onclick={() => select(t.id)}>
    <Icon name={t.icon} />
  </button>
{/snippet}

<nav>
  {#each PAINT as t}{@render tool(t)}{/each}

  <div class="colors">
    <button class="swatch bg" style:background={ed.bg} title="Background color (X swaps)" aria-label="Background color" onclick={() => ([ed.fg, ed.bg] = [ed.bg, ed.fg])}></button>
    <button class="swatch fg" style:background={ed.fg} title="Foreground color" aria-label="Foreground color"></button>
    <button class="icon mini swap" title="Swap colors (X)" onclick={() => ([ed.fg, ed.bg] = [ed.bg, ed.fg])}><Icon name="swap" /></button>
    <button class="mini reset" title="Default colors (D)" aria-label="Default colors" onclick={() => ((ed.fg = '#000000'), (ed.bg = '#ffffff'))}></button>
  </div>

  {@render tool(PICK)}
  <button
    class="icon tool"
    class:on={!!ed.transform}
    title="Transform the layer: move, scale, rotate (Ctrl+T or V)"
    aria-label="Transform the layer"
    disabled={!ed.canEdit || !active || active.kind === 'adjust'}
    onclick={() => (ed.transform ? engine?.cancelTransform() : engine?.startTransform())}
  >
    <Icon name="transform" />
  </button>

  <span class="grow"></span>
  {#each VIEW as t}{@render tool(t)}{/each}
</nav>

<style>
  nav {
    grid-area: tools;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 8px 0;
    background: var(--bg-2);
    border-right: 1px solid var(--border);
    /* A very small window (options in 3 rows, 400 px tall) scrolls the bar: a thin scrollbar
       shows that Hand and Zoom are below. */
    overflow-y: auto;
    scrollbar-width: thin;
  }
  .tool {
    width: 32px;
    height: 30px;
    flex: none;
  }
  .grow {
    flex: 1;
    min-height: 8px;
  }
  .colors {
    position: relative;
    flex: none;
    width: 36px;
    height: 44px;
    margin: 6px 0;
  }
  .swatch {
    position: absolute;
    width: 22px;
    height: 22px;
    padding: 0;
    border: 1px solid #000;
    box-shadow: 0 0 0 1px #777 inset;
    border-radius: 2px;
  }
  .swatch:hover {
    filter: brightness(1.05);
  }
  .fg {
    left: 2px;
    top: 2px;
    z-index: 1;
  }
  .bg {
    left: 12px;
    top: 12px;
  }
  .mini {
    position: absolute;
    width: 12px;
    height: 12px;
    padding: 0;
  }
  .swap {
    right: -2px;
    top: 0;
  }
  .swap :global(svg) {
    width: 11px;
    height: 11px;
  }
  /* Short windows: a tighter bar, so every tool shows without scrolling. */
  @media (max-height: 480px) {
    nav {
      gap: 1px;
      padding: 4px 0;
    }
    .tool {
      height: 27px;
    }
    .colors {
      margin: 3px 0;
    }
  }
  .reset {
    left: 1px;
    bottom: 1px;
    background: linear-gradient(135deg, #000 50%, #fff 50%);
    border: 1px solid #777;
    width: 10px;
    height: 10px;
    border-radius: 1px;
  }
</style>
