// Renders the app icons as PNG with no dependencies (supersampled shapes + zlib).
// Run: node scripts/make-icons.mjs  ->  public/icons/*.png
import fs from 'node:fs';
import zlib from 'node:zlib';

const BG = [38, 38, 38];
const BLUE = [49, 168, 255];
const WHITE = [245, 245, 245];

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function png(size, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Distance from p to a sampled S-curve (the brush stroke in the logo), in unit coordinates.
const CURVE = Array.from({ length: 200 }, (_, i) => {
  const t = i / 199;
  return [0.3 + 0.4 * t, 0.56 + 0.09 * Math.sin(t * Math.PI * 2) - 0.08 * t];
});
function curveDist(x, y) {
  let d = Infinity;
  for (const [cx, cy] of CURVE) d = Math.min(d, Math.hypot(x - cx, y - cy));
  return d;
}

/** full: background fills the square (maskable). Otherwise a rounded square with clear corners. */
function render(size, { full, scale = 1 }) {
  const SS = 4;
  const out = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (px + (sx + 0.5) / SS) / size;
          const v = (py + (sy + 0.5) / SS) / size;
          // Rounded-square background.
          const rad = 0.22;
          const qx = Math.max(Math.abs(u - 0.5) - (0.5 - rad), 0);
          const qy = Math.max(Math.abs(v - 0.5) - (0.5 - rad), 0);
          if (!full && Math.hypot(qx, qy) > rad) continue;
          let c = BG;
          // Content, scaled toward the center (maskable icons need a safe zone).
          const cu = 0.5 + (u - 0.5) / scale;
          const cv = 0.5 + (v - 0.5) / scale;
          if (Math.hypot(cu - 0.5, cv - 0.47) < 0.3) c = BLUE;
          if (curveDist(cu, cv) < 0.045) c = WHITE;
          r += c[0]; g += c[1]; b += c[2]; a += 255;
        }
      }
      const n = SS * SS, o = (py * size + px) * 4;
      const cov = a / 255;
      out[o] = cov ? r / cov : 0;
      out[o + 1] = cov ? g / cov : 0;
      out[o + 2] = cov ? b / cov : 0;
      out[o + 3] = a / n;
    }
  }
  return png(size, out);
}

const dir = new URL('../public/icons/', import.meta.url);
fs.mkdirSync(dir, { recursive: true });
const write = (name, buf) => fs.writeFileSync(new URL(name, dir), buf);
write('icon-192.png', render(192, { full: false }));
write('icon-512.png', render(512, { full: false }));
write('maskable-512.png', render(512, { full: true, scale: 0.8 }));
write('apple-touch-icon.png', render(180, { full: true }));
write('favicon-32.png', render(32, { full: false }));
console.log('icons written to public/icons');
