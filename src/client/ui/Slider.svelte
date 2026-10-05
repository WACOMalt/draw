<script lang="ts">
  // Compact label + range + number field, in the style of an options bar.
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
    oninput,
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
    /** Stretch the range to the available width (sheet layout). */
    wide?: boolean;
    oninput?: (v: number) => void;
  } = $props();

  // Log scale maps the slider position 0..1000 to min..max exponentially: fine steps at the low
  // end (size, flow, spacing). Values round to three significant digits, never finer than `step`.
  const toPos = (v: number) => (log ? (Math.log(v / min) / Math.log(max / min)) * 1000 : v);
  function fromPos(p: number): number {
    if (!log) return p;
    const v = min * (max / min) ** (p / 1000);
    const q = Math.max(step, 10 ** (Math.floor(Math.log10(v)) - 2));
    return Math.round(v / q) * q;
  }

  // Percent: one decimal below 10%, where a log slider has finer steps.
  const shown = $derived(
    percent ? (value < 0.1 ? Math.round(value * 1000) / 10 : Math.round(value * 100)) : Math.round(value * 100) / 100,
  );

  function set(v: number) {
    if (!Number.isFinite(v)) return;
    v = Math.min(max, Math.max(min, v));
    value = v;
    oninput?.(v);
  }
</script>

<label class="slider" class:wide {title}>
  <span class="lbl">{label}</span>
  <input
    type="range"
    style:width={wide ? null : `${width}px`}
    min={log ? 0 : min}
    max={log ? 1000 : max}
    step={log ? 1 : step}
    value={toPos(value)}
    oninput={(e) => set(fromPos(+e.currentTarget.value))}
  />
  <input
    type="number"
    value={shown}
    step="any"
    min={percent ? min * 100 : min}
    max={percent ? max * 100 : max}
    onchange={(e) => set(percent ? +e.currentTarget.value / 100 : +e.currentTarget.value)}
  />
  {#if percent}<span class="unit">%</span>{/if}
</label>

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
  .wide input[type='range'] {
    flex: 1;
    min-width: 0;
    height: 32px;
  }
  .wide input[type='number'] {
    width: 54px;
    padding: 6px 4px;
  }
  input[type='number'] {
    width: 44px;
    text-align: right;
    padding: 2px 4px;
  }
  .unit {
    color: var(--text-dim);
    margin-left: -3px;
  }
  input[type='range'] {
    -webkit-appearance: none;
    appearance: none;
    height: 16px;
    background: transparent;
    margin: 0;
  }
  input[type='range']::-webkit-slider-runnable-track {
    height: 3px;
    background: var(--bg-4);
    border-radius: 2px;
  }
  input[type='range']::-moz-range-track {
    height: 3px;
    background: var(--bg-4);
    border-radius: 2px;
  }
  input[type='range']::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 11px;
    height: 11px;
    margin-top: -4px;
    border-radius: 50%;
    background: var(--text);
    border: none;
  }
  input[type='range']::-moz-range-thumb {
    width: 11px;
    height: 11px;
    border-radius: 50%;
    background: var(--text);
    border: none;
  }
</style>
