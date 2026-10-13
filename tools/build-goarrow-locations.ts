/**
 * GoArrow's location database, generated per era from that era's own world data and cell.dat
 * (docs/plugin-specs/goarrow.md §5.2). GoArrow's bundled Crossroads of Dereth database has no data licence
 * and is never read. The world sources are build-map-markers.ts's:
 *
 *   end of retail  world-db-raw/ACE-World-16PY SQL, overlaid by ACE-World-16PY-Patches; dat/client_cell_1.dat
 *   AC1999         reference/ac1999/Server/Database/AC1999-World; dat-sets/ac1999-retail/cell.dat (+ the 1999 overlay)
 *   Dark Majesty   the ClassicACE CustomDM world in its MySQL container; dat-sets/classicace-customdm-1.60
 *
 * What it writes (packages/renderer/src/ui/goarrow/locations/<era>.ts; format: shared goarrow/locations.ts
 * GoArrowEraFile):
 *  - locations placed on the landscape or in a building (never inside a dungeon): portals (WeenieType 7)
 *    with their Destination (position type 2) as exit coords, or as a Dungeon entrance when the destination
 *    is a dungeon cell (interior, not SeenOutside); lifestones (25), vendors (12), allegiance bindstones (65),
 *    NPCs (creatures that can't be attacked), and UtilityBelt's towns / outposts where this era has people
 *    within 2.0 of them (build-map-markers.ts UB_TOWNS).
 *  - underground portals: portals inside a dungeon that lead out, with the walk from the nearest point an
 *    entrance drops you.
 *  - start points: GoArrow's recalls and portal gems that exist in this era, from the spell table's
 *    destinations and each gem's linked portal. One landing in a dungeon starts at the nearest way out.
 *  - mansion portal devices: GoArrow's device names, their destinations from the spells their Use emote casts.
 *  - islands: each landblock's island, from the terrain (a landblock is sea when all 81 vertices are water).
 *
 *   npx tsx tools/build-goarrow-locations.ts [eol|ac1999|dm ...]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  GoLocationType, GoRegionMap, goCoordsFromCell, goLabelIslands, GOARROW_DEFAULT_GEMS, GOARROW_DEFAULT_RECALLS, type GoArrowEraFile,
} from '../packages/shared/src/goarrow/index.ts';
import { trimPortalName, UB_TOWNS } from './build-map-markers.ts';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'packages/renderer/src/ui/goarrow/locations');

/** A world position: cell id and landblock-local metres. */
export interface GaPos { cell: number; x: number; y: number; z: number }
/** The parts of a weenie this generator reads. */
export interface GaWeenie {
  wcid: number;
  type: number;
  name: string;
  ints: Map<number, number>;
  bools: Map<number, boolean>;
  strs: Map<number, string>;
  dids: Map<number, number>;
  dest?: GaPos;
  /** Spells its emotes cast (CastSpellInstant). */
  castSpells: number[];
}
export interface GaPlacement { guid: number; wcid: number; pos: GaPos }
export interface GaSpell { id: number; name: string; pos: GaPos }
export interface GaWorld { weenies: GaWeenie[]; placements: GaPlacement[]; spells: GaSpell[] }

/** GoArrow's recall start names → the spell each era names for it. */
export const RECALL_SPELLS: Readonly<Record<string, string>> = {
  'Abandoned Mines': 'Free Ride to the Abandoned Mine',
  'Aerlinthe Recall': 'Aerlinthe Recall',
  'Aphus Lassel Recall': 'Recall Aphus Lassel',
  'Sancturary Recall': 'Recall the Sanctuary',
  'Mount Lethe Recall': 'Mount Lethe Recall',
  'Singularity Caul Recall': 'Recall to the Singularity Caul',
  'Glenden Wood Recall': 'Glenden Wood Recall',
  "Ulgrim's Recall": "Ulgrim's Recall",
};

/** GoArrow's bundled mansion portal device names (spec §4.4). */
export const DEVICE_NAMES: readonly string[] = [
  'Black Spawn Den Portal Device', 'Citadels Portal Device', 'Dangerous Portal Device', "K'nath Lair Portal", 'Lesser Direlands Device',
  'Olthoi Lands Portal Device', 'Outland Portal Device', "Portal to Izji Qo's Temple", "Portal to Kivik Lir's Temple", 'Replica of a Tursh Totem',
];

/** WeenieType (ACE WeenieType.cs). */
const WT = { Portal: 7, Creature: 10, Vendor: 12, LifeStone: 25, AllegianceBindstone: 65 } as const;
/** ACE property ids: Int ItemType 1, MinLevel 86, MaxLevel 87, PortalBitmask 111; Bool Attackable 19; String Name 1, QuestRestriction 37; DID LinkedPortalOne 31. */
const P = { ItemType: 1, MinLevel: 86, MaxLevel: 87, PortalBitmask: 111, Attackable: 19, Name: 1, QuestRestriction: 37, LinkedPortalOne: 31 } as const;
/** Fixed ids for UB's towns: landblock 0x0000 (open sea) has no world objects, so 0x70000000 + index can't meet a guid. */
export const TOWN_ID_BASE = 0x70000000;

// ── SQL parsing (ACE world layout) ──

/** Every INSERT's VALUES body for one table, joined. */
function valuesOf(text: string, table: string): string {
  const re = new RegExp('INSERT INTO `' + table + '` \\([^)]*\\)\\s*VALUES ([\\s\\S]*?);\\s*(?:\\n|$)', 'g');
  return [...text.matchAll(re)].map((m) => m[1]).join(',\n');
}
/** The value tuples of one table's INSERT, comments dropped, split on commas outside quotes. */
function rowsOf(text: string, table: string): string[][] {
  const body = valuesOf(text, table).replace(/\/\*[\s\S]*?\*\//g, '');
  const out: string[][] = [];
  let row: string[] | null = null;
  let cur = '';
  let quote = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (quote) {
      if (ch === '\\') { cur += ch + (body[++i] ?? ''); continue; }
      if (ch === "'") { if (body[i + 1] === "'") { cur += "''"; i++; continue; } quote = false; }
      cur += ch;
      continue;
    }
    if (ch === "'") { quote = true; cur += ch; continue; }
    if (ch === '(' && !row) { row = []; cur = ''; continue; }
    if (ch === ')' && row) { row.push(cur.trim()); out.push(row); row = null; continue; }
    if (ch === ',' && row) { row.push(cur.trim()); cur = ''; continue; }
    if (row) cur += ch;
  }
  return out;
}
const num = (s: string | undefined): number => (s && /^0x/i.test(s) ? parseInt(s, 16) : Number(s));
const unquote = (s: string): string => s.replace(/^'|'$/g, '').replace(/\\'|''/g, "'");

/** One weenie's SQL file → what the generator reads, or null when there is no weenie row. */
export function parseGoArrowWeenieSql(text: string): GaWeenie | null {
  const w = /INSERT INTO `weenie` \([^)]*\)\s*VALUES \((\d+), *'(?:[^'\\]|\\.|'')*', *(\d+)/.exec(text);
  if (!w) return null;
  const strs = new Map(rowsOf(text, 'weenie_properties_string').map((r) => [Number(r[1]), unquote(r[2] ?? '')]));
  const out: GaWeenie = {
    wcid: Number(w[1]),
    type: Number(w[2]),
    name: strs.get(P.Name) ?? '',
    ints: new Map(rowsOf(text, 'weenie_properties_int').map((r) => [Number(r[1]), Number(r[2])])),
    bools: new Map(rowsOf(text, 'weenie_properties_bool').map((r) => [Number(r[1]), /^true$/i.test(r[2] ?? '')])),
    strs,
    dids: new Map(rowsOf(text, 'weenie_properties_d_i_d').map((r) => [Number(r[1]), num(r[2]) >>> 0])),
    castSpells: [],
  };
  const dest = rowsOf(text, 'weenie_properties_position').find((r) => Number(r[1]) === 2);
  if (dest) out.dest = { cell: num(dest[2]) >>> 0, x: Number(dest[3]), y: Number(dest[4]), z: Number(dest[5]) };
  for (const r of rowsOf(text, 'weenie_properties_emote_action')) if (Number(r[2]) === 19 && r[20] && r[20] !== 'NULL') out.castSpells.push(Number(r[20]));
  return out;
}

/** One landblock's SQL file → its placements. */
export function parseGoArrowLandblockSql(text: string): GaPlacement[] {
  const out: GaPlacement[] = [];
  for (const m of text.matchAll(/VALUES \((0x[0-9A-F]+), *(\d+), *(0x[0-9A-F]+), *(-?[\d.eE+-]+), *(-?[\d.eE+-]+), *(-?[\d.eE+-]+)/gi)) {
    out.push({ guid: parseInt(m[1]!, 16) >>> 0, wcid: Number(m[2]), pos: { cell: parseInt(m[3]!, 16) >>> 0, x: Number(m[4]), y: Number(m[5]), z: Number(m[6]) } });
  }
  return out;
}

/** One spell's SQL file → its name and destination, or null when it has no position. */
export function parseGoArrowSpellSql(text: string): GaSpell | null {
  const r = rowsOf(text, 'spell')[0];
  const cols = /INSERT INTO `spell` \(([^)]*)\)/.exec(text)?.[1]?.split(',').map((c) => c.trim().replace(/`/g, ''));
  if (!r || !cols) return null;
  const at = (c: string) => r[cols.indexOf(c)];
  const cell = at('position_Obj_Cell_ID');
  if (!cell || cell === 'NULL') return null;
  return { id: Number(at('id')), name: unquote(at('name') ?? ''), pos: { cell: num(cell) >>> 0, x: Number(at('position_Origin_X')), y: Number(at('position_Origin_Y')), z: Number(at('position_Origin_Z')) } };
}

// ── the era table ──

const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * Build one era's table (everything but the islands). `seenOutside(cell)` reads the EnvCell's flag 0x01
 * (null: no such cell); a dungeon cell is an interior cell that isn't SeenOutside.
 */
export function buildGoArrowEra(world: GaWorld, seenOutside: (cell: number) => boolean | null): Omit<GoArrowEraFile, 'r'> {
  const isInterior = (cell: number) => (cell & 0xffff) >= 0x100;
  const isDungeon = (cell: number) => isInterior(cell) && seenOutside(cell) === false;
  const isLandscape = (cell: number) => !isInterior(cell) || seenOutside(cell) === true;
  const at = (p: GaPos) => goCoordsFromCell(p.cell, p.x, p.y);
  const byWcid = new Map(world.weenies.map((w) => [w.wcid, w]));
  const level = (w: GaWeenie) => [w.ints.get(P.MinLevel) ?? 0, w.ints.get(P.MaxLevel) ?? 0] as const;
  /** 1 = not for route finding: the server refuses everyone (PortalBitmask 0) or it needs a quest. */
  const portalFlags = (w: GaWeenie) => (w.ints.get(P.PortalBitmask) === 0 || w.strs.has(P.QuestRestriction) ? 1 : 0);
  const isNpc = (w: GaWeenie) => w.type === WT.Creature && ((w.ints.get(P.ItemType) ?? 0) & 0x10) !== 0 && w.bools.get(P.Attackable) === false;

  const l: GoArrowEraFile['l'] = [];
  const dungeonNames = new Map<number, Map<string, number>>();
  /** Landing points inside each dungeon landblock: where its entrances drop you. */
  const landings = new Map<number, GaPos[]>();
  const insidePortals: Array<{ guid: number; w: GaWeenie; pos: GaPos }> = [];
  for (const p of world.placements) {
    const w = byWcid.get(p.wcid);
    if (!w || !w.name) continue;
    if (isDungeon(p.pos.cell)) {
      if (w.type === WT.Portal && w.dest && isLandscape(w.dest.cell)) insidePortals.push({ guid: p.guid, w, pos: p.pos });
      continue;
    }
    const c = at(p.pos);
    const [minL, maxL] = level(w);
    let type: number;
    let exit: [number | null, number | null] = [null, null];
    let dungeonId = 0;
    let flags = 0;
    const name = w.name;
    if (w.type === WT.Portal) {
      if (!w.dest) continue;
      flags = portalFlags(w);
      if (isDungeon(w.dest.cell)) {
        type = GoLocationType.Dungeon;
        dungeonId = w.dest.cell >>> 16;
        const counts = dungeonNames.get(dungeonId) ?? new Map<string, number>();
        const n = trimPortalName(w.name);
        counts.set(n, (counts.get(n) ?? 0) + 1);
        dungeonNames.set(dungeonId, counts);
        const list = landings.get(dungeonId) ?? [];
        list.push(w.dest);
        landings.set(dungeonId, list);
      } else if (isLandscape(w.dest.cell)) {
        type = GoLocationType.Portal;
        const e = at(w.dest);
        exit = [r2(e.ns), r2(e.ew)];
      } else {
        type = GoLocationType.Portal; // its destination cell isn't in this era's cell.dat: listed, never routed
        flags = 1;
      }
    } else if (w.type === WT.LifeStone) type = GoLocationType.Lifestone;
    else if (w.type === WT.Vendor) type = GoLocationType.Vendor;
    else if (w.type === WT.AllegianceBindstone) type = GoLocationType.Bindstone;
    else if (isNpc(w)) type = GoLocationType.NPC;
    else continue;
    l.push([p.guid, type, name, r2(c.ns), r2(c.ew), exit[0], exit[1], dungeonId, minL, maxL, flags]);
  }
  // UB's towns and outposts, where this era has people near them.
  const people = l.filter((r) => r[1] === GoLocationType.Lifestone || r[1] === GoLocationType.Vendor || r[1] === GoLocationType.NPC);
  UB_TOWNS.forEach(([name, kind, ns, ew], i) => {
    if (people.some((p) => Math.hypot(p[3] - ns, p[4] - ew) <= 2)) {
      l.push([TOWN_ID_BASE + i, kind === 'Town' ? GoLocationType.Town : GoLocationType.Outpost, name, ns, ew, null, null, 0, 0, 0, 0]);
    }
  });
  const ids = new Set<number>();
  for (const r of l) { if (ids.has(r[0])) throw new Error(`duplicate location id 0x${r[0].toString(16)}`); ids.add(r[0]); }
  l.sort((a, b) => a[0] - b[0]);

  // Underground portals: reachable only when some entrance drops you in their dungeon.
  const walkFrom = (lb: number, pos: GaPos): number | null => {
    const ls = landings.get(lb);
    if (!ls?.length) return null;
    return Math.min(...ls.map((d) => Math.hypot(d.x - pos.x, d.y - pos.y, d.z - pos.z))) / 240;
  };
  const u: GoArrowEraFile['u'] = [];
  for (const { guid, w, pos } of insidePortals) {
    const lb = pos.cell >>> 16;
    const walk = walkFrom(lb, pos);
    if (walk === null) continue;
    const e = at(w.dest!);
    const [minL, maxL] = level(w);
    u.push([guid, w.name, lb, r2(e.ns), r2(e.ew), r3(walk), minL, maxL, portalFlags(w)]);
  }
  u.sort((a, b) => a[0] - b[0]);

  /** Where a teleport to `pos` effectively starts: there on the landscape; in a dungeon, its nearest way out. */
  const startAt = (pos: GaPos): [number | null, number | null] => {
    if (isLandscape(pos.cell)) { const c = at(pos); return [r2(c.ns), r2(c.ew)]; }
    const lb = pos.cell >>> 16;
    let best: { d: number; ns: number; ew: number } | null = null;
    for (const p of insidePortals) {
      if (p.pos.cell >>> 16 !== lb || portalFlags(p.w)) continue;
      const d = Math.hypot(p.pos.x - pos.x, p.pos.y - pos.y, p.pos.z - pos.z);
      if (!best || d < best.d) { const e = at(p.w.dest!); best = { d, ns: r2(e.ns), ew: r2(e.ew) }; }
    }
    return best ? [best.ns, best.ew] : [null, null];
  };
  const s: GoArrowEraFile['s'] = [];
  const spellByName = new Map<string, GaSpell>();
  for (const sp of world.spells) if (!spellByName.has(sp.name)) spellByName.set(sp.name, sp);
  for (const r of GOARROW_DEFAULT_RECALLS) {
    const sp = spellByName.get(RECALL_SPELLS[r.name] ?? r.name);
    if (sp) s.push([r.name, ...startAt(sp.pos)]);
  }
  for (const g of GOARROW_DEFAULT_GEMS) {
    const town = g.slice('Portal Gem: '.length);
    const gem = world.weenies.find((w) => (w.name === `${town} Portal Gem` || w.name === `${town}'s Portal Gem`) && w.dids.has(P.LinkedPortalOne));
    const portal = gem ? byWcid.get(gem.dids.get(P.LinkedPortalOne)!) : undefined;
    if (portal?.dest) s.push([g, ...startAt(portal.dest)]);
  }

  const spellById = new Map(world.spells.map((sp) => [sp.id, sp]));
  const p: GoArrowEraFile['p'] = [];
  for (const name of DEVICE_NAMES) {
    const w = world.weenies.find((x) => x.name === name && x.castSpells.length > 0);
    if (!w) continue;
    const dests: Array<[string, number, number]> = [];
    for (const id of w.castSpells) {
      const sp = spellById.get(id);
      if (!sp || !isLandscape(sp.pos.cell)) continue;
      const c = at(sp.pos);
      dests.push([sp.name, r2(c.ns), r2(c.ew)]);
    }
    if (dests.length) p.push([name, dests]);
  }

  const d: GoArrowEraFile['d'] = [...dungeonNames].map(([lb, counts]): [string, string] => {
    const best = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]![0];
    return [lb.toString(16).toUpperCase().padStart(4, '0'), best];
  }).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return { v: 1, l, u, s, p, d };
}

// ── era sources ──

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
function overlay(trees: string[][], key: (f: string) => string | null): string[] {
  const m = new Map<string, string>();
  for (const files of trees) for (const f of files) { const k = key(f); if (k) m.set(k, f); }
  return [...m.values()];
}
const WEENIE_DIRS = ['LifeStone', 'Portal', 'Vendor', 'Creature', 'AllegianceBindstone', 'Gem', 'Hooker'];

function fromSqlTree(roots: Array<{ weenies: string; landblocks: string; spells: string }>): GaWorld {
  const byId = (f: string) => /^(\d+) /.exec(basename(f))?.[1] ?? null;
  const wfiles = overlay(roots.map((r) => WEENIE_DIRS.flatMap((d) => sqlFiles(join(r.weenies, d)))), byId);
  const lfiles = overlay(roots.map((r) => sqlFiles(r.landblocks)), (f) => basename(f).toUpperCase());
  const sfiles = overlay(roots.map((r) => sqlFiles(r.spells)), byId);
  return {
    weenies: wfiles.flatMap((f) => { const w = parseGoArrowWeenieSql(readFileSync(f, 'utf8')); return w ? [w] : []; }),
    placements: lfiles.flatMap((f) => parseGoArrowLandblockSql(readFileSync(f, 'utf8'))),
    spells: sfiles.flatMap((f) => { const s = parseGoArrowSpellSql(readFileSync(f, 'utf8')); return s ? [s] : []; }),
  };
}

function fromClassicAce(): GaWorld {
  const pw = execFileSync('docker', ['exec', 'classicace-db', 'printenv', 'MYSQL_ROOT_PASSWORD'], { encoding: 'utf8' }).trim();
  const sql = (q: string): string[][] => execFileSync('docker', ['exec', 'classicace-db', 'mysql', '-uroot', `-p${pw}`, '-N', '-B', 'ace_world_customdm', '-e', q], { encoding: 'utf8', maxBuffer: 512 << 20, stdio: ['ignore', 'pipe', 'ignore'] })
    .trim().split('\n').filter(Boolean).map((l) => l.split('\t'));
  // Single-table reads joined here (joins on the property tables run for minutes there).
  const weenies = new Map<string, GaWeenie>();
  const names = new Map(sql('SELECT object_Id, value FROM weenie_properties_string WHERE type = 1').map(([id, v]) => [id!, v!]));
  const wanted = new Set([...DEVICE_NAMES]);
  for (const [id, t] of sql('SELECT class_Id, type FROM weenie')) {
    const type = Number(t);
    const name = names.get(id!) ?? '';
    if (![7, 10, 12, 25, 65].includes(type) && !/Portal Gem$/.test(name) && !wanted.has(name)) continue;
    weenies.set(id!, { wcid: Number(id), type, name, ints: new Map(), bools: new Map(), strs: new Map([[1, name]]), dids: new Map(), castSpells: [] });
  }
  const inList = [...weenies.keys()].join(',');
  for (const [id, k, v] of sql(`SELECT object_Id, type, value FROM weenie_properties_int WHERE type IN (1, 86, 87, 111) AND object_Id IN (${inList})`)) weenies.get(id!)?.ints.set(Number(k), Number(v));
  for (const [id, k, v] of sql(`SELECT object_Id, type, value + 0 FROM weenie_properties_bool WHERE type = 19 AND object_Id IN (${inList})`)) weenies.get(id!)?.bools.set(Number(k), v === '1');
  for (const [id, k, v] of sql(`SELECT object_Id, type, value FROM weenie_properties_string WHERE type = 37 AND object_Id IN (${inList})`)) weenies.get(id!)?.strs.set(Number(k), v!);
  for (const [id, k, v] of sql(`SELECT object_Id, type, value FROM weenie_properties_d_i_d WHERE type = 31 AND object_Id IN (${inList})`)) weenies.get(id!)?.dids.set(Number(k), Number(v) >>> 0);
  for (const [id, c, x, y, z] of sql(`SELECT object_Id, obj_Cell_Id, origin_X, origin_Y, origin_Z FROM weenie_properties_position WHERE position_Type = 2 AND object_Id IN (${inList})`)) {
    const w = weenies.get(id!);
    if (w) w.dest = { cell: Number(c) >>> 0, x: Number(x), y: Number(y), z: Number(z) };
  }
  const devIds = [...weenies.values()].filter((w) => wanted.has(w.name)).map((w) => w.wcid);
  if (devIds.length) {
    const emotes = new Map(sql(`SELECT id, object_Id FROM weenie_properties_emote WHERE object_Id IN (${devIds.join(',')})`).map(([eid, oid]) => [eid!, oid!]));
    if (emotes.size) {
      for (const [eid, sp] of sql(`SELECT emote_Id, spell_Id FROM weenie_properties_emote_action WHERE type = 19 AND emote_Id IN (${[...emotes.keys()].join(',')})`)) {
        if (sp && sp !== 'NULL') weenies.get(emotes.get(eid!)!)?.castSpells.push(Number(sp));
      }
    }
  }
  const placements = sql('SELECT guid, weenie_Class_Id, obj_Cell_Id, origin_X, origin_Y, origin_Z FROM landblock_instance')
    .map(([g, w, c, x, y, z]): GaPlacement => ({ guid: Number(g) >>> 0, wcid: Number(w), pos: { cell: Number(c) >>> 0, x: Number(x), y: Number(y), z: Number(z) } }));
  const spells = sql('SELECT id, name, position_Obj_Cell_ID, position_Origin_X, position_Origin_Y, position_Origin_Z FROM spell WHERE position_Obj_Cell_ID IS NOT NULL')
    .map(([id, n, c, x, y, z]): GaSpell => ({ id: Number(id), name: n!, pos: { cell: Number(c) >>> 0, x: Number(x), y: Number(y), z: Number(z) } }));
  return { weenies: [...weenies.values()], placements, spells };
}

/** The cell.dat readers: EnvCell SeenOutside, and whether a landblock is open sea (all 81 vertices water). */
async function cellReaders(cellPath: string, era: string): Promise<{ seenOutside: (cell: number) => boolean | null; isSea: (bx: number, by: number) => boolean }> {
  const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase.ts');
  const { FileDatBytes } = await import('../packages/dat-parser/src/node/FileDatBytes.ts');
  const { DatReader } = await import('../packages/dat-parser/src/DatReader.ts');
  const { EnvCell } = await import('../packages/dat-parser/src/file-types/EnvCell.ts');
  const { CellLandblock } = await import('../packages/dat-parser/src/file-types/CellLandblock.ts');
  const { isWaterTerrainType } = await import('../packages/shared/src/physics/WaterMap.ts');
  const db = new DatDatabase(new FileDatBytes(cellPath));
  if (era === 'ac1999') {
    const { ac1999CellOverlay } = await import('../packages/dat-parser/src/era1999/Ac1999Overlay.ts');
    db.setOverlay(ac1999CellOverlay());
  }
  const cache = new Map<number, boolean | null>();
  return {
    seenOutside: (cell) => {
      if (cache.has(cell)) return cache.get(cell)!;
      let v: boolean | null = null;
      try {
        const d = db.getFileData(cell >>> 0);
        if (d) v = (new EnvCell(new DatReader(d)).flags & 0x01) !== 0;
      } catch { v = null; }
      cache.set(cell, v);
      return v;
    },
    isSea: (bx, by) => {
      try {
        const d = db.getFileData((((bx << 24) | (by << 16)) >>> 0) + 0xffff);
        if (!d) return true;
        return CellLandblock.read(new DatReader(d)).terrain.every((t) => isWaterTerrainType(CellLandblock.getType(t)));
      } catch { return true; }
    },
  };
}

async function write(era: string, world: GaWorld, cellPath: string): Promise<void> {
  const { seenOutside, isSea } = await cellReaders(cellPath, era);
  const table = buildGoArrowEra(world, seenOutside);
  const islands = goLabelIslands(isSea);
  const file: GoArrowEraFile = { ...table, r: GoRegionMap.encode(islands) };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, `${era}.ts`), `// Generated by tools/build-goarrow-locations.ts from this era's world data and cell.dat; do not edit.\n// Format: GoArrowEraFile (packages/shared/src/goarrow/locations.ts).\nexport default ${JSON.stringify(JSON.stringify(file))};\n`);
  const count = (t: number) => table.l.filter((r) => r[1] === t).length;
  const sizes = new Map<number, number>();
  for (const id of islands) sizes.set(id, (sizes.get(id) ?? 0) + 1);
  console.log(`${era}: ${table.l.length} locations (portals ${count(GoLocationType.Portal)}, dungeons ${count(GoLocationType.Dungeon)}, lifestones ${count(GoLocationType.Lifestone)}, `
    + `vendors ${count(GoLocationType.Vendor)}, NPCs ${count(GoLocationType.NPC)}, bindstones ${count(GoLocationType.Bindstone)}, towns ${count(GoLocationType.Town)}, outposts ${count(GoLocationType.Outpost)}), `
    + `${table.u.length} underground portals, starts [${table.s.map((x) => `${x[0]}${x[1] === null ? ' (no coords)' : ''}`).join(', ')}], devices ${table.p.length}, `
    + `${sizes.size - 1} islands (mainland ${sizes.get(0)} landblocks)`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename);
const want = process.argv.slice(2);
const eras = !isMain ? [] : want.length ? want : ['eol', 'ac1999', 'dm'];
for (const era of eras) {
  if (era === 'eol') {
    const core = join(ROOT, 'world-db-raw/ACE-World-16PY/Database/3-Core');
    const patches = join(ROOT, 'world-db-raw/ACE-World-16PY-Patches/Database/Patches');
    await write('eol', fromSqlTree([
      { weenies: join(core, '9 WeenieDefaults/SQL'), landblocks: join(core, '6 LandBlockExtendedData'), spells: join(core, '2 SpellTableExtendedData') },
      { weenies: join(patches, '9 WeenieDefaults'), landblocks: join(patches, '6 LandBlockExtendedData'), spells: join(patches, '2 SpellTableExtendedData') },
    ]), join(ROOT, 'dat/client_cell_1.dat'));
  } else if (era === 'ac1999') {
    const base = join(ROOT, 'reference/ac1999/Server/Database/AC1999-World/3-Core');
    await write('ac1999', fromSqlTree([{ weenies: join(base, '9 WeenieDefaults/SQL'), landblocks: join(base, '6 LandBlockExtendedData/SQL'), spells: join(base, '2 SpellTableExtendedData') }]),
      join(ROOT, 'dat-sets/ac1999-retail/cell.dat'));
  } else if (era === 'dm') {
    await write('dm', fromClassicAce(), join(ROOT, 'dat-sets/classicace-customdm-1.60/client_cell_1.dat'));
  }
}
