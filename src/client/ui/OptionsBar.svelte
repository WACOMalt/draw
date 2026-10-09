<script lang="ts">
  import { BRUSH_TIPS, GRAINS, LIMITS, SHAPE_KINDS, type BrushTip, type GrainId, type LineCap, type Shape, type ShapeProps, type StrokeAlign } from '../../shared/types';
  import type { Engine } from '../engine/engine';
  import { SHAPE_LABEL } from '../engine/shapeTool';
  import { ed, type ShapeStyle, type Tool } from '../state.svelte';
  import Icon from './Icon.svelte';
  import PresetsPanel from './PresetsPanel.svelte';
  import ShapeColor from './ShapeColor.svelte';
  import Slider from './Slider.svelte';
  import { dismiss } from '../dismiss';

  let { stacked = false, engine = null }: { stacked?: boolean; engine?: Engine | null } = $props();
  const painting = $derived(ed.tool === 'brush' || ed.tool === 'eraser');
  const TOOL_LABEL: Record<Tool, string> = {
    brush: 'Brush',
    eraser: 'Eraser',
    strokeEraser: 'Stroke eraser',
    eyedropper: 'Eyedropper',
    select: 'Select',
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

  const selShapes = $derived(ed.selection.map((id) => ed.shapes.find((s) => s.id === id)).filter((s): s is Shape => !!s));
  const first = $derived(selShapes[0] ?? null);
  /** Screen pixels per local unit of a shape. */
  const kOf = (s: Shape) => Math.sqrt(Math.abs(s.m[0] * s.m[3] - s.m[1] * s.m[2])) * ed.view.zoom;
  const kind = $derived(first?.kind ?? ed.shapeKind);
  const st = $derived.by((): ShapeStyle => {
    if (!first) return ed.shapeStyle;
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
    };
  });
  const showStyle = $derived(ed.tool === 'shape' || selShapes.length > 0);
  const kinds = $derived(new Set(selShapes.length ? selShapes.map((s) => s.kind) : [ed.shapeKind]));
  const has = (...k: Shape['kind'][]) => k.some((x) => kinds.has(x));
  const round = (v: number) => (v >= 100 ? Math.round(v) : Math.round(v * 10) / 10);

  /**
   * Changes a setting: on the selected shapes (fn gives each one's props, from its pixels per unit;
   * null: not for this kind), and in the style for the next shape. `live`: a drag in progress.
   */
  function setShape(style: Partial<ShapeStyle>, fn: (s: Shape, k: number) => Partial<ShapeProps> | null, live = false) {
    Object.assign(ed.shapeStyle, style);
    if (selShapes.length) engine?.shapes.editSelected((s) => fn(s, kOf(s)), live);
  }
  const setFill = (v: string | null, live = false) => setShape({ fill: v }, (s) => (s.kind === 'line' ? null : { fill: v }), live);
  const setStroke = (v: string | null, live = false) => setShape({ stroke: v }, () => ({ stroke: v }), live);
  const setWidth = (px: number, live = false) =>
    setShape({ strokeWidth: px }, (s, k) => ({ strokeWidth: px / k, ...(s.stroke ? {} : { stroke: ed.shapeStyle.stroke ?? ed.fg }) }), live);
  const setAlign = (a: StrokeAlign) => setShape({ align: a }, (s) => (s.kind === 'line' ? null : { align: a }));
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
  const ALIGNS: [StrokeAlign, string][] = [['inside', 'Inside'], ['center', 'Center'], ['outside', 'Outside']];
  const CAPS: [LineCap, string][] = [['butt', 'Butt'], ['round', 'Round'], ['square', 'Square']];
  const activeLayer = $derived(ed.layers.find((l) => l.id === ed.activeLayerId) ?? null);

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
      {#each SHAPE_KINDS as k}
        <button class="icon chip" class:on={ed.shapeKind === k} role="radio" aria-checked={ed.shapeKind === k} title={SHAPE_LABEL[k]} aria-label={SHAPE_LABEL[k]} onclick={() => (ed.shapeKind = k)}>
          <Icon name={k} />
        </button>
      {/each}
    </div>
  {/if}
  {#if ed.tool === 'shape' && !stacked}
    <span class="kindname"><Icon name={ed.shapeKind} />{SHAPE_LABEL[ed.shapeKind]}</span>
  {:else if ed.tool === 'select' && selShapes.length}
    <span class="selname">{selShapes.length === 1 ? selShapes[0].name || SHAPE_LABEL[selShapes[0].kind] : `${selShapes.length} shapes`}</span>
  {/if}
  {#if showStyle}
    <div class="colorsrow">
      {#if has('rect', 'ellipse', 'polygon', 'star')}
        <span class="field"><span>Fill</span><ShapeColor big={stacked} label="Fill" value={st.fill} oninput={(v) => setFill(v, true)} onchange={(v) => setFill(v)} /></span>
      {/if}
      <span class="field"><span>Stroke</span><ShapeColor big={stacked} label="Stroke" value={st.stroke} oninput={(v) => setStroke(v, true)} onchange={(v) => setStroke(v)} /></span>
    </div>
    {#key `${first?.id}:${ed.selection.length}`}
      <Slider wide={stacked} label="Width" value={st.strokeWidth} min={0.5} max={LIMITS.maxBrushPx} step={0.1} log width={80} title="Stroke width, in screen pixels at the current zoom" oninput={(v) => setWidth(v, true)} onchange={(v) => setWidth(v)} />
    {/key}
    {#if has('rect', 'ellipse', 'polygon', 'star')}
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
            <Slider wide={stacked} label="Radius" value={st.radii[0]} min={0} max={500} step={1} width={70} title="Corner radius, in screen pixels" oninput={(v) => setRadius(null, v, true)} onchange={(v) => setRadius(null, v)} />
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
        <Slider wide={stacked} label="Rounding" value={st.rounding} min={0} max={500} step={1} width={70} title="Corner rounding, in screen pixels" oninput={(v) => setRounding(v, true)} onchange={(v) => setRounding(v)} />
      {/if}
    {/key}
    {#if kind === 'line' || (selShapes.length && has('line'))}
      <div class="toggles" role="radiogroup" aria-label="Line caps">
        {#each CAPS as [c, label]}
          <button class="icon wide" class:on={st.cap === c} role="radio" aria-checked={st.cap === c} title="{label} line ends" onclick={() => setCap(c)}>{label}</button>
        {/each}
      </div>
    {/if}
  {/if}
  {#if ed.tool === 'shape'}
    <span class="hint">{kind === 'line' ? 'Shift: 45° steps · Alt: from the center' : 'Shift: square · Alt: from the center'} · Click: a 100 px shape</span>
  {:else if ed.transform}
    <span class="hint">The whole layer is the selection: drag inside to move, handles to scale, the round handle to rotate. Click a shape to select it.</span>
  {:else if selShapes.length}
    <span class="hint">Drag inside: move · Handles: scale · Just outside a corner: rotate · Double-click: points</span>
  {:else if activeLayer && activeLayer.kind !== 'shape' && activeLayer.kind !== 'adjust'}
    <span class="hint">Click a shape to select it. On a paint layer or a group with paint, Select moves, scales and rotates the whole layer.</span>
  {:else}
    <span class="hint">Click a shape to select it · Shift+click: add or remove · Drag on empty canvas: select by rectangle</span>
  {/if}
  {#if ed.tool === 'select'}
    <div class="toggles end">
      <button
        class="icon wide"
        class:on={ed.keepSelection}
        aria-pressed={ed.keepSelection}
        title="While on, clicks outside the box do not change the selection: only Esc or Deselect do"
        onclick={() => (ed.keepSelection = !ed.keepSelection)}>Keep selection</button
      >
      <button class="icon wide" disabled={!selShapes.length} title="Deselect (Esc)" onclick={() => engine?.shapes.deselect()}>Deselect (Esc)</button>
    </div>
  {/if}
{/snippet}

<div class="opts" class:stacked>
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
    <span class="hint">Removes every stroke whose path the circle touches. Undo brings them back.</span>
  {:else if ed.tool === 'select' || ed.tool === 'shape'}
    {@render shapeOpts()}
  {:else if ed.tool === 'eyedropper'}
    <span class="hint">Click the canvas to pick a color from all layers. Hold Alt with the brush for a quick pick.</span>
  {:else if ed.tool === 'zoom'}
    <div class="toggles">
      <button class="icon wide" title="Zoom out (Ctrl+−)" onclick={() => engine?.zoomBy(0.5)}>−</button>
      <button class="icon wide" title="Zoom in (Ctrl+=)" onclick={() => engine?.zoomBy(2)}>+</button>
      <button class="icon wide" title="Actual size (Ctrl+1)" onclick={() => engine?.resetView()}>100%</button>
      <button class="icon wide" title="Fit everything (Ctrl+0)" onclick={() => engine?.fitAll()}>Fit all</button>
    </div>
    <span class="hint">Click to zoom in. Alt+click or right-click to zoom out. Drag right or left to zoom smoothly.</span>
  {:else}
    <span class="hint">Drag to pan. Hold Space with any tool to pan. Scroll to zoom.</span>
  {/if}
</div>

<style>
  .opts {
    grid-area: opts;
    display: flex;
    flex-wrap: wrap; /* never cut off controls: a narrow window gets a second row */
    align-items: center;
    gap: 4px 16px;
    padding: 4px 12px;
    background: var(--bg-2);
    border-bottom: 1px solid var(--border);
  }
  .tool {
    font-weight: 600;
    min-width: 66px;
  }
  .stacked {
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
  .hint {
    color: var(--text-dim);
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
