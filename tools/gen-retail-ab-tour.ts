// gen-retail-ab-tour.ts — export the retail A/B world tour from the ACE world
// DB into tools/retail-ab-tour.json (read by tools/retail-ab-scenes.ts).
//
// The tour is data, not a hand-picked list: every town point of interest
// (ACE's points_of_interest, what @telepoi resolves) and one drop point per
// dungeon landblock (the Destination of each portal weenie whose name says
// Dungeon and whose destination is an interior cell). Each becomes a
// fixed-heading frame in both clients, so building placement, terrain and
// dungeon geometry are compared across the world, not at two spots.
//
//   npx tsx tools/gen-retail-ab-tour.ts          (needs the ACE world DB — ace-db container or the cloud MariaDB — and dat/)
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.ts';
import { FileDatBytes } from '../packages/dat-parser/src/node/FileDatBytes.ts';
import { datCellLookup, retailFindEnvCell } from './lib/retail-find-cell.ts';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'retail-ab-tour.json');
// POIs that are utility destinations, not places (hotels, storage, the town network hub).
const NOT_PLACES = new Set(['Hotel', 'Hotel Swank', 'HotelSwank', 'Swank', 'Night Club', 'NightClub', 'Storage', 'Marketplace',
  'TN', 'Town Network', 'TownNetwork', 'Underground']);
const MAX_DUNGEONS = 14;
/**
 * Drop points ACE rejects even though the cell exists. A player teleported
 * there is never spawned and stays hidden in the teleport state, which blocks
 * every later teleport, so one bad point wedges the rest of a run.
 */
const ACE_REJECTS: Record<string, string> = {
  'Advocate Dungeon': "AddWorldObjectInternal: couldn't spawn at 0x018A017F [180 -90 0.005], then LoginComplete NRE (ACE log, 2026-10-02)",
};
const datPath = (f: string): string => join(dirname(fileURLToPath(import.meta.url)), '..', 'dat', f);
const cellDat = new DatDatabase(new FileDatBytes(datPath('client_cell_1.dat')));
const findCell = datCellLookup(cellDat, new DatDatabase(new FileDatBytes(datPath('client_portal.dat'))));

/** The ACE database: the Docker container on Jake's Mac, a local MariaDB in the cloud stack (provision-ace-stack.sh). */
const sql = (q: string): string[][] => {
  const opts = { encoding: 'utf8' as const, stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'] };
  let out: string;
  try { out = execFileSync('docker', ['exec', 'ace-db', 'mysql', '-uroot', '-p1999asheron2017', '-N', '-B', '-e', q], opts); }
  catch { out = execFileSync('mysql', ['-N', '-B', '-e', q], opts); }
  return out.trim().split('\n').filter(Boolean).map((l) => l.split('\t'));
};

const towns = sql('select name from ace_world.points_of_interest order by name').map(([n]) => n).filter((n) => !NOT_PLACES.has(n));
const skipped: string[] = [];

const rows = sql(`select s.value, p.obj_Cell_Id, p.origin_X, p.origin_Y, p.origin_Z, p.angles_W, p.angles_X, p.angles_Y, p.angles_Z
  from ace_world.weenie w
  join ace_world.weenie_properties_position p on p.object_Id = w.class_Id and p.position_Type = 2
  join ace_world.weenie_properties_string s on s.object_Id = w.class_Id and s.type = 1
  where w.type = 7 and (p.obj_Cell_Id & 65535) >= 256 and s.value like '%Dungeon%'
  order by s.value`);
const seen = new Set();
const dungeons: { name: string; teleloc: string; unplaceable?: string }[] = [];
for (const [name, cell, x, y, z, w, qx, qy, qz] of rows) {
  const lb = Number(cell) >>> 16;
  if (seen.has(lb) || /\(Area \d+\)/.test(name)) continue;   // one per landblock
  const label = name.replace(/ Portal$/, '');
  // The EoL cell.dat must hold the destination cell (Ogham Dungeon's 0x0272029A is absent).
  if (!cellDat.hasFile(Number(cell) >>> 0)) { skipped.push(`${label}: cell 0x${(Number(cell) >>> 0).toString(16)} not in cell.dat`); continue; }
  if (ACE_REJECTS[label]) { skipped.push(`${label}: ${ACE_REJECTS[label]}`); continue; }
  seen.add(lb);
  // Retail must be able to place the point (CPhysicsObj::AdjustPosition →
  // find_visible_child_cell: the named cell or its stab list). Crater Caves'
  // and Soul-Fearing Vestry's destinations name a cell the point is not in,
  // and retail drew an all-black world there (HARNESS.retail-ab-dark-dungeons).
  const placed = retailFindEnvCell(Number(cell) >>> 0, { x: Number(x), y: Number(y), z: Number(z) }, findCell);
  const f = (v: string): number => Number(Number(v).toFixed(4));
  dungeons.push({
    name: label,
    teleloc: `@teleloc 0x${(Number(cell) >>> 0).toString(16).toUpperCase().padStart(8, '0')} [${f(x)} ${f(y)} ${f(z)}] ${f(w)} ${f(qx)} ${f(qy)} ${f(qz)}`,
    ...(placed.kind === 'none' || placed.kind === 'outside'
      ? { unplaceable: placed.kind === 'none' ? placed.reason : 'adjusts to outside' } : {}),
  });
}
// Spread the picks across the list rather than taking the alphabetical head.
// An unplaceable pick gives way to the next placeable dungeon after it, so
// the other picks (and their retail frames) stay put.
const step = Math.max(1, Math.floor(dungeons.length / MAX_DUNGEONS));
const chosen = new Set<number>();
for (let i = 0; i < dungeons.length && chosen.size < MAX_DUNGEONS; i += step) {
  let j = i;
  while (j < dungeons.length && (dungeons[j].unplaceable || chosen.has(j) || (j !== i && j % step === 0))) j++;
  if (j < dungeons.length) chosen.add(j);
}
for (const d of dungeons) if (d.unplaceable) skipped.push(`${d.name}: retail cannot place the drop point (${d.unplaceable})`);
const picked = [...chosen].sort((a, b) => a - b).map((i) => ({ name: dungeons[i].name, teleloc: dungeons[i].teleloc }));

writeFileSync(OUT, JSON.stringify({
  generated: new Date().toISOString().slice(0, 10),
  source: 'ace_world.points_of_interest + portal weenie Destination positions (tools/gen-retail-ab-tour.ts)',
  skipped,
  towns,
  dungeons: picked,
}, null, 2) + '\n');
console.log(`wrote ${OUT}: ${towns.length} towns, ${picked.length} dungeons (of ${dungeons.length}); skipped: ${skipped.join('; ') || 'none'}`);
