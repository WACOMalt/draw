<script lang="ts">
  // What the Select and Shapes tools show over the canvas: the hover outline and name, the
  // selection box with its handles, the corner radius dots, the selection rectangle and the live
  // numbers. Drawing only: the engine handles the pointer (shapeTool.ts makes ed.overlay).
  import { ed } from '../state.svelte';

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
    {#if o.marquee}
      <rect class="marquee" x={o.marquee[0]} y={o.marquee[1]} width={o.marquee[2]} height={o.marquee[3]} />
    {/if}
  </svg>
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
