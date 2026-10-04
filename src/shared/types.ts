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
  size: number; // diameter in world units (screen px / zoom when the stroke started)
  opacity: number; // 0..1, cap for the whole stroke
  flow: number; // 0..1, alpha of a single dab
  hardness: number; // 0..1
  spacing: number; // fraction of the diameter
  pressureSize: boolean;
  pressureFlow: boolean;
  buildup: boolean; // airbrush: zero-length segments emit dabs
  // Tip and dynamics. All optional: a stroke without them is a round, plain brush.
  tip?: BrushTip; // default 'round'
  angle?: number; // degrees, 0..360
  roundness?: number; // 0.05..1: the tip squashed along its height
  followDirection?: boolean; // the tip turns with the stroke direction (added to angle)
  sizeJitter?: number; // 0..1: random size reduction per dab
  angleJitter?: number; // 0..1: random turn per dab, as a fraction of 360°
  scatter?: number; // 0..4: random offset across the stroke, in diameters
  opacityJitter?: number; // 0..1: random flow reduction per dab
  grain?: GrainId | null; // paper texture in stroke space
  grainScale?: number; // 0.1..10: grain cell size, in brush diameters
  grainStrength?: number; // 0..1
}

/** Built-in brush tips. Never change one after a release: old strokes would change. Add new IDs. */
export const BRUSH_TIPS = ['round', 'square', 'chalk', 'charcoal', 'bristle', 'splatter', 'pencil'] as const;
export type BrushTip = (typeof BRUSH_TIPS)[number];

/** Built-in grain textures (same rule as BRUSH_TIPS). */
export const GRAINS = ['paper', 'canvas', 'noise'] as const;
export type GrainId = (typeof GRAINS)[number];

export const ADJUST_TYPES = ['levels', 'curves', 'hueSat', 'brightContrast'] as const;
export type AdjustType = (typeof ADJUST_TYPES)[number];

/** The settings of an adjustment layer. All values work on 0..1 color channels. */
export type Adjust =
  | { type: 'levels'; inBlack: number; inWhite: number; gamma: number; outBlack: number; outWhite: number }
  /** Master curve: 2 to 16 points [in, out], in ascending order of `in`. */
  | { type: 'curves'; points: [number, number][] }
  /** hue in degrees (-180..180), saturation and lightness -1..1. */
  | { type: 'hueSat'; hue: number; saturation: number; lightness: number }
  | { type: 'brightContrast'; brightness: number; contrast: number };

export const DEFAULT_ADJUST: Record<AdjustType, Adjust> = {
  levels: { type: 'levels', inBlack: 0, inWhite: 1, gamma: 1, outBlack: 0, outWhite: 1 },
  curves: { type: 'curves', points: [[0, 0], [1, 1]] },
  hueSat: { type: 'hueSat', hue: 0, saturation: 0, lightness: 0 },
  brightContrast: { type: 'brightContrast', brightness: 0, contrast: 0 },
};

/**
 * A layer mask: strokes with `mask: id` on the layer. They paint grey on a white mask: black
 * hides the layer, white shows it. A new mask gets a new id, so the strokes of a deleted mask
 * stay out of a later one, and undo of the delete brings them back.
 */
export interface LayerMask {
  id: string;
  enabled: boolean;
}

export interface Layer {
  id: string;
  name: string;
  order: number; // fractional index, ascending = bottom to top
  blend: BlendMode;
  opacity: number;
  visible: boolean;
  deleted: boolean;
  /** 'adjust': no paint of its own; it changes everything below it. Set at creation. Default 'paint'. */
  kind?: 'paint' | 'adjust';
  adjust?: Adjust;
  /** Clipped to the nearest layer below that is not clipped (the base of the clipping group). */
  clip?: boolean;
  mask?: LayerMask | null;
}

export interface Stroke {
  id: string;
  layerId: string;
  seq: number; // z-order within the layer
  author: string;
  brush: Brush;
  pts: number[]; // flat x, y, pressure triples in world units
  deleted?: boolean;
  /** Set on a mask stroke: the id of the layer mask it paints (Layer.mask.id). */
  mask?: string;
}

export type LayerProps = Pick<Layer, 'name' | 'blend' | 'opacity' | 'visible' | 'order' | 'adjust' | 'clip' | 'mask'>;

/** Document features a client must know to draw a canvas right. The server lists them in welcome. */
export const DOC_FEATURES = ['adjust', 'clip', 'mask', 'tips'] as const;
export type DocFeature = (typeof DOC_FEATURES)[number];

export type Op =
  | { type: 'stroke.add'; stroke: Pick<Stroke, 'id' | 'layerId' | 'brush' | 'pts' | 'mask'> }
  | { type: 'stroke.remove'; id: string }
  | { type: 'stroke.restore'; id: string }
  | { type: 'layer.add'; layer: Pick<Layer, 'id' | 'kind'> & LayerProps }
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

export type Role = 'owner' | 'editor' | 'viewer';

/** What a client knows about the canvas it joined. */
export interface CanvasInfo {
  key: string;
  /** Owned by an account. False: temporary (deleted at expiresAt) or created before accounts. */
  owned: boolean;
  ownerName: string | null;
  /** Epoch ms when a temporary canvas is deleted. Null for owned and legacy canvases. */
  expiresAt: number | null;
  /** This browser created the temporary canvas and may claim it by logging in. */
  canClaim: boolean;
}

export type DeniedReason = 'no_access' | 'login_required' | 'password_required' | 'password_wrong' | 'expired' | 'deleted';

export type ClientMsg =
  | {
      t: 'hello';
      name: string;
      color: string;
      /** Anonymous secret of this browser: proves who created a temporary canvas. */
      anon?: string;
      /** Bearer session token (desktop app; the web app uses its cookie). */
      token?: string;
      /** Share link token (?k=). */
      link?: string;
      password?: string;
      /** Proof of an earlier correct join password, from welcome.grant. */
      grant?: string;
    }
  | { t: 'op'; opId: string; op: Op }
  | { t: 'live'; id: string; layerId: string; mask?: string; brush: Brush; pts: number[]; start: boolean }
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
      role: Role;
      canvas: CanvasInfo;
      /** Present after a correct join password: send it as hello.grant next time. */
      grant?: string;
      /** Features the document uses. A client that does not know one asks for an update. */
      features?: string[];
    }
  /** Role or canvas state changed while connected (claimed, sharing edited). */
  | { t: 'access'; role: Role; canvas: CanvasInfo }
  /** Join refused or access lost. The server closes the socket after this unless it asks for a password. */
  | { t: 'denied'; reason: DeniedReason }
  | { t: 'op'; seq: number; by: string; opId: string; op: AppliedOp }
  | { t: 'reject'; opId: string; reason: string }
  | { t: 'live'; by: string; id: string; layerId: string; mask?: string; brush: Brush; pts: number[]; start: boolean }
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
  /** Brush size in the UI, in screen pixels. */
  maxBrushPx: 1000,
  /** Stroke brush sizes in world units: the screen size divided by the zoom. */
  minBrushWorld: 1e-12,
  maxBrushWorld: 1e15,
  maxCoord: 1e15,
} as const;

/** Unambiguous alphabet for session codes: no 0/O, 1/I/L. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}$/;

/** Named sessions: lowercase letters, digits and single dashes, 3 to 40 characters. */
export const NAME_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,39}$/;

/** Turns user input like "Friday Jam!" into a session name ("friday-jam"), or null. */
export function normalizeName(input: string): string | null {
  const name = input
    .trim()
    .toLowerCase()
    .replace(/[\s_.]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  // A name in code format would be confusing, and codes are reserved for random sessions.
  if (!NAME_RE.test(name) || CODE_RE.test(name.toUpperCase())) return null;
  return name;
}

/** Strict parse of a session key from a URL or the WebSocket query: a code (XXXX-XXXX) or a name. */
export function parseKey(raw: string): string | null {
  const upper = raw.toUpperCase();
  if (CODE_RE.test(upper)) return upper;
  return NAME_RE.test(raw) ? raw : null;
}

/** Loose parse of what a person typed into a join field: every key it could mean, codes first. */
export function candidateKeys(input: string): string[] {
  return [normalizeCode(input), normalizeName(input)].filter((k): k is string => k !== null);
}

export function normalizeCode(input: string): string | null {
  const raw = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (raw.length !== 8) return null;
  const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
  return CODE_RE.test(code) ? code : null;
}
