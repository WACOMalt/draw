<script lang="ts">
  import { onMount } from 'svelte';
  import { parseKey } from '../shared/types';
  import { announceAuth, api, errorText, loadMe, watchAuth } from './api';
  import { ed, showToast } from './state.svelte';
  import Landing from './ui/Landing.svelte';
  import Editor from './ui/Editor.svelte';
  import AuthDialog from './ui/AuthDialog.svelte';
  import Modal from './ui/Modal.svelte';

  let path = $state(location.pathname);
  const code = $derived.by(() => {
    const m = /^\/s\/([^/]+)\/?$/.exec(path);
    if (!m) return null;
    try {
      return parseKey(decodeURIComponent(m[1]));
    } catch {
      return null;
    }
  });

  /** Desktop-app sign-in waiting for approval in this browser (?device=CODE). */
  let deviceCode = $state<string | null>(null);

  function go(to: string) {
    history.pushState(null, '', to);
    path = to;
  }

  onMount(() => {
    // A rename moves the open canvas to its new address (replace: the old one is gone).
    const navigate = (e: Event) => {
      const to = (e as CustomEvent<string>).detail;
      history.replaceState(null, '', to);
      path = location.pathname;
    };
    window.addEventListener('draw:navigate', navigate);
    void loadMe();
    watchAuth();
    // Links from emails and the desktop app arrive as query parameters. Handle, then tidy the URL.
    const q = new URLSearchParams(location.search);
    const verify = q.get('verify');
    if (verify === 'ok') {
      showToast('Email confirmed. You are logged in.');
      announceAuth(); // the tab you signed up from logs in too
    }
    if (verify === 'failed') {
      showToast('That confirmation link expired or was already used');
      ed.auth = 'login';
    }
    const reset = q.get('reset');
    if (reset) {
      ed.resetToken = reset;
      ed.auth = 'reset';
    }
    if (q.has('forgot')) ed.auth = 'forgot';
    deviceCode = q.get('device');
    for (const k of ['verify', 'reset', 'forgot', 'device']) q.delete(k);
    const rest = q.toString();
    history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : ''));
    return () => window.removeEventListener('draw:navigate', navigate);
  });

  async function approveDevice() {
    const r = await api('POST', '/api/auth/device/approve', { code: deviceCode });
    showToast(r.ok ? 'The desktop app is signed in' : r.data.error === 'bad_code' ? 'That sign-in code expired. Start again in the app.' : errorText(r.data.error));
    deviceCode = null;
  }
</script>

<svelte:window onpopstate={() => (path = location.pathname)} />

{#if code}
  {#key code}
    <Editor {code} onLeave={() => go('/')} />
  {/key}
{:else}
  <Landing onOpen={(c, k) => go(`/s/${c}${k ? `?k=${encodeURIComponent(k)}` : ''}`)} />
{/if}

{#if ed.auth}<AuthDialog />{/if}

{#if deviceCode && !ed.auth}
  <Modal title="Sign in the desktop app?" onClose={() => (deviceCode = null)}>
    {#if ed.user}
      <p>The Draw desktop app asks to sign in as <b>{ed.user.name}</b> ({ed.user.email}).</p>
      <p class="muted">Check that the app shows the code <b class="code">{deviceCode}</b>. Only approve a request you started.</p>
      <div class="actions">
        <button class="primary" onclick={approveDevice}>Approve</button>
        <button onclick={() => (deviceCode = null)}>Cancel</button>
      </div>
    {:else if ed.user === null}
      <p>Log in first, then approve the desktop app.</p>
      <div class="actions"><button class="primary" onclick={() => (ed.auth = 'login')}>Log in</button></div>
    {/if}
  </Modal>
{/if}

{#if ed.toast}<div class="toast" role="status">{ed.toast}</div>{/if}

<style>
  .toast {
    position: fixed;
    left: 50%;
    bottom: calc(80px + env(safe-area-inset-bottom));
    transform: translateX(-50%);
    z-index: 200;
    max-width: calc(100vw - 32px);
    padding: 7px 16px;
    border-radius: 16px;
    background: rgba(20, 20, 20, 0.94);
    border: 1px solid var(--line);
    pointer-events: none;
    text-align: center;
  }
  .code {
    font-family: ui-monospace, monospace;
    letter-spacing: 1px;
  }
</style>
