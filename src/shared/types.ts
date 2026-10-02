// Document model and wire protocol shared by the client, the tile worker and the server.

export const BLEND_MODES = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
  'add',
] as const;
export type BlendMode = (typeof BLEND_MODES)[number];

export interface Brush {
  tool: 'paint' | 'erase';
  color: string; // #rrggbb
  size: number; // diameter, world units
  opacity: number; // 0..1, cap for the whole stroke
  flow: number; // 0..1, alpha of a single dab
  hardness: number; // 0..1
  spacing: number; // fraction of the diameter
  pressureSize: boolean;
  pressureFlow: boolean;
  buildup: boolean; // airbrush: zero-length segments emit dabs
}

export interface Layer {
  id: string;
  name: string;
  order: number; // fractional index, ascending = bottom to top
  blend: BlendMode;
  opacity: number;
  visible: boolean;
  deleted: boolean;
}

export interface Stroke {
  id: string;
  layerId: string;
  seq: number; // z-order within the layer
  author: string;
  brush: Brush;
  pts: number[]; // flat x, y, pressure triples in world units
  deleted?: boolean;
}

export type LayerProps = Pick<Layer, 'name' | 'blend' | 'opacity' | 'visible' | 'order'>;

export type Op =
  | { type: 'stroke.add'; stroke: Pick<Stroke, 'id' | 'layerId' | 'brush' | 'pts'> }
  | { type: 'stroke.remove'; id: string }
  | { type: 'stroke.restore'; id: string }
  | { type: 'layer.add'; layer: Pick<Layer, 'id'> & LayerProps }
  | { type: 'layer.update'; id: string; props: Partial<LayerProps> }
  | { type: 'layer.remove'; id: string }
  | { type: 'layer.restore'; id: string };

/** An op as the server broadcasts it: restore ops carry the full object so late joiners can apply them. */
export type AppliedOp =
  | Exclude<Op, { type: 'stroke.add' } | { type: 'stroke.restore' }>
  | { type: 'stroke.add'; stroke: Stroke }
  | { type: 'stroke.restore'; id: string; stroke: Stroke };

export interface Peer {
  id: string;
  name: string;
  color: string;
}

export type ClientMsg =
  | { t: 'hello'; name: string; color: string }
  | { t: 'op'; opId: string; op: Op }
  | { t: 'live'; id: string; layerId: string; brush: Brush; pts: number[]; start: boolean }
  | { t: 'live.end'; id: string }
  | { t: 'cursor'; x: number | null; y: number | null; layerId: string | null }
  | { t: 'ping' };

export type ServerMsg =
  | {
      t: 'welcome';
      clientId: string;
      code: string;
      seq: number;
      layers: Layer[];
      strokes: Stroke[];
      peers: Peer[];
    }
  | { t: 'op'; seq: number; by: string; opId: string; op: AppliedOp }
  | { t: 'reject'; opId: string; reason: string }
  | { t: 'live'; by: string; id: string; layerId: string; brush: Brush; pts: number[]; start: boolean }
  | { t: 'live.end'; by: string; id: string }
  | { t: 'cursor'; by: string; x: number | null; y: number | null; layerId: string | null }
  | { t: 'peer.join'; peer: Peer }
  | { t: 'peer.leave'; id: string }
  | { t: 'error'; code: string; message: string }
  | { t: 'pong' };

export const LIMITS = {
  maxMessageBytes: 4 * 1024 * 1024,
  maxStrokePoints: 20000,
  maxLayers: 100,
  maxLayerName: 64,
  maxPeerName: 32,
  maxBrushSize: 1000,
  maxCoord: 1e8,
} as const;

/** Unambiguous alphabet for session codes: no 0/O, 1/I/L. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}$/;

export function normalizeCode(input: string): string | null {
  const raw = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (raw.length !== 8) return null;
  const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
  return CODE_RE.test(code) ? code : null;
}
