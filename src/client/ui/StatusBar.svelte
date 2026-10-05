<script lang="ts">
  import { ed } from '../state.svelte';

  const zoom = $derived.by(() => {
    const z = ed.view.zoom;
    if (z >= 100 || z < 0.001) return `×${z.toExponential(1).replace('e+', 'e')}`;
    return z >= 0.1 ? `${Math.round(z * 100)}%` : `${(z * 100).toFixed(1)}%`;
  });
  // Show enough decimals that the coordinates still move at deep zoom.
  const decimals = $derived(Math.max(0, Math.min(12, Math.ceil(Math.log10(ed.view.zoom)))));
</script>

<footer>
  <span>{zoom}</span>
  <span class="dim">{ed.cursor ? `${ed.cursor.x.toFixed(decimals)}, ${ed.cursor.y.toFixed(decimals)}` : '—'}</span>
  <span class="dim">{ed.strokeCount} strokes</span>
  <span class="grow"></span>
  <span class="dim" title="Renderer and bits per channel of its buffers">{ed.renderer}</span>
  <span class="dim" title="App version">v{__APP_VERSION__}</span>
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
    white-space: nowrap;
    overflow: hidden;
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
