/**
 * A read-only window on the local ACE world DB for stream players (tools/stream/brief.md): places, levels, NPCs and
 * portal destinations. The players run unattended, so their permission is this one command, not `docker exec … mysql`
 * (which would let a typo or a bad idea write to the world): one statement, a reading one, run inside a READ ONLY
 * transaction, its output clipped.
 *
 *   npx tsx tools/stream/world-query.ts "SELECT … FROM weenie_properties_string WHERE type = 1 AND value LIKE '%Drudge%' LIMIT 20"
 *   npx tsx tools/stream/world-query.ts lore "Olthoi Gardener"     a wiki-style monster lookup (tools/stream/lore.ts)
 *   npx tsx tools/stream/world-query.ts sells "Impenetrability"    which shops sell it, the price, and where (tools/stream/shops.ts)
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
import { formatLore, loreDetailSql, loreNameSql, parseLoreRows, pickLoreNames } from './lore.ts';
import { formatShops, parseShopOffers, parseShopVendors, shopOfferSql, shopVendorSql, type ShopDatInfo } from './shops.ts';

export const WORLD_QUERY_MAX_CHARS = 8000;

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
 */
export function hexCellColumns(table: string): string {
  const lines = table.replace(/\n+$/, '').split('\n');
  const rows = lines.map((l) => (/^\|.*\|$/.test(l) ? l.slice(1, -1).split('|').map((c) => c.trim()) : null));
  const header = rows.find((r) => r !== null);
  if (!header) return table;
  const cols = header.map((h, i) => (/cell/i.test(h) ? i : -1)).filter((i) => i >= 0);
  if (!cols.length) return table;
  let first: string | null = null;
  const cellHex = (v: string): string => {
    if (!/^\d+$/.test(v)) return v;
    const n = Number(v);
    if (n < 0x10000 || n > 0xffffffff) return v;
    const h = `0x${n.toString(16).toUpperCase().padStart(8, '0')}`;
    first ??= h;
    return h;
  };
  const out = rows.map((r) => (r && r !== header ? r.map((c, i) => (cols.includes(i) ? cellHex(c) : c)) : r));
  if (first === null) return table;
  const widths = header.map((_, i) => Math.max(...out.filter((r): r is string[] => r !== null).map((r) => (r[i] ?? '').length)));
  const rule = `+${widths.map((w) => '-'.repeat(w + 2)).join('+')}+`;
  const text = out.map((r) => (r ? `| ${r.map((c, i) => c.padEnd(widths[i])).join(' | ')} |` : rule)).join('\n');
  return `${text}\n(cell ids in hex: \`walk_to target=${first}\` walks to that room when you're in that dungeon or building, landblock 0x${(first as string).slice(2, 6)})`;
}

/** Run `stmts` inside one READ ONLY transaction; `table` = mysql's boxed output, else tab-separated rows, no header. */
function runReadOnly(stmts: string[], table: boolean): string {
  const container = process.env.ACJS_WORLD_DB_CONTAINER ?? 'ace-db';
  const db = process.env.ACJS_WORLD_DB ?? 'ace_world';
  const pw = process.env.ACJS_WORLD_DB_PASSWORD ?? '1999asheron2017';
  const format = table ? ['--table'] : ['-N', '--batch'];
  const sql = `START TRANSACTION READ ONLY; ${stmts.map((s) => `${s};`).join(' ')} ROLLBACK;`;
  const r = spawnSync('docker', ['exec', container, 'mysql', '-uroot', `-p${pw}`, ...format, db, '-e', sql], { encoding: 'utf8', maxBuffer: 32 << 20 });
  const err = (r.stderr ?? '').split('\n').filter((l) => l && !/Using a password on the command line/.test(l)).join('\n');
  if (r.status !== 0) { console.error(err || `mysql exited ${r.status}`); process.exit(1); }
  return r.stdout ?? '';
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
function sells(query: string): string {
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
  return formatShops(query, offers, vendors, dat);
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

function main(): void {
  if (process.argv[2] === 'lore') {
    console.log(clipOutput(lore(process.argv.slice(3).join(' '))));
    return;
  }
  if (process.argv[2] === 'sells') {
    console.log(clipOutput(sells(process.argv.slice(3).join(' '))));
    return;
  }
  const sql = process.argv.slice(2).join(' ');
  const why = worldQueryRefusal(sql);
  if (why) { console.error(`refused: ${why}`); process.exit(2); }
  const out = runReadOnly([sql.trim().replace(/;\s*$/, '')], true);
  console.log(clipOutput(out ? hexCellColumns(out) : '(no rows)'));
}

if (process.argv[1] && /world-query\.ts$/.test(process.argv[1])) main();
