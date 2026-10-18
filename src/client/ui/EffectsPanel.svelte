<script lang="ts">
  // The settings of a layer's effects (in the effects window): blur, drop shadow, outer glow,
  // inner glow. A checkbox turns an effect on or off (off keeps its settings). Lengths are world units; the
  // sliders show them in screen pixels at the current zoom, as the brush size. Changes go out at
  // most every 60 ms, and the engine merges changes within 2 s into one undo step.
  import { EFFECT_TYPES, type EffectType, type Layer, type LayerEffect } from '../../shared/types';
  import { flattenKaleidoscope, kaleidoscopeAngle, liftKaleidoscope, withKaleidoscopeAngle } from '../../shared/effects';
  import { allThreeD } from '../../shared/layers';
  import type { Engine } from '../engine/engine';
  import { ed } from '../state.svelte';
  import ShapeColor from './ShapeColor.svelte';
  import Slider from './Slider.svelte';

  let { engine, layer }: { engine: Engine | null; layer: Layer } = $props();

  const LABEL: Record<EffectType, string> = { blur: 'Blur', dropShadow: 'Drop shadow', outerGlow: 'Outer glow', innerGlow: 'Inner glow', kaleidoscope: 'Kaleidoscope' };
  const HINT: Record<EffectType, string> = {
    blur: 'A Gaussian blur of the layer',
    dropShadow: 'The layer’s shape, blurred, in a color, moved and behind it',
    outerGlow: 'The layer’s shape, blurred, in a color, behind it',
    innerGlow: 'A color from the edges inward, inside the layer',
    kaleidoscope: 'Copies of the layer, each turned, scaled and moved by the step once more (a gizmo on the canvas)',
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
      case 'kaleidoscope': {
        // Six around the middle of the view.
        const [cx, cy] = viewCenter();
        const e: LayerEffect = { type, enabled: true, radius: 0, count: 5, angle: 60, scale: 1, cx, cy, dx: 0, dy: 0, order: 'behind' };
        // A 3D layer's (or 3D group's) kaleidoscope is a 3D one.
        return three ? liftKaleidoscope(e) : e;
      }
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

  /** The kaleidoscope's step may move in 3D here (a 3D layer or group; a server that takes it). */
  const three = $derived(ed.kaleido3dOk && allThreeD(ed.layers, layer.id));

  /**
   * A 3D kaleidoscope step made a flat one (the nearest turn in the paper and scale; the tilt goes).
   * On a 3D layer or group the layer goes flat with it (a kaleidoscope has its layer's kind), after
   * a warning; the engine flattens the step in the same undo step.
   */
  function flatten(e: LayerEffect) {
    if (three) {
      const what = layer.kind === 'group' ? 'every layer in this group' : 'this layer';
      if (!confirm(`A flat kaleidoscope needs a flat layer: this also makes ${what} flat. Its strokes keep their depth but draw flat (Undo takes it back). Go on?`)) return;
      engine?.setThreeD(layer.id, false);
      return;
    }
    const x = find('kaleidoscope');
    if (!x) return;
    const f = flattenKaleidoscope(x);
    delete x.turn;
    delete x.cz;
    delete x.dz;
    set('kaleidoscope', { angle: f.angle, scale: f.scale, dx: f.dx, dy: f.dy });
  }

  /** The world point in the middle of the view. */
  function viewCenter(): [number, number] {
    const r = engine?.viewRect().bounds;
    return r ? [(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2] : [0, 0];
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
      {#if e && e.type !== 'blur' && e.type !== 'kaleidoscope'}
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
    {#if e?.enabled && t === 'kaleidoscope'}
      {@const n = e.count ?? 1}
      <div class="params">
        <label class="field" title="Copies of the layer (1 to 64)"
          >Count <input
            type="number"
            min="1"
            max="64"
            step="1"
            value={n}
            onchange={(ev) => {
              const v = Math.round(+ev.currentTarget.value);
              if (v >= 1) set(t, { count: Math.min(64, v) });
            }}
          /></label
        >
        {#if e.turn}
          <!-- A 3D step (a 3D layer's or group's): its turn is in 3D. -->
          <div class="field note">
            <span>3D step: the copies turn in 3D{three ? ' (tilt it with the gizmo: ball, red and green bars)' : ' (seen straight on, as this layer is flat)'}.</span>
            <button class="small" title={three ? 'Make it a flat step: the layer goes flat too' : 'Make it a flat step: the nearest turn in the paper and scale; the tilt goes'} disabled={!ed.canEdit} onclick={() => flatten(e)}>Flatten{three ? ' (and the layer)' : ''}</button>
          </div>
        {/if}
        {#if !e.turn || three}
        <div class="field">
          <!-- Copies compound the step (copy n turns n times as far): fine steps near 0, a full turn either way at the ends. A 3D step turns about its own axis. -->
          <Slider label="Angle" value={kaleidoscopeAngle(e)} min={-360} max={360} step={0.01} least={0.1} log width={80} title="Degrees each copy turns past the one before (fine near 0°)" oninput={(v) => set(t, withKaleidoscopeAngle(e, v))} />
          <button class="small" title="Even around a full turn: 360° ÷ (count + 1)" onclick={() => set(t, withKaleidoscopeAngle(e, Math.round((360 / (n + 1)) * 1000) / 1000))}>Even</button>
        </div>
        {/if}
        <Slider label="Scale" value={e.scale ?? 1} min={0.05} max={4} center={1} least={0.0001} step={0.0001} percent log width={100} title="Each copy's size, from the one before (fine near 100%: the copies multiply it)" oninput={(v) => set(t, { scale: v })} />
        <Slider label="Move X" value={px(e.dx ?? 0)} min={-2000} max={2000} step={0.1} least={0.1} log width={100} title="Screen pixels now: each copy moves this far from the one before (fine near 0)" oninput={(v) => set(t, { dx: world(v) })} />
        <Slider label="Move Y" value={px(e.dy ?? 0)} min={-2000} max={2000} step={0.1} least={0.1} log width={100} title="Screen pixels now (fine near 0)" oninput={(v) => set(t, { dy: world(v) })} />
        {#if three}
          <!-- Depths in screen pixels now, + toward the viewer (as the 3D transform's depth). -->
          <Slider label="Move Z" value={px(e.dz ?? 0)} min={-2000} max={2000} step={0.1} least={0.1} log width={100} title="Screen pixels now: each copy moves this far toward you (+) or away (−)" oninput={(v) => set(t, { dz: world(v) || undefined })} />
          <Slider label="Pivot Z" value={px(e.cz ?? 0)} min={-2000} max={2000} step={0.1} least={0.1} log width={100} title="The pivot's depth, screen pixels now: the 3D turn goes about this point" oninput={(v) => set(t, { cz: world(v) || undefined })} />
        {/if}
        <div class="field">
          <span>Copies</span>
          <div class="seg">
            <button class="small" class:on={e.order === 'behind'} onclick={() => set(t, { order: 'behind' })}>Behind</button>
            <button class="small" class:on={e.order === 'front'} onclick={() => set(t, { order: 'front' })}>In front</button>
          </div>
        </div>
        <button class="small" title="The pivot to the middle of the view" onclick={() => { const [cx, cy] = viewCenter(); set(t, { cx, cy }); }}>Pivot to the middle</button>
        <p class="hint">On the canvas: drag the round pivot, the square to move each step, and the arrow tip to turn and scale. The last copy follows the pointer (Alt: finer; Shift: 15° steps).</p>
      </div>
    {:else if e?.enabled}
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
  .field {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    margin: 0;
  }
  .field input {
    width: 60px;
  }
  .seg {
    display: flex;
    gap: 4px;
  }
  button.on {
    color: var(--text);
    border-color: var(--accent-dim);
    background: #24394c;
  }
  .hint {
    margin: 0;
    font-size: 11px;
    color: var(--text-faint);
  }
  .params {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 0 0 6px 22px;
  }
</style>
