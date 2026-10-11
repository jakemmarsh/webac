/**
 * What VirindiTank keeps per macro profile beyond its options: the Monsters,
 * Items, Consumables and Buffs tabs (docs/vtank-macro-behavior.md §4–§7,
 * docs/automation-vtank-window.md). Stored on a routine profile as `vtank`.
 *
 * Items are kept by name (VTank keeps object ids; a name survives a relog and
 * another client). Spells are kept by name; "best similar" means the family
 * (the spell table's category) at the best level you can cast.
 */

/** VirindiTank's damage elements (VT_eDamageElement, Virindi's public MIT connector). */
export const VT_DAMAGE = {
  Pierce: 0, Bludgeon: 1, Slash: 2, Acid: 3, Lightning: 4, Cold: 5, Fire: 6, Harm: 7, Auto: 8, Void: 9, DrainAuto: 10, Prismatic: 11, Random: 12, Fists: 13, None: 98, Physical: 99,
} as const;
/** The PetDmg column's "same as the player" (PAuto). */
export const VT_PET_AUTO = 101;
/** The Monsters tab's switch columns, in its order (F B G I Y V A R S WC FC Cp DC Cs). */
export const VT_MONSTER_COLUMNS = ['F', 'B', 'G', 'I', 'Y', 'V', 'A', 'R', 'S', 'WC', 'FC', 'Cp', 'DC', 'Cs'] as const;
export type VtMonsterColumn = (typeof VT_MONSTER_COLUMNS)[number];

export interface VtMonsterRow {
  /** A monster name, or a Monster Expression when `expr` is set. The first row is `<DEFAULT>`. */
  name: string;
  expr?: boolean;
  /** -1 ignore; 0–4 attack, higher first. */
  priority: number;
  /** The switch columns that are on. */
  on: VtMonsterColumn[];
  /** VT_DAMAGE value (Auto = 8). */
  damage: number;
  /** An extra element vuln (VT_DAMAGE value; None = 98). */
  exVuln: number;
  /** An Items-tab item by name, or null for <AUTO>. */
  weapon: string | null;
  offhand: string | null;
  /** Which of same-named Items-tab entries Weapon / Offhand means: that entry's object id (VtItemEntry.id). */
  weaponId?: number;
  offhandId?: number;
  /** VT_DAMAGE value or VT_PET_AUTO. */
  petDamage: number;
  /**
   * From a VTank `.usd`: the WeaponToUse / SecondaryEquip object ids when no carried item had that id at
   * import (object ids are the server's, per character). Written back as they were (vtankUsd.ts).
   */
  vt?: { weapon?: number; offhand?: number };
}

export const VT_DEFAULT_MONSTER: VtMonsterRow = { name: '<DEFAULT>', priority: 1, on: ['A', 'S'], damage: VT_DAMAGE.Auto, exVuln: VT_DAMAGE.None, weapon: null, offhand: null, petDamage: VT_PET_AUTO };

export interface VtankProfileData {
  /** The Monsters tab, `<DEFAULT>` first. */
  monsters: VtMonsterRow[];
  /** Weapons / wands / shields / pets; `noBuffs`: Add (no buffs). */
  items: VtItemEntry[];
  /** Gems / food / kits / potions / charges / grenades / lockpicks (and peas to split), by name. */
  consumables: string[];
  /** Spell components whose spells are not cast. */
  excludedScarabs: string[];
  /** Extra Buff Spells: one spell of each family to keep up (the best similar is used). */
  extraBuffs: string[];
  /** Blacklisted Buff Families: one spell of each family never cast. */
  blacklistedBuffs: string[];
  /**
   * VTank's GemFoodItems table (Name, Spell): the gems and foods used as buffs. Unset: VTank's default
   * profile's two (Asheron's Benediction 3810, Blackmoor's Favor 3811; buffItems.ts VT_GEM_FOOD_ITEMS).
   */
  gemFood?: Array<{ name: string; spell: number }>;
  /** What a `.usd` holds that the tabs above don't, kept so an export writes it back (vtankUsd.ts). */
  usd?: VtUsdKeep;
}

/**
 * An Items-tab entry. VTank keeps its items by object id, so two weapons of one
 * name are two entries (MOSS CombatProfileItems: an id means THAT object, a
 * second object of the same name never stands in for it). `id` is the object
 * id when the entry was added from the pack; an entry without one (an older
 * profile, an import) matches by name, as before.
 */
export interface VtItemEntry {
  name: string;
  id?: number;
  noBuffs?: boolean;
  /** The Hands column (MOSS: Auto / 1-Handed / 2-Handed); unset is Auto, which reads the item (a TwoHanded slot). */
  hands?: 1 | 2;
}

/** Whether a carried item is this Items-tab entry: by object id when the entry has one, else by name. */
export function vtItemIs(entry: VtItemEntry, item: { guid: number; name: string }): boolean {
  if (entry.id !== undefined) return (entry.id >>> 0) === (item.guid >>> 0);
  return entry.name.toLowerCase() === item.name.toLowerCase();
}

/**
 * The parts of a VirindiTank settings file (`.usd`) kept through import and export
 * (docs/vtank-formats.md §6). Object ids are the server's own (one character's items).
 */
export interface VtUsdKeep {
  /** AssistItems (Object name, Type): each Consumables-tab name's VTank kind (0 health kit … 11 all peas). */
  assistTypes?: Record<string, number>;
  /** AssistItems rows whose kind we don't know (outside 0–11), as read. */
  assistOther?: Array<{ name: string; type: number }>;
  /** ItemUseSpecifiers (Object id, Uses), as read: no public meaning. */
  itemUseSpecifiers?: Array<{ object: number; uses: number }>;
  /** BuffedItems (Object id, Spell id), as read: the Items-tab objects in order and each one's buff spells (-1: none named). */
  buffedItems?: Array<{ object: number; spell: number }>;
  /** Object ids the importer named (item name → its id), so an export writes the same ids back. */
  itemIds?: Record<string, number>;
  /** Items-tab object ids no carried item had at import (resolved by name when the macro runs). */
  unnamedItems?: number[];
  /** Extra Buff Spells / Blacklisted Buff Families exemplar spell ids the importer couldn't name (no spell table there). */
  unnamedExtraBuffs?: number[];
  unnamedBlacklistedBuffs?: number[];
  /** Settings rows whose value isn't a plain option (RechargeHandlerSet's table), as read. */
  settingsRaw?: Array<{ name: string; value: UsdValue }>;
  /** Tables we don't read (SettingsCategories, SettingsEnumInfo, a plugin's own), written back unchanged. */
  tables?: UsdTable[];
}

/** One typed value of VTank's settings serialisation (`i` int, `s` string, `d` double, `b` bool, `ba` bytes, a nested table). */
export type UsdValue =
  | { t: 'i'; v: number } | { t: 's'; v: string } | { t: 'd'; v: number } | { t: 'b'; v: boolean } | { t: 'ba'; v: string }
  | { t: 'table'; cols: string[]; index: boolean[]; rows: UsdValue[][] };
/** A named table of a `.usd`: its column names, which column is the index (`y`), and its rows. */
export interface UsdTable { name: string; cols: string[]; index: boolean[]; rows: UsdValue[][] }

export function emptyVtankData(): VtankProfileData {
  return { monsters: [structuredClone(VT_DEFAULT_MONSTER)], items: [], consumables: [], excludedScarabs: [], extraBuffs: [], blacklistedBuffs: [] };
}

// ── what the macro's planners read (filled by the agent host from the client's tables) ──

/** A spell you know, with what the spell table says about it. */
export interface PlanSpell {
  id: number;
  name: string;
  /** 'War Magic' | 'Life Magic' | 'Item Enchantment' | 'Creature Enchantment' | 'Void Magic' (the client's school names). */
  school: string;
  /** The spell table's category: spells of one family share it (ACE SpellCategory). */
  category: number;
  /** Its difficulty (the spell table's power). */
  power: number;
  /** Self-targeted (SpellFlags.SelfTargeted). */
  self: boolean;
  /** Beneficial with a duration (an enchantment that helps). */
  buff: boolean;
  /** Seconds; 0 for instants. */
  duration: number;
  /** The scarab / components it needs, by name, when known. */
  components?: string[];
  /** How far it reaches for you, metres (the spell examine's Range), when known. */
  range?: number;
}

/** A skill of yours (AC skill id), with its training and buffed value. */
export interface PlanSkill {
  id: number;
  name: string;
  training: 'untrained' | 'trained' | 'specialized';
  base: number;
  buffed: number;
}

/** An enchantment on you (or a cast you made), for "time left" tests. */
export interface PlanEnchantment {
  spellId?: number;
  name: string;
  category?: number;
  power?: number;
  remaining: number;
}

/** Something you carry, with what an examination told (when it was examined). */
export interface PlanItem {
  guid: number;
  name: string;
  stack?: number;
  /** ACE ItemType bits. */
  itemType?: number;
  /** Examined int properties (ACE PropertyInt), e.g. BoosterEnum 89, BoostValue 90, Structure 92. */
  ints?: Record<number, number>;
  floats?: Record<number, number>;
  /** Examined data ids (ACE PropertyDataId), e.g. Spell 28: the spell a gem, potion or caster casts when used. */
  dids?: Record<number, number>;
  equipped?: boolean;
  /** UiEffects (PropertyInt 18) from the object's public description (CreateObject weenie header), e.g. a summoning essence's element. */
  uiEffects?: number;
  /** The slots it can be worn or wielded in (its ValidLocations as EquipMask names joined by +, e.g. MissileAmmo). */
  fits?: string;
  /** Equipped: the slot names it is in. */
  slot?: string;
  /** AmmoType from the public description (launchers and ammunition). */
  ammoType?: number;
  /** The spells its examination lists (spell ids, in the server's order: its Spell, a cast-on-strike ProcSpell, then the rest; ACE AppraiseInfo). */
  spells?: number[];
}

export type Stance = 'peace' | 'melee' | 'missile' | 'magic';
