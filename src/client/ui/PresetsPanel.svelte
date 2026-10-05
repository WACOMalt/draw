<script lang="ts">
  // Shared brush presets, grouped by creator. A click applies a preset to the brush (or to the
  // eraser while it is the tool). "Save" stores the current settings for everyone.
  import { onMount } from 'svelte';
  import type { BrushPreset } from '../../shared/types';
  import { applyPreset, deletePreset, loadPresets, myCreators, savePreset } from '../presets';
  import { presetThumb } from '../presetThumb';
  import { ed, showToast } from '../state.svelte';

  let { stacked = false }: { stacked?: boolean } = $props();

  let presets = $state<BrushPreset[] | null>(null);
  let error = $state('');
  let mine = $state<Set<string>>(new Set());
  let name = $state('');
  let busy = $state(false);

  const COLLAPSED_KEY = 'draw.presetGroups';
  let collapsed = $state<Set<string>>(readCollapsed());
  function readCollapsed(): Set<string> {
    try {
      return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]'));
    } catch {
      return new Set();
    }
  }
  function toggle(creator: string) {
    const next = new Set(collapsed);
    if (next.has(creator)) next.delete(creator);
    else next.add(creator);
    collapsed = next;
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
    } catch {
      // storage may be unavailable
    }
  }

  async function refresh() {
    const [r, keys] = await Promise.all([loadPresets(), myCreators()]);
    mine = keys;
    if ('error' in r) error = r.error;
    else {
      presets = r;
      error = '';
    }
  }
  onMount(() => void refresh());

  /** Creator groups: mine first, then by name. The newest preset gives the group label. */
  const groups = $derived.by(() => {
    const map = new Map<string, { creator: string; name: string; items: BrushPreset[] }>();
    for (const p of presets ?? []) {
      let g = map.get(p.creator);
      if (!g) map.set(p.creator, (g = { creator: p.creator, name: p.creatorName, items: [] }));
      g.items.push(p);
      g.name = p.creatorName;
    }
    return [...map.values()].sort((a, b) => Number(mine.has(b.creator)) - Number(mine.has(a.creator)) || a.name.localeCompare(b.name));
  });

  const canDelete = (p: BrushPreset) => !!ed.user?.admin || mine.has(p.creator);

  async function save(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    const r = await savePreset(name.trim(), $state.snapshot(ed.activeBrush));
    busy = false;
    if ('error' in r) return showToast(r.error);
    presets = [...(presets ?? []), r];
    mine = await myCreators();
    name = '';
    showToast(`Saved "${r.name}" for everyone`);
  }

  async function remove(p: BrushPreset) {
    if (!confirm(`Delete the preset "${p.name}" for everyone?`)) return;
    const err = await deletePreset(p.id);
    if (err) return showToast(err);
    presets = (presets ?? []).filter((x) => x.id !== p.id);
  }

  function apply(p: BrushPreset) {
    applyPreset(p);
    showToast(`${ed.tool === 'eraser' ? 'Eraser' : 'Brush'}: ${p.name}`);
  }
</script>

<div class="presets" class:stacked>
  <form class="save" onsubmit={save}>
    <input type="text" placeholder="Name for the current {ed.tool === 'eraser' ? 'eraser' : 'brush'}" maxlength="40" bind:value={name} required />
    <button type="submit" disabled={busy || !name.trim()} title="Save the current settings as a preset for everyone">Save</button>
  </form>

  {#if error}
    <p class="msg">{error} <button class="linklike" onclick={refresh}>Try again</button></p>
  {:else if presets === null}
    <p class="msg">Loading presets…</p>
  {:else if presets.length === 0}
    <p class="msg">No presets yet. Save the first one.</p>
  {/if}

  <div class="groups">
    {#each groups as g (g.creator)}
      <section>
        <button class="group" aria-expanded={!collapsed.has(g.creator)} onclick={() => toggle(g.creator)}>
          <span class="chev" class:open={!collapsed.has(g.creator)}>›</span>
          {g.name}
          {#if mine.has(g.creator)}<span class="you">you</span>{/if}
          <span class="count">{g.items.length}</span>
        </button>
        {#if !collapsed.has(g.creator)}
          <div class="grid">
            {#each g.items as p (p.id)}
              <div class="card">
                <button class="pick" title="Use {p.name}" onclick={() => apply(p)}>
                  <img src={presetThumb(p.settings)} alt="" width="160" height="56" />
                  <span class="name">{p.name}</span>
                </button>
                {#if canDelete(p)}
                  <button class="del" title="Delete this preset" aria-label="Delete {p.name}" onclick={() => remove(p)}>×</button>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </section>
    {/each}
  </div>
</div>

<style>
  .presets {
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 360px;
    max-height: min(70vh, 640px);
  }
  .presets.stacked {
    width: auto;
    max-height: none;
  }
  .save {
    display: flex;
    gap: 6px;
  }
  .save input {
    flex: 1;
    min-width: 0;
    padding: 5px 8px;
  }
  .groups {
    overflow-y: auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .group {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 4px 2px;
    background: none;
    border: none;
    font-weight: 600;
    color: var(--text);
    text-align: left;
  }
  .chev {
    display: inline-block;
    width: 12px;
    color: var(--text-dim);
    transition: transform 0.12s;
  }
  .chev.open {
    transform: rotate(90deg);
  }
  .you {
    font-size: 10px;
    font-weight: 400;
    padding: 0 5px;
    border-radius: 6px;
    background: #24394c;
    color: var(--text-dim);
  }
  .count {
    margin-left: auto;
    font-weight: 400;
    font-size: 11px;
    color: var(--text-faint);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 6px;
    padding: 2px 0 6px;
  }
  .card {
    position: relative;
  }
  .pick {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 2px;
    padding: 4px;
    background: var(--bg-0);
    border: 1px solid var(--border);
    border-radius: 4px;
  }
  .pick:hover {
    border-color: var(--accent);
  }
  .pick img {
    width: 100%;
    height: auto;
    aspect-ratio: 160 / 56;
  }
  .name {
    font-size: 11.5px;
    text-align: center;
    padding: 2px 0;
    border-top: 1px solid var(--line);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .del {
    position: absolute;
    top: 2px;
    right: 2px;
    width: 18px;
    height: 18px;
    padding: 0;
    line-height: 16px;
    border-radius: 9px;
    background: rgba(0, 0, 0, 0.55);
    border: none;
    color: var(--text-dim);
    opacity: 0;
  }
  .card:hover .del,
  .stacked .del {
    opacity: 1;
  }
  .del:hover {
    color: #fff;
    background: var(--danger);
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
  }
</style>
