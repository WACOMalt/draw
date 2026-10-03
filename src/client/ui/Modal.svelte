<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';

  let { title, onClose, children, wide = false }: { title: string; onClose: () => void; children: Snippet; wide?: boolean } = $props();
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && onClose()} />

<div class="backdrop" role="presentation" onpointerdown={(e) => e.target === e.currentTarget && onClose()}>
  <div class="card" class:wide role="dialog" aria-modal="true" aria-label={title}>
    <header>
      <h2>{title}</h2>
      <button class="icon" aria-label="Close" onclick={onClose}><Icon name="close" /></button>
    </header>
    <div class="body">{@render children()}</div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: grid;
    place-items: center;
    padding: 16px;
    background: rgba(0, 0, 0, 0.5);
  }
  .card {
    width: min(380px, 100%);
    max-height: calc(100dvh - 32px);
    display: flex;
    flex-direction: column;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  }
  .card.wide {
    width: min(520px, 100%);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 12px 6px 20px;
  }
  h2 {
    margin: 0;
    font-size: 16px;
  }
  .body {
    padding: 6px 20px 20px;
    overflow-y: auto;
  }
  .body :global(label) {
    display: block;
    margin: 10px 0 4px;
    color: var(--text-dim);
  }
  .body :global(input[type='text']),
  .body :global(input[type='email']),
  .body :global(input[type='password']) {
    width: 100%;
    font-size: 14px;
    padding: 8px 10px;
    background: var(--bg-0);
    border: 1px solid var(--border);
    border-radius: 4px;
    outline: none;
  }
  .body :global(input:focus) {
    border-color: var(--accent);
  }
  .body :global(.actions) {
    display: flex;
    gap: 8px;
    margin-top: 16px;
  }
  .body :global(.actions .primary) {
    flex: 1;
    padding: 9px;
  }
  .body :global(.error) {
    color: var(--danger);
    margin: 10px 0 0;
  }
  .body :global(.muted) {
    color: var(--text-dim);
  }
  .body :global(.linklike) {
    background: none;
    border: none;
    padding: 0;
    color: var(--accent);
    cursor: pointer;
  }
</style>
