import { Canvas2DRenderer } from './compositor';
import { GLRenderer } from './gl/glRenderer';
import type { Renderer } from './renderer';

/**
 * WebGL2 when available, else Canvas 2D. Force one with ?renderer=2d|gl in the URL
 * (or localStorage 'draw.renderer') to compare the two.
 */
export function createRenderer(canvas: HTMLCanvasElement): Renderer {
  let force: string | null = new URLSearchParams(location.search).get('renderer');
  try {
    force ??= localStorage.getItem('draw.renderer');
  } catch {
    // ignore
  }
  if (force !== '2d') {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      desynchronized: true,
      powerPreference: 'high-performance',
    });
    if (gl) {
      try {
        return new GLRenderer(canvas, gl);
      } catch (e) {
        console.warn('WebGL2 renderer failed, using Canvas 2D', e);
      }
    }
  }
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('No canvas context available');
  return new Canvas2DRenderer(canvas, ctx);
}
