// scripts/make-icon.mjs
// Generates build/icon.png — a 512x512 Moss brand mark (dark rounded tile with a
// green moss dot). No image deps: emits a PNG by hand via zlib. Re-run to tweak.

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

const SIZE = 512;
const RADIUS = 104; // rounded-corner radius
const BG = [0x0b, 0x0b, 0x0f]; // app background
const DOT = [0x3f, 0xb9, 0x50]; // moss green
const DOT_HI = [0x56, 0xd3, 0x64]; // highlight

const cx = SIZE / 2;
const cy = SIZE / 2;
const dotR = 150;
const hiCx = cx - 44;
const hiCy = cy - 44;
const hiR = 150;

function insideRoundedTile(x, y) {
  // distance into each corner's rounding circle
  const rx = x < RADIUS ? RADIUS - x : x > SIZE - RADIUS ? x - (SIZE - RADIUS) : 0;
  const ry = y < RADIUS ? RADIUS - y : y > SIZE - RADIUS ? y - (SIZE - RADIUS) : 0;
  return rx * rx + ry * ry <= RADIUS * RADIUS;
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
let p = 0;
for (let y = 0; y < SIZE; y++) {
  raw[p++] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    let r = BG[0];
    let g = BG[1];
    let b = BG[2];
    let a = 255;
    if (!insideRoundedTile(x, y)) {
      a = 0;
    } else {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= dotR * dotR) {
        const hx = x - hiCx;
        const hy = y - hiCy;
        const hi = hx * hx + hy * hy <= hiR * hiR;
        r = hi ? DOT_HI[0] : DOT[0];
        g = hi ? DOT_HI[1] : DOT[1];
        b = hi ? DOT_HI[2] : DOT[2];
      }
    }
    raw[p++] = r;
    raw[p++] = g;
    raw[p++] = b;
    raw[p++] = a;
  }
}

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
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(body), 0);
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

mkdirSync("build", { recursive: true });
writeFileSync("build/icon.png", png);
console.log(`Wrote build/icon.png (${png.length} bytes, ${SIZE}x${SIZE})`);
