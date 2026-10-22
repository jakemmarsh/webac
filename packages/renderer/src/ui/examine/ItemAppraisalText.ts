/**
 * ItemAppraisalText — the end-of-retail ITEM examine (appraisal) body text,
 * ported as a pure function from the decompiled retail client
 * (reference/client-eol, build ac1_sep13; annotated decomp
 * `reference/client-eol/decomp/acclient-decompiled.annotated.c`).
 *
 * ── Where it goes ─────────────────────────────────────────────────────────
 * ItemExamineUI (ctor @ 004ab7f0, decomp line ~170180) finds, under the item
 * page 0x1000012e, the value text 0x10000138, burden text 0x10000139, icon
 * 0x1000013a and the ONE scrolling body text element 0x1000013c
 * (m_itemDisplayText). The EoL client opens examine as the floaty window
 * (layout 0x2100006b, gmFloatyExaminationUI) whose item page has NO
 * 0x10000138/0x10000139 — and ItemExamineUI::SetAppraiseInfo @ 004b72b0
 * (line ~178620) null-checks those: when absent it writes "Value: N" and
 * "Burden: N" INTO the body via Appraisal_ShowValueInfo /
 * Appraisal_ShowBurdenInfo instead. `hasValueBurdenElements` selects that
 * (default false = the EoL floaty page).
 *
 * ── How the body is built ────────────────────────────────────────────────
 * Every line goes through ItemExamineUI::AddItemInfo(text, fontColor,
 * sameParagraph) @ 004adca0 (line ~172256) / @ 004ac050 (wide):
 *   if the body already holds more than 1 glyph, append "\n" when
 *   sameParagraph != 0, else "\n\n"; then AppendTextWithFont(text, font 0,
 *   fontColor). AddItemInfo("", 0, 1) is therefore a bare "\n" — the way
 *   most sections open/close a blank line. It is ONE text element: no
 *   label/value columns, no per-paragraph spacing beyond the blank lines.
 *   fontColor indexes element 0x1000013c's p27 (0x1B) colour array
 *   (layout 0x2100006b): 0 = 0xFFFFFFFF white, 1 = mod_high_font
 *   0xFF00FF00 green (enchantment raised the stat), 2 = mod_low_font
 *   0xFFFF0000 red (lowered) — ItemExamineUI ctor sets mod_high_font = 1,
 *   mod_low_font = 2. Font: base element 0x10000371 of layout 0x2100003f,
 *   p26 = font 0x40000001.
 *
 * Section order = SetAppraiseInfo's call order (each function below cites
 * its address + annotated-decomp line).
 *
 * Retail's AddItemInfo only prepends a separator once the body holds > 1
 * glyph; we count characters already appended (newlines included) — the
 * glyph list counts rendered glyphs, which can only differ when the body
 * is empty or 1 character long.
 */

import type { IdentifyResponseData } from '../../network/ServerMessageHandler.js';
import { getStringParts } from '@ac/dat-parser/file-types/LayoutDesc.js';
import {
  APPRAISAL_SKILL_NAMES, ATTRIBUTE_NAMES, DAMAGE_TYPE, VITAL_NAMES,
  attunedStatusToString, bondedStatusToString, cFixed, cG, clothingPriorityToString,
  damageResistanceToString, damageTypeToString, deltaTimeToString, ftol, insertCommas,
  itemLevelToTotalXp, itemTotalXpToLevel, lockpickSuccessPercentToString,
  modifierToString, smallModifierToString, weaponTimeToString, workmanshipAdjective,
} from './appraisalFormat.js';

// ─── Public types ─────────────────────────────────────────────────────────

/** Font-colour index into 0x1000013c's p27 array (see header). */
export type AppraisalFontColor = 0 | 1 | 2;

export const APPRAISAL_COLOR = { normal: 0, modHigh: 1, modLow: 2 } as const;

/** ARGB of each index, from layout 0x2100006b element 0x1000013c p27. */
export const APPRAISAL_COLOR_ARGB: Readonly<Record<AppraisalFontColor, number>> = {
  0: 0xffffffff, 1: 0xff00ff00, 2: 0xffff0000,
};

/** One AddItemInfo / AppendText call, exactly as retail appends it. */
export interface AppraisalRun {
  /** What retail appended before `text` ('' when the body had ≤ 1 glyph). */
  separator: '' | '\n' | '\n\n';
  text: string;
  color: AppraisalFontColor;
  /** Retail function that produced the run (for debugging/tests). */
  section: string;
}

export interface AppraisalLine { text: string; color: AppraisalFontColor }

export interface ItemAppraisalText {
  /** Header element 0x10000138 text (ItemExamineUI::SetValueText). */
  value: string;
  /** Header element 0x10000139 text (ItemExamineUI::SetBurdenText). */
  burden: string;
  /** Raw retail append stream. */
  runs: AppraisalRun[];
  /** The full body string (runs concatenated). */
  text: string;
  /** `text` split on "\n"; a line's colour is the colour of the run that wrote it. */
  lines: AppraisalLine[];
  /** Runs of non-empty lines separated by one or more blank lines. */
  paragraphs: AppraisalLine[][];
}

export interface SpellInfo { name: string; description: string }

export interface ItemAppraisalResolvers {
  /** ClientMagicSystem::GetSpellName / GetSpellDescription (SpellTable 0x0E00000E). */
  spell?: (spellId: number) => SpellInfo | null | undefined;
  /** SkillSystem::InqSkillName — SkillTable 0x0E000004 name. Falls back to
   *  AppraisalSystem::SkillToString's retail table when not supplied. */
  skillName?: (skillId: number) => string | null | undefined;
  /** EnumMapper 0x10000002 (heritage). Retail hardcodes 2/5/13 first. */
  heritageName?: (heritage: number) => string | null | undefined;
  /** EnumMapper 0x10000005 (CreatureType); retail replaces "_" with " ". */
  creatureTypeName?: (creatureType: number) => string | null | undefined;
  /** MaterialTypeEnumMapper::MaterialTypeToString. */
  materialName?: (material: number) => string | null | undefined;
}

/** The examined object's own (PublicWeenieDesc) fields retail reads off the weenie. */
export interface AppraisedWeenieInfo {
  /** PWD ValidLocations (EquipMask). */
  validLocations?: number;
  /** PWD AmmoType. */
  ammoType?: number;
  /** PWD Priority (CoverageMask) — "Covers …". */
  priority?: number;
  /** PWD ObjectDescriptionFlags (0x2 Inscribable, 0x10000 Healer, 0x20000 Lockpick). */
  objectDescriptionFlags?: number;
  itemsCapacity?: number;
  containersCapacity?: number;
  /** The weenie's IsHooked virtual (vtable +0x74): hook-profile values replace PWD ones. */
  isHooked?: boolean;
  /** PWD _location: the slot it is wielded in, 0 when not wielded (1999 ACCWeenieObject::get_location
   *  @ 0x004e1f40 — "Use this item to unwield it." / "... to take it off."). */
  location?: number;
}

export interface ItemAppraisalContext {
  /** AppraisalProfile success_flag (the IdentifyObjectResponse success u32). Default true. */
  appraisalSuccess?: boolean;
  /** true = docked page with value/burden header elements (0x2100001c);
   *  false (default) = EoL floaty page 0x2100006b — value/burden go in the body. */
  hasValueBurdenElements?: boolean;
  weenie?: AppraisedWeenieInfo;
  /** Viewer's Shield skill (id 48): current level + SKILL_ADVANCEMENT_CLASS (3 = specialized). */
  viewerShieldSkill?: { current: number; advancementClass: number };
  /** Seconds left on the viewer's shared cooldown for PropertyInt 280, if on cooldown. */
  sharedCooldownRemainingSeconds?: number;
  /** The era has no nether damage (1999: the armor profile has no nether mod), so no Nether row. */
  noNetherDamage?: boolean;
  resolvers?: ItemAppraisalResolvers;
}

// ─── Property ids (ACE Properties/*.cs names) ─────────────────────────────
const PI = {
  EncumbranceVal: 5, RareId: 17, Value: 19, AccountRequirements: 26, ArmorLevel: 28,
  Bonded: 33, ResistMagic: 36, ResistLockpick: 38, DamageType: 45, AttackType: 47,
  MinLevel: 86, MaxLevel: 87, BoosterEnum: 89, BoostValue: 90, Structure: 92,
  CreationTimestamp: 98, ItemWorkmanship: 105, ItemSpellcraft: 106, ItemCurMana: 107,
  ItemMaxMana: 108, ItemDifficulty: 109, ItemAllegianceRankLimit: 110, PortalBitmask: 111,
  Attuned: 114, ItemSkillLevelLimit: 115, ItemManaCost: 117, MaterialType: 131,
  WieldRequirements: 158, WieldSkillType: 159, WieldDifficulty: 160, SlayerCreatureType: 166,
  NumItemsInMaterial: 170, NumTimesTinkered: 171, AppraisalLongDescDecoration: 172,
  AppraisalLockpickSuccessPercent: 173, AppraisalPages: 174, AppraisalMaxPages: 175,
  AppraisalItemSkill: 176, GemCount: 177, GemType: 178, ImbuedEffect: 179, HeritageGroup: 188,
  NumKeys: 193, ElementalDamageBonus: 204, ItemAttributeLimit: 257, ItemAttributeLevelLimit: 258,
  ItemAttribute2ndLimit: 259, ItemAttribute2ndLevelLimit: 260, ResistanceModifierType: 263,
  EquipmentSetId: 265, Lifespan: 267, RemainingLifespan: 268, Unique: 279, SharedCooldown: 280,
  Cleaving: 292, ImbuedEffect2: 303, ImbuedEffect3: 304, ImbuedEffect4: 305, ImbuedEffect5: 306,
  ItemMaxLevel: 319, ItemXpStyle: 320, HeritageSpecificArmor: 324, CloakWeaveProc: 352,
  WeaponType: 353, UseRequiresSkill: 366, UseRequiresSkillLevel: 367, UseRequiresSkillSpec: 368,
  UseRequiresLevel: 369, GearDamage: 370, GearDamageResist: 371, GearCrit: 372,
  GearCritResist: 373, GearCritDamage: 374, GearCritDamageResist: 375, GearHealingBoost: 376,
  GearNetherResist: 377, GearLifeResist: 378, GearMaxHealth: 379,
} as const;
const PB = {
  Locked: 3, UnlimitedUse: 63, IsSellable: 69, AppraisalHasAllowedWielder: 85, Retained: 91,
  AppraisalHasAllowedActivator: 94, Ivoryable: 99, Dyable: 100, RareUsesTimer: 108, AutowieldLeft: 130,
} as const;
const PF = {
  ManaRate: 5, WeaponDefense: 29, ItemEfficiency: 87, HealkitMod: 100, CriticalMultiplier: 136,
  ManaStoneDestroyChance: 137, ManaConversionMod: 144, CriticalFrequency: 147,
  WeaponMissileDefense: 149, WeaponMagicDefense: 150, ElementalDamageMod: 152, IgnoreArmor: 155,
  ResistanceModifier: 157, AbsorbMagicDamage: 159, CooldownDuration: 167,
} as const;
const PS = {
  Use: 14, ShortDesc: 15, LongDesc: 16, CraftsmanName: 25, AppraisalPortalDestination: 38,
  TinkerName: 39, ImbuerName: 40, GearPlatingName: 52,
} as const;
const PI64 = { AugmentationCost: 3, ItemTotalXp: 4, ItemBaseXp: 5 } as const;
const PDID_ProcSpell = 55;

/** EquipMask bits used by the weapon/armor section. */
const EQUIP = {
  WeaponMask: 0x3f00000, Shield: 0x200000, MissileWeapon: 0x400000, MissileAmmo: 0x800000,
  SpeedMask: 0x2500000, ArmorClothingMask: 0x8007fff,
} as const;

/** compute_str_hash("ID_Examine_Item_AugmentationCost") in StringTable 0x23000001. */
export const AUGMENTATION_COST_STRING_ID = 63136164;
/** Verbatim DAT fragments of that entry (fallback when tables aren't registered). */
const AUGMENTATION_COST_FALLBACK = [
  '\nUsing this gem will drain ', ' points of your available experience.\n',
];

// ─── Header strings (docked page only) ───────────────────────────────────

/**
 * ItemExamineUI::SetValueText @ 004add60 (line ~172301) / SetBurdenText
 * @ 004ae010: "Value: N" / "N Burden Units"; "Value: ???" / "Unknown Burden"
 * when the property is missing. Retail formats N with
 * PStringBase::convert(n, 1); we render it with thousands commas like the
 * body variant (convert's second arg is assumed to be the comma flag).
 */
export function buildItemValueBurdenHeader(data: Pick<IdentifyResponseData, 'propertiesInt'>): { value: string; burden: string } {
  const v = data.propertiesInt?.get(PI.Value);
  const b = data.propertiesInt?.get(PI.EncumbranceVal);
  return {
    value: v === undefined ? 'Value: ???' : `Value: ${insertCommas(v)}`,
    burden: b === undefined ? 'Unknown Burden' : `${insertCommas(b)} Burden Units`,
  };
}

// ─── Builder ─────────────────────────────────────────────────────────────

class Body {
  runs: AppraisalRun[] = [];
  private length = 0;
  /** ItemExamineUI::AddItemInfo @ 004adca0 / @ 004ac050. */
  add(section: string, text: string, color: AppraisalFontColor = 0, sameParagraph = true): void {
    const separator: AppraisalRun['separator'] = this.length > 1 ? (sameParagraph ? '\n' : '\n\n') : '';
    this.push(section, separator, text, color);
  }
  /** UIElement_Text::AppendStringInfo — no separator. */
  append(section: string, text: string, color: AppraisalFontColor = 0): void {
    this.push(section, '', text, color);
  }
  private push(section: string, separator: AppraisalRun['separator'], text: string, color: AppraisalFontColor): void {
    this.runs.push({ separator, text, color, section });
    this.length += separator.length + text.length;
  }
}

/** Enchantment highlight/colour pair → font colour (InqInt/FloatEnchantmentMod @ 005b2c10/005b2c70). */
function enchColor(pair: { highlight: number; color: number } | undefined, bit: number): AppraisalFontColor {
  if (!pair || !(pair.highlight & bit)) return 0;
  return pair.color & bit ? 1 : 2;
}

export function buildItemAppraisalText(data: IdentifyResponseData, ctx: ItemAppraisalContext = {}): ItemAppraisalText {
  const pInt = (id: number) => data.propertiesInt?.get(id);
  const pI64 = (id: number) => data.propertiesInt64?.get(id);
  const pBool = (id: number) => data.propertiesBool?.get(id);
  const pFloat = (id: number) => data.propertiesFloat?.get(id);
  const pStr = (id: number) => data.propertiesString?.get(id);
  const pDid = (id: number) => data.propertiesDataID?.get(id);
  const success = ctx.appraisalSuccess ?? true;
  const r = ctx.resolvers ?? {};
  const weenie = ctx.weenie ?? {};
  const hook = weenie.isHooked ? data.hookProfile : undefined;
  const odf = weenie.objectDescriptionFlags ?? 0;
  // PWD Healer flag (weenie byte +0x102 bit 0 = ObjectDescriptionFlags 0x10000) or,
  // for a hooked item, HookAppraisalProfile IsHealer (hookFlags 0x2).
  const isHealer = (odf & 0x10000) !== 0 || (!!hook && (hook.hookFlags & 0x2) !== 0);
  const armorEnch = data.armorEnchantment;
  const weaponEnch = data.weaponEnchantment;
  const resistEnch = data.resistEnchantment;

  const skillName = (id: number): string | null => {
    if (id === 0) return null;
    const s = r.skillName ? r.skillName(id) : APPRAISAL_SKILL_NAMES[id];
    return s ?? null;
  };
  /** AppraisalSystem::InqHeritageGroupDisplayName @ 005b4710. */
  const heritageName = (id: number): string | null => {
    if (id === 2) return "Gharu'ndim";
    if (id === 5) return 'Umbraen';
    if (id === 13) return 'Olthoi';
    return r.heritageName?.(id) ?? null;
  };
  /** AppraisalSystem::InqCreatureDisplayName @ 005b59e0. */
  const creatureName = (id: number): string | null => {
    const s = r.creatureTypeName?.(id);
    return s == null ? null : s.split('_').join(' ');
  };
  const materialName = (id: number): string | null => r.materialName?.(id) ?? null;
  /** AppraisalSystem::InqPluralizedGemName @ 005b5800. */
  const pluralGemName = (id: number): string => {
    if (id === 0x26) return 'Rubies';
    const base = materialName(id) ?? '';
    if ([0xb, 0x18, 0x1b, 0x1d, 0x20, 0x25, 0x28, 0x2e, 0x24, 0x2d].includes(id)) return `pieces of ${base}`;
    if (id === 0x1a || id === 0x31) return `${base}es`;
    if (id === 0x1c) return base;
    return `${base}s`;
  };

  const body = new Body();
  const add = body.add.bind(body);

  // Valid locations / ammo: the weenie's, or the hook profile's when hooked (SetAppraiseInfo).
  const validLocations = (hook ? hook.validLocations : weenie.validLocations) ?? 0;
  const ammoType = (hook ? hook.ammoType : weenie.ammoType) ?? 0;

  // Header text (docked page) — SetValueText / SetBurdenText.
  const header = buildItemValueBurdenHeader(data);

  // SetInscription → separate elements 0x1000013e/0x1000013f, not the body.

  // Appraisal_ShowValueInfo @ 004adea0 (line ~172355) / ShowBurdenInfo @ 004ae180 (line ~172496).
  if (!ctx.hasValueBurdenElements) {
    const v = pInt(PI.Value);
    add('ShowValueInfo', v === undefined ? 'Value: ???' : `Value: ${insertCommas(v)}`);
    const b = pInt(PI.EncumbranceVal);
    add('ShowBurdenInfo', b === undefined ? 'Burden: Unknown' : `Burden: ${insertCommas(b)}`);
  }

  // Appraisal_ShowTinkeringInfo @ 004b0e70 (line ~174590).
  {
    const S = 'ShowTinkeringInfo';
    const tinkered = pInt(PI.NumTimesTinkered);
    if (tinkered !== undefined) add(S, `This item has been tinkered ${tinkered} time${tinkered > 1 ? 's' : ''}.`);
    const tinker = pStr(PS.TinkerName);
    if (tinker !== undefined) add(S, `Last tinkered by ${tinker}.`);
    const imbuer = pStr(PS.ImbuerName);
    if (imbuer !== undefined) add(S, `Imbued by ${imbuer}.`);
    const work = pInt(PI.ItemWorkmanship);
    if (work !== undefined) {
      const items = pInt(PI.NumItemsInMaterial);
      if (items === undefined) {
        add(S, `Workmanship: ${workmanshipAdjective(work)} (${work})`);
      } else {
        const avg = Math.fround(Math.fround(work) / Math.fround(items));
        add(S, `Workmanship: ${workmanshipAdjective(ftol(avg + 0.5))} (${cFixed(avg, 2)})\n\nSalvaged from ${items} items.`);
      }
    }
    add(S, '');
  }

  // Appraisal_ShowSet @ 004ae880 (line ~172859).
  const setShown = (() => {
    const id = pInt(PI.EquipmentSetId);
    if (id === undefined) return false;
    const name = EQUIPMENT_SET_NAMES[id];
    if (!name) return false;
    add('ShowSet', `Set: ${name}`);
    return true;
  })();

  // Appraisal_ShowRatings @ 004af080 (line ~173290).
  const ratingsShown = (() => {
    const order: Array<[number, string]> = [
      [PI.GearDamage, 'Dam'], [PI.GearDamageResist, 'Dam Resist'], [PI.GearCrit, 'Crit'],
      [PI.GearCritDamage, 'Crit Dam'], [PI.GearCritResist, 'Crit Resist'],
      [PI.GearCritDamageResist, 'Crit Dam Resist'], [PI.GearHealingBoost, 'Heal Boost'],
      [PI.GearNetherResist, 'Nether Resist'], [PI.GearLifeResist, 'Life Resist'],
    ];
    const parts = order.filter(([id]) => (pInt(id) ?? 0) > 0).map(([id, label]) => `${label} ${pInt(id)}`);
    if (parts.length) add('ShowRatings', `Ratings: ${parts.join(', ')}.`);
    const vit = pInt(PI.GearMaxHealth) ?? 0;
    if (vit > 0) add('ShowRatings', `This item adds ${vit} Vitality.`);
    if (!parts.length && vit < 1) return false;
    add('ShowRatings', '');
    return true;
  })();
  if (ratingsShown || setShown) add('SetAppraiseInfo', '');

  // Appraisal_ShowWeaponAndArmorData @ 004b10e0 (line ~174655).
  showWeaponAndArmorData();
  // Appraisal_ShowDefenseModData @ 004b1df0 (line ~175090).
  {
    const S = 'ShowDefenseModData';
    const md = pFloat(PF.WeaponDefense);
    if (md !== undefined && md !== 1.0) add(S, `Bonus to Melee Defense: ${smallModifierToString(md)}.`, enchColor(weaponEnch, 0x2));
    const mi = pFloat(PF.WeaponMissileDefense);
    if (mi !== undefined && mi !== 1.0) add(S, `Bonus to Missile Defense: ${smallModifierToString(mi)}.`);
    const mg = pFloat(PF.WeaponMagicDefense);
    if (mg !== undefined && mg !== 1.0) add(S, `Bonus to Magic Defense: ${smallModifierToString(mg)}.`);
  }
  // Appraisal_ShowArmorMods @ 004b1f60 (line ~175130).
  {
    const ap = data.armorProfile;
    const al = pInt(PI.ArmorLevel);
    if (ap && al !== undefined && al > 0) {
      const S = 'ShowArmorMods';
      add(S, `\nArmor Level: ${al}`, enchColor(armorEnch, 0x1));
      const rows: Array<[number, number, number]> = [
        [DAMAGE_TYPE.Slash, ap.slashing, 0x2], [DAMAGE_TYPE.Pierce, ap.piercing, 0x4],
        [DAMAGE_TYPE.Bludgeon, ap.bludgeoning, 0x8], [DAMAGE_TYPE.Fire, ap.fire, 0x20],
        [DAMAGE_TYPE.Cold, ap.cold, 0x10], [DAMAGE_TYPE.Acid, ap.acid, 0x40],
        [DAMAGE_TYPE.Electric, ap.lightning, 0x80], [DAMAGE_TYPE.Nether, ap.nether, 0x100],
      ];
      for (const [type, mod, bit] of rows) {
        if (type === DAMAGE_TYPE.Nether && ctx.noNetherDamage) continue;
        const s = damageResistanceToString(type, al, mod);
        if (s !== null) add(S, s, enchColor(armorEnch, bit));
      }
    }
  }
  // Appraisal_ShowShortMagicInfo @ 004b2c90 (line ~175668).
  const spellList: number[] | undefined = (data.spellBook || data.activeEnchantments)
    ? [...(data.spellBook ?? []), ...(data.activeEnchantments ?? []).map((id) => (id | 0x80000000) >>> 0)]
    : undefined;
  if (spellList) {
    if (!success) add('ShowShortMagicInfo', 'Spells: unknown.', 0, false);
    else {
      const names = spellList.filter((id) => (id & 0x80000000) === 0).map((id) => r.spell?.(id)?.name ?? '');
      if (names.length) add('ShowShortMagicInfo', `Spells: ${names.join(', ')}`, 0, false);
    }
  }
  // Appraisal_ShowSpecialProperties @ 004b0140 (line ~174000).
  showSpecialProperties();
  // Appraisal_ShowUsage @ 004af930 (line ~173662).
  { const use = pStr(PS.Use); if (use !== undefined) add('ShowUsage', use, 0, false); }
  // Appraisal_ShowLevelLimitInfo @ 004b2920 (line ~175550).
  {
    const S = 'ShowLevelLimitInfo';
    const min = pInt(PI.MinLevel) ?? -1; const max = pInt(PI.MaxLevel) ?? -1;
    let line: string | null = null;
    if (min < 1) { if (max >= 1) line = `Restricted to characters of Level ${max} or below.`; }
    else if (max < 1) line = `Restricted to characters of Level ${min} or greater.`;
    else if (min === max) line = `Restricted to characters of Level ${min}.`;
    else line = `Restricted to characters of Levels ${min} to ${max}.`;
    if (line) add(S, line, 0, false);
    const dest = pStr(PS.AppraisalPortalDestination);
    if (dest !== undefined) add(S, `Destination: ${dest}`, 0, false);
  }
  // Appraisal_ShowWieldRequirements @ 004af9a0 (line ~173690).
  showWieldRequirements();
  // Appraisal_ShowUsageLimitInfo @ 004b2a70 (line ~175600).
  {
    const S = 'ShowUsageLimitInfo';
    let any = false;
    const lvl = pInt(PI.UseRequiresLevel) ?? 0;
    if (lvl > 0) { add(S, ''); add(S, `Use requires level ${lvl}.`); any = true; }
    const sk = pInt(PI.UseRequiresSkill) ?? 0;
    const skl = pInt(PI.UseRequiresSkillLevel) ?? 0;
    if (sk !== 0 && skl !== 0) {
      if (!any) add(S, '');
      add(S, `Use requires ${skillName(sk) ?? 'Unknown Skill'} of at least ${skl}.`);
      any = true;
    }
    const spec = pInt(PI.UseRequiresSkillSpec) ?? 0;
    if (spec !== 0) {
      if (!any) add(S, '');
      add(S, `Use requires specialized ${skillName(spec) ?? 'Unknown Skill'}.`);
    }
  }
  // Appraisal_ShowItemLevelInfo @ 004b3c60 (line ~176328).
  {
    const S = 'ShowItemLevelInfo';
    const baseXp = pI64(PI64.ItemBaseXp);
    const maxLevel = pInt(PI.ItemMaxLevel) ?? 0;
    const style = pInt(PI.ItemXpStyle) ?? 0;
    if (baseXp !== undefined && baseXp !== 0n && maxLevel > 0 && style > 0) {
      const total = pI64(PI64.ItemTotalXp) ?? 0n;
      const level = itemTotalXpToLevel(total, baseXp, maxLevel, style);
      const next = itemLevelToTotalXp(Math.min(level + 1, maxLevel), baseXp, maxLevel, style);
      add(S, `Item Level: ${level} / ${maxLevel}`);
      add(S, `Item XP: ${insertCommas(total)} / ${insertCommas(next)}`);
      add(S, '');
    }
    if (pInt(PI.CloakWeaveProc) === 2) {
      add(S, 'This cloak has a chance to reduce an incoming attack by 200 damage.');
      add(S, '');
    }
  }
  // Appraisal_ShowActivationRequirements @ 004b3270 (line ~175950).
  if (success) {
    const S = 'ShowActivationRequirements';
    const parts: string[] = [];
    const diff = pInt(PI.ItemDifficulty) ?? 0;
    if (diff > 0) parts.push(`Arcane Lore: ${diff}`);
    const rank = pInt(PI.ItemAllegianceRankLimit) ?? 0;
    if (rank > 0) parts.push(`Allegiance Rank: ${rank}`);
    const her = pInt(PI.HeritageGroup) ?? 0;
    if (her !== 0) { const n = heritageName(her); if (n !== null) parts.push(n); }
    const skLvl = pInt(PI.ItemSkillLevelLimit) ?? 0;
    const sk = pInt(PI.AppraisalItemSkill);
    if (skLvl > 0 && sk !== undefined) { const n = skillName(sk); if (n !== null) parts.push(`${n}: ${skLvl}`); }
    const atLvl = pInt(PI.ItemAttributeLevelLimit) ?? 0;
    const at = pInt(PI.ItemAttributeLimit);
    if (atLvl > 0 && at !== undefined) { const n = ATTRIBUTE_NAMES[at]; if (n) parts.push(`${n}: ${atLvl}`); }
    const vLvl = pInt(PI.ItemAttribute2ndLevelLimit) ?? 0;
    const vt = pInt(PI.ItemAttribute2ndLimit);
    if (vLvl > 0 && vt !== undefined) { const n = VITAL_NAMES[vt]; if (n) parts.push(`${n}: ${vLvl}`); }
    if (parts.length) add(S, `Activation requires ${parts.join(', ')}`);
    if (pBool(PB.AppraisalHasAllowedActivator) === true) {
      add(S, `This item can only be activated by ${pStr(PS.CraftsmanName) ?? 'the original owner'}.`);
    }
  }
  // Appraisal_ShowCasterData @ 004b1b10 (line ~175010).
  {
    const S = 'ShowCasterData';
    const mc = pFloat(PF.ManaConversionMod);
    if (mc !== undefined) add(S, `Bonus to Mana Conversion: ${modifierToString(mc + 1.0)}.`, enchColor(resistEnch, 0x1000), false);
    const edm = pFloat(PF.ElementalDamageMod);
    const dt = pInt(PI.DamageType);
    if (edm !== undefined && dt !== undefined) {
      const c = enchColor(resistEnch, 0x2000);
      const pk = (edm - 1.0) * 0.25 + 1.0; // CombatSystem::GetElementalModPKModifier @ 005c9020 (ElementalModPKModifier = 0.25)
      add(S, `Damage bonus for ${damageTypeToString(dt)} spells:`, c, false);
      add(S, ` vs. Monsters: ${smallModifierToString(edm)}.`, c);
      add(S, ` vs. Players: ${smallModifierToString(pk)}.`, c);
    }
  }
  // Appraisal_ShowBoostValue @ 004b2480 (line ~175370).
  if (!isHealer) {
    const v = pInt(PI.BoostValue); const kind = pInt(PI.BoosterEnum);
    if (v !== undefined && kind !== undefined) {
      const n = v < 0 ? -v : v;
      const line = kind === 2 ? (v < 0 ? `Depletes ${n} Health when used.` : `Restores ${n} Health when used.`)
        : kind === 4 ? (v < 0 ? `Depletes ${n} Stamina when consumed.` : `Restores ${n} Stamina when consumed.`)
          : kind === 6 ? (v < 0 ? `Depletes ${n} Mana when used.` : `Restores ${n} Mana when used.`)
            : null; // retail appends an uninitialised buffer here; we emit nothing
      if (line) add('ShowBoostValue', line, 0, false);
    }
  }
  // Appraisal_ShowHealKitValues @ 004b25a0 (line ~175420).
  if (isHealer) {
    const v = pInt(PI.BoostValue);
    if (v !== undefined) add('ShowHealKitValues', `Bonus to Healing Skill: ${v}`, 0, false);
    const m = pFloat(PF.HealkitMod);
    if (m !== undefined) add('ShowHealKitValues', `Restoration Bonus: ${ftol(m * 100.0)}%`);
  }
  // Appraisal_ShowCapacity @ 004b2680 (line ~175450). Retail returns early for a
  // hooked item that carries a hook profile (decomp mislabels the test as has_anim).
  if (!hook) {
    const S = 'ShowCapacity';
    const items = weenie.itemsCapacity ?? 0; const conts = weenie.containersCapacity ?? 0;
    if (items >= 1 && conts >= 1) add(S, `Can hold up to ${items} items and ${conts} containers.`, 0, false);
    else if (items >= 1) add(S, `Can hold up to ${items} items.`, 0, false);
    else if (conts >= 1) add(S, `Can hold up to ${conts} containers.`, 0, false);
    const maxPages = pInt(PI.AppraisalMaxPages); const pages = pInt(PI.AppraisalPages);
    if (maxPages !== undefined && pages !== undefined) add(S, `${pages} of ${maxPages} pages full.`, 0, false);
  }
  // Appraisal_ShowLockAppraiseInfo @ 004b2790 (line ~175480).
  if (!weenie.isHooked) {
    const S = 'ShowLockAppraiseInfo';
    const locked = pBool(PB.Locked);
    const resist = pInt(PI.ResistLockpick);
    if (locked === undefined) {
      if (resist !== undefined && resist < 0) add(S, `Bonus to Lockpick Skill: ${resist}`, 0, false);
      else if (resist !== undefined && resist > 0) add(S, `Bonus to Lockpick Skill: +${resist}`, 0, false);
    } else if (!locked) {
      add(S, 'Unlocked', 0, false);
    } else {
      add(S, 'Locked', 0, false);
      if (resist === undefined) add(S, "You can't tell how hard the lock is to pick.", 0, false);
      else {
        const pct = pInt(PI.AppraisalLockpickSuccessPercent);
        const adj = pct === undefined ? null : lockpickSuccessPercentToString(pct);
        if (adj !== null) add(S, `The lock looks ${adj} to pick (Resistance ${resist}).`, 0, false);
      }
    }
  }
  // Appraisal_ShowManaStoneInfo @ 004b3900 (line ~176190).
  if (!spellList) {
    const S = 'ShowManaStoneInfo';
    const mana = pInt(PI.ItemCurMana);
    if (mana !== undefined) add(S, `Stored Mana: ${mana}`);
    const eff = pFloat(PF.ItemEfficiency);
    if (eff !== undefined) add(S, `Efficiency: ${ftol(eff * 100.0)}%`);
    const dc = pFloat(PF.ManaStoneDestroyChance);
    if (dc !== undefined) add(S, `Chance of Destruction: ${ftol(dc * 100.0)}%`);
  }
  // Appraisal_ShowRemainingUses @ 004b3a20 (line ~176235).
  {
    const S = 'ShowRemainingUses';
    const keys = pInt(PI.NumKeys);
    if (keys !== undefined) add(S, keys === 1 ? `Contains ${keys} key.` : `Contains ${keys} keys.`);
    if (pBool(PB.UnlimitedUse)) add(S, 'Number of uses remaining:  Unlimited');
    else {
      const uses = pInt(PI.Structure);
      if (uses !== undefined) add(S, `Number of uses remaining: ${uses}`);
      else if (!success) {
        const flagged = (odf & 0x30000) !== 0
          || (!!weenie.isHooked && !!hook && (hook.hookFlags & (0x2 | 0x8)) !== 0);
        if (flagged) add(S, 'Number of uses remaining:  Unknown', 0, false);
      }
    }
  }
  // Appraisal_ShowCraftsman @ 004b0da0 (line ~174560).
  if (!pBool(PB.AppraisalHasAllowedWielder) && !pBool(PB.AppraisalHasAllowedActivator)) {
    const c = pStr(PS.CraftsmanName);
    if (c !== undefined) add('ShowCraftsman', `Created by ${c}.`);
  }
  // SetAppraiseInfo: InqBool(0x45 IsSellable) == false.
  if (pBool(PB.IsSellable) === false) add('SetAppraiseInfo', 'This item cannot be sold.');
  // Appraisal_ShowRareInfo @ 004b3b60 (line ~176285).
  if (pBool(PB.RareUsesTimer) === true) {
    add('ShowRareInfo', 'This rare item has a timer restriction of 3 minutes. You will not be able to use another rare item with a timer within 3 minutes of using this one.', 0, false);
  }
  { const rare = pInt(PI.RareId); if (rare !== undefined) add('ShowRareInfo', `Rare #${rare}`, 0, false); }
  // Appraisal_ShowMagicInfo @ 004b2e10 (line ~175735).
  if (spellList) {
    const S = 'ShowMagicInfo';
    if (!success) add(S, 'Spells: unknown.', 0, false);
    else {
      let descs = 'Spell Descriptions:';
      let enchs = 'Enchantments:\n';
      let hasIntrinsic = false; let hasEnch = false;
      for (const raw of spellList) {
        const info = r.spell?.(raw & 0x7fffffff);
        const entry = `\n~ ${info?.name ?? ''}: ${info?.description ?? ''}`;
        if (raw & 0x80000000) { enchs += entry; hasEnch = true; } else { descs += entry; hasIntrinsic = true; }
      }
      if (hasIntrinsic) {
        const sc = pInt(PI.ItemSpellcraft);
        if (sc !== undefined) add(S, `Spellcraft: ${sc}.`);
        const cur = pInt(PI.ItemCurMana); const max = pInt(PI.ItemMaxMana);
        if (cur !== undefined && max !== undefined) add(S, `Mana: ${cur} / ${max}.`);
        // ACE compatibility (BUG.mana-cost-zero-rate): ACE's world DB gives
        // some items ManaRate 0.0 = "no drain" and AppraiseInfo sends every
        // present [AssessmentProperty]; retail's server never sent a zero
        // rate, and the client's _ftol2(1/0) printed "1 point per
        // -2147483648 seconds." A zero rate is treated as absent — what it
        // means — so the item shows ItemManaCost, or no cost line.
        const rawRate = pFloat(PF.ManaRate);
        const rate = rawRate === 0 ? undefined : rawRate;
        if (rate !== undefined) {
          add(S, `Mana Cost: 1 point per ${ftol(Math.abs(1.0 / rate) + 0.5)} seconds.`);
        } else {
          const cost = pInt(PI.ItemManaCost);
          if (cost !== undefined) {
            add(S, cost > 0 ? `Mana Cost: ${cost}.\n(Can be reduced by the Mana Conversion skill)` : `Mana Cost: ${cost}.`, 0, false);
          }
        }
        add(S, descs, 0, false);
      }
      if (hasEnch) add(S, enchs, 0, false);
    }
  }
  // Appraisal_ShowDescription @ 004b6990 (line ~178273).
  showDescription();

  return finishAppraisalText(header, body.runs);

  // ── Sections with more branching ────────────────────────────────────

  function showWeaponAndArmorData(): void {
    const S = 'ShowWeaponAndArmorData';
    if ((validLocations & EQUIP.WeaponMask) === 0) {
      if (validLocations & EQUIP.ArmorClothingMask) {
        const covers = clothingPriorityToString(weenie.priority ?? 0);
        if (covers !== null) add(S, covers);
      }
      return;
    }
    if (validLocations & EQUIP.Shield) {
      const sl = pInt(PI.ArmorLevel);
      if (sl === undefined) add(S, 'Shield Level: Unknown');
      else {
        add(S, `Base Shield Level: ${sl}`, enchColor(armorEnch, 0x1));
        const sk = ctx.viewerShieldSkill ?? { current: 0, advancementClass: 0 };
        let eff = sk.advancementClass < 3 ? Math.trunc(sk.current / 2) : sk.current;
        if (sl < eff) eff = sl;
        add(S, `Effective Shield Level : ${eff} (with Shield skill)`);
      }
    }
    const w = data.weaponProfile;
    if (w) {
      const launcher = (validLocations & EQUIP.MissileWeapon) !== 0 && ammoType !== 0;
      const skill = APPRAISAL_SKILL_NAMES[w.weaponSkill];
      if (skill !== undefined) {
        const sub = pInt(PI.WeaponType);
        add(S, `Skill: ${skill}${sub !== undefined ? (WEAPON_TYPE_SUFFIX[sub] ?? '') : ''}`);
      }
      const prefix = launcher ? 'Damage Bonus: ' : 'Damage: ';
      if (w.damage < 0) add(S, `${prefix}Unknown`);
      else {
        let suffix = '';
        if (!launcher) {
          suffix = ', unknown type';
          if (w.damageType !== 0) suffix = `, ${damageTypeToString(w.damageType)}`;
        }
        const min = (1.0 - w.damageVariance) * w.damage;
        const line = F_EPS_F32 < w.damage - min
          ? `${prefix}${cG(min, min >= 10.0 ? 4 : 3)} - ${w.damage}${suffix}`
          : `${prefix}${w.damage}${suffix}`;
        let c = enchColor(weaponEnch, 0x8);
        if (!(weaponEnch && weaponEnch.highlight & 0x8)) c = enchColor(weaponEnch, 0x10);
        add(S, line, c);
      }
      const edb = pInt(PI.ElementalDamageBonus) ?? 0;
      if (edb > 0) add(S, `Elemental Damage Bonus: ${edb}, ${damageTypeToString(w.damageType)}.`);
      if (launcher) {
        if (!success) add(S, 'Damage Modifier: Unknown');
        else add(S, `Damage Modifier: ${modifierToString(w.damageMod)}.`, enchColor(weaponEnch, 0x20));
      }
      if (validLocations & EQUIP.SpeedMask) {
        const missile = (validLocations & EQUIP.MissileWeapon) !== 0;
        if (w.weaponTime < 0) {
          add(S, 'Speed:  Unknown');
          if (missile) add(S, 'Range:  Unknown');
        } else {
          add(S, `Speed: ${weaponTimeToString(w.weaponTime)} (${w.weaponTime})`, enchColor(weaponEnch, 0x4));
          if (missile) {
            // pow(maxVelocity, 2) × 0.10204… × 1.094, capped at MISSILE_RANGE_CAP 85.
            let range = Math.pow(w.maxVelocity, 2) * 0.1020408163265306 * 1.094;
            if (85.0 < range) range = 85.0;
            const yds = range >= 10.0 ? ftol(range) - (ftol(range) % 5) : ftol(Math.ceil(range));
            add(S, `Range: ${yds} yds.${w.maxVelocityEstimated ? ' (based on STRENGTH 100)' : ''}`);
          }
        }
      }
      if (w.weaponOffense !== 1.0 && !launcher) {
        const sign = w.weaponOffense < 1.0 ? '-' : '+';
        add(S, `Bonus to Attack Skill: ${sign}${ftol(Math.abs(1.0 - w.weaponOffense) * 100.0 + 0.5)}%.`, enchColor(weaponEnch, 0x1));
      }
    }
    if (validLocations & EQUIP.MissileWeapon) {
      const t = ammoType === 1 ? 'Uses arrows as ammunition.' : ammoType === 2 ? 'Uses quarrels as ammunition.'
        : ammoType === 4 ? 'Uses atlatl darts as ammunition.' : null;
      if (t) add(S, t);
    } else if (validLocations & EQUIP.MissileAmmo) {
      const t = ammoType === 1 ? 'Used as ammunition by bows.' : ammoType === 2 ? 'Used as ammunition by crossbows.'
        : ammoType === 4 ? 'Used as ammunition by atlatls.' : null;
      if (t) add(S, t);
    }
  }

  function showSpecialProperties(): void {
    const S = 'ShowSpecialProperties';
    add(S, '');
    const unique = pInt(PI.Unique);
    if (unique !== undefined) {
      add(S, '');
      add(S, `You can only carry ${insertCommas(unique)} of these items.`);
    }
    const cd = pFloat(PF.CooldownDuration);
    if (cd !== undefined) {
      // Wide-string path (AppendTextWithFont after a manual "\n" when > 1 glyph).
      add(S, `Cooldown When Used: ${deltaTimeToString(ftol(cd))}`);
      if (pInt(PI.SharedCooldown) !== undefined) {
        const rem = ctx.sharedCooldownRemainingSeconds;
        if (rem !== undefined && rem > 0) add(S, `Cooldown Remaining: ${deltaTimeToString(ftol(rem))}`);
        add(S, '');
      }
    }
    const cleave = pInt(PI.Cleaving);
    if (cleave !== undefined && cleave > 1) { add(S, `Cleave: ${cleave} enemies in front arc.`); add(S, ''); }

    const list: string[] = [];
    const slayer = pInt(PI.SlayerCreatureType);
    if (slayer !== undefined) {
      const n = creatureName(slayer);
      if (n !== null) list.push(slayer === 0x1f ? "Bael'Zharon's Hate" : `${n} slayer`);
    }
    const attack = pInt(PI.AttackType);
    if (attack !== undefined && (attack & 0x79e0) !== 0) list.push('Multi-Strike');
    let imbue = 0;
    for (const id of [PI.ImbuedEffect, PI.ImbuedEffect2, PI.ImbuedEffect3, PI.ImbuedEffect4, PI.ImbuedEffect5]) {
      const v = pInt(id); if (v !== undefined) imbue = (imbue | v) >>> 0;
    }
    if (imbue) {
      const bits: Array<[number, string]> = [
        [0x1, 'Critical Strike'], [0x2, 'Crippling Blow'], [0x4, 'Armor Rending'], [0x8, 'Slash Rending'],
        [0x10, 'Pierce Rending'], [0x20, 'Bludgeon Rending'], [0x40, 'Acid Rending'], [0x4000, 'Nether Rending'],
        [0x80, 'Cold Rending'], [0x100, 'Lightning Rending'], [0x200, 'Fire Rending'], [0x400, '+1 Melee Defense'],
        [0x800, '+1 Missile Defense'], [0x1000, '+1 Magic Defense'], [0x80000000, 'Phantasmal'],
      ];
      for (const [bit, name] of bits) if ((imbue & bit) >>> 0) list.push(name);
    }
    if (pFloat(PF.AbsorbMagicDamage) !== undefined) list.push('Magic Absorbing');
    const rm = pInt(PI.ResistMagic);
    if (rm !== undefined && rm > 9998) list.push('Unenchantable');
    const att = pInt(PI.Attuned);
    if (att !== undefined) { const s = attunedStatusToString(att); if (s) list.push(s); }
    const bonded = pInt(PI.Bonded);
    if (bonded !== undefined) { const s = bondedStatusToString(bonded); if (s) list.push(s); }
    if (pBool(PB.Retained) === true) list.push('Retained');
    if (pFloat(PF.CriticalMultiplier) !== undefined) list.push('Crushing Blow');
    if (pFloat(PF.CriticalFrequency) !== undefined) list.push('Biting Strike');
    if (pFloat(PF.IgnoreArmor) !== undefined) list.push('Armor Cleaving');
    const rmt = pInt(PI.ResistanceModifierType);
    if (pFloat(PF.ResistanceModifier) !== undefined && rmt !== undefined) {
      list.push(`Resistance Cleaving: ${damageTypeToString(rmt)}`);
    }
    if (pDid(PDID_ProcSpell) !== undefined) list.push('Cast on Strike');
    if (pBool(PB.Ivoryable) === true) list.push('Ivoryable');
    if (pBool(PB.Dyable) === true) list.push('Dyeable');

    let any = false;
    if (list.length) { add(S, `Properties: ${list.join(', ')}`); any = true; }
    if (imbue) { add(S, 'This item cannot be further imbued.'); any = true; }
    if (pBool(PB.AutowieldLeft) === true) { add(S, 'This item is tethered to the left side.'); any = true; }
    if (any) add(S, '');
  }

  function showWieldRequirements(): void {
    const S = 'ShowWieldRequirements';
    if (pBool(PB.AppraisalHasAllowedWielder) === true) {
      add(S, `Wield requires ${pStr(PS.CraftsmanName) ?? 'the original owner'}`);
    }
    const acct = pInt(PI.AccountRequirements);
    if (acct !== undefined && acct !== 0) add(S, acct === 1 ? 'Use requires Throne of Destiny.' : '');
    const hsa = pInt(PI.HeritageSpecificArmor);
    if (hsa !== undefined) { const n = heritageName(hsa); if (n !== null) add(S, `Wield requires ${n}`); }
    const blocks: Array<[number, number, number, boolean]> = [
      [PI.WieldRequirements, PI.WieldSkillType, PI.WieldDifficulty, false],
      [270, 271, 272, false], [273, 274, 275, false], [276, 277, 278, true],
    ];
    for (const [rId, sId, dId, capital] of blocks) {
      const req = pInt(rId); const skill = pInt(sId); const diff = pInt(dId);
      if (req === undefined || skill === undefined || diff === undefined) continue;
      const what = requirementString(req, skill, diff);
      let line: string;
      if ((req >= 1 && req <= 7) || req === 9 || req === 10) line = `Wield requires ${what} ${diff}`;
      else if (req === 8) {
        const t = diff === 3 ? (capital ? 'Specialized' : 'specialized') : (capital ? 'Trained' : 'trained');
        line = `Wield requires ${t} ${what}`;
      } else if (req === 11) line = `Wield requires ${what} type`;
      else if (req === 12) line = `Wield requires ${what} race`;
      else return; // retail: unknown requirement type ends the function
      add(S, line);
    }
  }

  /** ItemExamineUI::GetAppraisalStringFromRequirements @ 004acac0 (line ~170768). */
  function requirementString(req: number, skill: number, diff: number): string {
    let s = req === 2 || req === 4 || req === 6 ? 'base ' : '';
    switch (req) {
      case 1: case 2: case 8: s += skillName(skill) ?? ''; break;
      case 3: case 4: s += ATTRIBUTE_NAMES[skill] ?? ''; break;
      case 5: case 6: s += VITAL_NAMES[skill] ?? ''; break;
      case 7: s = 'level'; break;
      case 9: case 10:
        s = skill === 0x11f ? 'Standing with the Celestial Hand'
          : skill === 0x120 ? 'Standing with the Eldrytch Web'
            : skill === 0x121 ? 'Standing with the Radiant Blood' : 'unknown quality';
        break;
      case 11: s = creatureName(diff) ?? s; break;
      case 12: s = heritageName(diff) ?? s; break;
    }
    return s;
  }

  function showDescription(): void {
    const S = 'ShowDescription';
    const lifespan = pInt(PI.Lifespan); const created = pInt(PI.CreationTimestamp);
    const remaining = pInt(PI.RemainingLifespan);
    if (lifespan !== undefined && created !== undefined && remaining !== undefined) {
      if (remaining < 0) add(S, 'This item is in the act of disintegrating.');
      else {
        let t = remaining; let s = 'This item expires in ';
        if (t > 31536000) { s += `${Math.trunc(t / 31536000)} years, `; t %= 31536000; }
        if (t > 86400) { s += `${Math.trunc(t / 86400)} days, `; t %= 86400; }
        if (t > 3600) { s += `${Math.trunc(t / 3600)} hours, `; t %= 3600; }
        if (t > 60) { s += `${Math.trunc(t / 60)} minutes, `; t %= 60; }
        s += `${t} seconds.`;
        add(S, s);
      }
    }
    const longDesc = pStr(PS.LongDesc);
    if (longDesc === undefined) {
      const shortDesc = pStr(PS.ShortDesc);
      if (shortDesc !== undefined) { add(S, ''); add(S, shortDesc); }
    } else {
      let desc = pStr(PS.GearPlatingName) ?? longDesc;
      const deco = pInt(PI.AppraisalLongDescDecoration);
      if (deco !== undefined) {
        let prefix = ''; let suffix = '';
        const work = pInt(PI.ItemWorkmanship);
        if (deco & 1 && work !== undefined) prefix += `${workmanshipAdjective(work)} `;
        const mat = pInt(PI.MaterialType);
        if (mat !== undefined && mat > 0) {
          const m = materialName(mat) ?? '';
          prefix += `${m} `;
          if (m && desc.includes(m)) desc = desc.split(m).join('').trim();
        }
        const gc = pInt(PI.GemCount); const gt = pInt(PI.GemType);
        if (deco & 4 && gc !== undefined && gt !== undefined) {
          suffix = `, set with ${gc} ${gc === 1 ? (materialName(gt) ?? '') : pluralGemName(gt)}`;
        }
        desc = prefix + desc + suffix;
      }
      add(S, '');
      add(S, desc);
    }
    const portal = pInt(PI.PortalBitmask);
    if (portal !== undefined) {
      let s = '';
      if (portal & 0x2) s += 'Player Killers may not use this portal.\n';
      if (portal & 0x4) s += 'Lite Player Killers may not use this portal.\n';
      if (portal & 0x8) s += 'Non-Player Killers may not use this portal.\n';
      if (portal & 0x20) s += 'This portal cannot be recalled nor linked to.\n';
      if (portal & 0x10) s += 'This portal cannot be summoned.\n';
      add(S, '');
      add(S, s);
    }
    const aug = pI64(PI64.AugmentationCost);
    if (aug !== undefined) {
      const parts = getStringParts(AUGMENTATION_COST_STRING_ID) ?? AUGMENTATION_COST_FALLBACK;
      body.append(S, parts.length >= 2 ? `${parts[0]}${aug}${parts.slice(1).join('')}` : `${parts[0] ?? ''}${aug}`);
    }
  }
}

/** F_EPSILON as the float the damage-range test compares against (0x7aeee0). */
const F_EPS_F32 = Math.fround(0.0002);

/** Appraisal_ShowWeaponAndArmorData's WeaponType (PropertyInt 353) suffixes. */
const WEAPON_TYPE_SUFFIX: Readonly<Record<number, string>> = {
  1: ' (Unarmed Weapon)', 2: ' (Sword)', 3: ' (Axe)', 4: ' (Mace)', 5: ' (Spear)',
  6: ' (Dagger)', 7: ' (Staff)', 8: ' (Bow)', 9: ' (Crossbow)', 10: ' (Thrown)',
};

/** Appraisal_ShowSet's EquipmentSetId (PropertyInt 265) switch. */
export const EQUIPMENT_SET_NAMES: Readonly<Record<number, string>> = (() => {
  const m: Record<number, string> = {
    4: "Carraida's Benediction", 5: 'Noble Relic', 6: 'Ancient Relic', 7: 'Alduressa Relic',
    8: 'Shou-jen', 9: 'Empyrean Rings', 10: 'Arm, Mind, Heart', 11: 'Coat of Perfect Light',
    12: 'Leggings of Perfect Light', 13: "Soldier's", 14: "Adept's", 15: "Archer's",
    16: "Defender's", 17: "Tinker's", 18: "Crafter's", 19: 'Hearty', 20: 'Dexterous', 21: 'Wise',
    22: 'Swift', 23: 'Hardened', 24: 'Reinforced', 25: 'Interlocking', 26: 'Flame Proof',
    27: 'Acid Proof', 28: 'Cold Proof', 29: 'Lightning Proof', 30: 'Dedication',
    31: 'Gladiatorial Clothing', 32: 'Ceremonial Clothing', 33: 'Protective Clothing',
    35: 'Sigil of Defense', 36: 'Sigil of Destruction', 37: 'Sigil of Fury', 38: 'Sigil of Growth',
    39: 'Sigil of Vigor', 40: 'Heroic Protector', 41: 'Heroic Destroyer',
    49: 'Weave of Alchemy', 50: 'Weave of Arcane Lore', 51: 'Weave of Armor Tinkering',
    52: 'Weave of Assess Person', 54: 'Weave of Missile Weapons', 55: 'Weave of Cooking',
    56: 'Weave of Creature Enchantment', 57: 'Weave of Missile Weapons', 58: 'Weave of Finesse Weapons',
    59: 'Weave of Deception', 60: 'Weave of Fletching', 61: 'Weave of Healing',
    62: 'Weave of Item Enchantment', 63: 'Weave of Item Tinkering', 64: 'Weave of Leadership',
    65: 'Weave of Life Magic', 66: 'Weave of Loyalty', 68: 'Weave of Magic Defense',
    69: 'Weave of Magic Item Tinkering', 70: 'Weave of Mana Conversion', 71: 'Weave of Melee Defense',
    72: 'Weave of Missile Defense', 73: 'Weave of Salvaging', 76: 'Weave of Heavy Weapons',
    77: 'Weave of Missile Weapons', 78: 'Weave of Two Handed Combat', 80: 'Weave of Void Magic',
    81: 'Weave of War Magic', 82: 'Weave of Weapon Tinkering', 83: 'Weave of Assess Creature',
    84: 'Weave of Dirty Fighting', 85: 'Weave of Dual Wield', 86: 'Weave of Recklessness',
    87: 'Weave of Shield', 88: 'Weave of Sneak Attack', 89: 'Shou-jen Shozoku',
    90: 'Weave of Summoning', 91: 'Shrouded Soul', 92: 'Darkened Mind', 93: 'Clouded Spirit',
    130: 'Shimmering Shadows',
  };
  for (const id of [53, 67, 74, 75, 79]) m[id] = 'Weave of Light Weapons';
  const tiers = ['Minor', 'Major', 'Blackfire'];
  const kinds = ['Stinging', 'Sparking', 'Smoldering', 'Shivering'];
  const bases = ['Shrouded Soul', 'Darkened Mind', 'Clouded Spirit'];
  let id = 94;
  for (const t of tiers) for (const b of bases) for (const k of kinds) m[id++] = `${t} ${k} ${b}`;
  return m;
})();

// ─── Output shaping ──────────────────────────────────────────────────────

/** The append stream → the page's text, lines and paragraphs (shared with the 1999 item page). */
export function finishAppraisalText(header: { value: string; burden: string }, runs: AppraisalRun[]): ItemAppraisalText {
  const text = runs.map((r) => r.separator + r.text).join('');
  const lines: AppraisalLine[] = [];
  let cur: AppraisalLine | null = null;
  const breakLine = () => { lines.push(cur ?? { text: '', color: 0 }); cur = null; };
  for (const r of runs) {
    for (let i = 0; i < r.separator.length; i++) breakLine();
    const segs = r.text.split('\n');
    segs.forEach((seg, i) => {
      if (i > 0) breakLine();
      if (seg.length) {
        if (cur) cur.text += seg;
        else cur = { text: seg, color: r.color };
      }
    });
  }
  if (cur || runs.length) lines.push(cur ?? { text: '', color: 0 });
  const paragraphs: AppraisalLine[][] = [];
  let para: AppraisalLine[] = [];
  for (const l of lines) {
    if (l.text === '') { if (para.length) { paragraphs.push(para); para = []; } }
    else para.push(l);
  }
  if (para.length) paragraphs.push(para);
  return { value: header.value, burden: header.burden, runs, text, lines, paragraphs };
}
