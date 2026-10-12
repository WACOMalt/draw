<script lang="ts">
  // The settings of a layer's effects (in the effects window): blur, drop shadow, outer glow,
  // inner glow. A checkbox turns an effect on or off (off keeps its settings). Lengths are world units; the
  // sliders show them in screen pixels at the current zoom, as the brush size. Changes go out at
  // most every 60 ms, and the engine merges changes within 2 s into one undo step.
  import { EFFECT_TYPES, type EffectType, type Layer, type LayerEffect } from '../../shared/types';
  import type { Engine } from '../engine/engine';
  import { ed } from '../state.svelte';
  import ShapeColor from './ShapeColor.svelte';
  import Slider from './Slider.svelte';

  let { engine, layer }: { engine: Engine | null; layer: Layer } = $props();

  const LABEL: Record<EffectType, string> = { blur: 'Blur', dropShadow: 'Drop shadow', outerGlow: 'Outer glow', innerGlow: 'Inner glow' };
  const HINT: Record<EffectType, string> = {
    blur: 'A Gaussian blur of the layer',
    dropShadow: 'The layer’s shape, blurred, in a color, moved and behind it',
    outerGlow: 'The layer’s shape, blurred, in a color, behind it',
    innerGlow: 'A color from the edges inward, inside the layer',
  };

  /** A new effect, with sizes in screen pixels now. */
  function fresh(type: EffectType): LayerEffect {
    const px = 1 / ed.view.zoom;
    switch (type) {
      case 'blur':
        return { type, enabled: true, radius: 4 * px };
      case 'dropShadow':
        return { type, enabled: true, radius: 6 * px, color: '#000000', opacity: 0.5, spread: 0, dx: 6 * Math.SQRT1_2 * px, dy: 6 * Math.SQRT1_2 * px };
      case 'outerGlow':
        return { type, enabled: true, radius: 10 * px, color: '#ffd84d', opacity: 0.8, spread: 0 };
      case 'innerGlow':
        return { type, enabled: true, radius: 6 * px, color: '#ffffff', opacity: 0.8, spread: 0 };
    }
  }

  // The local copy follows the layer, and leads while changes wait to go out.
  // svelte-ignore state_referenced_locally
  let list = $state<LayerEffect[]>(($state.snapshot(layer.effects) as LayerEffect[] | undefined) ?? []);
  let timer: number | undefined;
  $effect(() => {
    const next = ($state.snapshot(layer.effects) as LayerEffect[] | undefined) ?? [];
    if (timer === undefined) list = next;
  });

  function send() {
    if (timer !== undefined) return;
    timer = window.setTimeout(() => {
      timer = undefined;
      engine?.setEffects(layer.id, $state.snapshot(list) as LayerEffect[]);
    }, 60);
  }

  const find = (t: EffectType) => list.find((e) => e.type === t);

  function toggle(t: EffectType, on: boolean) {
    const e = find(t);
    if (e) e.enabled = on;
    else if (on) list.push(fresh(t));
    send();
  }

  /** Sets a value of an effect. */
  function set(t: EffectType, patch: Partial<LayerEffect>) {
    const e = find(t);
    if (!e) return;
    Object.assign(e, patch);
    send();
  }

  // Screen pixels now ↔ world units.
  const px = (world: number) => world * ed.view.zoom;
  const world = (screen: number) => screen / ed.view.zoom;

  // The shadow offset as a distance and an angle (degrees, 0 = right, 90 = down).
  const dist = (e: LayerEffect) => Math.hypot(e.dx ?? 0, e.dy ?? 0);
  const angle = (e: LayerEffect) => Math.round(((Math.atan2(e.dy ?? 0, e.dx ?? 0) * 180) / Math.PI + 360) % 360);
  function setOffset(t: EffectType, d: number, deg: number) {
    const r = (deg * Math.PI) / 180;
    set(t, { dx: d * Math.cos(r), dy: d * Math.sin(r) });
  }
</script>

<div class="fx">
  {#each EFFECT_TYPES as t (t)}
    {@const e = find(t)}
    <div class="row">
      <label class="check" title={HINT[t]}>
        <input type="checkbox" checked={!!e?.enabled} onchange={(ev) => toggle(t, ev.currentTarget.checked)} />
        {LABEL[t]}
      </label>
      {#if e && e.type !== 'blur'}
        <ShapeColor
          label={LABEL[t]}
          value={e.color ?? '#000000'}
          opacity={e.opacity ?? 1}
          oninput={(v) => v && set(t, { color: v })}
          onchange={(v) => v && set(t, { color: v })}
          onopacity={(a) => set(t, { opacity: a })}
        />
      {/if}
    </div>
    {#if e?.enabled}
      <div class="params">
        <Slider
          label={t === 'blur' ? 'Radius' : 'Size'}
          value={px(e.radius)}
          min={0}
          max={1000}
          step={0.1}
          log
          width={100}
          title="Screen pixels now. It stays the same on the canvas at any zoom."
          oninput={(v) => set(t, { radius: world(v) })}
        />
        {#if t === 'dropShadow'}
          <Slider label="Distance" value={px(dist(e))} min={0} max={1000} step={0.1} log width={100} title="Screen pixels now" oninput={(v) => setOffset(t, world(v), angle(e))} />
          <Slider label="Angle" value={angle(e)} min={0} max={359} step={1} width={100} title="0° right, 90° down" oninput={(v) => setOffset(t, dist(e), v)} />
        {/if}
        {#if t !== 'blur'}
          <Slider label="Spread" value={e.spread ?? 0} min={0} max={0.99} step={0.01} percent width={100} title="Makes the edge harder" oninput={(v) => set(t, { spread: v })} />
        {/if}
      </div>
    {/if}
  {/each}
</div>

<style>
  .fx {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 26px;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
  }
  .params {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 0 0 6px 22px;
  }
</style>
