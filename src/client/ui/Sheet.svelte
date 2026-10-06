<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';
  import { dismiss } from '../dismiss';

  // Bottom sheet for the phone layout. A press anywhere outside closes it (the bottom bar
  // switches sheets itself). The dim backdrop lets presses through: a finger on the canvas
  // closes the sheet and pans, and two fingers pinch-zoom at once.
  let { title, onClose, children, tall = false }: { title: string; onClose: () => void; children: Snippet; tall?: boolean } = $props();
</script>

<div class="backdrop"></div>
<div class="sheet" class:tall role="dialog" aria-label={title} use:dismiss={{ open: true, close: onClose, keep: '.mobilebar' }}>
  <header>
    <span>{title}</span>
    <button class="icon" aria-label="Close" onclick={onClose}><Icon name="close" /></button>
  </header>
  <div class="body">{@render children()}</div>
</div>

<style>
  .backdrop {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.35);
    z-index: 20;
    pointer-events: none;
  }
  .sheet {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 21;
    max-height: 72%;
    display: flex;
    flex-direction: column;
    background: var(--bg-2);
    border-top: 1px solid var(--border);
    border-radius: 12px 12px 0 0;
    box-shadow: 0 -10px 30px rgba(0, 0, 0, 0.4);
    animation: up 0.16s ease-out;
  }
  .sheet.tall {
    height: 72%;
  }
  /* Landscape phones: a side panel on the right, full height, instead of a short wide strip. */
  @media (orientation: landscape) and (max-height: 520px) {
    .sheet,
    .sheet.tall {
      left: auto;
      top: 0;
      width: min(380px, 62%);
      height: auto;
      max-height: none;
      border-top: none;
      border-left: 1px solid var(--border);
      border-radius: 12px 0 0 12px;
      box-shadow: -10px 0 30px rgba(0, 0, 0, 0.4);
      animation-name: left;
    }
  }
  @keyframes left {
    from {
      transform: translateX(30px);
      opacity: 0;
    }
  }
  @keyframes up {
    from {
      transform: translateY(30px);
      opacity: 0;
    }
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 8px 4px 16px;
    font-weight: 600;
    font-size: 13px;
  }
  /* The sheet header already names the panel. */
  .body :global(h2) {
    display: none;
  }
  .body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }
</style>
