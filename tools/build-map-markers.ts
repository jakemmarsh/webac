/**
 * UtilityBelt's Landscape Maps markers and dungeon names (docs/vtank-parity-gaps.md §11.7; UtilityBelt is MIT,
 * ported from 5fe9825a, Lib/Maps/LandscapeMarkers.cs and Lib/Dungeon/Dungeon.cs). UB ships them as CSV
 * exports of the end-of-retail world (mapdata/*.csv, dungeons.csv). Here each era gets its own, from its own
 * world data and cell.dat, so a portal, vendor or lifestone shows only where that era has one:
 *
 *   end of retail  world-db-raw/ACE-World-16PY SQL, overlaid by ACE-World-16PY-Patches; dat/client_cell_1.dat
 *   AC1999         reference/ac1999/Server/Database/AC1999-World (the same layout); dat-sets/ac1999-retail/cell.dat
 *   Dark Majesty   the ClassicACE CustomDM world in its MySQL container; dat-sets/classicace-customdm-1.60
 *
 * Markers (UB's MarkerType): Lifestone (WeenieType 25), Vendor (12), NPC (a creature that can't be attacked),
 * Portal (7) and Dungeon (a portal into a dungeon: UB IsDungeon, an interior cell that isn't SeenOutside),
 * each where the world places one (landblock_instance) on the landscape or in a building. UB's town and
 * outpost list (its towns.csv, below) is kept for an era only where that era has a lifestone, vendor or NPC
 * within 2.0 of it. Dungeon names come from the portals into each dungeon (UB's "Portal to " and " Portal"
 * dropped, the most common name wins), in place of UB's dungeons.csv.
 *
 *   npx tsx tools/build-map-markers.ts [eol|ac1999|dm ...]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'packages/renderer/src/ui/maps/markers');

/** UB's towns.csv (name, type, NS, EW), as shipped at 5fe9825a. */
export const UB_TOWNS: ReadonlyArray<[string, 'Town' | 'Outpost', number, number]> = [
  ['Ahurenga', 'Town', 47.1, -90.3], ['Al-Arqas', 'Town', -31.1, 13.7], ['Al-Jalima', 'Town', 7.4, 4.8], ['Arwic', 'Town', 33.5, 56.8],
  ['Ayan Baqur', 'Town', -59.9, -87.9], ['Baishi', 'Town', -49.5, 62.5], ['Bandit Castle', 'Outpost', 66.4, 50], ['Beach Fort Outpost', 'Outpost', 76, -49],
  ['Bluespire', 'Town', 39.2, -75.2], ['Candeth Keep', 'Town', -87.5, -67.2], ['Colier', 'Town', 56.7, 38.4], ['Cragstone', 'Town', 25.7, 48.7],
  ['Crater Lake Village', 'Town', 64.9, 13.4], ["Danby's Outpost", 'Town', 23.3, -28.7], ['Dryreach', 'Town', -8.1, 73.1], ['East Lytelthorpe Outpost', 'Outpost', 0.9, 54.2],
  ['East Nanto Outpost', 'Outpost', -52.5, 85.4], ['East Rithwic Outpost', 'Outpost', 10.3, 61.5], ['East Samsur Outpost', 'Outpost', -3.2, 22.2], ['East Yaraq Outpost', 'Outpost', -21.4, 1.2],
  ['Eastham', 'Town', 17.5, 63.4], ['Eastwatch Outpost', 'Outpost', 90.3, -43.1], ['Fiun Outpost', 'Outpost', 95.9, -56.9], ['Fort Tethana', 'Town', 1.5, -72],
  ['Frost Haven', 'Town', -68.6, 25.4], ["Gharu'ndim Outpost", 'Outpost', 19.8, -3.2], ['Glenden Wood', 'Town', 29.7, 27.2], ['Greenspire', 'Town', 43, -66.9],
  ['Hebian-to', 'Town', -39.1, 83.2], ['Holtburg', 'Town', 42.3, 33.6], ['Kara', 'Town', -83, 47.1], ['Khayyaban', 'Town', -47.5, 24.8],
  ['Kryst', 'Town', -74.3, 84.5], ['Lin', 'Town', -54.6, 73.2], ['Linvak Tukal', 'Town', -77.8, 28], ['Lytelthorpe', 'Town', 0.6, 51.2],
  ["MacNiall's Freehold", 'Town', -73.9, 92.3], ['Mayoi', 'Town', -61.6, 82], ['Merwart Village', 'Town', 79.9, 59.1], ['Mountain Retreat', 'Outpost', 59.8, -4.2],
  ['Nanto', 'Town', -52.6, 81.9], ['Neydisa Castle', 'Outpost', 69.5, 17.5], ['North Al-Arqas Outpost', 'Outpost', -28.2, 13.9], ['North Nanto Outpost', 'Outpost', -49.1, 81.7],
  ['North Yanshi Outpost', 'Outpost', -9.9, 46.7], ['North Yaraq Outpost', 'Outpost', -18.7, -1.6], ['Northwest Samsur Outpost', 'Outpost', 0.1, 16.3], ['Oolutanga`s Refuge', 'Town', 2.3, 95.4],
  ['Plateau Village', 'Town', 44.2, -43.4], ["Qalaba'r", 'Town', -74.4, 19.3], ['Redspire', 'Town', 40.7, -83.1], ['Rithwic', 'Town', 10.6, 58.3],
  ['Samsur', 'Town', -2.9, 19.5], ['Sanamar', 'Town', 72, -60.9], ['Sawato', 'Town', -28.7, 59.3], ['Shoushi', 'Town', -33.5, 72.8],
  ['Silyun', 'Town', 87.2, -70.5], ['South Holtburg Outpost', 'Outpost', 39.5, 33.3], ['South Rithwic Outpost', 'Outpost', 7.5, 58.3], ['South Yanshi Outpost', 'Outpost', -15.7, 46.4],
  ['Southast Shoushi Outpost', 'Outpost', -36.6, 75.9], ['Stonehold', 'Town', 68.8, -21.5], ['Timaru', 'Town', 44.3, -78.1], ['Tou-Tou', 'Town', -28.1, 95.7],
  ['Tufa', 'Town', -14.2, 5.4], ['Uziz', 'Town', -25.5, 28.2], ['Wai Jhou', 'Town', -61.8, -51.3], ['West Al-Arqas Outpost', 'Outpost', -31.3, 10.7],
  ['West Holtburg Outpost', 'Outpost', 42.3, 30.7], ['West Lytelthorpe Outpost', 'Outpost', 1, 48.3], ['West Shoushi Outpost', 'Outpost', -33.6, 69.8], ['Westwatch Outpost', 'Outpost', 72.8, -73.3],
  ['Xarabydun', 'Town', -41.9, 16.2], ['Yanshi (Old)', 'Town', -12.7, 46.4], ['Yanshi (Rebuilt)', 'Town', -12.1, 42.4], ['Yaraq', 'Town', -21.5, -1.6],
  ['Zaikhal', 'Town', 13.7, 0.6],
];

/** One marker row: [type letter, name, NS, EW]. L lifestone, V vendor, N NPC, P portal, D dungeon portal, T town, O outpost. */
export type MarkerRow = [string, string, number, number];

/** A weenie this table cares about. */
export interface MapWeenie { wcid: number; kind: 'L' | 'V' | 'N' | 'P'; name: string; dest?: number }
/** A placed object: weenie class, cell, landblock-local x / y. */
export type Placement = [number, number, number, number];

/** WeenieType (ACE WeenieType.cs): Portal 7, Creature 10, Vendor 12, LifeStone 25. */
const KIND_OF_TYPE: Record<number, 'P' | 'N' | 'V' | 'L'> = { 7: 'P', 10: 'N', 12: 'V', 25: 'L' };

/** UB Geometry.LandblockToNS / LandblockToEW. */
export const cellToNS = (cell: number, y: number): number => ((y / 24) + ((cell >>> 16) & 0xff) * 8 - 1019.5) / 10;
export const cellToEW = (cell: number, x: number): number => ((x / 24) + ((cell >>> 24) & 0xff) * 8 - 1019.5) / 10;

/** UB's portal-name trim (TrackedObject: "Portal to " and " Portal" removed). */
export const trimPortalName = (n: string): string => n.replace('Portal to ', '').replace(' Portal', '');

function valuesOf(text: string, table: string): string {
  return new RegExp('INSERT INTO `' + table + '` \\([^)]*\\)\\s*VALUES ([\\s\\S]*?);\\s*(?:\\n|$)').exec(text)?.[1] ?? '';
}
function rowsOf(text: string, table: string): string[][] {
  const out: string[][] = [];
  for (const r of valuesOf(text, table).replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\(([^()]*)\)/g)) out.push(r[1]!.split(',').map((v) => v.trim()));
  return out;
}
const num = (s: string | undefined): number => (s && /^0x/i.test(s) ? parseInt(s, 16) : Number(s));

/** ACE-layout weenie SQL → the map's view of it, or null when it isn't a lifestone, vendor, NPC or portal. */
export function parseMapWeenieSql(text: string): MapWeenie | null {
  const w = /INSERT INTO `weenie` \([^)]*\)\s*VALUES \((\d+), *'(?:[^'\\]|\\.|'')*', *(\d+)/.exec(text);
  if (!w) return null;
  const kind = KIND_OF_TYPE[Number(w[2])];
  if (!kind) return null;
  const name = /\(\d+, *1, *'((?:[^'\\]|\\.|'')*)'\)/.exec(valuesOf(text, 'weenie_properties_string'))?.[1]?.replace(/\\'|''/g, "'");
  if (!name) return null;
  if (kind === 'N') {
    const ints = new Map(rowsOf(text, 'weenie_properties_int').map((r) => [Number(r[1]), Number(r[2])]));
    if (((ints.get(1) ?? 0) & 0x10) === 0) return null;
    const bools = new Map(rowsOf(text, 'weenie_properties_bool').map((r) => [Number(r[1]), r[2]]));
    if (!/^false$/i.test(bools.get(19) ?? '')) return null; // Attackable: a monster, not an NPC
  }
  const out: MapWeenie = { wcid: Number(w[1]), kind, name };
  if (kind === 'P') {
    const dest = rowsOf(text, 'weenie_properties_position').find((r) => Number(r[1]) === 2);
    if (dest) out.dest = num(dest[2]) >>> 0;
  }
  return out;
}

/** The landblock_instance rows of one landblock SQL file: [wcid, cell, x, y]. */
export function parseLandblockSql(text: string): Placement[] {
  const out: Placement[] = [];
  for (const m of text.matchAll(/VALUES \((0x[0-9A-F]+), *(\d+), *(0x[0-9A-F]+), *(-?[\d.eE+-]+), *(-?[\d.eE+-]+)/gi)) {
    out.push([Number(m[2]), parseInt(m[3]!, 16) >>> 0, Number(m[4]), Number(m[5])]);
  }
  return out;
}

/**
 * The era's markers and dungeon names. `seenOutside(cell)` reads the cell's EnvCell flags (null: no such
 * cell); an interior cell that isn't SeenOutside is a dungeon (UB Dungeon.IsDungeon).
 */
export function buildMapTable(weenies: MapWeenie[], placements: Placement[], seenOutside: (cell: number) => boolean | null): { m: MarkerRow[]; d: Array<[string, string]> } {
  const byWcid = new Map(weenies.map((w) => [w.wcid, w]));
  const isDungeonCell = (cell: number): boolean => (cell & 0xffff) >= 0x100 && seenOutside(cell) === false;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const markers: MarkerRow[] = [];
  const names = new Map<number, Map<string, number>>();
  const seen = new Set<string>();
  for (const [wcid, cell, x, y] of placements) {
    const w = byWcid.get(wcid);
    if (!w || isDungeonCell(cell)) continue;
    let kind: string = w.kind;
    let name = w.name;
    if (w.kind === 'P') {
      name = trimPortalName(w.name);
      if (w.dest && isDungeonCell(w.dest)) {
        kind = 'D';
        const lb = w.dest >>> 16;
        const counts = names.get(lb) ?? new Map<string, number>();
        counts.set(name, (counts.get(name) ?? 0) + 1);
        names.set(lb, counts);
      }
    }
    const row: MarkerRow = [kind, name, r2(cellToNS(cell, y)), r2(cellToEW(cell, x))];
    const key = row.join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    markers.push(row);
  }
  const people = markers.filter((m) => m[0] === 'L' || m[0] === 'V' || m[0] === 'N');
  for (const [name, type, ns, ew] of UB_TOWNS) {
    if (people.some((p) => Math.hypot(p[2] - ns, p[3] - ew) <= 2)) markers.push([type === 'Town' ? 'T' : 'O', name, ns, ew]);
  }
  markers.sort((a, b) => (a[0] + a[1] < b[0] + b[1] ? -1 : a[0] + a[1] > b[0] + b[1] ? 1 : a[2] - b[2] || a[3] - b[3]));
  const dungeons: Array<[string, string]> = [...names].map(([lb, counts]) => {
    const best = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]![0];
    return [lb.toString(16).toUpperCase().padStart(4, '0'), best];
  });
  dungeons.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return { m: markers, d: dungeons };
}

function sqlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...sqlFiles(p));
    else if (p.endsWith('.sql')) out.push(p);
  }
  return out;
}

/** Later trees replace earlier ones' files: weenies by class id, landblocks by file name. */
function overlay(trees: string[][], key: (f: string) => string | null): string[] {
  const m = new Map<string, string>();
  for (const files of trees) for (const f of files) { const k = key(f); if (k) m.set(k, f); }
  return [...m.values()];
}

const WEENIE_DIRS = ['LifeStone', 'Portal', 'Vendor', 'Creature'];

function fromSqlTree(roots: Array<{ weenies: string; landblocks: string }>): { weenies: MapWeenie[]; placements: Placement[] } {
  const wfiles = overlay(roots.map((r) => WEENIE_DIRS.flatMap((d) => sqlFiles(join(r.weenies, d)))), (f) => /^(\d+) /.exec(basename(f))?.[1] ?? null);
  const lfiles = overlay(roots.map((r) => sqlFiles(r.landblocks)), (f) => basename(f).toUpperCase());
  return {
    weenies: wfiles.flatMap((f) => { const w = parseMapWeenieSql(readFileSync(f, 'utf8')); return w ? [w] : []; }),
    placements: lfiles.flatMap((f) => parseLandblockSql(readFileSync(f, 'utf8'))),
  };
}

function fromClassicAce(): { weenies: MapWeenie[]; placements: Placement[] } {
  const pw = execFileSync('docker', ['exec', 'classicace-db', 'printenv', 'MYSQL_ROOT_PASSWORD'], { encoding: 'utf8' }).trim();
  const sql = (q: string): string[][] => execFileSync('docker', ['exec', 'classicace-db', 'mysql', '-uroot', `-p${pw}`, '-N', '-B', 'ace_world_customdm', '-e', q], { encoding: 'utf8', maxBuffer: 256 << 20 })
    .trim().split('\n').filter(Boolean).map((l) => l.split('\t'));
  // Plain single-table reads joined here (joins on the property tables run for minutes there).
  const types = new Map(sql('SELECT class_Id, type FROM weenie WHERE type IN (7, 10, 12, 25)').map(([id, t]) => [id!, Number(t)]));
  const creature = new Set(sql('SELECT object_Id FROM weenie_properties_int WHERE type = 1 AND (value & 16) <> 0').map(([id]) => id!));
  const unattackable = new Set(sql('SELECT object_Id FROM weenie_properties_bool WHERE type = 19 AND value = 0').map(([id]) => id!));
  const names = new Map(sql('SELECT object_Id, value FROM weenie_properties_string WHERE type = 1').map(([id, v]) => [id!, v!]));
  const dests = new Map(sql('SELECT object_Id, obj_Cell_Id FROM weenie_properties_position WHERE position_Type = 2').map(([id, c]) => [id!, Number(c) >>> 0]));
  const weenies: MapWeenie[] = [];
  for (const [id, t] of types) {
    const kind = KIND_OF_TYPE[t]!;
    const name = names.get(id);
    if (!name) continue;
    if (kind === 'N' && !(creature.has(id) && unattackable.has(id))) continue;
    weenies.push({ wcid: Number(id), kind, name, ...(kind === 'P' && dests.has(id) ? { dest: dests.get(id)! } : {}) });
  }
  const placements = sql('SELECT weenie_Class_Id, obj_Cell_Id, origin_X, origin_Y FROM landblock_instance')
    .map(([w, c, x, y]) => [Number(w), Number(c) >>> 0, Number(x), Number(y)] as Placement);
  return { weenies, placements };
}

async function seenOutsideReader(cellPath: string, era: string): Promise<(cell: number) => boolean | null> {
  const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase.ts');
  const { FileDatBytes } = await import('../packages/dat-parser/src/node/FileDatBytes.ts');
  const { DatReader } = await import('../packages/dat-parser/src/DatReader.ts');
  const { EnvCell } = await import('../packages/dat-parser/src/file-types/EnvCell.ts');
  const db = new DatDatabase(new FileDatBytes(cellPath));
  if (era === 'ac1999') {
    const { ac1999CellOverlay } = await import('../packages/dat-parser/src/era1999/Ac1999Overlay.ts');
    db.setOverlay(ac1999CellOverlay());
  }
  const cache = new Map<number, boolean | null>();
  return (cell) => {
    if (cache.has(cell)) return cache.get(cell)!;
    let v: boolean | null = null;
    try {
      const d = db.getFileData(cell >>> 0);
      if (d) v = (new EnvCell(new DatReader(d)).flags & 0x01) !== 0;
    } catch { v = null; }
    cache.set(cell, v);
    return v;
  };
}

async function write(era: string, src: { weenies: MapWeenie[]; placements: Placement[] }, cellPath: string): Promise<void> {
  const table = buildMapTable(src.weenies, src.placements, await seenOutsideReader(cellPath, era));
  writeFileSync(join(OUT, `${era}.ts`), `// Generated by tools/build-map-markers.ts from this era's world data and cell.dat; do not edit.\n// {m: [type, name, NS, EW][], d: [landblock, dungeon name][]}\nexport default ${JSON.stringify(JSON.stringify(table))};\n`);
  const count = (t: string) => table.m.filter((r) => r[0] === t).length;
  console.log(`${era}: ${table.m.length} markers (L ${count('L')}, V ${count('V')}, N ${count('N')}, P ${count('P')}, D ${count('D')}, T ${count('T')}, O ${count('O')}), ${table.d.length} dungeon names`);
}

// Run only as a script (tests import the parsers without regenerating anything).
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename);
const want = process.argv.slice(2);
const eras = !isMain ? [] : want.length ? want : ['eol', 'ac1999', 'dm'];
for (const era of eras) {
  if (era === 'eol') {
    await write('eol', fromSqlTree([
      { weenies: join(ROOT, 'world-db-raw/ACE-World-16PY/Database/3-Core/9 WeenieDefaults/SQL'), landblocks: join(ROOT, 'world-db-raw/ACE-World-16PY/Database/3-Core/6 LandBlockExtendedData') },
      { weenies: join(ROOT, 'world-db-raw/ACE-World-16PY-Patches/Database/Patches/9 WeenieDefaults'), landblocks: join(ROOT, 'world-db-raw/ACE-World-16PY-Patches/Database/Patches/6 LandBlockExtendedData') },
    ]), join(ROOT, 'dat/client_cell_1.dat'));
  } else if (era === 'ac1999') {
    const base = join(ROOT, 'reference/ac1999/Server/Database/AC1999-World/3-Core');
    await write('ac1999', fromSqlTree([{ weenies: join(base, '9 WeenieDefaults/SQL'), landblocks: join(base, '6 LandBlockExtendedData/SQL') }]), join(ROOT, 'dat-sets/ac1999-retail/cell.dat'));
  } else if (era === 'dm') {
    await write('dm', fromClassicAce(), join(ROOT, 'dat-sets/classicace-customdm-1.60/client_cell_1.dat'));
  }
}
