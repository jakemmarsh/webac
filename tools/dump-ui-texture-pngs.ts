// Dump UI textures from portal.dat as PNGs for visual inspection.
// Usage: npx tsx tools/dump-ui-texture-pngs.ts 0x06004cc2 0x0600111f ... [outdir]
import * as fs from 'fs';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { Texture } from '../packages/dat-parser/src/file-types/Texture.js';
import zlib from 'node:zlib';

function pngFromRGBA(width: number, height: number, rgba: Uint8Array): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.subarray(y * width * 4, (y + 1) * width * 4).forEach((v, i) => { raw[y * (width * 4 + 1) + 1 + i] = v; });
  }
  const chunks: Buffer[] = [];
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crcTable = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
    let crc = -1; for (const b of body) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
    const crcBuf = Buffer.alloc(4); crcBuf.writeInt32BE((crc ^ -1) | 0);
    chunks.push(len, body, crcBuf);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  chunk('IHDR', ihdr);
  chunk('IDAT', zlib.deflateSync(raw));
  chunk('IEND', Buffer.alloc(0));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks]);
}

const portalBuf = fs.readFileSync('dat/client_portal.dat').buffer;
const portalDb = new DatDatabase(portalBuf as ArrayBuffer);
const argv = process.argv.slice(2);
const outdir = argv[argv.length - 1].startsWith('0x') ? '/tmp/ui-tex' : argv.pop()!;
fs.mkdirSync(outdir, { recursive: true });
for (const arg of argv) {
  const id = parseInt(arg, 16);
  const data = portalDb.getFileData(id);
  if (!data) { console.log(`${arg}: NOT FOUND`); continue; }
  const tex = Texture.read(new DatReader(data));
  const rgba = tex.toRGBA();
  if (!rgba) { console.log(`${arg}: no RGBA`); continue; }
  const out = `${outdir}/${arg}.png`;
  fs.writeFileSync(out, pngFromRGBA(rgba.width, rgba.height, rgba.data));
  console.log(`${arg}: ${rgba.width}x${rgba.height} -> ${out}`);
}
