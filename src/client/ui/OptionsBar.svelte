<script lang="ts">
  import { ARROW_KINDS, BRUSH_TIPS, COMPOUND_OPS, CUSTOM_SHAPES, GRAINS, LIMITS, type ArrowKind, type BrushTip, type CompoundOp, type CustomShape, type GrainId, type LineCap, type Shape, type ShapeProps, type StrokeAlign } from '../../shared/types';
  import type { Engine } from '../engine/engine';
  import { CUSTOM_LABEL, SHAPE_LABEL, shapeLabel } from '../engine/shapeTool';
  import PresetIcon from './PresetIcon.svelte';
  import { centerOnly } from '../../shared/shapes';
  import { OP_LABEL, partShape, splitPartId } from '../../shared/compound';
  import { DRAW_KINDS, ed, type ShapeStyle, type Tool } from '../state.svelte';
  import Icon from './Icon.svelte';
  import PresetsPanel from './PresetsPanel.svelte';
  import ShapeColor from './ShapeColor.svelte';
  import Slider from './Slider.svelte';
  import { dismiss } from '../dismiss';

  let { stacked = false, engine = null }: { stacked?: boolean; engine?: Engine | null } = $props();

  /**
   * The bar floats over the top of the canvas, so the canvas never moves when it wraps to more
   * rows. Its height goes to ed.optsHeight: overlays at the top of the canvas move below it.
   */
  function floating(node: HTMLElement) {
    if (stacked) return;
    const ro = new ResizeObserver(() => (ed.optsHeight = node.offsetHeight + node.offsetTop));
    ro.observe(node);
    return {
      destroy: () => {
        ro.disconnect();
        ed.optsHeight = 0;
      },
    };
  }
  const painting = $derived(ed.tool === 'brush' || ed.tool === 'eraser');
  const TOOL_LABEL: Record<Tool, string> = {
    brush: 'Brush',
    eraser: 'Eraser',
    strokeEraser: 'Stroke eraser',
    eyedropper: 'Eyedropper',
    select: 'Select',
    pen: 'Pen',
    shape: 'Shapes',
    hand: 'Hand',
    zoom: 'Zoom',
  };
  const b = $derived(ed.activeBrush);
  let dynamicsOpen = $state(false);
  /** The Dynamics popover opens to the right when its button is near the left edge (a wrapped row). */
  let dynamicsLeft = $state(false);
  let presetsOpen = $state(false);
  const touchScreen = matchMedia('(any-pointer: coarse)').matches || navigator.maxTouchPoints > 0;

  const TIP_LABEL: Record<BrushTip, string> = {
    round: 'Round',
    square: 'Square',
    chalk: 'Chalk',
    charcoal: 'Charcoal',
    bristle: 'Bristle',
    splatter: 'Splatter',
    pencil: 'Pencil',
  };
  const GRAIN_LABEL: Record<GrainId, string> = { paper: 'Paper', canvas: 'Canvas', noise: 'Noise' };

  // --- shapes ----------------------------------------------------------------------------------
  // With shapes selected, the controls show the first one and change all of them (where the
  // setting fits the kind). Else they set the style of the next shape. Lengths are screen pixels.

  const shapeOf = (id: string): Shape | undefined => {
    const pid = splitPartId(id);
    if (!pid) return ed.shapes.find((s) => s.id === id);
    const c = ed.shapes.find((s) => s.id === pid[0]);
    return c && partShape(c, pid[1], (k) => SHAPE_LABEL[k]);
  };
  const selShapes = $derived(ed.selection.map(shapeOf).filter((s): s is Shape => !!s));

  // Compound shapes: combine the selection, or change a compound (its op, release, flatten), or in
  // parts mode the op of the selected parts.
  const OP_TITLE: Record<CompoundOp, string> = {
    unite: 'Unite: the area of all the shapes',
    subtract: 'Subtract: the bottom shape without the shapes above it',
    intersect: 'Intersect: only where the shapes overlap',
    exclude: 'Exclude: where an odd number of shapes overlap',
  };
  const wholeSel = $derived(selShapes.filter((s) => !splitPartId(s.id)));
  const canCombine = $derived(ed.tool === 'select' && !ed.partsOf && wholeSel.length >= 2);
  const compounds = $derived(ed.partsOf ? [] : wholeSel.filter((s) => s.kind === 'compound'));
  /** The op of the selected compounds (the op of their parts above the first), or null when mixed. */
  const compoundOp = $derived.by((): CompoundOp | null => {
    const ops = new Set(compounds.flatMap((c) => (c.parts ?? []).slice(1).map((p) => p.op)));
    return ops.size === 1 ? [...ops][0] : null;
  });
  const partInfo = $derived.by(() => {
    if (!ed.partsOf) return null;
    const c = ed.shapes.find((s) => s.id === ed.partsOf);
    const idx = ed.selection.map((id) => splitPartId(id)?.[1]).filter((i): i is number => i !== undefined);
    if (!c?.parts || !idx.length) return null;
    const ops = new Set(idx.filter((i) => i > 0).map((i) => c.parts![i]?.op));
    return { first: idx.includes(0) && idx.length === 1, op: ops.size === 1 ? [...ops][0] : null };
  });
  const first = $derived(selShapes[0] ?? null);
  /** Screen pixels per local unit of a shape. */
  const kOf = (s: Shape) => Math.sqrt(Math.abs(s.m[0] * s.m[3] - s.m[1] * s.m[2])) * ed.view.zoom;
  const kind = $derived(first?.kind ?? (ed.tool === 'pen' ? 'path' : ed.shapeKind));
  const st = $derived.by((): ShapeStyle => {
    if (!first) return ed.tool === 'pen' ? { ...ed.shapeStyle, ...ed.penStyle } : ed.shapeStyle;
    const k = kOf(first);
    const r = first.radii ?? [0, 0, 0, 0];
    return {
      fill: first.fill,
      stroke: first.stroke,
      strokeWidth: first.strokeWidth * k,
      align: first.align,
      cap: first.cap,
      radii: r.map((v) => v * k) as ShapeStyle['radii'],
      radiiLinked: first.radiiLinked ?? r.every((v) => v === r[0]),
      sides: first.sides ?? ed.shapeStyle.sides,
      points: first.points ?? ed.shapeStyle.points,
      innerRatio: first.innerRatio ?? ed.shapeStyle.innerRatio,
      rounding: (first.rounding ?? 0) * k,
      arc: first.arc ?? [0, 0],
      hole: first.hole ?? 0,
      preset: first.preset ?? ed.shapeStyle.preset,
      dash: first.dash ?? [],
      arrows: first.arrows ?? ['none', 'none'],
    };
  });
  const showStyle = $derived(ed.tool === 'shape' || ed.tool === 'pen' || selShapes.length > 0);
  const kinds = $derived(new Set(selShapes.length ? selShapes.map((s) => s.kind) : [kind]));
  // Alignment is for closed outlines; caps are for open ones (lines, open paths, the Pen).
  const alignable = $derived(selShapes.length ? selShapes.some((s) => !centerOnly(s)) : kind !== 'line' && kind !== 'path');
  const capped = $derived(selShapes.length ? selShapes.some((s) => centerOnly(s)) : kind === 'line' || kind === 'path');
  const has = (...k: Shape['kind'][]) => k.some((x) => kinds.has(x));
  const round = (v: number) => (v >= 100 ? Math.round(v) : Math.round(v * 10) / 10);

  /**
   * Changes a setting: on the selected shapes (fn gives each one's props, from its pixels per unit;
   * null: not for this kind), and in the style for the next shape. `live`: a drag in progress.
   */
  function setShape(style: Partial<ShapeStyle>, fn: (s: Shape, k: number) => Partial<ShapeProps> | null, live = false) {
    // The Pen keeps a style of its own (its paths start without a fill).
    if (ed.tool === 'pen') {
      for (const k of ['fill', 'stroke', 'strokeWidth', 'align', 'cap', 'dash', 'arrows'] as const) if (k in style) (ed.penStyle as Record<string, unknown>)[k] = style[k];
    } else Object.assign(ed.shapeStyle, style);
    if (selShapes.length) engine?.shapes.editSelected((s) => fn(s, kOf(s)), live);
  }
  const setFill = (v: string | null, live = false) => setShape({ fill: v }, (s) => (s.kind === 'line' ? null : { fill: v }), live);
  const setStroke = (v: string | null, live = false) => setShape({ stroke: v }, () => ({ stroke: v }), live);
  const setWidth = (px: number, live = false) =>
    setShape({ strokeWidth: px }, (s, k) => ({ strokeWidth: px / k, ...(s.stroke ? {} : { stroke: ed.shapeStyle.stroke ?? ed.fg }) }), live);
  const setAlign = (a: StrokeAlign) => setShape({ align: a }, (s) => (centerOnly(s) ? null : { align: a }));
  const setCap = (c: LineCap) => setShape({ cap: c }, () => ({ cap: c }));
  function setRadius(i: number | null, px: number, live = false) {
    const radii = [...st.radii] as ShapeStyle['radii'];
    if (i === null) radii.fill(px);
    else radii[i] = px;
    setShape({ radii }, (s, k) => {
      if (s.kind !== 'rect') return null;
      const r = [...(s.radii ?? [0, 0, 0, 0])] as ShapeStyle['radii'];
      if (i === null) r.fill(px / k);
      else r[i] = px / k;
      return { radii: r };
    }, live);
  }
  const setLinked = (on: boolean) => {
    setShape({ radiiLinked: on }, (s) => (s.kind === 'rect' ? { radiiLinked: on } : null));
    if (on) setRadius(null, st.radii[0]);
  };
  const setSides = (n: number, live = false) => setShape({ sides: n }, (s) => (s.kind === 'polygon' ? { sides: Math.round(n) } : null), live);
  const setPoints = (n: number, live = false) => setShape({ points: n }, (s) => (s.kind === 'star' ? { points: Math.round(n) } : null), live);
  const setInner = (v: number, live = false) => setShape({ innerRatio: v }, (s) => (s.kind === 'star' ? { innerRatio: v } : null), live);
  const setRounding = (px: number, live = false) => setShape({ rounding: px }, (s, k) => (s.kind === 'polygon' || s.kind === 'star' ? { rounding: px / k } : null), live);
  // Ellipse arcs: degrees, 0 at the right, clockwise. The same start and end: the whole ellipse.
  function setArc(i: 0 | 1, deg: number) {
    const v = Math.max(-360, Math.min(360, Math.round(deg * 10) / 10));
    const next = (a: [number, number]) => (i === 0 ? [v, a[1]] : [a[0], v]) as [number, number];
    setShape({ arc: next(st.arc) }, (s) => (s.kind === 'ellipse' ? { arc: next(s.arc ?? [0, 0]) } : null));
  }
  const arcEnd = $derived(st.arc[0] === st.arc[1] ? st.arc[0] + 360 : st.arc[1]);
  const setHole = (v: number, live = false) => setShape({ hole: v }, (s) => (s.kind === 'ellipse' ? { hole: v } : null), live);
  let presetOpen = $state(false);
  const setPreset = (p: CustomShape) => {
    presetOpen = false;
    setShape({ preset: p }, (s) => (s.kind === 'custom' ? { preset: p } : null));
  };
  // Dashes: patterns in stroke widths. Dots are dashes of no length with round caps.
  const DASHES: [string, string, number[]][] = [
    ['solid', 'Solid', []],
    ['dashed', 'Dashed', [3, 2]],
    ['long', 'Long dash', [6, 3]],
    ['dotted', 'Dotted', [0, 2]],
  ];
  const dashId = $derived(DASHES.find(([, , d]) => d.join() === st.dash.join())?.[0] ?? 'custom');
  const dashable = $derived(selShapes.length ? selShapes.some((s) => s.kind !== 'compound') : true);
  function setDash(id: string) {
    const d = DASHES.find(([x]) => x === id)?.[2] ?? [];
    const dots = d.length > 0 && d[0] === 0;
    setShape({ dash: d, ...(dots ? { cap: 'round' as LineCap } : {}) }, (s) => (s.kind === 'compound' ? null : { dash: d, ...(dots ? { cap: 'round' as LineCap } : {}) }));
  }
  const ARROW_LABEL: Record<ArrowKind, string> = { none: 'None', arrow: 'Arrow', open: 'Open arrow', circle: 'Circle', bar: 'Bar' };
  function setArrow(i: 0 | 1, a: ArrowKind) {
    const next = (x: [ArrowKind, ArrowKind]) => (i === 0 ? [a, x[1]] : [x[0], a]) as [ArrowKind, ArrowKind];
    setShape({ arrows: next(st.arrows) }, (s) => (centerOnly(s) ? { arrows: next(s.arrows ?? ['none', 'none']) } : null));
  }
  const ALIGNS: [StrokeAlign, string][] = [['inside', 'Inside'], ['center', 'Center'], ['outside', 'Outside']];
  const CAPS: [LineCap, string][] = [['butt', 'Butt'], ['round', 'Round'], ['square', 'Square']];
  const activeLayer = $derived(ed.layers.find((l) => l.id === ed.activeLayerId) ?? null);

  /** The element's text as its tooltip: the hints are cut to one line. */
  function fullTitle(node: HTMLElement) {
    const set = () => (node.title = node.textContent?.trim() ?? '');
    set();
    const mo = new MutationObserver(set);
    mo.observe(node, { childList: true, characterData: true, subtree: true });
    return { destroy: () => mo.disconnect() };
  }

  /** True when any dynamics setting is not at its default: the button shows it is on. */
  const dynamicsOn = $derived(
    (b.roundness ?? 1) < 1 || !!b.angle || !!b.followDirection || !!b.sizeJitter || !!b.angleJitter || !!b.scatter || !!b.opacityJitter || !!b.grain,
  );
</script>

{#snippet dynamics()}
  <div class="dyn" class:stacked>
    <Slider wide={stacked} label="Angle" value={b.angle ?? 0} min={0} max={360} step={1} width={90} title="Rotation of the tip, in degrees" oninput={(v) => (b.angle = v)} />
    <Slider wide={stacked} label="Roundness" value={b.roundness ?? 1} min={0.05} max={1} step={0.01} percent width={90} title="100% is round; less squashes the tip" oninput={(v) => (b.roundness = v)} />
    <button class="icon wide" class:on={b.followDirection} title="The tip turns with the stroke direction" onclick={() => (b.followDirection = !b.followDirection)}>Follow direction</button>
    <Slider wide={stacked} label="Size jitter" value={b.sizeJitter ?? 0} min={0} max={1} step={0.01} percent width={90} oninput={(v) => (b.sizeJitter = v)} />
    <Slider wide={stacked} label="Angle jitter" value={b.angleJitter ?? 0} min={0} max={1} step={0.01} percent width={90} oninput={(v) => (b.angleJitter = v)} />
    <Slider wide={stacked} label="Scatter" value={b.scatter ?? 0} min={0} max={4} step={0.01} percent width={90} title="Random offset across the stroke, in diameters" oninput={(v) => (b.scatter = v)} />
    <Slider wide={stacked} label="Flow jitter" value={b.opacityJitter ?? 0} min={0} max={1} step={0.01} percent width={90} oninput={(v) => (b.opacityJitter = v)} />
    <label class="field">
      <span>Grain</span>
      <select value={b.grain ?? ''} onchange={(e) => (b.grain = (e.currentTarget.value || null) as GrainId | null)}>
        <option value="">None</option>
        {#each GRAINS as g}<option value={g}>{GRAIN_LABEL[g]}</option>{/each}
      </select>
    </label>
    {#if b.grain}
      <Slider wide={stacked} label="Grain size" value={b.grainScale ?? 1} min={0.1} max={10} step={0.1} width={90} title="Size of the grain pattern, in brush diameters" oninput={(v) => (b.grainScale = v)} />
      <Slider wide={stacked} label="Grain depth" value={b.grainStrength ?? 0.5} min={0} max={1} step={0.01} percent width={90} oninput={(v) => (b.grainStrength = v)} />
    {/if}
  </div>
{/snippet}

{#snippet shapeOpts()}
  {#if ed.tool === 'shape' && stacked}
    <div class="kinds" role="radiogroup" aria-label="Shape">
      {#each DRAW_KINDS as k}
        <button
          class="icon chip"
          class:on={ed.shapeKind === k}
          role="radio"
          aria-checked={ed.shapeKind === k}
          title={SHAPE_LABEL[k]}
          aria-label={SHAPE_LABEL[k]}
          onclick={() => {
            ed.shapeKind = k;
            engine?.shapes.deselect();
          }}
        >
          <Icon name={k} />
        </button>
      {/each}
    </div>
  {/if}
  {#if ed.tool === 'shape' && !stacked}
    <span class="kindname">{#if ed.shapeKind === 'custom'}<PresetIcon preset={ed.shapeStyle.preset} />{CUSTOM_LABEL[ed.shapeStyle.preset]}{:else}<Icon name={ed.shapeKind} />{SHAPE_LABEL[ed.shapeKind]}{/if}</span>
  {/if}
  {#if ed.pointEdit && !stacked}
    <span class="kindname">Points</span>
  {/if}
  {#if selShapes.length && !stacked}
    <!-- With a selection, the options below change it (also with the Shapes tool). -->
    <span class="selname" title="The options change the selected shapes">
      {ed.tool === 'shape' || ed.tool === 'pen' ? 'Editing: ' : ''}{selShapes.length === 1 ? selShapes[0].name || shapeLabel(selShapes[0]) : `${selShapes.length} shapes`}
    </span>
  {/if}
  {#if showStyle}
    <div class="colorsrow">
      {#if has('rect', 'ellipse', 'polygon', 'star', 'path', 'compound', 'custom')}
        <span class="field"><span>Fill</span><ShapeColor big={stacked} label="Fill" value={st.fill} oninput={(v) => setFill(v, true)} onchange={(v) => setFill(v)} /></span>
      {/if}
      <span class="field"><span>Stroke</span><ShapeColor big={stacked} label="Stroke" value={st.stroke} oninput={(v) => setStroke(v, true)} onchange={(v) => setStroke(v)} /></span>
    </div>
    {#key `${first?.id}:${ed.selection.length}`}
      <Slider wide={stacked} label="Width" value={st.strokeWidth} min={0.5} max={LIMITS.maxBrushPx} step={0.1} log width={80} title="Stroke width, in screen pixels at the current zoom" oninput={(v) => setWidth(v, true)} onchange={(v) => setWidth(v)} />
    {/key}
    {#if alignable}
      <div class="toggles" role="radiogroup" aria-label="Stroke alignment">
        {#each ALIGNS as [a, label]}
          <button class="icon wide" class:on={st.align === a} role="radio" aria-checked={st.align === a} title="The stroke lies {a === 'center' ? 'on the center of' : `${a}`} the outline" onclick={() => setAlign(a)}>{label}</button>
        {/each}
      </div>
    {/if}
    {#if kind === 'rect' || (selShapes.length && has('rect'))}
      <div class="corners">
        {#key `${first?.id}:${st.radiiLinked}`}
          {#if st.radiiLinked}
            <Slider wide={stacked} label="Radius" value={st.radii[0]} min={0} max={500} step={0.1} log width={70} title="Corner radius, in screen pixels" oninput={(v) => setRadius(null, v, true)} onchange={(v) => setRadius(null, v)} />
          {:else}
            <span class="field">
              <span>Corners</span>
              {#each [0, 1, 2, 3] as i}
                <input
                  type="number"
                  class="num"
                  min="0"
                  step="any"
                  value={round(st.radii[i])}
                  title={['Top left', 'Top right', 'Bottom right', 'Bottom left'][i]}
                  aria-label="{['Top left', 'Top right', 'Bottom right', 'Bottom left'][i]} radius"
                  onchange={(e) => setRadius(i, Math.max(0, +e.currentTarget.value || 0))}
                />
              {/each}
            </span>
          {/if}
        {/key}
        <button class="icon link" class:on={st.radiiLinked} title={st.radiiLinked ? 'One radius for all corners: click to set each corner' : 'Each corner on its own: click for one radius'} aria-label="Link the corner radii" aria-pressed={st.radiiLinked} onclick={() => setLinked(!st.radiiLinked)}>
          <Icon name="link2" />
        </button>
      </div>
    {/if}
    {#key `${first?.id}:${ed.selection.length}`}
      {#if kind === 'polygon' || (selShapes.length && has('polygon'))}
        <Slider wide={stacked} label="Sides" value={st.sides} min={LIMITS.minCorners} max={LIMITS.maxCorners} step={1} width={70} oninput={(v) => setSides(v, true)} onchange={(v) => setSides(v)} />
      {/if}
      {#if kind === 'star' || (selShapes.length && has('star'))}
        <Slider wide={stacked} label="Points" value={st.points} min={LIMITS.minCorners} max={LIMITS.maxCorners} step={1} width={70} oninput={(v) => setPoints(v, true)} onchange={(v) => setPoints(v)} />
        <Slider wide={stacked} label="Inner" value={st.innerRatio} min={0.05} max={1} step={0.01} percent width={70} title="Inner radius, as a percent of the outer radius" oninput={(v) => setInner(v, true)} onchange={(v) => setInner(v)} />
      {/if}
      {#if kind === 'polygon' || kind === 'star' || (selShapes.length && has('polygon', 'star'))}
        <Slider wide={stacked} label="Rounding" value={st.rounding} min={0} max={500} step={0.1} log width={70} title="Corner rounding, in screen pixels" oninput={(v) => setRounding(v, true)} onchange={(v) => setRounding(v)} />
      {/if}
    {/key}
    {#if kind === 'ellipse' || (selShapes.length && has('ellipse'))}
      <span class="field" title="A pie slice: the start and end angle, in degrees (0 is right, clockwise). The same angle twice: the whole ellipse.">
        <span>Arc</span>
        <input type="number" class="num" step="any" value={round(st.arc[0])} aria-label="Arc start, degrees" onchange={(e) => setArc(0, +e.currentTarget.value || 0)} />°
        <span>to</span>
        <input type="number" class="num" step="any" value={round(arcEnd)} aria-label="Arc end, degrees" onchange={(e) => setArc(1, +e.currentTarget.value || 0)} />°
      </span>
      {#key `${first?.id}:${ed.selection.length}`}
        <Slider wide={stacked} label="Hole" value={st.hole} min={0} max={0.99} step={0.01} percent width={70} title="An inner ellipse cut out (a ring), as a percent of the size" oninput={(v) => setHole(v, true)} onchange={(v) => setHole(v)} />
      {/key}
    {/if}
    {#if (kind === 'custom' || (selShapes.length && has('custom'))) && stacked}
      <!-- The phone sheet has room: the outlines as a grid, not a popover. -->
      <div class="presetgrid" role="radiogroup" aria-label="Custom shape">
        {#each CUSTOM_SHAPES as p}
          <button class="icon chip" role="radio" aria-checked={st.preset === p} class:on={st.preset === p} title={CUSTOM_LABEL[p]} aria-label={CUSTOM_LABEL[p]} onclick={() => setPreset(p)}><PresetIcon preset={p} size={20} /></button>
        {/each}
      </div>
    {:else if kind === 'custom' || (selShapes.length && has('custom'))}
      <span class="field popwrap" use:dismiss={{ open: presetOpen, close: () => (presetOpen = false) }}>
        <span>Shape</span>
        <button class="icon wide" class:on={presetOpen} aria-haspopup="menu" aria-expanded={presetOpen} onclick={() => (presetOpen = !presetOpen)}>
          <PresetIcon preset={st.preset} />{CUSTOM_LABEL[st.preset]} ▾
        </button>
        {#if presetOpen}
          <div class="pop left presets" role="menu" data-over-canvas>
            {#each CUSTOM_SHAPES as p}
              <button class="icon cell" role="menuitem" class:on={st.preset === p} title={CUSTOM_LABEL[p]} aria-label={CUSTOM_LABEL[p]} onclick={() => setPreset(p)}><PresetIcon preset={p} size={22} /></button>
            {/each}
          </div>
        {/if}
      </span>
    {/if}
    {#if capped}
      <label class="field" title="What the start of the line shows">
        <span>Start</span>
        <select value={st.arrows[0]} onchange={(e) => setArrow(0, e.currentTarget.value as ArrowKind)}>
          {#each ARROW_KINDS as a}<option value={a}>{ARROW_LABEL[a]}</option>{/each}
        </select>
      </label>
      <label class="field" title="What the end of the line shows">
        <span>End</span>
        <select value={st.arrows[1]} onchange={(e) => setArrow(1, e.currentTarget.value as ArrowKind)}>
          {#each ARROW_KINDS as a}<option value={a}>{ARROW_LABEL[a]}</option>{/each}
        </select>
      </label>
    {/if}
    {#if dashable}
      <label class="field" title="Dashes, in stroke widths: they scale with the stroke">
        <span>Dash</span>
        <select value={dashId} onchange={(e) => setDash(e.currentTarget.value)}>
          {#each DASHES as [id, label]}<option value={id}>{label}</option>{/each}
          {#if dashId === 'custom'}<option value="custom" disabled>Custom</option>{/if}
        </select>
      </label>
    {/if}
    {#if ed.tool === 'pen'}
      <!-- Always shown with the Pen: it sets the curve of the next path (a path keeps the curve it started with). -->
      <div class="toggles" role="radiogroup" aria-label="New points" title="The curve of the next path you draw">
        <span class="lbl2">New points</span>
        <button class="icon wide" class:on={ed.penStyle.curve !== 'spline'} role="radio" aria-checked={ed.penStyle.curve !== 'spline'} title="Bezier: click for corners, drag for curves with handles" onclick={() => (ed.penStyle.curve = 'bezier')}>Bezier</button>
        <button class="icon wide" class:on={ed.penStyle.curve === 'spline'} role="radio" aria-checked={ed.penStyle.curve === 'spline'} title="Spline: a smooth curve through or near the points, without handles" onclick={() => (ed.penStyle.curve = 'spline')}>Spline</button>
      </div>
      {#if ed.penStyle.curve === 'spline'}
        <Slider
          wide={stacked}
          label="Smoothness"
          bind:value={ed.penStyle.smooth}
          min={-1}
          max={1}
          step={0.05}
          percent
          width={80}
          title="New points: -100% the curve goes through them, round · 0 a sharp corner · 100% the curve bends toward them (soft)"
        />
      {/if}
    {/if}
    {#if canCombine}
      <div class="toggles" role="group" aria-label="Combine">
        <span class="lbl2">Combine</span>
        {#each COMPOUND_OPS as op}
          <button class="icon wide" disabled={!ed.canEdit} title="{OP_TITLE[op]}. The shapes stay live: double-click to change them." onclick={() => engine?.shapes.combine(op)}>{OP_LABEL[op]}</button>
        {/each}
      </div>
    {:else if compounds.length && ed.tool === 'select'}
      <div class="toggles" role="radiogroup" aria-label="Compound">
        {#each COMPOUND_OPS as op}
          <button class="icon wide" class:on={compoundOp === op} role="radio" aria-checked={compoundOp === op} disabled={!ed.canEdit} title={OP_TITLE[op]} onclick={() => engine?.shapes.setCompoundOp(op)}>{OP_LABEL[op]}</button>
        {/each}
      </div>
      <div class="toggles">
        {#if compounds.length === 1}
          <button class="icon wide" disabled={!ed.canEdit} title="Select and change the shapes in it (or double-click it)" onclick={() => engine?.shapes.enterParts(compounds[0].id)}>Edit parts</button>
        {/if}
        <button class="icon wide" disabled={!ed.canEdit} title="Make the parts separate shapes again" onclick={() => engine?.shapes.release()}>Release</button>
        <button class="icon wide" disabled={!ed.canEdit} title="Make the result one path: the parts are no longer live. Undo turns it back." onclick={() => engine?.shapes.flatten()}>Flatten to one path</button>
      </div>
    {:else if partInfo && ed.tool === 'select'}
      {#if partInfo.first}
        <span class="lbl2" title="The other parts combine with the bottom part">Bottom part: the base</span>
      {:else}
        <div class="toggles" role="radiogroup" aria-label="Part op">
          <span class="lbl2">Part</span>
          {#each COMPOUND_OPS as op}
            <button class="icon wide" class:on={partInfo.op === op} role="radio" aria-checked={partInfo.op === op} disabled={!ed.canEdit} title={OP_TITLE[op]} onclick={() => engine?.shapes.setPartOp(op)}>{OP_LABEL[op]}</button>
          {/each}
        </div>
      {/if}
    {/if}
    {#if selShapes.length === 1 && selShapes[0].kind === 'path' && ed.tool === 'select'}
      <div class="toggles" role="radiogroup" aria-label="Curve">
        <span class="lbl2">Curve</span>
        <button class="icon wide" class:on={selShapes[0].curve !== 'spline'} role="radio" aria-checked={selShapes[0].curve !== 'spline'} title="Bezier: points with handles" onclick={() => engine?.shapes.setCurve('bezier')}>Bezier</button>
        <button class="icon wide" class:on={selShapes[0].curve === 'spline'} role="radio" aria-checked={selShapes[0].curve === 'spline'} title="Spline: smooth curves through or near the points (double-click to set each point)" onclick={() => engine?.shapes.setCurve('spline')}>Spline</button>
      </div>
    {/if}
    {#if capped || (dashable && st.dash.length > 0)}
      <div class="toggles" role="radiogroup" aria-label="Line caps">
        {#each CAPS as [c, label]}
          <button class="icon wide" class:on={st.cap === c} role="radio" aria-checked={st.cap === c} title="{label} line ends" onclick={() => setCap(c)}>{label}</button>
        {/each}
      </div>
    {/if}
  {/if}
  {#if ed.tool === 'pen'}
    <span class="hint" use:fullTitle>
      {ed.penDrawing && ed.penStyle.curve === 'spline'
        ? 'Click: a point · Drag: place it · Click the first point: close · Enter: finish · Backspace: last point · Double-click a point later to set its smoothness'
        : ed.penDrawing
        ? 'Click: a corner · Drag: a curve point · Alt+drag: break the handles · Click the first point: close · Enter: finish · Backspace: last point'
        : selShapes.length === 1
          ? 'Click its outline: add a point · Click a point: remove it · Click elsewhere: a new path'
          : 'Click: a corner point · Drag: a curve point with handles'}
    </span>
  {:else if ed.partsOf && !ed.pointEdit}
    <span class="hint" use:fullTitle>Parts: click one to select it · Drag: move · Double-click: its points · Delete: remove it · Esc: done</span>
  {:else if ed.pointEdit}
    <span class="hint" use:fullTitle>Drag points and handles · Alt+drag a handle: break it · Double-click a point: corner or smooth · Double-click the outline: add a point · Delete: remove · Enter or Esc: done</span>
  {:else if ed.tool === 'shape'}
    <span class="hint" use:fullTitle>{kind === 'line' ? 'Shift: 45° steps · Alt: from the center' : 'Shift: square · Alt: from the center'} · Click: a 100 px shape</span>
  {:else if ed.transform}
    <span class="hint" use:fullTitle>The whole layer is the selection: drag inside to move, handles to scale, the round handle to rotate. Click a shape to select it.</span>
  {:else if selShapes.length}
    <span class="hint" use:fullTitle>Drag inside: move · Alt+drag: copy · Handles: scale · Just outside a corner: rotate · Double-click: {selShapes.length === 1 && selShapes[0].kind === 'compound' ? 'parts' : 'points'}</span>
  {:else if activeLayer && activeLayer.kind !== 'shape' && activeLayer.kind !== 'adjust'}
    <span class="hint" use:fullTitle>Click a shape to select it. On a paint layer or a group with paint, Select moves, scales and rotates the whole layer.</span>
  {:else}
    <span class="hint" use:fullTitle>Click a shape to select it · Shift+click: add or remove · Drag on empty canvas: select by rectangle</span>
  {/if}
  {#if ed.tool === 'select'}
    <div class="toggles end">
      <button
        class="icon wide"
        class:on={ed.keepSelection}
        aria-pressed={ed.keepSelection}
        title="While on, clicks outside the box neither select another shape nor deselect. Shift+click still adds or removes; Esc and Deselect still clear."
        onclick={() => (ed.keepSelection = !ed.keepSelection)}>Keep selection</button
      >
      <button
        class="icon wide"
        class:on={ed.addSelection}
        aria-pressed={ed.addSelection}
        title="While on, a click on a shape adds it to the selection or removes it, and a drag on empty canvas adds the shapes in its rectangle: the same as Shift. For touch screens."
        onclick={() => (ed.addSelection = !ed.addSelection)}>Add to selection</button
      >
      <button
        class="icon wide"
        disabled={!selShapes.length || !ed.canEdit || !!ed.partsOf}
        title="Copies of the selected shapes, a little down and right, on top of them (Ctrl+D). Alt+drag a selection to drag a copy away."
        onclick={() => engine?.shapes.duplicate()}>Duplicate</button
      >
      <button
        class="icon wide"
        disabled={!selShapes.length || !ed.canEdit || !!ed.partsOf}
        title="The selected shapes become paint on a new paint layer above: the brush and the erasers work on them. Undo turns them back."
        onclick={() => engine?.convertShapesToPaint()}>To paint layer</button
      >
      <button class="icon wide" disabled={!selShapes.length} title="Deselect (Esc)" onclick={() => engine?.shapes.deselect()}>Deselect (Esc)</button>
    </div>
  {/if}
{/snippet}

<div class="opts" class:stacked use:floating data-over-canvas={stacked ? undefined : true}>
  <span class="tool">{TOOL_LABEL[ed.tool]}</span>
  {#if painting}
    {#if !stacked}
      <span class="popwrap" use:dismiss={{ open: presetsOpen, close: () => (presetsOpen = false) }}>
        <button class="icon wide" class:on={presetsOpen} title="Brush presets, shared by everyone" onclick={() => (presetsOpen = !presetsOpen)}>
          <Icon name="presets" /> Presets
        </button>
        {#if presetsOpen}
          <div class="pop left" data-over-canvas><PresetsPanel /></div>
        {/if}
      </span>
    {/if}
    <Slider wide={stacked} label="Size" bind:value={b.size} min={1} max={LIMITS.maxBrushPx} log width={110} title="Screen pixels at the current zoom. [ and ]" />
    <Slider wide={stacked} label="Opacity" bind:value={b.opacity} min={0.01} max={1} step={0.01} percent title="Keys 1–0. Caps the whole stroke." />
    <Slider wide={stacked} label="Flow" bind:value={b.flow} min={0.005} max={1} step={0.001} percent log title="Shift+1–0. Paint per dab: builds up where dabs overlap." />
    <Slider wide={stacked} label="Hardness" bind:value={b.hardness} min={0} max={1} step={0.01} percent title="Shift+[ and Shift+]" />
    <Slider wide={stacked} label="Spacing" bind:value={b.spacing} min={0.01} max={2} step={0.001} percent log width={70} title="Distance between dabs, as a percent of the diameter" />
    <Slider wide={stacked} label="Smoothing" bind:value={ed.smoothing} min={0} max={0.95} step={0.01} percent width={60} />
    <label class="field" title="Brush tip">
      <span>Tip</span>
      <select value={b.tip ?? 'round'} onchange={(e) => (b.tip = e.currentTarget.value as BrushTip)}>
        {#each BRUSH_TIPS as t}<option value={t}>{TIP_LABEL[t]}</option>{/each}
      </select>
    </label>
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
      {#if touchScreen}
        <button
          class="icon wide"
          class:on={ed.touchPressure}
          title="Finger pressure: the screen's touch pressure where it has one, else the touch size (press harder for more)"
          onclick={() => (ed.touchPressure = !ed.touchPressure)}
        >
          Finger pressure
        </button>
      {/if}
      {#if !stacked}
        <span class="popwrap" use:dismiss={{ open: dynamicsOpen, close: () => (dynamicsOpen = false) }}>
          <button class="icon wide" class:on={dynamicsOn} title="Angle, roundness, jitter, scatter and grain" onclick={(e) => {
            dynamicsLeft = e.currentTarget.getBoundingClientRect().right < 300;
            dynamicsOpen = !dynamicsOpen;
          }}>
            <Icon name="dynamics" /> Dynamics
          </button>
          {#if dynamicsOpen}
            <div class="pop" data-over-canvas class:left={dynamicsLeft}>{@render dynamics()}</div>
          {/if}
        </span>
      {/if}
    </div>
    {#if stacked}
      <h4 class="sub">Dynamics</h4>
      {@render dynamics()}
      <h4 class="sub">Presets</h4>
      <PresetsPanel stacked />
    {/if}
  {:else if ed.tool === 'strokeEraser'}
    <Slider wide={stacked} label="Size" bind:value={ed.strokeEraserSize} min={2} max={400} log width={110} title="Circle diameter in screen pixels" />
    <div class="toggles">
      <button class="icon wide" class:on={ed.strokeEraserAll} title="Remove strokes on every visible layer" onclick={() => (ed.strokeEraserAll = true)}>All layers</button>
      <button class="icon wide" class:on={!ed.strokeEraserAll} title="Remove strokes on the active layer only (its mask, when you paint the mask)" onclick={() => (ed.strokeEraserAll = false)}>
        Active layer
      </button>
    </div>
    <span class="hint" use:fullTitle>Removes every stroke whose path the circle touches. Undo brings them back.</span>
  {:else if ed.tool === 'select' || ed.tool === 'shape' || ed.tool === 'pen'}
    {@render shapeOpts()}
  {:else if ed.tool === 'eyedropper'}
    <span class="hint" use:fullTitle>Click the canvas to pick a color from all layers. Hold Alt with the brush for a quick pick.</span>
  {:else if ed.tool === 'zoom'}
    <div class="toggles">
      <button class="icon wide" title="Zoom out (Ctrl+−)" onclick={() => engine?.zoomBy(0.5)}>−</button>
      <button class="icon wide" title="Zoom in (Ctrl+=)" onclick={() => engine?.zoomBy(2)}>+</button>
      <button class="icon wide" title="Actual size (Ctrl+1)" onclick={() => engine?.resetView()}>100%</button>
      <button class="icon wide" title="Fit everything (Ctrl+0)" onclick={() => engine?.fitAll()}>Fit all</button>
    </div>
    <span class="hint" use:fullTitle>Click to zoom in. Alt+click or right-click to zoom out. Drag right or left to zoom smoothly.</span>
  {:else}
    <span class="hint" use:fullTitle>Drag to pan. Hold Space with any tool to pan. Scroll to zoom.</span>
  {/if}
</div>

<style>
  .opts {
    /* Floats over the top of the canvas, between the toolbar and the panels (Editor.svelte). */
    position: absolute;
    top: 6px;
    left: 6px;
    right: 6px;
    z-index: 20;
    display: flex;
    flex-wrap: wrap; /* never cut off controls: a narrow window gets a second row */
    align-items: center;
    gap: 4px 16px;
    min-height: 38px;
    padding: 4px 12px;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
  }
  .tool {
    font-weight: 600;
    min-width: 66px;
  }
  .stacked {
    position: static;
    /* auto, not 0: in the phone sheet (a scrolling flex column) the options must not shrink below
       their content, or the sections draw over each other. */
    min-height: auto;
    border-radius: 0;
    box-shadow: none;
    flex-wrap: nowrap;
    flex-direction: column;
    align-items: stretch;
    gap: 6px;
    padding: 4px 16px 12px;
    border: none;
    overflow: visible;
    background: none;
  }
  .stacked .tool {
    display: none;
  }
  .stacked .toggles {
    margin-top: 6px;
  }
  .stacked .wide {
    flex: 1;
    height: 36px;
    font-size: 12px;
  }
  .toggles {
    display: flex;
    gap: 4px;
  }
  .wide {
    width: auto;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    white-space: nowrap;
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
  /* One line: a hint that wrapped would add a row and move the canvas (also mid-gesture, when
     the hint changes). The full text shows on hover. */
  .hint {
    color: var(--text-dim);
    flex: 1 1 0;
    min-width: 120px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .stacked .hint {
    white-space: normal;
  }
  .lbl2 {
    color: var(--text-dim);
    margin-right: 4px;
    align-self: center;
  }
  .kindname {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-weight: 600;
    margin-left: -8px;
  }
  .selname {
    margin-left: -8px;
    max-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .colorsrow,
  .corners {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .corners {
    gap: 4px;
  }
  .num {
    width: 46px;
    text-align: right;
    padding: 2px 4px;
  }
  .link {
    width: 24px;
    height: 24px;
  }
  .link:global(.on) {
    color: var(--text);
    border: 1px solid var(--accent-dim);
    background: #24394c;
  }
  .end {
    margin-left: auto;
  }
  .kinds {
    display: flex;
    justify-content: space-between;
    gap: 4px;
    margin-bottom: 4px;
  }
  .chip {
    flex: 1;
    height: 40px;
    border: 1px solid var(--line);
    border-radius: 8px;
  }
  .chip:global(.on) {
    color: #fff;
    border-color: var(--accent);
    background: #1f6fb0;
  }
  .stacked .colorsrow {
    justify-content: flex-start;
    gap: 24px;
  }
  .stacked .end {
    margin-left: 0;
  }
  .field {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--text-dim);
    white-space: nowrap;
  }
  .stacked .field {
    justify-content: space-between;
  }
  .popwrap {
    position: relative;
  }
  .sub {
    margin: 10px 0 0;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-dim);
  }
  .pop.left {
    left: 0;
    right: auto;
  }
  .presetgrid {
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: 4px;
  }
  .presetgrid .chip {
    width: auto;
    height: 40px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .pop.presets {
    display: grid;
    grid-template-columns: repeat(6, 36px);
    gap: 4px;
    padding: 8px;
  }
  .pop.presets .cell {
    width: 36px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .pop {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 30;
    max-height: calc(100dvh - 140px);
    overflow-y: auto;
    padding: 10px 12px;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  }
  .dyn {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 230px;
  }
  .dyn.stacked {
    min-width: 0;
    padding: 0;
  }
</style>
