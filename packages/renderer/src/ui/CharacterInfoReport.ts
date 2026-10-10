/**
 * CharacterInfoReport — builds the text body of the retail "Character
 * Information" panel (gmCharacterInfoUI, layout classic_characterinfo /
 * 0x2100001c, single scrolling text element 0x1000011d).
 *
 * This is a faithful port of the decompiled retail client's update chain
 * (reference/client-eol, build ac1_sep13):
 *
 *   gmCharacterInfoUI::Update @ 0x4ba790 calls, in order:
 *     UpdatePlayerBirthAgeDeaths  @ 0x4b8cb0  — Born / Played / Deaths
 *     UpdateEnduranceInfo         @ 0x4b8eb0  — Natural/Drain Resistances, Regeneration Bonus
 *     UpdateInnateAttributeInfo   @ 0x4b87e0  — Innate Str/End/Coord/Quick/Focus/Self
 *     UpdateFakeSkills            @ 0x4b8930  — Chess Rank / Fishing Skill
 *     UpdateAugmentations         @ 0x4b9000  — masteries, luminance auras, gem augs
 *     UpdateLoad                  @ 0x4b8a20  — burden / overburden penalty
 *
 * Every visible string is resolved from the language DAT (StringTable
 * 0x23000001) through the retail `compute_str_hash` of its ID_* token — no
 * invented English text. The weapon-mastery names, summoning-mastery names
 * and burden phrasing that the retail client holds as its OWN string literals
 * are reproduced verbatim (they are the client's data, not approximations).
 *
 * The builder is a pure function of an injected property/string source so it
 * is unit-testable without a DOM or live DAT.
 *
 * UpdateEnduranceInfo reads base (unbuffed, init + ranks) Strength and
 * Endurance — CACQualities::InqAttribute(id, &v, raw=1) skips
 * EnchantAttribute — and picks a tier word from Str+End (resistances) and
 * Str+2·End (regeneration). Ghidra renders the sum as `m_data + local_94`
 * pointer arithmetic; the disassembly (4b8eea `add eax,edx; cmp eax,0xc8`,
 * 4b8f6b `lea eax,[ecx+2*eax]`) is a plain unsigned add.
 *
 * UpdateInnateAttributeInfo reads the Attribute struct overload
 * (InqAttribute @ 0x5919d0) and passes field +8 = _init_level, i.e. the
 * character-creation value, not init + ranks.
 */

import { getString, getStringParts, acStringHash } from '@ac/dat-parser/file-types/LayoutDesc.js';
import { getEncumbranceCapacity, getBurdenMod } from '@ac/shared';
import { formatAcTime } from '../utils/formatAcTime.js';

// ─── PropertyInt ids the report reads (ACE PropertyInt.cs) ──────────────
const P = {
  NumDeaths: 43,
  CreationTimestamp: 98,
  Age: 125,
  ChessRank: 181,
  FishingSkill: 192,
  EncumbranceVal: 5,
  // Masteries (value → weapon/summoning category)
  MeleeMastery: 354,
  RangedMastery: 355,
  SummoningMastery: 362,
  // Luminance aura ratings (base/spec split for the first four)
  LumAugDamageRating: 333,
  LumAugDamageReductionRating: 334,
  LumAugCritDamageRating: 335,
  LumAugCritReductionRating: 336,
  LumAugSurgeChanceRating: 338,
  LumAugItemManaUsage: 339,
  LumAugItemManaGain: 340,
  LumAugHealingRating: 342,
  LumAugSkilledCraft: 343,
  LumAugSkilledSpec: 344,
  LumAugAllSkills: 365,
  // Pack-augmentation that raises carrying capacity (UpdateLoad)
  AugmentationIncreasedCarryingCapacity: 230,
} as const;

/** Source of truth the report reads from (injected for testability). */
export interface CharacterInfoSource {
  /** Server PropertyInt by id; undefined when the server never sent it. */
  prop(id: number): number | undefined;
  /** Base attribute (init + ranks, UNBUFFED — ACE Attribute.Base) for id
   *  1..6: retail AttributeCache::InqAttribute @ 0x5cc4e0. */
  attribute(id: number): number;
  /** Innate (character-creation, `_init_level`) attribute for id 1..6. */
  innateAttribute(id: number): number;
  /** BUFFED Strength (ACE Attributes[Strength].Current) for the encumbrance
   *  capacity — retail CACQualities::InqLoad @ 0058f130 reads the enchanted
   *  value (InqAttribute(1, .., 0)). */
  strength: number;
}

// Retail client's own literals (decompiled UpdateAugmentations switch tables).
const MELEE_MASTERY: Record<number, string> = {
  1: 'Unarmed Weapons', 2: 'Swords', 3: 'Axes', 4: 'Maces',
  5: 'Spears', 6: 'Daggers', 7: 'Staves', 11: 'Two Handed Weapons',
};
const RANGED_MASTERY: Record<number, string> = {
  8: 'Bows', 9: 'Crossbows', 10: 'Thrown Weapons', 12: 'Magical Spells',
};
const SUMMONING_MASTERY: Record<number, string> = {
  1: 'Primalist', 2: 'Necromancer', 3: 'Naturalist',
};

// Gem augmentations, in the exact decompiled emit order: [PropertyInt id, token].
// Tokens whose template carries a {count} value slot are flagged hasCount.
const GEM_AUGMENTATIONS: Array<{ id: number; token: string; hasCount?: boolean }> = [
  { id: 218, token: 'ID_CharacterInfo_Augmentation_Attribute_Strength', hasCount: true },
  { id: 219, token: 'ID_CharacterInfo_Augmentation_Attribute_Endurance', hasCount: true },
  { id: 220, token: 'ID_CharacterInfo_Augmentation_Attribute_Coordination', hasCount: true },
  { id: 221, token: 'ID_CharacterInfo_Augmentation_Attribute_Quickness', hasCount: true },
  { id: 222, token: 'ID_CharacterInfo_Augmentation_Attribute_Focus', hasCount: true },
  { id: 223, token: 'ID_CharacterInfo_Augmentation_Attribute_Self', hasCount: true },
  { id: 240, token: 'ID_CharacterInfo_Augmentation_Resist_Slash', hasCount: true },
  { id: 241, token: 'ID_CharacterInfo_Augmentation_Resist_Pierce', hasCount: true },
  { id: 242, token: 'ID_CharacterInfo_Augmentation_Resist_Blunt', hasCount: true },
  { id: 243, token: 'ID_CharacterInfo_Augmentation_Resist_Acid', hasCount: true },
  { id: 327, token: 'ID_CharacterInfo_Augmentation_Resist_Nether', hasCount: true },
  { id: 244, token: 'ID_CharacterInfo_Augmentation_Resist_Fire', hasCount: true },
  { id: 245, token: 'ID_CharacterInfo_Augmentation_Resist_Frost', hasCount: true },
  { id: 246, token: 'ID_CharacterInfo_Augmentation_Resist_Lightning', hasCount: true },
  { id: 224, token: 'ID_CharacterInfo_Augmentation_Spec_Salvaging' },
  { id: 225, token: 'ID_CharacterInfo_Augmentation_Spec_ItemTinkering' },
  { id: 226, token: 'ID_CharacterInfo_Augmentation_Spec_ArmorTinkering' },
  { id: 227, token: 'ID_CharacterInfo_Augmentation_Spec_MagicItemTinkering' },
  { id: 228, token: 'ID_CharacterInfo_Augmentation_Spec_WeaponTinkering' },
  { id: 293, token: 'ID_CharacterInfo_Augmentation_Spec_Gearcraft' },
  { id: 229, token: 'ID_CharacterInfo_Augmentation_ExtraPackSlot' },
  { id: 230, token: 'ID_CharacterInfo_Augmentation_IncreasedCarryingCapacity' },
  { id: 231, token: 'ID_CharacterInfo_Augmentation_LessDeathItemLoss' },
  { id: 232, token: 'ID_CharacterInfo_Augmentation_SpellsRemainPastDeath' },
  { id: 233, token: 'ID_CharacterInfo_Augmentation_CriticalDefense' },
  { id: 234, token: 'ID_CharacterInfo_Augmentation_BonusXP' },
  { id: 235, token: 'ID_CharacterInfo_Augmentation_BonusSalvage' },
  { id: 236, token: 'ID_CharacterInfo_Augmentation_BonusImbueChance' },
  { id: 237, token: 'ID_CharacterInfo_Augmentation_FasterRegen' },
  { id: 238, token: 'ID_CharacterInfo_Augmentation_IncreasedSpellDuration' },
  { id: 294, token: 'ID_CharacterInfo_Augmentation_Infused_CreatureMagic' },
  { id: 295, token: 'ID_CharacterInfo_Augmentation_Infused_ItemMagic' },
  { id: 296, token: 'ID_CharacterInfo_Augmentation_Infused_LifeMagic' },
  { id: 297, token: 'ID_CharacterInfo_Augmentation_Infused_WarMagic' },
  { id: 328, token: 'ID_CharacterInfo_Augmentation_Infused_VoidMagic' },
  { id: 300, token: 'ID_CharacterInfo_Augmentation_SkilledMelee' },
  { id: 301, token: 'ID_CharacterInfo_Augmentation_SkilledMissile' },
  { id: 302, token: 'ID_CharacterInfo_Augmentation_SkilledMagic' },
  { id: 309, token: 'ID_CharacterInfo_Augmentation_DamageBonus' },
  { id: 310, token: 'ID_CharacterInfo_Augmentation_DamageResist' },
  { id: 298, token: 'ID_CharacterInfo_Augmentation_CriticalExpertise' },
  { id: 299, token: 'ID_CharacterInfo_Augmentation_CriticalPower' },
  { id: 326, token: 'ID_CharacterInfo_Augmentation_JackOfAllTrades' },
];

// ─── String helpers ──────────────────────────────────────────────────────

/** Resolve a token's first (or only) DAT string fragment. */
function str(token: string): string | null {
  return getString(acStringHash(token));
}
/** Resolve a token's full DAT fragment array. */
function parts(token: string): string[] | null {
  return getStringParts(acStringHash(token));
}

/**
 * Resolve AC's `{singular[1]|plural}` selector against a count: the singular
 * form is used when the count is exactly 1, otherwise the plural. Used by the
 * "augmented ... N {time[1]|times}" augmentation templates.
 */
function applyPlural(text: string, count: number): string {
  return text.replace(/\{([^[\]|{}]+)\[1\]\|([^{}]+)\}/g, (_m, sing, plur) =>
    count === 1 ? sing : plur);
}

/**
 * Render a multi-fragment template by interleaving its fragments with values:
 *   frag[0] + val[0] + frag[1] + val[1] + … + frag[n]
 * (frag count is one greater than value count). Mirrors the retail
 * StringInfo variable substitution for these report lines.
 */
function interleave(fragments: string[], values: Array<string | number>): string {
  let out = '';
  for (let i = 0; i < fragments.length; i++) {
    out += fragments[i];
    if (i < values.length) out += String(values[i]);
  }
  return out;
}

// ─── Sub-reports (one per decompiled Update* helper) ──────────────────────

function birthAgeDeaths(s: CharacterInfoSource, out: string[]): void {
  const born = s.prop(P.CreationTimestamp);
  if (born !== undefined && born > 0) {
    const f = parts('ID_CharacterInfo_Birth');
    // Retail pins locale via setlocale(0,"English") + strftime("%c") — see formatAcTime.
    const date = formatAcTime(born);
    if (f) out.push(interleave(f, [date]).trimEnd());
  }
  const age = s.prop(P.Age);
  if (age !== undefined && age > 0) {
    const f = parts('ID_CharacterInfo_Played');
    if (f) out.push(interleave(f, [formatDuration(age)]).trimEnd());
  }
  const deaths = s.prop(P.NumDeaths) ?? 0;
  if (deaths === 0) { pushLine(out, str('ID_CharacterInfo_Deaths_None')); }
  else if (deaths === 1) { pushLine(out, str('ID_CharacterInfo_Deaths_One')); }
  else if (deaths === 2) { pushLine(out, str('ID_CharacterInfo_Deaths_Two')); }
  else {
    const f = parts('ID_CharacterInfo_Deaths_Many');
    if (f) out.push(interleave(f, [deaths]).trimEnd());
  }
}

/** Retail UpdateEnduranceInfo tier word for Str+End (client literals). */
export function resistTier(sum: number): string {
  if (sum < 0xc9) return 'None';
  if (sum < 0x105) return 'Poor';
  if (sum < 0x141) return 'Mediocre';
  if (sum < 0x17d) return 'Hardy';
  return sum > 0x1b8 ? 'Indomitable' : 'Resilient';
}

/** Retail UpdateEnduranceInfo tier word for Str+2·End (client literals). */
export function regenTier(sum: number): string {
  if (sum < 0xc9) return 'None';
  if (sum < 0x15b) return 'Poor';
  if (sum < 0x1d7) return 'Mediocre';
  if (sum < 0x245) return 'Hardy';
  return sum > 0x2b2 ? 'Indomitable' : 'Resilient';
}

/** gmCharacterInfoUI::UpdateEnduranceInfo @ 0x4b8eb0 — always emitted.
 *  The EoL template ID_CharacterInfo_Resists has three variable slots in the
 *  order RESIST, RESIST, REGEN ("Natural Resistances: … / Drain Resistances:
 *  … / Regeneration Bonus: …"), so RESIST fills both resistance lines. */
function enduranceInfo(s: CharacterInfoSource, out: string[]): void {
  const strength = s.attribute(1) >>> 0;
  const endurance = s.attribute(2) >>> 0;
  const resist = resistTier(strength + endurance);
  const regen = regenTier(strength + 2 * endurance);
  const f = parts('ID_CharacterInfo_Resists');
  if (f) out.push(interleave(f, [resist, resist, regen]).trimEnd());
}

function innates(s: CharacterInfoSource, out: string[]): void {
  const f = parts('ID_CharacterInfo_Innates');
  if (!f) return;
  // attribute ids: 1 Str, 2 End, 4 Coord, 3 Quick, 5 Focus, 6 Self
  // (decompiled UpdateInnateAttributeInfo reads them in Str/End/Coord/Quick
  //  display order, querying ids 1,2,4,3,5,6).
  const vals = [
    s.innateAttribute(1), s.innateAttribute(2), s.innateAttribute(4),
    s.innateAttribute(3), s.innateAttribute(5), s.innateAttribute(6),
  ];
  out.push(interleave(f, vals).trimEnd());
}

function fakeSkills(s: CharacterInfoSource, out: string[]): void {
  const chess = s.prop(P.ChessRank);
  if (chess !== undefined) {
    const f = parts('ID_CharacterInfo_Chess');
    if (f) out.push(interleave(f, [chess]).trimEnd());
  }
  const fishing = s.prop(P.FishingSkill);
  if (fishing !== undefined && fishing > 0) {
    const f = parts('ID_CharacterInfo_Fishing');
    if (f) out.push(interleave(f, [fishing]).trimEnd());
  }
}

function masteries(s: CharacterInfoSource, out: string[]): void {
  const melee = s.prop(P.MeleeMastery) ?? 0;
  if (melee > 0) emitMastery(out, 'ID_CharacterInfo_Mastery_Melee', MELEE_MASTERY[melee] ?? 'Unknown');
  const ranged = s.prop(P.RangedMastery) ?? 0;
  if (ranged > 0) emitMastery(out, 'ID_CharacterInfo_Mastery_Ranged', RANGED_MASTERY[ranged] ?? 'Unknown');
  const summon = s.prop(P.SummoningMastery) ?? 0;
  if (summon > 0) emitMastery(out, 'ID_CharacterInfo_Mastery_Summoning', SUMMONING_MASTERY[summon] ?? 'Unknown');
}

function emitMastery(out: string[], token: string, name: string): void {
  const f = parts(token);
  if (f) out.push(interleave(f, [name]).trimEnd());
}

/** A luminance aura whose rating splits into a base part (≤5) and a
 *  Seer-granted "specialized" remainder. */
function lumSplit(s: CharacterInfoSource, id: number, baseTok: string, specTok: string, out: string[]): void {
  const rating = s.prop(id) ?? 0;
  if (rating <= 0) return;
  const base = Math.min(rating, 5);
  emitLum(out, baseTok, base);
  const spec = rating - 5;
  if (spec > 0) emitLum(out, specTok, spec);
}

/** A luminance aura shown as a single line, with an optional display multiplier. */
function lumSingle(s: CharacterInfoSource, id: number, token: string, out: string[], mult = 1): void {
  const rating = s.prop(id) ?? 0;
  if (rating > 0) emitLum(out, token, rating * mult);
}

function emitLum(out: string[], token: string, value: number): void {
  const f = parts(token);
  if (f) out.push(interleave(f, [value]).trimEnd());
}

function augmentations(s: CharacterInfoSource, out: string[]): void {
  // Masteries (above) then the Luminance Augmentations block.
  masteries(s, out);
  pushLine(out, str('ID_CharacterInfo_Luminance_Header'));
  lumSplit(s, P.LumAugDamageRating, 'ID_CharacterInfo_Luminance_Base_Damage', 'ID_CharacterInfo_Luminance_Spec_Damage', out);
  lumSplit(s, P.LumAugDamageReductionRating, 'ID_CharacterInfo_Luminance_Base_Reduction', 'ID_CharacterInfo_Luminance_Spec_Reduction', out);
  lumSplit(s, P.LumAugCritDamageRating, 'ID_CharacterInfo_Luminance_Base_Crit_Damage', 'ID_CharacterInfo_Luminance_Spec_Crit_Damage', out);
  lumSplit(s, P.LumAugCritReductionRating, 'ID_CharacterInfo_Luminance_Base_Crit_Reduction', 'ID_CharacterInfo_Luminance_Spec_Crit_Reduction', out);
  lumSingle(s, P.LumAugSurgeChanceRating, 'ID_CharacterInfo_Luminance_Base_Surge_Chance', out);
  lumSingle(s, P.LumAugItemManaUsage, 'ID_CharacterInfo_Luminance_Base_Mana_Use', out, 5);
  lumSingle(s, P.LumAugItemManaGain, 'ID_CharacterInfo_Luminance_Base_Mana_Gain', out, 5);
  lumSingle(s, P.LumAugHealingRating, 'ID_CharacterInfo_Luminance_Base_Healing', out);
  lumSingle(s, P.LumAugSkilledCraft, 'ID_CharacterInfo_Luminance_Base_Skilled_Craft', out);
  lumSingle(s, P.LumAugSkilledSpec, 'ID_CharacterInfo_Luminance_Spec_Skilled_Spec', out, 2);
  lumSingle(s, P.LumAugAllSkills, 'ID_CharacterInfo_Luminance_Base_All_Skills', out);

  // Gem augmentations — each shown only when owned (value > 0).
  for (const aug of GEM_AUGMENTATIONS) {
    const count = s.prop(aug.id) ?? 0;
    if (count <= 0) continue;
    if (aug.hasCount) {
      const f = parts(aug.token);
      if (f) out.push(applyPlural(interleave(f, [count]), count).trimEnd());
    } else {
      const line = str(aug.token);
      if (line) out.push(line.trimEnd());
    }
  }
}

function load(s: CharacterInfoSource, out: string[]): void {
  const encumbrance = s.prop(P.EncumbranceVal) ?? 0;
  const numCarryAugs = s.prop(P.AugmentationIncreasedCarryingCapacity) ?? 0;
  const capacity = getEncumbranceCapacity(s.strength, numCarryAugs);
  const ratio = capacity > 0 ? encumbrance / capacity : 3.0;
  if (ratio < 1.0) {
    pushLine(out, str('ID_CharacterInfo_Load_None'));
  } else {
    const f = parts('ID_CharacterInfo_Load_Burdened');
    if (f) {
      const excess = encumbrance - capacity;
      const burdenMod = getBurdenMod(ratio); // ACE EncumbranceSystem.GetBurdenMod
      const penalty = Math.round((1 - burdenMod) * 100);
      out.push(interleave(f, [excess, penalty]).trimEnd());
    }
  }
}

function formatDuration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const segs: string[] = [];
  if (d > 0) segs.push(`${d} day${d === 1 ? '' : 's'}`);
  if (h > 0) segs.push(`${h} hour${h === 1 ? '' : 's'}`);
  if (m > 0 || segs.length === 0) segs.push(`${m} minute${m === 1 ? '' : 's'}`);
  return segs.join(', ');
}

function pushLine(out: string[], line: string | null): void {
  if (line) out.push(line.trimEnd());
}

/**
 * Build the full Character Information report as an array of text lines (in
 * the exact retail emit order). Lines whose value is absent/zero are skipped,
 * matching the retail client (it only appends a StringInfo when the source
 * value is present and > threshold).
 */
export function buildCharacterInfoReport(s: CharacterInfoSource): string[] {
  const out: string[] = [];
  birthAgeDeaths(s, out);
  enduranceInfo(s, out);
  innates(s, out);
  fakeSkills(s, out);
  augmentations(s, out);
  load(s, out);
  return out;
}
