<script lang="ts">
  // The kaleidoscope gizmo: on the canvas while the effects window shows a layer with an enabled
  // kaleidoscope. It sets the step transform that each copy applies once more:
  //   round handle: the pivot (turn and scale about it)
  //   square: the move of each step (from the pivot)
  //   arrow tip: where the step takes the reference point (a fixed arm right of the pivot):
  //     its direction is the angle, its length the scale (Shift: 15° steps)
  // The square and the tip drag relative to where the drag started, and the step changes by the
  // pointer's change divided by the count: copy n applies the step n times, so this way the last
  // copy follows the pointer (turned as far, grown as much, moved about as far), and a small
  // change no longer throws the far copies across the canvas. Alt: 10× finer still.
  // Dots show where each copy takes the reference point and the pivot.
  //
  // On a 3D layer (or a group of 3D layers), when the server takes 3D steps, the step turns in 3D
  // too: a ball at the step turns it freely, the red bar about x, the green bar about y (each
  // divided among the copies as above; Shift: 15° steps), and the tip's turn goes about the axis
  // out of the paper. The dots then follow the copies in 3D, seen straight on.
  import { kaleidoscopeCopies, kaleidoscopeCopies3, kaleidoscopeStep3, kaleidoscopeTurn } from '../../shared/effects';
  import { applyM3, quatAxisAngle, quatMul, quatPow, trackball, QUAT_ID, type Quat } from '../../shared/transform3';
  import { allThreeD } from '../../shared/layers';
  import type { Affine, LayerEffect } from '../../shared/types';
  import type { Engine } from '../engine/engine';
  import { ed } from '../state.svelte';

  let { engine }: { engine: Engine } = $props();

  const layer = $derived(ed.layers.find((l) => l.id === ed.effectsLayer) ?? null);
  const saved = $derived(layer?.effects?.find((e) => e.type === 'kaleidoscope' && e.enabled) ?? null);
  /** While a handle moves: the effect as it is being set (changes go out every 60 ms). */
  let live = $state<LayerEffect | null>(null);
  const fx = $derived(live ?? saved);
  /** The step may turn in 3D: a 3D layer, or a group whose paint layers are all 3D. */
  const three = $derived(!!layer && ed.kaleido3dOk && allThreeD(ed.layers, layer.id));
  /** The tilt controls' radius around the step (px). */
  const BALL = 26;
  const TILT = 46;

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
    const cz = fx.cz ?? 0;
    // In 3D: the points move in 3D and show straight on; else as the paper sees the copies.
    const tip3 = applyM3(kaleidoscopeStep3(fx), cx + arm, cy, cz);
    const tip: [number, number] = [tip3[0], tip3[1]];
    const dots = three
      ? kaleidoscopeCopies3(fx).map((m) => ({ ref: applyM3(m, cx + arm, cy, cz).slice(0, 2) as [number, number], piv: applyM3(m, cx, cy, cz).slice(0, 2) as [number, number] }))
      : kaleidoscopeCopies(fx).map((m) => ({ ref: apply(m, cx + arm, cy), piv: apply(m, cx, cy) }));
    // How far the step tilts out of the paper (degrees), for the readout.
    const t = kaleidoscopeTurn(fx);
    const tilt = Math.round((2 * Math.asin(Math.min(1, Math.hypot(t[0], t[1]))) * 180) / Math.PI);
    return { cx, cy, arm, tip, move: [cx + (fx.dx ?? 0), cy + (fx.dy ?? 0)] as [number, number], dots, tilt };
  });

  let root = $state<HTMLDivElement>()!;
  /**
   * The handle being dragged. For the tip: the angle and scale at the start, and the pointer's
   * turn around the step's pivot so far (degrees, past ±180 too) and distance at the start.
   */
  let drag: {
    kind: 'pivot' | 'move' | 'tip' | 'ball' | 'tiltX' | 'tiltY';
    id: number;
    a0?: number;
    s0?: number;
    turn?: number;
    last?: number;
    r0?: number;
    p0?: [number, number];
    m0?: [number, number];
    /** 3D: the step's turn at the start, the pointer's turn so far (screen px for the ball). */
    q0?: Quat;
    q?: Quat;
    s?: [number, number];
  } | null = null;
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

  function down(e: PointerEvent, kind: 'pivot' | 'move' | 'tip' | 'ball' | 'tiltX' | 'tiltY') {
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
    if (kind === 'move') drag = { ...drag, p0: world(e), m0: [live.dx ?? 0, live.dy ?? 0] };
    // 3D turns: relative to the step's turn at the start (an angle becomes a turn).
    if (kind === 'ball' || kind === 'tiltX' || kind === 'tiltY') drag = { ...drag, q0: kaleidoscopeTurn(live), q: [...QUAT_ID], s: [e.clientX, e.clientY] };
    if (kind === 'tip') {
      const [x, y] = world(e);
      const vx = x - (live.cx ?? 0) - (live.dx ?? 0), vy = y - (live.cy ?? 0) - (live.dy ?? 0);
      // (Not from right at the pivot: the scale would jump.)
      drag = { ...drag, a0: live.angle ?? 0, s0: live.scale ?? 1, turn: 0, last: Math.atan2(vy, vx), r0: Math.max(Math.hypot(vx, vy), ARM / 4 / z), q0: kaleidoscopeTurn(live) };
    }
  }

  function move(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.id || !live) return;
    const [x, y] = world(e);
    if (drag.kind === 'pivot') {
      live.cx = x;
      live.cy = y;
    } else if (drag.kind === 'move') {
      const gain = (e.altKey ? 0.1 : 1) / Math.max(1, live.count ?? 1);
      live.dx = drag.m0![0] + (x - drag.p0![0]) * gain;
      live.dy = drag.m0![1] + (y - drag.p0![1]) * gain;
    } else if (drag.kind !== 'tip') {
      // A 3D turn of the step: the pointer's turn so far, divided among the copies, after the
      // turn at the start (about the paper's axes: the turn is applied after the step's own).
      const gain = (e.altKey ? 0.1 : 1) / Math.max(1, live.count ?? 1);
      const dx = e.clientX - drag.s![0], dy = e.clientY - drag.s![1];
      const snap = (a: number) => (e.shiftKey ? Math.round(a / (Math.PI / 12)) * (Math.PI / 12) : a);
      let q: Quat;
      if (drag.kind === 'ball') {
        drag.q = quatMul(trackball(dx, dy, BALL), drag.q!);
        drag.s = [e.clientX, e.clientY];
        q = drag.q;
      } else q = drag.kind === 'tiltX' ? quatAxisAngle(-1, 0, 0, snap(dy / BALL)) : quatAxisAngle(0, 1, 0, snap(dx / BALL));
      setTurn(quatMul(quatPow(q, gain), drag.q0!));
    } else {
      // The tip, around the moved pivot: the pointer's turn changes the angle, its distance the
      // scale, divided among the copies (see the top).
      const vx = x - (live.cx ?? 0) - (live.dx ?? 0), vy = y - (live.cy ?? 0) - (live.dy ?? 0);
      const th = Math.atan2(vy, vx);
      let d = th - drag.last!;
      d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
      drag.turn! += (d * 180) / Math.PI;
      drag.last = th;
      const gain = (e.altKey ? 0.1 : 1) / Math.max(1, live.count ?? 1);
      let a = drag.a0! + drag.turn! * gain;
      if (e.shiftKey) a = Math.round(a / 15) * 15;
      a = ((((a + 180) % 360) + 360) % 360) - 180;
      if (live.turn) {
        // A 3D step: the same turn about the axis out of the paper, after its own.
        setTurn(quatMul(quatAxisAngle(0, 0, 1, ((a - drag.a0!) * Math.PI) / 180), drag.q0!));
      } else live.angle = Math.round(a * 1000) / 1000;
      const k = drag.s0! * (Math.max(Math.hypot(vx, vy), 1e-9) / drag.r0!) ** gain;
      live.scale = Math.round(Math.min(100, Math.max(0.01, k)) * 1e5) / 1e5;
    }
    send();
  }

  /**
   * The step's turn: a 3D one (turn, angle 0), or back to an angle when it no longer tilts (so a
   * flat step stays a flat one for older apps).
   */
  function setTurn(q: Quat) {
    if (!live) return;
    if (Math.hypot(q[0], q[1]) > 1e-9) {
      live.turn = q.map((v) => Math.round(v * 1e9) / 1e9) as Quat;
      live.angle = 0;
    } else {
      delete live.turn;
      live.angle = Math.round(((2 * Math.atan2(q[2], q[3]) * 180) / Math.PI) * 1000) / 1000;
    }
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
      {#if !fx?.turn || three}<line class="step" x1={sx(geo.move[0])} y1={sy(geo.move[1])} x2={sx(geo.tip[0])} y2={sy(geo.tip[1])} />{/if}
      <rect
        class="handle"
        x={sx(geo.move[0]) - 6}
        y={sy(geo.move[1]) - 6}
        width="12"
        height="12"
        role="presentation"
        onpointerdown={(e) => down(e, 'move')}><title>Move each step (Alt: finer)</title></rect
      >
      <!-- A 3D step turns in 3D: not from this flat tip (the effects window can flatten it). -->
      {#if !fx?.turn || three}<circle class="handle tip" cx={sx(geo.tip[0])} cy={sy(geo.tip[1])} r="8" role="presentation" onpointerdown={(e) => down(e, 'tip')}
        ><title>Turn and scale each step (Alt: finer; Shift: 15° steps)</title></circle
      >{/if}
      {#if three}
        {@const mx = sx(geo.move[0])}
        {@const my = sy(geo.move[1])}
        <!-- 3D turns of the step, at the step: red about x (drag up and down), green about y (sideways), the ball freely. -->
        <circle class="ball" cx={mx} cy={my} r={BALL} role="presentation" onpointerdown={(e) => down(e, 'ball')}
          ><title>Turn each step in 3D (Alt: finer)</title></circle
        >
        <line class="axis x" x1={mx - TILT} y1={my} x2={mx + TILT} y2={my} />
        <line class="axis y" x1={mx} y1={my - TILT} x2={mx} y2={my + TILT} />
        {#each [-1, 1] as side (side)}
          <circle class="knob x" cx={mx + side * TILT} cy={my} r="5" role="presentation" onpointerdown={(e) => down(e, 'tiltX')}
            ><title>Tilt each step about x: drag up or down (Alt: finer; Shift: 15° steps)</title></circle
          >
          <circle class="knob y" cx={mx} cy={my + side * TILT} r="5" role="presentation" onpointerdown={(e) => down(e, 'tiltY')}
            ><title>Tilt each step about y: drag sideways (Alt: finer; Shift: 15° steps)</title></circle
          >
        {/each}
        {#if geo.tilt}<text class="tilt" x={mx + TILT + 8} y={my - 8}>tilt {geo.tilt}°</text>{/if}
      {/if}
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
  .ball {
    fill: rgba(74, 144, 255, 0.08);
    stroke: rgba(128, 128, 128, 0.9);
    stroke-width: 1.5;
    stroke-dasharray: 3 3;
    pointer-events: all;
    cursor: grab;
    touch-action: none;
  }
  .axis {
    stroke-width: 2;
    pointer-events: none;
  }
  .axis.x,
  .knob.x {
    stroke: #ff5a5f;
  }
  .axis.y,
  .knob.y {
    stroke: #3ccf6e;
  }
  .knob {
    fill: #fff;
    stroke-width: 2;
    pointer-events: all;
    touch-action: none;
  }
  .knob.x {
    cursor: ns-resize;
  }
  .knob.y {
    cursor: ew-resize;
  }
  .tilt {
    fill: #fff;
    font-size: 12px;
    paint-order: stroke;
    stroke: rgba(0, 0, 0, 0.7);
    stroke-width: 3px;
  }
  @media (pointer: coarse) {
    .handle {
      transform-box: fill-box;
      transform-origin: center;
      transform: scale(1.6);
    }
  }
</style>
