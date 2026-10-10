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
    { id: 'select', icon: 'select', label: 'Select' },
    { id: 'pen', icon: 'pen', label: 'Pen' },
    { id: 'shape', icon: 'rect', label: 'Shapes' },
    { id: 'hand', icon: 'hand', label: 'Hand' },
  ];

  function tool(t: Tool) {
    // Tapping the active tool again opens its settings (Shapes: the kind and the style).
    if (ed.tool === t && (t === 'brush' || t === 'eraser' || t === 'strokeEraser' || t === 'shape' || t === 'select' || t === 'pen')) sheet = sheet === 'brush' ? null : 'brush';
    else ed.tool = t;
    engine?.updateCursor();
  }
  const toggle = (s: SheetName) => (sheet = sheet === s ? null : s);
</script>

<nav class="mobilebar">
  {#each TOOLS as t}
    <button class="icon" class:on={ed.tool === t.id} aria-label={t.label} onclick={() => tool(t.id)}><Icon name={t.id === 'shape' ? ed.shapeKind : t.icon} /></button>
  {/each}
  <span class="sep"></span>
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
    /* Shrinks on narrow phones so every tool fits in one row. */
    flex: 1 1 0;
    min-width: 0;
    max-width: 44px;
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
