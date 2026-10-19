/**
 * A read-only window on the local ACE world DB for stream players (tools/stream/brief.md): places, levels, NPCs and
 * portal destinations. The players run unattended, so their permission is this one command, not `docker exec … mysql`
 * (which would let a typo or a bad idea write to the world): one statement, a reading one, run inside a READ ONLY
 * transaction, its output clipped.
 *
 *   npx tsx tools/stream/world-query.ts "SELECT … FROM weenie_properties_string WHERE type = 1 AND value LIKE '%Drudge%' LIMIT 20"
 *   npx tsx tools/stream/world-query.ts lore "Olthoi Gardener"     a wiki-style monster lookup (tools/stream/lore.ts)
 *   npx tsx tools/stream/world-query.ts sells "Impenetrability"    which shops sell it, the price, and where (tools/stream/shops.ts);
 *                                       add `near 42.1N 33.6E` for the nearest first
 *   npx tsx tools/stream/world-query.ts spawns "Grievver"          where a creature is placed or generated (tools/stream/spawns.ts);
 *                                       add `near 42.1N 33.6E` for the nearest first
 *
 * WORLD_QUERY_USAGE (printed with no arguments, and after a failed query) says how monsters spawn and the SQL dialect.
 *
 * ACJS_WORLD_DB_CONTAINER / ACJS_WORLD_DB / ACJS_WORLD_DB_PASSWORD pick another server's DB (default: end of retail's ace-db).
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatDatabase } from '../../packages/dat-parser/src/DatDatabase.js';
import { FileDatBytes } from '../../packages/dat-parser/src/node/FileDatBytes.js';
import { DatReader } from '../../packages/dat-parser/src/DatReader.js';
import { SpellTable } from '../../packages/dat-parser/src/file-types/SpellTable.js';
import { EnvCell } from '../../packages/dat-parser/src/file-types/EnvCell.js';
import { type AreaCreature, areaCreatureSql, parseAreaCreatures } from './corpses.ts';
import { formatLore, loreDetailSql, loreNameSql, parseLoreRows, pickLoreNames } from './lore.ts';
import { aceCellOf, formatShops, parseShopOffers, parseShopVendors, placeMapCoords, shopOfferSql, shopScrollOfferSql, shopVendorSql, type ShopDatInfo, type ShopOffer, type ShopVendor } from './shops.ts';
import { mapCoordinateText } from '../../packages/renderer/src/ui/MapMarkers.ts';
import { SPAWN_MAX_DEPTH, SPAWNS_MAX_NAMES, formatSpawns, parseSpawnsQuery, parseGenProfiles, parseSpawnPlaces, spawnParentSql, spawnPlaceSql, spawnSources, type GenProfile } from './spawns.ts';

export const WORLD_QUERY_MAX_CHARS = 8000;

/** Usage, how monsters spawn (ACE Landblock.CreateWorldObjects / SpawnEncounters, WorldObject_Generators) and the dialect. */
export const WORLD_QUERY_USAGE = [
  'usage: ./world-query "SELECT … LIMIT 20" | lore "<monster>" | sells "<item>" [near 42.1N 33.6E] | spawns "<monster>" [near 42.1N 33.6E]',
  'How monsters spawn: a landblock_instance row places a creature or a generator; a generator\'s weenie_properties_generator',
  'profiles name what it makes, often another generator (chains); most outdoor monsters come from the encounter table',
  '(landblock, cell_X, cell_Y → a generator wcid), not landblock_instance. `spawns "<monster>"` follows all three.',
  'SQL is MySQL 8: CONCAT(), HEX(), LPAD(), LOWER(), CAST(x AS UNSIGNED); there is no printf() (that is SQLite).',
  'A cell id XXYYcccc is a decimal number in the DB: landblock = obj_Cell_Id >> 16 (HEX() to read it); encounter.landblock is XXYY.',
  'XXYY0000 is an outdoor spot stored with its landblock only: ACE puts it in cell XXYY00cc, cc = floor(origin_X/24)×8 + floor(origin_Y/24) + 1 (select origin_X, origin_Y and it is shown so).',
].join('\n');

/** Why `sql` may not run, or null: a single SELECT / SHOW / DESCRIBE / EXPLAIN / WITH statement that writes nothing. */
export function worldQueryRefusal(sql: string): string | null {
  const s = sql.trim().replace(/;\s*$/, '');
  if (!s) return 'give one SQL statement';
  // Outside quoted strings: no second statement, no comments that could hide one.
  const bare = s.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, "''");
  if (bare.includes(';')) return 'one statement at a time';
  if (/--|#|\/\*/.test(bare)) return 'no SQL comments';
  if (!/^(select|show|describe|desc|explain|with)\b/i.test(bare)) return 'read-only: SELECT, SHOW, DESCRIBE, EXPLAIN or WITH … SELECT only';
  if (/\b(insert|update|delete|replace|drop|alter|create|truncate|grant|revoke|rename|load|handler|call|lock|set|do)\b/i.test(bare.replace(/^(show|describe|desc|explain)\b.*$/is, ''))) {
    return 'read-only: that statement would change the database';
  }
  if (/\binto\s+(outfile|dumpfile|@)/i.test(bare)) return 'read-only: no SELECT … INTO';
  if (/\b(sleep|benchmark|get_lock)\s*\(/i.test(bare)) return 'no sleep/benchmark/lock functions';
  return null;
}

export function clipOutput(out: string, max = WORLD_QUERY_MAX_CHARS): string {
  return out.length <= max ? out : `${out.slice(0, max)}\n… (${out.length - max} more characters cut: add a LIMIT or narrow the WHERE)`;
}

/**
 * mysql's boxed table with each cell-id column (a header with "cell" in it: obj_Cell_Id, dest_cell …) in hex. The DB
 * keeps a cell id as a decimal number, and Bulwark turned 25493832 (0x01850148, a Horrible Mu-miyah's room in Daiklos)
 * into "0x01850248" by hand, a cell Daiklos hasn't, so the bottom floor read as unreachable (2026-10-16). A footnote
 * says walk_to takes such an id. Other columns, and a table with no cell column, are as mysql printed them.
 *
 * An outdoor object the DB keeps with its landblock alone (XXYY0000: the Mountain Keep portal 1364 is 0xA8C30000 at
 * origin 105.357, 154.166) is in the cell ACE puts it in (aceCellOf: 0xA8C30027) when the row has origin_X / origin_Y
 * columns; without them it stays XXYY0000 and a footnote says what that means. Arcanist read 0xA8C30000 as "a nonsense
 * cell" (stream, 2026-10-17 07:38Z). The walk_to footnote names an indoor cell (a room) only; an outdoor one gets its
 * map coordinates, which walk_to takes.
 *
 * A column the query already turned to hex (HEX(obj_Cell_Id) AS cell, as Arcanist's query did) is read as hex: a value
 * of digits only ("1850148" for 0x01850148) was taken for a decimal and turned into another cell. Such a column is one
 * named HEX(…), an alias `sql` gives HEX(…), or one with a hex letter in any row.
 */
/** What the cell DAT says of a room: a building's (EnvCell SeenOutside) and where it stands in its landblock. */
export type RoomInfo = { building: boolean; x: number; y: number };

export function hexCellColumns(table: string, sql = '', roomOf?: (cell: number) => RoomInfo | null): string {
  const lines = table.replace(/\n+$/, '').split('\n');
  const rows = lines.map((l) => (/^\|.*\|$/.test(l) ? l.slice(1, -1).split('|').map((c) => c.trim()) : null));
  const header = rows.find((r) => r !== null);
  if (!header) return table;
  const cols = header.map((h, i) => (/cell/i.test(h) ? i : -1)).filter((i) => i >= 0);
  if (!cols.length) return table;
  const hexAliases = new Set([...sql.matchAll(/\bhex\s*\([^()]*\)\s+(?:as\s+)?[`"']?(\w+)/gi)].map((m) => m[1].toLowerCase()));
  const hexCols = new Set(cols.filter((i) => /^hex\s*\(/i.test(header[i]) || hexAliases.has(header[i].toLowerCase())
    || rows.some((r) => r && r !== header && /^[0-9A-F]*[A-F][0-9A-F]*$/i.test(r[i] ?? '') && (r[i] ?? '').length <= 8)));
  // The row's own origin, when the query selected it (origin_X, li.origin_X shows as origin_X; "x" / "y" aliases too).
  const xCol = header.findIndex((h) => /^(origin_?x|x)$/i.test(h));
  const yCol = header.findIndex((h) => /^(origin_?y|y)$/i.test(h));
  const hex = (n: number): string => `0x${n.toString(16).toUpperCase().padStart(8, '0')}`;
  let room: string | null = null;
  let outdoor: { cell: number; x: number; y: number } | null = null;
  let fixed: { from: number; to: number } | null = null;
  let bare: number | null = null;
  const cellHex = (v: string, row: string[], col: number): string => {
    const asHex = hexCols.has(col);
    if (asHex ? !/^[0-9A-F]{1,8}$/i.test(v) : !/^\d+$/.test(v)) return v;
    const n = asHex ? parseInt(v, 16) : Number(v);
    if (n < 0x10000 || n > 0xffffffff) return v;
    let cell = n >>> 0;
    if ((cell & 0xffff) === 0) {
      const x = xCol >= 0 ? Number(row[xCol]) : NaN, y = yCol >= 0 ? Number(row[yCol]) : NaN;
      if (Number.isFinite(x) && Number.isFinite(y) && xCol >= 0 && yCol >= 0 && row[xCol] !== '' && row[yCol] !== '') {
        cell = aceCellOf(cell, x, y);
        fixed ??= { from: n >>> 0, to: cell };
      } else bare ??= cell;
    }
    if ((cell & 0xffff) >= 0x100) room ??= hex(cell);
    else if ((cell & 0xffff) !== 0 && xCol >= 0 && yCol >= 0 && !outdoor) {
      const x = Number(row[xCol]), y = Number(row[yCol]);
      if (Number.isFinite(x) && Number.isFinite(y)) outdoor = { cell, x, y };
    }
    return hex(cell);
  };
  let any = false;
  const out = rows.map((r) => (r && r !== header ? r.map((c, i) => { if (!cols.includes(i)) return c; const h = cellHex(c, r, i); if (h !== c) any = true; return h; }) : r));
  if (!any) return table;
  const widths = header.map((_, i) => Math.max(...out.filter((r): r is string[] => r !== null).map((r) => (r[i] ?? '').length)));
  const rule = `+${widths.map((w) => '-'.repeat(w + 2)).join('+')}+`;
  const text = out.map((r) => (r ? `| ${r.map((c, i) => c.padEnd(widths[i])).join(' | ')} |` : rule)).join('\n');
  const notes: string[] = [];
  const r = room as string | null;
  // A building's room is walked to from outside too (the landscape, then its doorways), from up to 8 landblocks away
  // (AgentApi.CELL_TARGET_NEAR_LB). The note said "when you're in that dungeon or building", so Arcanist walked at the
  // Archmage by name from 1.4 km (refused: not in view), then by coordinates, never by 0x866C0106 (2026-10-18 21:06Z).
  if (r) {
    const info = roomOf?.(parseInt(r.slice(2), 16)) ?? null;
    const lb = `landblock 0x${r.slice(2, 6)}`;
    if (info?.building) notes.push(`${r} is a room in a building at about ${mapCoordinateText(placeMapCoords(parseInt(r.slice(2), 16), info.x, info.y))}: \`walk_to target=${r}\` walks there from outside too (the landscape, then the doorways) from up to about 1.5 km; farther, walk to those coordinates first`);
    else if (info) notes.push(`${r} is a dungeon room (${lb}): \`walk_to target=${r}\` walks to it once you are in that dungeon (go in by its portal)`);
    else notes.push(`\`walk_to target=${r}\` walks to that room: a building's from outside too (from up to about 1.5 km), a dungeon's once you are in it (${lb})`);
  }
  const o = outdoor as { cell: number; x: number; y: number } | null;
  if (o) notes.push(`${hex(o.cell)} is outdoors at ${mapCoordinateText(placeMapCoords(o.cell, o.x, o.y))}: walk_to takes those coordinates`);
  const f = fixed as { from: number; to: number } | null;
  if (f) notes.push(`a cell ending 0000 in the DB (${hex(f.from)}) is outdoors, stored with its landblock only; shown as the cell ACE puts it in, under its origin_X / origin_Y (${hex(f.to)})`);
  const b = bare as number | null;
  if (b !== null) notes.push(`a cell ending 0000 (${hex(b)}) is an outdoor spot stored with its landblock only: the real cell is landblock + (floor(origin_X / 24) × 8 + floor(origin_Y / 24) + 1); select origin_X, origin_Y too and it is shown`);
  return `${text}\n(cell ids in hex${notes.length ? `: ${notes.join('; ')}` : ''})`;
}

/** Run `stmts` inside one READ ONLY transaction; `table` = mysql's boxed output, else tab-separated rows, no header. */
function runReadOnly(stmts: string[], table: boolean): string {
  const r = queryReadOnly(stmts, table);
  if (!r.ok) { console.error(`${r.err}\n\n${WORLD_QUERY_USAGE}`); process.exit(1); }
  return r.out;
}

/** runReadOnly that reports a failure instead of exiting (the supervisor's reads: a missing DB must not end the stream). */
function queryReadOnly(stmts: string[], table: boolean): { ok: boolean; out: string; err: string } {
  const container = process.env.ACJS_WORLD_DB_CONTAINER ?? 'ace-db';
  const db = process.env.ACJS_WORLD_DB ?? 'ace_world';
  const pw = process.env.ACJS_WORLD_DB_PASSWORD ?? '1999asheron2017';
  const format = table ? ['--table'] : ['-N', '--batch'];
  const sql = `START TRANSACTION READ ONLY; ${stmts.map((s) => `${s};`).join(' ')} ROLLBACK;`;
  const r = spawnSync('docker', ['exec', container, 'mysql', '-uroot', `-p${pw}`, ...format, db, '-e', sql], { encoding: 'utf8', maxBuffer: 32 << 20 });
  const err = (r.stderr ?? '').split('\n').filter((l) => l && !/Using a password on the command line/.test(l)).join('\n');
  if (r.status !== 0) return { ok: false, out: '', err: err || `mysql exited ${r.status}` };
  return { ok: true, out: r.stdout ?? '', err };
}

/**
 * The shops that sell a scroll of any of `spellIds` and those vendors' places (shops.ts shopScrollOfferSql /
 * shopVendorSql), for the readiness block's Self-scroll line (shops.ts scrollSellerLines). Null when the world DB
 * can't be read. The DB is this era's (ACJS_WORLD_DB_*), so the scroll names and prices are too.
 */
export function scrollShops(spellIds: readonly number[]): { offers: ShopOffer[]; vendors: Map<number, ShopVendor> } | null {
  if (!spellIds.length) return { offers: [], vendors: new Map() };
  const o = queryReadOnly([shopScrollOfferSql(spellIds)], false);
  if (!o.ok) return null;
  const offers = parseShopOffers(o.out);
  if (!offers.length) return { offers, vendors: new Map() };
  const v = queryReadOnly(shopVendorSql(offers.map((x) => x.vendor)), false);
  return v.ok ? { offers, vendors: parseShopVendors(v.out) } : null;
}

/**
 * The monsters the world DB places in landblock `lb` (corpses.ts areaCreatureSql), for the opening's corpse lines; null
 * when the DB can't be read (the line then says nothing of them).
 */
export function areaCreatures(lb: number): AreaCreature[] | null {
  const r = queryReadOnly([areaCreatureSql(lb)], false);
  return r.ok ? parseAreaCreatures(r.out) : null;
}

/** `lore "<name>"`: the monster lookup. Two reads: the names containing it, then the chosen versions' details. */
function lore(query: string): string {
  const rows = runReadOnly([loreNameSql(query)], false).split('\n').filter(Boolean).map((l) => {
    const [id, name = ''] = l.split('\t');
    return { wcid: Number(id), name };
  });
  const pick = pickLoreNames(query, rows);
  if (!pick.wcids.length) return pick.note ?? '(nothing found)';
  const creatures = parseLoreRows(runReadOnly(loreDetailSql(pick.wcids), false));
  const flags = spellTable();
  for (const c of creatures) for (const s of c.spells) { const f = s.id !== undefined ? flags?.get(s.id)?.bitfield : undefined; if (f !== undefined) s.flags = f; }
  return formatLore(pick, creatures);
}

/** `sells "<item>"`: two reads, the shop offers whose item name contains it, then those vendors and their placements. */
function sells(arg: string): string {
  // `sells "<item>" near 42.1N 33.6E`: nearest shops first (the same `near` as spawns).
  const { name: query, near } = parseSpawnsQuery(arg);
  const offers = query.trim() ? parseShopOffers(runReadOnly([shopOfferSql(query)], false)) : [];
  const vendors = parseShopVendors(offers.length ? runReadOnly(shopVendorSql(offers.map((o) => o.vendor)), false) : '');
  const spells = offers.some((o) => o.spell) ? spellTable() : null;
  const cells = datAt(process.env.ACJS_CELL_DAT, '../../dat/client_cell_1.dat');
  const dat: ShopDatInfo = {
    spell: (id) => spells?.get(id),
    envCellFlags: (cell) => {
      const data = cells?.getFileData(cell);
      return data && data.byteLength >= 8 ? new DataView(data).getUint32(4, true) : undefined;
    },
  };
  return formatShops(query, offers, vendors, dat, undefined, near);
}

/**
 * `spawns "<monster>"`: the creatures named (as lore picks them), then the generators that make them, level by level
 * up to SPAWN_MAX_DEPTH, then where each is placed or rolled as an outdoor encounter.
 */
function spawns(arg: string): string {
  const { name: query, near } = parseSpawnsQuery(arg);
  const rows = query.trim() ? runReadOnly([loreNameSql(query)], false).split('\n').filter(Boolean).map((l) => {
    const [id, name = ''] = l.split('\t');
    return { wcid: Number(id), name };
  }) : [];
  const pick = pickLoreNames(query, rows, SPAWNS_MAX_NAMES);
  if (!pick.wcids.length) return formatSpawns(query, pick, []);
  const profiles: GenProfile[] = [];
  const gens = new Set<number>();
  let frontier = pick.wcids;
  for (let depth = 0; depth < SPAWN_MAX_DEPTH && frontier.length && gens.size < 2000; depth++) {
    const found = parseGenProfiles(runReadOnly([spawnParentSql(frontier)], false)).filter((p) => !gens.has(p.gen));
    profiles.push(...found);
    frontier = [...new Set(found.map((p) => p.gen))];
    for (const g of frontier) gens.add(g);
  }
  const places = parseSpawnPlaces(runReadOnly(spawnPlaceSql([...pick.wcids, ...gens]), false));
  const names = new Map(rows.map((r) => [r.wcid, r.name.trim()]));
  const nameOf = (w: number) => places.names.get(w) ?? names.get(w) ?? `wcid ${w}`;
  const cells = datAt(process.env.ACJS_CELL_DAT, '../../dat/client_cell_1.dat');
  const dat: ShopDatInfo = {
    envCellFlags: (cell) => {
      const data = cells?.getFileData(cell);
      return data && data.byteLength >= 8 ? new DataView(data).getUint32(4, true) : undefined;
    },
  };
  return formatSpawns(query, pick, spawnSources(pick.wcids, profiles, places, nameOf), dat, near);
}

function datAt(env: string | undefined, fallback: string): DatDatabase | null {
  const path = env ?? fileURLToPath(new URL(fallback, import.meta.url));
  if (!existsSync(path)) return null;
  try { return new DatDatabase(new FileDatBytes(path)); } catch { return null; }
}

/**
 * The portal DAT's SpellTable (0x0E00000E), read on demand (~60 ms): each spell's SpellBase.bitfield (whether a
 * monster's spell is cast at you: not Beneficial), power and school (who can learn a scroll). ACJS_PORTAL_DAT picks
 * another era's portal.dat. Null when the DAT isn't there (lore then judges by the spell's kind and name).
 */
function spellTable(): Map<number, { bitfield: number; power: number; school: number }> | null {
  try {
    const data = datAt(process.env.ACJS_PORTAL_DAT, '../../dat/client_portal.dat')?.getFileData(0x0e00000e);
    if (!data) return null;
    return new Map([...new SpellTable(new DatReader(data)).spells].map(([id, s]) => [id, { bitfield: s.bitfield, power: s.power, school: s.school }]));
  } catch {
    return null;
  }
}

/** A room's EnvCell from the cell DAT (ACJS_CELL_DAT picks another era's): SeenOutside (0x1) = a building's room. */
let cellDat: DatDatabase | null | undefined;
export function roomInfo(cell: number): RoomInfo | null {
  try {
    if (cellDat === undefined) cellDat = datAt(process.env.ACJS_CELL_DAT, '../../dat/client_cell_1.dat');
    const data = cellDat?.getFileData(cell >>> 0);
    if (!data) return null;
    const c = new EnvCell(new DatReader(data));
    return { building: (c.flags & 0x1) !== 0, x: c.position.origin.x, y: c.position.origin.y };
  } catch {
    return null;
  }
}

function main(): void {
  if (process.argv[2] === 'lore') {
    console.log(clipOutput(lore(process.argv.slice(3).join(' '))));
    return;
  }
  if (process.argv[2] === 'sells') {
    console.log(clipOutput(sells(process.argv.slice(3).join(' '))));
    return;
  }
  if (process.argv[2] === 'spawns') {
    console.log(clipOutput(spawns(process.argv.slice(3).join(' '))));
    return;
  }
  const sql = process.argv.slice(2).join(' ');
  if (!sql.trim() || /^(help|-h|--help)$/.test(sql.trim())) { console.log(WORLD_QUERY_USAGE); return; }
  const why = worldQueryRefusal(sql);
  if (why) { console.error(`refused: ${why}`); process.exit(2); }
  const out = runReadOnly([sql.trim().replace(/;\s*$/, '')], true);
  console.log(clipOutput(out ? hexCellColumns(out, sql, roomInfo) : '(no rows)'));
}

if (process.argv[1] && /world-query\.ts$/.test(process.argv[1])) main();
