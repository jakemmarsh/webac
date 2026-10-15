/**
 * A read-only window on the local ACE world DB for stream players (tools/stream/brief.md): places, levels, NPCs and
 * portal destinations. The players run unattended, so their permission is this one command, not `docker exec … mysql`
 * (which would let a typo or a bad idea write to the world): one statement, a reading one, run inside a READ ONLY
 * transaction, its output clipped.
 *
 *   npx tsx tools/stream/world-query.ts "SELECT … FROM weenie_properties_string WHERE type = 1 AND value LIKE '%Drudge%' LIMIT 20"
 *   npx tsx tools/stream/world-query.ts lore "Olthoi Gardener"     a wiki-style monster lookup (tools/stream/lore.ts)
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
  const flags = spellFlags();
  for (const c of creatures) for (const s of c.spells) { const f = s.id !== undefined ? flags?.get(s.id) : undefined; if (f !== undefined) s.flags = f; }
  return formatLore(pick, creatures);
}

/**
 * Each spell's SpellBase.bitfield from the portal DAT's SpellTable (0x0E00000E), read on demand (~60 ms): whether a
 * monster's spell is cast at you (not Beneficial). ACJS_PORTAL_DAT picks another era's portal.dat. Null when the
 * DAT isn't there (lore then judges by the spell's kind and name).
 */
function spellFlags(): Map<number, number> | null {
  const path = process.env.ACJS_PORTAL_DAT ?? fileURLToPath(new URL('../../dat/client_portal.dat', import.meta.url));
  if (!existsSync(path)) return null;
  try {
    const db = new DatDatabase(new FileDatBytes(path));
    const data = db.getFileData(0x0e00000e);
    if (!data) return null;
    return new Map([...new SpellTable(new DatReader(data)).spells].map(([id, s]) => [id, s.bitfield]));
  } catch {
    return null;
  }
}

function main(): void {
  if (process.argv[2] === 'lore') {
    console.log(clipOutput(lore(process.argv.slice(3).join(' '))));
    return;
  }
  const sql = process.argv.slice(2).join(' ');
  const why = worldQueryRefusal(sql);
  if (why) { console.error(`refused: ${why}`); process.exit(2); }
  const out = runReadOnly([sql.trim().replace(/;\s*$/, '')], true);
  console.log(clipOutput(out || '(no rows)'));
}

if (process.argv[1] && /world-query\.ts$/.test(process.argv[1])) main();
