// Streaming PNG writer: rows go in from the top, compressed data goes out to the sink as it
// is made. Only one zlib stream and one previous row are held in memory.
// RGB (or RGBA with `alpha`), 8 bits per channel, the "Sub" filter on every row (good for drawings, cheap to compute).

import type { Sink } from './sink';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(parts: Uint8Array[]): number {
  let c = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC_TABLE[(c ^ p[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** PNG limit: 2^31 - 1 pixels per side. */
export const PNG_MAX_SIDE = 2 ** 31 - 1;

export class PngWriter {
  private zWriter: WritableStreamDefaultWriter<Uint8Array>;
  private pump: Promise<void>;
  private rowsDone = 0;

  constructor(
    private sink: Sink,
    private width: number,
    private height: number,
    /** Keep the alpha channel (a transparent background): RGBA instead of RGB. */
    private alpha = false,
  ) {
    const cs = new CompressionStream('deflate'); // zlib format, as PNG needs
    this.zWriter = cs.writable.getWriter() as WritableStreamDefaultWriter<Uint8Array>;
    const reader = cs.readable.getReader();
    // Compressed bytes go out as IDAT chunks of up to 1 MB.
    this.pump = (async () => {
      let pending: Uint8Array[] = [];
      let n = 0;
      const flush = async () => {
        if (!n) return;
        const data = new Uint8Array(n);
        let o = 0;
        for (const p of pending) {
          data.set(p, o);
          o += p.length;
        }
        pending = [];
        n = 0;
        await this.chunk('IDAT', data);
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        pending.push(value);
        n += value.length;
        if (n >= 2 ** 20) await flush();
      }
      await flush();
    })();
  }

  private async chunk(type: string, data: Uint8Array): Promise<void> {
    const head = new Uint8Array(8);
    const dv = new DataView(head.buffer);
    dv.setUint32(0, data.length);
    const t = new TextEncoder().encode(type);
    head.set(t, 4);
    const tail = new Uint8Array(4);
    new DataView(tail.buffer).setUint32(0, crc32([t, data]));
    await this.sink.write(head);
    await this.sink.write(data);
    await this.sink.write(tail);
  }

  async begin(): Promise<void> {
    await this.sink.write(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, this.width);
    dv.setUint32(4, this.height);
    ihdr[8] = 8; // bit depth
    ihdr[9] = this.alpha ? 6 : 2; // RGBA or RGB
    await this.chunk('IHDR', ihdr);
  }

  /** `rgba` holds `rows` full rows (width × 4 bytes each); alpha is dropped unless `alpha`. */
  async addRows(rgba: Uint8ClampedArray, rows: number): Promise<void> {
    const w = this.width;
    const ch = this.alpha ? 4 : 3;
    const stride = 1 + w * ch;
    const out = new Uint8Array(stride * rows);
    for (let y = 0; y < rows; y++) {
      const o = y * stride;
      out[o] = 1; // Sub: each byte minus the same channel of the pixel to its left
      let si = y * w * 4;
      let di = o + 1;
      let pr = 0, pg = 0, pb = 0, pa = 0;
      for (let x = 0; x < w; x++, si += 4, di += ch) {
        const r = rgba[si], g = rgba[si + 1], b = rgba[si + 2];
        out[di] = r - pr;
        out[di + 1] = g - pg;
        out[di + 2] = b - pb;
        pr = r;
        pg = g;
        pb = b;
        if (ch === 4) {
          const a = rgba[si + 3];
          out[di + 3] = a - pa;
          pa = a;
        }
      }
    }
    await this.zWriter.ready;
    await this.zWriter.write(out);
    this.rowsDone += rows;
  }

  async end(): Promise<void> {
    if (this.rowsDone !== this.height) throw new Error(`PNG: ${this.rowsDone} of ${this.height} rows`);
    await this.zWriter.close();
    await this.pump;
    await this.chunk('IEND', new Uint8Array(0));
  }
}
