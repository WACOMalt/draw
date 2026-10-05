<script lang="ts">
  import type { Engine } from '../engine/engine';
  import { ed, showToast } from '../state.svelte';
  import Icon from './Icon.svelte';
  import { PUBLIC_ORIGIN } from '../config';
  import { links } from '../identity';
  import AccountButton from './AccountButton.svelte';
  import { pickFile } from '../files';

  let { engine, code, narrow, onLeave }: { engine: Engine | null; code: string; narrow: boolean; onLeave: () => void } = $props();
  /** Narrow screens: file actions and Leave go in a menu, so the bar fits on a 320 px phone. */
  let more = $state(false);
  function act(f: () => void) {
    more = false;
    f();
  }

  /** Copies the link this person came with (owners use the Share dialog instead). */
  async function copyLink() {
    const k = links.get(code);
    const url = `${PUBLIC_ORIGIN}/s/${code}${k ? `?k=${encodeURIComponent(k)}` : ''}`;
    try {
      await navigator.clipboard.writeText(url);
      showToast('Link copied');
    } catch {
      showToast(url);
    }
  }

  const initials = (name: string) =>
    name
      .split(/\s+/)
      .map((w) => w[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();
</script>

<header>
  <div class="brand"><span class="dot"></span>Draw</div>
  {#if ed.role === 'owner'}
    <button class="code share" title="Share: people, links, password" onclick={() => (ed.shareOpen = true)}>
      <Icon name="link" /><span><span class="word">Share{" "}</span>{code}</span>
    </button>
  {:else}
    <button class="code" title="Copy the link you opened this canvas with" onclick={copyLink}>
      <Icon name="link" /><span>{code}</span>
    </button>
  {/if}

  <div class="sep"></div>
  <button class="icon" title="Undo (Ctrl+Z)" disabled={!ed.canUndo || !ed.canEdit} onclick={() => engine?.undo()}><Icon name="undo" /></button>
  <button class="icon" title="Redo (Ctrl+Shift+Z)" disabled={!ed.canRedo || !ed.canEdit} onclick={() => engine?.redo()}><Icon name="redo" /></button>

  <div class="grow"></div>

  <div class="peers">
    {#each ed.peers as p (p.id)}
      <span class="avatar" style:background={p.color} title={p.name}>{initials(p.name)}</span>
    {/each}
    {#if !ed.user}
      <label class="me" title="Your name, as other people see it">
        <span class="avatar" style:background={ed.color}>{initials(ed.name)}</span>
        <input type="text" maxlength="32" bind:value={ed.name} />
      </label>
    {/if}
  </div>
  <AccountButton compact={narrow} onHome={onLeave} />

  {#if narrow}
    <div class="more">
      <button class="icon" title="More" aria-label="More" aria-expanded={more} onclick={() => (more = !more)}><Icon name="more" /></button>
      {#if more}
        <div class="menu" role="menu">
          <button role="menuitem" onclick={() => act(pickFile)}><Icon name="open" />Open a .bdraw file</button>
          <button role="menuitem" onclick={() => act(() => engine?.saveBdraw())}><Icon name="save" />Save to a .bdraw file</button>
          <button role="menuitem" onclick={() => act(() => engine?.exportPng())}><Icon name="download" />Export the view as PNG</button>
          <button role="menuitem" onclick={() => act(() => (ed.exportOpen = true))}><Icon name="image" />Export a large image…</button>
          <button role="menuitem" onclick={() => act(onLeave)}><Icon name="exit" />Leave this canvas</button>
        </div>
      {/if}
    </div>
  {:else}
    <button class="icon" title="Open a .bdraw file as a new canvas (Ctrl+O)" onclick={pickFile}><Icon name="open" /></button>
    <button class="icon" title="Save to a .bdraw file (Ctrl+S)" onclick={() => engine?.saveBdraw()}><Icon name="save" /></button>
    <button class="icon" title="Export the view as PNG (a snapshot of the screen)" onclick={() => engine?.exportPng()}><Icon name="download" /></button>
    <button class="icon" title="Export a large image: any scale, PNG or TIFF" onclick={() => (ed.exportOpen = true)}><Icon name="image" /></button>
    <button class="icon" title="Leave this canvas" onclick={onLeave}><Icon name="exit" /></button>
  {/if}
</header>

<svelte:window onpointerdown={(e) => more && !(e.target as Element).closest('.more') && (more = false)} />

<style>
  header {
    grid-area: top;
    min-height: 36px;
    padding-top: env(safe-area-inset-top);
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 8px;
    background: var(--bg-1);
    border-bottom: 1px solid var(--border);
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 7px;
    font-weight: 700;
    font-size: 13px;
    margin-right: 6px;
  }
  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--accent);
  }
  .code {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: ui-monospace, monospace;
    letter-spacing: 1px;
    padding: 3px 8px;
  }
  .share {
    color: var(--text);
    border-color: var(--accent-dim);
  }
  .sep {
    width: 1px;
    height: 18px;
    background: var(--line);
    margin: 0 4px;
  }
  .grow {
    flex: 1;
  }
  .peers {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-right: 6px;
  }
  .avatar {
    display: inline-grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    color: #111;
    font-size: 10px;
    font-weight: 700;
    border: 2px solid var(--bg-1);
  }
  .me {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-left: 6px;
  }
  .me input {
    width: 110px;
    background: transparent;
    border-color: transparent;
  }
  .me input:hover {
    border-color: var(--line);
  }
  .more {
    position: relative;
  }
  .menu {
    position: absolute;
    right: 0;
    top: calc(100% + 6px);
    z-index: 50;
    width: max-content;
    max-width: calc(100vw - 16px);
    padding: 6px;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
  }
  .menu button {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    text-align: left;
    background: transparent;
    border-color: transparent;
    padding: 10px 10px;
  }
  .menu button:hover {
    background: var(--bg-3);
  }
  @media (max-width: 760px), (max-height: 520px) and (pointer: coarse) {
    header {
      min-height: 46px;
      gap: 2px;
      padding-left: max(8px, env(safe-area-inset-left));
      padding-right: max(8px, env(safe-area-inset-right));
    }
    .brand span:not(.dot),
    .brand {
      font-size: 0;
      margin-right: 2px;
    }
    .me input,
    .sep {
      display: none;
    }
    header :global(button.icon) {
      width: 36px;
      height: 36px;
    }
    .code {
      min-width: 0;
      flex-shrink: 1;
      overflow: hidden;
      max-width: 42vw;
    }
    header > :global(*:not(.code)) {
      flex-shrink: 0;
    }
    .code span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .peers .avatar:nth-child(n + 4):not(.me .avatar) {
      display: none;
    }
  }
  /* Very small phones: keep the code readable. */
  @media (max-width: 400px) {
    .code :global(svg),
    .word,
    .me {
      display: none;
    }
    .code {
      padding: 3px 6px;
      letter-spacing: 0.5px;
    }
  }
</style>
