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

/**
 * The magic schools by the SpellTable's school number (MagicSchool), the skill name the character sheet uses, and the
 * short name the agent API's `spells` reports (main.ts schoolName: "War", "Life", "Item", "Creature", "Void").
 */
export const SCHOOLS = [
  { id: 1, name: 'War Magic', short: 'War' },
  { id: 2, name: 'Life Magic', short: 'Life' },
  { id: 3, name: 'Item Enchantment', short: 'Item' },
  { id: 4, name: 'Creature Enchantment', short: 'Creature' },
  { id: 5, name: 'Void Magic', short: 'Void' },
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

export interface KnownSpell { name: string; school: string; level?: number; id?: number; buff?: boolean }
/** A DAT SpellTable row; `id` (the spell id) names the scroll that teaches it (a scroll's PropertyDataId 28). */
export interface TableSpell { name: string; school: number; power: number; id?: number }

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
    const short = SCHOOLS.find((s) => s.name === school)!.short;
    const mine = known.filter((k) => k.school === short || k.school === school);
    const best = new Map<string, number>();
    for (const k of mine) {
      const f = spellFamily(k.name);
      best.set(f, Math.max(best.get(f) ?? 0, k.level ?? 1));
    }
    const cap = learnableLevel(skill);
    const missing = staples.filter((f) => !best.has(f));
    const low = staples.filter((f) => best.has(f) && best.get(f)! < cap);
    if (!missing.length && !low.length) continue;
    // Whole groups missing read as the group ("the Banes"), the rest by name; likewise a whole group known only at
    // one lower level ("the Banes (V)").
    const grouped = (fams: string[], same: (f: string) => string | number): string[] => {
      const groupOf = new Map<string, { label: string; first: string }>();
      for (const g of GROUPS) {
        const inSchool = g.members.filter((f) => staples.includes(f));
        if (inSchool.length > 1 && inSchool.every((f) => fams.includes(f) && same(f) === same(inSchool[0]))) for (const f of inSchool) groupOf.set(f, { label: g.label, first: inSchool[0] });
      }
      return fams.flatMap((f) => {
        const g = groupOf.get(f);
        return !g ? [f] : g.first === f ? [`@${g.label}@${f}`] : [];
      });
    };
    const label = (x: string): string => (x.startsWith('@') ? x.split('@')[1] : display(x));
    const famOf = (x: string): string => (x.startsWith('@') ? x.split('@')[2] : x);
    const ordered = grouped(missing, () => 0).map(label);
    const head = `spells: ${school} ${status} (${skill})`;
    const where = `you can learn up to level ${ROMAN[cap]}`;
    if (!mine.length) {
      out.push(`- ${head} but no ${school} spells known: buy and read scrolls at a mage shop (${joinList(ordered)}; ${where})`);
      continue;
    }
    // What is missing and what is known only at a lower level are said apart: Arcanist read "below your level:
    // Impenetrability (V), Blade Bane (V)…" beside a stale goal line as "you lack Item spells" while he knew every
    // Bane and Impenetrability at V (stream, 2026-10-17 06:14Z report).
    const parts = [`${mine.length} ${school} spell${mine.length === 1 ? '' : 's'} known${ordered.length ? '' : ', every staple family among them'}`];
    if (ordered.length) parts.push(`not known at all: ${joinList(ordered)}`);
    if (low.length) {
      const lvl = (f: string): string => ROMAN[best.get(f)!] || String(best.get(f));
      parts.push(`known, but below the level ${ROMAN[cap]} you can learn: ${joinList(grouped(low, lvl).map((x) => `${label(x)} (${lvl(famOf(x))})`), 5)}`);
    }
    out.push(`- ${head}: ${parts.join('; ')}; ${low.length && !ordered.length ? `level ${ROMAN[cap]} scrolls are sold at mage shops` : `${where} from scrolls at a mage shop`}`);
  }
  return out;
}

// ── your own buffs: the Self versions ──

/** Families whose Self spell is no buff (an instant heal or a transfer), when the spell list can't say (no `buff` flag). */
const NOT_BUFFS = new Set(['Heal', 'Revitalize', 'Stamina to Mana', 'Stamina to Health', 'Health to Mana', 'Health to Stamina', 'Mana to Health', 'Mana to Stamina', 'Mana Boost', 'Drain Health', 'Drain Mana', 'Drain Stamina']);

const SELF_LEVEL = /^(.*) Self(?: (I|II|III|IV|V|VI|VII|VIII))?$/;
const ROMAN_VALUE: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8 };

/** One buff the character casts on itself at a lower Self level than its skill can learn. */
export interface SelfBuffGap {
  /** The family ("Strength", "Defender") and its era name without Self and the level ("Aura of Defender"). */
  family: string;
  display: string;
  school: SchoolName;
  skill: number;
  /** The highest Self level known, the highest Self level the skill can learn, and the highest Other level known (0: none). */
  self: number;
  cap: number;
  other: number;
  /** The Self levels above `self` up to `cap` (highest first): each one's name and spell ids (the scroll that teaches it carries the id). */
  upgrades: Array<{ level: number; name: string; ids: number[] }>;
}

/**
 * The buffs a character casts on itself below the Self level its skill can learn (Player.CanReadScroll, the rule
 * spellGaps uses: a scroll of power 50..299 needs the school's skill ≥ power − 50). Self and Other are apart here:
 * spellGaps counts a family by its best level of either, so Arcanist's Strength, Quickness and Coordination read as
 * known at V (their Other V, cast on Bulwark) while his routine cast Self I on himself, the highest Self he knew, with
 * Aura of Defender Self I and Impregnability Self I likewise (Jake, 2026-10-18: "why is arcanist using level 1
 * spells"). `table` (the era's DAT SpellTable) gives each level's power, name and ids; without it the level a skill
 * can learn is learnableLevel's and no ids are known.
 */
export function selfBuffGaps(sheet: string | null, known: readonly KnownSpell[] | null, table: readonly TableSpell[] | null): SelfBuffGap[] {
  if (!known) return [];
  const schools = new Map(magicSchools(sheet).map((m) => [m.school, m.skill] as [SchoolName, number]));
  const schoolOf = (k: KnownSpell): (typeof SCHOOLS)[number] | undefined => SCHOOLS.find((s) => s.short === k.school || s.name === k.school);
  const levelOf = (k: KnownSpell): number => k.level ?? ROMAN_VALUE[SELF_LEVEL.exec(k.name)?.[2] ?? 'I'] ?? 1;
  const selfBest = new Map<string, { school: (typeof SCHOOLS)[number]; level: number; base: string }>();
  const otherBest = new Map<string, number>();
  for (const k of known) {
    const sc = schoolOf(k);
    if (!sc) continue;
    const fam = spellFamily(k.name);
    if (/ Other(?: [IVX]+)?$/.test(k.name)) { otherBest.set(`${sc.id}|${fam}`, Math.max(otherBest.get(`${sc.id}|${fam}`) ?? 0, levelOf(k))); continue; }
    const m = SELF_LEVEL.exec(k.name);
    if (!m || k.buff === false || (k.buff === undefined && NOT_BUFFS.has(fam))) continue;
    const key = `${sc.id}|${fam}`;
    const lv = levelOf(k);
    if (!selfBest.has(key) || selfBest.get(key)!.level < lv) selfBest.set(key, { school: sc, level: lv, base: m[1] });
  }
  const out: SelfBuffGap[] = [];
  for (const [key, b] of selfBest) {
    const skill = schools.get(b.school.name);
    if (skill === undefined) continue; // not trained: no scroll of it above level I can be read
    const fam = key.slice(key.indexOf('|') + 1);
    // Each Self level of the family in the era's table: its power decides who can read the scroll.
    const levels = new Map<number, { name: string; ids: number[]; power: number }>();
    for (const t of table ?? []) {
      if (t.school !== b.school.id || t.power >= 300 || spellFamily(t.name) !== fam || !SELF_LEVEL.test(t.name)) continue;
      const lv = ROMAN_VALUE[SELF_LEVEL.exec(t.name)![2] ?? 'I'] ?? 1;
      const e = levels.get(lv) ?? { name: t.name, ids: [], power: t.power };
      if (t.id !== undefined) e.ids.push(t.id);
      levels.set(lv, e);
    }
    const readable = (power: number): boolean => power < 50 || skill >= power - 50;
    const cap = levels.size ? Math.max(0, ...[...levels].filter(([, e]) => readable(e.power)).map(([lv]) => lv)) : learnableLevel(skill);
    if (cap <= b.level) continue;
    const display = (levels.get(cap)?.name ?? `${b.base} Self`).replace(SELF_LEVEL, '$1');
    const upgrades = [...levels].filter(([lv]) => lv > b.level && lv <= cap).sort((x, y) => y[0] - x[0]).map(([level, e]) => ({ level, name: e.name, ids: e.ids }));
    out.push({ family: fam, display, school: b.school.name, skill, self: b.level, cap, other: otherBest.get(key) ?? 0, upgrades });
  }
  return out.sort((a, b) => SCHOOLS.findIndex((s) => s.name === a.school) - SCHOOLS.findIndex((s) => s.name === b.school) || a.display.localeCompare(b.display));
}

/** "A, B and C". */
export function andList(names: readonly string[]): string {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * "- your own buffs: Strength, Quickness, Coordination and Impregnability are at Self I, though you can learn up to Self
 * V (your Creature Enchantment 205); …; you know Other V of Strength, Quickness and Coordination, which go on another
 * (Claude Bulwark), not on you". With no magic school trained (`magic` false) it says so; nothing without a gap.
 */
export function selfBuffLine(gaps: readonly SelfBuffGap[], o: { magic: boolean; partner?: string }): string | null {
  if (!o.magic) return '- your own buffs: no magic school trained or specialized, so you cast none on yourself';
  if (!gaps.length) return null;
  const groups = new Map<string, SelfBuffGap[]>();
  for (const g of gaps) {
    const k = `${g.self}|${g.cap}|${g.school}|${g.skill}`;
    groups.set(k, [...(groups.get(k) ?? []), g]);
  }
  const parts = [...groups.values()].map((gs) => {
    const g = gs[0];
    return `${andList(gs.map((x) => x.display))} ${gs.length === 1 ? 'is' : 'are'} at Self ${ROMAN[g.self]}, though you can learn up to Self ${ROMAN[g.cap]} (your ${g.school} ${g.skill})`;
  });
  const higherOther = gaps.filter((g) => g.other > g.self);
  if (higherOther.length) {
    const byLevel = new Map<number, string[]>();
    for (const g of higherOther) byLevel.set(g.other, [...(byLevel.get(g.other) ?? []), g.display]);
    const known = [...byLevel].sort((a, b) => b[0] - a[0]).map(([lv, names]) => `Other ${ROMAN[lv]} of ${andList(names)}`);
    parts.push(`you know ${andList(known)}, which go on someone else${o.partner ? ` (${o.partner})` : ''}, not on you`);
  }
  return `- your own buffs: ${parts.join('; ')}`;
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
    return data ? [...new SpellTable(new DatReader(data)).spells].map(([id, s]) => ({ id, name: s.name, school: s.school, power: s.power })) : null;
  } catch {
    return null;
  }
}
