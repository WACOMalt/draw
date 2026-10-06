<script lang="ts">
  // The app update dialog (Android and the Linux AppImage): see update.svelte.ts.
  import Modal from './Modal.svelte';
  import { grantPermission, restartApp, retryInstall, setAutoCheck, skipVersion, startUpdate, upd } from '../update.svelte';

  const u = $derived(upd.update!);
  const mb = (n: number) => `${Math.round(n / 1e5) / 10} MB`;
  const SHOWN = 8;
  const close = () => (upd.open = false);
</script>

{#if upd.open && upd.update}
  <Modal title={upd.phase === 'restart' ? 'Update installed' : 'Update available'} onClose={close}>
    {#if upd.phase === 'offer'}
      <p>
        <b>Draw {u.version}</b> is out. You have {u.current}.
        {#if u.how === 'manual'}
          Update it with your package manager, or get it from the release page.
        {/if}
      </p>
      {#if u.changes.length}
        <ul class="changes">
          {#each u.changes.slice(0, SHOWN) as c}<li>{c}</li>{/each}
        </ul>
        {#if u.changes.length > SHOWN}<p class="muted small">and {u.changes.length - SHOWN} more changes</p>{/if}
      {/if}
      <div class="actions">
        <button class="primary" onclick={startUpdate}>
          {u.how === 'manual' ? 'Open the release page' : u.size ? `Update (${mb(u.size)})` : 'Update'}
        </button>
        <button onclick={close}>Later</button>
      </div>
      <div class="foot">
        <button class="linklike" onclick={skipVersion}>Skip this version</button>
        <label class="auto"><input type="checkbox" checked={upd.auto} onchange={(e) => setAutoCheck(e.currentTarget.checked)} /> Check automatically</label>
      </div>
    {:else if upd.phase === 'downloading'}
      <p>Downloading Draw {u.version}…</p>
      <div class="bar"><div style:width="{Math.round(upd.progress * 100)}%"></div></div>
      <p class="muted small">{Math.floor(upd.progress * 100)}%{u.size ? ` of ${mb(u.size)}` : ''}. You can keep drawing.</p>
    {:else if upd.phase === 'installing'}
      <p>Android's installer is open. Tap <b>Update</b> there. Draw then closes: open it again to use the new version.</p>
      <div class="actions">
        <button onclick={retryInstall}>Open the installer again</button>
        <button onclick={close}>Close</button>
      </div>
    {:else if upd.phase === 'permission'}
      <p>To install its own updates, Draw needs your permission one time.</p>
      <ol>
        <li>Tap <b>Open the setting</b>.</li>
        <li>Turn on <b>Allow from this source</b>.</li>
        <li>Come back here and tap <b>Install</b>.</li>
      </ol>
      <div class="actions">
        <button class="primary" onclick={grantPermission}>Open the setting</button>
        <button onclick={retryInstall}>Install</button>
      </div>
    {:else if upd.phase === 'restart'}
      <p><b>Draw {u.version}</b> is installed. Restart to use it now, or it starts the next time you open Draw.</p>
      <div class="actions">
        <button class="primary" onclick={restartApp}>Restart now</button>
        <button onclick={close}>Later</button>
      </div>
    {:else}
      <p class="error">The update failed: {upd.error}</p>
      <div class="actions">
        <button class="primary" onclick={startUpdate}>Try again</button>
        <button onclick={close}>Close</button>
      </div>
    {/if}
  </Modal>
{/if}

<style>
  p {
    margin: 8px 0;
    line-height: 1.45;
  }
  .small {
    font-size: 12px;
  }
  .changes {
    margin: 8px 0;
    padding-left: 18px;
    max-height: 180px;
    overflow-y: auto;
    color: var(--text-dim);
    font-size: 12.5px;
    line-height: 1.5;
  }
  ol {
    margin: 8px 0;
    padding-left: 22px;
    line-height: 1.6;
  }
  .bar {
    height: 6px;
    margin-top: 12px;
    border-radius: 3px;
    background: var(--bg-0);
    overflow: hidden;
  }
  .bar div {
    height: 100%;
    background: var(--accent);
    transition: width 0.2s;
  }
  .foot {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-top: 14px;
    font-size: 12px;
  }
  .foot .auto {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
  }
</style>
