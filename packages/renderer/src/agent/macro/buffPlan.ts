/**
 * VirindiTank's automatic buff list (docs/vtank-macro-behavior.md §7, §10).
 *
 * VTank "automatically buffs every Attribute and Skill you have trained, as
 * well as every Protection and Bane" (wiki, Standard Options). For each
 * family it casts the best level you can: the highest power whose
 * power + SpellDiffExcessThreshold-Buff is within your buffed skill in that
 * spell's school (FAQ). Extra Buff Spells add a family (the best similar is
 * used), Blacklisted Buff Families remove one, and BuffProfile_Prots /
 * BuffProfile_Banes (with the BuffProfile-Prots / -Banes letters for Custom)
 * pick the elements. A buff is due with less than RebuffTimeRemainingSeconds
 * left, or, when idle with IdleBuffTopoff on, less than
 * IdleBuffTopoffTimeSeconds.
 *
 * Families come from the active era's own spell table, never from spell
 * names typed here: a family is a spell-table category, and what it buffs is
 * read from its members' descriptions ("Increases the caster's Strength by
 * 10 points.", "Reduces damage the target takes from Acid by 10%",
 * "Increases a shield or piece of armor's resistance to acid damage by
 * 10%"). Those sentences are the same in the end-of-retail, Dark Majesty and
 * 1999 tables, and they name skills as that era does (Heavy Weapons at end of
 * retail, Sword in the classic and 1999 tables), so a family resolves to the
 * era's own skill. The DAT carries no stat-mod field (that is server data,
 * ACE's world-DB `spell.stat_Mod_Type` / `stat_Mod_Key`); the tests check the
 * description-derived targets against it.
 *
 * Inference (marked INF in the behaviour doc, §11 item 5): which non-skill
 * creature/life buffs VTank counts as "always" (here: all six attributes,
 * natural armor and the three regeneration buffs; not max-vital buffs), and
 * which weapon auras it keeps (here: by the wielded weapon's kind).
 */
import { vtOption } from '@ac/shared';
import type { PlanEnchantment, PlanSkill, PlanSpell } from '@ac/shared';

// ── what a family buffs ──

/** The damage elements prots and banes are chosen by, as VTank's letters (A acid, L lightning, F fire, C cold, B bludgeon, P pierce, S slash). */
export type BuffElement = 'A' | 'L' | 'F' | 'C' | 'B' | 'P' | 'S';
export type Vital = 'health' | 'stamina' | 'mana';
/** A weapon or caster aura, by what it raises. */
export type WeaponAura = 'damage' | 'speed' | 'attack' | 'defense' | 'manaConversion' | 'elemental';

export type BuffTarget =
  /** An attribute, by the spell table's own word for it (Strength … Self). */
  | { kind: 'attribute'; attribute: string }
  /** A skill, by the spell table's name for it; `skillId` once resolved against the era's skill table. */
  | { kind: 'skill'; skill: string; skillId?: number }
  | { kind: 'vitalMax'; vital: Vital }
  | { kind: 'vitalRegen'; vital: Vital }
  /** "Reduces damage the target takes from …". */
  | { kind: 'protection'; element: BuffElement }
  /** "Increases a shield or piece of armor's resistance to … damage" (Item Enchantment, cast on armor). */
  | { kind: 'bane'; element: BuffElement }
  /** "Improves a shield or piece of armor's armor value" (Impenetrability). */
  | { kind: 'armorValue' }
  /** "Increases the caster's natural armor" (Armor Self). */
  | { kind: 'naturalArmor' }
  | { kind: 'weapon'; aura: WeaponAura }
  | { kind: 'other' };

export interface BuffFamily {
  /** The spell table's category: every spell of the family shares it. */
  category: number;
  /** The spell table's school (1 war, 2 life, 3 item, 4 creature, 5 void). */
  school: number;
  target: BuffTarget;
  /** Members whose own description names a different target (e.g. a quest spell filed in the family's category): never chosen for it. */
  exclude: Set<number>;
}

export interface BuffFamilies {
  byCategory: Map<number, BuffFamily>;
  /** Lower-cased spell name → category, so an Extra / Blacklisted name finds its family even when you know another level. */
  byName: Map<string, number>;
}

/** The attribute words a description can name (ACE PropertyAttribute: Strength, Endurance, Quickness, Coordination, Focus, Self). */
const ATTRIBUTES = ['strength', 'endurance', 'quickness', 'coordination', 'focus', 'self'];

/** A description's element word → VTank's letter. The tables use both "lightning" and "electric", "cold" and "frost". */
function elementLetter(word: string): BuffElement | null {
  const w = word.toLowerCase();
  if (w.startsWith('acid')) return 'A';
  if (w.startsWith('lightning') || w.startsWith('electric')) return 'L';
  if (w.startsWith('fire') || w.startsWith('flame')) return 'F';
  if (w.startsWith('cold') || w.startsWith('frost')) return 'C';
  if (w.startsWith('bludgeon')) return 'B';
  if (w.startsWith('pierc')) return 'P';
  if (w.startsWith('slash') || w.startsWith('blade')) return 'S';
  return null;
}

/**
 * Skill names the tables spell two ways. The creature tables call skill 27
 * "Assess Monster" in the Monster Attunement family's text and "Assess
 * Creature" elsewhere; the end-of-retail and classic skill tables name it
 * Assess Creature.
 */
const SKILL_NAME_ALIASES: Record<string, string> = { 'assess monster': 'assess creature' };
const normSkill = (s: string): string => {
  const n = s.trim().toLowerCase().replace(/\s+/g, ' ');
  return SKILL_NAME_ALIASES[n] ?? n;
};

const WHO = String.raw`(?:the target's|the caster's|target's|caster's|casters|your)`;

/** What one spell description says the spell raises, from its first sentence that says. */
export function describeBuffTarget(desc: string): BuffTarget {
  const sentences = desc.split(/(?<=[.!])\s+/);
  for (const s of sentences) {
    const t = sentenceTarget(s);
    if (t) return t;
  }
  return { kind: 'other' };
}

function sentenceTarget(s: string): BuffTarget | null {
  let m: RegExpMatchArray | null;
  if ((m = s.match(/shield or piece of armor's resistance to (\w+) damage/i))) {
    const e = elementLetter(m[1]);
    return e ? { kind: 'bane', element: e } : null;
  }
  if (/shield or piece of armor's armor value/i.test(s)) return { kind: 'armorValue' };
  if ((m = s.match(/damage (?:the )?(?:target|caster|you) takes? from (\w+)/i))) {
    const e = elementLetter(m[1]);
    return e ? { kind: 'protection', element: e } : null;
  }
  if (new RegExp(`${WHO} natural armor`, 'i').test(s)) return { kind: 'naturalArmor' };
  if ((m = s.match(/increases? maximum (health|stamina|mana)\b/i))) return { kind: 'vitalMax', vital: m[1].toLowerCase() as Vital };
  if ((m = s.match(/rate at which the (?:target|caster) regains (health|stamina|mana)\b/i))) return { kind: 'vitalRegen', vital: m[1].toLowerCase() as Vital };
  if (/natural healing rate/i.test(s)) return { kind: 'vitalRegen', vital: 'health' };
  if (/natural mana rate/i.test(s)) return { kind: 'vitalRegen', vital: 'mana' };
  if (/weapon's damage value/i.test(s)) return { kind: 'weapon', aura: 'damage' };
  if (/weapon's speed|speed of a weapon/i.test(s)) return { kind: 'weapon', aura: 'speed' };
  if (/weapon's attack skill modifier|offense bonus of a weapon/i.test(s)) return { kind: 'weapon', aura: 'attack' };
  if (/melee defense skill modifier of a weapon|weapon's defense skill modifier/i.test(s)) return { kind: 'weapon', aura: 'defense' };
  if (/mana conversion bonus/i.test(s)) return { kind: 'weapon', aura: 'manaConversion' };
  if (/elemental damage bonus of an elemental magic caster/i.test(s)) return { kind: 'weapon', aura: 'elemental' };
  if ((m = s.match(new RegExp(`^(?:increases|boosts|raises)\\s+${WHO}\\s+([a-z][a-z' ]*?)\\s+skill\\s+by\\b`, 'i')))) {
    return { kind: 'skill', skill: m[1].trim() };
  }
  if ((m = s.match(new RegExp(`^increases\\s+${WHO}\\s+(\\w+)\\s+by\\s+\\d`, 'i'))) && ATTRIBUTES.includes(m[1].toLowerCase())) {
    return { kind: 'attribute', attribute: m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() };
  }
  return null;
}

const targetKey = (t: BuffTarget): string => {
  switch (t.kind) {
    case 'attribute': return `attribute:${t.attribute.toLowerCase()}`;
    case 'skill': return `skill:${normSkill(t.skill)}`;
    case 'vitalMax': case 'vitalRegen': return `${t.kind}:${t.vital}`;
    case 'protection': case 'bane': return `${t.kind}:${t.element}`;
    case 'weapon': return `weapon:${t.aura}`;
    default: return t.kind;
  }
};

interface SpellRow { name: string; category: number; school: number; bitfield: number; power: number; duration?: number; desc?: string }

/** SpellFlags.Beneficial (ACE ACE.Entity/Enum/SpellFlags.cs). */
const BENEFICIAL = 0x4;

/**
 * Every buff family of a spell table: one per category of beneficial
 * enchantments. A family's target is what most of its members' descriptions
 * name (a category also holds a few quest spells whose text is flavour).
 * `skillNames` (the era's SkillTable 0x0E000004: id → name) resolves skill
 * families to ids; without it planBuffs matches skills by name.
 */
export function buildBuffFamilies(
  spellTable: { spells: Map<number, SpellRow> },
  skillNames?: Iterable<[number, string]>,
): BuffFamilies {
  const skillIdByName = new Map<string, number>();
  for (const [id, name] of skillNames ?? []) skillIdByName.set(normSkill(name), id);

  const groups = new Map<number, Array<{ id: number; s: SpellRow; t: BuffTarget }>>();
  const byName = new Map<string, number>();
  for (const [id, s] of spellTable.spells) {
    if (!(s.bitfield & BENEFICIAL) || s.category === 0) continue;
    // Boosts and transfers have no duration; an enchantment does (when the reader gave one).
    if (s.duration !== undefined && !(s.duration > 0)) continue;
    const t = describeBuffTarget(s.desc ?? '');
    let g = groups.get(s.category);
    if (!g) groups.set(s.category, (g = []));
    g.push({ id, s, t });
    byName.set(s.name.trim().toLowerCase(), s.category);
  }

  const byCategory = new Map<number, BuffFamily>();
  for (const [category, members] of groups) {
    const votes = new Map<string, { t: BuffTarget; n: number }>();
    for (const m of members) {
      if (m.t.kind === 'other') continue;
      const k = targetKey(m.t);
      const v = votes.get(k);
      if (v) v.n++; else votes.set(k, { t: m.t, n: 1 });
    }
    let best: { t: BuffTarget; n: number } | undefined;
    let parsed = 0;
    for (const v of votes.values()) { parsed += v.n; if (!best || v.n > best.n) best = v; }
    // A category with no majority holds many buffs (e.g. end of retail's Weave cantrips, one category for every skill): not one family.
    let target: BuffTarget = best && best.n * 2 > parsed ? { ...best.t } : { kind: 'other' };
    if (target.kind === 'skill') {
      const id = skillIdByName.get(normSkill(target.skill));
      target = id !== undefined ? { ...target, skillId: id } : target;
    }
    const key = targetKey(target);
    const exclude = new Set<number>();
    for (const m of members) if (m.t.kind !== 'other' && targetKey(m.t) !== key) exclude.add(m.id);
    // The family's school: its members' most common one.
    const schools = new Map<number, number>();
    for (const m of members) schools.set(m.s.school, (schools.get(m.s.school) ?? 0) + 1);
    const school = [...schools].sort((a, b) => b[1] - a[1])[0][0];
    byCategory.set(category, { category, school, target, exclude });
  }
  return { byCategory, byName };
}

// ── the plan ──

export interface BuffPlanInput {
  spells: PlanSpell[];               // spells you know
  skills: PlanSkill[];               // your skills (AC skill ids; ACE ACE.Entity/Enum/Skill.cs)
  active: PlanEnchantment[];         // enchantments on you now
  settings: Record<string, string | number | boolean>;  // VTank option names (vtOption canonical), our units
  extraBuffs: string[]; blacklistedBuffs: string[];     // spell names (each names a family)
  idle: boolean;
  /** category -> what it buffs; built once from the spell table by buildBuffFamilies */
  families: BuffFamilies;
  /** Your character level, for BuffWithUntrained-* (untrained schools stop buffing above it). Unknown: untrained schools are used. */
  level?: number;
  /** The wielded weapon's kind, for the weapon auras; none or unknown: no auras. */
  wielded?: 'melee' | 'missile' | 'caster' | null;
}

export interface PlannedBuff { spell: PlanSpell; target: 'self' | 'weapon' | 'shield' | 'armor'; why: string; remaining: number | null }

/** Weapon auras by wielded kind (INF): melee and missile weapons take damage, speed, attack and defense; casters mana conversion, elemental damage and defense. */
const AURAS: Record<'melee' | 'missile' | 'caster', WeaponAura[]> = {
  melee: ['damage', 'speed', 'attack', 'defense'],
  missile: ['damage', 'speed', 'attack', 'defense'],
  caster: ['manaConversion', 'elemental', 'defense'],
};

/** The plan's order: creature first, then life, then item (attributes, skills, vitals, armor, prots, banes, weapon). */
const KIND_ORDER: BuffTarget['kind'][] = ['attribute', 'skill', 'vitalRegen', 'vitalMax', 'naturalArmor', 'protection', 'bane', 'armorValue', 'weapon', 'other'];

/** The school a PlanSpell names, as the spell table's number. */
const SCHOOL_NAMES: Record<string, number> = { 'war magic': 1, 'life magic': 2, 'item enchantment': 3, 'creature enchantment': 4, 'void magic': 5 };

function setting(settings: Record<string, string | number | boolean>, name: string): string | number | boolean {
  const opt = vtOption(name);
  const want = (opt?.name ?? name).toLowerCase();
  for (const [k, v] of Object.entries(settings)) {
    if (k.toLowerCase() === want || vtOption(k)?.name.toLowerCase() === want) return v;
  }
  return opt?.default ?? '';
}
const num = (v: string | number | boolean, d: number): number => {
  const n = typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : Number(v);
  return Number.isFinite(n) ? n : d;
};
const bool = (v: string | number | boolean): boolean => v === true || v === 1 || (typeof v === 'string' && /^(true|1|yes|on)$/i.test(v.trim()));

/** The elements a prot or bane profile keeps: its enum value's letters (vtankOptions' values), All, None, or the Custom letter string. */
function profileElements(settings: Record<string, string | number | boolean>, enumName: string, lettersName: string): Set<BuffElement> {
  const opt = vtOption(enumName);
  const v = Math.round(num(setting(settings, enumName), Number(opt?.default ?? 2)));
  const label = opt?.values?.[v] ?? 'All';
  const letters = label === 'All' ? 'ALFCBPS' : label === 'None' ? '' : label === 'Custom' ? String(setting(settings, lettersName)) : label;
  const out = new Set<BuffElement>();
  for (const ch of letters.toUpperCase()) if ('ALFCBPS'.includes(ch)) out.add(ch as BuffElement);
  return out;
}

const trained = (s: PlanSkill | undefined): boolean => !!s && (s.training === 'trained' || s.training === 'specialized');

/**
 * The buffs you want up (`wanted`, one per family you can cast) and those to
 * cast now (`due`), in plan order. With Enable Buffing off nothing is due.
 */
export function planBuffs(input: BuffPlanInput): { wanted: PlannedBuff[]; due: PlannedBuff[] } {
  const { families, settings } = input;
  const threshold = num(setting(settings, 'SpellDiffExcessThreshold-Buff'), 5);
  const rebuffAt = num(setting(settings, 'RebuffTimeRemainingSeconds'), 300);
  const topoffAt = num(setting(settings, 'IdleBuffTopoffTimeSeconds'), 1200);
  const topoff = input.idle && bool(setting(settings, 'IdleBuffTopoff'));
  const prots = profileElements(settings, 'BuffProfile_Prots', 'BuffProfile-Prots');
  const banes = profileElements(settings, 'BuffProfile_Banes', 'BuffProfile-Banes');
  const untrainedLevel: Record<number, number> = {
    2: num(setting(settings, 'BuffWithUntrained-Life'), 80),
    3: num(setting(settings, 'BuffWithUntrained-Item'), 80),
    4: num(setting(settings, 'BuffWithUntrained-Creature'), 80),
  };

  const skillById = new Map(input.skills.map((s) => [s.id, s]));
  const skillByName = new Map(input.skills.map((s) => [normSkill(s.name), s]));
  const skillFor = (t: { skill: string; skillId?: number }): PlanSkill | undefined =>
    (t.skillId !== undefined ? skillById.get(t.skillId) : undefined) ?? skillByName.get(normSkill(t.skill));

  const familyOfName = (name: string): number | undefined => {
    const n = name.trim().toLowerCase();
    return families.byName.get(n) ?? input.spells.find((s) => s.name.trim().toLowerCase() === n)?.category;
  };
  const blacklisted = new Set(input.blacklistedBuffs.map(familyOfName).filter((c): c is number => c !== undefined));
  const extra = new Set(input.extraBuffs.map(familyOfName).filter((c): c is number => c !== undefined));

  // Why a family is wanted, or null.
  const wantFamily = (f: BuffFamily): string | null => {
    if (blacklisted.has(f.category)) return null;
    if (extra.has(f.category)) return 'Extra Buff Spells';
    const t = f.target;
    switch (t.kind) {
      case 'attribute': return `attribute ${t.attribute}`;
      case 'skill': { const s = skillFor(t); return trained(s) ? `trained skill ${s!.name}` : null; }
      case 'vitalRegen': return `${t.vital} regeneration`;
      case 'naturalArmor': return 'natural armor';
      case 'protection': return prots.has(t.element) ? `protection ${t.element}` : null;
      case 'bane': return banes.has(t.element) ? `bane ${t.element}` : null;
      case 'armorValue': return banes.size > 0 ? 'armor value' : null;
      case 'weapon': return input.wielded && AURAS[input.wielded].includes(t.aura) ? `weapon aura ${t.aura}` : null;
      default: return null;
    }
  };

  // Your buffed skill in a school, or null when that school may not buff.
  const schoolSkill = (schoolName: string): number | null => {
    const sk = skillByName.get(normSkill(schoolName));
    if (!sk) return null;
    if (!trained(sk)) {
      const lim = untrainedLevel[SCHOOL_NAMES[schoolName.trim().toLowerCase()] ?? 0];
      if (lim !== undefined && input.level !== undefined && input.level > lim) return null;
    }
    return sk.buffed;
  };

  const byCategory = new Map<number, PlanSpell[]>();
  for (const s of input.spells) {
    if (!s.buff) continue;
    let l = byCategory.get(s.category);
    if (!l) byCategory.set(s.category, (l = []));
    l.push(s);
  }

  const wanted: Array<PlannedBuff & { order: number }> = [];
  for (const [category, known] of byCategory) {
    const f = families.byCategory.get(category);
    if (!f) continue;
    const why = wantFamily(f);
    if (!why) continue;
    let best: PlanSpell | undefined;
    for (const s of known) {
      if (f.exclude.has(s.id)) continue;
      const skill = schoolSkill(s.school);
      if (skill === null || s.power + threshold > skill) continue;
      if (!best || s.power > best.power || (s.power === best.power && s.self && !best.self)) best = s;
    }
    if (!best) continue;
    const t = f.target.kind;
    const target: PlannedBuff['target'] = t === 'bane' || t === 'armorValue' ? 'armor' : t === 'weapon' ? 'weapon' : 'self';
    wanted.push({ spell: best, target, why, remaining: remainingFor(input.active, category, input.spells, best), order: KIND_ORDER.indexOf(t) });
  }
  wanted.sort((a, b) => a.order - b.order || a.spell.category - b.spell.category);
  const out: PlannedBuff[] = wanted.map(({ order: _o, ...b }) => b);

  if (!bool(setting(settings, 'EnableBuffing'))) return { wanted: out, due: [] };
  const due = out.filter((b) => b.remaining === null || b.remaining < rebuffAt || (topoff && b.remaining < topoffAt));
  return { wanted: out, due };
}

/**
 * Seconds left on the family's enchantment, or null when none is up. An
 * enchantment counts when it is of the same category (by its own category,
 * or the spell id / name of a spell you know in it) and is not weaker than
 * the planned spell (INF: a weaker one is replaced by the better level).
 */
function remainingFor(active: PlanEnchantment[], category: number, spells: PlanSpell[], planned: PlanSpell): number | null {
  let best: number | null = null;
  for (const e of active) {
    let cat = e.category;
    let power = e.power;
    if (cat === undefined) {
      const s = spells.find((x) => (e.spellId !== undefined && x.id === e.spellId) || x.name.toLowerCase() === e.name.toLowerCase());
      cat = s?.category;
      power ??= s?.power;
    }
    if (cat !== category) continue;
    if (power !== undefined && power < planned.power) continue;
    if (best === null || e.remaining > best) best = e.remaining;
  }
  return best;
}
