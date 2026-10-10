<script lang="ts">
  import { loadRecent, removeRecent, type Recent } from '../recent';
  import { DOWNLOAD_URL, IS_DESKTOP } from '../config';
  import { CAN_UPDATE, checkForUpdates, upd } from '../update.svelte';
  import { api } from '../api';
  import { pickFile } from '../files';
  import { links } from '../identity';
  import { ed } from '../state.svelte';
  import AccountButton from './AccountButton.svelte';
  import Icon from './Icon.svelte';
  import NewCanvasForm from './NewCanvasForm.svelte';
  import { deleteLocal, listLocal, type LocalCanvas } from '../local/store';

  interface Summary {
    key: string;
    role: string;
    lastActiveAt: number;
    owner: string | null;
  }

  let { onOpen, onOpenLocal }: { onOpen: (key: string, link?: string) => void; onOpenLocal: (id: string) => void } = $props();
  let join = $state('');
  let error = $state('');
  let busy = $state(false);
  let recent = $state<Recent[]>(loadRecent());
  let mine = $state<{ owned: Summary[]; shared: Summary[] } | null>(null);
  /** Canvases on this device only (local/). */
  let onDevice = $state<LocalCanvas[]>([]);
  void listLocal().then((l) => (onDevice = l));

  async function deleteOnDevice(c: LocalCanvas) {
    if (!confirm(`Delete "${c.name}" from this device? Only this device has it: it cannot be brought back.`)) return;
    await deleteLocal(c.id);
    onDevice = await listLocal();
  }

  // The account's canvases, whenever someone logs in.
  $effect(() => {
    if (!ed.user) return void (mine = null);
    void api<{ owned: Summary[]; shared: Summary[] }>('GET', '/api/canvases').then((r) => (mine = r.ok ? r.data : null));
  });

  async function onJoin(e: SubmitEvent) {
    e.preventDefault();
    error = '';
    // Accept a pasted share link as well as a code or name.
    let input = join.trim();
    let link: string | undefined;
    try {
      const u = new URL(input);
      link = u.searchParams.get('k') ?? undefined;
      input = decodeURIComponent(u.pathname.replace(/^\/s\//, ''));
    } catch {
      // not a URL
    }
    busy = true;
    const r = await api<{ exists: boolean; key: string | null }>('GET', `/api/sessions/${encodeURIComponent(input)}`);
    busy = false;
    if (!r.ok || !r.data.exists || !r.data.key) return void (error = `No canvas has the code or name "${input}".`);
    if (link) links.set(r.data.key, link);
    onOpen(r.data.key, link);
  }

  function ago(t: number): string {
    const s = (Date.now() - t) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return `${Math.floor(s / 86400)} d ago`;
  }

  function forget(key: string) {
    removeRecent(key);
    recent = loadRecent();
  }
</script>

<main>
  <div class="top">
    {#if !IS_DESKTOP}
      <a class="download" href={DOWNLOAD_URL} target="_blank" rel="noopener" title="Desktop app for Windows, macOS and Linux"><Icon name="download" /> Download app</a>
    {/if}
    <AccountButton />
  </div>
  <div class="card">
    <h1><span class="dot"></span>Draw</h1>
    <p class="sub">An infinite canvas you share with a link.</p>

    <NewCanvasForm onCreated={(key) => onOpen(key)} onLocal={onOpenLocal} />

    <button class="open" onclick={pickFile}><Icon name="open" /> Open a .bdraw file</button>

    <div class="or"><span>or join one</span></div>

    <form onsubmit={onJoin}>
      <input type="text" placeholder="Code, name or link" maxlength="300" autocomplete="off" spellcheck="false" bind:value={join} />
      <button type="submit" disabled={busy || !join.trim()}>Join</button>
    </form>

    {#if error}<p class="error">{error}</p>{/if}

    {#if mine?.owned.length}
      <div class="or"><span>your canvases</span></div>
      <ul class="recent">
        {#each mine.owned as c (c.key)}
          <li>
            <a href="/s/{c.key}" onclick={(e) => (e.preventDefault(), onOpen(c.key))}><span class="mono">{c.key}</span></a>
            <span class="when">{ago(c.lastActiveAt)}</span>
          </li>
        {/each}
      </ul>
    {/if}
    {#if mine?.shared.length}
      <div class="or"><span>shared with you</span></div>
      <ul class="recent">
        {#each mine.shared as c (c.key)}
          <li>
            <a href="/s/{c.key}" onclick={(e) => (e.preventDefault(), onOpen(c.key))}><span class="mono">{c.key}</span></a>
            <span class="when">{c.role === 'viewer' ? 'view' : 'edit'} · {c.owner}</span>
          </li>
        {/each}
      </ul>
    {/if}

    {#if onDevice.length}
      <div class="or"><span>only on this device</span></div>
      <ul class="recent">
        {#each onDevice as c (c.id)}
          <li>
            <a href="/l/{c.id}" onclick={(e) => (e.preventDefault(), onOpenLocal(c.id))}><span class="name">{c.name}</span></a>
            <span class="when">{ago(c.updated)}</span>
            <button class="icon x" title="Delete from this device" aria-label="Delete {c.name}" onclick={() => deleteOnDevice(c)}>×</button>
          </li>
        {/each}
      </ul>
    {/if}

    {#if recent.length}
      <div class="or"><span>recent on this device</span></div>
      <ul class="recent">
        {#each recent as r (r.key)}
          <li>
            <a href="/s/{r.key}" onclick={(e) => (e.preventDefault(), onOpen(r.key, links.get(r.key)))}><span class="mono">{r.key}</span></a>
            <span class="when">{ago(r.t)}</span>
            <button class="icon x" title="Remove from this list" aria-label="Remove {r.key}" onclick={() => forget(r.key)}>×</button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
  <p class="version">
    v{__APP_VERSION__}
    {#if CAN_UPDATE}
      · <button class="check" disabled={upd.checking} onclick={() => checkForUpdates(true)}>{upd.checking ? 'Checking…' : 'Check for updates'}</button>
    {/if}
  </p>
</main>

<style>
  main {
    min-height: 100%;
    height: 100%;
    overflow-y: auto;
    display: grid;
    /* minmax(0, 1fr): the column is the screen width, so the card never grows past it. */
    grid-template-columns: minmax(0, 1fr);
    place-items: center;
    /* Room for the fixed top buttons and the version line, so a tall card never runs under them. */
    padding: calc(max(10px, env(safe-area-inset-top)) + 44px) 16px calc(max(8px, env(safe-area-inset-bottom)) + 22px);
    background:
      radial-gradient(circle at 30% 20%, #2a3a4a 0, transparent 40%),
      radial-gradient(circle at 75% 80%, #3a2a40 0, transparent 45%),
      var(--bg-0);
  }
  .card {
    width: min(380px, 100%);
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 26px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  }
  h1 {
    margin: 0;
    font-size: 26px;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .dot {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--accent);
  }
  .sub {
    color: var(--text-dim);
    margin: 6px 0 20px;
    font-size: 13px;
  }
  .open {
    width: 100%;
    margin-top: 12px;
    padding: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
  }
  .download {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-dim);
    text-decoration: none;
    font-size: 12px;
    background: var(--bg-2);
  }
  .download:hover {
    color: var(--text);
    border-color: var(--accent);
  }
  .mono {
    font-family: ui-monospace, monospace;
    color: var(--text-dim);
  }
  .or {
    text-align: center;
    color: var(--text-faint);
    margin: 20px 0 16px;
    border-top: 1px solid var(--line);
    height: 0;
  }
  .or span {
    position: relative;
    top: -9px;
    background: var(--bg-2);
    padding: 0 8px;
  }
  form {
    display: flex;
    gap: 8px;
  }
  form input {
    flex: 1;
    min-width: 0;
    font-size: 15px;
    padding: 8px 10px;
  }
  form button {
    padding: 0 14px;
  }
  .error {
    color: var(--danger);
    margin: 14px 0 0;
  }
  .recent {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .recent li {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 34px;
  }
  .recent a {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text);
    text-decoration: none;
  }
  .recent a:hover .mono,
  .recent a:hover .name {
    color: var(--accent);
  }
  .name {
    color: var(--text-dim);
  }
  .when {
    color: var(--text-faint);
    font-size: 11px;
  }
  .top {
    display: flex;
    align-items: center;
    gap: 8px;
    position: fixed;
    top: max(10px, env(safe-area-inset-top));
    right: 12px;
    z-index: 10;
  }
  .version {
    position: fixed;
    right: 12px;
    bottom: max(8px, env(safe-area-inset-bottom));
    margin: 0;
    font-size: 11px;
    color: var(--text-faint);
  }
  .version .check {
    padding: 0;
    border: none;
    background: none;
    font-size: inherit;
    color: var(--text-dim);
    text-decoration: underline;
    cursor: pointer;
  }
  .version .check:disabled {
    text-decoration: none;
  }
  .x {
    font-size: 16px;
    color: var(--text-faint);
  }
</style>
