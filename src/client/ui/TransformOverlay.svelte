<script lang="ts">
  // Free transform of a layer or group (Ctrl+T or V): a box around what it draws, with handles.
  //   drag inside: move · corners: scale, keeping the shape (Shift: free; Alt: from the center)
  //   edges: stretch one way · round handle above: rotate (Shift: 15° steps)
  //   toolbar: flip, reset, cancel, apply · keys: Enter applies, Esc cancels, arrows nudge
  // The transform is the world matrix M = T(center) · R(angle) · S(sx, sy) · T(−original center).
  // While it changes, the renderer draws the layer moved (a preview); Apply sends one op.
  import { onMount } from 'svelte';
  import { compose } from '../../shared/layers';
  import type { Affine } from '../../shared/types';
  import type { Engine } from '../engine/engine';
  import { ed } from '../state.svelte';
  import Icon from './Icon.svelte';

  let { engine, id }: { engine: Engine; id: string } = $props();

  // What the layer draws now (world), set once: the transform is relative to it.
  const start = (() => engine.contentOf(id))();
  const B = start ?? { x0: 0, y0: 0, x1: 1, y1: 1 };
  const bw = Math.max(B.x1 - B.x0, 1e-12), bh = Math.max(B.y1 - B.y0, 1e-12);
  const bc: [number, number] = [(B.x0 + B.x1) / 2, (B.y0 + B.y1) / 2];

  let cx = $state(bc[0]);
  let cy = $state(bc[1]);
  let angle = $state(0); // radians
  let sx = $state(1);
  let sy = $state(1);

  const M = $derived.by((): Affine => {
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const rs: Affine = [cos * sx, sin * sx, -sin * sy, cos * sy, 0, 0];
    return compose([1, 0, 0, 1, cx, cy], compose(rs, [1, 0, 0, 1, -bc[0], -bc[1]]));
  });

  $effect(() => engine.previewTransform(M));

  // Screen (CSS px in the stage) from world, following the view.
  const toScreen = (x: number, y: number): [number, number] => [(x - ed.view.x) * ed.view.zoom, (y - ed.view.y) * ed.view.zoom];
  const apply = (m: Affine, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  /** Box corners on screen: top left, top right, bottom right, bottom left. */
  const corners = $derived([apply(M, B.x0, B.y0), apply(M, B.x1, B.y0), apply(M, B.x1, B.y1), apply(M, B.x0, B.y1)].map(([x, y]) => toScreen(x, y)));
  const mid = (a: [number, number], b: [number, number]): [number, number] => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const center = $derived(toScreen(cx, cy));
  /** The rotate handle: 28 px beyond the middle of the top edge, away from the center. */
  const rotHandle = $derived.by((): [number, number] => {
    const top = mid(corners[0], corners[1]);
    const dx = top[0] - center[0], dy = top[1] - center[1];
    const len = Math.hypot(dx, dy) || 1;
    return [top[0] + (dx / len) * 28, top[1] + (dy / len) * 28];
  });

  // Handles: corners (ix, iy = ±1) and edges (one of them 0), in the box's own frame.
  const HANDLES: [ix: number, iy: number][] = [
    [-1, -1], [1, -1], [1, 1], [-1, 1], // corners, same order as `corners`
    [0, -1], [1, 0], [0, 1], [-1, 0], // edges: top, right, bottom, left
  ];
  const handlePos = (ix: number, iy: number): [number, number] => {
    const [x, y] = apply(M, bc[0] + (ix * bw) / 2, bc[1] + (iy * bh) / 2);
    return toScreen(x, y);
  };

  let root = $state<HTMLDivElement>()!;
  /** The drag in progress and the state when it started. */
  let drag: {
    kind: 'move' | 'rotate' | 'scale';
    ix: number;
    iy: number;
    p0: [number, number];
    cx: number;
    cy: number;
    angle: number;
    sx: number;
    sy: number;
  } | null = null;

  /** Keeps the pointer's moves coming here (fails for a pointer that is already gone). */
  function capture(e: PointerEvent) {
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  }

  /** World point under a pointer event. */
  function world(e: PointerEvent): [number, number] {
    const r = root.getBoundingClientRect();
    return [ed.view.x + (e.clientX - r.left) / ed.view.zoom, ed.view.y + (e.clientY - r.top) / ed.view.zoom];
  }

  function down(e: PointerEvent, kind: 'move' | 'rotate' | 'scale', ix = 0, iy = 0) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    capture(e);
    drag = { kind, ix, iy, p0: world(e), cx, cy, angle, sx, sy };
  }

  function move(e: PointerEvent) {
    if (!drag) return;
    const p = world(e);
    const d = drag;
    if (d.kind === 'move') {
      cx = d.cx + p[0] - d.p0[0];
      cy = d.cy + p[1] - d.p0[1];
      return;
    }
    if (d.kind === 'rotate') {
      let a = d.angle + Math.atan2(p[1] - d.cy, p[0] - d.cx) - Math.atan2(d.p0[1] - d.cy, d.p0[0] - d.cx);
      if (e.shiftKey) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12);
      angle = a;
      return;
    }
    // Scale, in the box's frame at the start (rotation undone, origin at the start center).
    const cos = Math.cos(d.angle), sin = Math.sin(d.angle);
    const lx = cos * (p[0] - d.cx) + sin * (p[1] - d.cy);
    const ly = -sin * (p[0] - d.cx) + cos * (p[1] - d.cy);
    const hx0 = (Math.abs(d.sx) * bw) / 2, hy0 = (Math.abs(d.sy) * bh) / 2;
    const minH = 2 / ed.view.zoom; // at least a few screen pixels
    const fromCenter = e.altKey;
    // The fixed point: the opposite corner or edge, or the center with Alt.
    const ox = fromCenter ? 0 : -d.ix * hx0, oy = fromCenter ? 0 : -d.iy * hy0;
    let hx = hx0, hy = hy0;
    if (d.ix !== 0 && d.iy !== 0 && !e.shiftKey) {
      // A corner keeps the shape: the pointer projected on the line from the fixed point through
      // the corner gives one scale for both sides.
      const dx = d.ix * hx0 - ox, dy = d.iy * hy0 - oy;
      const k = Math.max(((lx - ox) * dx + (ly - oy) * dy) / (dx * dx + dy * dy || 1), minH / Math.max(hx0, hy0, 1e-300));
      hx = hx0 * k;
      hy = hy0 * k;
    } else {
      // Free: each side follows the pointer (an edge moves one side only).
      if (d.ix !== 0) hx = Math.max(minH, fromCenter ? Math.abs(lx) : ((lx - ox) * d.ix) / 2);
      if (d.iy !== 0) hy = Math.max(minH, fromCenter ? Math.abs(ly) : ((ly - oy) * d.iy) / 2);
    }
    // The new center: the fixed point plus half the new size toward the dragged side.
    const ncx = fromCenter || d.ix === 0 ? 0 : ox + d.ix * hx;
    const ncy = fromCenter || d.iy === 0 ? 0 : oy + d.iy * hy;
    cx = d.cx + cos * ncx - sin * ncy;
    cy = d.cy + sin * ncx + cos * ncy;
    sx = Math.sign(d.sx) * ((2 * hx) / bw);
    sy = Math.sign(d.sy) * ((2 * hy) / bh);
  }

  function up() {
    drag = null;
  }

  function reset() {
    [cx, cy, angle, sx, sy] = [bc[0], bc[1], 0, 1, 1];
  }

  onMount(() => {
    if (!start) engine.cancelTransform();
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        engine.applyTransform(M);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        engine.cancelTransform();
      } else if (e.key.startsWith('Arrow')) {
        e.preventDefault();
        const step = (e.shiftKey ? 10 : 1) / ed.view.zoom;
        if (e.key === 'ArrowLeft') cx -= step;
        if (e.key === 'ArrowRight') cx += step;
        if (e.key === 'ArrowUp') cy -= step;
        if (e.key === 'ArrowDown') cy += step;
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  });

  const pct = (v: number) => `${Math.round(Math.abs(v) * 100)}%`;
  const deg = $derived(Math.round(((((angle * 180) / Math.PI) % 360) + 540) % 360) - 180);
</script>

<div
  class="overlay"
  role="presentation"
  bind:this={root}
  onpointermove={move}
  onpointerup={up}
  onpointercancel={up}
  onwheel={(e) => {
    // Zoom still works over the box: hand the wheel to the canvas.
    e.preventDefault();
    root.parentElement?.querySelector('canvas')?.dispatchEvent(new WheelEvent('wheel', e));
  }}
>
  <svg>
    <polygon class="box" points={corners.map((c) => c.join(',')).join(' ')} onpointerdown={(e) => down(e, 'move')} role="presentation" />
    <line x1={mid(corners[0], corners[1])[0]} y1={mid(corners[0], corners[1])[1]} x2={rotHandle[0]} y2={rotHandle[1]} class="stem" />
    {#each HANDLES as [ix, iy], i (i)}
      {@const [hx, hy] = handlePos(ix, iy)}
      <rect
        class="handle"
        x={hx - 6}
        y={hy - 6}
        width="12"
        height="12"
        style:cursor={ix && iy ? 'nwse-resize' : ix ? 'ew-resize' : 'ns-resize'}
        role="presentation"
        onpointerdown={(e) => down(e, 'scale', ix, iy)}
      />
    {/each}
    <circle class="handle rot" cx={rotHandle[0]} cy={rotHandle[1]} r="7" role="presentation" onpointerdown={(e) => down(e, 'rotate')} />
  </svg>
  <div class="bar" role="toolbar" aria-label="Transform">
    <span class="info">W {pct(sx)} · H {pct(sy)} · {deg}°</span>
    <button class="icon" title="Flip horizontally" aria-label="Flip horizontally" onclick={() => (sx = -sx)}><Icon name="fliph" /></button>
    <button class="icon" title="Flip vertically" aria-label="Flip vertically" onclick={() => (sy = -sy)}><Icon name="flipv" /></button>
    <button title="Back to the start" onclick={reset}>Reset</button>
    <button title="Cancel (Esc)" onclick={() => engine.cancelTransform()}>Cancel</button>
    <button class="primary" title="Apply (Enter)" onclick={() => engine.applyTransform(M)}>Apply</button>
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
    pointer-events: all;
    cursor: move;
    touch-action: none;
  }
  .stem {
    stroke: var(--accent);
    stroke-width: 1.5;
  }
  .handle {
    fill: #fff;
    stroke: var(--accent);
    stroke-width: 1.5;
    pointer-events: all;
    touch-action: none;
  }
  .rot {
    cursor: grab;
  }
  @media (pointer: coarse) {
    .handle:not(.rot) {
      transform-box: fill-box;
      transform-origin: center;
      transform: scale(1.7);
    }
    .rot {
      r: 11;
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
</style>
