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

/** Brush settings as the UI holds them: no tool or color, and `size` in screen pixels. */
export type BrushSettings = Omit<Brush, 'tool' | 'color'>;

/**
 * A shared brush preset. `creator` identifies who saved it: `u:<user id>` for an account,
 * `a:<first 16 hex of sha256(anonymous secret)>` without one. `creatorName` is the account name,
 * or the display name at save time.
 */
export interface BrushPreset {
  id: string;
  name: string;
  settings: BrushSettings;
  creator: string;
  creatorName: string;
  createdAt: number;
}

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

/**
 * A layer's blend mode. 'pass' (pass through) is for groups only: the group's layers blend with
 * what is below the group, as if they were not grouped. Any other mode makes a group isolated:
 * its layers composite on their own, then the result blends as one layer.
 */
export type LayerBlend = BlendMode | 'pass';

export interface Layer {
  id: string;
  name: string;
  order: number; // fractional index among the layers of the same parent, ascending = bottom to top
  blend: LayerBlend;
  opacity: number;
  visible: boolean;
  deleted: boolean;
  /**
   * 'adjust': no paint of its own; it changes everything below it. 'group': a folder of layers
   * (layers name it as `parent`). 'shape': holds vector shapes (Shape), no strokes except on its
   * mask. Set at creation. Default 'paint'.
   */
  kind?: LayerKind;
  /** The group this layer is in; absent or null: the top level. A deleted group hides its layers. */
  parent?: string | null;
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
  /**
   * A vector stroke: a shape made paint (shapes.toPaint). It draws as that shape, exact at any
   * zoom, in the stroke order of its layer: the eraser and the brush work over it. `pts` are its
   * frame corners (for bounds, transforms and the stroke eraser); `brush` gives its main color.
   */
  vector?: StrokeVector;
}

/** The geometry and style of a shape, kept on a vector stroke. */
export type StrokeVector = Omit<ShapeInput, 'id' | 'layerId' | 'name' | 'z'>;

export const LAYER_KINDS = ['paint', 'adjust', 'group', 'shape'] as const;
export type LayerKind = (typeof LAYER_KINDS)[number];

// --- vector shapes ---------------------------------------------------------------------------

/** Never remove a kind after a release: old documents would break. Add new ones. */
export const SHAPE_KINDS = ['rect', 'ellipse', 'polygon', 'star', 'line', 'path'] as const;
export type ShapeKind = (typeof SHAPE_KINDS)[number];
export const STROKE_ALIGNS = ['center', 'inside', 'outside'] as const;
export type StrokeAlign = (typeof STROKE_ALIGNS)[number];
export const LINE_CAPS = ['butt', 'round', 'square'] as const;
export type LineCap = (typeof LINE_CAPS)[number];
export const LINE_JOINS = ['miter', 'round', 'bevel'] as const;
export type LineJoin = (typeof LINE_JOINS)[number];

/**
 * One contour of a path: its points, POINT_STRIDE numbers each, in local units: the anchor
 * (x, y), the handle toward the previous point (ix, iy), the handle toward the next point
 * (ox, oy), and the point type (PointType). A handle at its anchor is no handle: a segment
 * whose two handles are at their anchors is straight. A closed contour joins its last point
 * to its first.
 */
export interface PathContour {
  closed: boolean;
  pts: number[];
}
export const POINT_STRIDE = 7;
/**
 * corner: the two handles move on their own. smooth: the handles stay on one line (each keeps
 * its length). symmetric: the handles stay on one line with the same length.
 */
export const POINT_TYPES = ['corner', 'smooth', 'symmetric'] as const;
export type PointType = (typeof POINT_TYPES)[number];

/**
 * What a shape op may set. Geometry: a frame of w × h local units, (0, 0) to (w, h), that the
 * affine `m` maps to the world. Moves, rotations and layer transforms change `m` only, so they
 * stay exact; a resize changes the frame. Lengths (radii, rounding, stroke width) are local
 * units, so a layer transform scales them with the shape.
 *
 * Live settings, by kind (shapes stay editable; phase 2 point editing turns them into paths):
 * - rect: `radii`, the corner radii top left, top right, bottom right, bottom left.
 *   `radiiLinked`: the editor changes all four together.
 * - polygon: `sides` (3 to 64). star: `points` (3 to 64) and `innerRatio`, the inner radius as a
 *   fraction of the outer one. Both: `rounding`, a corner radius (each corner gets at most what
 *   fits).
 * - line: `line`, the start and end points (x0, y0, x1, y1) in the frame.
 * - path: `path`, Bezier contours (PathContour). Point editing turns any other kind into a
 *   path. The frame is the box of the curve.
 * The polygon and the star fill the frame: their points are scaled to its width and height.
 */
export interface ShapeProps {
  name: string;
  /** Order within the layer, ascending = bottom to top (a fractional index, as layer `order`). */
  z: number;
  w: number;
  h: number;
  m: Affine;
  radii?: [number, number, number, number];
  radiiLinked?: boolean;
  sides?: number;
  points?: number;
  innerRatio?: number;
  rounding?: number;
  line?: [number, number, number, number];
  path?: PathContour[];
  /** #rrggbb, or null: no fill. Lines have no fill. */
  fill: string | null;
  /** #rrggbb, or null: no stroke. */
  stroke: string | null;
  strokeWidth: number;
  /** Lines and paths with an open contour always stroke on the center. */
  align: StrokeAlign;
  cap: LineCap;
  join: LineJoin;
}

/** What shape.update may change: props, and the kind (to and from a path). */
export type ShapeUpdate = Partial<ShapeProps> & { kind?: ShapeKind };

/** A shape as a client sends it in shape.add and shape.live. */
export type ShapeInput = ShapeProps & { id: string; layerId: string; kind: ShapeKind };

export interface Shape extends ShapeInput {
  /** Who added it. */
  author: string;
  /** Seq of the op that added it. */
  seq: number;
  deleted?: boolean;
}

export type LayerProps = Pick<Layer, 'name' | 'blend' | 'opacity' | 'visible' | 'order' | 'adjust' | 'clip' | 'mask' | 'parent'>;

/** A 2D affine transform [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Affine = [number, number, number, number, number, number];

/** Document features a client must know to draw a canvas right. The server lists them in welcome. */
export const DOC_FEATURES = ['adjust', 'clip', 'mask', 'tips', 'groups', 'shapes', 'paths', 'vectors'] as const;
export type DocFeature = (typeof DOC_FEATURES)[number];

export type Op =
  | { type: 'stroke.add'; stroke: Pick<Stroke, 'id' | 'layerId' | 'brush' | 'pts' | 'mask'> }
  | { type: 'stroke.remove'; id: string }
  | { type: 'stroke.restore'; id: string }
  | { type: 'layer.add'; layer: Pick<Layer, 'id' | 'kind'> & LayerProps }
  | { type: 'layer.update'; id: string; props: Partial<LayerProps> }
  | { type: 'layer.remove'; id: string }
  | { type: 'layer.restore'; id: string }
  /**
   * Moves, scales, rotates or skews a layer, or a group with everything in it: every stroke and
   * shape of those layers (masks included, deleted ones too, so undoing a delete puts them back
   * in place).
   */
  | { type: 'layer.transform'; id: string; m: Affine }
  /** Adds a shape to a shape layer. */
  | { type: 'shape.add'; shape: ShapeInput }
  /**
   * Changes some props of a shape, or its kind (with the settings the new kind needs). The
   * result must be a valid shape of its kind; settings of other kinds are dropped.
   */
  | { type: 'shape.update'; id: string; props: ShapeUpdate }
  | { type: 'shape.remove'; id: string }
  | { type: 'shape.restore'; id: string }
  /**
   * Copies a layer, or a group with everything in it. The copy of the layer (or group) `id` gets
   * `newId`; copies of its layers, strokes and shapes get ids derived from `newId` and the original id
   * (derivedId), so every client makes the same copy. The copy goes into `parent` at `order`.
   */
  | { type: 'layer.duplicate'; id: string; newId: string; name: string; order: number; parent: string | null }
  /**
   * Makes shapes paint: each shape `ids` (live) becomes a vector stroke on the layer `layerId`
   * (id derivedId(key, shape id), in shape order) and is removed. A paint layer takes them; their
   * own shape layer takes them when they are all its shapes, and then becomes a paint layer.
   */
  | { type: 'shapes.toPaint'; key: string; ids: string[]; layerId: string }
  /** The undo of shapes.toPaint (same key, ids, layerId): the strokes go, the shapes come back. */
  | { type: 'shapes.fromPaint'; key: string; ids: string[]; layerId: string };

/** An op as the server broadcasts it: restore ops carry the full object so late joiners can apply them. */
export type AppliedOp =
  | Exclude<Op, { type: 'stroke.add' } | { type: 'stroke.restore' } | { type: 'shape.add' } | { type: 'shape.restore' }>
  | { type: 'stroke.add'; stroke: Stroke }
  | { type: 'stroke.restore'; id: string; stroke: Stroke }
  | { type: 'shape.add'; shape: Shape }
  | { type: 'shape.restore'; id: string; shape: Shape };

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

/** Link preview images: size of the PNG, and the gap between two from the same canvas. */
export const PREVIEW_LIMITS = { width: 1200, height: 630, maxBytes: 1_500_000, minIntervalMs: 60_000 } as const;

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
      /**
       * An embed on another site (/e/CODE): access from the link alone (no account, no
       * anonymous secret), at most view only, and not shown to other people.
       */
      embed?: boolean;
    }
  | { t: 'op'; opId: string; op: Op }
  | { t: 'live'; id: string; layerId: string; mask?: string; brush: Brush; pts: number[]; start: boolean }
  | { t: 'live.end'; id: string }
  /**
   * Shapes as this client shows them during a drag (not persisted): new ones, or changed copies
   * of existing ones. Each message replaces the last; an empty list ends the preview.
   */
  | { t: 'shape.live'; shapes: ShapeInput[] }
  | { t: 'cursor'; x: number | null; y: number | null; layerId: string | null }
  /**
   * Link preview image from an editor's browser: a PNG (base64, at most PREVIEW_LIMITS) of the
   * document at `seq`, framing the world rectangle `frame` (x, y, w, h).
   */
  | { t: 'preview'; png: string; seq: number; frame: [number, number, number, number] }
  | { t: 'ping' };

export type ServerMsg =
  | {
      t: 'welcome';
      clientId: string;
      code: string;
      seq: number;
      layers: Layer[];
      strokes: Stroke[];
      /** Live shapes (not deleted). Absent from servers before shapes. */
      shapes?: Shape[];
      peers: Peer[];
      role: Role;
      canvas: CanvasInfo;
      /** Present after a correct join password: send it as hello.grant next time. */
      grant?: string;
      /** Features the document uses. A client that does not know one asks for an update. */
      features?: string[];
      /** Seq that the stored link preview shows; null: none yet. Editors send a newer one. */
      previewSeq?: number | null;
    }
  /** Role or canvas state changed while connected (claimed, sharing edited). */
  | { t: 'access'; role: Role; canvas: CanvasInfo }
  /** A new link preview is stored (it shows this seq): other editors need not send one. */
  | { t: 'preview.saved'; seq: number }
  /** Join refused or access lost. The server closes the socket after this unless it asks for a password. */
  | { t: 'denied'; reason: DeniedReason }
  | { t: 'op'; seq: number; by: string; opId: string; op: AppliedOp }
  | { t: 'reject'; opId: string; reason: string }
  | { t: 'live'; by: string; id: string; layerId: string; mask?: string; brush: Brush; pts: number[]; start: boolean }
  | { t: 'live.end'; by: string; id: string }
  | { t: 'shape.live'; by: string; shapes: ShapeInput[] }
  | { t: 'cursor'; by: string; x: number | null; y: number | null; layerId: string | null }
  | { t: 'peer.join'; peer: Peer }
  | { t: 'peer.leave'; id: string }
  | { t: 'error'; code: string; message: string }
  | { t: 'pong' };

export const LIMITS = {
  maxMessageBytes: 4 * 1024 * 1024,
  maxStrokePoints: 20000,
  maxLayers: 100,
  /** Groups inside groups, at most. */
  maxGroupDepth: 8,
  maxLayerName: 64,
  maxPeerName: 32,
  /** Brush size in the UI, in screen pixels. */
  maxBrushPx: 1000,
  /** Stroke brush sizes in world units: the screen size divided by the zoom. */
  minBrushWorld: 1e-12,
  maxBrushWorld: 1e15,
  maxCoord: 1e15,
  /** Live shapes per canvas, and shapes in one shape.live message. */
  maxShapes: 20000,
  maxLiveShapes: 200,
  maxShapeName: 64,
  /** Polygon sides and star points. */
  minCorners: 3,
  maxCorners: 64,
  /** Points of all contours of one path, and its contours. */
  maxPathPoints: 5000,
  maxContours: 100,
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
