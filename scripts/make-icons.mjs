/**
 * Generate icon16/48/128 PNGs with zero dependencies (built-in zlib only).
 * Draws a dark rounded-square background with a light crescent moon.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'icons');

// --- minimal PNG encoder ----------------------------------------------------
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const body = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter type 0
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = deflateSync(raw);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- draw -------------------------------------------------------------------
function draw(size) {
  const buf = Buffer.alloc(size * size * 4);
  const bg = [15, 27, 45, 255]; // #0f1b2d
  const moon = [125, 211, 252, 255]; // #7dd3fc
  const r = size * 0.22; // corner radius
  const cx = size * 0.52,
    cy = size * 0.48,
    R = size * 0.30; // main moon disc
  const ox = cx + size * 0.12,
    oy = cy - size * 0.05,
    OR = size * 0.26; // cut-out disc

  const inRounded = (x, y) => {
    const dx = Math.min(x, size - 1 - x);
    const dy = Math.min(y, size - 1 - y);
    if (dx >= r || dy >= r) return true;
    return (r - dx) ** 2 + (r - dy) ** 2 <= r * r;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      let col = [0, 0, 0, 0];
      if (inRounded(x + 0.5, y + 0.5)) {
        col = bg;
        const inMoon = (x - cx) ** 2 + (y - cy) ** 2 <= R * R;
        const inCut = (x - ox) ** 2 + (y - oy) ** 2 <= OR * OR;
        if (inMoon && !inCut) col = moon;
      }
      buf[i] = col[0];
      buf[i + 1] = col[1];
      buf[i + 2] = col[2];
      buf[i + 3] = col[3];
    }
  }
  return encodePNG(size, size, buf);
}

for (const size of [16, 48, 128]) {
  writeFileSync(join(OUT, `icon${size}.png`), draw(size));
  console.log(`icons/icon${size}.png`);
}
