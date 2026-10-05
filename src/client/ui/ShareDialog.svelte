<script lang="ts">
  import { api, errorText } from '../api';
  import { PUBLIC_ORIGIN } from '../config';
  import { embedCode, embedUrl } from '../embed';
  import type { Engine } from '../engine/engine';
  import { followRename } from '../identity';
  import { ed, showToast } from '../state.svelte';
  import Modal from './Modal.svelte';

  let { code, engine, onDeleted }: { code: string; engine: Engine | null; onDeleted: () => void } = $props();

  interface Member {
    id: string;
    email: string;
    name: string;
    role: 'editor' | 'viewer';
  }
  interface Sharing {
    key: string;
    owner: { id: string; name: string; email: string } | null;
    members: Member[];
    codeLink: string;
    codeRole: 'editor' | 'viewer' | 'none';
    editLink: string | null;
    viewLink: string | null;
    password: boolean;
  }

  let s = $state<Sharing | null>(null);
  let error = $state('');
  let email = $state('');
  let role = $state<'editor' | 'viewer'>('editor');
  let newPassword = $state('');
  let transferTo = $state('');
  let newName = $state('');
  let busy = $state(false);

  // Embed: the area on screen when the dialog opened. The canvas link gives view access by
  // itself unless it is off; then the embed needs the private view link's token.
  // Read once, on purpose: moving the view under the open dialog does not change the frame.
  const shot = (() => engine?.viewRect() ?? null)();
  let embedOpen = $state(false);
  let embedWidth = $state<number | null>(null);
  const embedToken = $derived(
    !s || s.codeRole !== 'none' ? null : s.viewLink ? new URL(s.viewLink).searchParams.get('k') : null,
  );
  const canEmbed = $derived(!!s && !!shot && (s.codeRole !== 'none' || !!embedToken));
  const embedSrc = $derived(s && shot && canEmbed ? embedUrl(PUBLIC_ORIGIN, s.key, embedToken, shot.bounds) : '');
  const embedHtml = $derived(embedSrc && shot ? embedCode(embedSrc, shot.w, shot.h, embedWidth && embedWidth > 0 ? Math.round(embedWidth) : null) : '');

  async function copyEmbed() {
    try {
      await navigator.clipboard.writeText(embedHtml);
      showToast('Embed code copied');
    } catch {
      showToast('Select the code and copy it');
    }
  }

  const path = $derived(`/api/canvases/${encodeURIComponent(code)}`);

  async function call(method: string, sub: string, body?: unknown): Promise<boolean> {
    busy = true;
    error = '';
    const r = await api<Sharing>(method, `${path}${sub}`, body);
    busy = false;
    if (!r.ok) {
      error = errorText(r.data.error);
      return false;
    }
    if ('members' in r.data) s = r.data;
    return true;
  }

  $effect(() => {
    void call('GET', '/sharing');
  });

  async function copy(url: string | null) {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      showToast('Link copied');
    } catch {
      showToast(url);
    }
  }

  async function addMember(e: SubmitEvent) {
    e.preventDefault();
    if (await call('POST', '/members', { email, role })) email = '';
  }

  async function setPassword(e: SubmitEvent) {
    e.preventDefault();
    if (await call('POST', '/password', { password: newPassword })) {
      newPassword = '';
      showToast('Join password set');
    }
  }

  async function rename(body: { name: string } | { random: true }) {
    if (!confirm('Links that use the old address stop working. Private links keep working. Continue?')) return;
    busy = true;
    error = '';
    const r = await api<Sharing>('POST', `${path}/rename`, body);
    busy = false;
    if (!r.ok) {
      error = r.data.error === 'name_taken' ? 'That name is taken.' : r.data.error === 'bad_name' ? 'Use 3 to 40 letters, digits or dashes.' : errorText(r.data.error);
      return;
    }
    s = r.data;
    newName = '';
    showToast(`Moved to /s/${r.data.key}`);
    followRename(code, r.data.key);
  }

  async function transfer(e: SubmitEvent) {
    e.preventDefault();
    const mine = !s?.owner || s.owner.id === ed.user?.id;
    if (!confirm(`Make ${transferTo} the owner of ${code}? ${mine ? 'You keep' : `${s?.owner?.name} keeps`} edit access, but only the new owner can manage sharing.`)) return;
    if (await call('POST', '/transfer', { email: transferTo })) {
      showToast('Ownership transferred');
      ed.shareOpen = false;
    }
  }

  async function remove() {
    if (prompt(`This deletes ${code} for everyone and cannot be undone. Type the canvas name to confirm:`) !== code) return;
    if (await call('DELETE', '')) {
      ed.shareOpen = false;
      onDeleted();
    }
  }
</script>

<Modal title="Share {code}" wide onClose={() => (ed.shareOpen = false)}>
  {#if !s}
    <p class="muted">{error || 'Loading…'}</p>
  {:else}
    {#if s.owner && ed.user && s.owner.id !== ed.user.id}
      <p class="admin-note">You manage this canvas as an admin. It belongs to <b>{s.owner.name}</b>.</p>
    {/if}
    <section>
      <h3>People</h3>
      <ul class="people">
        <li><span class="who"><b>{s.owner?.name ?? ed.user?.name}</b> <span class="muted">{s.owner?.email ?? ed.user?.email}</span></span><span class="muted">Owner</span></li>
        {#each s.members as m (m.id)}
          <li>
            <span class="who"><b>{m.name}</b> <span class="muted">{m.email}</span></span>
            <select value={m.role} disabled={busy} onchange={(e) => call('PATCH', `/members/${m.id}`, { role: e.currentTarget.value })}>
              <option value="editor">Can edit</option>
              <option value="viewer">Can view</option>
            </select>
            <button class="small" disabled={busy} title="Remove access" onclick={() => call('DELETE', `/members/${m.id}`)}>Remove</button>
          </li>
        {/each}
      </ul>
      <form class="row" onsubmit={addMember}>
        <input type="email" placeholder="Email of a Draw account" bind:value={email} required />
        <select bind:value={role}>
          <option value="editor">Can edit</option>
          <option value="viewer">Can view</option>
        </select>
        <button type="submit" disabled={busy}>Add</button>
      </form>
    </section>

    <section>
      <h3>Links</h3>
      <div class="link">
        <div class="head">
          <b>Canvas link</b>
          <select value={s.codeRole} disabled={busy} onchange={(e) => call('POST', '/links', { kind: 'code', role: e.currentTarget.value })}>
            <option value="editor">Anyone with it can draw (public)</option>
            <option value="viewer">Anyone with it can view</option>
            <option value="none">Off: only people and private links</option>
          </select>
        </div>
        {#if s.codeRole !== 'none'}
          <div class="row">
            <input type="text" readonly value={s.codeLink} onfocus={(e) => e.currentTarget.select()} />
            <button onclick={() => copy(s!.codeLink)}>Copy</button>
          </div>
        {/if}
        <p class="muted note">This link is just the canvas code, and the code is part of every link.</p>
      </div>
      {#each [{ kind: 'edit', label: 'Private edit link', url: s.editLink, note: 'Anyone with it can draw. It cannot be guessed from the canvas link.' }, { kind: 'view', label: 'Private view link', url: s.viewLink, note: s.codeRole === 'editor' ? 'The canvas is public, so this link can draw too.' : 'Anyone with it can look, not draw. Useful when the canvas link is off.' }] as l (l.kind)}
        <div class="link">
          <div class="head">
            <b>{l.label}</b>
            <span class="muted">{l.url ? l.note : 'Off'}</span>
          </div>
          {#if l.url}
            <div class="row">
              <input type="text" readonly value={l.url} onfocus={(e) => e.currentTarget.select()} />
              <button onclick={() => copy(l.url)}>Copy</button>
            </div>
          {/if}
          <div class="row tight">
            <button class="small" disabled={busy} onclick={() => call('POST', '/links', { kind: l.kind, action: l.url ? 'disable' : 'enable' })}>{l.url ? 'Turn off' : 'Turn on'}</button>
            {#if l.url}<button class="small" disabled={busy} title="The old link stops working" onclick={() => call('POST', '/links', { kind: l.kind, action: 'reset' })}>Reset link</button>{/if}
          </div>
        </div>
      {/each}
    </section>

    <section>
      <h3>Join password</h3>
      <p class="muted">{s.password ? 'People who come through a link must enter it. People you added above do not.' : 'Off. Add one to protect the links.'}</p>
      <form class="row" onsubmit={setPassword}>
        <input type="password" placeholder={s.password ? 'New password' : 'Password (at least 4 characters)'} minlength="4" autocomplete="new-password" bind:value={newPassword} required />
        <button type="submit" disabled={busy}>{s.password ? 'Change' : 'Set'}</button>
        {#if s.password}<button type="button" disabled={busy} onclick={() => call('POST', '/password', { password: null })}>Remove</button>{/if}
      </form>
    </section>

    {#if error}<p class="error">{error}</p>{/if}

    <details bind:open={embedOpen}>
      <summary>Embed on a website</summary>
      {#if !shot}
        <p class="muted">Open the canvas first.</p>
      {:else if !canEmbed}
        <p class="muted">The canvas link is off, so an embed needs the private view link.</p>
        <button class="small" disabled={busy} onclick={() => call('POST', '/links', { kind: 'view', action: 'enable' })}>Turn on the private view link</button>
      {:else}
        <p class="muted note">
          A live, view-only copy of the area you see now. Visitors can pan and zoom, but not draw, and other people do not see them. To frame
          another area, close this window, move the view, and open Share again.
        </p>
        {#if embedOpen}
          <iframe class="preview" src={embedSrc} title="Embed preview" style:aspect-ratio="{shot.w} / {shot.h}" style:width="min(100%, {Math.round((200 * shot.w) / shot.h)}px)"></iframe>
        {/if}
        <div class="row">
          <label class="width">Width <input type="number" min="100" max="4000" placeholder="Full" bind:value={embedWidth} /> px</label>
          <span class="muted">{embedWidth ? 'Fixed width' : 'Full width of the page'}, height from the shape of your view</span>
        </div>
        <div class="row">
          <textarea readonly rows="3" value={embedHtml} onfocus={(e) => e.currentTarget.select()}></textarea>
          <button onclick={copyEmbed}>Copy</button>
        </div>
        {#if s.password}<p class="muted note">The canvas has a join password. An embed cannot ask for it, so it shows "This drawing needs a password".</p>{/if}
        <p class="muted note">The embed stops working if you rename the canvas, or turn off or reset the link it uses ({embedToken ? 'the private view link' : 'the canvas link'}).</p>
      {/if}
    </details>

    <details>
      <summary>Address, ownership and deletion</summary>
      <form class="row" onsubmit={(e) => (e.preventDefault(), rename({ name: newName }))}>
        <input type="text" placeholder="New name, like friday-jam" maxlength="40" bind:value={newName} required />
        <button type="submit" disabled={busy}>Rename</button>
        <button type="button" disabled={busy} onclick={() => rename({ random: true })}>New random code</button>
      </form>
      <form class="row" onsubmit={transfer}>
        <input type="email" placeholder="New owner's email" bind:value={transferTo} required />
        <button type="submit" disabled={busy}>Transfer</button>
      </form>
      <button class="danger" disabled={busy} onclick={remove}>Delete this canvas</button>
    </details>
  {/if}
</Modal>

<style>
  section {
    padding: 4px 0 12px;
    border-bottom: 1px solid var(--line);
    margin-bottom: 10px;
  }
  h3 {
    margin: 8px 0;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-dim);
  }
  .people {
    list-style: none;
    margin: 0 0 8px;
    padding: 0;
  }
  .people li {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 34px;
  }
  .who {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row {
    display: flex;
    gap: 6px;
    margin-top: 6px;
  }
  .row input {
    flex: 1;
    min-width: 0;
  }
  .row.tight {
    margin-top: 4px;
  }
  .link {
    margin-bottom: 10px;
  }
  .head {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 8px;
    align-items: baseline;
  }
  .note {
    margin: 4px 0 0;
    font-size: 11px;
  }
  .head b {
    white-space: nowrap;
  }
  .head select {
    margin-left: auto;
    min-width: 0;
    max-width: 100%;
  }
  .small {
    padding: 2px 8px;
    font-size: 11px;
  }
  details {
    margin-top: 6px;
  }
  summary {
    cursor: pointer;
    color: var(--text-dim);
    margin-bottom: 8px;
  }
  .danger {
    margin-top: 10px;
    color: var(--danger);
  }
  select {
    padding: 4px;
    max-width: 100%;
  }
  .admin-note {
    margin: 0 0 8px;
    padding: 6px 10px;
    border-radius: 6px;
    border-left: 3px solid #e8b04a;
    background: var(--bg-0);
    font-size: 12px;
  }
  .preview {
    display: block;
    margin: 8px 0;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--bg-0);
  }
  textarea {
    flex: 1;
    min-width: 0;
    resize: vertical;
    font: 11px/1.4 ui-monospace, monospace;
    padding: 6px 8px;
    background: var(--bg-0);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    user-select: text;
  }
  .width {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    white-space: nowrap;
  }
  .width input {
    width: 76px;
  }
  .row .muted {
    align-self: center;
    font-size: 11px;
  }
</style>
