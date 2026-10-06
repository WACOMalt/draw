<script lang="ts">
  import type { Engine } from '../engine/engine';
  import { ed, type Tool } from '../state.svelte';
  import Icon from './Icon.svelte';

  export type SheetName = 'brush' | 'color' | 'layers';
  let { engine, sheet = $bindable() }: { engine: Engine | null; sheet: SheetName | null } = $props();

  const TOOLS: { id: Tool; icon: string; label: string }[] = [
    { id: 'brush', icon: 'brush', label: 'Brush' },
    { id: 'eraser', icon: 'eraser', label: 'Eraser' },
    { id: 'strokeEraser', icon: 'strokeEraser', label: 'Stroke eraser' },
    { id: 'eyedropper', icon: 'eyedropper', label: 'Eyedropper' },
    { id: 'hand', icon: 'hand', label: 'Hand' },
  ];

  function tool(t: Tool) {
    // Tapping the active painting tool again opens its settings.
    if (ed.tool === t && (t === 'brush' || t === 'eraser' || t === 'strokeEraser')) sheet = sheet === 'brush' ? null : 'brush';
    else ed.tool = t;
    engine?.updateCursor();
  }
  const toggle = (s: SheetName) => (sheet = sheet === s ? null : s);
</script>

<nav>
  {#each TOOLS as t}
    <button class="icon" class:on={ed.tool === t.id} aria-label={t.label} onclick={() => tool(t.id)}><Icon name={t.icon} /></button>
  {/each}
  <span class="sep"></span>
  <button class="icon" class:on={sheet === 'brush'} aria-label="Brush settings" onclick={() => toggle('brush')}><Icon name="sliders" /></button>
  <button class="icon color" class:on={sheet === 'color'} aria-label="Color" onclick={() => toggle('color')}>
    <span style:background={ed.fg}></span>
  </button>
  <button class="icon" class:on={sheet === 'layers'} aria-label="Layers" onclick={() => toggle('layers')}><Icon name="layers" /></button>
</nav>

<style>
  nav {
    grid-area: bottom;
    display: flex;
    align-items: center;
    justify-content: space-around;
    gap: 2px;
    padding: 6px 8px calc(6px + env(safe-area-inset-bottom));
    padding-left: max(8px, env(safe-area-inset-left));
    padding-right: max(8px, env(safe-area-inset-right));
    background: var(--bg-1);
    border-top: 1px solid var(--border);
    z-index: 22;
  }
  nav :global(button.icon) {
    width: 44px;
    height: 44px;
    border-radius: 10px;
  }
  nav :global(svg.i) {
    width: 20px;
    height: 20px;
  }
  .sep {
    width: 1px;
    height: 24px;
    background: var(--line);
  }
  .color span {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    border: 2px solid #fff;
    box-shadow: 0 0 0 1px #000;
  }
</style>
