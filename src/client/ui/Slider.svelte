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
    oninput?: (v: number) => void;
  } = $props();

  // Log scale maps the slider position 0..1000 to min..max exponentially (for brush size).
  const toPos = (v: number) => (log ? (Math.log(v / min) / Math.log(max / min)) * 1000 : v);
  const fromPos = (p: number) => (log ? Math.round(min * (max / min) ** (p / 1000)) : p);

  const shown = $derived(percent ? Math.round(value * 100) : Math.round(value * 100) / 100);

  function set(v: number) {
    if (!Number.isFinite(v)) return;
    v = Math.min(max, Math.max(min, v));
    value = v;
    oninput?.(v);
  }
</script>

<label class="slider" {title}>
  <span class="lbl">{label}</span>
  <input
    type="range"
    style:width="{width}px"
    min={log ? 0 : min}
    max={log ? 1000 : max}
    step={log ? 1 : step}
    value={toPos(value)}
    oninput={(e) => set(fromPos(+e.currentTarget.value))}
  />
  <input
    type="number"
    value={shown}
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
