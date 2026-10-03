<script lang="ts">
  import { normalizeName } from '../../shared/types';
  import { loadRecent, removeRecent, type Recent } from '../recent';
  import { PUBLIC_ORIGIN } from '../config';
  import { api, errorText } from '../api';
  import { anonSecret, links } from '../identity';
  import { ed } from '../state.svelte';
  import AccountButton from './AccountButton.svelte';

  interface Summary {
    key: string;
    role: string;
    lastActiveAt: number;
    owner: string | null;
  }

  let { onOpen }: { onOpen: (key: string, link?: string) => void } = $props();
  let name = $state('');
  let join = $state('');
  let error = $state('');
  let taken = $state<string | null>(null);
  let busy = $state(false);
  let recent = $state<Recent[]>(loadRecent());
  let mine = $state<{ owned: Summary[]; shared: Summary[] } | null>(null);

  const preview = $derived(name.trim() ? normalizeName(name) : null);

  // The account's canvases, whenever someone logs in.
  $effect(() => {
    if (!ed.user) return void (mine = null);
    void api<{ owned: Summary[]; shared: Summary[] }>('GET', '/api/canvases').then((r) => (mine = r.ok ? r.data : null));
  });

  async function create(withName: boolean) {
    busy = true;
    error = '';
    taken = null;
    // The anonymous secret marks this browser as the creator, so it alone may claim the canvas.
    const r = await api<{ key: string }>('POST', '/api/sessions', withName ? { name, anon: anonSecret() } : { anon: anonSecret() });
    busy = false;
    if (r.status === 409) return void (taken = (r.data as { key?: string }).key ?? null);
    if (r.status === 400) return void (error = 'Use 3 to 40 letters, digits or dashes for the name.');
    if (r.status === 401) return void (ed.auth = 'login');
    if (!r.ok) return void (error = r.status === 429 ? 'Too many new canvases. Wait a minute and try again.' : errorText(r.data.error));
    onOpen(r.data.key);
  }

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
  <div class="top"><AccountButton /></div>
  <div class="card">
    <h1><span class="dot"></span>Draw</h1>
    <p class="sub">An infinite canvas you share with a link.</p>

    <button class="primary big" disabled={busy} onclick={() => create(false)}>New canvas</button>
    <p class="hint">
      {#if ed.user}
        Saved to your account. Gets a random code; you choose who can open it.
      {:else}
        Temporary: deleted after 5 days unless you log in and keep it. Only this browser can keep it.
      {/if}
    </p>

    <div class="or"><span>or give it a name</span></div>

    {#if ed.user}
      <form onsubmit={(e) => (e.preventDefault(), create(true))}>
        <input type="text" placeholder="friday-jam" maxlength="60" autocomplete="off" spellcheck="false" bind:value={name} />
        <button type="submit" disabled={busy || !preview}>Create</button>
      </form>
      {#if name.trim()}
        <p class="hint">
          {#if preview}<span class="mono">{new URL(PUBLIC_ORIGIN).host}/s/{preview}</span> · private until you share it{:else}Use 3 to 40 letters, digits or dashes.{/if}
        </p>
      {/if}
      {#if taken}
        <p class="taken"><span class="mono">{taken}</span> is taken.</p>
      {/if}
    {:else}
      <p class="hint">Named canvases need an account. <button class="linklike" onclick={() => (ed.auth = 'login')}>Log in</button> or <button class="linklike" onclick={() => (ed.auth = 'register')}>create one</button>.</p>
    {/if}

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
  <p class="version">v{__APP_VERSION__}</p>
</main>

<style>
  main {
    min-height: 100%;
    height: 100%;
    overflow-y: auto;
    display: grid;
    place-items: center;
    padding: max(16px, env(safe-area-inset-top)) 16px max(16px, env(safe-area-inset-bottom));
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
  .taken {
    margin: 8px 0 0;
    display: flex;
    align-items: center;
    gap: 8px;
    color: #ffd43b;
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
  .recent a:hover .mono {
    color: var(--accent);
  }
  .when {
    color: var(--text-faint);
    font-size: 11px;
  }
  .top {
    position: fixed;
    top: max(10px, env(safe-area-inset-top));
    right: 12px;
    z-index: 10;
  }
  .linklike {
    background: none;
    border: none;
    padding: 0;
    color: var(--accent);
    cursor: pointer;
  }
  .version {
    position: fixed;
    right: 12px;
    bottom: max(8px, env(safe-area-inset-bottom));
    margin: 0;
    font-size: 11px;
    color: var(--text-faint);
  }
  .x {
    font-size: 16px;
    color: var(--text-faint);
  }
</style>
