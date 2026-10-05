<script lang="ts">
  import { ADJUST_TYPES, BLEND_MODES, LIMITS, type BlendMode } from '../../shared/types';
  import { Engine } from '../engine/engine';
  import { ed } from '../state.svelte';
  import AdjustPanel from './AdjustPanel.svelte';
  import Icon from './Icon.svelte';
  import Slider from './Slider.svelte';

  let { engine }: { engine: Engine | null } = $props();

  const topDown = $derived([...ed.layers].reverse());
  const active = $derived(ed.layers.find((l) => l.id === ed.activeLayerId) ?? null);
  const index = $derived(ed.layers.findIndex((l) => l.id === ed.activeLayerId));

  let editing = $state<string | null>(null);
  let adjustMenu = $state(false);

  /** A layer is drawn clipped only when a layer that is not clipped lies somewhere below it. */
  const clippedIds = $derived.by(() => {
    const out = new Set<string>();
    let base = false;
    for (const l of ed.layers) {
      if (l.clip && base) out.add(l.id);
      else base = l.kind !== 'adjust';
    }
    return out;
  });

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
      {@const isActive = layer.id === ed.activeLayerId}
      <li
        class:active={isActive}
        class:clipped={clippedIds.has(layer.id)}
        onpointerdown={() => {
          engine?.setActiveLayer(layer.id);
          engine?.setMaskTarget(false);
        }}
      >
        {#if clippedIds.has(layer.id)}<span class="cliparrow" title="Clipped to the layer below">↳</span>{/if}
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
          <span class="name" class:hidden={!layer.visible} class:target={isActive && !ed.maskTarget} role="button" tabindex="-1" ondblclick={() => (editing = layer.id)} title="Double-click to rename">
            {#if layer.kind === 'adjust'}<span class="kind" title="Adjustment layer"><Icon name="adjust" /></span>{/if}
            {layer.name}
          </span>
        {/if}
        {#if layer.mask}
          <button
            class="icon maskchip"
            class:target={isActive && ed.maskTarget}
            class:off={!layer.mask.enabled}
            title={layer.mask.enabled ? 'Layer mask: click to paint on it (black hides, white shows). Shift+click turns it off.' : 'Layer mask (off): Shift+click turns it on'}
            onpointerdown={(e) => {
              e.stopPropagation();
              if (e.shiftKey) return engine?.setMaskEnabled(layer.id, !layer.mask!.enabled);
              engine?.setActiveLayer(layer.id);
              engine?.setMaskTarget(true);
            }}
          >
            <Icon name="mask" />
          </button>
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

  {#if active && (active.kind === 'adjust' || active.mask)}
    <div class="props">
      {#if active.kind === 'adjust'}
        <h3>{Engine.ADJUST_NAMES[active.adjust!.type]}</h3>
        {#key active.id}<AdjustPanel {engine} layer={active} />{/key}
      {/if}
      {#if active.mask}
        <div class="maskrow">
          <span class="lbl">Mask</span>
          <button class="small" class:on={!ed.maskTarget} title="Paint on the layer" disabled={active.kind === 'adjust'} onclick={() => engine?.setMaskTarget(false)}>Layer</button>
          <button class="small" class:on={ed.maskTarget} title="Paint on the mask: black hides, white shows" onclick={() => engine?.setMaskTarget(true)}>Mask</button>
          <label class="check" title="Turn the mask off without deleting it">
            <input type="checkbox" checked={active.mask.enabled} onchange={(e) => engine?.setMaskEnabled(active.id, e.currentTarget.checked)} /> On
          </label>
        </div>
      {/if}
    </div>
  {/if}

  <div class="footer">
    <button class="icon" title="New layer" onclick={() => engine?.addLayer()}><Icon name="plus" /></button>
    <span class="menuwrap">
      <button class="icon" title="New adjustment layer" onclick={() => (adjustMenu = !adjustMenu)}><Icon name="adjust" /></button>
      {#if adjustMenu}
        <div class="menu" role="menu">
          {#each ADJUST_TYPES as t}
            <button
              role="menuitem"
              onclick={() => {
                adjustMenu = false;
                engine?.addAdjustmentLayer(t);
              }}>{Engine.ADJUST_NAMES[t]}</button
            >
          {/each}
        </div>
      {/if}
    </span>
    <button
      class="icon"
      title={active?.mask ? 'Delete the layer mask' : 'Add a layer mask'}
      class:on={!!active?.mask}
      disabled={!active}
      onclick={() => active && (active.mask ? engine?.deleteMask(active.id) : engine?.addMask(active.id))}
    >
      <Icon name="mask" />
    </button>
    <button
      class="icon"
      title={active?.clip ? 'Release from the clipping mask' : 'Clip to the layer below (clipping mask)'}
      class:on={!!active?.clip}
      disabled={!active || index <= 0}
      onclick={() => active && engine?.setClip(active.id, !active.clip)}
    >
      <Icon name="clip" />
    </button>
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
    min-height: 300px;
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
    min-height: 102px; /* three rows stay visible next to the properties */
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
  li.clipped {
    padding-left: 14px;
  }
  .cliparrow {
    color: var(--text-dim);
    margin-right: -4px;
  }
  .kind {
    display: inline-flex;
    vertical-align: -2px;
    margin-right: 4px;
    color: var(--text-dim);
  }
  .name.target,
  .maskchip.target {
    outline: 1px solid var(--accent);
    outline-offset: 1px;
    border-radius: 2px;
  }
  .maskchip {
    width: 22px;
    height: 22px;
    flex: none;
  }
  .maskchip.off {
    opacity: 0.4;
  }
  .props {
    padding: 8px 10px;
    border-top: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex: none;
    max-height: 55%;
    overflow-y: auto;
  }
  h3 {
    margin: 0;
    font-size: 11px;
    font-weight: 600;
    color: var(--text-dim);
  }
  .maskrow {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .maskrow .lbl {
    color: var(--text-dim);
    margin-right: 4px;
  }
  .small {
    padding: 2px 8px;
    font-size: 11px;
  }
  .small.on,
  .footer .on {
    color: var(--text);
    border-color: var(--accent-dim);
    background: #24394c;
  }
  .check {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: var(--text-dim);
  }
  .menuwrap {
    position: relative;
  }
  .menu {
    position: absolute;
    bottom: 30px;
    left: 0;
    z-index: 20;
    display: flex;
    flex-direction: column;
    min-width: 160px;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: 4px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4);
    padding: 4px;
  }
  .menu button {
    text-align: left;
    padding: 6px 10px;
    background: none;
    border: none;
  }
  .menu button:hover {
    background: #2d3d4d;
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
  @media (pointer: coarse) {
    li {
      height: 46px;
    }
    .footer :global(button.icon) {
      width: 40px;
      height: 40px;
    }
  }
</style>
