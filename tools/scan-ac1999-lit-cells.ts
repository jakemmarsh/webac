/**
 * List the 1999 cell.dat's env cells whose static objects carry DAT point lights (BUG.ac1999-point-light-falloff):
 * the places to look at the 1999 point-light falloff in game. One line per cell: cell id, light count,
 * and each light's intensity / falloff.
 *
 *   npx tsx tools/scan-ac1999-lit-cells.ts [datSetDir=dat-sets/ac1999-retail] [maxCells=40] [--eor (an end-of-retail dat/ dir)]
 */
import { resolve } from 'node:path';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { FileDatBytes } from '../packages/dat-parser/src/node/FileDatBytes.js';
import { EnvCell } from '../packages/dat-parser/src/file-types/EnvCell.js';
import { SetupModel } from '../packages/dat-parser/src/file-types/SetupModel.js';
import { transcodeEnvCell1999 } from '../packages/dat-parser/src/era1999/Geometry1999.js';

const dir = resolve(process.argv[2] ?? 'dat-sets/ac1999-retail');
const maxCells = Number(process.argv[3] ?? 40);
// An end-of-retail pair (client_cell_1.dat / client_portal.dat) for comparison: no 1999 transcode.
const eor = process.argv.includes('--eor');
const cellDb = new DatDatabase(new FileDatBytes(resolve(dir, eor ? 'client_cell_1.dat' : 'cell.dat')));
const portalDb = new DatDatabase(new FileDatBytes(resolve(dir, eor ? 'client_portal.dat' : 'portal.dat')));

const setupLights = new Map<number, { intensity: number; falloff: number }[]>();
function lightsOf(setupId: number): { intensity: number; falloff: number }[] {
  let l = setupLights.get(setupId);
  if (l) return l;
  l = [];
  const data = portalDb.getFileData(setupId);
  if (data) {
    try {
      const s = new SetupModel(new DatReader(data));
      for (const li of s.lights.values()) l.push({ intensity: li.intensity, falloff: li.falloff });
    } catch { /* not parseable in this format: skip */ }
  }
  setupLights.set(setupId, l);
  return l;
}

let found = 0;
for (const id of cellDb.listFileIds()) {
  const low = id & 0xffff;
  if (low < 0x100 || low >= 0xfffe) continue;
  const raw = cellDb.getFileData(id);
  if (!raw) continue;
  let cell: EnvCell;
  try { cell = new EnvCell(new DatReader(eor ? raw : transcodeEnvCell1999(raw, id))); } catch { continue; }
  const lights = cell.staticObjects.filter((s) => (s.id >>> 24) === 0x02).flatMap((s) => lightsOf(s.id));
  if (lights.length === 0) continue;
  console.log(`0x${(id >>> 0).toString(16).padStart(8, '0')}  ${lights.length} light(s)  ${lights.map((l) => `I ${l.intensity.toFixed(2)} / F ${l.falloff.toFixed(1)}`).join(', ')}`);
  if (++found >= maxCells) break;
}
console.log(`${found} lit cell(s) listed`);
