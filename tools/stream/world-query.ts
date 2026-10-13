/**
 * A read-only window on the local ACE world DB for stream players (tools/stream/brief.md): places, levels, NPCs and
 * portal destinations. The players run unattended, so their permission is this one command, not `docker exec … mysql`
 * (which would let a typo or a bad idea write to the world): one statement, a reading one, run inside a READ ONLY
 * transaction, its output clipped.
 *
 *   npx tsx tools/stream/world-query.ts "SELECT … FROM weenie_properties_string WHERE type = 1 AND value LIKE '%Drudge%' LIMIT 20"
 *
 * ACJS_WORLD_DB_CONTAINER / ACJS_WORLD_DB / ACJS_WORLD_DB_PASSWORD pick another server's DB (default: end of retail's ace-db).
 */
import { spawnSync } from 'node:child_process';

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

function main(): void {
  const sql = process.argv.slice(2).join(' ');
  const why = worldQueryRefusal(sql);
  if (why) { console.error(`refused: ${why}`); process.exit(2); }
  const container = process.env.ACJS_WORLD_DB_CONTAINER ?? 'ace-db';
  const db = process.env.ACJS_WORLD_DB ?? 'ace_world';
  const pw = process.env.ACJS_WORLD_DB_PASSWORD ?? '1999asheron2017';
  const stmt = sql.trim().replace(/;\s*$/, '');
  const r = spawnSync('docker', ['exec', container, 'mysql', '-uroot', `-p${pw}`, '--table', db, '-e', `START TRANSACTION READ ONLY; ${stmt}; ROLLBACK;`], { encoding: 'utf8', maxBuffer: 32 << 20 });
  const err = (r.stderr ?? '').split('\n').filter((l) => l && !/Using a password on the command line/.test(l)).join('\n');
  if (r.status !== 0) { console.error(err || `mysql exited ${r.status}`); process.exit(1); }
  console.log(clipOutput(r.stdout || '(no rows)'));
}

if (process.argv[1] && /world-query\.ts$/.test(process.argv[1])) main();
