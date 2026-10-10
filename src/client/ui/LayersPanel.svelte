<script lang="ts">
  // The layers panel: a tree, top layer first, groups as folders (Photoshop style). A row's grip
  // drags it (mouse, pen or finger): drop on the upper or lower part of a row to go above or below
  // it, on the middle of a group to go into it. Groups open and close with their arrow.
  import { ADJUST_TYPES, BLEND_MODES, LIMITS, type Layer, type LayerBlend, type Shape } from '../../shared/types';
  import { SHAPE_LABEL } from '../engine/shapeTool';
  import { layerTree, subtreeIds, type LayerNode } from '../../shared/layers';
  import { Engine } from '../engine/engine';
  import { ed } from '../state.svelte';
  import AdjustPanel from './AdjustPanel.svelte';
  import Icon from './Icon.svelte';
  import Slider from './Slider.svelte';
  import { dismiss } from '../dismiss';

  /** sheet: the phone's layers sheet. It keeps the Transform button (no tool bar on phones). */
  let { engine, sheet = false }: { engine: Engine | null; sheet?: boolean } = $props();

  interface Row {
    layer: Layer;
    depth: number;
    group: boolean;
    open: boolean;
  }

  const tree = $derived(layerTree(ed.layers));
  /** Rows top-down: a group's row, then (when open) its layers, top first. */
  const rows = $derived.by(() => {
    const out: Row[] = [];
    const walk = (nodes: LayerNode[], depth: number) => {
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        const group = n.layer.kind === 'group';
        // Groups and shape layers open and close (a shape layer shows its shapes).
        const open = (group || n.layer.kind === 'shape') && !ed.collapsed.has(n.layer.id);
        out.push({ layer: n.layer, depth, group, open });
        if (open) walk(n.children, depth + 1);
      }
    };
    walk(tree, 0);
    return out;
  });
  const active = $derived(ed.layers.find((l) => l.id === ed.activeLayerId) ?? null);

  let editing = $state<string | null>(null);
  let adjustMenu = $state(false);

  /** Drawn clipped: a clipped layer with a sibling below it that is not clipped (and not an adjustment). */
  const clippedIds = $derived.by(() => {
    const out = new Set<string>();
    const walk = (nodes: LayerNode[]) => {
      let base = false;
      for (const n of nodes) {
        if (n.layer.clip && base) out.add(n.layer.id);
        else base = n.layer.kind !== 'adjust';
        walk(n.children);
      }
    };
    walk(tree);
    return out;
  });
  /** Whether the active layer has a sibling below it (it can clip to it). */
  const hasBelow = $derived(!!active && !!engine?.canMove(active.id, -1));

  const BLEND_LABEL: Record<LayerBlend, string> = {
    pass: 'Pass Through',
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
  const blendModes = $derived<LayerBlend[]>(active?.kind === 'group' ? ['pass', ...BLEND_MODES] : [...BLEND_MODES]);

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

  function toggleOpen(id: string) {
    const next = new Set(ed.collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    ed.collapsed = next;
  }

  const peersOn = (layerId: string) => ed.peers.filter((p) => p.layerId === layerId);

  /** The shapes of each shape layer, top first (as the layers). */
  const shapesBy = $derived.by(() => {
    const out = new Map<string, Shape[]>();
    for (const s of ed.shapes) {
      let list = out.get(s.layerId);
      if (!list) out.set(s.layerId, (list = []));
      list.unshift(s);
    }
    return out;
  });
  let editingShape = $state<string | null>(null);

  /** A shape row: selects the shape (Shift: adds or removes it), with the Select tool. */
  function pickShape(e: PointerEvent, s: Shape) {
    if (!engine) return;
    const ids = e.shiftKey ? (ed.selection.includes(s.id) ? ed.selection.filter((id) => id !== s.id) : [...ed.selection, s.id]) : [s.id];
    if (ed.tool !== 'select' && ed.tool !== 'shape') {
      ed.tool = 'select';
      engine.updateCursor();
    }
    engine.shapes.select(ids);
  }

  function renameShape(id: string, value: string) {
    editingShape = null;
    const name = value.trim().slice(0, LIMITS.maxShapeName);
    if (name) engine?.shapes.rename(id, name);
  }

  // --- drag and drop -----------------------------------------------------------------------------

  let list = $state<HTMLUListElement>()!;
  /** The row being dragged, and where it would land. */
  let dragId = $state<string | null>(null);
  let drop = $state<{ id: string; where: 'above' | 'below' | 'into' } | null>(null);

  function grab(e: PointerEvent, id: string) {
    if (e.button !== 0 || !ed.canEdit) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      // the pointer is already gone
    }
    dragId = id;
    drop = null;
  }

  function dragMove(e: PointerEvent) {
    if (!dragId) return;
    const banned = subtreeIds(ed.layers, dragId);
    drop = null;
    for (const li of list.querySelectorAll<HTMLElement>('li[data-id]')) {
      const r = li.getBoundingClientRect();
      if (e.clientY < r.top || e.clientY >= r.bottom) continue;
      const id = li.dataset.id!;
      if (banned.has(id)) return;
      const f = (e.clientY - r.top) / r.height;
      const group = ed.layers.find((l) => l.id === id)?.kind === 'group';
      drop = { id, where: group ? (f < 0.25 ? 'above' : f > 0.75 ? 'below' : 'into') : f < 0.5 ? 'above' : 'below' };
      return;
    }
  }

  function dragEnd() {
    const id = dragId, d = drop;
    dragId = null;
    drop = null;
    if (!id || !d || !engine) return;
    const target = ed.layers.find((l) => l.id === d.id);
    if (!target) return;
    if (d.where === 'into') {
      // At the top of the group.
      const top = rows.find((r) => r.layer.parent === target.id && r.layer.id !== id);
      engine.moveTo(id, target.id, top?.layer.id ?? null, null);
      if (ed.collapsed.has(target.id)) toggleOpen(target.id);
      return;
    }
    const parent = target.parent ?? null;
    // Siblings bottom to top, without the dragged layer.
    const sib = ed.layers.filter((l) => (l.parent ?? null) === parent && l.id !== id).sort((a, b) => a.order - b.order);
    const i = sib.findIndex((l) => l.id === target.id);
    // "above" in the panel is higher in the stack.
    if (d.where === 'above') engine.moveTo(id, parent, target.id, sib[i + 1]?.id ?? null);
    else engine.moveTo(id, parent, sib[i - 1]?.id ?? null, target.id);
  }
</script>

<section>
  <h2>Layers</h2>
  <div class="controls">
    <select
      disabled={!active || active.kind === 'adjust'}
      value={active?.blend ?? 'normal'}
      onchange={(e) => active && engine?.updateLayer(active.id, { blend: e.currentTarget.value as LayerBlend })}
    >
      {#each blendModes as m}
        <option value={m}>{BLEND_LABEL[m]}</option>
      {/each}
    </select>
    {#key active?.id}
      <Slider label="Opacity" value={active?.opacity ?? 1} min={0} max={1} step={0.01} percent width={70} oninput={setOpacity} />
    {/key}
  </div>

  <ul bind:this={list} class:dragging={!!dragId} onpointermove={dragMove} onpointerup={dragEnd} onpointercancel={dragEnd}>
    {#each rows as row (row.layer.id)}
      {@const layer = row.layer}
      {@const isActive = layer.id === ed.activeLayerId}
      <li
        data-id={layer.id}
        class:active={isActive}
        class:clipped={clippedIds.has(layer.id)}
        class:group={row.group}
        class:lifted={dragId === layer.id}
        class:drop-above={drop?.id === layer.id && drop.where === 'above'}
        class:drop-below={drop?.id === layer.id && drop.where === 'below'}
        class:drop-into={drop?.id === layer.id && drop.where === 'into'}
        style:--depth={row.depth}
        onpointerdown={() => {
          engine?.setActiveLayer(layer.id);
          engine?.setMaskTarget(false);
          engine?.shapes.layerPicked(layer.id);
        }}
      >
        <span class="grip" title="Drag to move (into a group: drop on its middle)" role="button" tabindex="-1" onpointerdown={(e) => grab(e, layer.id)}>
          <Icon name="grip" />
        </span>
        {#if clippedIds.has(layer.id)}<span class="cliparrow" title="Clipped to the layer below">↳</span>{/if}
        <button
          class="icon eye"
          title={layer.visible ? 'Hide' : 'Show'}
          onpointerdown={(e) => e.stopPropagation()}
          onclick={() => engine?.updateLayer(layer.id, { visible: !layer.visible })}
        >
          <Icon name={layer.visible ? 'eye' : 'eyeoff'} />
        </button>
        {#if row.group || layer.kind === 'shape'}
          <button
            class="icon chev"
            class:open={row.open}
            title={row.group ? (row.open ? 'Close the group' : 'Open the group') : row.open ? 'Hide the shapes' : 'Show the shapes'}
            onpointerdown={(e) => e.stopPropagation()}
            onclick={() => toggleOpen(layer.id)}
          >
            <Icon name="chevron" />
          </button>
        {/if}
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
            {#if layer.kind === 'shape'}<span class="kind" title="Shape layer: holds shapes"><Icon name="shapes" /></span>{/if}
            {#if row.group}<span class="kind" title="Group"><Icon name="folder" /></span>{/if}
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
          {#if layer.blend !== 'normal' && layer.blend !== 'pass'}<span class="tag">{BLEND_LABEL[layer.blend].split(' ')[0]}</span>{/if}
          {#if layer.opacity < 1}<span class="tag">{Math.round(layer.opacity * 100)}%</span>{/if}
        </span>
      </li>
      {#if layer.kind === 'shape' && row.open}
        {#each shapesBy.get(layer.id) ?? [] as sh (sh.id)}
          <li class="shape" class:active={ed.selection.includes(sh.id)} style:--depth={row.depth + 1} onpointerdown={(e) => pickShape(e, sh)}>
            <span class="kind"><Icon name={sh.kind} /></span>
            {#if editingShape === sh.id}
              <input
                type="text"
                value={sh.name}
                use:focus
                onpointerdown={(e) => e.stopPropagation()}
                onblur={(e) => renameShape(sh.id, e.currentTarget.value)}
                onkeydown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') e.currentTarget.blur();
                  if (e.key === 'Escape') editingShape = null;
                }}
              />
            {:else}
              <span class="name" class:hidden={!layer.visible} role="button" tabindex="-1" ondblclick={() => (editingShape = sh.id)} title="Double-click to rename">
                {sh.name || SHAPE_LABEL[sh.kind]}
              </span>
            {/if}
            <span
              class="chip"
              class:outline={!sh.fill}
              style:background={sh.fill ?? 'transparent'}
              style:border-color={sh.stroke ?? (sh.fill ? '#000' : 'var(--text-faint)')}
              title="Fill {sh.fill ?? 'none'} · stroke {sh.stroke ?? 'none'}"
            ></span>
            <button
              class="icon del"
              title="Delete the shape (Delete)"
              aria-label="Delete {sh.name}"
              disabled={!ed.canEdit}
              onpointerdown={(e) => e.stopPropagation()}
              onclick={() => engine?.shapes.remove([sh.id])}
            >
              <Icon name="trash" />
            </button>
          </li>
        {/each}
      {/if}
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
    <span class="menuwrap" use:dismiss={{ open: adjustMenu, close: () => (adjustMenu = false) }}>
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
    {#if active?.kind === 'group'}
      <button class="icon" title="Ungroup: take the layers out (Ctrl+Shift+G)" onclick={() => engine?.ungroup(active.id)}><Icon name="folder" /></button>
    {:else}
      <button class="icon" title={active ? 'Put the layer in a new group (Ctrl+G)' : 'New group'} onclick={() => (active ? engine?.groupLayer(active.id) : engine?.addGroup())}>
        <Icon name="group" />
      </button>
    {/if}
    <button
      class="icon"
      title={active?.mask ? 'Delete the layer mask' : 'Add a layer mask'}
      class:on={!!active?.mask}
      disabled={!active || active.kind === 'group'}
      onclick={() => active && (active.mask ? engine?.deleteMask(active.id) : engine?.addMask(active.id))}
    >
      <Icon name="mask" />
    </button>
    <button
      class="icon"
      title={active?.clip ? 'Release from the clipping mask' : 'Clip to the layer below (clipping mask)'}
      class:on={!!active?.clip}
      disabled={!active || !hasBelow}
      onclick={() => active && engine?.setClip(active.id, !active.clip)}
    >
      <Icon name="clip" />
    </button>
    <button class="icon" title="Duplicate (Ctrl+J)" disabled={!active} onclick={() => active && engine?.duplicate(active.id)}><Icon name="copy" /></button>
    {#if active?.kind === 'shape'}
      <button
        class="icon"
        title="Convert to a paint layer: the shapes become paint (exact at any zoom) that the brush and the erasers work on. Undo turns it back."
        aria-label="Convert to a paint layer"
        disabled={!ed.canEdit}
        onclick={() => active && engine?.convertLayerToPaint(active.id)}
      >
        <Icon name="brush" />
      </button>
    {/if}
    {#if sheet}
      <button class="icon" title="Transform: move, scale, rotate" disabled={!active || active.kind === 'adjust'} onclick={() => engine?.startTransform()}>
        <Icon name="transform" />
      </button>
    {/if}
    <button class="icon" title="Move up" disabled={!active || !engine?.canMove(active.id, 1)} onclick={() => active && engine?.moveLayer(active.id, 1)}>
      <Icon name="up" />
    </button>
    <button class="icon" title="Move down" disabled={!active || !engine?.canMove(active.id, -1)} onclick={() => active && engine?.moveLayer(active.id, -1)}>
      <Icon name="down" />
    </button>
    <span class="grow"></span>
    <button class="icon" title={active?.kind === 'group' ? 'Delete the group and its layers' : 'Delete layer'} disabled={!active} onclick={() => active && engine?.deleteLayer(active.id)}>
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
  li {
    padding-left: calc(2px + var(--depth, 0) * 14px);
    position: relative;
  }
  li.clipped {
    padding-left: calc(14px + var(--depth, 0) * 14px);
  }
  li.group .name {
    font-weight: 600;
  }
  .grip {
    display: grid;
    place-items: center;
    width: 16px;
    height: 100%;
    flex: none;
    color: var(--text-faint);
    cursor: grab;
    touch-action: none;
  }
  .grip:hover {
    color: var(--text-dim);
  }
  ul.dragging,
  ul.dragging * {
    cursor: grabbing;
  }
  li.lifted {
    opacity: 0.45;
  }
  li.drop-above::before,
  li.drop-below::after {
    content: '';
    position: absolute;
    left: calc(var(--depth, 0) * 14px);
    right: 0;
    height: 2px;
    background: var(--accent);
    pointer-events: none;
  }
  li.drop-above::before {
    top: -1px;
  }
  li.drop-below::after {
    bottom: -1px;
  }
  li.drop-into {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .chev {
    width: 18px;
    height: 18px;
    flex: none;
    color: var(--text-dim);
    transition: transform 0.12s;
  }
  .chev.open {
    transform: rotate(90deg);
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
  li.shape {
    height: 28px;
    padding-left: calc(30px + var(--depth, 0) * 14px);
  }
  li.shape .kind {
    margin-right: 0;
  }
  .chip {
    flex: none;
    width: 14px;
    height: 14px;
    border-radius: 3px;
    border: 2px solid #000;
  }
  .chip.outline {
    border-width: 2px;
  }
  .del {
    width: 22px;
    height: 22px;
    flex: none;
    visibility: hidden;
  }
  li.shape:hover .del,
  li.shape.active .del {
    visibility: visible;
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
    flex-wrap: wrap;
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
    li.shape {
      height: 40px;
    }
    .del {
      visibility: visible;
      width: 36px;
      height: 36px;
    }
    .grip {
      width: 26px;
    }
    .footer :global(button.icon) {
      width: 40px;
      height: 40px;
    }
  }
</style>
