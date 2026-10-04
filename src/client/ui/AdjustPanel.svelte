<script lang="ts">
  // Settings of the active adjustment layer. Changes go out at most every 60 ms, and the engine
  // merges changes within 2 s into one undo step.
  import type { Adjust, Layer } from '../../shared/types';
  import { toneFunction } from '../engine/adjust';
  import type { Engine } from '../engine/engine';
  import Slider from './Slider.svelte';

  let { engine, layer }: { engine: Engine | null; layer: Layer } = $props();

  // The local copy follows the layer (the effect below), and leads while the person drags.
  // svelte-ignore state_referenced_locally
  let a = $state<Adjust>($state.snapshot(layer.adjust!) as Adjust);
  let dragging = false;
  $effect(() => {
    // $state.snapshot: layer.adjust is a reactive proxy, which structuredClone cannot copy.
    const next = $state.snapshot(layer.adjust!) as Adjust;
    if (!dragging) a = next;
  });

  let timer: number | undefined;
  function send() {
    if (timer !== undefined) return;
    timer = window.setTimeout(() => {
      timer = undefined;
      engine?.setAdjust(layer.id, $state.snapshot(a) as Adjust);
    }, 60);
  }
  const set = (key: string) => (v: number) => {
    (a as Record<string, unknown>)[key] = v;
    send();
  };

  // --- curves editor ---------------------------------------------------------------------------
  const S = 200; // px
  let svg = $state<SVGSVGElement | null>(null);
  let drag = $state<number | null>(null);

  const path = $derived.by(() => {
    if (a.type !== 'curves') return '';
    const f = toneFunction(a)!;
    let d = '';
    for (let i = 0; i <= 64; i++) {
      const x = i / 64;
      d += `${i ? 'L' : 'M'}${(x * S).toFixed(1)},${((1 - Math.min(1, Math.max(0, f(x)))) * S).toFixed(1)}`;
    }
    return d;
  });

  function toUnit(e: PointerEvent): [number, number] {
    const r = svg!.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height))];
  }

  function down(e: PointerEvent) {
    if (a.type !== 'curves') return;
    const [x, y] = toUnit(e);
    const pts = a.points;
    // Grab the nearest point within 8 px, else add one (16 at most).
    let best = -1, bestD = 8 / S;
    pts.forEach(([px, py], i) => {
      const d = Math.hypot(px - x, py - y);
      if (d < bestD) (best = i), (bestD = d);
    });
    if (best < 0) {
      if (pts.length >= 16) return;
      best = pts.findIndex(([px]) => px > x);
      if (best <= 0) return; // keep inside the end points
      pts.splice(best, 0, [x, y]);
      send();
    }
    drag = best;
    dragging = true;
    try {
      svg!.setPointerCapture(e.pointerId);
    } catch {
      // The pointer is already gone: the drag still works inside the editor.
    }
  }

  function move(e: PointerEvent) {
    if (drag === null || a.type !== 'curves') return;
    const [x, y] = toUnit(e);
    const pts = a.points;
    // Stay between the neighbors, so the points keep ascending order.
    const lo = drag > 0 ? pts[drag - 1][0] + 0.01 : 0;
    const hi = drag < pts.length - 1 ? pts[drag + 1][0] - 0.01 : 1;
    pts[drag] = [Math.min(hi, Math.max(lo, x)), y];
    send();
  }

  function up() {
    drag = null;
    dragging = false;
  }

  function remove(i: number) {
    if (a.type !== 'curves' || i === 0 || i === a.points.length - 1) return;
    a.points.splice(i, 1);
    send();
  }
</script>

<div class="adjust">
  {#if a.type === 'levels'}
    <Slider label="In black" value={a.inBlack} min={0} max={0.99} step={0.01} percent width={90} oninput={set('inBlack')} />
    <Slider label="Gamma" value={a.gamma} min={0.1} max={3} step={0.01} width={90} oninput={set('gamma')} />
    <Slider label="In white" value={a.inWhite} min={0.01} max={1} step={0.01} percent width={90} oninput={set('inWhite')} />
    <Slider label="Out black" value={a.outBlack} min={0} max={1} step={0.01} percent width={90} oninput={set('outBlack')} />
    <Slider label="Out white" value={a.outWhite} min={0} max={1} step={0.01} percent width={90} oninput={set('outWhite')} />
  {:else if a.type === 'curves'}
    <svg
      bind:this={svg}
      viewBox="0 0 {S} {S}"
      class="curve"
      role="application"
      aria-label="Curve. Drag a point. Click to add a point. Double-click a point to remove it."
      onpointerdown={down}
      onpointermove={move}
      onpointerup={up}
      onpointercancel={up}
    >
      {#each [0.25, 0.5, 0.75] as g}
        <line x1={g * S} y1="0" x2={g * S} y2={S} class="grid" />
        <line x1="0" y1={g * S} x2={S} y2={g * S} class="grid" />
      {/each}
      <line x1="0" y1={S} x2={S} y2="0" class="diag" />
      <path d={path} class="line" />
      {#each a.points as [x, y], i}
        <circle
          cx={x * S}
          cy={(1 - y) * S}
          r={drag === i ? 6 : 4.5}
          class="pt"
          role="button"
          tabindex="-1"
          ondblclick={() => remove(i)}
        />
      {/each}
    </svg>
    <p class="hint">Drag a point. Click the line to add one. Double-click a point to remove it.</p>
  {:else if a.type === 'hueSat'}
    <Slider label="Hue" value={a.hue} min={-180} max={180} step={1} width={110} oninput={set('hue')} />
    <Slider label="Saturation" value={a.saturation} min={-1} max={1} step={0.01} percent width={110} oninput={set('saturation')} />
    <Slider label="Lightness" value={a.lightness} min={-1} max={1} step={0.01} percent width={110} oninput={set('lightness')} />
  {:else if a.type === 'brightContrast'}
    <Slider label="Brightness" value={a.brightness} min={-1} max={1} step={0.01} percent width={110} oninput={set('brightness')} />
    <Slider label="Contrast" value={a.contrast} min={-1} max={1} step={0.01} percent width={110} oninput={set('contrast')} />
  {/if}
</div>

<style>
  .adjust {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .curve {
    width: 100%;
    max-width: 220px;
    aspect-ratio: 1;
    background: var(--bg-0);
    border: 1px solid var(--border);
    border-radius: 3px;
    touch-action: none;
    cursor: crosshair;
    align-self: center;
  }
  .grid {
    stroke: #333;
    stroke-width: 1;
  }
  .diag {
    stroke: #444;
    stroke-dasharray: 3 3;
  }
  .line {
    fill: none;
    stroke: var(--text);
    stroke-width: 1.5;
  }
  .pt {
    fill: var(--bg-2);
    stroke: var(--accent);
    stroke-width: 2;
    cursor: grab;
  }
  .hint {
    margin: 0;
    font-size: 11px;
    color: var(--text-faint);
  }
</style>
