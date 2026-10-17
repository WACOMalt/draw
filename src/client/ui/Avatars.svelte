<script lang="ts">
  // VR people (vdraw) as ghosts on the canvas: their head and hands seen straight down on the
  // paper (depth ignored), in their color, faint, with the canvas zoom. A head is a circle 0.2 m
  // across with a short line where it looks (a dot when it looks straight at the paper); a hand a
  // small circle with a pointer where the controller points; faint arms join them. No message for
  // STALE ms: the ghost fades out, and goes after GONE ms.
  import { ed, type AvatarView } from '../state.svelte';
  import type { Pose } from '../../shared/types';

  const STALE = 3000;
  const GONE = 4000;

  let now = $state(performance.now());
  const any = $derived(ed.avatars.length > 0);
  $effect(() => {
    if (!any) return;
    const t = window.setInterval(() => {
      now = performance.now();
      const live = ed.avatars.filter((a) => now - a.at < GONE);
      if (live.length !== ed.avatars.length) ed.avatars = live;
    }, 200);
    return () => window.clearInterval(t);
  });

  type Pt = [number, number];
  interface Hand {
    c: Pt;
    r: number;
    /** The pointer: from the circle's edge to its tip; null when the hand points at the paper. */
    line: [Pt, Pt] | null;
  }
  interface Ghost {
    id: string;
    name: string;
    color: string;
    opacity: number;
    c: Pt;
    r: number;
    look: [Pt, Pt] | null;
    hands: Hand[];
  }

  /** From the edge of a circle (c, r) along the paper part of `f`, `len` px per unit of it. Null: too short to see. */
  function pointer(c: Pt, r: number, f: Pose['f'], len: number): [Pt, Pt] | null {
    const l = Math.hypot(f[0], f[1]);
    if (l < 0.25) return null;
    const dx = f[0] / l, dy = f[1] / l;
    return [
      [c[0] + dx * r, c[1] + dy * r],
      [c[0] + dx * (r + len * l), c[1] + dy * (r + len * l)],
    ];
  }

  const ghosts = $derived.by((): Ghost[] => {
    if (!ed.showAvatars) return [];
    const { x: vx, y: vy, zoom } = ed.view;
    const S = (p: Pose['p']): Pt => [(p[0] - vx) * zoom, (p[1] - vy) * zoom];
    return ed.avatars.flatMap((a: AvatarView) => {
      const age = now - a.at;
      const fade = age < STALE ? 1 : Math.max(0, 1 - (age - STALE) / (GONE - STALE));
      if (fade <= 0) return [];
      const peer = ed.peers.find((p) => p.id === a.id);
      const k = a.m * zoom; // screen px per meter of this person
      const c = S(a.head.p);
      const r = Math.max(3, 0.1 * k);
      const hands = a.hands.flatMap((h): Hand[] => {
        if (!h) return [];
        const hc = S(h.p);
        const hr = Math.max(2, 0.03 * k);
        return [{ c: hc, r: hr, line: pointer(hc, hr, h.f, 0.15 * k) }];
      });
      return [{ id: a.id, name: peer?.name ?? 'VR', color: peer?.color ?? '#9aa0a6', opacity: fade, c, r, look: pointer(c, r, a.head.f, 0.12 * k), hands }];
    });
  });
</script>

{#if ghosts.length}
  <svg class="avatars" aria-hidden="true">
    {#each ghosts as g (g.id)}
      <g style:opacity={g.opacity} style:--c={g.color}>
        {#each g.hands as h, i (i)}
          <line class="arm" x1={g.c[0]} y1={g.c[1]} x2={h.c[0]} y2={h.c[1]} />
        {/each}
        <circle cx={g.c[0]} cy={g.c[1]} r={g.r} />
        {#if g.look}
          <line x1={g.look[0][0]} y1={g.look[0][1]} x2={g.look[1][0]} y2={g.look[1][1]} />
        {:else}
          <circle class="dot" cx={g.c[0]} cy={g.c[1]} r="1.5" />
        {/if}
        {#each g.hands as h, i (i)}
          <circle cx={h.c[0]} cy={h.c[1]} r={h.r} />
          {#if h.line}<line x1={h.line[0][0]} y1={h.line[0][1]} x2={h.line[1][0]} y2={h.line[1][1]} />{/if}
        {/each}
        <text x={g.c[0]} y={g.c[1] - g.r - 5}>{g.name}</text>
      </g>
    {/each}
  </svg>
{/if}

<style>
  .avatars {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: hidden;
    pointer-events: none;
  }
  g {
    transition: opacity 200ms linear;
  }
  circle,
  line {
    fill: none;
    stroke: var(--c);
    stroke-width: 1.5;
    stroke-opacity: 0.45;
    stroke-linecap: round;
  }
  .dot {
    fill: var(--c);
    fill-opacity: 0.45;
    stroke: none;
  }
  .arm {
    stroke-opacity: 0.15;
  }
  text {
    fill: var(--c);
    fill-opacity: 0.85;
    font-size: 11px;
    font-weight: 600;
    text-anchor: middle;
    paint-order: stroke;
    stroke: rgba(0, 0, 0, 0.25);
    stroke-width: 2px;
  }
</style>
