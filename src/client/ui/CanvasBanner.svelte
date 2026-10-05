<script lang="ts">
  import { ed } from '../state.svelte';
  import ClaimDialog from './ClaimDialog.svelte';

  let { code }: { code: string } = $props();
  let now = $state(Date.now());
  let claiming = $state(false);

  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(t);
  });

  const left = $derived.by(() => {
    const ms = (ed.canvas?.expiresAt ?? 0) - now;
    if (ms <= 0) return 'soon';
    const h = Math.floor(ms / 3600_000);
    return h >= 24 ? `${Math.floor(h / 24)} d ${h % 24} h` : h >= 1 ? `${h} h` : `${Math.max(1, Math.round(ms / 60_000))} min`;
  });

</script>

{#if ed.outdated}
  <div class="banner warn" role="alert">This canvas uses features from a newer Draw. Update the app to see it correctly.</div>
{:else if ed.canvas?.expiresAt}
  <div class="banner" class:creator={ed.canvas.canClaim}>
    <span>Temporary canvas · deleted in {left}</span>
    {#if ed.canvas.canClaim}
      {#if ed.user}
        <button class="primary" onclick={() => (claiming = true)}>Keep this canvas</button>
      {:else}
        <button class="primary" onclick={() => (ed.auth = 'login')}>Log in to keep it</button>
      {/if}
    {/if}
  </div>
{:else if ed.role === 'viewer'}
  <div class="banner view">View only</div>
{/if}

{#if claiming && ed.canvas?.canClaim}<ClaimDialog {code} onClose={() => (claiming = false)} />{/if}

<style>
  .banner.warn {
    background: rgba(120, 80, 10, 0.92);
    color: #fff;
    padding: 4px 12px;
  }
  .banner {
    position: absolute;
    top: 10px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 5;
    display: flex;
    align-items: center;
    gap: 10px;
    max-width: calc(100% - 120px);
    padding: 4px 6px 4px 12px;
    border-radius: 16px;
    font-size: 12px;
    white-space: nowrap;
    background: rgba(30, 30, 30, 0.88);
    border: 1px solid var(--line);
    color: var(--text-dim);
  }
  .banner span {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .banner.creator {
    color: var(--text);
    border-color: rgba(49, 168, 255, 0.5);
  }
  .banner.view {
    padding: 4px 12px;
  }
  .banner:not(:has(button)) {
    padding-right: 12px;
  }
  button {
    padding: 3px 10px;
    border-radius: 12px;
    font-size: 12px;
    white-space: nowrap;
  }
  /* A narrow stage: full width, and the text wraps instead of being cut. */
  @container (max-width: 560px) {
    .banner {
      max-width: calc(100% - 20px);
      width: max-content;
      white-space: normal;
      border-radius: 12px;
      line-height: 1.3;
    }
  }
  /* Phone layout: below the zoom pill. */
  @media (max-width: 760px) {
    .banner {
      top: 46px;
    }
  }
</style>
