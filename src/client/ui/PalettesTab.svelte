<script lang="ts">
  // Color palettes: your own (shared with everyone, under your name), paint palettes built in, and
  // the palettes of other people, grouped by creator. A tap on a swatch makes it the color.
  // "Add current color" adds to your active palette (it makes one when you have none).
  import { onMount } from 'svelte';
  import type { Engine } from '../engine/engine';
  import type { Palette, PaletteColor } from '../../shared/types';
  import { BUILTIN_PALETTES } from '../../shared/paints';
  import { LIMITS } from '../../shared/types';
  import { deletePalette, loadPalettes, savePalette, updatePalette } from '../palettes';
  import { myCreators } from '../presets';
  import { ed, showToast } from '../state.svelte';

  let { engine }: { engine: Engine | null } = $props();

  let palettes = $state<Palette[] | null>(null);
  let error = $state('');
  let mine = $state<Set<string>>(new Set());
  let editing = $state<string | null>(null);
  let busy = $state(false);
  /** The swatch picked last, for the line under the buttons. */
  let picked = $state<PaletteColor | null>(null);

  function readSet(key: string): Set<string> {
    try {
      return new Set(JSON.parse(localStorage.getItem(key) ?? '[]'));
    } catch {
      return new Set();
    }
  }
  function store(key: string, value: unknown) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // storage may be unavailable
    }
  }

  const COLLAPSED_KEY = 'draw.paletteGroups';
  const ACTIVE_KEY = 'draw.activePalette';
  let collapsed = $state<Set<string>>(readSet(COLLAPSED_KEY));
  let active = $state<string | null>(readActive());
  function readActive(): string | null {
    try {
      return JSON.parse(localStorage.getItem(ACTIVE_KEY) ?? 'null');
    } catch {
      return null;
    }
  }
  function setActive(id: string) {
    active = id;
    store(ACTIVE_KEY, id);
  }
  function toggle(key: string) {
    const next = new Set(collapsed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    collapsed = next;
    store(COLLAPSED_KEY, [...next]);
  }

  async function refresh() {
    const [r, keys] = await Promise.all([loadPalettes(), myCreators()]);
    mine = keys;
    if ('error' in r) error = r.error;
    else {
      palettes = r;
      error = '';
    }
  }
  onMount(() => void refresh());

  const own = $derived((palettes ?? []).filter((p) => mine.has(p.creator)));
  /** The palette "Add current color" adds to: the active one, or else the newest of mine. */
  const target = $derived(own.find((p) => p.id === active) ?? own.at(-1) ?? null);
  /** Palettes of other people, grouped by creator, by name. */
  const others = $derived.by(() => {
    const map = new Map<string, { creator: string; name: string; items: Palette[] }>();
    for (const p of palettes ?? []) {
      if (mine.has(p.creator)) continue;
      let g = map.get(p.creator);
      if (!g) map.set(p.creator, (g = { creator: p.creator, name: p.creatorName, items: [] }));
      g.items.push(p);
      g.name = p.creatorName;
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  });

  function pick(c: PaletteColor) {
    ed.fg = c.hex;
    engine?.addSwatch(c.hex);
    picked = c;
  }

  function replace(p: Palette) {
    palettes = (palettes ?? []).map((x) => (x.id === p.id ? p : x));
  }

  async function change(p: Palette, next: { name?: string; colors?: PaletteColor[] }) {
    const before = p;
    replace({ ...p, ...next });
    const r = await updatePalette(p.id, next);
    if ('error' in r) {
      replace(before);
      showToast(r.error);
    } else replace(r);
  }

  async function addTo(p: Palette | null) {
    const color: PaletteColor = { hex: ed.fg };
    if (!p) {
      busy = true;
      const r = await savePalette('My colors', [color]);
      busy = false;
      if ('error' in r) return showToast(r.error);
      palettes = [...(palettes ?? []), r];
      mine = await myCreators();
      setActive(r.id);
      return;
    }
    setActive(p.id);
    if (p.colors.some((c) => c.hex === color.hex)) return showToast(`${color.hex} is already in ${p.name}`);
    if (p.colors.length >= LIMITS.maxPaletteColors) return showToast(`A palette holds at most ${LIMITS.maxPaletteColors} colors.`);
    await change(p, { colors: [...p.colors, color] });
  }

  async function newPalette() {
    const name = prompt('Name of the new palette', 'My colors')?.trim();
    if (!name) return;
    busy = true;
    const r = await savePalette(name.slice(0, LIMITS.maxPaletteName), []);
    busy = false;
    if ('error' in r) return showToast(r.error);
    palettes = [...(palettes ?? []), r];
    mine = await myCreators();
    setActive(r.id);
    editing = null;
  }

  async function remove(p: Palette) {
    if (!confirm(`Delete the palette "${p.name}" for everyone?`)) return;
    const err = await deletePalette(p.id);
    if (err) return showToast(err);
    palettes = (palettes ?? []).filter((x) => x.id !== p.id);
    if (editing === p.id) editing = null;
  }

  function rename(p: Palette, value: string) {
    const name = value.trim().slice(0, LIMITS.maxPaletteName);
    if (name && name !== p.name) void change(p, { name });
  }

  const canDelete = (p: Palette) => !!ed.user?.admin || mine.has(p.creator);
</script>

<div class="palettes">
  <div class="bar">
    <span class="current" style:background={ed.fg}></span>
    <button class="add" disabled={busy || !!error} onclick={() => addTo(target)} title={target ? `Add the current color to ${target.name}` : 'Make a palette with the current color'}>
      + Add current color
    </button>
    <button disabled={busy || !!error} onclick={newPalette} title="Make a new palette, shared with everyone under your name">New palette</button>
  </div>
  <p class="status">
    {#if picked}{picked.name ? `${picked.name} · ` : ''}{picked.hex}{:else if target}Adds to <b>{target.name}</b>{:else}&nbsp;{/if}
  </p>

  <div class="scroll">
    {#if error}
      <p class="msg">{error} <button class="linklike" onclick={refresh}>Try again</button></p>
    {:else if palettes === null}
      <p class="msg">Loading palettes…</p>
    {/if}

    {#if own.length}
      <h3>Yours</h3>
      {#each own as p (p.id)}
        <section class:active={target?.id === p.id}>
          <div class="head">
            <button class="group" aria-expanded={!collapsed.has(p.id)} onclick={() => toggle(p.id)}>
              <span class="chev" class:open={!collapsed.has(p.id)}>›</span>
              <span class="title">{p.name}</span>
              <span class="count">{p.colors.length}</span>
            </button>
            <button class="tool" class:on={editing === p.id} title={editing === p.id ? 'Done' : 'Edit this palette'} onclick={() => (editing = editing === p.id ? null : p.id)}>{editing === p.id ? 'Done' : 'Edit'}</button>
          </div>
          {#if editing === p.id}
            <input class="rename" value={p.name} maxlength={LIMITS.maxPaletteName} aria-label="Palette name" onchange={(e) => rename(p, e.currentTarget.value)} />
          {/if}
          {#if !collapsed.has(p.id)}
            <div class="grid">
              {#each p.colors as c, i (c.hex + i)}
                <div class="cell">
                  <button class="sw" style:background={c.hex} title={c.name ?? c.hex} aria-label={c.name ?? c.hex} onclick={() => pick(c)}></button>
                  {#if editing === p.id}
                    <button class="x" title="Remove this color" aria-label="Remove {c.hex}" onclick={() => change(p, { colors: p.colors.filter((_, j) => j !== i) })}>×</button>
                  {/if}
                </div>
              {/each}
              <button class="sw plus" title="Add the current color to {p.name}" aria-label="Add the current color to {p.name}" onclick={() => addTo(p)}>+</button>
            </div>
            {#if editing === p.id && canDelete(p)}
              <button class="linklike danger" onclick={() => remove(p)}>Delete this palette</button>
            {/if}
          {/if}
        </section>
      {/each}
    {/if}

    <h3>Paint</h3>
    {#each BUILTIN_PALETTES as p (p.id)}
      <section>
        <button class="group" aria-expanded={!collapsed.has(p.id)} onclick={() => toggle(p.id)}>
          <span class="chev" class:open={!collapsed.has(p.id)}>›</span>
          <span class="title">{p.name}</span>
          <span class="count">{p.colors.length}</span>
        </button>
        {#if !collapsed.has(p.id)}
          <p class="note">{p.note}</p>
          <div class="grid">
            {#each p.colors as c (c.hex + c.name)}
              <button class="sw" style:background={c.hex} title={c.name ?? c.hex} aria-label={c.name ?? c.hex} onclick={() => pick(c)}></button>
            {/each}
          </div>
        {/if}
      </section>
    {/each}

    {#if others.length}
      <h3>Shared</h3>
      {#each others as g (g.creator)}
        <section>
          <button class="group" aria-expanded={!collapsed.has(g.creator)} onclick={() => toggle(g.creator)}>
            <span class="chev" class:open={!collapsed.has(g.creator)}>›</span>
            <span class="title">{g.name}</span>
            <span class="count">{g.items.length}</span>
          </button>
          {#if !collapsed.has(g.creator)}
            {#each g.items as p (p.id)}
              <div class="sub">
                <span>{p.name}</span>
                {#if canDelete(p)}
                  <button class="linklike danger" title="Delete this palette" onclick={() => remove(p)}>Delete</button>
                {/if}
              </div>
              <div class="grid">
                {#each p.colors as c, i (c.hex + i)}
                  <button class="sw" style:background={c.hex} title={c.name ?? c.hex} aria-label={c.name ?? c.hex} onclick={() => pick(c)}></button>
                {/each}
              </div>
            {/each}
          {/if}
        </section>
      {/each}
    {/if}
  </div>
</div>

<style>
  .palettes {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .current {
    width: 22px;
    height: 22px;
    flex: none;
    border-radius: 3px;
    border: 1px solid #000;
  }
  .bar button {
    min-width: 0;
    padding: 4px 8px;
    white-space: nowrap;
  }
  .bar .add {
    flex: 1;
  }
  .status {
    margin: 0;
    min-height: 16px;
    font-size: 11px;
    color: var(--text-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .scroll {
    max-height: min(46vh, 420px);
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  h3 {
    margin: 8px 0 2px;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: var(--text-faint);
  }
  section {
    border-radius: 4px;
    padding: 0 2px 4px;
  }
  section.active {
    background: var(--accent-dim);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .group {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
    padding: 4px 2px;
    background: none;
    border: none;
    color: var(--text);
    font-weight: 600;
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }
  .title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chev {
    display: inline-block;
    width: 12px;
    flex: none;
    color: var(--text-dim);
    transition: transform 0.12s;
  }
  .chev.open {
    transform: rotate(90deg);
  }
  .count {
    margin-left: auto;
    font-weight: 400;
    font-size: 11px;
    color: var(--text-faint);
  }
  .rename {
    display: block;
    width: calc(100% - 18px);
    margin: 0 0 4px 18px;
    padding: 2px 4px;
    font-size: 12px;
  }
  .tool {
    padding: 2px 8px;
    font-size: 11px;
  }
  .tool.on {
    border-color: var(--accent);
    color: var(--accent);
  }
  .note {
    margin: 0 0 4px 18px;
    font-size: 11px;
    color: var(--text-dim);
  }
  .sub {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin: 4px 0 2px 18px;
    font-size: 11px;
    color: var(--text-dim);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(9, 1fr);
    gap: 3px;
  }
  .cell {
    position: relative;
  }
  .sw {
    display: block;
    width: 100%;
    aspect-ratio: 1;
    padding: 0;
    border: 1px solid #000;
    border-radius: 2px;
    cursor: pointer;
  }
  .plus {
    background: none;
    border: 1px dashed var(--border);
    color: var(--text-dim);
    font-size: 14px;
    line-height: 1;
  }
  .x {
    position: absolute;
    top: -5px;
    right: -5px;
    width: 16px;
    height: 16px;
    padding: 0;
    border-radius: 50%;
    border: 1px solid var(--border);
    background: var(--danger);
    color: #fff;
    font-size: 11px;
    line-height: 1;
  }
  .msg {
    margin: 0;
    color: var(--text-dim);
    font-size: 12px;
  }
  .linklike {
    background: none;
    border: none;
    padding: 0;
    color: var(--accent);
    cursor: pointer;
    font-size: 11px;
  }
  .linklike.danger {
    color: var(--danger);
    margin: 4px 0 0 18px;
  }
  .sub .linklike.danger {
    margin: 0;
  }
</style>
