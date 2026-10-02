<script lang="ts">
  import { ed } from '../state.svelte';

  const zoom = $derived(ed.view.zoom >= 0.1 ? `${Math.round(ed.view.zoom * 100)}%` : `${(ed.view.zoom * 100).toFixed(1)}%`);
</script>

<footer>
  <span>{zoom}</span>
  <span class="dim">{ed.cursor ? `${Math.round(ed.cursor.x)}, ${Math.round(ed.cursor.y)}` : '—'}</span>
  <span class="dim">{ed.strokeCount} strokes</span>
  <span class="grow"></span>
  <span class="dim">{ed.peers.length + 1} {ed.peers.length ? 'people' : 'person'} here</span>
  <span class="state {ed.status}">{ed.status}</span>
</footer>

<style>
  footer {
    grid-area: status;
    display: flex;
    align-items: center;
    gap: 18px;
    padding: 0 10px;
    background: var(--bg-1);
    border-top: 1px solid var(--border);
    font-size: 11px;
  }
  .dim {
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
  }
  .grow {
    flex: 1;
  }
  .state::before {
    content: '';
    display: inline-block;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    margin-right: 5px;
    background: #ffd43b;
  }
  .state.online::before {
    background: #69db7c;
  }
  .state.offline::before {
    background: var(--danger);
  }
</style>
