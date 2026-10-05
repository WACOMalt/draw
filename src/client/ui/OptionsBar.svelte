<script lang="ts">
  import { BRUSH_TIPS, GRAINS, LIMITS, type BrushTip, type GrainId } from '../../shared/types';
  import { ed } from '../state.svelte';
  import Icon from './Icon.svelte';
  import PresetsPanel from './PresetsPanel.svelte';
  import Slider from './Slider.svelte';

  let { stacked = false }: { stacked?: boolean } = $props();
  const painting = $derived(ed.tool === 'brush' || ed.tool === 'eraser');
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

<div class="opts" class:stacked>
  <span class="tool">{ed.tool === 'eraser' ? 'Eraser' : ed.tool === 'brush' ? 'Brush' : ed.tool === 'eyedropper' ? 'Eyedropper' : 'Hand'}</span>
  {#if painting}
    {#if !stacked}
      <span class="popwrap">
        <button class="icon wide" class:on={presetsOpen} title="Brush presets, shared by everyone" onclick={() => (presetsOpen = !presetsOpen)}>
          <Icon name="presets" /> Presets
        </button>
        {#if presetsOpen}
          <div class="pop left"><PresetsPanel /></div>
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
        <span class="popwrap">
          <button class="icon wide" class:on={dynamicsOn} title="Angle, roundness, jitter, scatter and grain" onclick={(e) => {
            dynamicsLeft = e.currentTarget.getBoundingClientRect().right < 300;
            dynamicsOpen = !dynamicsOpen;
          }}>
            <Icon name="dynamics" /> Dynamics
          </button>
          {#if dynamicsOpen}
            <div class="pop" class:left={dynamicsLeft}>{@render dynamics()}</div>
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
