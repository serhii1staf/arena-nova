// Generates the Tauri icon set (PNG + Windows ICO) with zero image deps.
// The artwork echoes the game: a soft green "sanctuary glow" on a dark field.
//
// Usage: node scripts/gen-icons.mjs
import zlib from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'src-tauri', 'icons');
mkdirSync(outDir, { recursive: true });

// ---- CRC32 (IEEE) ---------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- Artwork --------------------------------------------------------------
function renderRGBA(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const cx = size * 0.5;
  const cy = size * 0.46;
  const glowR = size * 0.34;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // Dark green base with a subtle vertical gradient.
      const vy = y / size;
      let r = 10 + vy * 8;
      let g = 26 + vy * 14;
      let b = 14 + vy * 8;
      // Central soft glow.
      const d = Math.hypot(x - cx, y - cy) / glowR;
      const glow = Math.max(0, 1 - d);
      const gg = glow * glow;
      r += gg * 200;
      g += gg * 240;
      b += gg * 170;
      // Rounded-corner alpha mask for a modern app-icon silhouette.
      const margin = size * 0.06;
      const inx = Math.min(x - margin, size - margin - x);
      const iny = Math.min(y - margin, size - margin - y);
      const edge = Math.min(inx, iny);
      const alpha = Math.max(0, Math.min(1, edge / (size * 0.04)));
      rgba[i] = Math.min(255, r);
      rgba[i + 1] = Math.min(255, g);
      rgba[i + 2] = Math.min(255, b);
      rgba[i + 3] = Math.round(alpha * 255);
    }
  }
  return rgba;
}

function makePng(size) {
  return encodePng(size, size, renderRGBA(size));
}

// ---- ICO (embeds a 256px PNG; supported on Windows Vista+) -----------------
function encodeIco(png256) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // count
  const entry = Buffer.alloc(16);
  entry[0] = 0; // width 256 => 0
  entry[1] = 0; // height 256 => 0
  entry[2] = 0; // palette
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(png256.length, 8); // size
  entry.writeUInt32LE(6 + 16, 12); // offset
  return Buffer.concat([header, entry, png256]);
}

// ---- Emit -----------------------------------------------------------------
const png256 = makePng(256);
const outputs = {
  '32x32.png': makePng(32),
  '128x128.png': makePng(128),
  '128x128@2x.png': png256,
  'icon.png': makePng(512),
  'icon.ico': encodeIco(png256),
};
for (const [name, buf] of Object.entries(outputs)) {
  writeFileSync(join(outDir, name), buf);
  console.log(`  ${name} (${buf.length} bytes)`);
}
console.log(`Icons written to ${outDir}`);
