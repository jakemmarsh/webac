/**
 * VirindiTank's UseSpecialAmmo (docs/vtank-parity-gaps.md §7): "whether the macro should craft and use special
 * ammunition types. "Raider" indicates Raider Lightning ammo, and "SCurrency" indicates ammo from Colosseum,
 * Graveyard, and Paradox-touched Olthoi Infested Area" (the VTank wiki's Advanced Options page). VTank keeps its
 * own table; ours comes from each era's world data:
 *   - Raider (mask 1): ammunition named "Raider …" (Raider Lightning Arrow / Bolt / Atlatl Dart);
 *   - SCurrency (mask 2): ammunition whose arrowheads (or bundles) are sold only for an alternate currency
 *     (a vendor with PropertyDataId AlternateCurrency 57): Colosseum, Graveyard and Paradox-touched Olthoi
 *     vendors, and also Burning Sands and Gear Blade ammo, which the world sells the same way.
 * Ammunition is a weenie of WeenieType Ammunition (5).
 *
 *   end of retail  world-db-raw/ACE-World-16PY + ACE-World-16PY-Patches (a patch replaces a weenie)
 *   AC1999         reference/ac1999/Server/Database/AC1999-World
 *   Dark Majesty   the ClassicACE CustomDM world in its MySQL container
 *
 *   npx tsx tools/build-ammo-tables.ts [eol|ac1999|dm ...]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** [ammunition name, mask (1 Raider, 2 SCurrency)] */
export type SpecialAmmoRow = [string, number];

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'packages/renderer/src/agent/macro/specialAmmo');
const AMMO_KIND = /(Arrow|Quarrel|Atlatl Dart|Bolt)$/;

/** What one weenie's SQL says: its name, WeenieType, alternate currency and shop list. */
export interface WeenieFacts { wcid: number; name: string; type: number; altCurrency: boolean; shop: string[] }

export function parseWeenieSql(text: string): WeenieFacts | null {
  const w = /INSERT INTO `weenie` \([^)]*\)\s*VALUES \((\d+), *'[^']*', *(\d+)/.exec(text);
  if (!w) return null;
  const wcid = Number(w[1]);
  const name = new RegExp(`\\(${wcid}, +1, +'((?:[^']|'')*)'\\) /\\* Name \\*/`).exec(text)?.[1]?.replace(/''/g, "'") ?? '';
  const altCurrency = new RegExp(`\\(${wcid}, +57, +\\d+\\) /\\* AlternateCurrency`).test(text);
  const shop = [...text.matchAll(/\(\d+, +4, +\d+, [^)]*\) \/\* Create (.*?) \(\d+\) for Shop \*\//g)].map((m) => m[1]!);
  return { wcid, name, type: Number(w[2]), altCurrency, shop };
}

/** The ammunition family an alternate-currency shop item stocks ("Crate of Olthoi Acid Arrowheads" → "Olthoi Acid"). */
export function ammoFamily(shopItem: string): string | null {
  const s = shopItem.trim().replace(/^(Crate|Wrapped Bundle|Bundle) of /i, '');
  const m = /^(.+?) (Arrowheads|Arrow Bundle|Atlatl Dart Bundle|Bolt Bundle|Quarrel Bundle|Arrows|Quarrels|Atlatl Darts|Bolts|Arrow|Quarrel|Atlatl Dart|Bolt)$/i.exec(s);
  return m ? m[1]! : null;
}

/** The special-ammo rows from every weenie of a world. */
export function specialAmmo(weenies: Iterable<WeenieFacts>): SpecialAmmoRow[] {
  const all = [...weenies];
  const ammo = [...new Set(all.filter((w) => w.type === 5 && w.name).map((w) => w.name))];
  const families = new Set(all.filter((w) => w.altCurrency).flatMap((w) => w.shop.map(ammoFamily).filter((f): f is string => !!f)));
  const rows = new Map<string, number>();
  for (const name of ammo) {
    if (!AMMO_KIND.test(name)) continue;
    let mask = 0;
    if (/^Raider /i.test(name)) mask |= 1;
    for (const f of families) if (name.toLowerCase().startsWith(`${f.toLowerCase()} `)) mask |= 2;
    if (mask) rows.set(name, (rows.get(name) ?? 0) | mask);
  }
  return [...rows].sort((a, b) => a[0].localeCompare(b[0]));
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

/** Every weenie of SQL trees, later trees replacing earlier ones by wcid. */
function fromSqlTrees(dirs: string[]): WeenieFacts[] {
  const by = new Map<number, WeenieFacts>();
  for (const d of dirs) for (const f of sqlFiles(d)) { const w = parseWeenieSql(readFileSync(f, 'utf8')); if (w) by.set(w.wcid, w); }
  return [...by.values()];
}

function fromClassicAce(): WeenieFacts[] {
  const pw = execFileSync('docker', ['exec', 'classicace-db', 'printenv', 'MYSQL_ROOT_PASSWORD'], { encoding: 'utf8' }).trim();
  const sql = (q: string): string[][] => execFileSync('docker', ['exec', 'classicace-db', 'mysql', '-uroot', `-p${pw}`, '-N', '-B', 'ace_world_customdm', '-e', q], { encoding: 'utf8', maxBuffer: 64 << 20 })
    .trim().split('\n').filter(Boolean).map((l) => l.split('\t'));
  // Plain separate reads (a join on the names table runs for minutes there).
  const names = new Map(sql('SELECT object_Id, value FROM weenie_properties_string WHERE type = 1').map(([id, v]) => [Number(id), v!]));
  const types = new Map(sql('SELECT class_Id, type FROM weenie').map(([id, t]) => [Number(id), Number(t)]));
  const alt = new Set(sql('SELECT object_Id FROM weenie_properties_d_i_d WHERE type = 57').map(([id]) => Number(id)));
  const shops = new Map<number, string[]>();
  for (const [vendor, item] of sql('SELECT object_Id, weenie_Class_Id FROM weenie_properties_create_list WHERE destination_Type = 4')) {
    if (!alt.has(Number(vendor))) continue;
    const list = shops.get(Number(vendor)) ?? [];
    list.push(names.get(Number(item)) ?? '');
    shops.set(Number(vendor), list);
  }
  return [...types].map(([wcid, type]) => ({ wcid, name: names.get(wcid) ?? '', type, altCurrency: alt.has(wcid), shop: shops.get(wcid) ?? [] }));
}

function write(era: string, rows: SpecialAmmoRow[]): void {
  writeFileSync(join(OUT, `${era}.ts`), `// Generated by tools/build-ammo-tables.ts from this era's world data; do not edit.\n// [ammunition name, UseSpecialAmmo mask (1 Raider, 2 SCurrency)]\nexport default ${JSON.stringify(JSON.stringify(rows))};\n`);
  console.log(`${era}: ${rows.length} special ammunition`);
}

// Run only as a script (tests import the parsers without regenerating anything).
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename);
const want = process.argv.slice(2);
const eras = !isMain ? [] : want.length ? want : ['eol', 'ac1999', 'dm'];
for (const era of eras) {
  if (era === 'eol') write('eol', specialAmmo(fromSqlTrees([join(ROOT, 'world-db-raw/ACE-World-16PY/Database/3-Core/9 WeenieDefaults'), join(ROOT, 'world-db-raw/ACE-World-16PY-Patches/Database/Patches/9 WeenieDefaults')])));
  else if (era === 'ac1999') write('ac1999', specialAmmo(fromSqlTrees([join(ROOT, 'reference/ac1999/Server/Database/AC1999-World/3-Core/9 WeenieDefaults')])));
  else if (era === 'dm') write('dm', specialAmmo(fromClassicAce()));
}
