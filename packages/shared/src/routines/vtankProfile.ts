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
  /** VT_DAMAGE value or VT_PET_AUTO. */
  petDamage: number;
}

export const VT_DEFAULT_MONSTER: VtMonsterRow = { name: '<DEFAULT>', priority: 1, on: ['A', 'S'], damage: VT_DAMAGE.Auto, exVuln: VT_DAMAGE.None, weapon: null, offhand: null, petDamage: VT_PET_AUTO };

export interface VtankProfileData {
  /** The Monsters tab, `<DEFAULT>` first. */
  monsters: VtMonsterRow[];
  /** Weapons / wands / shields / pets; `noBuffs`: Add (no buffs). */
  items: Array<{ name: string; noBuffs?: boolean }>;
  /** Gems / food / kits / potions / charges / grenades / lockpicks (and peas to split), by name. */
  consumables: string[];
  /** Spell components whose spells are not cast. */
  excludedScarabs: string[];
  /** Extra Buff Spells: one spell of each family to keep up (the best similar is used). */
  extraBuffs: string[];
  /** Blacklisted Buff Families: one spell of each family never cast. */
  blacklistedBuffs: string[];
}

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
  /** Examined int properties (ACE PropertyInt), e.g. BoostValue 90, BoosterEnum 95, Structure 92. */
  ints?: Record<number, number>;
  floats?: Record<number, number>;
  equipped?: boolean;
}

export type Stance = 'peace' | 'melee' | 'missile' | 'magic';
