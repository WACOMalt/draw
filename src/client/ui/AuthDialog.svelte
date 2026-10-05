<script lang="ts">
  import { announceAuth, api, errorText } from '../api';
  import { IS_TAURI } from '../config';
  import { desktopToken } from '../identity';
  import { ed, showToast, type User } from '../state.svelte';
  import Modal from './Modal.svelte';
  import Captcha from './Captcha.svelte';

  let email = $state(ed.authEmail);
  let password = $state('');
  let name = $state(ed.user?.name ?? ed.name);
  let error = $state('');
  let unverified = $state(false);
  let busy = $state(false);
  /** Captcha solution for register and forgot; `captchaRound` renews the widget after a try. */
  let captcha = $state('');
  let captchaRound = $state(0);
  const needsCaptcha = $derived(ed.auth === 'register' || ed.auth === 'forgot');

  const titles = { login: 'Log in', register: 'Create an account', forgot: 'Reset your password', reset: 'Choose a new password', sent: 'Check your email' };

  function close() {
    ed.auth = null;
  }
  function view(v: typeof ed.auth) {
    error = '';
    unverified = false;
    ed.auth = v;
  }
  /** Tells open canvases to reconnect with the new identity. */
  function signedIn(user: User, token?: string) {
    if (token) desktopToken.set(token);
    ed.user = user;
    announceAuth();
    showToast(`Logged in as ${user.name}`);
    close();
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    error = '';
    try {
      if (ed.auth === 'login') {
        const r = await api<{ user: User; token?: string }>('POST', '/api/auth/login', { email, password, client: IS_TAURI ? 'desktop' : undefined });
        if (r.ok) return signedIn(r.data.user, r.data.token);
        unverified = r.data.error === 'unverified';
        error = errorText(r.data.error);
      } else if (ed.auth === 'register') {
        const r = await api<{ user?: User; token?: string; verify?: boolean }>('POST', '/api/auth/register', {
          email,
          password,
          name,
          captcha,
          client: IS_TAURI ? 'desktop' : undefined,
        });
        captchaRound++; // a challenge works once
        if (!r.ok) return void (error = errorText(r.data.error));
        // No email confirmation on this server: logged in at once.
        if (r.data.user) return signedIn(r.data.user, r.data.token);
        ed.authEmail = email;
        view('sent');
      } else if (ed.auth === 'forgot') {
        const r = await api('POST', '/api/auth/forgot', { email, captcha });
        captchaRound++;
        if (!r.ok) return void (error = errorText(r.data.error));
        ed.authEmail = email;
        view('sent');
      } else if (ed.auth === 'reset') {
        const r = await api<{ user: User }>('POST', '/api/auth/reset', { token: ed.resetToken, password });
        if (!r.ok) return void (error = errorText(r.data.error));
        // The reset sets a cookie for the web app. The desktop app logs in again for its token.
        if (IS_TAURI) {
          showToast('Password changed. Log in with the new password.');
          return view('login');
        }
        signedIn(r.data.user);
      }
    } finally {
      busy = false;
    }
  }

  async function resend() {
    await api('POST', '/api/auth/resend', { email: email || ed.authEmail });
    showToast('If the account is waiting for confirmation, a new link is on its way');
  }
</script>

<Modal title={titles[ed.auth ?? 'login']} onClose={close}>
  {#if ed.auth === 'sent'}
    <p>We sent a link to <b>{ed.authEmail}</b>. Open it to continue.</p>
    <p class="muted">It can take a minute. Check the spam folder too.{IS_TAURI ? ' After you confirm in the browser, log in here.' : ''}</p>
    <div class="actions">
      <button class="primary" onclick={() => view('login')}>Back to log in</button>
      <button onclick={resend}>Send again</button>
    </div>
  {:else}
    <form onsubmit={submit}>
      {#if ed.auth === 'register'}
        <label for="a-name">Display name</label>
        <input id="a-name" type="text" maxlength="40" autocomplete="nickname" bind:value={name} required />
      {/if}
      {#if ed.auth !== 'reset'}
        <label for="a-email">Email</label>
        <input id="a-email" type="email" autocomplete="email" bind:value={email} required />
      {/if}
      {#if ed.auth !== 'forgot'}
        <label for="a-pw">{ed.auth === 'login' ? 'Password' : 'New password (at least 8 characters)'}</label>
        <input id="a-pw" type="password" minlength={ed.auth === 'login' ? 1 : 8} autocomplete={ed.auth === 'login' ? 'current-password' : 'new-password'} bind:value={password} required />
      {/if}
      {#if needsCaptcha}
        {#key captchaRound}<Captcha bind:payload={captcha} />{/key}
      {/if}
      {#if error}
        <p class="error">{error}</p>
        {#if unverified}<button type="button" class="linklike" onclick={resend}>Send the confirmation email again</button>{/if}
      {/if}
      <div class="actions">
        <button class="primary" type="submit" disabled={busy || (needsCaptcha && !captcha)} title={needsCaptcha && !captcha ? 'Wait for the check above' : undefined}>
          {ed.auth === 'login' ? 'Log in' : ed.auth === 'register' ? 'Create account' : ed.auth === 'forgot' ? 'Send reset link' : 'Save password'}
        </button>
      </div>
    </form>
    <p class="switch muted">
      {#if ed.auth === 'login'}
        No account? <button class="linklike" onclick={() => view('register')}>Create one</button> ·
        <button class="linklike" onclick={() => view('forgot')}>Forgot password?</button>
      {:else if ed.auth === 'register'}
        Have an account? <button class="linklike" onclick={() => view('login')}>Log in</button>
      {:else}
        <button class="linklike" onclick={() => view('login')}>Back to log in</button>
      {/if}
    </p>
  {/if}
</Modal>

<style>
  .switch {
    margin: 14px 0 0;
    text-align: center;
  }
</style>
