// Layer effects and blur adjustment layers: rules shared by the server and the clients.

import type { Adjust, Affine, Affine3, Layer, LayerEffect } from './types';
import { LIMITS } from './types';
import { allThreeD, flatAffine } from './layers';
import { applyM3, buildM3, quatAxisAngle, quatMul, quatNormalize, rotation3, type Quat } from './transform3';

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
    // The kaleidoscope pivot moves with the layer (its turn and scale stay). A 3D step's turn
    // turns with the layer in the paper, and its depths scale as the strokes' (transformThreeD).
    if (e.cx !== undefined && e.cy !== undefined) {
      out.cx = m[0] * e.cx + m[2] * e.cy + m[4];
      out.cy = m[1] * e.cx + m[3] * e.cy + m[5];
    }
    if (e.turn) {
      const r = quatAxisAngle(0, 0, 1, Math.atan2(m[1], m[0]));
      out.turn = quatMul(quatMul(r, e.turn), [-r[0], -r[1], -r[2], r[3]]);
    }
    if (e.cz !== undefined) out.cz = e.cz * k;
    if (e.dz !== undefined) out.dz = e.dz * k;
    return out;
  });
}

/**
 * The step transform of a kaleidoscope effect (world to world): turn by `angle` and scale by
 * `scale` about the pivot, then move by (dx, dy). Copy i is this transform applied i times.
 */
export function kaleidoscopeStep(e: LayerEffect): Affine {
  const a = ((e.angle ?? 0) * Math.PI) / 180, k = e.scale ?? 1;
  const c = Math.cos(a) * k, s = Math.sin(a) * k;
  const cx = e.cx ?? 0, cy = e.cy ?? 0;
  // p' = R·S·(p − pivot) + pivot + offset
  return [c, s, -s, c, cx - c * cx + s * cy + (e.dx ?? 0), cy - s * cx - c * cy + (e.dy ?? 0)];
}

/** The turn of a kaleidoscope step: its 3D `turn`, or `angle` degrees about the axis out of the paper. */
export function kaleidoscopeTurn(e: LayerEffect): Quat {
  return e.turn ? quatNormalize(e.turn) : quatAxisAngle(0, 0, 1, ((e.angle ?? 0) * Math.PI) / 180);
}

/**
 * The step of a kaleidoscope in 3D (world to world, axes as Stroke.threed): about the pivot
 * (cx, cy, cz) it turns (kaleidoscopeTurn) and scales, then moves by (dx, dy, dz). Without the
 * 3D settings, kaleidoscopeStep's turn in the paper (depth only scales).
 */
export function kaleidoscopeStep3(e: LayerEffect): Affine3 {
  return buildM3(kaleidoscopeTurn(e), e.scale ?? 1, [e.cx ?? 0, e.cy ?? 0, e.cz ?? 0], [e.dx ?? 0, e.dy ?? 0, e.dz ?? 0]);
}

/**
 * The step tilts the copies out of the paper (its turn is not only about the axis out of it):
 * on a 3D layer they then differ from a picture moved in the paper, and come from the strokes.
 */
export function kaleidoscopeTilts(e: LayerEffect): boolean {
  if (!e.turn) return false;
  const [x, y] = quatNormalize(e.turn);
  return Math.hypot(x, y) > 1e-9;
}

/** The 3D transforms of the copies, copy 1 first (the step applied 1, 2, … times). */
export function kaleidoscopeCopies3(e: LayerEffect): Affine3[] {
  const step = kaleidoscopeStep3(e);
  const out: Affine3[] = [];
  let m: Affine3 = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
  for (let i = 0; i < Math.min(LIMITS.maxKaleidoscope, e.count ?? 0); i++) out.push((m = compose3(step, m)));
  return out;
}

/**
 * The copies as the 2D view sees them (straight on, no perspective): copy i is the 2D transform
 * that its 3D transform makes on the paper at the pivot's depth (x, y moved; depth dropped). For a
 * step in the paper this is the step applied i times; for one that tilts, the copies squash
 * across the tilt as a tilted picture looks from the front. This is how a flat layer draws a 3D
 * step ("down projected"): exact for its strokes, which lie in the paper.
 */
export function kaleidoscopeCopies(e: LayerEffect): Affine[] {
  const z = e.cz ?? 0;
  return kaleidoscopeCopies3(e).map((m) => [m[0], m[1], m[3], m[4], m[6] * z + m[9], m[7] * z + m[10]]);
}

/** a after b (apply b first). */
function compose3(a: Affine3, b: Affine3): Affine3 {
  const out = new Array<number>(12);
  for (let c = 0; c < 3; c++)
    for (let r = 0; r < 3; r++) out[c * 3 + r] = a[r] * b[c * 3] + a[3 + r] * b[c * 3 + 1] + a[6 + r] * b[c * 3 + 2];
  const t = applyM3(a, b[9], b[10], b[11]);
  out[9] = t[0];
  out[10] = t[1];
  out[11] = t[2];
  return out as Affine3;
}

/**
 * Effects after a 3D layer transform m3 (a turn times one scale k, and a move): lengths scale by
 * k (as transformEffects with m3's view in the paper); a kaleidoscope's step follows the layer
 * exactly (m3 · step · m3⁻¹: its pivot moves, its move turns and scales, its turn turns with
 * the layer). A layer turned out of the paper thus gets a 3D step (feature 'kaleido3d').
 */
export function transformEffects3(effects: LayerEffect[], m3: Affine3): LayerEffect[] {
  const flat = transformEffects(effects, flatAffine(m3));
  return flat.map((out, i) => {
    const e = effects[i];
    if (e.type !== 'kaleidoscope') return out;
    const k = Math.cbrt(Math.abs(m3[0] * (m3[4] * m3[8] - m3[7] * m3[5]) - m3[3] * (m3[1] * m3[8] - m3[7] * m3[2]) + m3[6] * (m3[1] * m3[5] - m3[4] * m3[2])));
    // The layer's turn as a quaternion (from its rotation matrix, scale divided out).
    const q = quatFromMatrix(m3.slice(0, 9).map((v) => v / k));
    const [px, py, pz] = applyM3(m3, e.cx ?? 0, e.cy ?? 0, e.cz ?? 0);
    const d = [e.dx ?? 0, e.dy ?? 0, e.dz ?? 0];
    const md = [0, 1, 2].map((r) => m3[r] * d[0] + m3[3 + r] * d[1] + m3[6 + r] * d[2]);
    const turn = quatMul(quatMul(q, kaleidoscopeTurn(e)), [-q[0], -q[1], -q[2], q[3]]);
    const res: LayerEffect = { ...out, cx: px, cy: py, dx: md[0], dy: md[1] };
    // Still a turn in the paper: the flat settings (angle) say it; else the 3D ones.
    if (Math.hypot(turn[0], turn[1]) > 1e-9) {
      res.turn = turn;
      res.angle = 0;
    } else {
      delete res.turn;
      res.angle = Math.round(((2 * Math.atan2(turn[2], turn[3]) * 180) / Math.PI) * 1e9) / 1e9;
      if (res.angle > 360) res.angle -= 360;
      if (res.angle < -360) res.angle += 360;
    }
    if (Math.abs(pz) > 0) res.cz = pz;
    else delete res.cz;
    if (Math.abs(md[2]) > 0) res.dz = md[2];
    else delete res.dz;
    return res;
  });
}

/** The unit quaternion of a rotation matrix (3×3, column-major). */
function quatFromMatrix(r: number[]): Quat {
  // Shepperd's method: from the largest of w, x, y, z.
  const m00 = r[0], m11 = r[4], m22 = r[8];
  const t = m00 + m11 + m22;
  let q: Quat;
  if (t > 0) {
    const s = Math.sqrt(t + 1) * 2;
    q = [(r[5] - r[7]) / s, (r[6] - r[2]) / s, (r[1] - r[3]) / s, s / 4];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [s / 4, (r[3] + r[1]) / s, (r[6] + r[2]) / s, (r[5] - r[7]) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(r[3] + r[1]) / s, s / 4, (r[7] + r[5]) / s, (r[6] - r[2]) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(r[6] + r[2]) / s, (r[7] + r[5]) / s, s / 4, (r[1] - r[3]) / s];
  }
  return quatNormalize(q);
}

/** A blur adjustment after a layer transform (a group with it inside): the radius scales. */
export function transformAdjust(a: Adjust, m: Affine): Adjust {
  if (a.type !== 'blur') return a;
  return { ...a, radius: a.radius * Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) };
}

/** As transformLayerLengths, after a 3D layer transform (transformEffects3). */
export function transformLayerLengths3<L extends Layer>(l: L, m3: Affine3): L {
  if (!l.effects?.length && l.adjust?.type !== 'blur') return l;
  return {
    ...l,
    ...(l.effects?.length ? { effects: transformEffects3(l.effects, m3) } : {}),
    ...(l.adjust ? { adjust: transformAdjust(l.adjust, flatAffine(m3)) } : {}),
  };
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

/** The kaleidoscope's step is a 3D one: a turn in 3D, or depths. */
export function isKaleidoscope3(e: LayerEffect): boolean {
  return !!e.turn || e.cz !== undefined || e.dz !== undefined;
}

/**
 * A kaleidoscope made a flat step: the turn in the paper and the scale nearest to what the 2D view
 * shows of its step (straight on, at the pivot), the same move of the pivot; the tilt and the
 * depths go. (A flat layer's kaleidoscope is always flat.)
 */
export function flattenKaleidoscope(e: LayerEffect): LayerEffect {
  const [a, b, c, d, tx, ty] = kaleidoscopeCopies({ ...e, count: 1 })[0];
  const cx = e.cx ?? 0, cy = e.cy ?? 0;
  const out: LayerEffect = {
    ...e,
    angle: Math.round(((Math.atan2(b - c, a + d) * 180) / Math.PI) * 1000) / 1000,
    scale: Math.min(100, Math.max(0.01, Math.sqrt(Math.abs(a * d - b * c)))),
    dx: a * cx + c * cy + tx - cx,
    dy: b * cx + d * cy + ty - cy,
  };
  delete out.turn;
  delete out.cz;
  delete out.dz;
  return out;
}

/** A kaleidoscope made a 3D step: its angle as a turn about the axis out of the paper. (A 3D layer's is always 3D.) */
export function liftKaleidoscope(e: LayerEffect): LayerEffect {
  if (e.turn) return e;
  return { ...e, angle: 0, turn: quatAxisAngle(0, 0, 1, ((e.angle ?? 0) * Math.PI) / 180) };
}

/**
 * A 3D step's angle, degrees: how far it turns about its axis (minus when the axis points into the
 * paper). The angle of a flat step.
 */
export function kaleidoscopeAngle(e: LayerEffect): number {
  if (!e.turn) return e.angle ?? 0;
  const [x, y, z, w] = quatNormalize(e.turn);
  const s = Math.hypot(x, y, z);
  const a = (2 * Math.atan2(s, w) * 180) / Math.PI;
  return z < 0 ? -a : a;
}

/** The step turned `deg` degrees about its axis (a 3D step: the axis kept; out of the paper when it has none). */
export function withKaleidoscopeAngle(e: LayerEffect, deg: number): Partial<LayerEffect> {
  if (!e.turn) return { angle: deg };
  const [x, y, z] = quatNormalize(e.turn);
  const s = Math.hypot(x, y, z);
  let axis: [number, number, number] = s > 1e-9 ? [x / s, y / s, z / s] : [0, 0, 1];
  if (axis[2] < 0) axis = [-axis[0], -axis[1], -axis[2]];
  return { turn: quatAxisAngle(axis[0], axis[1], axis[2], (deg * Math.PI) / 180) };
}

/**
 * The effects to set so each kaleidoscope has its layer's kind: a 3D step on a layer or group whose
 * paint layers are all 3D (when `ok3d`: the server takes 3D steps), a flat step elsewhere.
 * `layers`: the live layers, as they will be.
 */
export function kaleidoscopeFixes(layers: Layer[], ok3d: boolean): { id: string; effects: LayerEffect[] }[] {
  const out: { id: string; effects: LayerEffect[] }[] = [];
  for (const l of layers) {
    const i = l.effects?.findIndex((e) => e.type === 'kaleidoscope') ?? -1;
    if (i < 0) continue;
    const e = l.effects![i];
    const three = ok3d && allThreeD(layers, l.id);
    const fixed = three && !e.turn ? liftKaleidoscope(e) : !three && isKaleidoscope3(e) ? flattenKaleidoscope(e) : null;
    if (fixed) out.push({ id: l.id, effects: l.effects!.map((x, j) => (j === i ? fixed : x)) });
  }
  return out;
}
