// Dump the portal-space landblocks' (0x526A-0x526C) cell layout: origins,
// rotations, portal connectivity, and static objects. Used to design the
// PortalSpaceRenderer camera path through the real EnvCell tunnel (VISUAL.2).
import * as fs from 'fs';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { EnvCell } from '../packages/dat-parser/src/file-types/EnvCell.js';

const cellBuf = fs.readFileSync('dat/client_cell_1.dat').buffer;
const cellDb = new DatDatabase(cellBuf as ArrayBuffer);

for (const lb of [0x526A, 0x526B, 0x526C]) {
  const prefix = lb << 16;
  console.log(`\n== landblock 0x${lb.toString(16)} ==`);
  for (let i = 0; i < 300; i++) {
    const id = (prefix | (0x0100 + i)) >>> 0;
    const data = cellDb.getFileData(id);
    if (!data) break;
    const c = new EnvCell(new DatReader(data));
    const o = c.position.origin, q = c.position.orientation;
    const stabs = c.staticObjects.map(s => `0x${s.id.toString(16)}@(${s.frame.origin.x.toFixed(1)},${s.frame.origin.y.toFixed(1)},${s.frame.origin.z.toFixed(1)})`).join(' ');
    console.log(`0x${id.toString(16)} env=0x${c.environmentId.toString(16)} struct=${c.cellStructure} pos=(${o.x.toFixed(1)},${o.y.toFixed(1)},${o.z.toFixed(1)}) rot=(${q.w.toFixed(2)},${q.x.toFixed(2)},${q.y.toFixed(2)},${q.z.toFixed(2)}) portals=[${c.cellPortals.map(p=>'0x'+p.otherCellId.toString(16)).join(',')}] stabs=${stabs || '-'}`);
  }
}
