// Gaussian blur at any size for the same cost. After glsl-fast-gaussian-blur (Experience Monks):
// a separable blur (one pass across, one down) whose taps fall between two texels, so the GPU's
// bilinear filter reads both with their weights in one fetch. A blur wider than a few pixels
// runs on a smaller image: each halving of the resolution halves the blur in pixels, so the
// kernel never grows past MAX_SIGMA. The result is read back with bilinear filtering.
//
// The renderer gets the smaller image straight from coarser tiles (a "level"), with a margin
// around the view, so pixels just off screen blur in from the edge too (see glRenderer, effect
// frames). Lengths here are pixels of the image being blurred.

/** Largest standard deviation, in pixels of a level, that the kernel blurs in one pass pair. */
export const MAX_SIGMA = 4;
/** Pixels of a level kept around the view: 3 standard deviations, rounded up. */
export const MARGIN = 3 * MAX_SIGMA + 4;
/** Taps per side the shader reads, the center included (KERNEL_TAPS * 2 - 1 fetches). */
export const KERNEL_TAPS = 8;

/**
 * The level to blur at, for a standard deviation of `sigma` pixels at full resolution: k halvings
 * (2^k pixels become one), and what is left of the blur in pixels of that level.
 * `downsampled`: the level comes from halving the image k times with a box filter, which already
 * blurs a little (variance 1/12 px² of the level, summed over the halvings); else it is rendered
 * at that scale from tiles.
 */
export function blurLevel(sigma: number, downsampled: boolean): { k: number; sigma: number } {
  if (!(sigma > MAX_SIGMA)) return { k: 0, sigma: Math.max(0, sigma) };
  const k = Math.ceil(Math.log2(sigma / MAX_SIGMA));
  const s = sigma / 2 ** k;
  const box = downsampled ? (1 - 4 ** -k) / 12 : 0;
  return { k, sigma: Math.sqrt(Math.max(0, s * s - box)) };
}

/**
 * A 1D Gaussian kernel for linear sampling: offsets (in texels) and weights. Index 0 is the
 * center tap; each other tap is read at +offset and −offset. Two neighbor texels i and i + 1
 * merge into one tap at the offset between them that bilinear filtering weighs as they are.
 * n: taps in use (1: no blur).
 */
export function kernel(sigma: number): { n: number; off: Float32Array; w: Float32Array } {
  const off = new Float32Array(KERNEL_TAPS);
  const w = new Float32Array(KERNEL_TAPS);
  if (!(sigma > 0.2)) {
    w[0] = 1;
    return { n: 1, off, w };
  }
  // 2 * (KERNEL_TAPS - 1) texels per side fit.
  const r = Math.min(2 * (KERNEL_TAPS - 1), Math.ceil(3 * sigma));
  const g = (i: number) => Math.exp((-i * i) / (2 * sigma * sigma));
  let sum = g(0);
  for (let i = 1; i <= r; i++) sum += 2 * g(i);
  w[0] = g(0) / sum;
  let n = 1;
  for (let i = 1; i <= r; i += 2) {
    const a = g(i) / sum, b = i + 1 <= r ? g(i + 1) / sum : 0;
    w[n] = a + b;
    off[n] = (i * a + (i + 1) * b) / (a + b);
    n++;
  }
  return { n, off, w };
}
