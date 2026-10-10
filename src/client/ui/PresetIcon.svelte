<script lang="ts">
  // A custom shape's outline as a small filled icon (the same path the canvas draws).
  import { CUSTOM_PATHS } from '../../shared/shapes';
  import { POINT_STRIDE, type CustomShape } from '../../shared/types';

  let { preset, size = 16 }: { preset: CustomShape; size?: number } = $props();

  const d = $derived.by(() => {
    let out = '';
    for (const c of CUSTOM_PATHS[preset] ?? []) {
      const p = c.pts, n = p.length / POINT_STRIDE;
      const at = (i: number, k: number) => p[(i % n) * POINT_STRIDE + k];
      out += `M${at(0, 0)} ${at(0, 1)}`;
      for (let i = 0; i < (c.closed ? n : n - 1); i++) {
        const j = i + 1;
        const straight = at(i, 4) === at(i, 0) && at(i, 5) === at(i, 1) && at(j, 2) === at(j, 0) && at(j, 3) === at(j, 1);
        out += straight ? `L${at(j, 0)} ${at(j, 1)}` : `C${at(i, 4)} ${at(i, 5)} ${at(j, 2)} ${at(j, 3)} ${at(j, 0)} ${at(j, 1)}`;
      }
      if (c.closed) out += 'Z';
    }
    return out;
  });
</script>

<svg class="p" width={size} height={size} viewBox="0 0 100 100" aria-hidden="true"><path {d} /></svg>

<style>
  .p {
    flex: none;
    display: block;
  }
  path {
    fill: currentColor;
    fill-rule: nonzero;
  }
</style>
