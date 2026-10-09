// Tiled TIFF writer: 256 × 256 tiles, RGB (or RGBA with unassociated alpha) 8 bits, Deflate with the horizontal predictor.
// Tiles go to the sink as they are made, in any order; the directory (IFD) with every tile's
// offset goes at the end, and the header is patched to point to it.
// Classic TIFF has 32-bit offsets (files up to 4 GB). Past that it is BigTIFF (64-bit offsets),
// which GIMP (2.10.32+), Photoshop, Krita, libtiff and GDAL read.

import type { Sink } from './sink';

export const TIFF_TILE = 256;
/** Uncompressed size above which the file is BigTIFF, with room for the directory. */
const CLASSIC_LIMIT = 4 * 2 ** 30 - 64 * 2 ** 20;
/** TIFF limit: 2^32 - 1 pixels per side. */
export const TIFF_MAX_SIDE = 2 ** 32 - 1;

/** Classic TIFF is enough when even the uncompressed image fits in 4 GB. */
export function needsBigTiff(width: number, height: number, alpha = false): boolean {
  return width * height * (alpha ? 4 : 3) > CLASSIC_LIMIT;
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

export class TiffWriter {
  readonly big: boolean;
  readonly tilesX: number;
  readonly tilesY: number;
  private offsets: number[];
  private counts: number[];

  constructor(
    private sink: Sink,
    private width: number,
    private height: number,
    /** Keep the alpha channel (a transparent background): RGBA instead of RGB. */
    private alpha = false,
  ) {
    this.big = needsBigTiff(width, height, alpha);
    this.tilesX = Math.ceil(width / TIFF_TILE);
    this.tilesY = Math.ceil(height / TIFF_TILE);
    const n = this.tilesX * this.tilesY;
    this.offsets = new Array(n).fill(0);
    this.counts = new Array(n).fill(0);
  }

  async begin(): Promise<void> {
    // Header with a zero directory offset; patched in end().
    const h = new Uint8Array(this.big ? 16 : 8);
    const dv = new DataView(h.buffer);
    h[0] = h[1] = 0x49; // "II": little-endian
    if (this.big) {
      dv.setUint16(2, 43, true);
      dv.setUint16(4, 8, true); // offset size
    } else dv.setUint16(2, 42, true);
    await this.sink.write(h);
  }

  /**
   * Adds the tiles inside a piece of the image. The piece starts at a tile corner: (px, py) are
   * multiples of TIFF_TILE. `rgba` is w × h. Tiles at the image edge are padded with the last
   * column and row.
   */
  async addPiece(rgba: Uint8ClampedArray, px: number, py: number, w: number, h: number): Promise<void> {
    const T = TIFF_TILE;
    const compressed: { index: number; data: Promise<Uint8Array> }[] = [];
    for (let ty = 0; ty * T < h; ty++) {
      for (let tx = 0; tx * T < w; tx++) {
        const ch = this.alpha ? 4 : 3;
        const tile = new Uint8Array(T * T * ch);
        for (let y = 0; y < T; y++) {
          const sy = Math.min(h - 1, ty * T + y);
          let di = y * T * ch;
          for (let x = 0; x < T; x++, di += ch) {
            const sx = Math.min(w - 1, tx * T + x);
            const si = (sy * w + sx) * 4;
            tile[di] = rgba[si];
            tile[di + 1] = rgba[si + 1];
            tile[di + 2] = rgba[si + 2];
            if (ch === 4) tile[di + 3] = rgba[si + 3];
          }
          // Predictor 2: each byte minus the same channel to its left, right to left.
          const row = y * T * ch;
          for (let i = row + T * ch - 1; i >= row + ch; i--) tile[i] = (tile[i] - tile[i - ch]) & 255;
        }
        const index = (py / T + ty) * this.tilesX + (px / T + tx);
        compressed.push({ index, data: deflate(tile) });
      }
    }
    // Compress in parallel, write in order.
    for (const c of compressed) {
      const data = await c.data;
      this.offsets[c.index] = this.sink.size;
      this.counts[c.index] = data.length;
      await this.sink.write(data);
      if (this.sink.size % 2) await this.sink.write(new Uint8Array(1)); // word alignment
    }
  }

  async end(): Promise<void> {
    const big = this.big;
    const n = this.offsets.length;
    if (this.offsets.some((o, i) => o === 0 && this.counts[i] === 0)) throw new Error('TIFF: missing tiles');
    // Arrays that do not fit in an entry go before the directory.
    const longs = (vals: number[]) => {
      const b = new Uint8Array(vals.length * (big ? 8 : 4));
      const dv = new DataView(b.buffer);
      vals.forEach((v, i) => (big ? dv.setBigUint64(i * 8, BigInt(v), true) : dv.setUint32(i * 4, v, true)));
      return b;
    };
    const inline = big ? 8 : 4;
    const place = async (b: Uint8Array): Promise<number> => {
      const at = this.sink.size;
      await this.sink.write(b);
      if (this.sink.size % 2) await this.sink.write(new Uint8Array(1));
      return at;
    };
    const ch = this.alpha ? 4 : 3;
    const bits = new Uint8Array(ch * 2).map((_, i) => (i % 2 ? 0 : 8));
    const software = new TextEncoder().encode('Draw (draw.bsums.xyz)\0');
    const res = new Uint8Array([72, 0, 0, 0, 1, 0, 0, 0]); // 72/1
    const offsetsAt = n * inline > inline ? await place(longs(this.offsets)) : -1;
    const countsAt = n * inline > inline ? await place(longs(this.counts)) : -1;
    const bitsAt = bits.length > inline ? await place(bits) : -1;
    const softwareAt = await place(software);
    const resAt = res.length > inline ? await place(res) : -1;

    const SHORT = 3, LONG = 4, RATIONAL = 5, ASCII = 2, LONG8 = 16;
    const offType = big ? LONG8 : LONG;
    type Entry = [tag: number, type: number, count: number, value: number | Uint8Array];
    const entries: Entry[] = [
      [256, LONG, 1, this.width],
      [257, LONG, 1, this.height],
      [258, SHORT, ch, bitsAt >= 0 ? bitsAt : bits],
      [259, SHORT, 1, 8], // Deflate
      [262, SHORT, 1, 2], // RGB
      [277, SHORT, 1, ch],
      [282, RATIONAL, 1, resAt >= 0 ? resAt : res],
      [283, RATIONAL, 1, resAt >= 0 ? resAt : res],
      [284, SHORT, 1, 1], // chunky
      [296, SHORT, 1, 2], // inches
      [305, ASCII, software.length, softwareAt],
      [317, SHORT, 1, 2], // horizontal predictor
      [322, SHORT, 1, TIFF_TILE],
      [323, SHORT, 1, TIFF_TILE],
      [324, offType, n, offsetsAt >= 0 ? offsetsAt : longs(this.offsets)],
      [325, offType, n, countsAt >= 0 ? countsAt : longs(this.counts)],
      ...(this.alpha ? [[338, SHORT, 1, 2] as Entry] : []), // ExtraSamples: unassociated alpha
    ];
    const entrySize = big ? 20 : 12;
    const ifd = new Uint8Array((big ? 8 : 2) + entries.length * entrySize + (big ? 8 : 4));
    const dv = new DataView(ifd.buffer);
    if (big) dv.setBigUint64(0, BigInt(entries.length), true);
    else dv.setUint16(0, entries.length, true);
    let o = big ? 8 : 2;
    for (const [tag, type, count, value] of entries) {
      dv.setUint16(o, tag, true);
      dv.setUint16(o + 2, type, true);
      if (big) dv.setBigUint64(o + 4, BigInt(count), true);
      else dv.setUint32(o + 4, count, true);
      const vo = o + (big ? 12 : 8);
      if (value instanceof Uint8Array) ifd.set(value, vo); // small data, in the entry itself
      else if (isOffset(type, count, inline) || type === LONG8) {
        // An offset to data placed before the directory (or one 64-bit value).
        if (big) dv.setBigUint64(vo, BigInt(value), true);
        else dv.setUint32(vo, value, true);
      } else if (type === SHORT) dv.setUint16(vo, value, true);
      else dv.setUint32(vo, value, true);
      o += entrySize;
    }
    // Next directory: none (already zero).
    const ifdAt = this.sink.size;
    await this.sink.write(ifd);

    const head = new Uint8Array(big ? 8 : 4);
    const hv = new DataView(head.buffer);
    if (big) hv.setBigUint64(0, BigInt(ifdAt), true);
    else hv.setUint32(0, ifdAt, true);
    await this.sink.patch(big ? 8 : 4, head);
  }
}

/** True when an entry's value field holds an offset to data elsewhere (the data is too large). */
function isOffset(type: number, count: number, inline: number): boolean {
  const size: Record<number, number> = { 2: 1, 3: 2, 4: 4, 5: 8, 16: 8 };
  return (size[type] ?? 4) * count > inline;
}
