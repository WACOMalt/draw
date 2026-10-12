<script lang="ts">
  // Export image, Area: Pick. A crop box on the canvas that sets the export region.
  //   drag on the canvas: a new box · drag inside: move · handles: resize
  //   wheel, two fingers or the middle button: zoom and pan while picking
  //   toolbar: a shape lock (the export shapes), the output size in pixels (a typed size sets
  //   the shape), Screen (the size follows the box at the screen's resolution), Cancel, Accept
  //   keys: Enter accepts, Esc cancels
  // Accept stores the region in ed.exportRegion and the export dialog comes back.
  import { onMount } from 'svelte';
  import type { Engine } from '../engine/engine';
  import { ASPECTS, aspectRatio } from '../export/aspects';
  import { ed } from '../state.svelte';
  import { closeOnBack } from '../back';

  let { engine }: { engine: Engine } = $props();

  type Box = { x0: number; y0: number; x1: number; y1: number };
  const start = ed.exportRegion;

  /** The box in world units, or null before the first drag. */
  let box = $state<Box | null>(start ? { ...start.bounds } : null);
  /** The shape lock: an id of ASPECTS, 'custom' (a typed size), or null (free). */
  let aspect = $state<string | null>(start?.aspect ?? null);
  /** The size follows the box at the screen's resolution. */
  let auto = $state(start?.auto ?? true);
  /** A typed size (auto off): the width, and the height for 'custom'. */
  let resW = $state(start?.w ?? 1920);
  let resH = $state(start?.h ?? 1080);

  const MAX_SIDE = 4_294_967_295;
  const dpr = window.devicePixelRatio || 1;
  const bw = $derived(box ? box.x1 - box.x0 : 0);
  const bh = $derived(box ? box.y1 - box.y0 : 0);
  /** Width / height that the box keeps, or null (free). */
  const ratio = $derived(aspect === 'custom' ? resW / resH : aspectRatio(aspect));
  /** The output size in pixels. */
  const out = $derived.by((): [number, number] => {
    if (!box) return [0, 0];
    if (auto) {
      const s = ed.view.zoom * dpr;
      return [Math.max(1, Math.round(bw * s)), Math.max(1, Math.round(bh * s))];
    }
    if (aspect === 'custom') return [resW, resH];
    return [resW, Math.max(1, Math.round(resW / (ratio ?? bw / bh)))];
  });

  // Screen (CSS px in the stage) from world, following the view.
  const sx = (x: number) => (x - ed.view.x) * ed.view.zoom;
  const sy = (y: number) => (y - ed.view.y) * ed.view.zoom;
  const scr = $derived(box ? { x: sx(box.x0), y: sy(box.y0), w: bw * ed.view.zoom, h: bh * ed.view.zoom } : null);

  /** The box changed to the width / height `r`, about its center, with the same area. */
  function reshape(r: number | null) {
    if (!box || !r) return;
    const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
    const w = Math.sqrt(bw * bh * r), h = w / r;
    box = { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2 };
  }

  function setAspect(id: string | null) {
    if (!auto && aspect === 'custom') resW = out[0];
    aspect = id;
    reshape(aspectRatio(id));
  }

  /**
   * A typed width or height fixes the size. With a shape chosen, the other side follows that
   * shape. Free (or a typed shape): width × height becomes the shape of the box.
   */
  function typeSize(side: 'w' | 'h', v: number) {
    if (!(v >= 1)) return;
    v = Math.min(MAX_SIDE, Math.round(v));
    const preset = aspectRatio(aspect);
    auto = false;
    if (preset) {
      resW = side === 'w' ? v : Math.max(1, Math.min(MAX_SIDE, Math.round(v * preset)));
      return;
    }
    [resW, resH] = side === 'w' ? [v, out[1]] : [out[0], v];
    aspect = 'custom';
    reshape(resW / resH);
  }

  function accept() {
    if (!box) return;
    const [w, h] = out;
    // The region gets the exact shape of the output: same center and width.
    const cy = (box.y0 + box.y1) / 2, nh = (bw * h) / w;
    ed.exportRegion = { bounds: { x0: box.x0, y0: cy - nh / 2, x1: box.x1, y1: cy + nh / 2 }, w, h, aspect, auto };
    ed.exportPicking = false;
  }
  const cancel = () => (ed.exportPicking = false);

  let root = $state<HTMLDivElement>()!;
  /** Pointers down on the canvas area, in CSS px of the stage. */
  const pointers = new Map<number, [number, number]>();
  type Drag =
    | { kind: 'new'; p0: [number, number]; prev: Box | null }
    | { kind: 'move'; p0: [number, number]; b0: Box }
    | { kind: 'resize'; ix: number; iy: number; b0: Box }
    | { kind: 'pan'; l0: [number, number]; v0: { x: number; y: number; zoom: number } }
    | { kind: 'pinch'; a: number; b: number; la: [number, number]; lb: [number, number]; v0: { x: number; y: number; zoom: number } };
  let drag: Drag | null = null;

  function local(e: PointerEvent): [number, number] {
    const r = root.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }
  const toWorld = ([lx, ly]: [number, number]): [number, number] => [ed.view.x + lx / ed.view.zoom, ed.view.y + ly / ed.view.zoom];

  function capture(e: PointerEvent) {
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  }

  function downCanvas(e: PointerEvent) {
    e.preventDefault();
    capture(e);
    pointers.set(e.pointerId, local(e));
    const v0 = { ...ed.view };
    if (pointers.size === 2) {
      // A second finger: zoom and pan instead of drawing a box.
      if (drag?.kind === 'new') box = drag.prev;
      const [[a, la], [b, lb]] = [...pointers];
      drag = { kind: 'pinch', a, b, la, lb, v0 };
    } else if (pointers.size === 1) {
      if (e.button === 1) drag = { kind: 'pan', l0: local(e), v0 };
      else if (e.button === 0) drag = { kind: 'new', p0: toWorld(local(e)), prev: box };
    }
  }

  function downBox(e: PointerEvent, ix?: number, iy?: number) {
    if (e.button !== 0 || !box || pointers.size) return;
    e.preventDefault();
    e.stopPropagation();
    capture(e);
    drag = ix === undefined ? { kind: 'move', p0: toWorld(local(e)), b0: { ...box } } : { kind: 'resize', ix, iy: iy!, b0: { ...box } };
  }

  function move(e: PointerEvent) {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, local(e));
    const d = drag;
    if (!d) return;
    const min = 4 / ed.view.zoom;
    if (d.kind === 'pinch') {
      const pa = pointers.get(d.a), pb = pointers.get(d.b);
      if (!pa || !pb) return;
      const dist0 = Math.hypot(d.la[0] - d.lb[0], d.la[1] - d.lb[1]) || 1;
      const z = Math.min(1e11, Math.max(1e-9, (d.v0.zoom * Math.hypot(pa[0] - pb[0], pa[1] - pb[1])) / dist0));
      const c0 = [(d.la[0] + d.lb[0]) / 2, (d.la[1] + d.lb[1]) / 2], c1 = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2];
      // The world point under the first center stays under the fingers.
      engine.setView(d.v0.x + c0[0] / d.v0.zoom - c1[0] / z, d.v0.y + c0[1] / d.v0.zoom - c1[1] / z, z);
      return;
    }
    if (d.kind === 'pan') {
      const l = local(e);
      engine.setView(d.v0.x - (l[0] - d.l0[0]) / d.v0.zoom, d.v0.y - (l[1] - d.l0[1]) / d.v0.zoom, d.v0.zoom);
      return;
    }
    const p = toWorld(local(e));
    if (d.kind === 'new') {
      const dx = p[0] - d.p0[0], dy = p[1] - d.p0[1];
      let w = Math.abs(dx), h = Math.abs(dy);
      if (ratio) {
        w = Math.max(w, h * ratio);
        h = w / ratio;
      }
      const x0 = dx < 0 ? d.p0[0] - w : d.p0[0], y0 = dy < 0 ? d.p0[1] - h : d.p0[1];
      box = { x0, y0, x1: x0 + w, y1: y0 + h };
    } else if (d.kind === 'move') {
      const dx = p[0] - d.p0[0], dy = p[1] - d.p0[1];
      box = { x0: d.b0.x0 + dx, y0: d.b0.y0 + dy, x1: d.b0.x1 + dx, y1: d.b0.y1 + dy };
    } else {
      // Resize: the opposite side (or corner) stays.
      const b = d.b0, { ix, iy } = d;
      const ax = ix > 0 ? b.x0 : b.x1, ay = iy > 0 ? b.y0 : b.y1;
      let w = ix ? Math.max(min, ix * (p[0] - ax)) : b.x1 - b.x0;
      let h = iy ? Math.max(min, iy * (p[1] - ay)) : b.y1 - b.y0;
      if (ratio) {
        if (ix && iy) w = Math.max(w, h * ratio);
        if (ix) h = w / ratio;
        else w = h * ratio;
      }
      // A side that is not dragged stays centered when the shape lock changes its length.
      const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
      const x0 = ix > 0 ? ax : ix < 0 ? ax - w : cx - w / 2;
      const y0 = iy > 0 ? ay : iy < 0 ? ay - h : cy - h / 2;
      box = { x0, y0, x1: x0 + w, y1: y0 + h };
    }
  }

  function up(e: PointerEvent) {
    pointers.delete(e.pointerId);
    const d = drag;
    if (d?.kind === 'pinch') {
      if (pointers.size < 2) drag = null;
      return;
    }
    // A tap (no real drag) keeps the box there was.
    if (d?.kind === 'new' && box && (bw * ed.view.zoom < 4 || bh * ed.view.zoom < 4)) box = d.prev;
    drag = null;
  }

  onMount(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        accept();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    };
    window.addEventListener('keydown', key, true);
    // Android's Back cancels, like Esc.
    const release = closeOnBack(cancel);
    return () => {
      window.removeEventListener('keydown', key, true);
      release();
    };
  });

  const HANDLES: [ix: number, iy: number][] = [
    [-1, -1], [1, -1], [1, 1], [-1, 1],
    [0, -1], [1, 0], [0, 1], [-1, 0],
  ];
  const CURSOR: Record<string, string> = { '-1,-1': 'nwse', '1,1': 'nwse', '1,-1': 'nesw', '-1,1': 'nesw', '0,-1': 'ns', '0,1': 'ns', '-1,0': 'ew', '1,0': 'ew' };
</script>

<div
  class="overlay"
  role="presentation"
  bind:this={root}
  onpointermove={move}
  onpointerup={up}
  onpointercancel={up}
  onwheel={(e) => {
    // The wheel zooms the canvas, as without the picker.
    e.preventDefault();
    root.parentElement?.querySelector('canvas')?.dispatchEvent(new WheelEvent('wheel', e));
  }}
>
  <svg>
    <rect class="catch" width="100%" height="100%" role="presentation" onpointerdown={downCanvas} />
    {#if scr}
      <!-- Dims everything outside the box. -->
      <path class="dim" fill-rule="evenodd" d="M-1e5,-1e5H1e5V1e5H-1e5Z M{scr.x},{scr.y}h{scr.w}v{scr.h}h{-scr.w}Z" />
      <rect class="box" x={scr.x} y={scr.y} width={scr.w} height={scr.h} role="presentation" onpointerdown={(e) => downBox(e)} />
      {#each HANDLES as [ix, iy], i (i)}
        <rect
          class="handle"
          x={scr.x + ((ix + 1) / 2) * scr.w - 6}
          y={scr.y + ((iy + 1) / 2) * scr.h - 6}
          width="12"
          height="12"
          style:cursor="{CURSOR[`${ix},${iy}`]}-resize"
          role="presentation"
          onpointerdown={(e) => downBox(e, ix, iy)}
        />
      {/each}
    {/if}
  </svg>
  {#if scr}
    <div class="dims" style:left="{scr.x}px" style:top="{Math.max(0, scr.y - 24)}px">{out[0].toLocaleString()} × {out[1].toLocaleString()} px</div>
  {/if}
  <div class="bar" role="toolbar" aria-label="Export region">
    <div class="hint">{box ? 'Drag inside to move, the handles to resize, or drag a new box.' : 'Drag a box over the area to export.'}</div>
    <div class="chips" role="radiogroup" aria-label="Shape">
      <button role="radio" aria-checked={aspect === null} class:on={aspect === null} onclick={() => setAspect(null)}>Free</button>
      {#each ASPECTS as [id] (id)}
        <button role="radio" aria-checked={aspect === id} class:on={aspect === id} onclick={() => setAspect(id)}>{id}</button>
      {/each}
    </div>
    <div class="row">
      <label class="num" title="Output width in pixels. With Free, the typed size also sets the shape"
        ><input
          type="number"
          min="1"
          step="1"
          value={box ? out[0] : ''}
          placeholder="W"
          disabled={!box}
          aria-label="Output width in pixels"
          onchange={(e) => typeSize('w', +e.currentTarget.value)}
        /></label
      >
      <span class="x">×</span>
      <label class="num" title="Output height in pixels. With Free, the typed size also sets the shape"
        ><input
          type="number"
          min="1"
          step="1"
          value={box ? out[1] : ''}
          placeholder="H"
          disabled={!box}
          aria-label="Output height in pixels"
          onchange={(e) => typeSize('h', +e.currentTarget.value)}
        /></label
      >
      <span class="px">px</span>
      <button class:on={auto} title="The size follows the box at the resolution of your screen" onclick={() => (auto = true)}>Screen</button>
      <span class="grow"></span>
      <button title="Cancel (Esc)" onclick={cancel}>Cancel</button>
      <button class="primary" disabled={!box} title="Use this region (Enter)" onclick={accept}>Accept</button>
    </div>
  </div>
</div>

<style>
  .overlay {
    position: absolute;
    inset: 0;
    z-index: 8;
  }
  svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
  }
  .catch {
    fill: transparent;
    cursor: crosshair;
    touch-action: none;
  }
  .dim {
    fill: rgba(0, 0, 0, 0.45);
    pointer-events: none;
  }
  .box {
    fill: transparent;
    stroke: var(--accent);
    stroke-width: 1.5;
    cursor: move;
    touch-action: none;
  }
  .handle {
    fill: #fff;
    stroke: var(--accent);
    stroke-width: 1.5;
    touch-action: none;
  }
  @media (pointer: coarse) {
    .handle {
      transform-box: fill-box;
      transform-origin: center;
      transform: scale(1.8);
    }
  }
  .dims {
    position: absolute;
    padding: 2px 6px;
    border-radius: 4px;
    background: var(--accent);
    color: #fff;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    pointer-events: none;
  }
  .hint {
    color: var(--text-dim);
    font-size: 12px;
  }
  .bar {
    position: absolute;
    left: 50%;
    bottom: 12px;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    width: max-content;
    max-width: calc(100% - 16px);
    border-radius: 10px;
    background: rgba(30, 30, 30, 0.95);
    border: 1px solid var(--line);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  }
  .chips {
    display: flex;
    gap: 4px;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .chips button {
    flex: none;
    padding: 4px 9px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  button.on {
    color: var(--text);
    border-color: var(--accent-dim);
    background: #24394c;
  }
  .num {
    margin: 0;
  }
  .num input {
    width: 84px;
    font-variant-numeric: tabular-nums;
  }
  .x,
  .px {
    color: var(--text-dim);
  }
  .grow {
    flex: 1;
  }
</style>
