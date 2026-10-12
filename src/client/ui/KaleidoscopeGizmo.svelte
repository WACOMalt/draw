<script lang="ts">
  // The kaleidoscope gizmo: on the canvas while the effects window shows a layer with an enabled
  // kaleidoscope. It sets the step transform that each copy applies once more:
  //   round handle: the pivot (turn and scale about it)
  //   square: the move of each step (from the pivot)
  //   arrow tip: where the step takes the reference point (a fixed arm right of the pivot):
  //     its direction is the angle, its length the scale (Shift: 15° steps)
  // Dots show where each copy takes the reference point and the pivot.
  import { kaleidoscopeStep } from '../../shared/effects';
  import { compose } from '../../shared/layers';
  import type { Affine, LayerEffect } from '../../shared/types';
  import type { Engine } from '../engine/engine';
  import { ed } from '../state.svelte';

  let { engine }: { engine: Engine } = $props();

  const layer = $derived(ed.layers.find((l) => l.id === ed.effectsLayer) ?? null);
  const saved = $derived(layer?.effects?.find((e) => e.type === 'kaleidoscope' && e.enabled) ?? null);
  /** While a handle moves: the effect as it is being set (changes go out every 60 ms). */
  let live = $state<LayerEffect | null>(null);
  const fx = $derived(live ?? saved);

  /** The reference arm: 80 screen px right of the pivot. */
  const ARM = 80;
  const z = $derived(ed.view.zoom);
  const sx = (x: number) => (x - ed.view.x) * z;
  const sy = (y: number) => (y - ed.view.y) * z;
  const apply = (m: Affine, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

  const geo = $derived.by(() => {
    if (!fx) return null;
    const cx = fx.cx ?? 0, cy = fx.cy ?? 0;
    const arm = ARM / z;
    const step = kaleidoscopeStep(fx);
    const tip = apply(step, cx + arm, cy);
    const dots: { ref: [number, number]; piv: [number, number] }[] = [];
    let m: Affine = step;
    for (let i = 0; i < Math.min(64, fx.count ?? 0); i++) {
      dots.push({ ref: apply(m, cx + arm, cy), piv: apply(m, cx, cy) });
      m = compose(step, m);
    }
    return { cx, cy, arm, tip, move: [cx + (fx.dx ?? 0), cy + (fx.dy ?? 0)] as [number, number], dots };
  });

  let root = $state<HTMLDivElement>()!;
  let drag: { kind: 'pivot' | 'move' | 'tip'; id: number } | null = null;
  let timer: number | undefined;

  function world(e: PointerEvent): [number, number] {
    const r = root.getBoundingClientRect();
    return [ed.view.x + (e.clientX - r.left) / z, ed.view.y + (e.clientY - r.top) / z];
  }

  function send() {
    if (timer !== undefined) return;
    timer = window.setTimeout(() => {
      timer = undefined;
      if (!layer || !live) return;
      const list = ($state.snapshot(layer.effects) as LayerEffect[]).map((e) => (e.type === 'kaleidoscope' ? ($state.snapshot(live) as LayerEffect) : e));
      engine.setEffects(layer.id, list);
    }, 60);
  }

  function down(e: PointerEvent, kind: 'pivot' | 'move' | 'tip') {
    if (e.button !== 0 || !saved || !ed.canEdit) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    live = { ...($state.snapshot(saved) as LayerEffect) };
    drag = { kind, id: e.pointerId };
  }

  function move(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.id || !live) return;
    const [x, y] = world(e);
    if (drag.kind === 'pivot') {
      live.cx = x;
      live.cy = y;
    } else if (drag.kind === 'move') {
      live.dx = x - (live.cx ?? 0);
      live.dy = y - (live.cy ?? 0);
    } else {
      // The tip, from the moved pivot: its direction is the angle, its length the scale.
      const vx = x - (live.cx ?? 0) - (live.dx ?? 0), vy = y - (live.cy ?? 0) - (live.dy ?? 0);
      let a = (Math.atan2(vy, vx) * 180) / Math.PI;
      if (e.shiftKey) a = Math.round(a / 15) * 15;
      live.angle = Math.round(a * 100) / 100;
      live.scale = Math.min(100, Math.max(0.01, Math.hypot(vx, vy) / (ARM / z)));
    }
    send();
  }

  function up(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    // The last change goes out now; the layer then shows it.
    window.clearTimeout(timer);
    timer = undefined;
    if (layer && live) {
      const list = ($state.snapshot(layer.effects) as LayerEffect[]).map((x) => (x.type === 'kaleidoscope' ? ($state.snapshot(live) as LayerEffect) : x));
      engine.setEffects(layer.id, list);
    }
    live = null;
  }
</script>

{#if geo}
  <div class="gizmo" bind:this={root} role="presentation" onpointermove={move} onpointerup={up} onpointercancel={up}>
    <svg>
      {#each geo.dots as d, i (i)}
        <circle class="dot" cx={sx(d.ref[0])} cy={sy(d.ref[1])} r="3" />
        {#if fx && (fx.dx || fx.dy)}<circle class="dot piv" cx={sx(d.piv[0])} cy={sy(d.piv[1])} r="2" />{/if}
      {/each}
      <!-- The reference arm, and the step: pivot + move, then the tip. -->
      <line class="arm" x1={sx(geo.cx)} y1={sy(geo.cy)} x2={sx(geo.cx) + ARM} y2={sy(geo.cy)} />
      <line class="link" x1={sx(geo.cx)} y1={sy(geo.cy)} x2={sx(geo.move[0])} y2={sy(geo.move[1])} />
      <line class="step" x1={sx(geo.move[0])} y1={sy(geo.move[1])} x2={sx(geo.tip[0])} y2={sy(geo.tip[1])} />
      <rect
        class="handle"
        x={sx(geo.move[0]) - 6}
        y={sy(geo.move[1]) - 6}
        width="12"
        height="12"
        role="presentation"
        onpointerdown={(e) => down(e, 'move')}><title>Move each step</title></rect
      >
      <circle class="handle tip" cx={sx(geo.tip[0])} cy={sy(geo.tip[1])} r="8" role="presentation" onpointerdown={(e) => down(e, 'tip')}
        ><title>Turn and scale each step (Shift: 15° steps)</title></circle
      >
      <circle class="handle pivot" cx={sx(geo.cx)} cy={sy(geo.cy)} r="9" role="presentation" onpointerdown={(e) => down(e, 'pivot')}><title>The pivot</title></circle>
      <circle class="pivdot" cx={sx(geo.cx)} cy={sy(geo.cy)} r="2.5" />
    </svg>
  </div>
{/if}

<style>
  .gizmo {
    position: absolute;
    inset: 0;
    z-index: 6;
    pointer-events: none;
  }
  svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
  }
  .arm {
    stroke: var(--accent);
    stroke-width: 1.5;
    stroke-dasharray: 4 4;
    opacity: 0.7;
  }
  .link {
    stroke: var(--accent);
    stroke-width: 1;
    opacity: 0.6;
  }
  .step {
    stroke: var(--accent);
    stroke-width: 2;
  }
  .dot {
    fill: var(--accent);
    opacity: 0.7;
  }
  .dot.piv {
    fill: #fff;
    stroke: var(--accent);
    stroke-width: 1;
  }
  .handle {
    fill: #fff;
    stroke: var(--accent);
    stroke-width: 2;
    pointer-events: all;
    cursor: grab;
    touch-action: none;
  }
  .handle.pivot {
    fill: rgba(255, 255, 255, 0.85);
    cursor: move;
  }
  .handle.tip {
    fill: var(--accent);
  }
  .pivdot {
    fill: var(--accent);
    pointer-events: none;
  }
  @media (pointer: coarse) {
    .handle {
      transform-box: fill-box;
      transform-origin: center;
      transform: scale(1.6);
    }
  }
</style>
