<script lang="ts">
  import { ed } from '../state.svelte';
  import Modal from './Modal.svelte';
  import NewCanvasForm from './NewCanvasForm.svelte';

  // A .bdraw file always opens as a new online canvas: a copy, never the canvas it came from.
  let { onOpen }: { onOpen: (key: string) => void } = $props();
  const file = ed.openFile!;
  const size = file.blob.size < 1024 * 1024 ? `${Math.max(1, Math.round(file.blob.size / 1024))} KB` : `${(file.blob.size / 1024 / 1024).toFixed(1)} MB`;
</script>

<Modal title="Open {file.name}" onClose={() => (ed.openFile = null)}>
  <p class="muted">{size} · Opens as a new online canvas with a copy of the drawing.</p>
  <NewCanvasForm
    file={file.blob}
    onCreated={(key) => {
      ed.openFile = null;
      onOpen(key);
    }}
  />
</Modal>
