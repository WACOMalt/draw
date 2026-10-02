<script lang="ts">
  import { normalizeCode } from '../../shared/types';

  let { onOpen }: { onOpen: (code: string) => void } = $props();
  let input = $state('');
  let error = $state('');
  let busy = $state(false);

  async function create() {
    busy = true;
    error = '';
    try {
      const res = await fetch('/api/sessions', { method: 'POST' });
      if (res.status === 429) throw new Error('Too many new canvases. Wait a minute and try again.');
      if (!res.ok) throw new Error(`Server error (${res.status})`);
      const { code } = await res.json();
      onOpen(code);
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }

  async function join(e: SubmitEvent) {
    e.preventDefault();
    const code = normalizeCode(input);
    if (!code) return (error = 'A code has 8 characters, like ABCD-EFGH.');
    busy = true;
    error = '';
    try {
      const res = await fetch(`/api/sessions/${code}`);
      const body = await res.json();
      if (!body.exists) throw new Error(`No canvas has the code ${code}.`);
      onOpen(code);
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<main>
  <div class="card">
    <h1><span class="dot"></span>Draw</h1>
    <p class="sub">An infinite canvas you share with a code.</p>

    <button class="primary big" disabled={busy} onclick={create}>New canvas</button>

    <div class="or"><span>or join one</span></div>

    <form onsubmit={join}>
      <input
        type="text"
        placeholder="ABCD-EFGH"
        maxlength="9"
        autocomplete="off"
        spellcheck="false"
        bind:value={input}
      />
      <button type="submit" disabled={busy || !input.trim()}>Join</button>
    </form>

    {#if error}<p class="error">{error}</p>{/if}
  </div>
</main>

<style>
  main {
    height: 100%;
    display: grid;
    place-items: center;
    background:
      radial-gradient(circle at 30% 20%, #2a3a4a 0, transparent 40%),
      radial-gradient(circle at 75% 80%, #3a2a40 0, transparent 45%),
      var(--bg-0);
  }
  .card {
    width: min(360px, calc(100vw - 32px));
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 28px;
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
    margin: 6px 0 22px;
    font-size: 13px;
  }
  .big {
    width: 100%;
    padding: 10px;
    font-size: 14px;
  }
  .or {
    text-align: center;
    color: var(--text-faint);
    margin: 18px 0;
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
    font-size: 15px;
    letter-spacing: 2px;
    text-transform: uppercase;
    font-family: ui-monospace, monospace;
    padding: 7px 10px;
  }
  .error {
    color: var(--danger);
    margin: 14px 0 0;
  }
</style>
