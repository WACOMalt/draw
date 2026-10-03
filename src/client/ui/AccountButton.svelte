<script lang="ts">
  import { announceAuth, logout } from '../api';
  import { ed, showToast } from '../state.svelte';

  let { compact = false, onHome }: { compact?: boolean; onHome?: () => void } = $props();
  let open = $state(false);

  const initials = (name: string) =>
    name
      .split(/\s+/)
      .map((w) => w[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();

  async function signOut() {
    open = false;
    await logout();
    announceAuth();
    showToast('Logged out');
  }
</script>

<svelte:window onpointerdown={(e) => open && !(e.target as Element).closest('.account') && (open = false)} />

<div class="account">
  {#if ed.user}
    <button class="me" onclick={() => (open = !open)} title={ed.user.email} aria-expanded={open}>
      <span class="avatar">{initials(ed.user.name)}</span>
      {#if !compact}<span class="name">{ed.user.name}</span>{/if}
    </button>
    {#if open}
      <div class="menu" role="menu">
        <div class="who">
          <b>{ed.user.name}</b>
          <span>{ed.user.email}</span>
        </div>
        {#if onHome}<button role="menuitem" onclick={() => ((open = false), onHome?.())}>My canvases</button>{/if}
        <button role="menuitem" onclick={signOut}>Log out</button>
      </div>
    {/if}
  {:else if ed.user === null}
    <button class="login" onclick={() => (ed.auth = 'login')}>Log in</button>
  {/if}
</div>

<style>
  .account {
    position: relative;
  }
  .me {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 8px 2px 2px;
    background: transparent;
    border-color: transparent;
    border-radius: 14px;
  }
  .me:hover {
    background: var(--bg-3);
  }
  .avatar {
    display: inline-grid;
    place-items: center;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: var(--accent);
    color: #0b1d2c;
    font-size: 10px;
    font-weight: 700;
  }
  .name {
    max-width: 140px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .login {
    padding: 3px 12px;
  }
  .menu {
    position: absolute;
    right: 0;
    top: calc(100% + 6px);
    z-index: 50;
    min-width: 200px;
    padding: 6px;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
  }
  .who {
    display: flex;
    flex-direction: column;
    padding: 6px 8px 8px;
    border-bottom: 1px solid var(--line);
    margin-bottom: 4px;
  }
  .who span {
    color: var(--text-dim);
    font-size: 11px;
  }
  .menu button {
    display: block;
    width: 100%;
    text-align: left;
    background: transparent;
    border-color: transparent;
    padding: 7px 8px;
  }
  .menu button:hover {
    background: var(--bg-3);
  }
</style>
