// Index all 0x06 textures (id, width, height, format) → verification/texture-index.json
// Reusable artifact for icon/texture hunts. Usage: npx tsx tools/index-textures.ts
import * as fs from 'fs';
import { DatDatabase } from '../../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../../packages/dat-parser/src/DatReader.js';
import { Texture } from '../../packages/dat-parser/src/file-types/Texture.js';

const db = new DatDatabase(fs.readFileSync('dat/client_portal.dat').buffer as ArrayBuffer);
const ids = db.listFileIds(0x06).sort((a, b) => a - b);
const out: Array<{ id: string; w: number; h: number; fmt: number }> = [];
let fail = 0;
for (const id of ids) {
  try {
    const data = db.getFileData(id);
    if (!data) { fail++; continue; }
    const tex = Texture.read(new DatReader(data));
    out.push({ id: '0x' + (id >>> 0).toString(16).padStart(8, '0'), w: tex.width, h: tex.height, fmt: tex.format });
  } catch { fail++; }
}
fs.writeFileSync('verification/texture-index.json', JSON.stringify(out));
console.log(`indexed ${out.length} textures (${fail} failed) → verification/texture-index.json`);
