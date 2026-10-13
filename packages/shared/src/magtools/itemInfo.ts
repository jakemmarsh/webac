/**
 * Mag-Tools' "Item info on identify" line (docs/plugin-specs/magtools.md §8, §13), rebuilt
 * clean-room from the spec's facts: the fragments in order, the spell filter, the "buffed"
 * values, and the `+/-(rule)` loot-rule prefix. Mag-Tools is LGPL; no code is copied. The
 * label tables (skills, masteries, sets) are literal output strings, recorded as facts.
 *
 * Everything reads an appraised item handed in (`MtItemData`, ACE property ids) — no UI and no
 * game access here. `mtItemInfoLine` takes the loot verdict through an injected matcher.
 */
import { PropertyBool, PropertyDataId, PropertyFloat, PropertyInt, PropertyString } from '../weenie-types.js';
import { MATERIAL_NAMES } from '../loot/MaterialTypes.js';
import type { LootRule } from '../routines/RoutineDoc.js';
import { mtDouble, mtN, mtRound, mtRoundTo } from './format.js';

// ─── Inputs ──────────────────────────────────────────────────────────────

/** Decal's ObjectClass numbers (the ones Mag-Tools tests; renderer agent/decalObjectClass.ts computes them). */
export const MtObjectClass = {
  Unknown: 0, MeleeWeapon: 1, Armor: 2, Clothing: 3, Jewelry: 4, Monster: 5, Food: 6, Money: 7, Misc: 8,
  MissileWeapon: 9, Container: 10, Gem: 11, SpellComponent: 12, Key: 13, Portal: 14, TradeNote: 15,
  ManaStone: 16, Player: 24, Vendor: 25, Door: 26, Corpse: 27, Lifestone: 28, HealingKit: 29, Lockpick: 30,
  WandStaffOrb: 31, Book: 33, Npc: 37, Foci: 38, Salvage: 39, Ust: 40, Services: 41, Housing: 42,
} as const;

/** One spell an item carries (or that is active on it): Family = SpellBase.Category, Difficulty = SpellBase.Power. */
export interface MtSpellInfo {
  id: number;
  name: string;
  /** Spell table Category (Mag-Tools' "Family"). */
  family: number;
  /** Spell table Power (Mag-Tools' "Difficulty"). */
  difficulty: number;
  /** A debuff / offensive (cast-on-strike) spell: the mana tracker skips it. */
  offensive?: boolean;
}

/**
 * An appraised item, as ACE sends it (IdentifyObjectResponse): property maps by ACE id, the
 * spellbook split in two — carried spells (entries without 0x80000000) and the ids active on
 * the item (entries with 0x80000000, masked off).
 */
export interface MtItemData {
  id: number;
  name: string;
  /** Decal ObjectClass (MtObjectClass). */
  objectClass: number;
  int: Readonly<Record<number, number>>;
  float: Readonly<Record<number, number>>;
  bool?: Readonly<Record<number, boolean>>;
  string?: Readonly<Record<number, string>>;
  did?: Readonly<Record<number, number>>;
  spells: readonly MtSpellInfo[];
  activeSpellIds?: readonly number[];
}

// ─── §13: Decal keys → our ACE property ids ─────────────────────────────

/** Where a Decal WorldObject key Mag-Tools reads lives among ACE's properties (spec §13). */
export interface MtPropertyRef {
  kind: 'int' | 'float' | 'bool' | 'string' | 'did' | 'derived';
  id?: number;
  /** For a Decal-synthesised key: how it is worked out. */
  note?: string;
}

export const MT_DECAL_KEYS: Readonly<Record<string, MtPropertyRef>> = {
  Burden: { kind: 'int', id: PropertyInt.EncumbranceVal },
  ItemSlots: { kind: 'int', id: PropertyInt.ItemsCapacity },
  PackSlots: { kind: 'int', id: PropertyInt.ContainersCapacity },
  EquipableSlots: { kind: 'int', id: PropertyInt.ValidLocations },
  EquippedSlots: { kind: 'int', id: PropertyInt.CurrentWieldedLocation },
  StackMax: { kind: 'int', id: PropertyInt.MaxStackSize },
  StackCount: { kind: 'int', id: PropertyInt.StackSize },
  Value: { kind: 'int', id: PropertyInt.Value },
  ArmorLevel: { kind: 'int', id: PropertyInt.ArmorLevel },
  Unenchantable: { kind: 'int', id: PropertyInt.ResistMagic },
  AffectsVitalAmt: { kind: 'int', id: PropertyInt.BoostValue },
  UsesRemaining: { kind: 'int', id: PropertyInt.Structure },
  Workmanship: { kind: 'int', id: PropertyInt.ItemWorkmanship },
  CurrentMana: { kind: 'int', id: PropertyInt.ItemCurMana },
  MaximumMana: { kind: 'int', id: PropertyInt.ItemMaxMana },
  LoreRequirement: { kind: 'int', id: PropertyInt.ItemDifficulty },
  SkillLevelReq: { kind: 'int', id: PropertyInt.ItemSkillLevelLimit },
  Material: { kind: 'int', id: PropertyInt.MaterialType },
  WieldReqType: { kind: 'int', id: PropertyInt.WieldRequirements },
  WieldReqAttribute: { kind: 'int', id: PropertyInt.WieldSkillType },
  WieldReqValue: { kind: 'int', id: PropertyInt.WieldDifficulty },
  NumberTimesTinkered: { kind: 'int', id: PropertyInt.NumTimesTinkered },
  ActivationReqSkillId: { kind: 'int', id: PropertyInt.AppraisalItemSkill },
  Imbued: { kind: 'int', id: PropertyInt.ImbuedEffect },
  KeysHeld: { kind: 'int', id: PropertyInt.NumKeys },
  ElementalDmgBonus: { kind: 'int', id: PropertyInt.ElementalDamageBonus },
  EquipmentSetId: { kind: 'int', id: PropertyInt.EquipmentSetId },
  Mastery: { kind: 'int', id: PropertyInt.WeaponType },
  UseRequiresSkill: { kind: 'int', id: PropertyInt.UseRequiresSkill },
  UseRequiresSkillLevel: { kind: 'int', id: PropertyInt.UseRequiresSkillLevel },
  UseRequiresSkillSpec: { kind: 'int', id: PropertyInt.UseRequiresSkillSpec },
  UseRequiresLevel: { kind: 'int', id: PropertyInt.UseRequiresLevel },
  GearDamage: { kind: 'int', id: PropertyInt.GearDamage },
  GearDamageResist: { kind: 'int', id: PropertyInt.GearDamageResist },
  GearCrit: { kind: 'int', id: PropertyInt.GearCrit },
  GearCritResist: { kind: 'int', id: PropertyInt.GearCritResist },
  GearCritDamage: { kind: 'int', id: PropertyInt.GearCritDamage },
  GearCritDamageResist: { kind: 'int', id: PropertyInt.GearCritDamageResist },
  GearHealingBoost: { kind: 'int', id: PropertyInt.GearHealingBoost },
  GearMaxHealth: { kind: 'int', id: PropertyInt.GearMaxHealth },
  MaxDamage: { kind: 'int', id: PropertyInt.Damage, note: 'Decal 218103842, from the weapon profile' },
  ManaRateOfChange: { kind: 'float', id: PropertyFloat.ManaRate },
  Variance: { kind: 'float', id: PropertyFloat.DamageVariance, note: 'Decal 167772171' },
  MeleeDefenseBonus: { kind: 'float', id: PropertyFloat.WeaponDefense },
  AttackBonus: { kind: 'float', id: PropertyFloat.WeaponOffense, note: 'Decal 167772172' },
  DamageBonus: { kind: 'float', id: PropertyFloat.DamageMod, note: 'Decal 167772174' },
  ManaCBonus: { kind: 'float', id: PropertyFloat.ManaConversionMod },
  MissileDBonus: { kind: 'float', id: PropertyFloat.WeaponMissileDefense },
  MagicDBonus: { kind: 'float', id: PropertyFloat.WeaponMagicDefense },
  ElementalDamageVersusMonsters: { kind: 'float', id: PropertyFloat.ElementalDamageMod },
  SalvageWorkmanship: { kind: 'derived', note: 'ItemWorkmanship ÷ NumItemsInMaterial' },
  SlashProt: { kind: 'float', id: PropertyFloat.ArmorModVsSlash },
  PierceProt: { kind: 'float', id: PropertyFloat.ArmorModVsPierce },
  BludgeonProt: { kind: 'float', id: PropertyFloat.ArmorModVsBludgeon },
  ColdProt: { kind: 'float', id: PropertyFloat.ArmorModVsCold },
  FireProt: { kind: 'float', id: PropertyFloat.ArmorModVsFire },
  AcidProt: { kind: 'float', id: PropertyFloat.ArmorModVsAcid },
  LightningProt: { kind: 'float', id: PropertyFloat.ArmorModVsElectric },
  FullDescription: { kind: 'string', id: PropertyString.LongDesc },
  Retained: { kind: 'bool', id: PropertyBool.Retained },
  AssociatedSpell: { kind: 'did', id: PropertyDataId.Spell },
};

// ─── Label tables (literal output strings) ───────────────────────────────

/** Mag-Tools' skill names by skill id (its own list: "Thrown Weapons", "Void"; no 17, 25, 26). */
export const MT_SKILL_NAMES: Readonly<Record<number, string>> = {
  1: 'Axe', 2: 'Bow', 3: 'Crossbow', 4: 'Dagger', 5: 'Mace', 6: 'Melee Defense', 7: 'Missile Defense', 8: 'Sling',
  9: 'Spear', 10: 'Staff', 11: 'Sword', 12: 'Thrown Weapons', 13: 'Unarmed Combat', 14: 'Arcane Lore', 15: 'Magic Defense',
  16: 'Mana Conversion', 18: 'Item Tinkering', 19: 'Assess Person', 20: 'Deception', 21: 'Healing', 22: 'Jump',
  23: 'Lockpick', 24: 'Run', 27: 'Assess Creature', 28: 'Weapon Tinkering', 29: 'Armor Tinkering',
  30: 'Magic Item Tinkering', 31: 'Creature Enchantment', 32: 'Item Enchantment', 33: 'Life Magic', 34: 'War Magic',
  35: 'Leadership', 36: 'Loyalty', 37: 'Fletching', 38: 'Alchemy', 39: 'Cooking', 40: 'Salvaging',
  41: 'Two Handed Combat', 42: 'Gearcraft', 43: 'Void', 44: 'Heavy Weapons', 45: 'Light Weapons', 46: 'Finesse Weapons',
  47: 'Missile Weapons', 48: 'Shield', 49: 'Dual Wield', 50: 'Recklessness', 51: 'Sneak Attack', 52: 'Dirty Fighting',
  53: 'Challenge', 54: 'Summoning',
};

/** WeaponType (353) → mastery label (spec §8 row 3). */
export const MT_MASTERY_NAMES: Readonly<Record<number, string>> = {
  1: 'Unarmed Weapon', 2: 'Sword', 3: 'Axe', 4: 'Mace', 5: 'Spear', 6: 'Dagger', 7: 'Staff', 8: 'Bow', 9: 'Crossbow',
  10: 'Thrown', 11: 'Two Handed Combat',
};

/** EquipmentSetId (265) → Mag-Tools' set label (its spellings kept: "Hardenend Set", "Ninja_New"). */
export const MT_SET_NAMES: Readonly<Record<number, string>> = (() => {
  const m: Record<number, string> = {
    2: 'Test', 4: "Carraida's Benediction", 5: 'Noble Relic Set', 6: 'Ancient Relic Set', 7: 'Relic Alduressa Set',
    8: 'Shou-jen Set', 9: 'Empyrean Rings Set', 10: 'Arm, Mind, Heart Set', 11: 'Coat of the Perfect Light Set',
    12: 'Leggings of Perfect Light Set', 13: "Soldier's Set", 14: "Adept's Set", 15: "Archer's Set", 16: "Defender's Set",
    17: "Tinker's Set", 18: "Crafter's Set", 19: 'Hearty Set', 20: 'Dexterous Set', 21: 'Wise Set', 22: 'Swift Set',
    23: 'Hardenend Set', 24: 'Reinforced Set', 25: 'Interlocking Set', 26: 'Flame Proof Set', 27: 'Acid Proof Set',
    28: 'Cold Proof Set', 29: 'Lightning Proof Set', 30: 'Dedication Set', 31: 'Gladiatorial Clothing Set',
    32: 'Ceremonial Clothing', 33: 'Protective Clothing', 34: 'Noobie Armor', 35: 'Sigil of Defense',
    36: 'Sigil of Destruction', 37: 'Sigil of Fury', 38: 'Sigil of Growth', 39: 'Sigil of Vigor',
    40: 'Heroic Protector Set', 41: 'Heroic Destroyer Set', 42: 'Olthoi Armor D Red', 43: 'Olthoi Armor C Rat',
    44: 'Olthoi Armor C Red', 45: 'Olthoi Armor D Rat', 46: 'Upgraded Relic Alduressa Set',
    47: 'Upgraded Ancient Relic Set', 48: 'Upgraded Noble Relic Set', 49: 'Weave of Alchemy', 50: 'Weave of Arcane Lore',
    51: 'Weave of Armor Tinkering', 52: 'Weave of Assess Person', 54: 'Weave of Missile Weapons', 55: 'Weave of Cooking',
    56: 'Weave of Creature Enchantment', 57: 'Weave of Missile Weapons', 58: 'Weave of Finesse', 59: 'Weave of Deception',
    60: 'Weave of Fletching', 61: 'Weave of Healing', 62: 'Weave of Item Enchantment', 63: 'Weave of Item Tinkering',
    64: 'Weave of Leadership', 65: 'Weave of Life Magic', 66: 'Weave of Loyalty', 68: 'Weave of Magic Defense',
    69: 'Weave of Magic Item Tinkering', 70: 'Weave of Mana Conversion', 71: 'Weave of Melee Defense',
    72: 'Weave of Missile Defense', 73: 'Weave of Salvaging', 76: 'Weave of Heavy Weapons', 77: 'Weave of Missile Weapons',
    78: 'Weave of Two Handed Combat', 80: 'Weave of Void Magic', 81: 'Weave of War Magic', 82: 'Weave of Weapon Tinkering',
    83: 'Weave of Assess Creature ', 84: 'Weave of Dirty Fighting', 85: 'Weave of Dual Wield', 86: 'Weave of Recklessness',
    87: 'Weave of Shield', 88: 'Weave of Sneak Attack', 89: 'Ninja_New', 90: 'Weave of Summoning', 91: 'Shrouded Soul',
    92: 'Darkened Mind', 93: 'Clouded Spirit', 130: 'Shimmering Shadows', 131: 'Brown Society Locket',
    132: 'Yellow Society Locket', 133: 'Red Society Band', 134: 'Green Society Band', 135: 'Purple Society Band',
    136: 'Blue Society Band', 137: 'Gauntlet Garb', 138: 'UNKNOWN_138', 139: 'UNKNOWN_139', 140: 'UNKNOWN_140',
  };
  for (const id of [53, 67, 74, 75, 79]) m[id] = 'Weave of Light Weapons';
  let id = 94;
  for (const tier of ['Minor', 'Major', 'Blackfire']) {
    for (const base of ['Shrouded Soul', 'Darkened Mind', 'Clouded Spirit']) {
      for (const kind of ['Stinging', 'Sparking', 'Smoldering', 'Shivering']) m[id++] = `${tier} ${kind} ${base}`;
    }
  }
  return m;
})();

/** Material ids Mag-Tools has no name for: the category ids (Cloth, Gem, Metal, Stone, Wood) and Unknown. */
const MT_UNNAMED_MATERIALS = new Set([0, 3, 9, 56, 65, 72]);
/** MaterialType → name (our MATERIAL_NAMES, which match Mag-Tools' list), or null where Mag-Tools has none. */
export function mtMaterialName(id: number): string | null {
  if (MT_UNNAMED_MATERIALS.has(id)) return null;
  return MATERIAL_NAMES[id] ?? null;
}

// ─── §8 row 6: imbues ────────────────────────────────────────────────────

const IMBUE_BITS: ReadonlyArray<[number, string]> = [
  [1, ' CS'], [2, ' CB'], [4, ' AR'], [8, ' SlashRend'], [16, ' PierceRend'], [32, ' BludgeRend'], [64, ' AcidRend'],
  [128, ' FrostRend'], [256, ' LightRend'], [512, ' FireRend'], [1024, ' MeleeImbue'], [4096, ' MagicImbue'],
  [8192, ' Hematited'], [0x20000000, ' MagicAbsorb'],
];

// ─── Buffed values (spec §8 row 17) ──────────────────────────────────────

/**
 * Spell id → the item property it changes, by how much, and the bonus the item carries for it
 * (spec §8, Mag-Tools Dictionaries). Ids checked against ACE SpellId.cs (every one names the
 * spell the spec says) and the magnitudes against the ACE world DB `spell` table where it has
 * them (VI/VII, Minor/Major tiers, Feeble…Major Hermetic Link).
 *
 * `bonus` (what an item carrying the spell gains when wielded) is set for the cantrips and
 * item-only spells; a war buff (VI, VII, Incantation, Prodigal) carried by an item is stripped
 * like any other enchantment and adds nothing, as the spec's "strip temporary item buffs, add
 * the item's own cantrip bonus" reads. `multiply`: ManaConversionMod scales.
 */
export interface MtSpellEffect { property: { kind: 'int' | 'float'; id: number }; change: number; bonus: number; multiply?: boolean }

const DMG = { kind: 'int' as const, id: PropertyInt.Damage };
const AL = { kind: 'int' as const, id: PropertyInt.ArmorLevel };
const EDM = { kind: 'float' as const, id: PropertyFloat.ElementalDamageMod };
const OFF = { kind: 'float' as const, id: PropertyFloat.WeaponOffense };
const DEF = { kind: 'float' as const, id: PropertyFloat.WeaponDefense };
const MC = { kind: 'float' as const, id: PropertyFloat.ManaConversionMod };

export const MT_SPELL_EFFECTS: Readonly<Record<number, MtSpellEffect>> = {
  // MaxDamage: Blood Drinker VI, Infected Caress, Incantation of Blood Drinker (×2), Blood Thirst cantrips, Prodigal.
  1616: { property: DMG, change: 20, bonus: 0 }, 2096: { property: DMG, change: 22, bonus: 0 },
  5183: { property: DMG, change: 24, bonus: 0 }, 4395: { property: DMG, change: 24, bonus: 0 },
  2598: { property: DMG, change: 2, bonus: 2 }, 2586: { property: DMG, change: 4, bonus: 4 },
  4661: { property: DMG, change: 7, bonus: 7 }, 6089: { property: DMG, change: 10, bonus: 10 },
  3688: { property: DMG, change: 300, bonus: 0 },
  // ArmorLevel: Impenetrability VI, Brogard's Defiance, Incantation, Impenetrability cantrips.
  1486: { property: AL, change: 200, bonus: 0 }, 2108: { property: AL, change: 220, bonus: 0 },
  4407: { property: AL, change: 240, bonus: 0 },
  2604: { property: AL, change: 20, bonus: 20 }, 2592: { property: AL, change: 40, bonus: 40 },
  4667: { property: AL, change: 60, bonus: 60 }, 6095: { property: AL, change: 80, bonus: 80 },
  // ElementalDamageMod: Spirit Drinker VI, Infected Spirit Caress, Incantation (×2), Spirit Thirst cantrips, Prodigal.
  3258: { property: EDM, change: 0.06, bonus: 0 }, 3259: { property: EDM, change: 0.07, bonus: 0 },
  5182: { property: EDM, change: 0.08, bonus: 0 }, 4414: { property: EDM, change: 0.08, bonus: 0 },
  3251: { property: EDM, change: 0.01, bonus: 0.01 }, 3250: { property: EDM, change: 0.03, bonus: 0.03 },
  4670: { property: EDM, change: 0.05, bonus: 0.05 }, 6098: { property: EDM, change: 0.07, bonus: 0.07 },
  3735: { property: EDM, change: 0.15, bonus: 0 },
  // WeaponOffense: Heart Seeker VI, Elysa's Sight, Incantation, Heart Thirst cantrips.
  1592: { property: OFF, change: 0.15, bonus: 0 }, 2106: { property: OFF, change: 0.17, bonus: 0 },
  4405: { property: OFF, change: 0.2, bonus: 0 },
  2603: { property: OFF, change: 0.03, bonus: 0.03 }, 2591: { property: OFF, change: 0.05, bonus: 0.05 },
  4666: { property: OFF, change: 0.07, bonus: 0.07 }, 6094: { property: OFF, change: 0.09, bonus: 0.09 },
  // WeaponDefense: Defender VI, Cragstone's Will, Incantation, Defender cantrips, Mukkir Sense (an item spell), Prodigal.
  1605: { property: DEF, change: 0.15, bonus: 0 }, 2101: { property: DEF, change: 0.17, bonus: 0 },
  4400: { property: DEF, change: 0.2, bonus: 0 },
  2600: { property: DEF, change: 0.03, bonus: 0.03 }, 2588: { property: DEF, change: 0.05, bonus: 0.05 },
  4663: { property: DEF, change: 0.07, bonus: 0.07 }, 6091: { property: DEF, change: 0.09, bonus: 0.09 },
  3985: { property: DEF, change: 0.04, bonus: 0.04 }, 3699: { property: DEF, change: 0.25, bonus: 0 },
  // ManaConversionMod (multipliers): Hermetic Link VI, Mystic's Blessing, Incantation, Feeble…Legendary Hermetic Link.
  1480: { property: MC, change: 1.6, bonus: 0, multiply: true }, 2117: { property: MC, change: 1.7, bonus: 0, multiply: true },
  4418: { property: MC, change: 1.8, bonus: 0, multiply: true },
  3201: { property: MC, change: 1.05, bonus: 1.05, multiply: true }, 3199: { property: MC, change: 1.1, bonus: 1.1, multiply: true },
  3202: { property: MC, change: 1.15, bonus: 1.15, multiply: true }, 3200: { property: MC, change: 1.2, bonus: 1.2, multiply: true },
  6086: { property: MC, change: 1.25, bonus: 1.25, multiply: true }, 6087: { property: MC, change: 1.3, bonus: 1.3, multiply: true },
};

/** A float mod's value when the item lacks it: the multipliers read 1, the rest 0. */
const FLOAT_ONE = new Set<number>([
  PropertyFloat.DamageMod, PropertyFloat.ElementalDamageMod, PropertyFloat.WeaponOffense, PropertyFloat.WeaponDefense,
  PropertyFloat.WeaponMagicDefense, PropertyFloat.WeaponMissileDefense,
]);

const intOf = (item: MtItemData, id: number): number => item.int[id] ?? 0;
const floatOf = (item: MtItemData, id: number): number => item.float[id] ?? (FLOAT_ONE.has(id) ? 1 : 0);

function buffed(item: MtItemData, kind: 'int' | 'float', id: number): number {
  let v = kind === 'int' ? intOf(item, id) : floatOf(item, id);
  for (const sid of item.activeSpellIds ?? []) {
    const e = MT_SPELL_EFFECTS[sid];
    if (!e || e.property.kind !== kind || e.property.id !== id) continue;
    v = e.multiply ? v / e.change : v - e.change;
  }
  for (const s of item.spells) {
    const e = MT_SPELL_EFFECTS[s.id];
    if (!e || !e.bonus || e.property.kind !== kind || e.property.id !== id) continue;
    v = e.multiply ? v * e.bonus : v + e.bonus;
  }
  return v;
}

/** The item's value of an int property with temporary item buffs stripped and its own cantrip bonus added. */
export function mtBuffedInt(item: MtItemData, id: number): number { return buffed(item, 'int', id); }
/** The same for a float property. */
export function mtBuffedFloat(item: MtItemData, id: number): number { return buffed(item, 'float', id); }

/** Damage over time with 10% crits at 2×: m × (0.9 × (2 − v) / 2 + 0.1 × 2). */
function dot(max: number, variance: number): number {
  return max * ((1 - 0.1) * (2 - variance) / 2 + 0.1 * 2);
}

/**
 * Mag-Tools' "CalcedBuffedTinkedDoT": the buffed max damage under an assumed +24 Blood Drinker,
 * with the item's remaining tinks spent one at a time on iron (+1 max) or granite (variance ×0.8),
 * whichever gives more; one tink is held back for an imbue when the item has none.
 */
export function mtBuffedTinkedDoT(item: MtItemData): number {
  let max = mtBuffedInt(item, PropertyInt.Damage);
  let v = floatOf(item, PropertyFloat.DamageVariance);
  let left = 0;
  if (intOf(item, PropertyInt.MaterialType) > 0) {
    left = Math.max(10 - intOf(item, PropertyInt.NumTimesTinkered), 0);
    if (intOf(item, PropertyInt.ImbuedEffect) === 0) left -= 1;
  }
  for (let i = 0; i < left; i++) {
    if (dot(max + 24 + 1, v) >= dot(max + 24, v * 0.8)) max += 1;
    else v *= 0.8;
  }
  return dot(max + 24, v);
}

/** Mag-Tools' buffed missile damage: max + (damage mod − 1) × 100 ÷ 3 + elemental bonus, all buffed. */
export function mtBuffedMissileDamage(item: MtItemData): number {
  return mtBuffedInt(item, PropertyInt.Damage)
    + ((mtBuffedFloat(item, PropertyFloat.DamageMod) - 1) * 100) / 3
    + mtBuffedInt(item, PropertyInt.ElementalDamageBonus);
}

// ─── §8 row 18: which spells show ────────────────────────────────────────

/** Weapon-buff spell families (Blood Drinker, Heart Seeker, Defender, Swift Killer, Spirit Drinker …). */
const WEAPON_BUFF_FAMILIES = new Set([152, 153, 154, 155, 156, 157, 158, 195, 325]);
const LEVEL_SUFFIX = /\s(I|II|III|IV|V|VI)$/;

/** Whether the item-info line names this spell (spec §8 "Spell filter"). */
export function mtShowsSpell(item: MtItemData, spell: MtSpellInfo): boolean {
  if (intOf(item, PropertyInt.MaterialType) <= 0) return true;
  if (/(Minor|Major|Epic|Legendary) Impenetrability/.test(spell.name)) return true;
  if (spell.name.includes('Augmented')) return true;
  const baneLike = spell.name.includes('Bane') || spell.name.startsWith('Impen') || spell.name.startsWith('Brogard');
  if (baneLike) return intOf(item, PropertyInt.ResistMagic) !== 0;
  if (WEAPON_BUFF_FAMILIES.has(spell.family)) {
    if (spell.difficulty === 250) return false;
    return spell.difficulty === 300 || spell.difficulty >= 400;
  }
  if (LEVEL_SUFFIX.test(spell.name)) return false;
  if (spell.difficulty === 300) return false;
  if (spell.name.includes('Incantation')) return false;
  return true;
}

// ─── The line ────────────────────────────────────────────────────────────

export interface MtItemInfoOptions {
  /** ItemInfoOnIdent.ShowBuffedValues (default on). */
  showBuffedValues: boolean;
  /** ItemInfoOnIdent.ShowValueAndBurden (default off). */
  showValueAndBurden: boolean;
}

const skillName = (id: number): string | null => MT_SKILL_NAMES[id] ?? null;

/** Mag-Tools' `<itemInfo>` string for an appraised item (spec §8, fragments 1–29 in order). */
export function mtItemInfo(item: MtItemData, opts: MtItemInfoOptions): string {
  const I = (id: number) => intOf(item, id);
  const F = (id: number) => floatOf(item, id);
  let s = '';
  // 1. material
  const material = I(PropertyInt.MaterialType);
  if (material > 0) s += mtMaterialName(material) !== null ? `${mtMaterialName(material)} ` : `unknown material ${material} `;
  // 2. name
  s += item.name;
  // 3. mastery
  const mastery = I(PropertyInt.WeaponType);
  if (mastery > 0) s += MT_MASTERY_NAMES[mastery] ? ` (${MT_MASTERY_NAMES[mastery]})` : ` (Unknown mastery ${mastery})`;
  // 4. set
  const set = I(PropertyInt.EquipmentSetId);
  if (set !== 0) s += MT_SET_NAMES[set] !== undefined ? `, ${MT_SET_NAMES[set]}` : `, Unknown set ${set}`;
  // 5. armor level
  if (I(PropertyInt.ArmorLevel) > 0) s += `, AL ${I(PropertyInt.ArmorLevel)}`;
  // 6. imbues
  const imbue = I(PropertyInt.ImbuedEffect);
  if (imbue > 0) {
    s += ',';
    for (const [bit, label] of IMBUE_BITS) if ((imbue & bit) !== 0) s += label;
  }
  // 7. tinks
  if (I(PropertyInt.NumTimesTinkered) > 0) s += `, Tinks ${I(PropertyInt.NumTimesTinkered)}`;
  // 8. damage range
  const maxDmg = I(PropertyInt.Damage);
  const variance = F(PropertyFloat.DamageVariance);
  if (maxDmg !== 0) s += variance !== 0 ? `, ${mtN(maxDmg - maxDmg * variance, 2)}-${maxDmg}` : `, ${maxDmg}`;
  // 9–16. bonuses
  if (I(PropertyInt.ElementalDamageBonus) !== 0) s += `, +${I(PropertyInt.ElementalDamageBonus)}`;
  if (F(PropertyFloat.DamageMod) !== 1) s += `, +${mtRound((F(PropertyFloat.DamageMod) - 1) * 100)}%`;
  if (F(PropertyFloat.ElementalDamageMod) !== 1) s += `, +${mtRound((F(PropertyFloat.ElementalDamageMod) - 1) * 100)}%vs. Monsters`;
  if (F(PropertyFloat.WeaponOffense) !== 1) s += `, +${mtRound((F(PropertyFloat.WeaponOffense) - 1) * 100)}%a`;
  if (F(PropertyFloat.WeaponDefense) !== 1) s += `, ${mtRound((F(PropertyFloat.WeaponDefense) - 1) * 100)}%md`;
  if (F(PropertyFloat.WeaponMagicDefense) !== 1) s += `, ${mtDouble(mtRoundTo((F(PropertyFloat.WeaponMagicDefense) - 1) * 100, 1))}%mgc.d`;
  if (F(PropertyFloat.WeaponMissileDefense) !== 1) s += `, ${mtDouble(mtRoundTo((F(PropertyFloat.WeaponMissileDefense) - 1) * 100, 1))}%msl.d`;
  if (F(PropertyFloat.ManaConversionMod) !== 0) s += `, ${mtRound(F(PropertyFloat.ManaConversionMod) * 100)}%mc`;
  // 17. buffed values
  const cls = item.objectClass;
  if (opts.showBuffedValues && (cls === MtObjectClass.MeleeWeapon || cls === MtObjectClass.MissileWeapon || cls === MtObjectClass.WandStaffOrb)) {
    s += ', (';
    if (cls === MtObjectClass.MeleeWeapon) s += `${mtN(mtBuffedTinkedDoT(item), 1)}/${mtBuffedInt(item, PropertyInt.Damage)}`;
    else if (cls === MtObjectClass.MissileWeapon) s += mtN(mtBuffedMissileDamage(item), 1);
    else s += mtN((mtBuffedFloat(item, PropertyFloat.ElementalDamageMod) - 1) * 100, 1);
    s += ' ';
    if (F(PropertyFloat.WeaponOffense) !== 1) s += `${mtN(mtRound((mtBuffedFloat(item, PropertyFloat.WeaponOffense) - 1) * 100), 1)}/`;
    if (F(PropertyFloat.WeaponDefense) !== 1) s += mtN(mtRound((mtBuffedFloat(item, PropertyFloat.WeaponDefense) - 1) * 100), 1);
    if (F(PropertyFloat.ManaConversionMod) !== 0) s += `/${mtRound(mtBuffedFloat(item, PropertyFloat.ManaConversionMod) * 100)}`;
    s += ')';
  }
  // 18. spells, highest id first
  for (const spell of [...item.spells].sort((a, b) => b.id - a.id)) {
    if (mtShowsSpell(item, spell)) s += `, ${spell.name}`;
  }
  // 19. wield requirement
  const wieldDiff = I(PropertyInt.WieldDifficulty);
  const wieldSkill = I(PropertyInt.WieldSkillType);
  if (wieldDiff > 0) {
    if (I(PropertyInt.WieldRequirements) === 7 && wieldSkill === 1) s += `, Wield Lvl ${wieldDiff}`;
    else s += skillName(wieldSkill) !== null ? `, ${skillName(wieldSkill)} ${wieldDiff}` : `, Unknown skill: ${wieldSkill} ${wieldDiff}`;
  }
  // 20. level to use
  if (I(PropertyInt.UseRequiresLevel) > 0) s += `, Lvl ${I(PropertyInt.UseRequiresLevel)}`;
  // 21. activation skill
  const limit = I(PropertyInt.ItemSkillLevelLimit);
  const actSkill = I(PropertyInt.AppraisalItemSkill);
  if (limit > 0 && (wieldSkill !== actSkill || wieldDiff < limit)) {
    s += skillName(actSkill) !== null ? `, ${skillName(actSkill)} ${limit} to Activate` : `, Unknown skill: ${actSkill} ${limit} to Activate`;
  }
  // 22–23. use requirements
  const useSkill = I(PropertyInt.UseRequiresSkill);
  const useLevel = I(PropertyInt.UseRequiresSkillLevel);
  const useSpec = I(PropertyInt.UseRequiresSkillSpec);
  if (useSkill > 0 && useLevel > 0) s += skillName(useSkill) !== null ? `, ${skillName(useSkill)} ${useLevel}` : `, Unknown skill: ${useSkill} ${useLevel}`;
  if (useSpec > 0 && useLevel > 0) s += skillName(useSpec) !== null ? `, Spec ${skillName(useSpec)} ${useLevel}` : `, Unknown skill spec: ${useSpec} ${useLevel}`;
  // 24. arcane lore difficulty
  if (I(PropertyInt.ItemDifficulty) > 0) s += `, Diff ${I(PropertyInt.ItemDifficulty)}`;
  // 25. workmanship
  const salvageWork = cls === MtObjectClass.Salvage && I(PropertyInt.NumItemsInMaterial) > 0
    ? I(PropertyInt.ItemWorkmanship) / I(PropertyInt.NumItemsInMaterial) : 0;
  if (cls === MtObjectClass.Salvage && salvageWork > 0) s += `, Work ${mtN(salvageWork, 2)}`;
  else if (I(PropertyInt.ItemWorkmanship) > 0 && I(PropertyInt.NumTimesTinkered) !== 10) s += `, Craft ${I(PropertyInt.ItemWorkmanship)}`;
  // 26. unenchantable armour's protections
  if (cls === MtObjectClass.Armor && I(PropertyInt.ResistMagic) !== 0) {
    const prots = [PropertyFloat.ArmorModVsSlash, PropertyFloat.ArmorModVsPierce, PropertyFloat.ArmorModVsBludgeon,
      PropertyFloat.ArmorModVsCold, PropertyFloat.ArmorModVsFire, PropertyFloat.ArmorModVsAcid, PropertyFloat.ArmorModVsElectric];
    s += `, [${prots.map((p) => mtN(F(p), 1)).join('/')}]`;
  }
  // 27. value and burden
  if (opts.showValueAndBurden) {
    if (I(PropertyInt.Value) > 0) s += `, Value ${mtN(I(PropertyInt.Value), 0)}`;
    if (I(PropertyInt.EncumbranceVal) > 0) s += `, BU ${I(PropertyInt.EncumbranceVal)}`;
  }
  // 28. gear ratings
  const ratings = ([
    ['D', PropertyInt.GearDamage], ['DR', PropertyInt.GearDamageResist], ['C', PropertyInt.GearCrit],
    ['CD', PropertyInt.GearCritDamage], ['CR', PropertyInt.GearCritResist], ['CDR', PropertyInt.GearCritDamageResist],
    ['HB', PropertyInt.GearHealingBoost], ['V', PropertyInt.GearMaxHealth],
  ] as const).filter(([, id]) => I(id) > 0).map(([label, id]) => `${label} ${I(id)}`);
  if (ratings.length) s += `, [${ratings.join(', ')}]`;
  // 29. keyrings
  if (cls === MtObjectClass.Misc && item.name.includes('Keyring')) s += `, Keys: ${I(PropertyInt.NumKeys)}, Uses: ${I(PropertyInt.Structure)}`;
  return s;
}

// ─── The loot-rule prefix ────────────────────────────────────────────────

/** What the loot profile says about an item: `+` when it would be looted, and the matching rule's name. */
export interface MtLootVerdict { looted: boolean; rule: string | null; salvage: boolean }

/** Our loot rules' answer (renderer RoutineEngine `lootRuleFor`) as Mag-Tools' verdict: any rule but Ignore loots it. */
export function mtLootVerdict(rule: LootRule | null): MtLootVerdict {
  if (!rule) return { looted: false, rule: null, salvage: false };
  return { looted: rule.action !== 'ignore', rule: rule.label ?? rule.action, salvage: rule.action === 'salvage' };
}

/** One item-info chat line, in parts so the chat can make `prefix` a link that selects `itemId`. */
export interface MtItemInfoLine {
  itemId: number;
  /** `+(Rule)`, `+`, `-` …; empty when no loot profile is loaded. */
  prefix: string;
  info: string;
  /** The whole line as plain text (`<prefix> <info>`, or `<info>`). */
  text: string;
}

/**
 * Mag-Tools' item-info line. `matcher` is the loaded loot profile (null when there is none:
 * the line is the bare item info). Upstream wraps the prefix in `<Tell:IIDString:…>…<\\Tell>`
 * with a doubled backslash; spec §12 #11 says emit a proper clickable item link instead, so the
 * prefix comes back on its own for the chat to link (`itemId`).
 */
export function mtItemInfoLine(item: MtItemData, opts: MtItemInfoOptions, matcher: ((item: MtItemData) => MtLootVerdict) | null): MtItemInfoLine {
  const info = mtItemInfo(item, opts);
  if (!matcher) return { itemId: item.id, prefix: '', info, text: info };
  const v = matcher(item);
  const prefix = (v.looted ? '+' : '-') + (v.rule ? `(${v.rule})` : '');
  return { itemId: item.id, prefix, info, text: `${prefix} ${info}` };
}

/**
 * Whether a line prints (spec §8 "Printer"): a user's ident always does; a container-scan item
 * only with a matching rule, and not a salvage rule's when salvage is suppressed (a container
 * named Chest / Vault / Reliquary). Without a loot profile, container-scan items never print.
 */
export function mtPrintsItem(verdict: MtLootVerdict | null, source: { containerScan: boolean; suppressSalvage?: boolean }): boolean {
  if (!source.containerScan) return true;
  if (!verdict || verdict.rule === null) return false;
  return !(source.suppressSalvage && verdict.salvage);
}

/** A container whose scan drops salvage rules (spec §8 "Container scan"). */
export function mtSuppressesSalvage(containerName: string): boolean {
  return /Chest|Vault|Reliquary/.test(containerName);
}
/** A container whose contents are never scanned. */
export function mtScansContainer(containerName: string): boolean {
  return containerName !== 'Storage';
}

// ─── Which appraisals print (spec §8 "Trigger") ─────────────────────────

const NEVER_PRINTED = new Set<number>([
  MtObjectClass.Corpse, MtObjectClass.Door, MtObjectClass.Foci, MtObjectClass.Housing, MtObjectClass.Lifestone,
  MtObjectClass.Npc, MtObjectClass.Portal, MtObjectClass.Vendor,
]);

/**
 * Mag-Tools' "items identified by the user": an appraisal prints when the object was selected
 * in the last 10 s (once), unless it is a corpse, door, focus, house, lifestone, NPC, portal or
 * vendor. With "Ident Items on Left Click", a selection within 1 s of a left click asks for an appraisal.
 */
export class MtIdentWatcher {
  private selected = new Map<number, number>();
  private lastLeftClick = -Infinity;

  leftClick(now: number): void { this.lastLeftClick = now; }

  /** A selection; true when it should be appraised now (left-click ident on and a left click within 1 s). */
  select(id: number, now: number, leftClickIdent: boolean): boolean {
    this.selected.set(id, now);
    return leftClickIdent && now - this.lastLeftClick <= 1000;
  }

  /** Appraisal data arrived: true when the info line should print. */
  appraised(id: number, objectClass: number, now: number): boolean {
    const at = this.selected.get(id);
    if (at === undefined || now - at > 10_000) return false;
    this.selected.delete(id);
    return !NEVER_PRINTED.has(objectClass);
  }
}
