<script lang="ts">
  import type { Engine } from '../engine/engine';
  import { hexToHsv, hexToRgb, hsvToHex, parseHex, type HSV } from '../color';
  import { ed } from '../state.svelte';

  let { engine }: { engine: Engine | null } = $props();

  // Local HSV keeps the hue when saturation or value reach 0.
  let hsv = $state<HSV>(hexToHsv(ed.fg));
  let lastHex = ed.fg;
  let hexInput = $state(ed.fg.slice(1));

  $effect(() => {
    const fg = ed.fg;
    if (fg !== lastHex) {
      const next = hexToHsv(fg);
      if (next.s === 0 || next.v === 0) next.h = hsv.h;
      hsv = next;
      lastHex = fg;
    }
    hexInput = fg.slice(1);
  });

  function commit(next: HSV) {
    hsv = next;
    lastHex = hsvToHex(next);
    ed.fg = lastHex;
  }

  function drag(el: HTMLElement, fn: (fx: number, fy: number) => void) {
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      fn(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)));
    };
    const down = (e: PointerEvent) => {
      el.setPointerCapture(e.pointerId);
      move(e);
      el.addEventListener('pointermove', move);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      engine?.addSwatch(ed.fg);
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    return { destroy: () => (el.removeEventListener('pointerdown', down), el.removeEventListener('pointerup', up)) };
  }

  function svArea(el: HTMLElement) {
    return drag(el, (fx, fy) => commit({ h: hsv.h, s: fx, v: 1 - fy }));
  }
  function hueArea(el: HTMLElement) {
    return drag(el, (fx) => commit({ ...hsv, h: Math.min(359.9, fx * 360) }));
  }

  function onHex(e: Event) {
    const v = parseHex((e.currentTarget as HTMLInputElement).value);
    if (v) {
      ed.fg = v;
      engine?.addSwatch(v);
    } else hexInput = ed.fg.slice(1);
  }

  const rgb = $derived(hexToRgb(ed.fg));

  function onRgb(i: number, value: string) {
    const c = [...rgb] as [number, number, number];
    c[i] = Math.max(0, Math.min(255, Math.round(+value) || 0));
    ed.fg = '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
  }
</script>

<section>
  <h2>Color</h2>
  <div class="sv" style:background-color={hsvToHex({ h: hsv.h, s: 1, v: 1 })} use:svArea>
    <div class="knob" style:left="{hsv.s * 100}%" style:top="{(1 - hsv.v) * 100}%"></div>
  </div>
  <div class="hue" use:hueArea>
    <div class="hknob" style:left="{(hsv.h / 360) * 100}%"></div>
  </div>
  <div class="fields">
    <span class="preview" style:background={ed.fg}></span>
    <label>#<input type="text" class="hex" maxlength="7" bind:value={hexInput} onchange={onHex} /></label>
    {#each ['R', 'G', 'B'] as ch, i}
      <label>{ch}<input type="number" min="0" max="255" value={rgb[i]} onchange={(e) => onRgb(i, e.currentTarget.value)} /></label>
    {/each}
  </div>
  {#if ed.swatches.length}
    <div class="swatches">
      {#each ed.swatches as c (c)}
        <button style:background={c} title={c} aria-label={c} onclick={() => (ed.fg = c)}></button>
      {/each}
    </div>
  {/if}
</section>

<style>
  section {
    padding: 8px 10px 10px;
    border-bottom: 1px solid var(--border);
  }
  h2 {
    margin: 0 0 8px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: var(--text-dim);
  }
  .sv {
    position: relative;
    height: 140px;
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
    margin-top: 8px;
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
    border: 2px solid #fff;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6);
    pointer-events: none;
  }
  .fields {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 8px;
    color: var(--text-dim);
  }
  .preview {
    width: 20px;
    height: 20px;
    border-radius: 3px;
    border: 1px solid #000;
    flex: none;
  }
  .fields label {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .hex {
    width: 62px;
    font-family: ui-monospace, monospace;
  }
  .fields input[type='number'] {
    width: 34px;
    padding: 3px 2px;
    text-align: center;
  }
  .swatches {
    display: grid;
    grid-template-columns: repeat(9, 1fr);
    gap: 3px;
    margin-top: 8px;
  }
  .swatches button {
    aspect-ratio: 1;
    padding: 0;
    border: 1px solid #000;
    border-radius: 2px;
  }
</style>
