<script lang="ts">
  import { SHAPE_KINDS, type ShapeKind } from '../../shared/types';
  import type { Engine } from '../engine/engine';
  import { SHAPE_LABEL } from '../engine/shapeTool';
  import { ed, type Tool } from '../state.svelte';
  import Icon from './Icon.svelte';
  import { dismiss } from '../dismiss';

  let { engine }: { engine: Engine | null } = $props();

  // Top: painting tools, the colors, the eyedropper, Select, Pen and Shapes. Bottom: navigation.
  type T = { id: Tool; icon: string; label: string; key: string };
  const PAINT: T[] = [
    { id: 'brush', icon: 'brush', label: 'Brush', key: 'B' },
    { id: 'eraser', icon: 'eraser', label: 'Eraser', key: 'E' },
    { id: 'strokeEraser', icon: 'strokeEraser', label: 'Stroke eraser: removes whole strokes', key: 'Shift+E' },
  ];
  const PICK: T = { id: 'eyedropper', icon: 'eyedropper', label: 'Eyedropper', key: 'I' };
  const SELECT: T = { id: 'select', icon: 'select', label: 'Select: shapes (double-click: their points), or the whole layer on a paint layer', key: 'V' };
  const PEN: T = { id: 'pen', icon: 'pen', label: 'Pen: click for corners, drag for curves', key: 'P' };
  const VIEW: T[] = [
    { id: 'hand', icon: 'hand', label: 'Hand', key: 'H' },
    { id: 'zoom', icon: 'zoom', label: 'Zoom: click zooms in, Alt+click or right-click zooms out, drag sideways', key: 'Z' },
  ];

  function select(t: Tool) {
    ed.tool = t;
    engine?.updateCursor();
  }

  /** The shape kinds menu, placed beside the button (the bar scrolls, so the menu is fixed). */
  let flyout = $state<{ x: number; y: number } | null>(null);
  let shapeBtn = $state<HTMLButtonElement>()!;

  function openFlyout() {
    const r = shapeBtn.getBoundingClientRect();
    flyout = { x: r.right + 6, y: Math.min(r.top, window.innerHeight - 200) };
  }

  function pickKind(k: ShapeKind) {
    ed.shapeKind = k;
    flyout = null;
    // The options bar then shows the settings of the new kind, not of a selected shape.
    engine?.shapes.deselect();
    select('shape');
  }

  // A long press on the Shapes button opens the menu too (pens and fingers have no right click).
  let pressTimer: number | undefined;
  /** The long press opened the menu: the click that follows it does nothing. */
  let pressed = false;
</script>

{#snippet tool(t: T)}
  <button class="icon tool" class:on={ed.tool === t.id} title="{t.label} ({t.key})" aria-label={t.label} onclick={() => select(t.id)}>
    <Icon name={t.icon} />
  </button>
{/snippet}

<nav>
  {#each PAINT as t}{@render tool(t)}{/each}

  <div class="colors">
    <button class="swatch bg" style:background={ed.bg} title="Background color (X swaps)" aria-label="Background color" onclick={() => ([ed.fg, ed.bg] = [ed.bg, ed.fg])}></button>
    <button class="swatch fg" style:background={ed.fg} title="Foreground color" aria-label="Foreground color"></button>
    <button class="icon mini swap" title="Swap colors (X)" onclick={() => ([ed.fg, ed.bg] = [ed.bg, ed.fg])}><Icon name="swap" /></button>
    <button class="mini reset" title="Default colors (D)" aria-label="Default colors" onclick={() => ((ed.fg = '#000000'), (ed.bg = '#ffffff'))}></button>
  </div>

  {@render tool(PICK)}
  <span class="sep"></span>
  {@render tool(SELECT)}
  {@render tool(PEN)}
  <span class="shapewrap" use:dismiss={{ open: !!flyout, close: () => (flyout = null) }}>
    <button
      bind:this={shapeBtn}
      class="icon tool more"
      class:on={ed.tool === 'shape'}
      title="Shapes: {SHAPE_LABEL[ed.shapeKind]} (U; Shift+U: next shape). Click again, or right-click, for the other shapes."
      aria-label="Shapes"
      aria-haspopup="menu"
      aria-expanded={!!flyout}
      onclick={() => {
        if (pressed) return void (pressed = false);
        if (ed.tool === 'shape') {
          if (flyout) flyout = null;
          else openFlyout();
        } else select('shape');
      }}
      oncontextmenu={(e) => {
        e.preventDefault();
        openFlyout();
      }}
      onpointerdown={() => {
        window.clearTimeout(pressTimer);
        pressed = false;
        pressTimer = window.setTimeout(() => {
          pressed = true;
          openFlyout();
        }, 450);
      }}
      onpointerup={() => window.clearTimeout(pressTimer)}
      onpointerleave={() => window.clearTimeout(pressTimer)}
    >
      <Icon name={ed.shapeKind} />
    </button>
    {#if flyout}
      <div class="flyout" role="menu" style:left="{flyout.x}px" style:top="{flyout.y}px" data-over-canvas>
        {#each SHAPE_KINDS as k}
          <button role="menuitem" class:on={ed.shapeKind === k} onclick={() => pickKind(k)}>
            <Icon name={k} /><span>{SHAPE_LABEL[k]}</span><kbd>U</kbd>
          </button>
        {/each}
      </div>
    {/if}
  </span>

  <span class="grow"></span>
  {#each VIEW as t}{@render tool(t)}{/each}
</nav>

<style>
  nav {
    grid-area: tools;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 8px 0;
    background: var(--bg-2);
    border-right: 1px solid var(--border);
    /* A very small window (options in 3 rows, 400 px tall) scrolls the bar: a thin scrollbar
       shows that Hand and Zoom are below. */
    overflow-y: auto;
    scrollbar-width: thin;
  }
  .tool {
    width: 32px;
    height: 30px;
    flex: none;
  }
  .sep {
    flex: none;
    width: 22px;
    height: 1px;
    margin: 3px 0;
    background: var(--line);
  }
  /* A small triangle in the corner: the button has a menu. */
  .more {
    position: relative;
  }
  .more::after {
    content: '';
    position: absolute;
    right: 3px;
    bottom: 3px;
    border-left: 4px solid transparent;
    border-bottom: 4px solid var(--text-dim);
  }
  .shapewrap {
    display: contents;
  }
  .flyout {
    position: fixed;
    z-index: 40;
    display: flex;
    flex-direction: column;
    min-width: 190px;
    padding: 4px;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  }
  .flyout button {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 30px;
    padding: 0 10px;
    text-align: left;
    background: none;
    border: none;
    border-radius: 4px;
  }
  .flyout button:hover {
    background: #2d3d4d;
  }
  .flyout button.on {
    background: #1f6fb0;
    color: #fff;
  }
  .flyout span {
    flex: 1;
  }
  .flyout kbd {
    font: inherit;
    color: var(--text-faint);
  }
  .flyout button.on kbd {
    color: #cfe8ff;
  }
  .grow {
    flex: 1;
    min-height: 8px;
  }
  .colors {
    position: relative;
    flex: none;
    width: 36px;
    height: 44px;
    margin: 6px 0;
  }
  .swatch {
    position: absolute;
    width: 22px;
    height: 22px;
    padding: 0;
    border: 1px solid #000;
    box-shadow: 0 0 0 1px #777 inset;
    border-radius: 2px;
  }
  .swatch:hover {
    filter: brightness(1.05);
  }
  .fg {
    left: 2px;
    top: 2px;
    z-index: 1;
  }
  .bg {
    left: 12px;
    top: 12px;
  }
  .mini {
    position: absolute;
    width: 12px;
    height: 12px;
    padding: 0;
  }
  .swap {
    right: -2px;
    top: 0;
  }
  .swap :global(svg) {
    width: 11px;
    height: 11px;
  }
  /* Short windows: a tighter bar, so every tool shows without scrolling. */
  @media (max-height: 480px) {
    nav {
      gap: 1px;
      padding: 4px 0;
    }
    .tool {
      height: 27px;
    }
    .colors {
      margin: 3px 0;
    }
  }
  .reset {
    left: 1px;
    bottom: 1px;
    background: linear-gradient(135deg, #000 50%, #fff 50%);
    border: 1px solid #777;
    width: 10px;
    height: 10px;
    border-radius: 1px;
  }
</style>
