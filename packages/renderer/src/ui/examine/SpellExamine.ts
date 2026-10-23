/**
 * SpellExamine — the examination window's spell page (layout 0x2100006b,
 * page 0x10000153), as SpellExamineUI::ExamineSpell @ 004b6210 fills it.
 *
 * Ground truth (decompiled EoL client, build ac1_sep13):
 *  - Title (0x1000012d): CSpellBase::InqName, no stack prefix.
 *  - School 0x1000015e: "School: " + SchoolEnumToName @ 00597400.
 *  - Mana 0x10000160 (left of the shared row): SetManaText @ 004b5e40 —
 *    "Mana: " + base mana with commas ("0" when < 1), then
 *    " + %d per target" when mana_mod > 0. No Mana Conversion adjustment.
 *  - Duration 0x10000161 (right of the same row): only an Enchantment /
 *    FellowEnchantment duration > 0 — "Duration: %u min." for ≥ 60 s
 *    (trunc(d / 60)), else "Duration: %u sec.".
 *  - Range 0x10000162: DetermineSpellRange @ 004ad450 — r = base_range_mod ×
 *    the caster's skill for the school + base_range_constant, capped at
 *    RADAR_OUTDOOR_RADIUS (75); r == 0 → no line, else
 *    "Range: %.1f yds." with r / 0.9144.
 *  - Body 0x10000163: AddItemInfo(description), then — when the formula has
 *    components — "\nCOMPONENTS:" and one "     <name>" line per component
 *    with a valid SpellComponentBase and icon.
 *  - Icon 0x1000015f: the spell icon composite (SpellIconComposite).
 *  - Component list 0x1000032d: one 32x32 row (template 0x1000032e) per
 *    listed component, re-centred on x = 150 (x = 134 − 16·(n − 1), width
 *    32·n); UpdateComponents @ 004abe20 shows the dark scrim child
 *    0x10000330 over a component the player does not carry.
 */
import { appropriateSpellFormula } from '@ac/shared';

/** SchoolEnumToName @ 00597400. */
export function schoolName(school: number): string {
  switch (school) {
    case 1: return 'War Magic';
    case 2: return 'Life Magic';
    case 3: return 'Item Enchantment';
    case 4: return 'Creature Enchantment';
    case 5: return 'Void Magic';
    default: return 'None';
  }
}

/** InqSkillForSpell: the casting skill (STypeSkill) for a school, 0 = none. */
export function skillForSchool(school: number): number {
  switch (school) {
    case 1: return 0x22; // War Magic
    case 2: return 0x21; // Life Magic
    case 3: return 0x20; // Item Enchantment
    case 4: return 0x1f; // Creature Enchantment
    case 5: return 0x2b; // Void Magic
    default: return 0;
  }
}

/** SetManaText @ 004b5e40. */
export function spellManaText(baseMana: number, manaMod: number): string {
  const n = baseMana >= 1 ? Math.trunc(baseMana).toLocaleString('en-US') : '0';
  return manaMod > 0 ? `Mana: ${n} + ${Math.trunc(manaMod)} per target` : `Mana: ${n}`;
}

/** ExamineSpell's duration line ('' = left clear). */
export function spellDurationText(duration: number | undefined): string {
  if (duration === undefined || duration === -1 || !(duration > 0)) return '';
  return duration >= 60 ? `Duration: ${Math.trunc(duration / 60)} min.` : `Duration: ${Math.trunc(duration)} sec.`;
}

/** SpellType.PortalSummon: the 1999 examine prints its portal's lifetime as one value. */
const META_SPELL_PORTAL_SUMMON = 7;

/**
 * The 1999 SpellExaminePanel_ExamineSpell @ 0x00511110 duration line (SWEEP1999.magic MAG-5):
 * CSpellBase_InqDuration (an enchantment's duration, a portal summon's lifetime), then for a
 * portal summon "Duration: %u min." (d / 60) from 60 s up, else "Duration: %u sec."; for every
 * other spell the band the AC1999 server rolls in (SpellPotency.cpp clamps to ×0.75 .. ×1.25):
 * "Duration: %.1f-%.1f min." when the top is past 90 s, else "Duration: %u-%u sec." (each ftol'd).
 */
export function spellDurationText1999(spell: { duration?: number; metaSpellType?: number; portalLifetime?: number }): string {
  const portal = spell.metaSpellType === META_SPELL_PORTAL_SUMMON;
  const d = portal ? spell.portalLifetime : spell.duration;
  if (d === undefined || d === -1 || !(d > 0)) return '';
  if (portal) return d >= 60 ? `Duration: ${Math.trunc(d / 60)} min.` : `Duration: ${Math.trunc(d)} sec.`;
  const lo = d * 0.75, hi = d * 1.25;
  if (hi > 90) return `Duration: ${(lo / 60).toFixed(1)}-${(hi / 60).toFixed(1)} min.`;
  return `Duration: ${Math.trunc(lo)}-${Math.trunc(hi)} sec.`;
}

/** RADAR_OUTDOOR_RADIUS (.rdata 0x7cc6a0) and METERS_PER_YARD. */
const MAX_SPELL_RANGE = 75;
const METERS_PER_YARD = 0.9144;

/** DetermineSpellRange @ 004ad450 ('' = no range line). */
export function spellRangeText(baseRangeMod: number, baseRangeConstant: number, skill: number): string {
  const r = Math.min(baseRangeMod * skill + baseRangeConstant, MAX_SPELL_RANGE);
  if (r === 0) return '';
  return `Range: ${(r / METERS_PER_YARD).toFixed(1)} yds.`;
}

/**
 * DetermineSpellRange @ 004ad450 in metres: base_range_mod × the school's skill + base_range_constant, capped at
 * 75. The skill is CACQualities::InqSkillLevel @ 00591e40, `_level_from_pp + _init_level` (the ranks bought plus
 * the creation bonus; no attribute part, no buffs), and the best of the five magic skills for a school with none.
 * ACE's server check is the same (Player_Magic.cs: "use init + ranks, same as acclient DetermineSpellRange").
 */
export function spellRangeMeters(s: { school: number; baseRangeMod: number; baseRangeConstant: number }, inqSkillLevel: (skillId: number) => number): number {
  const skill = skillForSchool(s.school);
  const level = skill ? inqSkillLevel(skill) : Math.max(...[0x1f, 0x20, 0x21, 0x22, 0x2b].map(inqSkillLevel));
  return Math.min(s.baseRangeMod * level + s.baseRangeConstant, MAX_SPELL_RANGE);
}

/** CACQualities::InqSkillLevel @ 00591e40 over the client's skill records: ranks + init level, 0 without a record. */
export function inqSkillLevel(skills: { getRaises(id: number): number; getInitLevel(id: number): number }, skillId: number): number {
  return skills.getRaises(skillId) + skills.getInitLevel(skillId);
}

/** One component row of the list (and its body line). */
export interface SpellExamineComponent {
  /** The SpellComponentTable id (row property 0x10000010). */
  scid: number;
  name: string;
  iconDid: number;
  /** ComponentTracker::ComponentIsOwned — any quantity carried. */
  owned: boolean;
  /** GetComponentObjectID — the first carried object of that component (0 = none). */
  objectId: number;
}

export interface SpellExamineModel {
  spellId: number;
  title: string;
  school: string;
  mana: string;
  duration: string;
  range: string;
  /** The body lines (description, then the COMPONENTS block). */
  body: string[];
  iconDid: number;
  components: SpellExamineComponent[];
}

export interface SpellExamineInputs {
  spellId: number;
  spell: {
    name: string; desc: string; school: number; icon: number;
    baseMana: number; manaMod: number; baseRangeConstant: number; baseRangeMod: number;
    duration?: number; metaSpellType?: number; portalLifetime?: number;
  };
  /** The era's Duration line (EraClientRules.spellDurationText); end of retail's when absent. */
  durationText?: 'eor' | 'ac1999';
  /**
   * ClientMagicSystem::GetAppropriateSpellFormula @ 00567d50's inputs: the
   * spell's base formula, the account-customized one, and what decides
   * between them (a held focus of the spell's school or its Infused
   * augmentation lists the scarab only).
   */
  formula: Omit<Parameters<typeof appropriateSpellFormula>[0], 'school'>;
  /** InqSkillLevel for a skill id (the caster's current level). */
  skillLevel: (skillId: number) => number;
  /** SpellComponentTable entry for a component id (null = none / no icon). */
  component: (scid: number) => { name: string; icon: number } | null;
  /** The first carried object of a component (0 = not carried). */
  carriedObject: (scid: number) => number;
  /**
   * A 1999 world's "Charge: 87%" (VISUAL.ac1999-spell-charge; 1999 SpellExaminePanel::
   * ExamineSpell @ 0x00511110, magic/SpellCharge1999.ts): one more line of the body,
   * after the description. Absent in every other era.
   */
  chargeLine?: string;
}

/** SpellExamineUI::ExamineSpell @ 004b6210 for one spell. */
export function buildSpellExamineModel(i: SpellExamineInputs): SpellExamineModel {
  const s = i.spell;
  const body: string[] = [];
  if (s.desc) body.push(s.desc);
  if (i.chargeLine) body.push(i.chargeLine);
  const components: SpellExamineComponent[] = [];
  const formula = appropriateSpellFormula({ ...i.formula, school: s.school });
  if (formula.length > 0) {
    body.push('', 'COMPONENTS:');
    for (const scid of formula) {
      const c = i.component(scid);
      if (!c || !c.icon) continue;
      const objectId = i.carriedObject(scid);
      components.push({ scid, name: c.name, iconDid: c.icon, owned: objectId !== 0, objectId });
      body.push(`     ${c.name}`);
    }
  }
  const skill = skillForSchool(s.school);
  return {
    spellId: i.spellId,
    title: s.name,
    school: `School: ${schoolName(s.school)}`,
    mana: spellManaText(s.baseMana, s.manaMod),
    duration: i.durationText === 'ac1999' ? spellDurationText1999(s) : spellDurationText(s.duration),
    // A school with no casting skill takes the best of the five magic skills.
    range: spellRangeText(s.baseRangeMod, s.baseRangeConstant,
      skill ? i.skillLevel(skill) : Math.max(...[0x1f, 0x20, 0x21, 0x22, 0x2b].map(i.skillLevel))),
    body,
    iconDid: s.icon,
    components,
  };
}

/** The component list's re-centred rect (x around 150, 32 px per component). */
export function spellComponentListRect(count: number): { x: number; width: number } {
  const n = Math.max(1, count);
  return { x: 134 - 16 * (n - 1), width: 32 * n };
}

/** Page 0x10000153's element ids. */
export const SPELL_PAGE = {
  school: 0x1000015e, icon: 0x1000015f, mana: 0x10000160, duration: 0x10000161, range: 0x10000162,
  body: 0x10000163, bodyScrollbar: 0x10000164, componentList: 0x1000032d,
} as const;
