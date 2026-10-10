/**
 * dump-region-lighting — the retail day/night lighting curve, straight from the DAT.
 *
 * WHY: the reference corpus has NO night screenshot (closest is gw_01.jpg, a
 * sunset), so a scene audit judging our night render has no image ground truth.
 * But it does not need one: RegionDesc (0x13000000) carries the actual retail
 * curve the client interpolated — per time-of-day directional brightness and
 * colour, ambient brightness and colour, and fog colour/range. Per CLAUDE.md's
 * "the DAT wins", this outranks any screenshot for lighting, sky and fog.
 *
 * Feed the output to the visual-fidelity-audit scene pass so lighting findings
 * are anchored to real values ("at phase 0.0 the region specifies ambBright
 * 0.08, our night terrain reads far brighter") instead of vibes.
 *
 * Usage:
 *   npx tsx tools/dump-region-lighting.ts            # all day groups
 *   npx tsx tools/dump-region-lighting.ts Sunny      # only groups matching a name
 *   npx tsx tools/dump-region-lighting.ts --at 0.0   # interpolated values at one phase
 */
import * as fs from 'fs';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { RegionDesc } from '../packages/dat-parser/src/file-types/RegionDesc.js';

const argv = process.argv.slice(2);
const atIdx = argv.indexOf('--at');
const atPhase = atIdx >= 0 ? Number(argv[atIdx + 1]) : null;
const nameFilter = argv.filter((a, i) => !a.startsWith('--') && i !== atIdx + 1);

const buf = fs.readFileSync('dat/client_portal.dat').buffer;
const db = new DatDatabase(buf as ArrayBuffer);
const regionData = db.getFileData(0x13000000);
if (!regionData) { console.error('No RegionDesc (0x13000000) in dat/client_portal.dat'); process.exit(1); }
const rd = new RegionDesc(new DatReader(regionData));

/** ARGB uint32 -> #RRGGBB (+alpha when not opaque). */
const hex = (c: number): string => {
  const a = (c >>> 24) & 0xff, r = (c >>> 16) & 0xff, g = (c >>> 8) & 0xff, b = c & 0xff;
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}` +
    (a === 0xff ? '' : ` a=${(a / 255).toFixed(2)}`);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

console.log(`Region: "${rd.regionName}"  —  ${rd.skyInfo?.dayGroups?.length ?? 0} day group(s)`);
console.log('Phase: 0.0 = midnight, 0.25 dawn, 0.5 noon, 0.75 dusk\n');

const groups = (rd.skyInfo?.dayGroups ?? []).filter(
  (g) => !nameFilter.length || nameFilter.some((n) => g.dayName.toLowerCase().includes(n.toLowerCase())),
);

for (const g of groups) {
  console.log(`── "${g.dayName}"  chanceOfOccur=${g.chanceOfOccur}  skyObjects=${g.skyObjects.length}  entries=${g.skyTime.length}`);
  if (atPhase !== null) {
    // Same slot search the renderer uses: last entry whose begin <= phase.
    const st = g.skyTime;
    let i = 0;
    for (let k = 0; k < st.length; k++) if (st[k].begin <= atPhase) i = k;
    const next = st[Math.min(i + 1, st.length - 1)];
    const span = (next.begin - st[i].begin) || 1;
    const t = Math.min(Math.max((atPhase - st[i].begin) / span, 0), 1);
    console.log(`   @${atPhase.toFixed(3)}  dirBright=${lerp(st[i].dirBright, next.dirBright, t).toFixed(4)}` +
      `  ambBright=${lerp(st[i].ambBright, next.ambBright, t).toFixed(4)}` +
      `  dirColor=${hex(st[i].dirColor)}  ambColor=${hex(st[i].ambColor)}` +
      `  fog=${hex(st[i].worldFogColor)} [${st[i].minWorldFog}..${st[i].maxWorldFog}]`);
    continue;
  }
  console.log('   begin   dirBright  ambBright  dirColor    ambColor    fogColor    fogRange       pitch/head');
  for (const s of g.skyTime) {
    console.log(
      `   ${s.begin.toFixed(3)}   ${s.dirBright.toFixed(4).padStart(8)}  ${s.ambBright.toFixed(4).padStart(9)}` +
      `  ${hex(s.dirColor).padEnd(10)}  ${hex(s.ambColor).padEnd(10)}  ${hex(s.worldFogColor).padEnd(10)}` +
      `  ${String(s.minWorldFog).padStart(5)}..${String(s.maxWorldFog).padEnd(6)}` +
      `  ${s.dirPitch.toFixed(1)}/${s.dirHeading.toFixed(1)}`,
    );
  }
  console.log('');
}
