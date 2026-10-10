// Regenerate packages/shared/src/enums/CharacterTitle.ts from ACE's
// CharacterTitle.cs so ids match the server EXACTLY — including the 22
// UNKNOWNGUESSEDNAME placeholder gaps ACE reserves (sweep 2026-06-11). ACE uses
// implicit C# numbering (Invalid=0, sequential); we emit explicit ids = index.
import fs from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const ACE = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/CharacterTitle.cs');
const OUT = resolve(REPO, 'packages/shared/src/enums/CharacterTitle.ts');

const cs = fs.readFileSync(ACE, 'utf8');
// Grab the body between `enum CharacterTitle : uint {` and the matching `}`.
const m = cs.match(/enum\s+CharacterTitle\s*:\s*uint\s*\{([\s\S]*?)\n\s*\}/);
if (!m) throw new Error('could not locate ACE enum body');
const body = m[1];
const names = [];
for (const raw of body.split('\n')) {
  let line = raw.replace(/\/\/.*$/, '').trim();   // strip // comments
  if (!line) continue;
  line = line.replace(/,\s*$/, '');               // strip trailing comma
  // must be a bare identifier (no explicit `= N` in ACE; guard anyway)
  const id = line.split('=')[0].trim();
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(id)) names.push(id);
}
if (names[0] !== 'Invalid') throw new Error(`expected Invalid first, got ${names[0]}`);

// Sanity anchors from the sweep finding.
const idx = (n) => names.indexOf(n);
const expect = { PerforatedKnight: 160, PestControl: 162, CosmicConscious: 893 };
for (const [n, v] of Object.entries(expect)) {
  if (idx(n) !== v) throw new Error(`anchor mismatch: ${n} expected ${v} got ${idx(n)}`);
}
console.error(`parsed ${names.length} members; anchors OK (PestControl=162, CosmicConscious=893)`);

const enumLines = names.map((n, i) => `  ${n} = ${i},`).join('\n');

const header = `/**
 * CharacterTitle — full enum port from ACE source.
 *
 * Source: reference/ACE/Source/ACE.Entity/Enum/CharacterTitle.cs.
 * AUTO-GENERATED — regenerate with tools/gen-character-title-enum.mjs.
 *
 * The C# enum has no explicit value assignments (sequential from Invalid=0),
 * but it RESERVES 22 \`UNKNOWNGUESSEDNAME###\` placeholder ids for titles the ACE
 * team could not name. Those gaps MUST be preserved or every title id after the
 * first gap (PestControl=162) drifts by 1..22 vs the server (sweep 2026-06-11).
 * The server sends raw TitleId over GameEventCharacterTitle; titleDisplayName()
 * resolves it, treating the placeholders as the "Title <id>" fallback.
 */
export enum CharacterTitle {
${enumLines}
}

/**
 * Render a CharacterTitle enum ID as a human-readable display name.
 *
 * ACE enum entries are PascalCase with lowercase connector words embedded
 * ("BaneoftheRemoran", "ChampionofSilyun"). Split on connectors + CamelCase.
 * Unknown ids and the reserved UNKNOWNGUESSEDNAME placeholders fall back to
 * 'Title <id>'.
 */
export function titleDisplayName(id: number): string {
  const name = CharacterTitle[id];
  if (!name || name === 'Invalid' || name.startsWith('UNKNOWNGUESSEDNAME')) return \`Title \${id}\`;
  let s: string = name;
  s = s.replace(/ofthe/g, ' of the ');
  s = s.replace(/andthe/g, ' and the ');
  s = s.replace(/(?<=[a-z])(of|and|the|by|for|to)(?=[A-Z])/g, ' $1 ');
  s = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return s.replace(/\\s+/g, ' ').trim();
}
`;

fs.writeFileSync(OUT, header);
console.error(`wrote ${OUT} (${names.length} members)`);
