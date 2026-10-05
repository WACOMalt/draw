// Shape and range checks for untrusted input. Each validator returns a clean copy or throws.

import {
  ADJUST_TYPES,
  BLEND_MODES,
  BRUSH_TIPS,
  GRAINS,
  LIMITS,
  type Adjust,
  type BlendMode,
  type Brush,
  type BrushSettings,
  type LayerMask,
  type LayerProps,
  type Op,
} from './types';

export class ValidationError extends Error {}

function fail(msg: string): never {
  throw new ValidationError(msg);
}

const ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/;

function id(v: unknown, what = 'id'): string {
  if (typeof v !== 'string' || !ID_RE.test(v)) fail(`bad ${what}`);
  return v;
}

function num(v: unknown, min: number, max: number, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) fail(`bad ${what}`);
  return v;
}

function bool(v: unknown, what: string): boolean {
  if (typeof v !== 'boolean') fail(`bad ${what}`);
  return v;
}

function str(v: unknown, max: number, what: string): string {
  if (typeof v !== 'string' || v.length > max) fail(`bad ${what}`);
  return v;
}

function obj(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(`bad ${what}`);
  return v as Record<string, unknown>;
}

export function validateColor(v: unknown): string {
  if (typeof v !== 'string') fail('bad color');
  const c = v.toLowerCase();
  if (!COLOR_RE.test(c)) fail('bad color');
  return c;
}

function oneOf<T extends string>(v: unknown, list: readonly T[], what: string): T {
  if (typeof v !== 'string' || !(list as readonly string[]).includes(v)) fail(`bad ${what}`);
  return v as T;
}

export function validateBrush(v: unknown): Brush {
  const b = obj(v, 'brush');
  if (b.tool !== 'paint' && b.tool !== 'erase') fail('bad brush.tool');
  // Tip and dynamics are optional, and only copied when present: old strokes stay unchanged.
  const extra: Partial<Brush> = {};
  if (b.tip !== undefined) extra.tip = oneOf(b.tip, BRUSH_TIPS, 'brush.tip');
  if (b.angle !== undefined) extra.angle = num(b.angle, 0, 360, 'brush.angle');
  if (b.roundness !== undefined) extra.roundness = num(b.roundness, 0.05, 1, 'brush.roundness');
  if (b.followDirection !== undefined) extra.followDirection = bool(b.followDirection, 'brush.followDirection');
  if (b.sizeJitter !== undefined) extra.sizeJitter = num(b.sizeJitter, 0, 1, 'brush.sizeJitter');
  if (b.angleJitter !== undefined) extra.angleJitter = num(b.angleJitter, 0, 1, 'brush.angleJitter');
  if (b.scatter !== undefined) extra.scatter = num(b.scatter, 0, 4, 'brush.scatter');
  if (b.opacityJitter !== undefined) extra.opacityJitter = num(b.opacityJitter, 0, 1, 'brush.opacityJitter');
  if (b.grain !== undefined) extra.grain = b.grain === null ? null : oneOf(b.grain, GRAINS, 'brush.grain');
  if (b.grainScale !== undefined) extra.grainScale = num(b.grainScale, 0.1, 10, 'brush.grainScale');
  if (b.grainStrength !== undefined) extra.grainStrength = num(b.grainStrength, 0, 1, 'brush.grainStrength');
  return {
    tool: b.tool,
    color: validateColor(b.color),
    size: num(b.size, LIMITS.minBrushWorld, LIMITS.maxBrushWorld, 'brush.size'),
    opacity: num(b.opacity, 0, 1, 'brush.opacity'),
    flow: num(b.flow, 0.001, 1, 'brush.flow'),
    hardness: num(b.hardness, 0, 1, 'brush.hardness'),
    spacing: num(b.spacing, 0.01, 2, 'brush.spacing'),
    pressureSize: bool(b.pressureSize, 'brush.pressureSize'),
    pressureFlow: bool(b.pressureFlow, 'brush.pressureFlow'),
    buildup: bool(b.buildup, 'brush.buildup'),
    ...extra,
  };
}

/** Preset settings: a brush without tool and color, with `size` in screen pixels. */
export function validateBrushSettings(v: unknown): BrushSettings {
  const s = obj(v, 'settings');
  num(s.size, 1, LIMITS.maxBrushPx, 'settings.size');
  const { tool: _t, color: _c, ...settings } = validateBrush({ ...s, tool: 'paint', color: '#000000' });
  return settings;
}

export function validateAdjust(v: unknown): Adjust {
  const a = obj(v, 'adjust');
  const type = oneOf(a.type, ADJUST_TYPES, 'adjust.type');
  const unit = (x: unknown, what: string) => num(x, 0, 1, `adjust.${what}`);
  const signed = (x: unknown, what: string) => num(x, -1, 1, `adjust.${what}`);
  switch (type) {
    case 'levels': {
      const out = {
        type,
        inBlack: unit(a.inBlack, 'inBlack'),
        inWhite: unit(a.inWhite, 'inWhite'),
        gamma: num(a.gamma, 0.1, 10, 'adjust.gamma'),
        outBlack: unit(a.outBlack, 'outBlack'),
        outWhite: unit(a.outWhite, 'outWhite'),
      };
      if (out.inWhite - out.inBlack < 0.004) fail('bad adjust.inWhite');
      return out;
    }
    case 'curves': {
      if (!Array.isArray(a.points) || a.points.length < 2 || a.points.length > 16) fail('bad adjust.points');
      const points = a.points.map((p): [number, number] => {
        if (!Array.isArray(p) || p.length !== 2) fail('bad adjust.points');
        return [unit(p[0], 'points'), unit(p[1], 'points')];
      });
      for (let i = 1; i < points.length; i++) if (points[i][0] <= points[i - 1][0]) fail('bad adjust.points order');
      return { type, points };
    }
    case 'hueSat':
      return {
        type,
        hue: num(a.hue, -180, 180, 'adjust.hue'),
        saturation: signed(a.saturation, 'saturation'),
        lightness: signed(a.lightness, 'lightness'),
      };
    case 'brightContrast':
      return { type, brightness: signed(a.brightness, 'brightness'), contrast: signed(a.contrast, 'contrast') };
  }
}

function layerMask(v: unknown): LayerMask | null {
  if (v === null) return null;
  const m = obj(v, 'mask');
  return { id: id(m.id, 'mask.id'), enabled: bool(m.enabled, 'mask.enabled') };
}

export function validatePoints(v: unknown, minPoints = 1): number[] {
  if (!Array.isArray(v) || v.length % 3 !== 0) fail('bad pts');
  const n = v.length / 3;
  if (n < minPoints || n > LIMITS.maxStrokePoints) fail('bad pts length');
  const out = new Array<number>(v.length);
  for (let i = 0; i < v.length; i += 3) {
    out[i] = num(v[i], -LIMITS.maxCoord, LIMITS.maxCoord, 'pts.x');
    out[i + 1] = num(v[i + 1], -LIMITS.maxCoord, LIMITS.maxCoord, 'pts.y');
    out[i + 2] = num(v[i + 2], 0, 1, 'pts.p');
  }
  return out;
}

function blend(v: unknown): BlendMode {
  if (typeof v !== 'string' || !(BLEND_MODES as readonly string[]).includes(v)) fail('bad blend');
  return v as BlendMode;
}

function layerProps(v: unknown, partial: boolean): Partial<LayerProps> {
  const p = obj(v, 'props');
  const out: Partial<LayerProps> = {};
  if (p.name !== undefined || !partial) out.name = str(p.name, LIMITS.maxLayerName, 'name');
  if (p.blend !== undefined || !partial) out.blend = blend(p.blend);
  if (p.opacity !== undefined || !partial) out.opacity = num(p.opacity, 0, 1, 'opacity');
  if (p.visible !== undefined || !partial) out.visible = bool(p.visible, 'visible');
  if (p.order !== undefined || !partial) out.order = num(p.order, -1e12, 1e12, 'order');
  // Optional for every layer, also at creation.
  if (p.adjust !== undefined) out.adjust = validateAdjust(p.adjust);
  if (p.clip !== undefined) out.clip = bool(p.clip, 'clip');
  if (p.mask !== undefined) out.mask = layerMask(p.mask);
  if (partial && Object.keys(out).length === 0) fail('empty props');
  return out;
}

export function validateOp(v: unknown): Op {
  const o = obj(v, 'op');
  switch (o.type) {
    case 'stroke.add': {
      const s = obj(o.stroke, 'stroke');
      return {
        type: 'stroke.add',
        stroke: {
          id: id(s.id),
          layerId: id(s.layerId, 'layerId'),
          brush: validateBrush(s.brush),
          pts: validatePoints(s.pts),
          ...(s.mask !== undefined ? { mask: id(s.mask, 'mask') } : {}),
        },
      };
    }
    case 'stroke.remove':
    case 'stroke.restore':
    case 'layer.remove':
    case 'layer.restore':
      return { type: o.type, id: id(o.id) };
    case 'layer.add': {
      const l = obj(o.layer, 'layer');
      const kind = l.kind === undefined ? undefined : oneOf(l.kind, ['paint', 'adjust'] as const, 'layer.kind');
      const props = layerProps(l, false) as LayerProps;
      if (kind === 'adjust' && !props.adjust) fail('adjustment layer without adjust');
      return { type: 'layer.add', layer: { id: id(l.id), ...(kind ? { kind } : {}), ...props } };
    }
    case 'layer.update':
      return { type: 'layer.update', id: id(o.id), props: layerProps(o.props, true) };
    default:
      fail('unknown op type');
  }
}

export { id as validateId, num as validateNumber, str as validateString };
