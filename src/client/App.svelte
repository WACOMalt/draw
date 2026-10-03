<script lang="ts">
  import { parseKey } from '../shared/types';
  import Landing from './ui/Landing.svelte';
  import Editor from './ui/Editor.svelte';

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

  function go(to: string) {
    history.pushState(null, '', to);
    path = to;
  }
</script>

<svelte:window onpopstate={() => (path = location.pathname)} />

{#if code}
  {#key code}
    <Editor {code} onLeave={() => go('/')} />
  {/key}
{:else}
  <Landing onOpen={(c) => go(`/s/${c}`)} />
{/if}
