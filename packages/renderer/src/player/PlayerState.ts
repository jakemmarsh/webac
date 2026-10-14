/**
 * PlayerState — manages the player's game state, bridging shared game logic
 * systems to the renderer. This is the central player data model.
 */
import {
  AttributeSystem, AttributeId,
  VitalSystem, VitalId, REGEN_INTERVAL,
  SkillSystem, SkillAdvancementClass,
  XpSystem,
  InventoryManager,
  EquipmentSystem,
  EnchantmentManager,
  VitaeSystem,
  PropertyInt,
  PropertyBool,
  playerStatModsFromIntProps, getAttributeCurrent, getSkillCurrent, getSkillBaseValue,
  getPlayerEncumbranceCapacity,
} from '@ac/shared';
import type { InventoryItem, Skill, PlayerStatMods } from '@ac/shared';
import type { SkillBase } from '@ac/dat-parser';

export interface CharacterInfo {
  name: string;
  heritage: number;
  gender: number;
  level: number;
  totalXp: bigint;
  availableXp: bigint;
  skillCredits: number;
  attributes: {
    strength: number;
    endurance: number;
    coordination: number;
    quickness: number;
    focus: number;
    self: number;
  };
  skills: Map<number, SkillAdvancementClass>;
}

export class PlayerState {
  // Character identity
  name = '';
  heritage = 0;
  gender = 0;

  /**
   * Server-tracked totals — updated from PrivateUpdatePropertyInt events.
   * Pre-FAITHFUL.225 these were not tracked client-side, so commerce + death
   * events left the UI showing stale values.
   */
  /** Total pyreals (sum of all coin stacks). Maintained by ACE
   * Player_Commerce.cs; sent on every coin change via
   * PropertyInt.CoinValue (20). */
  coinValue = 0;
  /** Cumulative death counter. PropertyInt.NumDeaths (43). */
  numDeaths = 0;
  /** Current vitae penalty pool — server-tracked CP forfeited on death,
   * paid back via XP gain. PropertyInt.VitaeCpPool (129). */
  vitaeCpPool = 0;
  /** Mirror of PropertyInt.EncumbranceCapacity (96) when the server sends it.
   * NOT authoritative and NOT used for burden: ACE only emits it as a one-off
   * snapshot when an Increased Carrying Capacity augmentation is bought
   * (AugmentationDevice.cs:122-123; not [SendOnLogin]), and the retail client
   * never reads it — CACQualities::InqLoad @ 0058f130 recomputes capacity from
   * the enchanted Strength + PropertyInt 230 every time. See
   * {@link encumbranceCapacity} (STATS.burden-capacity-augs-buffs). */
  serverEncumbranceCapacity = 0;
  /**
   * Max number of side-pack containers the player can equip. ACE
   * AugmentationDevice.cs emits PropertyInt.ContainersCapacity (7) when
   * the player uses a Pack Slot augmentation to expand from the default 7.
   */
  containersCapacity = 7;
  /**
   * Max number of items the player's main inventory can hold (NOT side
   * packs). PropertyInt.ItemsCapacity (6).
   */
  itemsCapacity = 102;
  /**
   * Cumulative character age in seconds, ticks up server-side roughly
   * every 7 seconds while in-world. PropertyInt.Age (125). Equivalent to
   * the `@age` query response, but provided eagerly so the character
   * panel + tooltip can show "Time played" without round-tripping the
   * server.
   */
  ageSeconds = 0;
  /**
   * Bitfield identifying which Society faction the player belongs to.
   * PropertyInt.Faction1Bits (281). 0 = unaffiliated. Per ACE
   * Entity/Enlightenment.cs this is cleared on enlightenment-reset.
   */
  faction1Bits = 0;
  /**
   * Player's rank within each of the 3 Societies (Throne of Destiny
   * expansion). PropertyInt.SocietyRank{Celhan,Eldweb,Radblo} (287/288/289).
   * 0 = no rank in that society; values 1-7 map to the named ranks
   * (Initiate / Adept / Knight / Lord / Master / Grand Master / Tyrant).
   */
  societyRankCelhan = 0;
  societyRankEldweb = 0;
  societyRankRadblo = 0;
  /**
   * FAITHFUL.234 — additional server-tracked totals.
   *
   *   allegianceRank (30)         — rank within current allegiance.
   *   advocateLevel (112)         — admin advocate level (0=none).
   *   deathLevel (139)            — level the player died at (vitae context).
   *   chessRank/Total/Won/Lost (181-184) — chess statistics.
   *   housePurchaseTimestamp (199) — owned-house purchase epoch.
   *   aetheriaBitfield (322)      — Aetheria gem affinity flags.
   *   gearMaxHealth (379)         — bonus max-health from gear/aug.
   *   enlightenment (390)         — enlightenment level (0+).
   */
  allegianceRank = 0;
  advocateLevel = 0;
  deathLevel = 0;
  chessRank = 0;
  chessTotalGames = 0;
  chessGamesWon = 0;
  chessGamesLost = 0;
  housePurchaseTimestamp = 0;
  aetheriaBitfield = 0;
  gearMaxHealth = 0;
  enlightenment = 0;
  /**
   * FAITHFUL.235 — Luminance Augmentation rating fields (333-345, 365).
   *
   * Endgame stat-bonus system from the Throne of Destiny expansion.
   * Players spend Luminance to permanently increase one of these
   * ratings; each rating affects a specific combat/utility formula
   * server-side (damage dealt, damage reduction, crit chance/dmg,
   * surge effect/chance, item mana use/gain, max vitality, healing
   * rating, craft skill bonuses).
   *
   * Stored here so future Aug UI can read them without round-tripping
   * the server; also surfaced on damage-tooltip calculations once that
   * UI lands.
   *
   * Reference: ACE.Entity.Enum.Properties.PropertyInt entries with the
   * `LumAug*` prefix.
   */
  lumAugDamageRating = 0;
  lumAugDamageReductionRating = 0;
  lumAugCritDamageRating = 0;
  lumAugCritReductionRating = 0;
  lumAugSurgeEffectRating = 0;
  lumAugSurgeChanceRating = 0;
  lumAugItemManaUsage = 0;
  lumAugItemManaGain = 0;
  lumAugVitality = 0;
  lumAugHealingRating = 0;
  lumAugSkilledCraft = 0;
  lumAugSkilledSpec = 0;
  lumAugNoDestroyCraft = 0;
  lumAugAllSkills = 0;
  /**
   * FAITHFUL.236 — Luminance + ItemTotalXp Int64 totals.
   *
   * PropertyInt64.AvailableLuminance (6) — current spendable Lum.
   * PropertyInt64.MaximumLuminance   (7) — Lum cap (rises with augs).
   * PropertyInt64.ItemTotalXp        (4) — bonded-item XP pool.
   *
   * All three displayed on the character panel in retail; server emits
   * on every change via PrivateUpdatePropertyInt64.
   */
  availableLuminance = 0n;
  maximumLuminance = 0n;
  itemTotalXp = 0n;
  /**
   * FAITHFUL.237 — server-tracked boolean flags.
   *
   *   isAdvocate (47)                — admin advocate flag (helper status)
   *   spellComponentsRequired (68)   — gates inscribed-spell components
   *                                    (toggle via Spell-Comps character option)
   *   isPsr (97)                     — Player Senior Resolution flag
   *   ignoreHouseBarriers (25)       — house-perm bypass (admin / owner)
   *
   * Afk (110) is already wired in main.ts onPrivateUpdatePropertyBool.
   */
  isAdvocate = false;
  /**
   * SWEEP1006B.magic-casting.missing-components-pre-check-default — retail
   * ClientMagicSystem::AreSpellComponentsRequired @ 00567b90 reads PlayerDesc
   * bool 0x44 with CBaseQualities::InqBool @ 0058fe70, which leaves its
   * `false` default when the key is absent. ACE never stores `true`
   * (Player_Properties.cs:286-290), so absent = false: the cast goes out and
   * ACE answers WeenieError 0x0400 when components are missing.
   */
  spellComponentsRequired = false;
  isPsr = false;
  ignoreHouseBarriers = false;

  /**
   * Apply a server-sent PropertyBool for the local player (Private update,
   * or a Public update addressed to our own guid — ACE's `@requirecomps`
   * sends SpellComponentsRequired as GameMessagePublicUpdatePropertyBool,
   * DeveloperCommands.cs:2543/2549). Returns true when the key is one of the
   * mirrored flags.
   */
  seedSpellComponentsRequired(fromPlayerDescription: boolean | undefined): void {
    // Retail replaces PlayerDesc on every login: a bool missing from THIS
    // PlayerDescription reads false again, whatever an earlier login set.
    this.spellComponentsRequired = fromPlayerDescription ?? false;
  }

  applyServerBool(key: number, value: boolean): boolean {
    switch (key) {
      case PropertyBool.IsAdvocate: this.isAdvocate = value; return true;
      case PropertyBool.SpellComponentsRequired: this.spellComponentsRequired = value; return true;
      case PropertyBool.IsPsr: this.isPsr = value; return true;
      case PropertyBool.IgnoreHouseBarriers: this.ignoreHouseBarriers = value; return true;
      default: return false;
    }
  }

  /**
   * FAITHFUL.381 — Server-tracked PropertyDataId values for the local
   * player. ACE Player_Properties.cs sends PrivateUpdatePropertyDataID
   * (self-side path) when the player's own Setup / MotionTable /
   * SoundTable / Icon changes. Pre-fix the handler in main.ts was
   * diagnostic-only; downstream code that needs the current DIDs
   * (model rebuild, hit-sound lookup, idle motion playback) read the
   * stale CreateObject-time values. Defaults to 0 = unset; consumers
   * fall back to character-generation values when missing.
   *
   * Anchored at:
   *   reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyDataId.cs:6-8 →
   *     Setup = 1, MotionTable = 2, SoundTable = 3
   *   reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyDataId.cs:14 →
   *     Icon = 8
   *   reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyDataId.cs:16 →
   *     CombatTable = 4 ([SendOnLogin]; heritage-specific, e.g. Olthoi
   *     uses 0x30000001 instead of the humanoid default 0x30000000)
   */
  setupId = 0;
  motionTableId = 0;
  soundTableId = 0;
  iconId = 0;
  combatTableId = 0;

  /**
   * BUG.patron-allegiance-instance-id-dropped — server-tracked
   * PropertyInstanceId values for the local player. Allegiance(24) and
   * Patron(25) are [SendOnLogin] (PropertyInstanceId.cs:43-46); Monarch(26)
   * is not SendOnLogin but is re-broadcast live via
   * GameMessagePublicUpdateInstanceID whenever swear/break-allegiance
   * changes it (Player_Allegiance.cs / Player_Properties.cs broadcast=true).
   * 0 = none/unset. Allegiance(24) is dead in current ACE (never actually
   * set), so it will stay 0 in practice; kept for parity with the wire enum.
   */
  patronGuid = 0;
  monarchGuid = 0;
  allegianceGuid = 0;

  /**
   * Generic mirror of the player's server PropertyInt values — seeded from
   * the full PlayerDescription int map at login and updated on every
   * PrivateUpdatePropertyInt delta. Lets read-mostly consumers (e.g. the
   * Character Information panel report, which keys off ~70 distinct prop ids:
   * masteries, gem augmentations, luminance auras, birth/age/deaths) look up
   * any int property without bespoke per-field wiring. Named fields above
   * remain the source for values with side effects (HUD, movement, combat).
   */
  serverIntProps: Map<number, number> = new Map();

  /**
   * One PrivateUpdatePropertyInt into the int mirror. A removed quality
   * (GDLE's 0x01D1 PrivateRemoveIntEvent; GAP.gdle-qualities-remove-events)
   * leaves the mirror, as retail's CBaseQualities::RemoveInt drops the key
   * (InqInt then fails) — not a stored 0.
   */
  applyServerIntProp(key: number, value: number, removed = false): void {
    if (removed) this.serverIntProps.delete(key);
    else this.serverIntProps.set(key, value);
  }

  // Core systems — mutable so initFromCreation can replace them
  attributes: AttributeSystem;
  vitals: VitalSystem;
  skills: SkillSystem;
  xp: XpSystem;
  readonly inventory: InventoryManager;
  readonly equipment: EquipmentSystem;
  readonly enchantments: EnchantmentManager;
  readonly vitae: VitaeSystem;

  // Quest state
  readonly questFlags = new Map<string, { completions: number; lastComplete: number }>();

  constructor() {
    // Default attribute values (10 each, minimum viable character)
    this.attributes = new AttributeSystem({
      strength: 10, endurance: 10, coordination: 10,
      quickness: 10, focus: 10, self: 10,
    });
    this.vitals = new VitalSystem();
    this.skills = new SkillSystem(new Map());
    this.xp = new XpSystem(0);
    this.inventory = new InventoryManager();
    this.equipment = new EquipmentSystem();
    this.enchantments = new EnchantmentManager();
    this.vitae = new VitaeSystem();
    // STATS.enchantments-never-populated — the vitals' max is ACE's
    // CreatureVital.MaxValue: it needs this player's enchantment registry
    // (buffs, vitae) and PropertyInt mods (Enlightenment, GearMaxHealth).
    this.vitals.setStatContext(() => ({ enchantments: this.enchantments, mods: this.statMods }));
  }

  /** The [SendOnLogin] PropertyInt inputs of the stat formulas (augs, Enlightenment, GearMaxHealth). */
  get statMods(): PlayerStatMods {
    return playerStatModsFromIntProps((key) => this.serverIntProps.get(key));
  }

  /** ACE CreatureAttribute.Current — the BUFFED attribute (CreatureAttribute.cs:139-155). */
  getAttributeCurrent(id: AttributeId): number {
    return getAttributeCurrent(this.attributes, id, this.enchantments);
  }

  /** ACE CreatureSkill.Current — enchantments, vitae, augmentations (CreatureSkill.cs:154-195). */
  getSkillCurrent(id: number, skillTable: Map<number, SkillBase>): number {
    return getSkillCurrent(this.skills, id, skillTable, this.attributes, this.enchantments, this.statMods);
  }

  /** ACE CreatureSkill.Base — unbuffed, with GetAugBonus_Base (CreatureSkill.cs:136-151). */
  getSkillBase(id: number, skillTable: Map<number, SkillBase>): number {
    return getSkillBaseValue(this.skills, id, skillTable, this.attributes, this.statMods);
  }

  /**
   * Carry capacity — ACE Player.GetEncumbranceCapacity (Player_Inventory.cs:
   * 46-51): buffed Strength × (150 + 30/aug, capped) with
   * PropertyInt.AugmentationIncreasedCarryingCapacity (230).
   */
  get encumbranceCapacity(): number {
    return getPlayerEncumbranceCapacity(
      this.attributes,
      this.enchantments,
      this.serverIntProps.get(PropertyInt.AugmentationIncreasedCarryingCapacity) ?? 0,
    );
  }

  /**
   * Initialize from character creation data.
   */
  initFromCreation(info: CharacterInfo): void {
    this.name = info.name;
    this.heritage = info.heritage;
    this.gender = info.gender;

    // Create fresh attribute system with creation values
    this.attributes = new AttributeSystem(info.attributes);

    // Create fresh skill system with advancement classes
    this.skills = new SkillSystem(info.skills);

    // Initialize vitals to max (requires attributes for max calculation)
    this.vitals.initToMax(this.attributes);

    // Set level and XP
    this.xp.setLevel(info.level);
    this.xp.setXp(info.totalXp, info.availableXp);

    // Set skill credits
    this.xp.setSkillCredits(info.skillCredits, info.skillCredits);
  }

  /**
   * Get current health as fraction (0-1).
   */
  get healthFraction(): number {
    const max = this.vitals.getMax(VitalId.Health, this.attributes);
    const cur = this.vitals.getCurrent(VitalId.Health);
    return max > 0 ? cur / max : 0;
  }

  /**
   * Get current stamina as fraction (0-1).
   */
  get staminaFraction(): number {
    const max = this.vitals.getMax(VitalId.Stamina, this.attributes);
    const cur = this.vitals.getCurrent(VitalId.Stamina);
    return max > 0 ? cur / max : 0;
  }

  /**
   * Get current mana as fraction (0-1).
   */
  get manaFraction(): number {
    const max = this.vitals.getMax(VitalId.Mana, this.attributes);
    const cur = this.vitals.getCurrent(VitalId.Mana);
    return max > 0 ? cur / max : 0;
  }

  /**
   * Get health values.
   */
  get health(): { current: number; max: number } {
    return {
      current: this.vitals.getCurrent(VitalId.Health),
      max: this.vitals.getMax(VitalId.Health, this.attributes),
    };
  }

  /**
   * Get stamina values.
   */
  get stamina(): { current: number; max: number } {
    return {
      current: this.vitals.getCurrent(VitalId.Stamina),
      max: this.vitals.getMax(VitalId.Stamina, this.attributes),
    };
  }

  /**
   * Get mana values.
   */
  get mana(): { current: number; max: number } {
    return {
      current: this.vitals.getCurrent(VitalId.Mana),
      max: this.vitals.getMax(VitalId.Mana, this.attributes),
    };
  }

  /**
   * Current level.
   */
  get level(): number {
    return this.xp.level;
  }

  set level(value: number) {
    this.xp.setLevel(value);
  }

  get totalXp(): bigint {
    return this.xp.totalXp;
  }

  set totalXp(value: bigint) {
    this.xp.setXp(value, this.xp.availableXp);
  }

  get availableXp(): bigint {
    return this.xp.availableXp;
  }

  set availableXp(value: bigint) {
    this.xp.setXp(this.xp.totalXp, value);
  }

  /**
   * Is the player dead?
   */
  get isDead(): boolean {
    return this.vitals.isDead();
  }

  /**
   * Get total burden (encumbrance) of inventory + equipment.
   */
  get totalBurden(): number {
    return this.inventory.totalBurden;
  }

  /**
   * Serialize state for save/load.
   */
  serialize(): object {
    return {
      name: this.name,
      heritage: this.heritage,
      gender: this.gender,
      level: this.xp.level,
      totalXp: this.xp.totalXp.toString(),
      availableXp: this.xp.availableXp.toString(),
      skillCredits: this.xp.totalSkillCredits,
      vitae: this.vitae.vitaePenalty,
      health: this.vitals.getCurrent(VitalId.Health),
      stamina: this.vitals.getCurrent(VitalId.Stamina),
      mana: this.vitals.getCurrent(VitalId.Mana),
      quests: Object.fromEntries(this.questFlags),
    };
  }
}
