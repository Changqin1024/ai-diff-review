// Generates media/icon.png (128x128) for the extension listing.
// Run: node scripts/make-icon.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = 128;
const SS = 4;
const S = OUT * SS;

const TOP = [76, 111, 255];
const BOTTOM = [122, 90, 248];
const WHITE = [255, 255, 255];

function sdRoundBox(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

const BG = { cx: 64, cy: 64, hw: 64, hh: 64, r: 28 };
const SHAPES = [
  { cx: 64, cy: 64, hw: 1.5, hh: 36, r: 1.5, a: 0.45 }, // divider
  { cx: 38, cy: 42, hw: 18, hh: 3, r: 3, a: 0.95 },
  { cx: 34, cy: 60, hw: 14, hh: 3, r: 3, a: 0.95 },
  { cx: 36, cy: 78, hw: 16, hh: 3, r: 3, a: 0.95 },
  { cx: 88, cy: 50, hw: 13, hh: 3, r: 3, a: 0.95 }, // plus horizontal
  { cx: 88, cy: 50, hw: 3, hh: 11, r: 3, a: 0.95 }, // plus vertical
  { cx: 88, cy: 82, hw: 13, hh: 3, r: 3, a: 0.95 }, // minus
];

const rgba = Buffer.alloc(OUT * OUT * 4);

for (let y = 0; y < OUT; y++) {
  for (let x = 0; x < OUT; x++) {
    let pr = 0;
    let pg = 0;
    let pb = 0;
    let pa = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const px = x + (sx + 0.5) / SS;
        const py = y + (sy + 0.5) / SS;
        if (sdRoundBox(px, py, BG.cx, BG.cy, BG.hw, BG.hh, BG.r) >= 0) {
          continue;
        }
        const t = py / OUT;
        let r = TOP[0] + (BOTTOM[0] - TOP[0]) * t;
        let g = TOP[1] + (BOTTOM[1] - TOP[1]) * t;
        let b = TOP[2] + (BOTTOM[2] - TOP[2]) * t;
        for (const s of SHAPES) {
          if (sdRoundBox(px, py, s.cx, s.cy, s.hw, s.hh, s.r) < 0) {
            r = r + (WHITE[0] - r) * s.a;
            g = g + (WHITE[1] - g) * s.a;
            b = b + (WHITE[2] - b) * s.a;
          }
        }
        pr += r;
        pg += g;
        pb += b;
        pa += 1;
      }
    }
    const n = SS * SS;
    const i = (y * OUT + x) * 4;
    if (pa > 0) {
      rgba[i] = Math.round(pr / pa);
      rgba[i + 1] = Math.round(pg / pa);
      rgba[i + 2] = Math.round(pb / pa);
      rgba[i + 3] = Math.round((pa / n) * 255);
    }
  }
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(OUT, 0);
ihdr.writeUInt32BE(OUT, 4);
ihdr[8] = 8;
ihdr[9] = 6;
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const raw = Buffer.alloc((OUT * 4 + 1) * OUT);
for (let y = 0; y < OUT; y++) {
  raw[y * (OUT * 4 + 1)] = 0;
  rgba.copy(raw, y * (OUT * 4 + 1) + 1, y * OUT * 4, (y + 1) * OUT * 4);
}

const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const outPath = path.join(__dirname, '..', 'media', 'icon.png');
fs.writeFileSync(outPath, png);
console.log('wrote', outPath, png.length, 'bytes');
