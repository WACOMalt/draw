// Shape and range checks for untrusted input. Each validator returns a clean copy or throws.

import { BLEND_MODES, LIMITS, type BlendMode, type Brush, type LayerProps, type Op } from './types';

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

export function validateBrush(v: unknown): Brush {
  const b = obj(v, 'brush');
  if (b.tool !== 'paint' && b.tool !== 'erase') fail('bad brush.tool');
  return {
    tool: b.tool,
    color: validateColor(b.color),
    size: num(b.size, 0.5, LIMITS.maxBrushSize, 'brush.size'),
    opacity: num(b.opacity, 0, 1, 'brush.opacity'),
    flow: num(b.flow, 0.001, 1, 'brush.flow'),
    hardness: num(b.hardness, 0, 1, 'brush.hardness'),
    spacing: num(b.spacing, 0.01, 2, 'brush.spacing'),
    pressureSize: bool(b.pressureSize, 'brush.pressureSize'),
    pressureFlow: bool(b.pressureFlow, 'brush.pressureFlow'),
    buildup: bool(b.buildup, 'brush.buildup'),
  };
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
      return { type: 'layer.add', layer: { id: id(l.id), ...(layerProps(l, false) as LayerProps) } };
    }
    case 'layer.update':
      return { type: 'layer.update', id: id(o.id), props: layerProps(o.props, true) };
    default:
      fail('unknown op type');
  }
}

export { id as validateId, num as validateNumber, str as validateString };
