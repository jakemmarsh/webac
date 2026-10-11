/**
 * VirindiTank Classic's loot editor, as data (docs/vtank-parity-gaps.md §3.2): its requirement types
 * under its own names, the fields each one shows and what they hold, the lists its dropdowns offer and
 * the line each requirement shows in the editor's list. The window's editor
 * (renderer ui/automation/lootEditor.ts) draws from this; the requirements are VTClassic's own
 * (type id, data lines), exactly as a .utl holds them, so what the editor makes the importer reads
 * (utlToLoot) and the exporter writes back (exportUtl).
 *
 * Ported from VTClassic's editor source, MIT-licensed (Copyright (c) 2008-2010 VirindiPlugins):
 * http://www.virindi.net/repos/virindi_public/trunk/VirindiTankLootPlugins/ — VTClassic Shared
 * LootRules.cs (each requirement's FriendlyName, DisplayString, UI_* fields and defaults),
 * Constants.cs (the key enums, eLootAction, GameInfo's material / skill / set / mastery tables) and
 * ComboKeys.cs (dropdowns list the enum names sorted).
 */
import type { LootAction } from './RoutineDoc.js';
import { VTCLASSIC_COLOR_SLOTS, type UtlRequirement, type UtlRule } from './vtank.js';

/** Constants.cs StringValueKey. */
export const VTC_STRING_KEYS: Record<string, number> = {
  Name: 1, Title: 5, Inscription: 7, InscribedBy: 8, FellowshipName: 10, UsageInstructions: 14, SimpleDescription: 15, FullDescription: 16,
  MonarchName: 21, OnlyActivatedBy: 25, Patron: 35, PortalDestination: 38, LastTinkeredBy: 39, ImbuedBy: 40, DateBorn: 43, SecondaryName: 184549376,
};
/** Constants.cs IntValueKey (ids above 0x10000 are Decal's own keys). */
export const VTC_INT_KEYS: Record<string, number> = {
  Species: 2, Burden: 5, EquippedSlots: 10, RareId: 17, Value: 19, TotalValue: 20, SkillCreditsAvail: 24, CreatureLevel: 25, RestrictedToToD: 26,
  ArmorLevel: 28, Rank: 30, Bonded: 33, NumberFollowers: 35, Unenchantable: 36, LockpickDifficulty: 38, Deaths: 43, WandElemDmgType: 45,
  MinLevelRestrict: 86, MaxLevelRestrict: 87, LockpickSkillBonus: 88, AffectsVitalId: 89, AffectsVitalAmt: 90, UsesTotal: 91, UsesRemaining: 92,
  DateOfBirth: 98, Workmanship: 105, Spellcraft: 106, CurrentMana: 107, MaximumMana: 108, LoreRequirement: 109, RankRequirement: 110,
  PortalRestrictions: 111, Gender: 113, Attuned: 114, SkillLevelReq: 115, ManaCost: 117, Age: 125, XPForVPReduction: 129, Material: 131,
  WieldReqType: 158, WieldReqAttribute: 159, WieldReqValue: 160, SlayerSpecies: 166, CooldownSeconds: 167, NumberItemsSalvagedFrom: 170,
  NumberTimesTinkered: 171, DescriptionFormat: 172, PagesUsed: 174, PagesTotal: 175, ActivationReqSkillId: 176, GemSettingQty: 177,
  GemSettingType: 178, Imbued: 179, Heritage: 188, FishingSkill: 192, KeysHeld: 193, ElementalDmgBonus: 204, ArmorSetID: 265, ItemMaxLevel: 319,
  CloakChanceType: 352, WeaponMasteryCategory: 353, SummoningGemBuffedSkillReq: 367, SummoningGemLevelReq: 369, DamRating: 370,
  DamResistRating: 371, CritRating: 372, CritResistRating: 373, CritDamRating: 374, CritDamResistRating: 375, HealBoostRating: 376,
  VitalityRating: 379, Type: 218103808, Icon: 218103809, Container: 218103810, Landblock: 218103811, ItemSlots: 218103812, PackSlots: 218103813,
  StackCount: 218103814, StackMax: 218103815, AssociatedSpell: 218103816, Slot: 218103817, Wielder: 218103818, WieldingSlot: 218103819,
  Monarch: 218103820, Coverage: 218103821, EquipableSlots: 218103822, EquipType: 218103823, IconOutline: 218103824, MissileType: 218103825,
  UsageMask: 218103826, HouseOwner: 218103827, HookMask: 218103828, HookType: 218103829, Model: 218103830, Flags: 218103831,
  CreateFlags1: 218103832, CreateFlags2: 218103833, Category: 218103834, Behavior: 218103835, MagicDef: 218103836, SpecialProps: 218103837,
  SpellCount: 218103838, WeapSpeed: 218103839, EquipSkill: 218103840, DamageType: 218103841, MaxDamage: 218103842, Unknown10: 218103843,
  Unknown100000: 218103844, Unknown800000: 218103845, Unknown8000000: 218103846, PhysicsDataFlags: 218103847, ActiveSpellCount: 218103848,
  IconOverlay: 218103849, IconUnderlay: 218103850,
};
/** Constants.cs DoubleValueKey. */
export const VTC_DOUBLE_KEYS: Record<string, number> = {
  ManaRateOfChange: 5, MeleeDefenseBonus: 29, ManaTransferEfficiency: 87, HealingKitRestoreBonus: 100, ManaStoneChanceDestruct: 137, ManaCBonus: 144,
  MissileDBonus: 149, MagicDBonus: 150, ElementalDamageVersusMonsters: 152, SlashProt: 167772160, PierceProt: 167772161, BludgeonProt: 167772162,
  AcidProt: 167772163, LightningProt: 167772164, FireProt: 167772165, ColdProt: 167772166, Heading: 167772167, ApproachDistance: 167772168,
  SalvageWorkmanship: 167772169, Scale: 167772170, Variance: 167772171, AttackBonus: 167772172, Range: 167772173, DamageBonus: 167772174,
};
/** Constants.cs ObjectClass (Decal's). */
export const VTC_OBJECT_CLASSES: Record<string, number> = {
  Unknown: 0, MeleeWeapon: 1, Armor: 2, Clothing: 3, Jewelry: 4, Monster: 5, Food: 6, Money: 7, Misc: 8, MissileWeapon: 9, Container: 10, Gem: 11,
  SpellComponent: 12, Key: 13, Portal: 14, TradeNote: 15, ManaStone: 16, Plant: 17, BaseCooking: 18, BaseAlchemy: 19, BaseFletching: 20,
  CraftedCooking: 21, CraftedAlchemy: 22, CraftedFletching: 23, Player: 24, Vendor: 25, Door: 26, Corpse: 27, Lifestone: 28, HealingKit: 29,
  Lockpick: 30, WandStaffOrb: 31, Bundle: 32, Book: 33, Journal: 34, Sign: 35, Housing: 36, Npc: 37, Foci: 38, Salvage: 39, Ust: 40, Services: 41,
  Scroll: 42,
};
/** Constants.cs VTCSkillID (AC skill ids). */
export const VTC_SKILLS: Record<string, number> = {
  Axe: 1, Bow: 2, Crossbow: 3, Dagger: 4, Mace: 5, MeleeDefense: 6, MissileDefense: 7, Spear: 9, Staff: 10, Sword: 11, ThrownWeapons: 12, Unarmed: 13,
  ArcaneLore: 14, MagicDefense: 15, ManaConversion: 16, ItemTinkering: 18, AssessPerson: 19, Deception: 20, Healing: 21, Jump: 22, Lockpick: 23,
  Run: 24, AssessCreature: 27, WeaponTinkering: 28, ArmorTinkering: 29, MagicItemTinkering: 30, CreatureEnchantment: 31, ItemEnchantment: 32,
  LifeMagic: 33, WarMagic: 34, Leadership: 35, Loyalty: 36, Fletching: 37, Alchemy: 38, Cooking: 39, Salvaging: 40, TwoHandedCombat: 41,
  Gearcraft: 42, Void: 43, HeavyWeapons: 44, LightWeapons: 45, FinesseWeapons: 46, MissileWeapons: 47, Shield: 48, DualWield: 49, Recklessness: 50,
  SneakAttack: 51, DirtyFighting: 52, Summoning: 54,
};
/** GameInfo.getMaterialInfo: the editor's material names. */
export const VTC_MATERIALS: Record<string, number> = {
  Agate: 10, Alabaster: 66, Amber: 11, Amethyst: 12, Aquamarine: 13, 'Armoredillo Hide': 53, Azurite: 14, 'Black Garnet': 15, 'Black Opal': 16,
  Bloodstone: 17, Brass: 57, Bronze: 58, Carnelian: 18, Ceramic: 1, Citrine: 19, Copper: 59, Diamond: 20, Ebony: 73, Emerald: 21, 'Fire Opal': 22,
  Gold: 60, Granite: 67, 'Green Garnet': 23, 'Green Jade': 24, 'Gromnie Hide': 54, Hematite: 25, 'Imperial Topaz': 26, Iron: 61, Ivory: 51, Jet: 27,
  'Lapis Lazuli': 28, 'Lavender Jade': 29, Leather: 52, Linen: 4, Mahogany: 74, Malachite: 30, Marble: 68, Moonstone: 31, Oak: 75, Obsidian: 69,
  Onyx: 32, Opal: 33, Peridot: 34, Pine: 76, Porcelain: 2, Pyreal: 62, 'Red Garnet': 35, 'Red Jade': 36, 'Reed Shark Hide': 55, 'Rose Quartz': 37,
  Ruby: 38, Sandstone: 70, Sapphire: 39, Satin: 5, Serpentine: 71, Silk: 6, Silver: 63, 'Smokey Quartz': 40, Steel: 64, Sunstone: 41, Teak: 77,
  'Tiger Eye': 42, Tourmaline: 43, Turquoise: 44, Velvet: 7, 'White Jade': 45, 'White Quartz': 46, 'White Sapphire': 47, Wool: 8,
  'Yellow Garnet': 48, 'Yellow Topaz': 49, Zircon: 50,
};
/** GameInfo.getSkillInfo: the Info box's skill names (WieldReqAttribute values). */
export const VTC_SKILL_INFO: Record<string, number> = {
  'Axe (DEPRECEATED)': 1, 'Bow (DEPRECEATED)': 2, 'Crossbow (DEPRECEATED)': 3, 'Dagger (DEPRECEATED)': 4, 'Mace (DEPRECEATED)': 5, MeleeD: 6,
  MissileD: 7, 'Spear (DEPRECEATED)': 9, 'Staff (DEPRECEATED)': 10, 'Sword (DEPRECEATED)': 11, 'Thrown Weapons (DEPRECEATED)': 12,
  'Unarmed Combat (DEPRECEATED)': 13, MagicD: 15, ManaCon: 16, Creature: 31, Item: 32, Life: 33, War: 34, 'Two-Handed Combat': 41, Void: 43,
  'Heavy Weapons': 44, 'Light Weapons': 45, 'Finesse Weapons': 46, 'Missile Weapons': 47, Shield: 48, 'Dual Wield': 49, Recklessness: 50,
  'Sneak Attack': 51, 'Dirty Fighting': 52, Summoning: 54,
};
/** GameInfo.getSetInfo: the Info box's armour sets (ArmorSetID values). */
export const VTC_SETS: Record<string, number> = Object.fromEntries([
  'Protective Clothing', 'Gladiatorial Clothing', 'Dedication', 'Lightning Proof', 'Cold Proof', 'Acid Proof', 'Flame Proof', 'Interlocking', 'Reinforced',
  'Hardenend', 'Swift', 'Wise', 'Dexterous', 'Hearty', "Crafter's", "Tinker's", "Defender's", "Archer's", "Adept's", "Soldier's",
  'Leggings of Perfect Light', 'Coat of the Perfect Light', 'Arm, Mind, Heart', 'Empyrean Rings', 'Shou-jen', 'Relic Alduressa', 'Ancient Relic', 'Noble Relic',
].map((nm, i) => [nm, 32 - i]));
/** GameInfo.getMasteryInfo (WeaponMasteryCategory values). */
export const VTC_MASTERIES: Record<string, number> = {
  'Unarmed Weapon': 1, Sword: 2, Axe: 3, Mace: 4, Spear: 5, Dagger: 6, Staff: 7, Bow: 8, Crossbow: 9, Thrown: 10, 'Two Handed Combat': 11,
};

/** .NET's default string order (Array.Sort / SortedDictionary on strings: culture-aware, not ordinal). */
export const vtcSort = (a: string, b: string): number => a.localeCompare(b, 'en');
/** A table's names in the order VTClassic's dropdowns list them (ComboKeys: sorted). */
export const vtcNames = (t: Record<string, number>): string[] => Object.keys(t).sort(vtcSort);
const nameOf = (t: Record<string, number>, id: number): string => Object.keys(t).find((k) => t[k] === id) ?? String(id);
/** The name an id has in one of GameInfo's tables (material, skill, mastery), else undefined. */
const infoName = (t: Record<string, number>, id: number): string | undefined => Object.keys(t).sort(vtcSort).find((k) => t[k] === id);

/** VTClassic's actions as its editor lists them (eLootActionTool.FriendlyNames), with their ids. */
export const VTC_ACTIONS: Array<{ id: number; label: string }> = [
  { id: 1, label: 'Keep' }, { id: 2, label: 'Salvage' }, { id: 3, label: 'Sell' }, { id: 4, label: 'Read' }, { id: 10, label: 'Keep #' },
];
/** eLootAction names, for actions the editor's list doesn't offer (NoLoot, User1–5). */
const ACTION_NAMES: Record<number, string> = { 0: 'NoLoot', 1: 'Keep', 2: 'Salvage', 3: 'Sell', 4: 'Read', 5: 'User1', 6: 'User2', 7: 'User3', 8: 'User4', 9: 'User5', 10: 'Keep #' };
export const vtcActionName = (id: number): string => ACTION_NAMES[id] ?? String(id);
/** Our loot action → VTClassic's id. */
export const VTC_ACTION_OF: Record<LootAction, number> = { ignore: 0, keep: 1, salvage: 2, sell: 3, read: 4, 'keep-up-to': 10 };

/** .NET's Regex(text) where it parses, else the text escaped (iLootRule.createRegexForText). */
export function vtcRegexText(text: string): string {
  try { new RegExp(text); return text; } catch { return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
}
const int = (v: string): string => { const t = v.trim(); return /^[-+]?\d+$/.test(t) && Number.isSafeInteger(Number(t)) ? String(Number(t)) : '0'; };
const dbl = (v: string): string => { const x = Number(v.trim().replace(',', '.')); return v.trim() !== '' && Number.isFinite(x) ? String(x) : '0'; };
const dnum = (s: string | undefined): string => { const x = Number(String(s ?? '0').replace(',', '.')); return Number.isFinite(x) ? String(x) : '0'; };
const hex = (v: string): number => { const t = v.trim(); return /^[0-9a-f]+$/i.test(t) ? parseInt(t, 16) & 0xffffff : 0; };

/** One field of a requirement: its label, and how it reads and writes the requirement's lines. */
export interface VtcField { label: string; get(lines: string[]): string; set(lines: string[], value: string): string[] }
/** The "Acts on" dropdown (VTClassic's UI_ActsOnCombo): its label, its options, and the chosen one. */
export interface VtcCombo { label: string; options(): string[]; get(lines: string[]): number; set(lines: string[], index: number): string[] }
/**
 * One VTClassic requirement type: its name in the Requirement Type dropdown (FriendlyName), a new
 * one's lines, the Acts on dropdown and the Value / Value 2 / Value 3 / Value 4 boxes it shows, and
 * its line in the requirement list (DisplayString). `needsId`: VTClassic draws it dark red (the item
 * must be examined first, MayRequireID).
 */
export interface VtcReqType {
  type: number;
  name: string;
  make(): string[];
  actsOn?: VtcCombo;
  values: Partial<Record<1 | 2 | 3 | 4, VtcField>>;
  display(lines: string[]): string;
  needsId(lines: string[]): boolean;
  /** The colour sample (VTClassic's label4) for the colour requirements. */
  colour?(lines: string[]): [number, number, number];
}

/** A combo over a key table: the key is line `at`; an unknown id keeps its place (shown by number). */
const keyCombo = (label: string, t: Record<string, number>, at: number): VtcCombo => ({
  label,
  options: () => vtcNames(t),
  get: (l) => vtcNames(t).findIndex((k) => t[k] === Number(l[at])),
  set: (l, i) => { const k = vtcNames(t)[i]; const out = [...l]; if (k !== undefined) out[at] = String(t[k]); return out; },
});
const line = (label: string, at: number, parse: (v: string) => string): VtcField => ({ label, get: (l) => l[at] ?? '', set: (l, v) => { const out = [...l]; out[at] = parse(v); return out; } });
const dline = (label: string, at: number): VtcField => ({ label, get: (l) => dnum(l[at]), set: (l, v) => { const out = [...l]; out[at] = dbl(v); return out; } });

/** The keys an item has before it is examined (GameInfo.IsIDProperty returns false for these; every other key needs an examination). */
const ID_FREE_INT = new Set(['CreateFlags1', 'Type', 'Icon', 'Category', 'Behavior', 'CreateFlags2', 'IconUnderlay', 'ItemSlots', 'PackSlots', 'MissileType', 'Value',
  'UsageMask', 'IconOutline', 'EquipType', 'UsesRemaining', 'UsesTotal', 'StackCount', 'StackMax', 'Container', 'Slot', 'EquipableSlots', 'EquippedSlots',
  'Coverage', 'Unknown8000000', 'Monarch', 'HookMask', 'IconOverlay', 'Material'].map((k) => VTC_INT_KEYS[k]));
const ID_FREE_STRING = new Set([VTC_STRING_KEYS.Name, VTC_STRING_KEYS.SecondaryName]);
const ID_FREE_DOUBLE = new Set([VTC_DOUBLE_KEYS.ApproachDistance, VTC_DOUBLE_KEYS.SalvageWorkmanship]);

/** The annotation VTClassic adds to a Material / WieldReqAttribute / WeaponMasteryCategory value. */
function keyNote(key: number, v: string): string {
  const id = Number(v);
  const t = key === 131 ? VTC_MATERIALS : key === 159 ? VTC_SKILL_INFO : key === 353 ? VTC_MASTERIES : null;
  const name = t ? infoName(t, id) : undefined;
  return name ? ` (${name})` : '';
}
const longKey = (name: string, op: string): Omit<VtcReqType, 'type'> => ({
  name, make: () => ['0', '176'],
  actsOn: keyCombo('Acts on', VTC_INT_KEYS, 1),
  values: { 1: line('Long Value', 0, int) },
  display: (l) => `${nameOf(VTC_INT_KEYS, Number(l[1]))} ${op} ${l[0]}${keyNote(Number(l[1]), l[0])}`,
  needsId: (l) => !ID_FREE_INT.has(Number(l[1])),
});
const doubleKey = (name: string, op: string): Omit<VtcReqType, 'type'> => ({
  name, make: () => ['0', '167772163'],
  actsOn: keyCombo('Acts on', VTC_DOUBLE_KEYS, 1),
  values: { 1: dline('Double Value', 0) },
  display: (l) => `${nameOf(VTC_DOUBLE_KEYS, Number(l[1]))} ${op} ${dnum(l[0])}`,
  needsId: (l) => !ID_FREE_DOUBLE.has(Number(l[1])),
});
const single = (name: string, label: string, shown: (v: string) => string, parse: (v: string) => string, needsId: boolean): Omit<VtcReqType, 'type'> => ({
  name, make: () => ['0'], values: { 1: line(label, 0, parse) }, display: (l) => shown(l[0] ?? '0'), needsId: () => needsId,
});
/** A colour's RGB lines as VTClassic's hex box ((EColor.ToArgb() & 0xFFFFFF).ToString("X")), and back. */
const rgbField: VtcField = {
  label: 'RGB color value (hex)',
  get: (l) => (((Number(l[0]) & 255) << 16) | ((Number(l[1]) & 255) << 8) | (Number(l[2]) & 255)).toString(16).toUpperCase(),
  set: (l, v) => { const c = hex(v); const out = [...l]; out[0] = String((c >> 16) & 255); out[1] = String((c >> 8) & 255); out[2] = String(c & 255); return out; },
};
const colourText = (l: string[]): string => `Color [A=255, R=${l[0]}, G=${l[1]}, B=${l[2]}]`;
const colourFields = { 1: rgbField, 2: dline('Max diff (Hue 0-255)', 3), 3: dline('Max diff (S/V 0-1)', 4) };
const rgbOf = (l: string[]): [number, number, number] => [Number(l[0]) & 255, Number(l[1]) & 255, Number(l[2]) & 255];
const ARMOR_GROUPS = (): string[] => Object.keys(VTCLASSIC_COLOR_SLOTS);

/** Every VTClassic requirement type (LootRuleCreator), by type id. */
export const VTC_REQ_TYPES: VtcReqType[] = ([
  [0, { name: 'Spell Name Match', make: () => [''], values: { 1: line('Spell Name Pattern', 0, vtcRegexText) }, display: (l) => `SpellNameMatch: ${l[0] ?? ''}`, needsId: () => true }],
  [1, {
    name: 'String Value Match', make: () => ['', '16'], actsOn: keyCombo('Acts on', VTC_STRING_KEYS, 1),
    values: { 1: line('String Value Pattern', 0, vtcRegexText) },
    display: (l) => `${nameOf(VTC_STRING_KEYS, Number(l[1]))} matches: ${l[0] ?? ''}`, needsId: (l) => !ID_FREE_STRING.has(Number(l[1])),
  }],
  [2, longKey('Long Value Key <=', '<=')],
  [3, longKey('Long Value Key >=', '>=')],
  [4, doubleKey('Double Value Key <=', '<=')],
  [5, doubleKey('Double Value Key >=', '>=')],
  [6, single('Damage Percentage >=', 'Damage Percent', (v) => `DamagePercentGE >= ${dnum(v)}`, dbl, false)],
  [7, { name: 'ObjectClass', make: () => ['2'], actsOn: keyCombo('ObjectClass is', VTC_OBJECT_CLASSES, 0), values: {}, display: (l) => `ObjectClass = ${nameOf(VTC_OBJECT_CLASSES, Number(l[0]))}`, needsId: () => false }],
  [8, single('Spell Count >=', 'Spell Count', (v) => `SpellCount >= ${v}`, int, true)],
  [9, {
    name: 'Spell Match and Count', make: () => ['', '', '1'],
    values: { 1: line('Does Match', 0, vtcRegexText), 2: line('Does NOT Match', 1, vtcRegexText), 3: line('Minimum spells that match', 2, int) },
    display: (l) => ((l[1] ?? '').trim() === '' ? `SpellMatch: ${l[0] ?? ''} [${l[2] ?? '1'} times]` : `SpellMatch: ${l[0] ?? ''}, but not ${l[1]} [${l[2] ?? '1'} times]`),
    needsId: () => true,
  }],
  [10, single('Minimum Damage >=', 'Minimum Damage', (v) => `MinDamage >= ${dnum(v)}`, dbl, true)],
  [11, { ...longKey('Long Value Key Has Flags', ''), display: (l) => `${nameOf(VTC_INT_KEYS, Number(l[1]))} has flags ${l[0]} (0x${(Number(l[0]) >>> 0).toString(16).toUpperCase()})` }],
  [12, longKey('Long Value Key ==', '==')],
  [13, longKey('Long Value Key !=', '!=')],
  [14, { name: 'One Similar Color', make: () => ['255', '255', '255', '10', '0.1'], values: colourFields, display: (l) => `Any Color ${colourText(l)}: ${dnum(l[3])}, ${dnum(l[4])}`, needsId: () => false, colour: rgbOf }],
  [15, {
    name: 'Armor Type Similar Color', make: () => ['255', '255', '255', '10', '0.1', ARMOR_GROUPS()[0]],
    actsOn: { label: 'Armor Type/Color Region', options: ARMOR_GROUPS, get: (l) => ARMOR_GROUPS().indexOf(l[5] ?? ''), set: (l, i) => { const out = [...l]; out[5] = ARMOR_GROUPS()[i] ?? out[5]; return out; } },
    values: colourFields, display: (l) => `${l[5] ?? ''}: ${colourText(l)}, ${dnum(l[3])}, ${dnum(l[4])}`, needsId: () => false, colour: rgbOf,
  }],
  [16, { name: 'Slot Similar Color', make: () => ['255', '255', '255', '10', '0.1', '0'], values: { ...colourFields, 4: line('Palette Entry #', 5, int) }, display: (l) => `Slot ${l[5] ?? '0'} Color ${colourText(l)}: ${dnum(l[3])}, ${dnum(l[4])}`, needsId: () => false, colour: rgbOf }],
  [17, {
    name: 'Slot Exact Palette', make: () => ['0', '0'],
    values: { 1: line('Palette Entry #', 0, int), 2: { label: 'Palette ID', get: (l) => (Number(l[1]) & 0xffffff).toString(16).toUpperCase(), set: (l, v) => { const out = [...l]; out[1] = String(hex(v)); return out; } } },
    display: (l) => `Slot ${l[0] ?? '0'} Palette 0x${(Number(l[1]) >>> 0).toString(16).toUpperCase()}`, needsId: () => false,
  }],
  [1000, { name: 'Character Buffed Skill >=', make: () => ['0', '38'], actsOn: keyCombo('Acts on', VTC_SKILLS, 1), values: { 1: line('Buffed Skill Value', 0, int) }, display: (l) => `Buffed ${nameOf(VTC_SKILLS, Number(l[1]))} >= ${l[0]}`, needsId: () => false }],
  [1001, single('Free Main Pack Slots >=', 'Empty Slots', (v) => `Main pack slots >= ${v}`, int, false)],
  [1002, single('Character Level >=', 'Character Level', (v) => `Char Level >= ${v}`, int, false)],
  [1003, single('Character Level <=', 'Character Level', (v) => `Char Level <= ${v}`, int, false)],
  [1004, {
    name: 'Base Skill Range', make: () => ['38', '0', '999'], actsOn: keyCombo('Acts on', VTC_SKILLS, 0),
    values: { 1: line('Minimum Base Skill', 1, int), 2: line('Maximum Base Skill', 2, int) },
    display: (l) => `Base ${nameOf(VTC_SKILLS, Number(l[0]))} [${l[1]}-${l[2]}]`, needsId: () => false,
  }],
  [2000, single('Calced Buffed Median Damage >=', 'Calced Buffed Median Damage', (v) => `Buffed Median Damage >= ${dnum(v)}`, dbl, true)],
  [2001, single('Calced Buffed Missile Damage >=', 'Calced Buffed Missile Damage', (v) => `Buffed Missile Damage >= ${dnum(v)}`, dbl, true)],
  [2003, {
    name: 'Buffed Long Value Key >=', make: () => ['0', '218103842'],
    actsOn: { label: 'Acts on', options: () => ['ArmorLevel', 'MaxDamage'], get: (l) => [28, 218103842].indexOf(Number(l[1])), set: (l, i) => { const out = [...l]; out[1] = String([28, 218103842][i] ?? out[1]); return out; } },
    values: { 1: dline('Buffed Long Value', 0) }, display: (l) => `Buffed ${nameOf(VTC_INT_KEYS, Number(l[1]))} >= ${dnum(l[0])}`, needsId: () => true,
  }],
  [2005, {
    name: 'Buffed Double Value Key >=', make: () => ['0', '167772172'],
    actsOn: { label: 'Acts on', options: () => ['AttackBonus', 'ElementalDamageVersusMonsters', 'ManaCBonus', 'MeleeDefenseBonus'], get: (l) => [167772172, 152, 144, 29].indexOf(Number(l[1])), set: (l, i) => { const out = [...l]; out[1] = String([167772172, 152, 144, 29][i] ?? out[1]); return out; } },
    values: { 1: dline('Buffed Double Value', 0) }, display: (l) => `Buffed ${nameOf(VTC_DOUBLE_KEYS, Number(l[1]))} >= ${dnum(l[0])}`, needsId: () => true,
  }],
  [2006, single('Calced Buffed Tinked Dmg >=', 'Calced Buffed Tinked Damage', (v) => `Calced Buffed Tinked Dmg >= ${dnum(v)}`, dbl, true)],
  [2007, single('Calced Total Ratings >=', 'Calced Total Ratings', (v) => `Calced Total Ratings >= ${dnum(v)}`, dbl, true)],
  [2008, {
    name: 'Calced Buffed Tinked Target Melee', make: () => ['0', '0', '0'],
    values: { 1: dline('Target Calced Buffed Tinked DoT', 0), 2: dline('Target Buffed Melee Defense Bonus', 1), 3: dline('Target Buffed Attack Bonus', 2) },
    display: (l) => `Melee Target: ${dnum(l[0])} DoT: ${dnum(l[1])} md, ${dnum(l[2])} a`, needsId: () => true,
  }],
  [9999, {
    name: 'Enable/Disable', make: () => ['true'],
    actsOn: { label: 'Status', options: () => ['Disabled', 'Enabled'], get: (l) => (l[0] === 'true' ? 0 : 1), set: (_l, i) => [i < 1 ? 'true' : 'false'] },
    values: {}, display: (l) => (l[0] === 'true' ? 'This rule is currently disabled' : 'This rule is active'), needsId: () => false,
  }],
] as Array<[number, Omit<VtcReqType, 'type'>]>).map(([type, t]) => ({ type, ...t }));

export const vtcReqType = (type: number): VtcReqType | undefined => VTC_REQ_TYPES.find((t) => t.type === type);
/** The Requirement Type dropdown's order (Form1.SetCurrentReq): Enable/Disable first, then the rest by name. */
export const VTC_REQ_MENU: VtcReqType[] = [vtcReqType(9999)!, ...VTC_REQ_TYPES.filter((t) => t.type !== 9999).sort((a, b) => vtcSort(a.name, b.name))];

/** A requirement's line in the editor's list; one VTClassic doesn't know shows as it does ("UNSUPPORTED REQUIREMENT"). */
export function vtcReqText(q: UtlRequirement): string {
  const t = vtcReqType(q.type);
  return t ? t.display(q.lines) : 'UNSUPPORTED REQUIREMENT';
}
/** Whether a rule is switched off (an Enable/Disable requirement set to Disabled). */
export const vtcRuleDisabled = (r: UtlRule): boolean => r.reqs.some((q) => q.type === 9999 && q.lines[0] === 'true');
/** VTClassic draws a rule dark red when every requirement needs the item examined (lstRules_DrawItem's badRule). */
export const vtcRuleNeedsId = (r: UtlRule): boolean => !r.reqs.some((q) => !(vtcReqType(q.type)?.needsId(q.lines) ?? false));
/**
 * Toggle this rule (Form1.button3_Click): drop every Enable/Disable requirement; if none of them was
 * Disabled, add a Disabled one.
 */
export function vtcToggleRule(r: UtlRule): UtlRule {
  const was = vtcRuleDisabled(r);
  const reqs = r.reqs.filter((q) => q.type !== 9999);
  if (!was) reqs.push({ type: 9999, lines: ['true'] });
  return { ...r, reqs };
}
/** A new rule (cmdNewRule_Click): "New Rule", Keep, no requirements. */
export const vtcNewRule = (): UtlRule => ({ name: 'New Rule', action: 1, reqs: [] });
/** A new requirement (cmdNewReq_Click): a Spell Name Match. */
export const vtcNewReq = (): UtlRequirement => ({ type: 0, lines: [''] });
/** Change a requirement's type (cmbReqType): a fresh one of the new type. */
export const vtcReqOfType = (type: number): UtlRequirement => ({ type, lines: vtcReqType(type)?.make() ?? [] });

/**
 * Auto-Sort Rules (Form1.autoSortRulesToolStripMenuItem_Click): by action (Keep # counts as Keep),
 * then rules that need no examination first, then by name. A stable bubble sort, as VTClassic's.
 */
export function vtcAutoSort<T extends UtlRule>(rules: T[]): T[] {
  const out = [...rules];
  const act = (r: UtlRule) => (r.action === 10 ? 1 : r.action);
  const anyId = (r: UtlRule) => r.reqs.some((q) => vtcReqType(q.type)?.needsId(q.lines) ?? false);
  for (let i = out.length - 1; i > 0; i--) {
    for (let j = 0; j < i; j++) {
      const a = out[j]; const b = out[j + 1];
      const swap = act(a) > act(b) || (act(a) === act(b) && anyId(a) && !anyId(b)) || (act(a) === act(b) && anyId(a) === anyId(b) && a.name.localeCompare(b.name, 'en') > 0);
      if (swap) [out[j], out[j + 1]] = [b, a];
    }
  }
  return out;
}

/** The Salvage Combination tab's value mode default (Form_SalvageTab DEFAULT_VALUECOMBINE_VALUE). */
export const VTC_DEFAULT_VALUE_COMBINE = 390000;
/** A material's name as the Salvage Combination list shows it (GameInfo.getMaterialName), else its id. */
export const vtcMaterialName = (id: number): string => infoName(VTC_MATERIALS, id) ?? String(id);

/** GameInfo.getMaterialGroups: Rule → Add/Update Salvage Rules' material groups (listed by name). */
export const VTC_MATERIAL_GROUPS: Record<string, number[]> = {
  'Armor Tinkering': [66, 53, 58, 1, 68, 34, 55, 64, 8, 49, 50],
  'Item Tinkering': [59, 73, 60, 4, 76, 2, 31, 6, 63, 77],
  'Magic Item Tinkering': [10, 14, 16, 17, 18, 19, 22, 25, 29, 30, 33, 36, 37, 41],
  'Weapon Tinkering': [13, 15, 57, 21, 67, 61, 26, 27, 74, 75, 35, 7, 47],
  'Basic Tinkering': [51, 52],
  Gearcrafting: [11, 20, 54, 62, 38, 39],
  'Armor Imbues': [34, 49, 50],
  'Protection Tinks': [66, 53, 58, 1, 68, 55, 64, 8],
  'Weapon Imbues': [13, 15, 21, 26, 27, 35, 47, 41, 16],
  'Brass/Granite/Iron/Mahog': [57, 67, 61, 74],
  'RG/BG/Jet': [35, 15, 27],
};
/** A salvage rule's name for a material (Macros.addMaterialRules): "S: Gold". */
export const vtcSalvageRuleName = (material: number): string => `S: ${vtcMaterialName(material)}`;
/** A salvage rule's requirements (Macros.updateMaterialRule): Material == m (as <= and >=), SalvageWorkmanship >= w. */
export const vtcMaterialReqs = (material: number, work: number): UtlRequirement[] => [
  { type: 2, lines: [String(material), String(VTC_INT_KEYS.Material)] },
  { type: 3, lines: [String(material), String(VTC_INT_KEYS.Material)] },
  { type: 5, lines: [String(work), String(VTC_DOUBLE_KEYS.SalvageWorkmanship)] },
];
/**
 * Update Workmanship Requirements (Macros.alterWorkmanshipReqs) on one rule: every Double Value Key >=
 * raised by `by` (at most 10) and every <= lowered by it (at least 1); for Keep the change is reversed.
 * Ours stores SalvageWorkmanship as the item's Workmanship (ACE ItemWorkmanship 105, vtank.ts
 * DECAL_FLOAT_KEYS), which a rule shows as Long Value Key Workmanship, so those move too.
 * True when it changed anything.
 */
export function vtcAlterWorkmanship(r: UtlRule, by: number): boolean {
  const d = r.action === 1 ? -by : by;
  let changed = false;
  for (const q of r.reqs) {
    const v = Number(String(q.lines[0] ?? '0').replace(',', '.')) || 0;
    const work = Number(q.lines[1]) === VTC_INT_KEYS.Workmanship;
    if (q.type === 5 || (q.type === 3 && work)) { q.lines[0] = String(Math.min(10, v + d)); changed = true; }
    else if (q.type === 4 || (q.type === 2 && work)) { q.lines[0] = String(Math.max(1, v - d)); changed = true; }
  }
  return changed;
}
/**
 * Add Packslot Requirements on one rule (Form1.addPackslotRulesToolStripMenuItem_Click): a Free Main
 * Pack Slots >= `slots` where it has none; with `update`, an existing one is set to `slots` too.
 * True when it changed anything.
 */
export function vtcAddPackslots(r: UtlRule, slots: number, update: boolean): boolean {
  const have = r.reqs.find((q) => q.type === 1001);
  if (!have) { r.reqs.push({ type: 1001, lines: [String(slots)] }); return true; }
  if (update) { have.lines = [String(slots)]; return true; }
  return false;
}
