/**
 * The monster tables the automation's combat reads (VirindiTank's game-info
 * database: MonsterDamageOverrides / SpeciesDamages for the Auto element and
 * SpeciesMembers' maximum health for the streak finisher; docs/vtank-macro-
 * behavior.md §4). One table per era, from that era's own world data, so each
 * era fights its own monsters:
 *
 *   end of retail  world-db-raw/ACE-World-16PY  "3-Core/9 WeenieDefaults/SQL/{Creature,Cow}"
 *   AC1999         reference/ac1999/Server/Database/AC1999-World (the same layout)
 *   Dark Majesty   the ClassicACE CustomDM world in its MySQL container (plain single-table reads)
 *
 * Kept: weenies whose ItemType has Creature (0x10) and that are not
 * Attackable = False (NPCs, vendors). Each row is [name, weak, maxHealth]:
 *   weak       the seven elements VTank's damage list names, most damaging
 *              first by the creature's Resist* multipliers (PropertyFloat
 *              64 Slash, 65 Pierce, 66 Bludgeon, 67 Fire, 68 Cold, 69 Acid,
 *              70 Electric; ACE multiplies a hit's damage by it, so higher =
 *              weaker), ties in VTank's own order for unlisted monsters
 *              (pierce, bludgeon, slash, acid, lightning, cold, fire). One
 *              letter each: p b s a l c f. Empty when every multiplier is the
 *              same (nothing to prefer). Nether (166) is left out: VTank's
 *              damage list has no nether, and Auto reaches nether only through
 *              a Void-only caster's training.
 *   maxHealth  weenie_properties_attribute_2nd MaxHealth (type 1)
 *              current_Level, else init_Level + Endurance / 2.
 * One name, several weenies (e.g. Drudge Skulker at several levels): the
 * median of each multiplier and of max health across them, so one odd quest
 * variant doesn't decide for the common one.
 *
 *   npx tsx tools/build-monster-tables.ts [eol|ac1999|dm ...]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface CreatureFacts {
  name: string;
  /** Resist multipliers in ELEMENT_ORDER order (1 when the weenie doesn't set one). */
  resist: number[];
  maxHealth: number;
}

/** VTank's element order for monsters its database doesn't list (MOSS VtankDamageDatabase.UnlistedElementOrder), as letters. */
export const ELEMENT_ORDER = ['p', 'b', 's', 'a', 'l', 'c', 'f'] as const;
/** PropertyFloat Resist* id → index in ELEMENT_ORDER (ACE PropertyFloat.cs 64–70). */
const RESIST_INDEX: Record<number, number> = { 64: 2, 65: 0, 66: 1, 67: 6, 68: 5, 69: 3, 70: 4 };

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'packages/renderer/src/agent/macro/monsters');

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

/** The VALUES text of one `INSERT INTO \`table\`` statement. */
function valuesOf(text: string, table: string): string {
  return new RegExp('INSERT INTO `' + table + '` \\([^)]*\\)\\s*VALUES ([\\s\\S]*?);\\s*(?:\\n|$)').exec(text)?.[1] ?? '';
}

/** The numeric rows of one statement, each as its comma-separated values (comments dropped). */
function rowsOf(text: string, table: string): string[][] {
  const out: string[][] = [];
  for (const r of valuesOf(text, table).replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\(([^()]*)\)/g)) out.push(r[1].split(',').map((v) => v.trim()));
  return out;
}

/** ACE-layout weenie SQL → the creature's facts, or null when it isn't an attackable creature. */
export function parseCreatureSql(text: string): CreatureFacts | null {
  const ints = new Map(rowsOf(text, 'weenie_properties_int').map((r) => [Number(r[1]), Number(r[2])]));
  if (((ints.get(1) ?? 0) & 0x10) === 0) return null; // ItemType Creature
  const bools = new Map(rowsOf(text, 'weenie_properties_bool').map((r) => [Number(r[1]), r[2]]));
  if (/^false$/i.test(bools.get(19) ?? '')) return null; // Attackable = False: an NPC
  const name = /\(\d+, *1, *'((?:[^'\\]|\\.|'')*)'\)/.exec(valuesOf(text, 'weenie_properties_string'))?.[1]?.replace(/\\'|''/g, "'");
  if (!name) return null;
  const resist = ELEMENT_ORDER.map(() => 1);
  for (const r of rowsOf(text, 'weenie_properties_float')) {
    const i = RESIST_INDEX[Number(r[1])];
    if (i !== undefined && Number.isFinite(Number(r[2]))) resist[i] = Number(r[2]);
  }
  const endurance = Number(rowsOf(text, 'weenie_properties_attribute').find((r) => Number(r[1]) === 2)?.[2] ?? 0);
  const hp = rowsOf(text, 'weenie_properties_attribute_2nd').find((r) => Number(r[1]) === 1);
  return { name, resist, maxHealth: maxHealthOf(hp ? Number(hp[2]) : 0, hp ? Number(hp[5]) : 0, endurance) };
}

function maxHealthOf(init: number, current: number, endurance: number): number {
  return current > 0 ? current : init + Math.round(endurance / 2);
}

/** The weak-element letters for one set of multipliers ('' when they're all equal). */
export function weakOrder(resist: number[]): string {
  if (resist.every((v) => v === resist[0])) return '';
  return ELEMENT_ORDER.map((el, i) => ({ el, v: resist[i], i })).sort((a, b) => b.v - a.v || a.i - b.i).map((x) => x.el).join('');
}

const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };

/** One row per name: [name, weak, maxHealth], merging same-named weenies by median. */
export function buildMonsterRows(all: CreatureFacts[]): Array<[string, string, number]> {
  const byName = new Map<string, CreatureFacts[]>();
  for (const c of all) { const l = byName.get(c.name); if (l) l.push(c); else byName.set(c.name, [c]); }
  const rows: Array<[string, string, number]> = [];
  for (const [name, cs] of byName) {
    const resist = ELEMENT_ORDER.map((_, i) => median(cs.map((c) => c.resist[i])));
    rows.push([name, weakOrder(resist), Math.round(median(cs.map((c) => c.maxHealth)))]);
  }
  return rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function fromSqlTree(dir: string): CreatureFacts[] {
  return [...sqlFiles(join(dir, 'Creature')), ...sqlFiles(join(dir, 'Cow'))].flatMap((f) => { const c = parseCreatureSql(readFileSync(f, 'utf8')); return c ? [c] : []; });
}

function fromClassicAce(): CreatureFacts[] {
  const pw = execFileSync('docker', ['exec', 'classicace-db', 'printenv', 'MYSQL_ROOT_PASSWORD'], { encoding: 'utf8' }).trim();
  const sql = (q: string): string[][] => execFileSync('docker', ['exec', 'classicace-db', 'mysql', '-uroot', `-p${pw}`, '-N', '-B', 'ace_world_customdm', '-e', q], { encoding: 'utf8', maxBuffer: 256 << 20 })
    .trim().split('\n').filter(Boolean).map((l) => l.split('\t'));
  // Plain single-table reads joined here (joins on weenie_properties_string run for minutes there).
  const creatures = new Set(sql('SELECT object_Id FROM weenie_properties_int WHERE type = 1 AND (value & 16) <> 0').map(([id]) => id));
  for (const [id] of sql("SELECT object_Id FROM weenie_properties_bool WHERE type = 19 AND value = 0")) creatures.delete(id);
  const names = new Map(sql('SELECT object_Id, value FROM weenie_properties_string WHERE type = 1').filter(([id]) => creatures.has(id)).map(([id, v]) => [id, v]));
  const resist = new Map<string, number[]>();
  for (const [id, type, value] of sql('SELECT object_Id, type, value FROM weenie_properties_float WHERE type BETWEEN 64 AND 70')) {
    if (!creatures.has(id)) continue;
    let r = resist.get(id);
    if (!r) resist.set(id, (r = ELEMENT_ORDER.map(() => 1)));
    r[RESIST_INDEX[Number(type)]] = Number(value);
  }
  const endurance = new Map(sql('SELECT object_Id, init_Level FROM weenie_properties_attribute WHERE type = 2').map(([id, v]) => [id, Number(v)]));
  const hp = new Map(sql('SELECT object_Id, init_Level, current_Level FROM weenie_properties_attribute_2nd WHERE type = 1').map(([id, i, c]) => [id, [Number(i), Number(c)]]));
  const out: CreatureFacts[] = [];
  for (const [id, name] of names) {
    const [init, current] = hp.get(id) ?? [0, 0];
    out.push({ name, resist: resist.get(id) ?? ELEMENT_ORDER.map(() => 1), maxHealth: maxHealthOf(init, current, endurance.get(id) ?? 0) });
  }
  return out;
}

function write(era: string, all: CreatureFacts[]): void {
  const rows = buildMonsterRows(all);
  // A module exporting the table as one JSON string (cheap to type-check; the bundle splits it into its own chunk).
  writeFileSync(join(OUT, `${era}.ts`), `// Generated by tools/build-monster-tables.ts from this era's world data; do not edit.\nexport default ${JSON.stringify(JSON.stringify(rows))};\n`);
  console.log(`${era}: ${rows.length} monster names from ${all.length} creature weenies`);
}

// Run only as a script (tests import the parser without regenerating anything).
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename);
const want = process.argv.slice(2);
const eras = !isMain ? [] : want.length ? want : ['eol', 'ac1999', 'dm'];
for (const era of eras) {
  if (era === 'eol') write('eol', fromSqlTree(join(ROOT, 'world-db-raw/ACE-World-16PY/Database/3-Core/9 WeenieDefaults/SQL')));
  else if (era === 'ac1999') write('ac1999', fromSqlTree(join(ROOT, 'reference/ac1999/Server/Database/AC1999-World/3-Core/9 WeenieDefaults/SQL')));
  else if (era === 'dm') write('dm', fromClassicAce());
}
