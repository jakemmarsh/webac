/**
 * dump-playscript-entries.ts — what a PhysicsScriptTable plays for given
 * PlayScript enums, hook by hook (CreateParticle emitters, SoundTable
 * sounds, CallPES chains). Used to find retail's own effect for an event
 * before touching an invented one (BUG.invented-portal-burst-and-spell-effects,
 * 2026-09-28): e.g. the teleport Hide / Hidden / UnHide scripts on the human
 * table 0x34000004.
 *
 *   npx tsx tools/dump-playscript-entries.ts <tableHex> <enumHex>[,<enumHex>…]
 *   npx tsx tools/dump-playscript-entries.ts 34000004 74,75,76
 */
import * as fs from 'fs';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { PhysicsScript, PhysicsScriptTable } from '../packages/dat-parser/src/file-types/PhysicsScript.js';
import { AnimationHookType } from '../packages/dat-parser/src/file-types/AnimationHook.js';
import { PlayScript } from '../packages/shared/src/enums/PlayScript.js';

const portal = new DatDatabase(new Uint8Array(fs.readFileSync('dat/client_portal.dat')).buffer);
const hex = (n: number) => '0x' + (n >>> 0).toString(16).padStart(8, '0');
const tableId = parseInt(process.argv[2] ?? '34000004', 16) >>> 0;
const enums = (process.argv[3] ?? '74,75,76').split(',').map((s) => parseInt(s, 16));

function describe(sid: number, depth: number, seen: Set<number>): void {
  const pad = '  '.repeat(depth);
  const d = portal.getFileData(sid);
  if (!d) { console.log(`${pad}(missing ${hex(sid)})`); return; }
  const s = PhysicsScript.read(new DatReader(d));
  console.log(`${pad}script ${hex(sid)}: ${s.steps.length} steps`);
  for (const st of s.steps) {
    const h = st.hook as unknown as Record<string, unknown> & { hookType: number };
    const name = AnimationHookType[h.hookType] ?? h.hookType;
    const rest = Object.entries(h).filter(([k]) => k !== 'hookType' && k !== 'direction')
      .map(([k, v]) => `${k}=${typeof v === 'number' && v > 0xffff ? hex(v) : JSON.stringify(v)}`).join(' ');
    console.log(`${pad}  t=${st.startTime.toFixed(2)} ${name} ${rest}`);
    const pes = (h as { pes?: number }).pes;
    if (pes && !seen.has(pes) && depth < 3) { seen.add(pes); describe(pes, depth + 2, seen); }
  }
}

const data = portal.getFileData(tableId);
if (!data) throw new Error(`no table ${hex(tableId)}`);
const table = PhysicsScriptTable.read(new DatReader(data));
for (const e of enums) {
  const entries = table.scripts.get(e);
  console.log(`\n${PlayScript[e] ?? e} (0x${e.toString(16)}) on ${hex(tableId)}: ${entries ? entries.map((x) => `${hex(x.scriptId)}@${x.mod}`).join(', ') : 'NO ENTRY'}`);
  for (const x of entries ?? []) describe(x.scriptId, 1, new Set());
}
