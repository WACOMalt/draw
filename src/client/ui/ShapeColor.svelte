<script lang="ts">
  // A Fill or Stroke swatch for shapes. A click opens a small color picker with a "None" choice,
  // the foreground and background colors and the recent colors. A drag in the picker previews
  // the color (oninput); the release sets it (onchange: one undo step).
  import { hexToHsv, hsvToHex, parseHex, type HSV } from '../color';
  import { ed } from '../state.svelte';
  import { dismiss } from '../dismiss';

  let {
    label,
    value,
    big = false,
    oninput,
    onchange,
  }: {
    label: string;
    value: string | null;
    /** Phone sheet: a larger swatch. */
    big?: boolean;
    oninput: (v: string | null) => void;
    onchange: (v: string | null) => void;
  } = $props();

  let open = $state(false);
  let left = $state(false);
  let hsv = $state<HSV>({ h: 0, s: 0, v: 0 });
  let hex = $state('');

  function show(e: MouseEvent) {
    open = !open;
    if (!open) return;
    left = (e.currentTarget as HTMLElement).getBoundingClientRect().left < 260;
    hsv = hexToHsv(value ?? ed.fg);
    hex = (value ?? '').slice(1);
  }

  function setHsv(next: HSV, done: boolean) {
    hsv = next;
    const c = hsvToHex(next);
    hex = c.slice(1);
    if (done) onchange(c);
    else oninput(c);
  }

  function pick(c: string | null) {
    if (c) {
      hsv = hexToHsv(c);
      hex = c.slice(1);
    }
    onchange(c);
  }

  function area(el: HTMLElement, fn: (fx: number, fy: number) => HSV) {
    let id: number | null = null;
    const at = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      return fn(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)));
    };
    const down = (e: PointerEvent) => {
      id = e.pointerId;
      el.setPointerCapture(e.pointerId);
      setHsv(at(e), false);
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId === id) setHsv(at(e), false);
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== id) return;
      id = null;
      setHsv(at(e), true);
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    return {
      destroy: () => {
        el.removeEventListener('pointerdown', down);
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
      },
    };
  }
  const svArea = (el: HTMLElement) => area(el, (fx, fy) => ({ h: hsv.h, s: fx, v: 1 - fy }));
  const hueArea = (el: HTMLElement) => area(el, (fx) => ({ ...hsv, h: Math.min(359.9, fx * 360) }));

  const quick = $derived([...new Set([ed.fg, ed.bg, ...ed.swatches])].slice(0, 16));
</script>

<span class="wrap" use:dismiss={{ open, close: () => (open = false) }}>
  <button class="sw" class:big class:none={!value} style:background={value ?? undefined} title="{label}: {value ?? 'none'}" aria-label="{label} color" aria-expanded={open} onclick={show}></button>
  {#if open}
    <div class="pop" class:left data-over-canvas role="dialog" aria-label="{label} color">
      <div class="row">
        <button class="none-btn" class:on={!value} onclick={() => pick(null)}><span class="sw none small"></span>None</button>
        <label class="hex">#<input type="text" maxlength="7" bind:value={hex} onchange={() => {
          const c = parseHex(hex);
          if (c) pick(c);
          else hex = (value ?? '').slice(1);
        }} /></label>
      </div>
      <div class="sv" style:background-color={hsvToHex({ h: hsv.h, s: 1, v: 1 })} use:svArea>
        <div class="knob" style:left="{hsv.s * 100}%" style:top="{(1 - hsv.v) * 100}%"></div>
      </div>
      <div class="hue" use:hueArea>
        <div class="hknob" style:left="{(hsv.h / 360) * 100}%"></div>
      </div>
      <div class="quick">
        {#each quick as c, i (c)}
          <button style:background={c} title={i === 0 ? `Foreground ${c}` : i === 1 ? `Background ${c}` : c} aria-label={c} onclick={() => pick(c)}></button>
        {/each}
      </div>
    </div>
  {/if}
</span>

<style>
  .wrap {
    position: relative;
    display: inline-flex;
  }
  .sw {
    width: 24px;
    height: 20px;
    padding: 0;
    border-radius: 3px;
    border: 1px solid #000;
    box-shadow: inset 0 0 0 1px #777;
  }
  .sw.big {
    width: 44px;
    height: 34px;
    border-radius: 6px;
  }
  .sw.small {
    display: inline-block;
    width: 14px;
    height: 12px;
  }
  /* No color: a checkerboard with a red slash. */
  .none {
    background:
      linear-gradient(to top right, transparent calc(50% - 1px), #e03131 calc(50% - 1px), #e03131 calc(50% + 1px), transparent calc(50% + 1px)),
      repeating-conic-gradient(#fff 0 25%, #ccc 0 50%) 0 0 / 8px 8px;
  }
  .pop {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 30;
    width: 224px;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  }
  .pop.left {
    left: 0;
    right: auto;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .none-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 8px;
    font-size: 11px;
  }
  .none-btn.on {
    border-color: var(--accent-dim);
    background: #24394c;
  }
  .hex {
    display: flex;
    align-items: center;
    gap: 2px;
    color: var(--text-dim);
    margin-left: auto;
  }
  .hex input {
    width: 70px;
    font-family: ui-monospace, monospace;
  }
  .sv {
    position: relative;
    height: 120px;
    border-radius: 3px;
    background-image: linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent);
    cursor: crosshair;
    touch-action: none;
  }
  .knob {
    position: absolute;
    width: 12px;
    height: 12px;
    margin: -6px 0 0 -6px;
    border-radius: 50%;
    border: 2px solid #fff;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6);
    pointer-events: none;
  }
  .hue {
    position: relative;
    height: 12px;
    border-radius: 3px;
    background: linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00);
    cursor: ew-resize;
    touch-action: none;
  }
  .hknob {
    position: absolute;
    top: -2px;
    width: 6px;
    height: 16px;
    margin-left: -3px;
    border-radius: 2px;
    border: 1px solid #fff;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6);
    pointer-events: none;
  }
  .quick {
    display: grid;
    grid-template-columns: repeat(8, 1fr);
    gap: 3px;
  }
  .quick button {
    aspect-ratio: 1;
    padding: 0;
    border: 1px solid #000;
    border-radius: 2px;
  }
  @media (pointer: coarse) {
    .sv {
      height: 150px;
    }
    .hue {
      height: 22px;
    }
    .hknob {
      height: 26px;
    }
  }
</style>
