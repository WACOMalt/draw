<script lang="ts">
  // The ALTCHA widget (altcha.org, MIT): a proof of work the browser solves in about a second,
  // with the challenge from this server (/api/captcha). No third party, no image puzzles; the
  // "human interaction signature" collector is off. Loaded only when a form shows it.
  // `payload` holds the solution once verified (else ''). A challenge works once: remount the
  // component (a new {#key}) after the server answered.
  import { onMount } from 'svelte';
  import 'altcha/types/svelte';
  import { API_BASE } from '../config';

  let { payload = $bindable('') }: { payload?: string } = $props();

  let ready = $state(false);
  onMount(() => {
    payload = '';
    let alive = true;
    void import('altcha').then(() => alive && (ready = true));
    return () => {
      alive = false;
    };
  });

  const configuration = JSON.stringify({ humanInteractionSignature: false, hideLogo: true });
</script>

{#if ready}
  <altcha-widget
    class="captcha"
    challenge="{API_BASE}/api/captcha"
    auto="onload"
    type="checkbox"
    {configuration}
    onstatechange={(e) => (payload = e.detail.state === 'verified' ? (e.detail.payload ?? '') : '')}
  ></altcha-widget>
{:else}
  <div class="captcha loading">Loading the check…</div>
{/if}

<style>
  .captcha {
    display: block;
    margin-top: 12px;
    --altcha-max-width: 100%;
    --altcha-color-base: var(--bg-0);
    --altcha-color-base-content: var(--text);
    --altcha-color-neutral: var(--bg-3);
    --altcha-color-neutral-content: var(--text-dim);
    --altcha-color-primary: var(--accent);
    --altcha-color-primary-content: #fff;
    --altcha-border-color: var(--border);
    --altcha-border-radius: 6px;
    --altcha-input-background-color: var(--bg-0);
    --altcha-input-color: var(--text);
    --altcha-checkbox-border-color: var(--line);
    --altcha-spinner-color: var(--accent);
  }
  .loading {
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text-dim);
    font-size: 12px;
  }
</style>
