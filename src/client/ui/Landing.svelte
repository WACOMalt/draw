<script lang="ts">
  import { normalizeName } from '../../shared/types';
  import { loadRecent, removeRecent, type Recent } from '../recent';

  let { onOpen }: { onOpen: (key: string) => void } = $props();
  let name = $state('');
  let join = $state('');
  let error = $state('');
  let taken = $state<string | null>(null);
  let busy = $state(false);
  let recent = $state<Recent[]>(loadRecent());

  const preview = $derived(name.trim() ? normalizeName(name) : null);

  async function create(withName: boolean) {
    busy = true;
    error = '';
    taken = null;
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(withName ? { name } : {}),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 409) {
        taken = body.key;
        return;
      }
      if (res.status === 429) throw new Error('Too many new canvases. Wait a minute and try again.');
      if (res.status === 400) throw new Error('Use 3 to 40 letters, digits or dashes for the name.');
      if (!res.ok) throw new Error(`Server error (${res.status})`);
      onOpen(body.key);
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }

  async function onJoin(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    error = '';
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(join.trim())}`);
      const body = await res.json();
      if (!body.exists) throw new Error(`No canvas has the code or name “${join.trim()}”.`);
      onOpen(body.key);
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
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
  <div class="card">
    <h1><span class="dot"></span>Draw</h1>
    <p class="sub">An infinite canvas you share with a link.</p>

    <button class="primary big" disabled={busy} onclick={() => create(false)}>New private canvas</button>
    <p class="hint">Gets a random code. Only people with the link can find it.</p>

    <div class="or"><span>or give it a name</span></div>

    <form onsubmit={(e) => (e.preventDefault(), create(true))}>
      <input type="text" placeholder="friday-jam" maxlength="60" autocomplete="off" spellcheck="false" bind:value={name} />
      <button type="submit" disabled={busy || !preview}>Create</button>
    </form>
    {#if name.trim()}
      <p class="hint">
        {#if preview}<span class="mono">{location.host}/s/{preview}</span> · anyone who guesses the name can join{:else}Use 3 to 40 letters, digits or dashes.{/if}
      </p>
    {/if}
    {#if taken}
      <p class="taken">
        <span class="mono">{taken}</span> already exists.
        <button onclick={() => onOpen(taken!)}>Open it</button>
      </p>
    {/if}

    <div class="or"><span>or join one</span></div>

    <form onsubmit={onJoin}>
      <input type="text" placeholder="Code or name" maxlength="60" autocomplete="off" spellcheck="false" bind:value={join} />
      <button type="submit" disabled={busy || !join.trim()}>Join</button>
    </form>

    {#if error}<p class="error">{error}</p>{/if}

    {#if recent.length}
      <div class="or"><span>recent on this device</span></div>
      <ul class="recent">
        {#each recent as r (r.key)}
          <li>
            <a href="/s/{r.key}" onclick={(e) => (e.preventDefault(), onOpen(r.key))}><span class="mono">{r.key}</span></a>
            <span class="when">{ago(r.t)}</span>
            <button class="icon x" title="Remove from this list" aria-label="Remove {r.key}" onclick={() => forget(r.key)}>×</button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
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
  .x {
    font-size: 16px;
    color: var(--text-faint);
  }
</style>
