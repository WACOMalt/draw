<script lang="ts">
  // 3D transform of a 3D layer (engine.takes3d): the paper seen straight on, so depth shows only
  // in numbers. One turn, one uniform scale and a move, about the pivot (the middle of what the
  // layer draws, at the middle of its depth):
  //   drag inside the box: move · Alt+drag: depth (up: toward you) · the box's corners: scale
  //   outer ring (blue): turn about the view axis · ball in the middle: turn freely (trackball)
  //   red bar: turn about x · green bar: turn about y (Shift: 15° steps on the ring and the bars)
  //   bar: depth, reset, cancel, apply · keys: Enter applies, Esc cancels, arrows nudge
  // The transform is m3 = T(pivot + move) · s·R(q) · T(−pivot); Apply sends one layer.transform.
  import { onMount, untrack } from 'svelte';
  import type { Affine3 } from '../../shared/types';
  import { buildM3, quatAxisAngle, quatMul, trackball, QUAT_ID, type Quat } from '../../shared/transform3';
  import type { Engine } from '../engine/engine';
  import type { Bounds } from '../engine/doc';
  import { ed } from '../state.svelte';
  import { closeOnBack } from '../back';

  let { engine, id }: { engine: Engine; id: string } = $props();

  // What the layer draws now, set once: the transform is relative to it.
  const start = (() => engine.contentOf(id))();
  const pivot = (() => engine.pivot3(id) ?? [0, 0, 0])() as [number, number, number];
  /** Half the diagonal of what the layer draws (world), for the size of the gizmo. */
  const reach = start ? Math.hypot(start.x1 - start.x0, start.y1 - start.y0) / 2 : 1;

  let q = $state<Quat>([...QUAT_ID]);
  let s = $state(1);
  let move = $state<[number, number, number]>([0, 0, 0]);

  const M3 = $derived(buildM3(q, s, pivot, move));
  /** World bounds of the preview (what the layer would draw). */
  let box = $state<Bounds | null>(start);
  $effect(() => {
    const m = M3;
    box = untrack(() => engine.previewTransform3(m)) ?? box;
  });

  // Screen (CSS px in the stage) from world, following the view.
  const toScreen = (x: number, y: number): [number, number] => [(x - ed.view.x) * ed.view.zoom, (y - ed.view.y) * ed.view.zoom];
  const center = $derived(toScreen(pivot[0] + move[0], pivot[1] + move[1]));
  /** The ring's radius (px): around everything the layer can turn into, and never tiny. */
  const ring = $derived(Math.max(56, reach * s * ed.view.zoom + 22));
  /** How far inside the ring the axis bars end (px): the ring stays free to grab there. */
  const KNOB = 22;
  /** The trackball's radius (px): small, so most of the box still moves the layer. */
  const ball = $derived(Math.min(56, ring * 0.4));
  const corners = $derived.by((): [number, number][] => {
    const b = box ?? { x0: pivot[0], y0: pivot[1], x1: pivot[0], y1: pivot[1] };
    return [toScreen(b.x0, b.y0), toScreen(b.x1, b.y0), toScreen(b.x1, b.y1), toScreen(b.x0, b.y1)];
  });

  let root = $state<HTMLDivElement>()!;
  type Kind = 'move' | 'depth' | 'scale' | 'spin' | 'ball' | 'tiltX' | 'tiltY';
  /** The drag in progress, the pointer at its start (and last), and the state then. */
  let drag: { kind: Kind; p0: [number, number]; last: [number, number]; q: Quat; s: number; move: [number, number, number] } | null = null;
  /** The live depth readout of an Alt+drag. */
  let depthTip = $state<string | null>(null);

  /** Pointer position in the stage (CSS px). */
  function local(e: PointerEvent): [number, number] {
    const r = root.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  function down(e: PointerEvent, kind: Kind) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      // the pointer is already gone
    }
    if (kind === 'move' && e.altKey) kind = 'depth';
    const p = local(e);
    drag = { kind, p0: p, last: p, q: [...q], s, move: [...move] };
  }

  const snap = (a: number, on: boolean) => (on ? Math.round(a / (Math.PI / 12)) * (Math.PI / 12) : a);

  function pointerMove(e: PointerEvent) {
    if (!drag) return;
    const d = drag;
    const p = local(e);
    const dx = p[0] - d.p0[0], dy = p[1] - d.p0[1];
    const z = ed.view.zoom;
    switch (d.kind) {
      case 'move':
        move = [d.move[0] + dx / z, d.move[1] + dy / z, d.move[2]];
        break;
      case 'depth':
        // Up the screen: toward the viewer (+z).
        move = [d.move[0], d.move[1], d.move[2] - dy / z];
        depthTip = depthLabel(move[2]);
        break;
      case 'scale': {
        const r0 = Math.hypot(d.p0[0] - center[0], d.p0[1] - center[1]);
        const r1 = Math.hypot(p[0] - center[0], p[1] - center[1]);
        if (r0 > 1) s = Math.max(1e-6, d.s * (r1 / r0));
        break;
      }
      case 'spin': {
        const a = Math.atan2(p[1] - center[1], p[0] - center[0]) - Math.atan2(d.p0[1] - center[1], d.p0[0] - center[0]);
        q = quatMul(quatAxisAngle(0, 0, 1, snap(a, e.shiftKey)), d.q);
        break;
      }
      case 'ball':
        // Each move turns a little more, about the axis across the move.
        q = quatMul(trackball(p[0] - d.last[0], p[1] - d.last[1], ball), q);
        break;
      case 'tiltX':
        q = quatMul(quatAxisAngle(-1, 0, 0, snap(dy / ball, e.shiftKey)), d.q);
        break;
      case 'tiltY':
        q = quatMul(quatAxisAngle(0, 1, 0, snap(dx / ball, e.shiftKey)), d.q);
        break;
    }
    d.last = p;
  }

  function up() {
    drag = null;
    depthTip = null;
  }

  function reset() {
    q = [...QUAT_ID];
    s = 1;
    move = [0, 0, 0];
  }

  /** A depth in canvas units, signed (+: toward the viewer). */
  const depthLabel = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v) < 10 ? Math.abs(v).toFixed(1) : Math.round(Math.abs(v))}`;

  const apply = () => engine.applyTransform3($state.snapshot(M3) as Affine3);

  onMount(() => {
    if (!start) engine.cancelTransform();
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
        if (e.key !== 'Enter') return;
        t.blur();
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        apply();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        engine.cancelTransform();
      } else if (e.key.startsWith('Arrow')) {
        e.preventDefault();
        const step = (e.shiftKey ? 10 : 1) / ed.view.zoom;
        const [x, y, zz] = move;
        if (e.key === 'ArrowLeft') move = [x - step, y, zz];
        if (e.key === 'ArrowRight') move = [x + step, y, zz];
        if (e.key === 'ArrowUp') move = [x, y - step, zz];
        if (e.key === 'ArrowDown') move = [x, y + step, zz];
      }
    };
    window.addEventListener('keydown', key, true);
    // Android's Back cancels, like Esc.
    const release = closeOnBack(() => engine.cancelTransform());
    return () => {
      window.removeEventListener('keydown', key, true);
      release();
    };
  });

  const pct = (v: number) => `${Math.round(v * 100)}%`;
  /** How far the layer turned in all, degrees (the angle of the quaternion). */
  const turned = $derived(Math.round((2 * Math.acos(Math.min(1, Math.abs(q[3]))) * 180) / Math.PI));
</script>

<div
  class="overlay"
  role="presentation"
  bind:this={root}
  onpointermove={pointerMove}
  onpointerup={up}
  onpointercancel={up}
  onwheel={(e) => {
    // Zoom still works over the gizmo: hand the wheel to the canvas.
    e.preventDefault();
    root.parentElement?.querySelector('canvas')?.dispatchEvent(new WheelEvent('wheel', e));
  }}
>
  <svg>
    <polygon class="box" points={corners.map((c) => c.join(',')).join(' ')} onpointerdown={(e) => down(e, 'move')} role="presentation" />
    <circle class="ring hit" cx={center[0]} cy={center[1]} r={ring} role="presentation" onpointerdown={(e) => down(e, 'spin')} />
    <circle class="ring" cx={center[0]} cy={center[1]} r={ring} />
    <circle class="ball" cx={center[0]} cy={center[1]} r={ball} role="presentation" onpointerdown={(e) => down(e, 'ball')} />
    <!-- The axis bars: red turns about x (drag up and down), green about y (drag sideways). -->
    <line class="axis hit" style:cursor="ns-resize" x1={center[0] - ring + KNOB} y1={center[1]} x2={center[0] + ring - KNOB} y2={center[1]} role="presentation" onpointerdown={(e) => down(e, 'tiltX')} />
    <line class="axis x" x1={center[0] - ring + KNOB} y1={center[1]} x2={center[0] + ring - KNOB} y2={center[1]} />
    <line class="axis hit" style:cursor="ew-resize" x1={center[0]} y1={center[1] - ring + KNOB} x2={center[0]} y2={center[1] + ring - KNOB} role="presentation" onpointerdown={(e) => down(e, 'tiltY')} />
    <line class="axis y" x1={center[0]} y1={center[1] - ring + KNOB} x2={center[0]} y2={center[1] + ring - KNOB} />
    {#each [-1, 1] as side (side)}
      <circle class="knob x" cx={center[0] + side * (ring - KNOB)} cy={center[1]} r="6" role="presentation" onpointerdown={(e) => down(e, 'tiltX')} />
      <circle class="knob y" cx={center[0]} cy={center[1] + side * (ring - KNOB)} r="6" role="presentation" onpointerdown={(e) => down(e, 'tiltY')} />
    {/each}
    {#each corners as [hx, hy], i (i)}
      <rect class="handle" x={hx - 6} y={hy - 6} width="12" height="12" style:cursor={i % 2 ? 'nesw-resize' : 'nwse-resize'} role="presentation" onpointerdown={(e) => down(e, 'scale')} />
    {/each}
    {#if depthTip}
      <text class="tip" x={center[0] + 12} y={center[1] - 12}>Depth {depthTip}</text>
    {/if}
  </svg>
  <div class="bar" role="toolbar" aria-label="3D transform">
    <span class="info" title="A 3D layer: it turns, scales and moves in 3D. Alt+drag in the box changes the depth.">3D · {pct(s)} · {turned}°</span>
    <label class="depth" title="Depth: how far the layer moves toward you (+) or away (−), in canvas units. Alt+drag in the box changes it too.">
      Depth
      <input
        type="number"
        step="any"
        value={Math.round(move[2] * 1000) / 1000}
        onchange={(e) => {
          const v = Number(e.currentTarget.value);
          if (Number.isFinite(v)) move = [move[0], move[1], v];
        }}
      />
    </label>
    <button title="Back to the start" onclick={reset}>Reset</button>
    <button title="Cancel (Esc)" onclick={() => engine.cancelTransform()}>Cancel</button>
    <button class="primary" title="Apply (Enter)" onclick={apply}>Apply</button>
  </div>
</div>

<style>
  .overlay {
    position: absolute;
    inset: 0;
    z-index: 7;
    pointer-events: none;
  }
  svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
  }
  .box {
    fill: rgba(49, 168, 255, 0.04);
    stroke: var(--accent);
    stroke-width: 1.5;
    stroke-dasharray: 4 3;
    pointer-events: all;
    cursor: move;
    touch-action: none;
  }
  .ring {
    fill: none;
    stroke: #4a90ff;
    stroke-width: 2;
  }
  .hit {
    stroke: transparent;
    stroke-width: 20;
    fill: none;
    pointer-events: stroke;
    touch-action: none;
  }
  .ring.hit {
    cursor: grab;
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
  .axis.hit {
    stroke-width: 12;
    pointer-events: stroke;
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
  .handle {
    fill: #fff;
    stroke: var(--accent);
    stroke-width: 1.5;
    pointer-events: all;
    touch-action: none;
  }
  .tip {
    fill: #fff;
    font-size: 12px;
    paint-order: stroke;
    stroke: rgba(0, 0, 0, 0.7);
    stroke-width: 3px;
  }
  @media (pointer: coarse) {
    .handle,
    .knob {
      transform-box: fill-box;
      transform-origin: center;
      transform: scale(1.7);
    }
  }
  .bar {
    position: absolute;
    left: 50%;
    bottom: 12px;
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
    font-variant-numeric: tabular-nums;
    margin-right: 4px;
  }
  .depth {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: var(--text-dim);
  }
  .depth input {
    width: 72px;
  }
</style>
