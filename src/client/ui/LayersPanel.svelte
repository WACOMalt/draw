<script lang="ts">
  // The layers panel: a tree, top layer first, groups as folders (Photoshop style). A row's grip
  // drags it (mouse, pen or finger): drop on the upper or lower part of a row to go above or below
  // it, on the middle of a group to go into it. Groups open and close with their arrow.
  import { ADJUST_TYPES, BLEND_MODES, EFFECT_TYPES, LIMITS, type EffectType, type Layer, type LayerBlend, type LayerEffect, type Shape } from '../../shared/types';
  import { shapeLabel } from '../engine/shapeTool';
  import PresetIcon from './PresetIcon.svelte';
  import { OP_LABEL, partId } from '../../shared/compound';
  import { layerTree, subtreeIds, type LayerNode } from '../../shared/layers';
  import { Engine } from '../engine/engine';
  import { ed, showToast } from '../state.svelte';
  import AdjustPanel from './AdjustPanel.svelte';
  import { takesEffects } from '../../shared/effects';
  import Icon from './Icon.svelte';
  import Slider from './Slider.svelte';
  import ShapeColor from './ShapeColor.svelte';
  import { dismiss } from '../dismiss';

  /** sheet: the phone's layers sheet. It keeps the Transform button (no tool bar on phones). */
  let { engine, sheet = false }: { engine: Engine | null; sheet?: boolean } = $props();

  interface Row {
    layer: Layer;
    depth: number;
    group: boolean;
    open: boolean;
    /** The effects of a group, listed after its layers (they draw under them). */
    fx?: boolean;
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
        if (group && n.layer.effects?.length) out.push({ layer: n.layer, depth, group: false, open: false, fx: true });
      }
    };
    walk(tree, 0);
    return out;
  });
  const active = $derived(ed.layers.find((l) => l.id === ed.activeLayerId) ?? null);
  /** The canvas has 3D layers (from vdraw): the header offers to hide them on this device. */
  const hasThreeD = $derived(ed.layers.some((l) => l.threed));

  let editing = $state<string | null>(null);
  let adjustMenu = $state(false);
  const canFx = $derived(!!active && takesEffects(active.kind) && ed.effectsOk);
  /** The active layer can be 3D: a paint layer. */
  const canThreeD = $derived(!!active && (active.kind ?? 'paint') === 'paint');
  const fxShown = $derived(!!active && ed.effectsLayer === active.id);
  const EFFECT_LABEL: Record<EffectType, string> = { blur: 'Blur', dropShadow: 'Drop shadow', outerGlow: 'Outer glow', innerGlow: 'Inner glow', kaleidoscope: 'Kaleidoscope' };
  /** Opens the effects window of a layer (or closes it when it is open). */
  function openEffects(id: string, toggle = false) {
    if (!ed.effectsOk) return showToast('Layer effects need a newer server. Canvases on this device have them.');
    ed.effectsLayer = toggle && ed.effectsLayer === id ? null : id;
  }
  /** An effect's eye in the list: on or off, its settings kept. */
  function toggleEffect(layer: Layer, type: EffectType) {
    const list = ($state.snapshot(layer.effects) as LayerEffect[] | undefined) ?? [];
    const e = list.find((x) => x.type === type);
    if (!e) return;
    e.enabled = !e.enabled;
    engine?.setEffects(layer.id, list);
  }

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
  /** Selected shapes: the footer's up and down move them among the shapes of their layer. */
  const shapeSel = $derived(ed.selection.length > 0);
  const shapeUp = $derived(ed.shapes.length >= 0 && shapeSel && !!engine?.shapes.canArrange(ed.selection, 1));
  const shapeDown = $derived(ed.shapes.length >= 0 && shapeSel && !!engine?.shapes.canArrange(ed.selection, -1));

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
    const ids = e.shiftKey || ed.addSelection ? (ed.selection.includes(s.id) ? ed.selection.filter((id) => id !== s.id) : [...ed.selection, s.id]) : [s.id];
    if (ed.tool !== 'select' && ed.tool !== 'shape') {
      ed.tool = 'select';
      engine.updateCursor();
    }
    engine.shapes.select(ids);
  }

  /** A part row of a compound: parts mode, with the part selected (Shift: adds or removes it). */
  function pickPart(e: PointerEvent, c: Shape, i: number) {
    if (!engine) return;
    e.stopPropagation();
    if (ed.tool !== 'select') {
      ed.tool = 'select';
      engine.updateCursor();
    }
    const id = partId(c.id, i);
    if (ed.partsOf !== c.id) engine.shapes.enterParts(c.id);
    if (ed.partsOf !== c.id) return;
    engine.shapes.select(e.shiftKey || ed.addSelection ? (ed.selection.includes(id) ? ed.selection.filter((s) => s !== id) : [...ed.selection, id]) : [id]);
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

  // Shapes: a drag among the shapes of the same layer changes their order.
  let shapeDrag = $state<string | null>(null);
  let shapeDrop = $state<{ id: string; where: 'above' | 'below' } | null>(null);

  function grabShape(e: PointerEvent, id: string) {
    if (e.button !== 0 || !ed.canEdit) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      // the pointer is already gone
    }
    shapeDrag = id;
    shapeDrop = null;
  }

  function dragMove(e: PointerEvent) {
    if (shapeDrag) {
      const layer = ed.shapes.find((s) => s.id === shapeDrag)?.layerId;
      shapeDrop = null;
      for (const li of list.querySelectorAll<HTMLElement>('li[data-shape]')) {
        const r = li.getBoundingClientRect();
        if (e.clientY < r.top || e.clientY >= r.bottom) continue;
        const id = li.dataset.shape!;
        if (id !== shapeDrag && ed.shapes.find((s) => s.id === id)?.layerId === layer) shapeDrop = { id, where: e.clientY < r.top + r.height / 2 ? 'above' : 'below' };
        return;
      }
      return;
    }
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
    if (shapeDrag) {
      const id = shapeDrag, d = shapeDrop;
      shapeDrag = null;
      shapeDrop = null;
      // "above" in the panel is higher in the stack: right above the target, or right below it.
      if (d) engine?.shapes.moveShapeTo(id, d.where === 'above' ? d.id : null, d.where === 'below' ? d.id : null);
      return;
    }
    const id = dragId, d = drop;
    dragId = null;
    drop = null;
    if (!id || !d || !engine) return;
    const target = ed.layers.find((l) => l.id === d.id);
    if (!target) return;
    if (d.where === 'into') {
      // At the top of the group.
      const top = rows.find((r) => !r.fx && r.layer.parent === target.id && r.layer.id !== id);
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
  <div class="head">
    <h2>Layers</h2>
    {#if hasThreeD}
      <!-- This device only: no op, the 3D layers stay visible for everyone else. -->
      <button
        class="small threedtoggle"
        class:on={ed.show3dLayers}
        aria-pressed={ed.show3dLayers}
        title={ed.show3dLayers ? 'Hide the 3D layers on this device (others still see them)' : 'Show the 3D layers (hidden on this device only)'}
        onclick={() => engine?.setShow3dLayers(!ed.show3dLayers)}
      >
        <Icon name={ed.show3dLayers ? 'eye' : 'eyeoff'} /> 3D
      </button>
    {/if}
  </div>
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
    {#each rows as row (row.fx ? `${row.layer.id}:fx` : row.layer.id)}
      {@const layer = row.layer}
      {#if row.fx}
        {@render effectRows(layer, row.depth)}
      {:else}
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
        ondblclick={(e) => {
          // As in Photoshop: a double-click on the row (not on the name, which renames) opens the effects.
          if ((e.target as Element).closest('.txt, input, button') || !takesEffects(layer.kind) || !ed.effectsOk) return;
          openEffects(layer.id);
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
          <span class="name" class:hidden={!layer.visible || (layer.threed && !ed.show3dLayers)} class:target={isActive && !ed.maskTarget}>
            {#if layer.kind === 'adjust'}<span class="kind" title="Adjustment layer"><Icon name="adjust" /></span>{/if}
            {#if layer.kind === 'shape'}<span class="kind" title="Shape layer: holds shapes"><Icon name="shapes" /></span>{/if}
            {#if row.group}<span class="kind" title="Group"><Icon name="folder" /></span>{/if}
            <!-- Double-click the name to rename it; elsewhere on the row, to open the effects. -->
            <span class="txt" role="button" tabindex="-1" ondblclick={() => (editing = layer.id)} title={takesEffects(layer.kind) ? 'Double-click to rename (elsewhere on the row: effects)' : 'Double-click to rename'}>{layer.name}</span>
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
          {#if layer.threed}<span class="tag threed" title="A 3D layer: its strokes have depth (painted in VR in vdraw, or moved in 3D)">3D</span>{/if}
          {#if layer.blend !== 'normal' && layer.blend !== 'pass'}<span class="tag">{BLEND_LABEL[layer.blend].split(' ')[0]}</span>{/if}
          {#if layer.opacity < 1}<span class="tag">{Math.round(layer.opacity * 100)}%</span>{/if}
          {#if layer.effects?.length}
            <button
              class="tag fx"
              class:off={!layer.effects.some((e) => e.enabled)}
              title="Layer effects: open the settings"
              onpointerdown={(e) => e.stopPropagation()}
              onclick={() => openEffects(layer.id)}>fx</button
            >
          {/if}
        </span>
      </li>
      <!-- A layer's effects right under it; a group's after its layers (rows marked fx). -->
      {#if layer.effects?.length && !row.group}{@render effectRows(layer, row.depth)}{/if}
      {#if layer.kind === 'shape' && row.open}
        {#each shapesBy.get(layer.id) ?? [] as sh (sh.id)}
          <li
            class="shape"
            data-shape={sh.id}
            class:active={ed.selection.includes(sh.id)}
            class:lifted={shapeDrag === sh.id}
            class:drop-above={shapeDrop?.id === sh.id && shapeDrop.where === 'above'}
            class:drop-below={shapeDrop?.id === sh.id && shapeDrop.where === 'below'}
            style:--depth={row.depth + 1}
            onpointerdown={(e) => pickShape(e, sh)}
          >
            <span class="grip" title="Drag to change the order" role="button" tabindex="-1" onpointerdown={(e) => grabShape(e, sh.id)}><Icon name="grip" /></span>
            <span class="kind">{#if sh.kind === 'custom' && sh.preset}<PresetIcon preset={sh.preset} size={14} />{:else}<Icon name={sh.kind} />{/if}</span>
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
                {sh.name || shapeLabel(sh)}
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
          {#if sh.kind === 'compound' && sh.parts}
            <!-- Its parts, top first: each one's op with the parts below it (the bottom part is the base). -->
            {#each sh.parts.map((p, i) => ({ p, i })).reverse() as { p, i } (i)}
              <li class="shape part" class:active={ed.selection.includes(partId(sh.id, i))} style:--depth={row.depth + 2} onpointerdown={(e) => pickPart(e, sh, i)}>
                <span class="kind">{#if p.kind === 'custom' && p.preset}<PresetIcon preset={p.preset} size={14} />{:else}<Icon name={p.kind} />{/if}</span>
                <span class="name" class:hidden={!layer.visible}>{p.name || `${shapeLabel(p)} ${i + 1}`}</span>
                <span class="op" title={i ? `${OP_LABEL[p.op]}: how it combines with the parts below` : 'The base: the parts above combine with it'}>{i ? OP_LABEL[p.op] : 'Base'}</span>
              </li>
            {/each}
          {/if}
        {/each}
      {/if}
      {/if}
    {/each}
  </ul>

  <!-- A layer's effects, as in Photoshop: an eye each; a click opens the settings. -->
  {#snippet effectRows(layer: Layer, depth: number)}
    {#each EFFECT_TYPES.filter((t) => layer.effects?.some((e) => e.type === t)) as t (t)}
      {@const on = !!layer.effects?.find((e) => e.type === t)?.enabled}
      <li class="effect" class:off={!on} style:--depth={depth + 1} onpointerdown={() => engine?.setActiveLayer(layer.id)} ondblclick={() => openEffects(layer.id)}>
        <button
          class="icon eye"
          title={on ? 'Turn the effect off' : 'Turn the effect on'}
          disabled={!ed.canEdit || !ed.effectsOk}
          onpointerdown={(e) => e.stopPropagation()}
          onclick={() => toggleEffect(layer, t)}
        >
          <Icon name={on ? 'eye' : 'eyeoff'} />
        </button>
        <span class="name" role="button" tabindex="-1" title="Open the settings" onclick={() => openEffects(layer.id)} onkeydown={(e) => e.key === 'Enter' && openEffects(layer.id)}
          >{EFFECT_LABEL[t]}{#if layer.kind === 'group'}<span class="of"> · {layer.name}</span>{/if}</span
        >
      </li>
    {/each}
  {/snippet}

  <!-- The bottom of the stack. None: alpha 0 (the color stays for when it comes back). -->
  <div class="paper" title="The paper under all layers. Below 100% opacity the screen shows a checkerboard, and exports on the paper keep the transparency.">
    <span class="lbl">Paper</span>
    <span class="pct">{ed.paper.alpha > 0 ? `${Math.round(ed.paper.alpha * 100)}%` : 'None'}</span>
    <ShapeColor
      label="Paper"
      up
      value={ed.paper.alpha > 0 ? ed.paper.color : null}
      opacity={ed.paper.alpha}
      oninput={(v) => engine?.setPaper(v ? { color: v, alpha: ed.paper.alpha || 1 } : { ...ed.paper, alpha: 0 }, true)}
      onchange={(v) => engine?.setPaper(v ? { color: v, alpha: ed.paper.alpha || 1 } : { ...ed.paper, alpha: 0 })}
      onopacity={(a, done) => engine?.setPaper({ ...ed.paper, alpha: a }, !done)}
    />
  </div>
  <!-- How paint mixes on this canvas: a canvas setting, for everyone on it. -->
  <div
    class="paper"
    title={ed.pigmentOk
      ? 'Paint mixing for the whole canvas. Pigment: strokes mix with the paint below as real paint does (blue and yellow make green). Normal: they cover it.'
      : 'Pigment mixing needs a newer server. Canvases on this device have it.'}
  >
    <span class="lbl">Paint mixing</span>
    <div class="seg">
      <button class="small" class:on={ed.mix === 'normal'} disabled={!ed.canEdit} onclick={() => engine?.setMix('normal')}>Normal</button>
      <button class="small" class:on={ed.mix === 'pigment'} disabled={!ed.canEdit || (!ed.pigmentOk && ed.mix !== 'pigment')} onclick={() => engine?.setMix('pigment')}
        >Pigment</button
      >
    </div>
  </div>

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
              disabled={t === 'blur' && !ed.effectsOk}
              title={t === 'blur' && !ed.effectsOk ? 'Needs a newer server. Canvases on this device have it.' : undefined}
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
      class="icon fxbtn"
      title={!ed.effectsOk
        ? 'Layer effects need a newer server. Canvases on this device have them.'
        : canFx
          ? fxShown
            ? 'Close the layer effects'
            : 'Layer effects: blur, drop shadow, glows (or double-click the layer)'
          : 'Adjustment layers take no effects'}
      class:on={fxShown}
      disabled={!canFx}
      onclick={() => active && openEffects(active.id, true)}>fx</button
    >
    <!-- 2D or 3D: a 3D layer keeps depth (VR paints in it) and the Select tool turns it in 3D. -->
    <button
      class="icon threedbtn"
      title={!canThreeD
        ? '3D layers are paint layers'
        : active?.threed
          ? 'A 3D layer: click to make it flat (2D) again. It draws the same.'
          : ed.threedOk
            ? 'Make it a 3D layer: the Select tool then turns it in 3D, and in VR it paints with depth'
            : '3D layers need a newer server. Canvases on this device have them.'}
      aria-pressed={!!active?.threed}
      class:on={!!active?.threed}
      disabled={!canThreeD || !ed.canEdit || (!active?.threed && !ed.threedOk)}
      onclick={() => active && engine?.setThreeD(active.id, !active.threed)}>3D</button
    >
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
    {#if shapeSel}
      <!-- With shapes selected, up and down change their order in their layer. -->
      <button
        class="icon"
        title="Move the selected shapes up (Ctrl+]; Shift+click or Ctrl+Shift+]: to the top)"
        disabled={!shapeUp || !ed.canEdit}
        onclick={(e) => engine?.shapes.arrange(ed.selection, 1, e.shiftKey)}
      >
        <Icon name="up" />
      </button>
      <button
        class="icon"
        title="Move the selected shapes down (Ctrl+[; Shift+click or Ctrl+Shift+[: to the bottom)"
        disabled={!shapeDown || !ed.canEdit}
        onclick={(e) => engine?.shapes.arrange(ed.selection, -1, e.shiftKey)}
      >
        <Icon name="down" />
      </button>
    {:else}
      <button class="icon" title="Move up" disabled={!active || !engine?.canMove(active.id, 1)} onclick={() => active && engine?.moveLayer(active.id, 1)}>
        <Icon name="up" />
      </button>
      <button class="icon" title="Move down" disabled={!active || !engine?.canMove(active.id, -1)} onclick={() => active && engine?.moveLayer(active.id, -1)}>
        <Icon name="down" />
      </button>
    {/if}
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
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-right: 8px;
  }
  .threedtoggle {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 1px 6px;
    font-size: 10px;
    font-weight: 600;
  }
  .threedtoggle :global(svg.i) {
    width: 12px;
    height: 12px;
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
  .tag.fx,
  .fxbtn {
    font-style: italic;
    font-weight: 600;
  }
  .threedbtn {
    font-size: 11px;
    font-weight: 700;
  }
  .tag.fx {
    color: var(--accent);
  }
  .tag.threed {
    font-weight: 600;
    letter-spacing: 0.3px;
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
  li.effect {
    height: 24px;
    font-size: 11.5px;
    padding-left: calc(22px + var(--depth, 0) * 14px);
    color: var(--text-dim);
  }
  li.effect .eye {
    width: 22px;
    height: 20px;
  }
  li.effect .name {
    cursor: pointer;
  }
  li.effect .of {
    color: var(--text-faint);
  }
  li.effect.off .name {
    opacity: 0.5;
    text-decoration: line-through;
  }
  button.tag {
    border: none;
    cursor: pointer;
    line-height: inherit;
    height: auto;
    min-width: 0;
  }
  .tag.fx.off {
    opacity: 0.5;
  }
  li.shape .kind {
    margin-right: 0;
  }
  li.shape.part {
    height: 24px;
    font-size: 11px;
  }
  .op {
    flex: none;
    padding: 1px 6px;
    border-radius: 8px;
    border: 1px solid var(--border);
    color: var(--text-dim);
    font-size: 10px;
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
    /* The effects can be long: they scroll, and the layer list keeps its rows. */
    max-height: 55%;
    overflow-y: auto;
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
  .paper {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 34px;
    padding: 0 8px 0 10px;
    border-top: 1px solid var(--border);
  }
  .paper .lbl {
    flex: 1;
  }
  .paper .pct {
    color: #999;
    font-size: 12px;
  }
  .paper + .paper {
    border-top: none;
  }
  .seg {
    display: flex;
    gap: 4px;
  }
  .seg button.on {
    color: var(--text);
    border-color: var(--accent-dim);
    background: #24394c;
  }
  .footer {
    display: flex;
    /* One row: with up to 11 buttons (a shape layer, the phone sheet) they get narrower instead of wrapping. */
    flex-wrap: nowrap;
    align-items: center;
    gap: 2px;
    padding: 4px 6px;
    border-top: 1px solid var(--border);
    background: var(--bg-1);
  }
  .footer :global(button.icon) {
    flex: 0 1 26px;
    min-width: 20px;
  }
  .footer .menuwrap {
    display: flex;
    flex: 0 1 26px;
    min-width: 20px;
  }
  .footer .menuwrap :global(button.icon) {
    flex: 1 1 auto;
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
    .footer :global(button.icon),
    .footer .menuwrap {
      flex-basis: 40px;
      min-width: 28px;
      height: 40px;
    }
  }
</style>
