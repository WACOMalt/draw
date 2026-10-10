<script lang="ts">
  import { normalizeName } from '../../shared/types';
  import { PUBLIC_ORIGIN } from '../config';
  import { createCanvas } from '../files';
  import { ed, showToast } from '../state.svelte';
  import { createLocal } from '../local/store';
  import { createLocalFromFile, defaultName } from '../local/import';

  // Makes a canvas, empty or from a .bdraw file. Accounts choose a name (empty: a random code)
  // and private or public; without an account the canvas is temporary. With onLocal, it can also
  // make a canvas on this device only (local/), and does so when the server cannot be reached.
  let {
    file,
    fileName,
    onCreated,
    onLocal,
  }: { file?: Blob; fileName?: string; onCreated: (key: string) => void; onLocal?: (id: string) => void } = $props();

  let name = $state('');
  let busy = $state(false);
  let error = $state('');
  let taken = $state<string | null>(null);

  const preview = $derived(name.trim() ? normalizeName(name) : null);

  async function create(access?: 'editor' | 'none') {
    busy = true;
    error = '';
    taken = null;
    const r = await createCanvas({ ...(access ? { access } : {}), ...(ed.user && preview ? { name } : {}) }, file);
    busy = false;
    if ('key' in r) return onCreated(r.key);
    if (r.code === 'network' && onLocal) return onDevice(true);
    if (r.code === 'login_required') return void (ed.auth = 'login');
    if (r.code === 'name_taken') taken = r.taken ?? preview;
    else error = r.error;
  }

  /** A canvas on this device only. `offline`: the server could not be reached. */
  async function onDevice(offline = false) {
    if (!onLocal) return;
    busy = true;
    error = '';
    try {
      let id: string;
      if (file) {
        const r = await createLocalFromFile(fileName?.replace(/\.bdraw$/i, '') || defaultName(), file);
        if (r.skipped) showToast(`${r.skipped} damaged ${r.skipped === 1 ? 'item was' : 'items were'} left out`);
        id = r.id;
      } else id = (await createLocal(defaultName())).id;
      if (offline) showToast('No connection: the canvas is on this device. Put it online later to share it.');
      onLocal(id);
    } catch (e) {
      error = e instanceof Error ? e.message : 'The canvas could not be made on this device.';
    } finally {
      busy = false;
    }
  }
</script>

{#if ed.user}
  <form class="named" onsubmit={(e) => (e.preventDefault(), create('none'))}>
    <input type="text" placeholder="Random code" aria-label="Name (empty for a random code)" maxlength="60" autocomplete="off" spellcheck="false" bind:value={name} />
    <p class="hint">
      {#if !name.trim()}
        Empty: a random code like <span class="mono">K7QX-2MPD</span>.
      {:else if preview}
        <span class="mono">{new URL(PUBLIC_ORIGIN).host}/s/{preview}</span>
      {:else}
        Use 3 to 40 letters, digits or dashes.
      {/if}
    </p>
    {#if taken}<p class="taken"><span class="mono">{taken}</span> is taken.</p>{/if}
    <div class="two">
      <button type="submit" class="primary" disabled={busy || (!!name.trim() && !preview)}>Create private canvas</button>
      <button type="button" class="primary" disabled={busy || (!!name.trim() && !preview)} onclick={() => create('editor')}>Create public canvas</button>
    </div>
    <p class="hint">Private: only you and people you add or send a link. Public: anyone with the link can draw. Change it later in Share.</p>
  </form>
{:else}
  <button class="primary big" disabled={busy} onclick={() => create()}>{file ? 'Open as a temporary canvas' : 'New canvas'}</button>
  <p class="hint">
    Temporary: deleted after 5 days unless you log in and keep it. Only this browser can keep it.
    Named and private canvases need an account. <button class="linklike" onclick={() => (ed.auth = 'login')}>Log in</button> or
    <button class="linklike" onclick={() => (ed.auth = 'register')}>create one</button>.
  </p>
{/if}
{#if onLocal}
  <button class="device" disabled={busy} onclick={() => onDevice()}>{file ? 'Open on this device only' : 'New canvas on this device'}</button>
  <p class="hint">Works without a connection. Only this device has it, until you put it online to share it.</p>
{/if}
{#if error}<p class="error">{error}</p>{/if}

<style>
  .device {
    width: 100%;
    margin-top: 12px;
    padding: 8px;
  }
  .named input {
    width: 100%;
    font-size: 15px;
    padding: 8px 10px;
  }
  .two {
    display: flex;
    gap: 8px;
    margin-top: 10px;
  }
  .two button {
    flex: 1;
    padding: 10px 6px;
  }
  .big {
    width: 100%;
    padding: 11px;
    font-size: 14px;
  }
  .hint {
    color: var(--text-faint);
    margin: 6px 0 0;
    font-size: 11.5px;
    overflow-wrap: anywhere;
  }
  .mono {
    font-family: ui-monospace, monospace;
    color: var(--text-dim);
  }
  .taken {
    margin: 8px 0 0;
    color: #ffd43b;
  }
  .error {
    color: var(--danger);
    margin: 10px 0 0;
  }
  .linklike {
    background: none;
    border: none;
    padding: 0;
    color: var(--accent);
    cursor: pointer;
    font-size: inherit;
  }
</style>
