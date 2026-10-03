import type { Stroke } from '../../shared/types';

/** Tile side in device pixels. */
export const TILE = 256;
// Wide enough for the engine's zoom range (1e-9 .. 1e11 with devicePixelRatio up to 4).
export const MIN_LOD = -45;
export const MAX_LOD = 40;

/** LOD for a device scale (device px per world unit). Biased so tiles are mostly drawn at or below 1:1. */
export function lodFor(deviceScale: number): number {
  const l = Math.floor(-Math.log2(deviceScale) + 0.2);
  return Math.min(MAX_LOD, Math.max(MIN_LOD, l));
}

/** World units covered by one tile at this LOD. */
export function tileWorld(lod: number): number {
  return TILE * 2 ** lod;
}

export function tileKey(layer: string, lod: number, tx: number, ty: number): string {
  return `${layer}|${lod}|${tx}|${ty}`;
}

export interface TileView {
  lod: number;
  tx0: number;
  ty0: number;
  tx1: number; // inclusive
  ty1: number;
  layers: string[]; // visible layer ids, priority order
}

export type ToWorker =
  | { t: 'reset'; strokes: Stroke[]; seq: number }
  | { t: 'add'; stroke: Stroke; seq: number }
  | { t: 'remove'; id: string; seq: number }
  | { t: 'seq'; seq: number }
  | { t: 'view'; view: TileView }
  | { t: 'forget'; keys: string[] };

export type FromWorker =
  | { t: 'tile'; key: string; bmp: ImageBitmap | null }
  | { t: 'rendered'; seq: number };
