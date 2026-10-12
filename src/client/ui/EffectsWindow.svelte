<script lang="ts">
  // The layer effects window (as Photoshop's Layer Style): the settings of one layer's effects,
  // floating over the canvas so the change shows as it is made. It opens from the fx button, the
  // fx badge or an effect row in the layers panel, or a double-click on a layer row. Esc, Back and
  // the close button close it. It follows the layer: deleted, or not a paint or shape layer, closes it.
  import { onMount } from 'svelte';
  import { takesEffects } from '../../shared/effects';
  import type { Engine } from '../engine/engine';
  import { ed } from '../state.svelte';
  import { closeOnBack } from '../back';
  import EffectsPanel from './EffectsPanel.svelte';
  import Icon from './Icon.svelte';

  let { engine }: { engine: Engine | null } = $props();

  const layer = $derived(ed.layers.find((l) => l.id === ed.effectsLayer) ?? null);
  const close = () => (ed.effectsLayer = null);

  $effect(() => {
    if (!layer || !takesEffects(layer.kind) || !ed.effectsOk) close();
  });

  onMount(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key === 'Escape' && !(t && t.tagName === 'INPUT' && t.getAttribute('type') === 'text')) close();
    };
    window.addEventListener('keydown', key);
    const release = closeOnBack(close);
    return () => {
      window.removeEventListener('keydown', key);
      release();
    };
  });
</script>

{#if layer}
  <div class="win" role="dialog" aria-label="Layer effects of {layer.name}" data-over-canvas>
    <header>
      <h2><span class="fx">fx</span> {layer.name}</h2>
      <button class="icon" aria-label="Close" title="Close (Esc)" onclick={close}><Icon name="close" /></button>
    </header>
    <div class="body">
      {#key layer.id}<EffectsPanel {engine} {layer} />{/key}
    </div>
  </div>
{/if}

<style>
  .win {
    position: absolute;
    top: calc(var(--opts-h, 0px) + 10px);
    right: 10px;
    z-index: 9;
    width: 260px;
    max-height: calc(100% - var(--opts-h, 0px) - 80px);
    display: flex;
    flex-direction: column;
    background: rgba(37, 37, 37, 0.97);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.5);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 6px 4px 12px;
  }
  h2 {
    margin: 0;
    font-size: 13px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .fx {
    font-style: italic;
    color: var(--accent);
    margin-right: 2px;
  }
  .body {
    padding: 2px 12px 10px;
  }
  /* Phones: across the top of the canvas. */
  @media (max-width: 760px), (max-height: 520px) and (pointer: coarse) {
    .win {
      top: 8px;
      left: 8px;
      right: 8px;
      width: auto;
      max-height: 55%;
    }
    /* A phone may be short of room: the settings scroll (a color picker opens inside them). */
    .body {
      overflow-y: auto;
    }
  }
</style>
