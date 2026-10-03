<script lang="ts">
  import { api, errorText } from '../api';
  import { anonSecret, followRename } from '../identity';
  import { showToast } from '../state.svelte';
  import Modal from './Modal.svelte';

  let { code, onClose }: { code: string; onClose: () => void } = $props();

  // A temporary canvas is open to anyone with its code, so "public" keeps things as they are.
  let access = $state<'editor' | 'viewer' | 'none'>('editor');
  let naming = $state<'keep' | 'random' | 'name'>('keep');
  let name = $state('');
  let busy = $state(false);
  let error = $state('');

  const accessOptions = [
    { value: 'editor', label: 'Public', note: 'Anyone with the link can draw, as now.' },
    { value: 'viewer', label: 'View only', note: 'Anyone with the link can look. You share a private edit link with the people who draw.' },
    { value: 'none', label: 'Private', note: 'Only you, people you add, and private links you share.' },
  ] as const;

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    error = '';
    const r = await api<{ key: string }>('POST', `/api/canvases/${encodeURIComponent(code)}/claim`, {
      anon: anonSecret(),
      access,
      ...(naming === 'random' ? { random: true } : naming === 'name' ? { name } : {}),
    });
    busy = false;
    if (!r.ok) {
      error =
        r.data.error === 'cannot_claim'
          ? 'Only the browser that created this canvas can keep it.'
          : r.data.error === 'name_taken'
            ? 'That name is taken. Try another.'
            : r.data.error === 'bad_name'
              ? 'Use 3 to 40 letters, digits or dashes.'
              : errorText(r.data.error);
      return;
    }
    onClose();
    showToast('Saved to your account. It will not expire.');
    followRename(code, r.data.key);
  }
</script>

<Modal title="Keep this canvas" {onClose}>
  <form onsubmit={submit}>
    <p class="muted">It moves to your account and never expires. You can change these later in Share.</p>

    <fieldset>
      <legend>Who can open the link</legend>
      {#each accessOptions as o (o.value)}
        <label class="opt">
          <input type="radio" name="access" value={o.value} bind:group={access} />
          <span><b>{o.label}</b><br /><span class="muted">{o.note}</span></span>
        </label>
      {/each}
    </fieldset>

    <fieldset>
      <legend>Address</legend>
      <label class="opt">
        <input type="radio" name="naming" value="keep" bind:group={naming} />
        <span><b>Keep {code}</b></span>
      </label>
      <label class="opt">
        <input type="radio" name="naming" value="random" bind:group={naming} />
        <span><b>New random code</b><br /><span class="muted">Links with the old code stop working.</span></span>
      </label>
      <label class="opt">
        <input type="radio" name="naming" value="name" bind:group={naming} />
        <span><b>A name</b><br /><span class="muted">Like draw.bsums.xyz/s/friday-jam. Links with the old code stop working.</span></span>
      </label>
      {#if naming === 'name'}
        <!-- svelte-ignore a11y_autofocus -->
        <input type="text" placeholder="friday-jam" maxlength="40" autofocus bind:value={name} required />
      {/if}
    </fieldset>

    {#if error}<p class="error">{error}</p>{/if}
    <div class="actions">
      <button type="submit" class="primary" disabled={busy}>Keep this canvas</button>
      <button type="button" onclick={onClose}>Cancel</button>
    </div>
  </form>
</Modal>

<style>
  fieldset {
    border: none;
    margin: 12px 0 0;
    padding: 0;
  }
  legend {
    padding: 0;
    margin-bottom: 4px;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-dim);
  }
  .opt {
    display: flex !important;
    gap: 8px;
    align-items: flex-start;
    margin: 6px 0 !important;
    color: var(--text) !important;
    cursor: pointer;
  }
  .opt input {
    margin-top: 3px;
  }
  .opt .muted {
    font-size: 12px;
  }
</style>
