/**
 * VISUAL.dat-static-default-scripts — census of the DAT statics (LandBlockInfo
 * objects + EnvCell stabs) in one landblock whose Setup carries a
 * DefaultScript, and what each script's hooks do (retail
 * CPhysicsObj::InitDefaults @ 005139d0 plays it for every physics object).
 *
 *   npx tsx tools/dump-static-default-scripts.ts [landblockHex=01F6]
 */
import * as fs from 'fs';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { SetupModel } from '../packages/dat-parser/src/file-types/SetupModel.js';
import { PhysicsScript } from '../packages/dat-parser/src/file-types/PhysicsScript.js';
import { LandblockInfo } from '../packages/dat-parser/src/file-types/LandblockInfo.js';
import { EnvCell } from '../packages/dat-parser/src/file-types/EnvCell.js';
import { AnimationHookType } from '../packages/dat-parser/src/file-types/AnimationHook.js';

const portal = new DatDatabase(new Uint8Array(fs.readFileSync('dat/client_portal.dat')).buffer);
const cell = new DatDatabase(new Uint8Array(fs.readFileSync('dat/client_cell_1.dat')).buffer);
const lb = parseInt(process.argv[2] ?? '01F6', 16);
const prefix = (lb << 16) >>> 0;

const counts = new Map<number, number>();
const add = (id: number) => { if ((id >>> 24) === 0x02) counts.set(id, (counts.get(id) ?? 0) + 1); };
const infoData = cell.getFileData((prefix | 0xfffe) >>> 0);
const info = infoData ? new LandblockInfo(new DatReader(infoData)) : null;
for (const o of info?.objects ?? []) add(o.id);
for (let i = 0; i < (info?.numCells ?? 0); i++) {
  const d = cell.getFileData((prefix | (0x100 + i)) >>> 0);
  if (!d) continue;
  for (const s of new EnvCell(new DatReader(d)).staticObjects) add(s.id);
}
const hex = (n: number) => '0x' + (n >>> 0).toString(16).padStart(8, '0');
const describe = (sid: number, depth = 0): string[] => {
  const d = portal.getFileData(sid);
  if (!d) return [`${'  '.repeat(depth)}(missing ${hex(sid)})`];
  const s = PhysicsScript.read(new DatReader(d));
  return s.steps.map(st => {
    const h = st.hook as unknown as Record<string, unknown> & { hookType: number };
    const name = AnimationHookType[h.hookType] ?? h.hookType;
    const extra = Object.entries(h).filter(([k]) => k !== 'hookType' && k !== 'direction')
      .map(([k, v]) => `${k}=${typeof v === 'number' && v > 0xffff ? hex(v) : JSON.stringify(v)}`).join(' ');
    return `${'  '.repeat(depth)}t=${st.startTime.toFixed(2)} ${name} ${extra}`;
  });
};
console.log(`landblock ${lb.toString(16)}: ${info?.objects.length ?? 0} landblock objects, ${info?.numCells ?? 0} cells`);
for (const [id, n] of [...counts].sort((a, b) => b[1] - a[1])) {
  const sd = portal.getFileData(id);
  if (!sd) continue;
  const setup = new SetupModel(new DatReader(sd));
  if (!setup.defaultScript) continue;
  console.log(`${hex(id)} x${n} lights=${setup.lights.size} DefaultScript ${hex(setup.defaultScript)}`);
  for (const line of describe(setup.defaultScript, 1)) console.log(line);
}
