// Composite a range of 0x06 textures into labeled grid contact sheets for vision scanning.
// Usage: npx tsx tools/contact-sheet.ts 0x06004c00 0x06004e00 [outdir] [maxDim]
//   - reads verification/texture-index.json to filter the range
//   - writes <outdir>/sheet-NN.png (grid, cell=48px, checkerboard bg) + sheet-manifest.json
//     mapping each grid cell (row,col) -> texture id/dims, in reading order.
import * as fs from 'fs';
import { DatDatabase } from '../../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../../packages/dat-parser/src/DatReader.js';
import { Texture } from '../../packages/dat-parser/src/file-types/Texture.js';
import zlib from 'node:zlib';

function png(width: number, height: number, rgba: Uint8Array): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (width * 4 + 1)] = 0; rgba.subarray(y * width * 4, (y + 1) * width * 4).forEach((v, i) => { raw[y * (width * 4 + 1) + 1 + i] = v; }); }
  const chunks: Buffer[] = [];
  const crcTable = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); let crc = -1; for (const b of body) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8); const crcBuf = Buffer.alloc(4); crcBuf.writeInt32BE((crc ^ -1) | 0); chunks.push(len, body, crcBuf); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  chunk('IHDR', ihdr); chunk('IDAT', zlib.deflateSync(raw)); chunk('IEND', Buffer.alloc(0));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks]);
}

const [startA, endA, outA, maxA] = process.argv.slice(2);
const start = parseInt(startA, 16), end = parseInt(endA, 16);
const outdir = outA && !outA.startsWith('0x') ? outA : '/tmp/sheets';
const maxDim = maxA ? parseInt(maxA, 10) : 64;
fs.mkdirSync(outdir, { recursive: true });
const idx: Array<{ id: string; w: number; h: number }> = JSON.parse(fs.readFileSync('verification/texture-index.json', 'utf8'));
const pick = idx.filter((t) => { const v = parseInt(t.id, 16); return v >= start && v < end && t.w <= maxDim && t.h <= maxDim; });
const db = new DatDatabase(fs.readFileSync('dat/client_portal.dat').buffer as ArrayBuffer);

const CELL = 48, COLS = 16, PER = COLS * 16; // 16x16 cells per sheet
const manifest: Array<{ sheet: number; row: number; col: number; id: string; w: number; h: number }> = [];
for (let s = 0; s * PER < pick.length; s++) {
  const batch = pick.slice(s * PER, (s + 1) * PER);
  const rows = Math.ceil(batch.length / COLS);
  const W = COLS * CELL, H = rows * CELL;
  const buf = new Uint8Array(W * H * 4);
  // magenta background so transparent/edge art stands out
  for (let i = 0; i < W * H; i++) { buf[i * 4] = 255; buf[i * 4 + 1] = 0; buf[i * 4 + 2] = 255; buf[i * 4 + 3] = 255; }
  batch.forEach((t, i) => {
    const row = Math.floor(i / COLS), col = i % COLS;
    manifest.push({ sheet: s, row, col, id: t.id, w: t.w, h: t.h });
    let rgba; try { const d = db.getFileData(parseInt(t.id, 16)); if (!d) return; rgba = Texture.read(new DatReader(d)).toRGBA(); } catch { return; }
    if (!rgba) return;
    const ox = col * CELL + Math.max(0, (CELL - rgba.width) >> 1), oy = row * CELL + Math.max(0, (CELL - rgba.height) >> 1);
    for (let y = 0; y < Math.min(rgba.height, CELL); y++) for (let x = 0; x < Math.min(rgba.width, CELL); x++) {
      const sp = (y * rgba.width + x) * 4, a = rgba.data[sp + 3] / 255; if (a === 0) continue;
      const dp = ((oy + y) * W + (ox + x)) * 4;
      for (let c = 0; c < 3; c++) buf[dp + c] = Math.round(rgba.data[sp + c] * a + buf[dp + c] * (1 - a));
      buf[dp + 3] = 255;
    }
  });
  fs.writeFileSync(`${outdir}/sheet-${String(s).padStart(2, '0')}.png`, png(W, H, buf));
}
fs.writeFileSync(`${outdir}/sheet-manifest.json`, JSON.stringify(manifest, null, 0));
console.log(`${pick.length} textures in [${startA},${endA}) -> ${Math.ceil(pick.length / PER)} sheets in ${outdir} (16 cols, 48px cells, reading order; (row,col) in sheet-manifest.json)`);
