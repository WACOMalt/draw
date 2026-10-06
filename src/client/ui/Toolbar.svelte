<script lang="ts">
  import type { Engine } from '../engine/engine';
  import { ed, type Tool } from '../state.svelte';
  import Icon from './Icon.svelte';

  let { engine }: { engine: Engine | null } = $props();

  const TOOLS: { id: Tool; icon: string; label: string; key: string }[] = [
    { id: 'brush', icon: 'brush', label: 'Brush', key: 'B' },
    { id: 'eraser', icon: 'eraser', label: 'Eraser', key: 'E' },
    { id: 'strokeEraser', icon: 'strokeEraser', label: 'Stroke eraser: removes whole strokes', key: 'Shift+E' },
    { id: 'eyedropper', icon: 'eyedropper', label: 'Eyedropper', key: 'I' },
    { id: 'hand', icon: 'hand', label: 'Hand', key: 'H' },
  ];

  function select(t: Tool) {
    ed.tool = t;
    engine?.updateCursor();
  }
</script>

<nav>
  {#each TOOLS as t}
    <button class="icon tool" class:on={ed.tool === t.id} title="{t.label} ({t.key})" onclick={() => select(t.id)}>
      <Icon name={t.icon} />
    </button>
  {/each}

  <div class="colors">
    <button class="swatch bg" style:background={ed.bg} title="Background color (X swaps)" aria-label="Background color" onclick={() => ([ed.fg, ed.bg] = [ed.bg, ed.fg])}></button>
    <button class="swatch fg" style:background={ed.fg} title="Foreground color" aria-label="Foreground color"></button>
    <button class="icon mini swap" title="Swap colors (X)" onclick={() => ([ed.fg, ed.bg] = [ed.bg, ed.fg])}><Icon name="swap" /></button>
    <button class="mini reset" title="Default colors (D)" aria-label="Default colors" onclick={() => ((ed.fg = '#000000'), (ed.bg = '#ffffff'))}></button>
  </div>
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
  }
  .tool {
    width: 32px;
    height: 30px;
  }
  .colors {
    position: relative;
    width: 36px;
    height: 44px;
    margin-top: 10px;
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
