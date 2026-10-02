<script lang="ts">
  import { LIMITS } from '../../shared/types';
  import { ed } from '../state.svelte';
  import Slider from './Slider.svelte';

  const painting = $derived(ed.tool === 'brush' || ed.tool === 'eraser');
  const b = $derived(ed.activeBrush);
</script>

<div class="opts">
  <span class="tool">{ed.tool === 'eraser' ? 'Eraser' : ed.tool === 'brush' ? 'Brush' : ed.tool === 'eyedropper' ? 'Eyedropper' : 'Hand'}</span>
  {#if painting}
    <Slider label="Size" bind:value={b.size} min={1} max={LIMITS.maxBrushSize} log width={110} title="[ and ]" />
    <Slider label="Opacity" bind:value={b.opacity} min={0.01} max={1} step={0.01} percent title="Keys 1–0. Caps the whole stroke." />
    <Slider label="Flow" bind:value={b.flow} min={0.01} max={1} step={0.01} percent title="Shift+1–0. Paint per dab: builds up where dabs overlap." />
    <Slider label="Hardness" bind:value={b.hardness} min={0} max={1} step={0.01} percent title="Shift+[ and Shift+]" />
    <Slider label="Spacing" bind:value={b.spacing} min={0.01} max={2} step={0.01} percent width={70} title="Distance between dabs, as a percent of the diameter" />
    <Slider label="Smoothing" bind:value={ed.smoothing} min={0} max={0.95} step={0.01} percent width={60} />
    <div class="toggles">
      <button class="icon wide" class:on={b.pressureSize} title="Pen pressure controls size" onclick={() => (b.pressureSize = !b.pressureSize)}>
        P·size
      </button>
      <button class="icon wide" class:on={b.pressureFlow} title="Pen pressure controls flow" onclick={() => (b.pressureFlow = !b.pressureFlow)}>
        P·flow
      </button>
      <button class="icon wide" class:on={b.buildup} title="Airbrush: paint keeps building up while the pen stays still" onclick={() => (b.buildup = !b.buildup)}>
        Airbrush
      </button>
    </div>
  {:else if ed.tool === 'eyedropper'}
    <span class="hint">Click the canvas to pick a color from all layers. Hold Alt with the brush for a quick pick.</span>
  {:else}
    <span class="hint">Drag to pan. Hold Space with any tool to pan. Scroll to zoom.</span>
  {/if}
</div>

<style>
  .opts {
    grid-area: opts;
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 0 12px;
    background: var(--bg-2);
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
    scrollbar-width: none;
  }
  .tool {
    font-weight: 600;
    min-width: 66px;
  }
  .toggles {
    display: flex;
    gap: 4px;
  }
  .wide {
    width: auto;
    padding: 0 8px;
    font-size: 11px;
    color: var(--text-dim);
    border: 1px solid var(--line);
  }
  .wide:global(.on) {
    color: var(--text);
    border-color: var(--accent-dim);
    background: #24394c;
  }
  .hint {
    color: var(--text-dim);
  }
</style>
