<script lang="ts">
  import { BLEND_MODES, LIMITS, type BlendMode } from '../../shared/types';
  import type { Engine } from '../engine/engine';
  import { ed } from '../state.svelte';
  import Icon from './Icon.svelte';
  import Slider from './Slider.svelte';

  let { engine }: { engine: Engine | null } = $props();

  const topDown = $derived([...ed.layers].reverse());
  const active = $derived(ed.layers.find((l) => l.id === ed.activeLayerId) ?? null);
  const index = $derived(ed.layers.findIndex((l) => l.id === ed.activeLayerId));

  let editing = $state<string | null>(null);

  const BLEND_LABEL: Record<BlendMode, string> = {
    normal: 'Normal',
    multiply: 'Multiply',
    screen: 'Screen',
    overlay: 'Overlay',
    darken: 'Darken',
    lighten: 'Lighten',
    'color-dodge': 'Color Dodge',
    'color-burn': 'Color Burn',
    'hard-light': 'Hard Light',
    'soft-light': 'Soft Light',
    difference: 'Difference',
    exclusion: 'Exclusion',
    hue: 'Hue',
    saturation: 'Saturation',
    color: 'Color',
    luminosity: 'Luminosity',
    add: 'Add (Linear Dodge)',
  };

  // Slider drags send at most one op per 60 ms.
  let opacityTimer: number | undefined;
  let opacityPending: { id: string; v: number } | null = null;
  function setOpacity(v: number) {
    if (!active) return;
    opacityPending = { id: active.id, v };
    if (opacityTimer !== undefined) return;
    opacityTimer = window.setTimeout(function flush() {
      opacityTimer = undefined;
      if (opacityPending) engine?.updateLayer(opacityPending.id, { opacity: opacityPending.v }, 'opacity');
      opacityPending = null;
    }, 60);
  }

  function rename(id: string, value: string) {
    editing = null;
    const name = value.trim().slice(0, LIMITS.maxLayerName);
    if (name) engine?.updateLayer(id, { name });
  }

  function focus(el: HTMLInputElement) {
    el.focus();
    el.select();
  }

  const peersOn = (layerId: string) => ed.peers.filter((p) => p.layerId === layerId);
</script>

<section>
  <h2>Layers</h2>
  <div class="controls">
    <select
      disabled={!active}
      value={active?.blend ?? 'normal'}
      onchange={(e) => active && engine?.updateLayer(active.id, { blend: e.currentTarget.value as BlendMode })}
    >
      {#each BLEND_MODES as m}
        <option value={m}>{BLEND_LABEL[m]}</option>
      {/each}
    </select>
    {#key active?.id}
      <Slider label="Opacity" value={active?.opacity ?? 1} min={0} max={1} step={0.01} percent width={70} oninput={setOpacity} />
    {/key}
  </div>

  <ul>
    {#each topDown as layer (layer.id)}
      <li class:active={layer.id === ed.activeLayerId} onpointerdown={() => engine?.setActiveLayer(layer.id)}>
        <button
          class="icon eye"
          title={layer.visible ? 'Hide' : 'Show'}
          onpointerdown={(e) => e.stopPropagation()}
          onclick={() => engine?.updateLayer(layer.id, { visible: !layer.visible })}
        >
          <Icon name={layer.visible ? 'eye' : 'eyeoff'} />
        </button>
        {#if editing === layer.id}
          <input
            type="text"
            value={layer.name}
            use:focus
            onblur={(e) => rename(layer.id, e.currentTarget.value)}
            onkeydown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') editing = null;
            }}
          />
        {:else}
          <span class="name" class:hidden={!layer.visible} role="button" tabindex="-1" ondblclick={() => (editing = layer.id)} title="Double-click to rename">
            {layer.name}
          </span>
        {/if}
        <span class="meta">
          {#each peersOn(layer.id) as p (p.id)}
            <span class="pdot" style:background={p.color} title="{p.name} is on this layer"></span>
          {/each}
          {#if layer.blend !== 'normal'}<span class="tag">{BLEND_LABEL[layer.blend].split(' ')[0]}</span>{/if}
          {#if layer.opacity < 1}<span class="tag">{Math.round(layer.opacity * 100)}%</span>{/if}
        </span>
      </li>
    {/each}
  </ul>

  <div class="footer">
    <button class="icon" title="New layer" onclick={() => engine?.addLayer()}><Icon name="plus" /></button>
    <button class="icon" title="Move up" disabled={!active || index >= ed.layers.length - 1} onclick={() => active && engine?.moveLayer(active.id, 1)}>
      <Icon name="up" />
    </button>
    <button class="icon" title="Move down" disabled={!active || index <= 0} onclick={() => active && engine?.moveLayer(active.id, -1)}>
      <Icon name="down" />
    </button>
    <span class="grow"></span>
    <button class="icon" title="Delete layer" disabled={!active || ed.layers.length <= 1} onclick={() => active && engine?.deleteLayer(active.id)}>
      <Icon name="trash" />
    </button>
  </div>
</section>

<style>
  section {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  h2 {
    margin: 0;
    padding: 8px 10px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: var(--text-dim);
  }
  .controls {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 0 10px 8px;
    border-bottom: 1px solid var(--border);
  }
  select {
    width: 100%;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    flex: 1;
    overflow-y: auto;
    min-height: 0;
  }
  li {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 34px;
    padding: 0 8px 0 4px;
    border-bottom: 1px solid #292929;
    cursor: default;
  }
  li:hover {
    background: #343434;
  }
  li.active {
    background: #3d4b59;
  }
  .eye {
    flex: none;
  }
  .name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    outline: none;
  }
  .name.hidden {
    color: var(--text-faint);
  }
  li input {
    flex: 1;
    min-width: 0;
  }
  .meta {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .pdot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }
  .tag {
    font-size: 10px;
    color: var(--text-dim);
    background: var(--bg-1);
    border-radius: 3px;
    padding: 0 4px;
  }
  .footer {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 4px 6px;
    border-top: 1px solid var(--border);
    background: var(--bg-1);
  }
  .grow {
    flex: 1;
  }
</style>
