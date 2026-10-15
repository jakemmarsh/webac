/**
 * The readiness block's "spells you could have" line (tools/stream/prompt.ts readinessBrief). Jake, watching the
 * stream 2026-10-15: "is arcanist using item magic? armor doesnt seem buffed". Claude Arcanist had trained Item
 * Enchantment (166) and knew no Item Enchantment spell: training a school teaches nothing, its spells come from
 * scrolls (bought at a mage shop or an archmage, then `use`d), and he never bought one.
 *
 * Facts only: for each trained or specialized magic school, how many of its spells the character knows, the staple
 * families it lacks (by the DAT SpellTable's own names) and the ones it knows below the level its skill can learn.
 * ACE Player.CanReadScroll: a scroll of power 50..299 needs the school's current skill ≥ power − 50 (below 50 anyone
 * can read; 300+ is level VII and up, not bought from a shop); the level of a power is ACE SpellFormula's
 * (spellLevelFromPower / MIN_POWER_BY_LEVEL).
 */
import { fileURLToPath } from 'node:url';
import { MIN_POWER_BY_LEVEL } from '../../packages/shared/src/magic/SpellFormula.ts';

/** The magic schools by the SpellTable's school number (MagicSchool) and the skill / AgentSpell.school name. */
export const SCHOOLS = [
  { id: 1, name: 'War Magic' },
  { id: 2, name: 'Life Magic' },
  { id: 3, name: 'Item Enchantment' },
  { id: 4, name: 'Creature Enchantment' },
  { id: 5, name: 'Void Magic' },
] as const;
export type SchoolName = (typeof SCHOOLS)[number]['name'];

const BANES = ['Blade Bane', 'Piercing Bane', 'Bludgeon Bane', 'Flame Bane', 'Frost Bane', 'Acid Bane', 'Lightning Bane'];
const PROTECTIONS = ['Blade Protection', 'Piercing Protection', 'Bludgeoning Protection', 'Fire Protection', 'Cold Protection', 'Acid Protection', 'Lightning Protection'];
const ATTRIBUTES = ['Strength', 'Endurance', 'Coordination', 'Quickness', 'Focus', 'Willpower'];
const BOLTS = ['Flame Bolt', 'Frost Bolt', 'Acid Stream', 'Lightning Bolt', 'Force Bolt', 'Shock Wave', 'Whirling Blade'];

/** Families a player of that school carries, by family name (a spell name without "Aura of", Self / Other and its level). */
export const STAPLES: Record<SchoolName, string[]> = {
  'Item Enchantment': ['Impenetrability', ...BANES, 'Blood Drinker', 'Swift Killer', 'Heart Seeker', 'Defender', 'Spirit Drinker', 'Hermetic Link'],
  'Life Magic': ['Heal', 'Revitalize', 'Stamina to Mana', 'Armor', ...PROTECTIONS],
  'Creature Enchantment': [...ATTRIBUTES, 'Invulnerability', 'Impregnability', 'Magic Resistance'],
  'War Magic': BOLTS,
  'Void Magic': ['Nether Bolt', 'Nether Streak', 'Nether Arc', 'Destructive Curse', 'Festering Curse'],
};

/** Families that read as one group when every one of them is missing. */
const GROUPS: Array<{ label: string; members: string[] }> = [
  { label: 'the Banes', members: BANES },
  { label: 'the Protections', members: PROTECTIONS },
  { label: 'the attribute buffs', members: ATTRIBUTES },
];

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'];

/** "Aura of Blood Drinker Self III" → "Blood Drinker"; "Impenetrability IV" → "Impenetrability"; "Heal Self I" → "Heal". */
export function spellFamily(name: string): string {
  return name.trim()
    .replace(/^Aura of /, '')
    .replace(/ (?:I|II|III|IV|V|VI|VII|VIII|Incantation)$/, '')
    .replace(/ (?:Self|Other)$/, '');
}

/** The highest scroll level a school's skill can learn (CanReadScroll: power ≤ skill + 50; levels I–VI). */
export function learnableLevel(skill: number): number {
  let best = 1;
  for (let level = 1; level <= 6; level++) if (MIN_POWER_BY_LEVEL[level] <= skill + 50) best = level;
  return best;
}

/** Each trained or specialized magic school on the character sheet (GameUI.agentCharacterSheet) with its effective skill. */
export function magicSchools(sheet: string | null): Array<{ school: SchoolName; status: 'trained' | 'specialized'; skill: number }> {
  const out: Array<{ school: SchoolName; status: 'trained' | 'specialized'; skill: number }> = [];
  if (!sheet) return out;
  for (const m of sheet.matchAll(/^(Specialized|Trained) skills: (.+)$/gm)) {
    for (const s of SCHOOLS) {
      const hit = new RegExp(`(?:^|, )${s.name} (\\d+)`).exec(m[2]);
      if (hit) out.push({ school: s.name, status: m[1].toLowerCase() as 'trained' | 'specialized', skill: Number(hit[1]) });
    }
  }
  return out;
}

export interface KnownSpell { name: string; school: string; level?: number }
export interface TableSpell { name: string; school: number; power: number }

function joinList(names: string[], max = 4): string {
  return names.length > max ? `${names.slice(0, max).join(', ')}…` : names.join(', ');
}

/**
 * One "spells: …" line per trained or specialized magic school with a gap, nothing for a school that has its staples
 * at the level it can learn. `table` (the era's DAT SpellTable) keeps only the families the era has and gives their
 * names ("Aura of Blood Drinker" at end of retail); without it the family names are used as they are.
 */
export function spellGaps(sheet: string | null, known: readonly KnownSpell[] | null, table: readonly TableSpell[] | null): string[] {
  if (!known) return [];
  const out: string[] = [];
  for (const { school, status, skill } of magicSchools(sheet)) {
    const schoolId = SCHOOLS.find((s) => s.name === school)!.id;
    // The era's name for each family: its lowest-power spell's name, without Self / Other and the level.
    const names = new Map<string, string>();
    if (table) {
      const low = new Map<string, TableSpell>();
      for (const t of table) {
        if (t.school !== schoolId || t.power >= 300) continue;
        const f = spellFamily(t.name);
        if (STAPLES[school].includes(f) && (!low.has(f) || t.power < low.get(f)!.power)) low.set(f, t);
      }
      for (const [f, t] of low) names.set(f, t.name.replace(/ (?:I|II|III|IV|V|VI)$/, '').replace(/ (?:Self|Other)$/, ''));
    }
    const staples = STAPLES[school].filter((f) => !table || names.has(f));
    const display = (f: string): string => names.get(f) ?? f;
    const mine = known.filter((k) => k.school === school);
    const best = new Map<string, number>();
    for (const k of mine) {
      const f = spellFamily(k.name);
      best.set(f, Math.max(best.get(f) ?? 0, k.level ?? 1));
    }
    const cap = learnableLevel(skill);
    const missing = staples.filter((f) => !best.has(f));
    const low = staples.filter((f) => best.has(f) && best.get(f)! < cap);
    if (!missing.length && !low.length) continue;
    // Whole groups missing read as the group ("the Banes"), the rest by name.
    const groupOf = new Map<string, { label: string; first: string }>();
    for (const g of GROUPS) {
      const inSchool = g.members.filter((f) => staples.includes(f));
      if (inSchool.length > 1 && inSchool.every((f) => missing.includes(f))) for (const f of inSchool) groupOf.set(f, { label: g.label, first: inSchool[0] });
    }
    const ordered = missing.flatMap((f) => {
      const g = groupOf.get(f);
      return !g ? [display(f)] : g.first === f ? [g.label] : [];
    });
    const head = `spells: ${school} ${status} (${skill})`;
    const where = `you can learn up to level ${ROMAN[cap]}`;
    if (!mine.length) {
      out.push(`- ${head} but no ${school} spells known: buy and read scrolls at a mage shop (${joinList(ordered)}; ${where})`);
      continue;
    }
    const parts = [`${mine.length} ${school} spell${mine.length === 1 ? '' : 's'} known`];
    if (ordered.length) parts.push(`none of ${joinList(ordered)}`);
    if (low.length) parts.push(`below your level: ${joinList(low.map((f) => `${display(f)} (${ROMAN[best.get(f)!] || best.get(f)})`))}`);
    out.push(`- ${head}: ${parts.join('; ')}; ${where} from scrolls at a mage shop`);
  }
  return out;
}

/**
 * The era's spell table rows (name, school, power) from the portal DAT's SpellTable (0x0E00000E), read once on demand
 * as world-query's lore does; `ACJS_PORTAL_DAT` picks another era's portal.dat. Null when the DAT isn't there.
 */
export async function loadSpellTableRows(path = process.env.ACJS_PORTAL_DAT ?? fileURLToPath(new URL('../../dat/client_portal.dat', import.meta.url))): Promise<TableSpell[] | null> {
  const { existsSync } = await import('node:fs');
  if (!existsSync(path)) return null;
  try {
    const { DatDatabase } = await import('../../packages/dat-parser/src/DatDatabase.js');
    const { FileDatBytes } = await import('../../packages/dat-parser/src/node/FileDatBytes.js');
    const { DatReader } = await import('../../packages/dat-parser/src/DatReader.js');
    const { SpellTable } = await import('../../packages/dat-parser/src/file-types/SpellTable.js');
    const data = new DatDatabase(new FileDatBytes(path)).getFileData(0x0e00000e);
    return data ? [...new SpellTable(new DatReader(data)).spells.values()].map((s) => ({ name: s.name, school: s.school, power: s.power })) : null;
  } catch {
    return null;
  }
}
