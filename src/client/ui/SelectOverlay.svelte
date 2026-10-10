<script lang="ts">
  // What the Select, Pen and Shapes tools show over the canvas: the hover outline and name, the
  // selection box with its handles, the corner radius dots, the selection rectangle, the live
  // numbers, and for point editing and the Pen the points, their handles and a bar of actions.
  // The canvas part draws only: the engine handles the pointer (shapeTool.ts makes ed.overlay).
  import type { Engine } from '../engine/engine';
  import { CORNER, SMOOTH } from '../engine/pathEdit';
  import { ed } from '../state.svelte';

  let { engine }: { engine: Engine | null } = $props();

  const o = $derived(ed.overlay);
  const coarse = matchMedia('(pointer: coarse)').matches;
  const hs = coarse ? 9 : 4.5; // half the handle size
</script>

{#if o}
  <svg class="overlay" aria-hidden="true">
    {#each o.outlines as d}<path class="sel" {d} />{/each}
    {#if o.hover}{#each o.hover.outline as d}<path class="hover" {d} />{/each}{/if}
    {#if o.box}
      <polygon class="box" points={o.box.map((p) => p.join(',')).join(' ')} />
    {/if}
    {#each o.handles as [x, y], i (i)}
      {#if coarse}<circle class="handle" cx={x} cy={y} r={i < 4 ? hs : hs - 2} />{:else}<rect class="handle" x={x - hs} y={y - hs} width={hs * 2} height={hs * 2} />{/if}
    {/each}
    {#each o.dots as [x, y], i (i)}<circle class="dot" cx={x} cy={y} r={coarse ? 7 : 4} />{/each}
    {#each o.ends as [x, y], i (i)}<circle class="handle" cx={x} cy={y} r={coarse ? 9 : 5} />{/each}
    {#if o.rubber}<path class="rubber" d={o.rubber} />{/if}
    {#each o.knobs as k, i (i)}
      <line class="stem" x1={k.ax} y1={k.ay} x2={k.x} y2={k.y} />
      <circle class="knob" cx={k.x} cy={k.y} r={coarse ? 8 : 3.5} />
    {/each}
    {#each o.anchors as a, i (i)}
      {#if a.smooth}
        <circle class="anchor" class:on={a.sel} cx={a.x} cy={a.y} r={coarse ? 9 : 4} />
      {:else}
        <rect class="anchor" class:on={a.sel} x={a.x - (coarse ? 8 : 4)} y={a.y - (coarse ? 8 : 4)} width={coarse ? 16 : 8} height={coarse ? 16 : 8} />
      {/if}
    {/each}
    {#if o.marquee}
      <rect class="marquee" x={o.marquee[0]} y={o.marquee[1]} width={o.marquee[2]} height={o.marquee[3]} />
    {/if}
  </svg>
  {#if o.tip}
    <div class="label" style:transform="translate({o.tip.x}px, {o.tip.y}px)">{o.tip.text}</div>
  {/if}
  {#if o.bar && engine}
    <div class="bar" role="toolbar" aria-label={o.bar.kind === 'pen' ? 'Pen' : 'Points'}>
      {#if o.bar.kind === 'points'}
        <span class="info">{o.bar.selected ? `${o.bar.selected} of ${o.bar.points} points` : `${o.bar.points} points · click one to select it`}</span>
        <button disabled={!o.bar.selected} title="Corner: the handles move on their own" onclick={() => engine.shapes.setPointType(CORNER)}>Corner</button>
        <button disabled={!o.bar.selected} title="Smooth: the handles stay on one line" onclick={() => engine.shapes.setPointType(SMOOTH)}>Smooth</button>
        <button disabled={!o.bar.selected} title="Delete the points (Delete)" onclick={() => engine.shapes.deletePoints()}>Delete</button>
        <button class="primary" title="Back to the whole shape (Enter or Esc)" onclick={() => engine.shapes.exitPoints()}>Done</button>
      {:else}
        <span class="info">{o.bar.points} point{o.bar.points === 1 ? '' : 's'}</span>
        <button disabled={o.bar.points < 2} title="Take back the last point (Backspace)" onclick={() => engine.shapes.penUndoPoint()}>Undo point</button>
        <button disabled={o.bar.points < 3} title="Join the last point to the first and end the path" onclick={() => engine.shapes.penClose()}>Close</button>
        <button class="primary" title="End the path (Enter)" onclick={() => engine.shapes.finishPen()}>Done</button>
      {/if}
    </div>
  {/if}
  {#if o.hover}
    <div class="label" style:transform="translate({o.hover.x + 14}px, {o.hover.y + 18}px)">Click: select {o.hover.label}</div>
  {/if}
  {#if o.readout}
    <div class="label readout" style:transform="translate({o.readout.x}px, {o.readout.y}px)">{o.readout.text}</div>
  {/if}
{/if}

<style>
  .overlay {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    overflow: visible;
    z-index: 3;
  }
  path,
  polygon,
  rect,
  circle {
    vector-effect: non-scaling-stroke;
  }
  .sel {
    fill: none;
    stroke: var(--accent);
    stroke-width: 1;
  }
  .hover {
    fill: none;
    stroke: var(--accent);
    stroke-width: 2;
  }
  .box {
    fill: rgba(49, 168, 255, 0.05);
    stroke: var(--accent);
    stroke-width: 1.2;
  }
  .handle {
    fill: #fff;
    stroke: var(--accent);
    stroke-width: 1.4;
  }
  .dot {
    fill: var(--accent);
    stroke: #fff;
    stroke-width: 1.5;
  }
  .rubber {
    fill: none;
    stroke: var(--accent);
    stroke-width: 1.2;
    stroke-dasharray: 5 4;
  }
  .stem {
    stroke: var(--accent);
    stroke-width: 1;
  }
  .knob {
    fill: #fff;
    stroke: var(--accent);
    stroke-width: 1.2;
  }
  .anchor {
    fill: #fff;
    stroke: var(--accent);
    stroke-width: 1.4;
  }
  .anchor.on {
    fill: var(--accent);
  }
  .bar {
    position: absolute;
    left: 50%;
    bottom: 12px;
    z-index: 6;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    max-width: calc(100% - 16px);
    flex-wrap: wrap;
    justify-content: center;
    border-radius: 10px;
    background: rgba(30, 30, 30, 0.92);
    border: 1px solid var(--line);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    pointer-events: auto;
  }
  .info {
    color: var(--text-dim);
    font-size: 11px;
    margin-right: 4px;
  }
  @media (pointer: coarse) {
    .bar button {
      min-height: 40px;
    }
  }
  .marquee {
    fill: rgba(49, 168, 255, 0.08);
    stroke: var(--accent);
    stroke-width: 1;
    stroke-dasharray: 4 3;
  }
  .label {
    position: absolute;
    left: 0;
    top: 0;
    z-index: 4;
    pointer-events: none;
    padding: 3px 8px;
    border-radius: 4px;
    background: rgba(20, 20, 20, 0.92);
    color: var(--text);
    font-size: 11px;
    white-space: nowrap;
  }
  .readout {
    font-variant-numeric: tabular-nums;
  }
</style>
