<script lang="ts">
  import type { Engine } from '../engine/engine';
  import { ed } from '../state.svelte';

  let { engine, onLeave }: { engine: Engine | null; onLeave: () => void } = $props();
  let password = $state('');

  function join(e: SubmitEvent) {
    e.preventDefault();
    engine?.submitPassword(password);
    password = '';
  }
</script>

<div class="screen">
  <div class="card">
    {#if ed.denied === 'password_required' || ed.denied === 'password_wrong'}
      <h2>This canvas has a password</h2>
      <p>Ask the person who shared the link for it.</p>
      <form onsubmit={join}>
        <!-- svelte-ignore a11y_autofocus -->
        <input type="password" placeholder="Password" autocomplete="off" bind:value={password} autofocus required />
        <button class="primary" type="submit">Join</button>
      </form>
      {#if ed.denied === 'password_wrong'}<p class="error">Wrong password.</p>{/if}
    {:else if ed.denied === 'login_required'}
      <h2>This canvas is private</h2>
      <p>Log in with an account it is shared with, or ask the owner for a link.</p>
      <div class="actions">
        <button class="primary" onclick={() => (ed.auth = 'login')}>Log in</button>
        <button onclick={onLeave}>Home</button>
      </div>
    {:else if ed.denied === 'no_access'}
      <h2>No access</h2>
      <p><b>{ed.user?.email}</b> cannot open this canvas. Ask the owner to share it with you, or log in with another account.</p>
      <div class="actions">
        <button class="primary" onclick={() => (ed.auth = 'login')}>Switch account</button>
        <button onclick={onLeave}>Home</button>
      </div>
    {:else if ed.denied === 'expired'}
      <h2>This canvas expired</h2>
      <p>Temporary canvases are deleted 5 days after they are made, unless their creator logs in and keeps them.</p>
      <div class="actions"><button class="primary" onclick={onLeave}>Home</button></div>
    {:else}
      <h2>This canvas was deleted</h2>
      <p>Its owner deleted it.</p>
      <div class="actions"><button class="primary" onclick={onLeave}>Home</button></div>
    {/if}
  </div>
</div>

<style>
  .screen {
    position: absolute;
    inset: 0;
    z-index: 30;
    display: grid;
    place-items: center;
    padding: 16px;
    background: var(--bg-0);
  }
  .card {
    width: min(380px, 100%);
    padding: 24px;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: 10px;
  }
  h2 {
    margin: 0 0 8px;
    font-size: 17px;
  }
  p {
    color: var(--text-dim);
    margin: 0 0 14px;
  }
  form,
  .actions {
    display: flex;
    gap: 8px;
  }
  input {
    flex: 1;
    font-size: 14px;
    padding: 8px 10px;
  }
  .actions button,
  form button {
    padding: 8px 16px;
  }
  .error {
    color: var(--danger);
    margin: 10px 0 0;
  }
</style>
