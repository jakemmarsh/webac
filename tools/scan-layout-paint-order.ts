/**
 * scan-layout-paint-order.ts — list every LayoutDesc (0x21xxxxxx) whose
 * overlapping sibling elements paint in a different order under the retail
 * rule (BUG.layout-zlevel-semantics-inverted) than under the old
 * zLevel-as-CSS-z-index rendering. Use it to pick the screens to verify
 * side by side after touching the paint order.
 *
 * Usage: npx tsx tools/scan-layout-paint-order.ts [--art-only] [0x21000005 ...]
 *   --art-only  only pairs where BOTH elements draw image media of their own
 */
import * as fs from 'fs';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import {
  parseLayoutDesc, parseMasterProperty, resolveLayoutDesc, setMasterPropertyTypes,
  type LayoutDescData,
} from '../packages/dat-parser/src/file-types/LayoutDesc.js';
import { scanLayoutPaintOrderFlips } from './layout-paint-order-lib.js';

const args = process.argv.slice(2);
const artOnly = args.includes('--art-only');
const only = args.filter((a) => a.startsWith('0x')).map((a) => parseInt(a, 16));

const portal = new DatDatabase(fs.readFileSync('dat/client_portal.dat').buffer as ArrayBuffer);
const lang = new DatDatabase(fs.readFileSync('dat/client_local_English.dat').buffer as ArrayBuffer);
setMasterPropertyTypes(parseMasterProperty(portal.getReader(0x39000001)));

const cache = new Map<number, LayoutDescData | null>();
const load = (id: number): LayoutDescData | null => {
  if (!cache.has(id)) {
    const d = lang.getFileData(id);
    cache.set(id, d ? parseLayoutDesc(new DatReader(d)) : null);
  }
  return cache.get(id)!;
};

const hex = (n: number) => `0x${(n >>> 0).toString(16).padStart(8, '0')}`;
const ids = only.length ? only : lang.listFileIds(0x21).sort((a, b) => a - b);
for (const id of ids) {
  const raw = load(id);
  if (!raw) continue;
  let flips = scanLayoutPaintOrderFlips(id, resolveLayoutDesc(raw, load));
  if (artOnly) flips = flips.filter((f) => f.back.hasArt && f.front.hasArt);
  if (!flips.length) continue;
  console.log(`${hex(id)}: ${flips.length} flipped overlapping pair(s)`);
  for (const f of flips) {
    const e = (x: typeof f.back) => `${hex(x.id)} z${x.zLevel} r${x.readOrder}${x.hasArt ? ' art' : ''}`;
    console.log(`  parent ${f.parentId ? hex(f.parentId) : '(top)'}: retail back ${e(f.back)}  |  retail front ${e(f.front)}`);
  }
}
