// What the engine needs from a renderer. Two implementations:
// - GLRenderer: WebGL2, half-float buffers, shader blend modes (preferred)
// - Canvas2DRenderer: Canvas 2D + tile worker, 8-bit (fallback without WebGL2)

import type { Affine, Brush, Layer, Shape, Stroke } from '../../shared/types';
import type { PerfProfile } from './perf';

export interface ViewState {
  x: number; // world coordinate at the left edge of the canvas
  y: number;
  zoom: number; // CSS px per world unit
}

export interface Renderer {
  readonly kind: 'webgl2' | 'canvas2d';
  /** Bits per channel of the internal buffers (16 = half float). */
  readonly precision: 8 | 16;
  /** How much work this device gets (perf.ts). The engine caps the pixel ratio at maxScale. */
  readonly profile: PerfProfile;
  /** Set by the engine: the renderer calls it when panning and zooming run slowly. */
  onSlow: (() => void) | null;
  readonly view: ViewState;
  readonly size: { w: number; h: number };
  destroy(): void;
  resize(cssW: number, cssH: number, dpr: number): void;
  setView(x: number, y: number, zoom: number): void;
  toWorld(cssX: number, cssY: number): [number, number];
  toScreen(wx: number, wy: number): [number, number];
  invalidate(): void;
  /**
   * Draws a frame now, not at the next animation frame. A resize clears the canvas: drawn at
   * once, the blank canvas never reaches the screen (a window resize showed black throughout).
   */
  renderNow(): void;

  setLayers(layers: Layer[]): void;
  resetStrokes(strokes: Stroke[], seq: number): void;
  addStroke(stroke: Stroke, seq: number): void;
  removeStroke(id: string, seq: number): void;
  advanceSeq(seq: number): void;

  /** Committed shapes (live ones), as in the welcome. */
  resetShapes(shapes: Shape[]): void;
  /** A committed shape that is new or changed. A deleted shape is removed. */
  putShape(shape: Shape, seq: number): void;
  removeShape(id: string, seq: number): void;
  /**
   * Shapes as someone edits them (`owner`: 'local' or a peer id), drawn over the committed ones
   * with the same id (deleted: hidden). An empty list ends that owner's drafts. A layer with
   * drafts draws straight to the screen until the edit ends and its tiles catch up.
   */
  setShapeDrafts(owner: string, shapes: Shape[]): void;

  liveBegin(id: string, layerId: string, brush: Brush, remote: boolean): void;
  hasLive(id: string): boolean;
  liveAppend(id: string, pts: number[]): void;
  /** The stroke is in the document at this seq. Its buffer stays until the tiles show it. */
  liveCommit(id: string, seq: number): void;
  liveEnd(id: string): void;
  liveCancel(id: string): void;
  /** Drops remote strokes that stopped without a commit (peer left, op rejected). */
  sweepLive(): void;

  /**
   * Draws the layer or group `p.id` moved by the world transform `p.m` (not applied yet) instead
   * of its tiles: the live preview of a transform. Null clears it.
   */
  setTransformPreview(p: { id: string; m: Affine } | null): void;
  /** The transform is applied: keep the preview until the layer's tiles show it, then drop it. */
  settleTransformPreview(): void;

  /** Composited color under a CSS-pixel position, as #rrggbb. */
  sample(cssX: number, cssY: number): string;
  exportPng(): Promise<Blob | null>;
}
