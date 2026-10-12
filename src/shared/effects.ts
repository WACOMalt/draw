// Layer effects and blur adjustment layers: rules shared by the server and the clients.

import type { Adjust, Affine, Layer, LayerEffect } from './types';

/** Layers that can have effects: paint and shape layers, and groups. */
export const takesEffects = (kind: Layer['kind']) => kind === undefined || kind === 'paint' || kind === 'shape' || kind === 'group';

/**
 * Effects after a layer transform: lengths scale by √|det m| (the average scale, as brush
 * sizes do), and a shadow offset turns and scales with the linear part of m.
 */
export function transformEffects(effects: LayerEffect[], m: Affine): LayerEffect[] {
  const k = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
  return effects.map((e) => {
    const out: LayerEffect = { ...e, radius: e.radius * k };
    if (e.dx !== undefined && e.dy !== undefined) {
      out.dx = m[0] * e.dx + m[2] * e.dy;
      out.dy = m[1] * e.dx + m[3] * e.dy;
    }
    return out;
  });
}

/** A blur adjustment after a layer transform (a group with it inside): the radius scales. */
export function transformAdjust(a: Adjust, m: Affine): Adjust {
  if (a.type !== 'blur') return a;
  return { ...a, radius: a.radius * Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) };
}

/** The layer with its effect lengths and blur radius transformed (the same object when nothing changes). */
export function transformLayerLengths<L extends Layer>(l: L, m: Affine): L {
  if (!l.effects?.length && l.adjust?.type !== 'blur') return l;
  return {
    ...l,
    ...(l.effects?.length ? { effects: transformEffects(l.effects, m) } : {}),
    ...(l.adjust ? { adjust: transformAdjust(l.adjust, m) } : {}),
  };
}
