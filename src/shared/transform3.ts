// 3D layer transforms (layer.transform with m3) as the 2D app's 3D gizmo builds them: a turn
// (a unit quaternion), one uniform scale and a move, about a pivot. The turn becomes an exact
// rotation matrix in doubles, so validAffine3 (columns at right angles to 1e-6) accepts the
// result however many small turns went into it.

import type { Affine3 } from './types';

/** A rotation as a unit quaternion: x, y, z, w. */
export type Quat = [number, number, number, number];

export const QUAT_ID: Quat = [0, 0, 0, 1];
export const IDENTITY3: Affine3 = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

/** A turn by `angle` radians about the axis (ax, ay, az) (right-handed; any length; zero: no turn). */
export function quatAxisAngle(ax: number, ay: number, az: number, angle: number): Quat {
  const len = Math.hypot(ax, ay, az);
  if (!(len > 0) || !Number.isFinite(angle)) return [...QUAT_ID];
  const s = Math.sin(angle / 2) / len;
  return [ax * s, ay * s, az * s, Math.cos(angle / 2)];
}

/** The turn `a` after the turn `b` (apply b first), made unit again. */
export function quatMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return quatNormalize([
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ]);
}

export function quatNormalize(q: Quat): Quat {
  const len = Math.hypot(q[0], q[1], q[2], q[3]);
  return len > 0 ? [q[0] / len, q[1] / len, q[2] / len, q[3] / len] : [...QUAT_ID];
}

/** A part `g` of a turn (the same axis, g times the angle): g = 0 no turn, 1 the turn. */
export function quatPow(q: Quat, g: number): Quat {
  const [x, y, z, w] = quatNormalize(q);
  const half = Math.acos(Math.max(-1, Math.min(1, w)));
  return half < 1e-12 ? [...QUAT_ID] : quatAxisAngle(x, y, z, 2 * half * g);
}

/** The rotation matrix of a unit quaternion: 3×3, column-major (as the first nine numbers of an Affine3). */
export function rotation3(q: Quat): number[] {
  const [x, y, z, w] = quatNormalize(q);
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w),
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w),
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y),
  ];
}

/**
 * The 3D transform that turns by `q` and scales by `s` about `pivot`, then moves by `move`:
 * p' = pivot + move + s·R(q)·(p − pivot).
 */
export function buildM3(q: Quat, s: number, pivot: [number, number, number], move: [number, number, number]): Affine3 {
  const r = rotation3(q).map((v) => v * s);
  const [px, py, pz] = pivot;
  return [
    ...r,
    px + move[0] - (r[0] * px + r[3] * py + r[6] * pz),
    py + move[1] - (r[1] * px + r[4] * py + r[7] * pz),
    pz + move[2] - (r[2] * px + r[5] * py + r[8] * pz),
  ] as Affine3;
}

/** A point through a 3D transform. */
export function applyM3(m: Affine3, x: number, y: number, z: number): [number, number, number] {
  return [
    m[0] * x + m[3] * y + m[6] * z + m[9],
    m[1] * x + m[4] * y + m[7] * z + m[10],
    m[2] * x + m[5] * y + m[8] * z + m[11],
  ];
}

/**
 * The inverse of a 3D transform whose linear part is a turn times one scale s (validAffine3):
 * the transposed linear part over s², and the move undone. The undo of a 3D layer transform.
 */
export function invertM3(m: Affine3): Affine3 {
  const s2 = (m[0] * m[0] + m[1] * m[1] + m[2] * m[2] + m[3] * m[3] + m[4] * m[4] + m[5] * m[5] + m[6] * m[6] + m[7] * m[7] + m[8] * m[8]) / 3;
  const l = [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]].map((v) => v / s2);
  return [
    ...l,
    -(l[0] * m[9] + l[3] * m[10] + l[6] * m[11]),
    -(l[1] * m[9] + l[4] * m[10] + l[7] * m[11]),
    -(l[2] * m[9] + l[5] * m[10] + l[8] * m[11]),
  ] as Affine3;
}

/** Within `eps` of no change (relative to `size` for the move). */
export function isIdentity3(m: Affine3, size = 1, eps = 1e-9): boolean {
  return m.every((v, i) => Math.abs(v - IDENTITY3[i]) <= (i < 9 ? eps : eps * Math.max(1, size)));
}

/**
 * The turn of a trackball drag by (dx, dy) screen pixels on a ball of radius `r` pixels: about
 * the axis in the screen plane at right angles to the drag, so the side toward the viewer
 * follows the pointer (x right, y down, z toward the viewer).
 */
export function trackball(dx: number, dy: number, r: number): Quat {
  return quatAxisAngle(-dy, dx, 0, Math.hypot(dx, dy) / Math.max(r, 1));
}
