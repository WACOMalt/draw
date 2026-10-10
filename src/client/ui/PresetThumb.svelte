<script lang="ts">
  // A preset thumbnail that loads when it scrolls near the view (presetThumb.ts draws it in a
  // worker, or takes it from storage). An empty box holds its place until then.
  import type { BrushSettings } from '../../shared/types';
  import { presetThumb } from '../presetThumb';

  let { settings }: { settings: BrushSettings } = $props();
  let src = $state('');

  function lazy(node: HTMLElement) {
    let done = false;
    const io = new IntersectionObserver(
      (es) => {
        if (done || !es.some((e) => e.isIntersecting)) return;
        done = true;
        io.disconnect();
        presetThumb($state.snapshot(settings)).then(
          (u) => (src = u),
          () => {},
        );
      },
      { rootMargin: '200px' },
    );
    io.observe(node);
    return { destroy: () => io.disconnect() };
  }
</script>

<span class="thumb" use:lazy>
  {#if src}<img {src} alt="" width="160" height="56" />{/if}
</span>

<style>
  .thumb {
    display: block;
    width: 100%;
    aspect-ratio: 160 / 56;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.03);
  }
  img {
    display: block;
    width: 100%;
    height: 100%;
    animation: in 0.15s ease-out;
  }
  @keyframes in {
    from {
      opacity: 0;
    }
  }
</style>
