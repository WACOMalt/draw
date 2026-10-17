<script lang="ts">
  // Compact label + slider + number field, in the style of an options bar.
  //
  // The slider is drawn here, not a native range input: a native one has a tiny thumb on a
  // phone, and inside a scrolling sheet a slightly diagonal drag becomes a scroll and drops the
  // slider. Here the track takes `touch-action: pan-y`: a vertical swipe scrolls the page or
  // sheet, a sideways drag moves the value (from the first sideways movement), and a tap sets
  // the value at that point. Mouse and pen set it at once and follow. Keys: arrows (Shift: 10×),
  // Home and End.
  let {
    label,
    value = $bindable(),
    min,
    max,
    step = 1,
    percent = false,
    log = false,
    width = 90,
    title = '',
    wide = false,
    least,
    center = 0,
    oninput,
    onchange,
  }: {
    label: string;
    value: number;
    min: number;
    max: number;
    step?: number;
    percent?: boolean;
    log?: boolean;
    width?: number;
    title?: string;
    /** Stretch the slider to the available width (sheet layout). */
    wide?: boolean;
    /** A log slider through `center`: the smallest distance from it (default from `step`). */
    least?: number;
    /**
     * A log slider with min < center < max runs exponentially away from `center` both ways, with
     * `center` in the middle of the track (a turn either way, a scale up or down from 100%).
     */
    center?: number;
    oninput?: (v: number) => void;
    /** The change is done: the drag ended, a key or the number field set the value. */
    onchange?: (v: number) => void;
  } = $props();

  // Position 0..1 on the track. Log scale maps it to min..max exponentially: fine steps at the
  // low end (size, flow, spacing). Values round to three significant digits, never finer than
  // `step`; a linear slider rounds to `step`. A log slider from 0 (corner radius, rounding)
  // keeps the first ZERO of the track for 0; the rest runs exponentially from `lo`. A log slider
  // through `center` (min < center < max: a turn either way, a scale up or down) has `center` in
  // the middle, and each half runs exponentially from `lo` away from it out to its end: fine
  // steps near the center and large ones at the ends.
  const ZERO = 0.05;
  const signed = $derived(log && min < center && center < max);
  const zeroed = $derived(log && !signed && min === 0);
  const lo = $derived(least ?? (zeroed || signed ? Math.min(Math.max(step, 0.5), max / 10) : min));
  const logPos = (v: number, hi = max) => Math.log(v / lo) / Math.log(hi / lo);
  /** The far end of the half of a signed slider that `d` (from the center) is on. */
  const side = (d: number) => (d > 0 ? max - center : center - min);
  const toPos = (v: number) => {
    if (!log) return (v - min) / (max - min);
    if (signed) {
      const d = v - center, a = Math.abs(d);
      const off = a === 0 ? 0 : a < lo ? ZERO / 2 : ZERO + (0.5 - ZERO) * logPos(a, side(d));
      return 0.5 + Math.sign(d) * off;
    }
    if (!zeroed) return logPos(v);
    return v <= 0 ? 0 : v < lo ? ZERO / 2 : ZERO + (1 - ZERO) * logPos(v);
  };
  /** v rounded to three significant digits, never finer than `step`. */
  const round3 = (v: number) => {
    const q = Math.max(step, 10 ** (Math.floor(Math.log10(v)) - 2));
    return Math.round(v / q) * q;
  };
  function fromPos(p: number): number {
    p = Math.min(1, Math.max(0, p));
    if (!log) return Math.round((min + p * (max - min)) / step) * step;
    if (signed) {
      const d = Math.abs(p - 0.5);
      if (d < ZERO / 2) return center;
      const m = Math.max(0, (d - ZERO) / (0.5 - ZERO));
      const sgn = Math.sign(p - 0.5);
      return center + sgn * round3(lo * (side(sgn) / lo) ** m);
    }
    if (zeroed) {
      if (p < ZERO / 2) return 0;
      p = Math.max(0, (p - ZERO) / (1 - ZERO));
    }
    return round3(lo * (max / lo) ** p);
  }
  const pos = $derived(Math.min(1, Math.max(0, toPos(value))));

  // Percent: one decimal below 10%, where a log slider has finer steps.
  // A slider through a center shows two decimals (a scale of 100.25%).
  const shown = $derived(
    percent
      ? signed
        ? Math.round(value * 10000) / 100
        : value < 0.1
          ? Math.round(value * 1000) / 10
          : Math.round(value * 100)
      : Math.round(value * 100) / 100,
  );

  function set(v: number) {
    if (!Number.isFinite(v)) return;
    v = Math.min(max, Math.max(min, v));
    if (v === value) return;
    value = v;
    oninput?.(v);
  }

  let track = $state<HTMLDivElement>()!;
  /** The pointer that moves the slider, and for touch whether a sideways drag has started. */
  let drag: { id: number; touch: boolean; x0: number; y0: number; live: boolean } | null = null;
  let active = $state(false);

  const posAt = (clientX: number) => {
    const r = track.getBoundingClientRect();
    return (clientX - r.left) / r.width;
  };

  function down(e: PointerEvent) {
    if (e.button !== 0 || drag) return;
    const touch = e.pointerType === 'touch';
    drag = { id: e.pointerId, touch, x0: e.clientX, y0: e.clientY, live: !touch };
    try {
      track.setPointerCapture(e.pointerId);
    } catch {
      // the pointer is already gone
    }
    if (!touch) {
      e.preventDefault(); // no text selection while dragging
      track.focus();
      active = true;
      set(fromPos(posAt(e.clientX)));
    }
  }

  function move(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.live) {
      // Touch: start once the finger goes sideways; a vertical swipe stays a scroll (the browser
      // then cancels this pointer).
      const dx = Math.abs(e.clientX - drag.x0), dy = Math.abs(e.clientY - drag.y0);
      if (dx < 4 || dx < dy) return;
      drag.live = active = true;
    }
    set(fromPos(posAt(e.clientX)));
  }

  function up(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.id) return;
    // A tap that did not move: set the value there.
    if (e.type === 'pointerup' && !drag.live) set(fromPos(posAt(e.clientX)));
    const changed = drag.live || e.type === 'pointerup';
    drag = null;
    active = false;
    if (changed) onchange?.(value);
  }

  function key(e: KeyboardEvent) {
    const big = e.shiftKey ? 10 : 1;
    let p: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') p = log ? pos + 0.01 * big : null;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') p = log ? pos - 0.01 * big : null;
    else if (e.key === 'Home') return e.preventDefault(), set(min), onchange?.(value);
    else if (e.key === 'End') return e.preventDefault(), set(max), onchange?.(value);
    else return;
    e.preventDefault();
    if (p !== null) set(fromPos(p));
    else set(value + (e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : -1) * step * big);
    onchange?.(value);
  }
</script>

<div class="slider" class:wide {title}>
  <span class="lbl">{label}</span>
  <div
    class="track"
    class:active
    bind:this={track}
    style:width={wide ? null : `${width}px`}
    role="slider"
    tabindex="0"
    aria-label={label}
    aria-valuemin={percent ? min * 100 : min}
    aria-valuemax={percent ? max * 100 : max}
    aria-valuenow={shown}
    onpointerdown={down}
    onpointermove={move}
    onpointerup={up}
    onpointercancel={up}
    onkeydown={key}
  >
    <!-- Through 0, the fill runs from the middle. -->
    <div class="rail"><div class="fill" style:margin-left="{signed ? Math.min(pos, 0.5) * 100 : 0}%" style:width="{(signed ? Math.abs(pos - 0.5) : pos) * 100}%"></div></div>
    <div class="thumb" style:left="{pos * 100}%"></div>
  </div>
  <input
    type="number"
    aria-label={label}
    value={shown}
    step="any"
    min={percent ? min * 100 : min}
    max={percent ? max * 100 : max}
    onchange={(e) => {
      set(percent ? +e.currentTarget.value / 100 : +e.currentTarget.value);
      onchange?.(value);
    }}
  />
  {#if percent}<span class="unit">%</span>{/if}
</div>

<style>
  .slider {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
  }
  .lbl {
    color: var(--text-dim);
  }
  .wide {
    display: flex;
    width: 100%;
    gap: 10px;
  }
  .wide .lbl {
    width: 76px;
    flex: none;
  }
  .track {
    position: relative;
    height: 18px;
    flex: none;
    cursor: pointer;
    /* Vertical swipes scroll the page or sheet; sideways drags come here. */
    touch-action: pan-y;
    outline: none;
  }
  .wide .track {
    flex: 1;
    min-width: 0;
  }
  .rail {
    position: absolute;
    left: 0;
    right: 0;
    top: 50%;
    height: 3px;
    margin-top: -1.5px;
    border-radius: 2px;
    background: var(--bg-4);
    overflow: hidden;
  }
  .fill {
    height: 100%;
    background: var(--accent-dim);
  }
  .thumb {
    position: absolute;
    top: 50%;
    width: 11px;
    height: 11px;
    margin: -5.5px 0 0 -5.5px;
    border-radius: 50%;
    background: var(--text);
    pointer-events: none;
    transition: transform 0.08s;
  }
  .track:focus-visible .thumb {
    box-shadow: 0 0 0 3px var(--accent-dim);
  }
  .track.active .thumb {
    transform: scale(1.25);
  }
  input[type='number'] {
    width: 44px;
    text-align: right;
    padding: 2px 4px;
  }
  .wide input[type='number'] {
    width: 54px;
    padding: 6px 4px;
  }
  .unit {
    color: var(--text-dim);
    margin-left: -3px;
  }
  /* Touch screens: a finger-sized target. The track keeps its look; the hit area grows. */
  @media (pointer: coarse) {
    .track {
      height: 44px;
    }
    .rail {
      height: 4px;
      margin-top: -2px;
    }
    .thumb {
      width: 22px;
      height: 22px;
      margin: -11px 0 0 -11px;
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
    }
    input[type='number'] {
      min-height: 36px;
      font-size: 14px;
    }
  }
</style>
