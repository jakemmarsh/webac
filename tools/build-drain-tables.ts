/**
 * The drain and martyr tables the automation's Drain Auto plan reads
 * (VirindiTank's game-info DrainSpellOptions / MartyrSpellOptions;
 * docs/vtank-macro-behavior.md "Drain Auto: the drain and martyr plan").
 * One table per era, from that era's own spell data, so each era drains with
 * its own numbers:
 *
 *   end of retail  world-db-raw/ACE-World-16PY  "3-Core/2 SpellTableExtendedData" SQL, overlaid by
 *                  ACE-World-16PY-Patches "Database/Patches/2 SpellTableExtendedData" (by spell id)
 *   AC1999         reference/ac1999/Server/Database/AC1999-World (the same layout)
 *   Dark Majesty   the ClassicACE CustomDM world in its MySQL container (`spell`, one plain read)
 *
 * Rows, [spellId, kind, factor, cap, multiplier]:
 *   'd' a health drain (source Health, destination Health, TransferFlags
 *       TargetSource | CasterDestination = 6): factor = `proportion` of the
 *       target's current health, cap = `transfer_Cap` points (0 = none),
 *       multiplier = 1 - `loss_Percent` (what reaches you; ACE
 *       WorldObject_Magic.HandleCastSpell_Transfer).
 *   'm' a martyr (a Life projectile whose e_Type has Health, 128, with a
 *       `drain_Percentage`): factor = the share of YOUR current health it
 *       spends, multiplier = `damage_Ratio` (the damage per point spent; ACE
 *       HandleCastSpell_Projectile, SpellProjectile.LifeProjectileDamage).
 *       'r' the same, fired as a ring (more than one projectile).
 * Whether you know and can cast each spell is the macro's business; this only
 * says what the spell does.
 *
 *   npx tsx tools/build-drain-tables.ts [eol|ac1999|dm ...]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { overlayFiles } from './build-monster-tables.ts';

export type DrainRow = [number, 'd' | 'm' | 'r', number, number, number];

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'packages/renderer/src/agent/macro/drains');

/** One ACE `spell` row as column → raw value (NULL as null). */
export type SpellRecord = Record<string, string | null>;

/** The `spell` row of an ACE-layout spell SQL file, by column name. */
export function parseSpellSql(text: string): SpellRecord | null {
  const m = /INSERT INTO `spell` \(([^)]*)\)\s*VALUES \(([\s\S]*?)\);/.exec(text);
  if (!m) return null;
  const cols = m[1].split(',').map((c) => c.trim().replace(/`/g, ''));
  const vals: string[] = [];
  let cur = '', quoted = false;
  const body = m[2].replace(/\/\*[\s\S]*?\*\//g, '');
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quoted) {
      if (c === "'" && body[i + 1] === "'") { cur += "'"; i++; } else if (c === "'") quoted = false; else cur += c;
    } else if (c === "'") quoted = true;
    else if (c === ',') { vals.push(cur.trim()); cur = ''; } else cur += c;
  }
  vals.push(cur.trim());
  const out: SpellRecord = {};
  cols.forEach((c, i) => { const v = vals[i]; out[c] = v === undefined || /^null$/i.test(v) ? null : v; });
  return out;
}

const n = (v: string | null | undefined): number => (v === null || v === undefined ? NaN : Number(v));

/** A spell row as a drain or martyr row, or null when it is neither. */
export function drainRow(r: SpellRecord): DrainRow | null {
  const id = n(r.id);
  if (!Number.isFinite(id)) return null;
  if (n(r.source) === 2 && n(r.destination) === 2 && (n(r.transfer_Bitfield) & 6) === 6 && n(r.proportion) > 0) {
    const loss = Number.isFinite(n(r.loss_Percent)) ? n(r.loss_Percent) : 0;
    return [id, 'd', n(r.proportion), Number.isFinite(n(r.transfer_Cap)) ? n(r.transfer_Cap) : 0, Math.round((1 - loss) * 1000) / 1000];
  }
  if ((n(r.e_Type) & 128) !== 0 && n(r.drain_Percentage) > 0 && n(r.damage_Ratio) > 0) {
    return [id, n(r.num_Projectiles) > 1 ? 'r' : 'm', n(r.drain_Percentage), 0, n(r.damage_Ratio)];
  }
  return null;
}

function fromSqlDirs(...dirs: string[]): DrainRow[] {
  const list = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.sql')).map((f) => join(dir, f)) : []);
  return overlayFiles(dirs.map(list)).flatMap((f) => { const r = parseSpellSql(readFileSync(f, 'utf8')); const d = r ? drainRow(r) : null; return d ? [d] : []; });
}

function fromClassicAce(): DrainRow[] {
  const pw = execFileSync('docker', ['exec', 'classicace-db', 'printenv', 'MYSQL_ROOT_PASSWORD'], { encoding: 'utf8' }).trim();
  const cols = ['id', 'source', 'destination', 'proportion', 'loss_Percent', 'transfer_Cap', 'transfer_Bitfield', 'e_Type', 'drain_Percentage', 'damage_Ratio', 'num_Projectiles'];
  const out = execFileSync('docker', ['exec', 'classicace-db', 'mysql', '-uroot', `-p${pw}`, '-N', '-B', 'ace_world_customdm', '-e', `SELECT ${cols.join(', ')} FROM spell`], { encoding: 'utf8', maxBuffer: 64 << 20 });
  return out.trim().split('\n').filter(Boolean).flatMap((l) => {
    const v = l.split('\t');
    const r: SpellRecord = {};
    cols.forEach((c, i) => { r[c] = v[i] === 'NULL' ? null : v[i]; });
    const d = drainRow(r);
    return d ? [d] : [];
  });
}

function write(era: string, rows: DrainRow[]): void {
  rows.sort((a, b) => a[0] - b[0]);
  writeFileSync(join(OUT, `${era}.ts`), `// Generated by tools/build-drain-tables.ts from this era's spell data; do not edit.\nexport default ${JSON.stringify(JSON.stringify(rows))};\n`);
  console.log(`${era}: ${rows.filter((r) => r[1] === 'd').length} drains, ${rows.filter((r) => r[1] !== 'd').length} martyrs`);
}

// Run only as a script (tests import the parser without regenerating anything).
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename);
const want = process.argv.slice(2);
const eras = !isMain ? [] : want.length ? want : ['eol', 'ac1999', 'dm'];
for (const era of eras) {
  if (era === 'eol') write('eol', fromSqlDirs(join(ROOT, 'world-db-raw/ACE-World-16PY/Database/3-Core/2 SpellTableExtendedData/SQL'), join(ROOT, 'world-db-raw/ACE-World-16PY-Patches/Database/Patches/2 SpellTableExtendedData')));
  else if (era === 'ac1999') write('ac1999', fromSqlDirs(join(ROOT, 'reference/ac1999/Server/Database/AC1999-World/3-Core/2 SpellTableExtendedData/SQL')));
  else if (era === 'dm') write('dm', fromClassicAce());
}
