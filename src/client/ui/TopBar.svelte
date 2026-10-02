<script lang="ts">
  import type { Engine } from '../engine/engine';
  import { ed, showToast } from '../state.svelte';
  import Icon from './Icon.svelte';

  let { engine, code, onLeave }: { engine: Engine | null; code: string; onLeave: () => void } = $props();

  async function copyLink() {
    const url = `${location.origin}/s/${code}`;
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
  <button class="code" title="Copy the share link" onclick={copyLink}>
    <Icon name="link" /><span>{code}</span>
  </button>

  <div class="sep"></div>
  <button class="icon" title="Undo (Ctrl+Z)" disabled={!ed.canUndo} onclick={() => engine?.undo()}><Icon name="undo" /></button>
  <button class="icon" title="Redo (Ctrl+Shift+Z)" disabled={!ed.canRedo} onclick={() => engine?.redo()}><Icon name="redo" /></button>

  <div class="grow"></div>

  <div class="peers">
    {#each ed.peers as p (p.id)}
      <span class="avatar" style:background={p.color} title={p.name}>{initials(p.name)}</span>
    {/each}
    <label class="me" title="Your name, as other people see it">
      <span class="avatar" style:background={ed.color}>{initials(ed.name)}</span>
      <input type="text" maxlength="32" bind:value={ed.name} />
    </label>
  </div>

  <button class="icon" title="Export the view as PNG" onclick={() => engine?.exportPng()}><Icon name="download" /></button>
  <button class="icon" title="Leave this canvas" onclick={onLeave}><Icon name="exit" /></button>
</header>

<style>
  header {
    grid-area: top;
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
</style>
