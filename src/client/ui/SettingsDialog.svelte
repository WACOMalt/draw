<script lang="ts">
  // App settings on this device. Rendering: the performance profile (perf.ts). The renderer reads
  // it when it starts, so a change applies after a reload.
  import Modal from './Modal.svelte';
  import { ed } from '../state.svelte';
  import { autoPerf, perfSetting, setPerfSetting, type PerfName } from '../engine/perf';

  let { onClose }: { onClose: () => void } = $props();

  const start = perfSetting();
  let choice = $state<PerfName | 'auto'>(start);
  const auto = autoPerf();
  const byUrl = new URLSearchParams(location.search).has('perf');

  const options: { value: PerfName | 'auto'; label: string; note: string }[] = [
    { value: 'auto', label: 'Auto', note: auto ? `Detects the device. Here: ${auto.name}, for ${auto.why}.` : 'Detects the device.' },
    { value: 'full', label: 'Full', note: 'The screen resolution and 16-bit buffers. For desktops and fast tablets.' },
    { value: 'phone', label: 'Phone', note: 'At most 2× resolution, 16-bit buffers, fewer tiles in memory.' },
    { value: 'light', label: 'Light', note: 'At most 1.5× resolution and 8-bit buffers: half the memory. Soft and low-flow strokes get less exact colors.' },
  ];
</script>

<Modal title="Settings" {onClose}>
  <fieldset>
    <legend>Rendering on this device</legend>
    {#each options as o (o.value)}
      <label class="opt">
        <input type="radio" name="perf" value={o.value} bind:group={choice} onchange={() => setPerfSetting(choice)} />
        <span><b>{o.label}</b><br /><span class="muted">{o.note}</span></span>
      </label>
    {/each}
  </fieldset>
  <p class="muted now">Now: {ed.renderer}</p>
  {#if byUrl}<p class="muted">The <code>?perf=</code> in the address overrides this setting.</p>{/if}
  {#if choice !== start}
    <p>The change applies after a reload.</p>
    <div class="actions">
      <button class="primary" onclick={() => location.reload()}>Reload now</button>
      <button onclick={onClose}>Later</button>
    </div>
  {/if}
</Modal>

<style>
  fieldset {
    border: none;
    margin: 0;
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
  .opt .muted,
  .now {
    font-size: 12px;
  }
  .actions {
    display: flex;
    gap: 8px;
  }
</style>
