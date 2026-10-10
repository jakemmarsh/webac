/**
 * EnchantmentManager — active enchantment (buff/debuff) tracking.
 *
 * Handles:
 *  - Apply enchantments with duration
 *  - Stacking rules (highest spell of same type wins)
 *  - Duration countdown and expiry
 *  - Periodic effects (regen/DoT ticks)
 *  - Dispel (targeted + AoE)
 *  - Vitae penalty interaction (multiplicative scalar)
 *  - Resistance modifiers (protection vs vulnerability)
 *
 * Vitae: applied AFTER multiplicative buffs, BEFORE additive buffs.
 *   effectiveValue = (base × multiplierBuffs × vitae) + additiveBonuses
 *
 * Resistance: multiplicative stacking. Protection (< 1.0) reduces damage,
 *   Vulnerability (> 1.0) increases damage.
 *
 * Reference: ACE EnchantmentManager.cs, CreatureSkill.cs, CreatureVital.cs
 */

import { SkillId } from '../ace-enums.js';
import { roundHalfAwayFromZero, roundHalfToEven } from '../util/round.js';

export interface ActiveEnchantment {
  spellId: number;
  spellName: string;
  category: EnchantmentCategory;
  buffAttribute: number;   // which attribute/skill/damage type (0 if N/A)
  magnitude: number;       // bonus/penalty amount (additive enchantments)
  multiplier?: number;     // multiplicative modifier (e.g. 1.1 = +10%, 0.9 = -10%)
  duration: number;        // total duration in seconds
  remaining: number;       // remaining time in seconds
  casterId: number;        // who cast this
  spellLevel: number;      // spell level (for stacking comparison)
  periodicRate?: number;   // ticks per second for periodic effects
  periodicAmount?: number; // amount per tick (positive = heal, negative = damage)
}

export enum EnchantmentCategory {
  AttributeBuff = 1,
  AttributeDebuff = 2,
  SkillBuff = 3,
  SkillDebuff = 4,
  VitalRegen = 5,
  VitalDot = 6,
  WeaponBuff = 7,
  ArmorBuff = 8,
  ResistanceBuff = 9,
  ResistanceDebuff = 10,
  VitalBuff = 11,
  VitalDebuff = 12,
}

/**
 * Domain grouping for the generic buffAttribute-keyed stat lookups below.
 *
 * PropertyAttribute (Strength=1..Self=6), PropertyAttribute2nd/vitals
 * (MaxHealth=1, MaxStamina=3, MaxMana=5), SkillId (Axe=1..MeleeDefense=6)
 * and DamageType bit flags all reuse the same low numeric range, so
 * buffAttribute alone is ambiguous. ACE's own EnchantmentManager never
 * queries by StatModKey alone — every accessor (GetAttributeMod,
 * GetVitalMod, GetSkillMod, GetResistanceMod, ...) pairs the key with an
 * EnchantmentTypeFlags context flag (Attribute/SecondAtt/Skill/...) in the
 * same query. This enum is that context flag for our simplified category
 * model. VitalRegen/VitalDot are deliberately excluded — those are
 * periodic ticks consumed via tick(), not magnitude-based stat lookups.
 */
export enum EnchantmentStatDomain {
  Attribute = 'attribute',
  Vital = 'vital',
  Skill = 'skill',
  DamageType = 'damageType',
  Weapon = 'weapon',
  Armor = 'armor',
}

const CATEGORY_DOMAIN: ReadonlyMap<EnchantmentCategory, EnchantmentStatDomain> = new Map([
  [EnchantmentCategory.AttributeBuff, EnchantmentStatDomain.Attribute],
  [EnchantmentCategory.AttributeDebuff, EnchantmentStatDomain.Attribute],
  [EnchantmentCategory.SkillBuff, EnchantmentStatDomain.Skill],
  [EnchantmentCategory.SkillDebuff, EnchantmentStatDomain.Skill],
  [EnchantmentCategory.VitalBuff, EnchantmentStatDomain.Vital],
  [EnchantmentCategory.VitalDebuff, EnchantmentStatDomain.Vital],
  [EnchantmentCategory.ResistanceBuff, EnchantmentStatDomain.DamageType],
  [EnchantmentCategory.ResistanceDebuff, EnchantmentStatDomain.DamageType],
  [EnchantmentCategory.WeaponBuff, EnchantmentStatDomain.Weapon],
  [EnchantmentCategory.ArmorBuff, EnchantmentStatDomain.Armor],
]);

export interface EnchantmentTick {
  enchantment: ActiveEnchantment;
  amount: number;
  expired: boolean;
}

/**
 * ACE's sentinel for an enchantment cast by equipping an item: it stays
 * active until the item is dequipped, never expiring on its own.
 * (ACE EnchantmentManager.BuildEntry: entry.Duration = -1.0 for equip;
 * PropertiesEnchantmentRegistryExtensions.HeartBeat expires only
 * Duration >= 0 entries; AddEnchantmentResult substitutes
 * double.PositiveInfinity for -1 before any duration comparison.)
 * Stored raw as -1 in duration/remaining — never store Infinity.
 */
export const PERMANENT_ENCHANTMENT_DURATION = -1;

// ─── Wire enchantment registry (STATS.enchantments-never-populated) ─────────

/**
 * The StatModType bits the stat lookups key off — ACE
 * ACE.Entity/Enum/EnchantmentTypeFlags.cs ("These flags are used to determine
 * what enchantments stack"). Same values as the retail client's smod.type
 * tests (CEnchantmentRegistry::EnchantAttribute passes 1, EnchantAttribute2nd
 * 2, EnchantSkill 0x10; Enchantment::Enchant tests 0x4000 / 0x8000).
 */
export const StatModType = {
  Attribute:      0x0000001,
  SecondAtt:      0x0000002,
  Int:            0x0000004,
  Float:          0x0000008,
  Skill:          0x0000010,
  SingleStat:     0x0001000,
  MultipleStat:   0x0002000,
  Multiplicative: 0x0004000,
  Additive:       0x0008000,
  AttackSkills:   0x0010000,
  DefenseSkills:  0x0020000,
  Vitae:          0x0800000,
  Cooldown:       0x1000000,
  Beneficial:     0x2000000,
} as const;

/** ACE SpellId.Vitae (ACE.Entity/Enum/SpellId.cs) — the lone vitae slot. */
export const VITAE_SPELL_ID = 666;

/**
 * One wire Enchantment record — ACE Network/Structure/Enchantment.cs Write()
 * (the fields of @ac/network EnchantmentData the stat math needs). Kept
 * structural so the network parser's objects drop straight in.
 */
export interface EnchantmentRegistryEntry {
  spellId: number;
  layer: number;
  spellCategory: number;
  powerLevel: number;
  startTime: number;
  duration: number;
  casterGuid: number;
  statModType: number;
  statModKey: number;
  statModValue: number;
  /** EquipmentSet id when the enchantment came from an item set (0 = none). */
  spellSetId?: number;
}

/**
 * C# `float` arithmetic: every ACE stat computation (CreatureAttribute /
 * CreatureVital / CreatureSkill, the EnchantmentManager Get*Mod products)
 * runs in single precision, so each step rounds to float32. A double-
 * precision port disagrees at .5 boundaries — e.g. 150 × vitae 0.95f is
 * 142.4999982 in double (→ 142) but 142.5f in float (→ Round() 143).
 */
const f32 = Math.fround;

/** ACE SkillHelper.AttackSkills (ACE.Entity/Enum/Skill.cs:263-288). */
const ATTACK_SKILLS: ReadonlySet<number> = new Set([
  SkillId.Axe, SkillId.Bow, SkillId.Crossbow, SkillId.Dagger, SkillId.Mace, SkillId.Sling,
  SkillId.Spear, SkillId.Staff, SkillId.Sword, SkillId.ThrownWeapon, SkillId.UnarmedCombat,
  SkillId.FinesseWeapons, SkillId.HeavyWeapons, SkillId.LightWeapons, SkillId.MissileWeapons,
  SkillId.TwoHandedCombat, SkillId.WarMagic, SkillId.LifeMagic, SkillId.VoidMagic, SkillId.DualWield,
]);

/** ACE SkillHelper.DefenseSkills (ACE.Entity/Enum/Skill.cs:290-296). */
const DEFENSE_SKILLS: ReadonlySet<number> = new Set([
  SkillId.MeleeDefense, SkillId.MissileDefense, SkillId.MagicDefense, SkillId.Shield,
]);

export class EnchantmentManager {
  private enchantments: ActiveEnchantment[] = [];
  private periodicAccumulators: Map<number, number> = new Map(); // spellId → time since last tick

  /**
   * The server's enchantment registry as mirrored from the wire: the login
   * PlayerDescription EnchantmentRegistry (ACE EnchantmentManager.SendRegistry)
   * plus every MagicUpdate/Remove/Purge/Dispel event. Keyed spellId:layer —
   * the LayeredSpellID the remove/dispel messages carry. Vitae lives in its
   * own slot, exactly like the retail client's CEnchantmentRegistry::_vitae
   * (separate from _mult_list/_add_list/_cooldown_list; RemoveEnchantment
   * @ 005944e0 checks it first).
   */
  private registry: Map<string, EnchantmentRegistryEntry> = new Map();
  private vitaeEntry: EnchantmentRegistryEntry | null = null;

  private static isVitaeEntry(e: EnchantmentRegistryEntry): boolean {
    return e.spellId === VITAE_SPELL_ID || (e.statModType & StatModType.Vitae) !== 0;
  }

  /** Add or replace one wire enchantment (MagicUpdateEnchantment / login registry). */
  upsertRegistryEntry(e: EnchantmentRegistryEntry): void {
    if (EnchantmentManager.isVitaeEntry(e)) {
      this.vitaeEntry = { ...e };
      return;
    }
    this.registry.set(`${e.spellId}:${e.layer}`, { ...e });
  }

  /** MagicRemoveEnchantment / MagicDispelEnchantment (spellId + layer). */
  removeRegistryEntry(spellId: number, layer: number): boolean {
    // ACE EnchantmentManager.Remove sends vitae with layer forced to 0
    // (EnchantmentManager.cs:327) — match the slot by spell id alone.
    if (spellId === VITAE_SPELL_ID && this.vitaeEntry) {
      this.vitaeEntry = null;
      return true;
    }
    return this.registry.delete(`${spellId}:${layer}`);
  }

  /** Replace the whole registry (login PlayerDescription). */
  loadRegistry(entries: Iterable<EnchantmentRegistryEntry>): void {
    this.clearRegistry();
    for (const e of entries) this.upsertRegistryEntry(e);
  }

  /** Drop everything (character switch / logout). */
  clearRegistry(): void {
    this.registry.clear();
    this.vitaeEntry = null;
  }

  /**
   * MagicPurgeEnchantments (death). Retail CEnchantmentRegistry::
   * PurgeEnchantments @ 00594de0 purges only the mult/add lists — vitae and
   * the cooldown list survive (ACE RemoveAllEnchantments agrees: "except for
   * vitae and item spells").
   */
  purgeRegistry(): void {
    for (const [key, e] of this.registry) {
      if ((e.statModType & StatModType.Cooldown) === 0) this.registry.delete(key);
    }
  }

  /** MagicPurgeBadEnchantments — harmful entries only (ACE RemoveAllBadEnchantments). */
  purgeBadRegistry(): void {
    for (const [key, e] of this.registry) {
      if ((e.statModType & (StatModType.Beneficial | StatModType.Cooldown)) === 0) this.registry.delete(key);
    }
  }

  /** Every mirrored entry (vitae included). */
  getRegistryEntries(): EnchantmentRegistryEntry[] {
    const out = [...this.registry.values()];
    if (this.vitaeEntry) out.push(this.vitaeEntry);
    return out;
  }

  /**
   * ACE Player.Vitae (Player_Properties.cs:228-239): the vitae enchantment's
   * StatModValue, or 1.0 when none (retail CEnchantmentRegistry::GetVitaeValue
   * @ 00593990 — same).
   */
  getVitae(): number {
    return this.vitaeEntry ? this.vitaeEntry.statModValue : 1.0;
  }

  /**
   * ACE PropertiesEnchantmentRegistryExtensions.GetEnchantmentsTopLayerByStat
   * ModType(statModType, statModKey, handleMultiple) (:197-237): the entries
   * whose StatModType carries every bit of `statModType` and whose key
   * matches — plus, with handleMultiple, the MultipleStat / key-0 non-vitae
   * entries that hit every key of the type — then only the TOP layer of
   * each SpellCategory: highest PowerLevel, ties to the latest StartTime
   * (retail Enchantment::Duel @ 005cace0 is the same power→start_time duel).
   * Set spells tie-break on spell id instead of StartTime (ACE :229); the
   * Level8AuraSelfSpells tie-break (:183) only concerns weapon auras, never
   * an attribute / vital / skill / regen key, so it is not modelled.
   */
  getTopLayer(statModType: number, statModKey: number, handleMultiple = false): EnchantmentRegistryEntry[] {
    let single = statModType;
    let multiple = 0;
    if (handleMultiple) {
      multiple = statModType | StatModType.MultipleStat;
      single = statModType | StatModType.SingleStat;
    }
    const top = new Map<number, EnchantmentRegistryEntry>();
    for (const e of this.registry.values()) {
      const matches =
        ((e.statModType & single) === single && e.statModKey === statModKey)
        || (handleMultiple
          && (e.statModType & multiple) === multiple
          && (e.statModType & StatModType.Vitae) === 0
          && e.statModKey === 0);
      if (!matches) continue;
      const cur = top.get(e.spellCategory);
      if (!cur || EnchantmentManager.outranks(e, cur)) top.set(e.spellCategory, e);
    }
    return [...top.values()];
  }

  private static outranks(a: EnchantmentRegistryEntry, b: EnchantmentRegistryEntry): boolean {
    if (a.powerLevel !== b.powerLevel) return a.powerLevel > b.powerLevel;
    const aSet = (a.spellSetId ?? 0) !== 0;
    const bSet = (b.spellSetId ?? 0) !== 0;
    const ak = aSet ? a.spellId : a.startTime;
    const bk = bSet ? b.spellId : b.startTime;
    return ak > bk;
  }

  /** Product of the top-layer multipliers (float, ACE `multiplier *= StatModValue`). */
  private product(entries: EnchantmentRegistryEntry[]): number {
    let m = 1.0;
    for (const e of entries) m = f32(m * e.statModValue);
    return m;
  }

  /** ACE GetAttributeMod_Additive (EnchantmentManager.cs:680-689): Σ (int)StatModValue. */
  getAttributeModAdditive(attribute: number): number {
    let mod = 0;
    for (const e of this.getTopLayer(StatModType.Attribute | StatModType.Additive, attribute, true)) {
      mod += Math.trunc(e.statModValue);
    }
    return mod;
  }

  /** ACE GetAttributeMod_Multiplier (EnchantmentManager.cs:694-703). */
  getAttributeModMultiplier(attribute: number): number {
    return this.product(this.getTopLayer(StatModType.Attribute | StatModType.Multiplicative, attribute, true));
  }

  /** ACE GetVitalMod_Additives (EnchantmentManager.cs:708-718) — key = PropertyAttribute2nd (MaxHealth 1 / MaxStamina 3 / MaxMana 5). */
  getVitalModAdditive(vital2nd: number): number {
    let mod = 0;
    for (const e of this.getTopLayer(StatModType.SecondAtt | StatModType.Additive, vital2nd, true)) {
      mod = f32(mod + e.statModValue);
    }
    return mod;
  }

  /** ACE GetVitalMod_Multiplier (EnchantmentManager.cs:723-733) — e.g. Asheron's Benediction. */
  getVitalModMultiplier(vital2nd: number): number {
    return this.product(this.getTopLayer(StatModType.SecondAtt | StatModType.Multiplicative, vital2nd, true));
  }

  /**
   * ACE GetSkillMod_Additives (EnchantmentManager.cs:759-775): Σ (int)
   * StatModValue, plus the Dirty Fighting defense/attack debuffs for the
   * SkillHelper.DefenseSkills / AttackSkills sets (ACE.Entity Skill.cs:263-296;
   * GetDefenseDebuffMod / GetAttackDebuffMod :1104-1123, key 0, bare
   * Math.Round = half-to-even).
   */
  getSkillModAdditive(skill: number): number {
    let mod = 0;
    for (const e of this.getTopLayer(StatModType.Skill | StatModType.Additive, skill, true)) {
      mod += Math.trunc(e.statModValue);
    }
    const debuff = (flag: number): number => {
      let sum = 0;
      for (const e of this.getTopLayer(StatModType.Skill | StatModType.Additive | flag, 0)) sum = f32(sum + e.statModValue);
      return roundHalfToEven(sum);
    };
    if (DEFENSE_SKILLS.has(skill)) mod += debuff(StatModType.DefenseSkills);
    if (ATTACK_SKILLS.has(skill)) mod += debuff(StatModType.AttackSkills);
    return mod;
  }

  /** ACE GetSkillMod_Multiplier (EnchantmentManager.cs:779-790) — e.g. shroud spells. */
  getSkillModMultiplier(skill: number): number {
    return this.product(this.getTopLayer(StatModType.Skill | StatModType.Multiplicative, skill, true));
  }

  /**
   * ACE GetRegenerationMod (EnchantmentManager.cs:944-956): regeneration /
   * rejuvenation / mana-renewal spells are Float|SingleStat|Multiplicative
   * enchantments keyed on PropertyFloat HealthRate (3) / StaminaRate (4) /
   * ManaRate (5) (GetVitalRateKey :607-619).
   */
  getRegenerationMod(rateKey: number): number {
    return this.product(this.getTopLayer(StatModType.Float | StatModType.SingleStat | StatModType.Multiplicative, rateKey));
  }

  /** Get all active enchantments. */
  getAll(): ReadonlyArray<ActiveEnchantment> {
    return this.enchantments;
  }

  /** Get active enchantments for a specific attribute/skill/vital/damage-type key within one domain. */
  getForAttribute(attrId: number, domain: EnchantmentStatDomain): ActiveEnchantment[] {
    return this.enchantments.filter(e => e.buffAttribute === attrId && CATEGORY_DOMAIN.get(e.category) === domain);
  }

  /** Get the total bonus for a specific key within one domain from all active enchantments. */
  getTotalBonus(attrId: number, domain: EnchantmentStatDomain): number {
    // Stacking rule: for each category, only the highest level spell applies
    const byCategory = new Map<EnchantmentCategory, ActiveEnchantment>();

    for (const e of this.enchantments) {
      if (e.buffAttribute !== attrId || CATEGORY_DOMAIN.get(e.category) !== domain) continue;
      const existing = byCategory.get(e.category);
      if (!existing || e.spellLevel > existing.spellLevel) {
        byCategory.set(e.category, e);
      }
    }

    let total = 0;
    for (const e of byCategory.values()) {
      total += e.magnitude;
    }
    return total;
  }

  /**
   * Apply a new enchantment.
   * Stacking rules:
   *  - Same category + same buffAttribute: highest spell level wins
   *  - Same level: refresh duration
   *  - Lower level: rejected (returns false)
   */
  apply(enchantment: ActiveEnchantment): boolean {
    // Find existing of same category + attribute
    const existingIdx = this.enchantments.findIndex(
      e => e.category === enchantment.category && e.buffAttribute === enchantment.buffAttribute,
    );

    if (existingIdx >= 0) {
      const existing = this.enchantments[existingIdx];
      if (enchantment.spellLevel > existing.spellLevel) {
        // Higher level overwrites
        this.enchantments[existingIdx] = enchantment;
        return true;
      } else if (enchantment.spellLevel === existing.spellLevel) {
        // Same level: only refresh when the new cast's duration exceeds the
        // time already remaining (ACE EnchantmentManager.cs: timeRemaining =
        // refreshSpell.Duration + refreshSpell.StartTime; if (duration >
        // timeRemaining) refresh) — a shorter recast must not shorten it.
        // The -1 permanent sentinel maps to +Infinity for the comparison
        // (ACE AddEnchantmentResult: entry.Duration == -1 ? PositiveInfinity
        // : entry.Duration), so a finite recast never clobbers a permanent
        // equip enchantment; the stored value stays the raw sentinel.
        const newDuration = enchantment.duration === PERMANENT_ENCHANTMENT_DURATION
          ? Infinity : enchantment.duration;
        const existingRemaining = existing.remaining === PERMANENT_ENCHANTMENT_DURATION
          ? Infinity : existing.remaining;
        if (newDuration > existingRemaining) {
          existing.remaining = enchantment.duration;
        }
        return true;
      } else {
        // Lower level rejected
        return false;
      }
    }

    // No existing — add new
    this.enchantments.push(enchantment);
    return true;
  }

  /**
   * Process time: reduce durations, generate periodic effects.
   * @returns array of periodic ticks and expired enchantments
   */
  tick(dt: number): EnchantmentTick[] {
    const results: EnchantmentTick[] = [];
    const expired: number[] = [];

    for (let i = 0; i < this.enchantments.length; i++) {
      const e = this.enchantments[i];
      // Permanent (equip) enchantments never count down or expire — removed
      // only by dequip. Mirrors ACE's Duration >= 0 guard in
      // PropertiesEnchantmentRegistryExtensions.HeartBeat.
      const permanent = e.duration === PERMANENT_ENCHANTMENT_DURATION
        || e.remaining === PERMANENT_ENCHANTMENT_DURATION;
      if (!permanent) e.remaining -= dt;

      // Periodic effects
      if (e.periodicRate && e.periodicAmount) {
        const acc = (this.periodicAccumulators.get(e.spellId) ?? 0) + dt;
        const tickInterval = 1.0 / e.periodicRate;
        if (acc >= tickInterval) {
          this.periodicAccumulators.set(e.spellId, acc - tickInterval);
          results.push({
            enchantment: e,
            amount: e.periodicAmount,
            expired: false,
          });
        } else {
          this.periodicAccumulators.set(e.spellId, acc);
        }
      }

      // Expired
      if (!permanent && e.remaining <= 0) {
        expired.push(i);
        results.push({
          enchantment: e,
          amount: 0,
          expired: true,
        });
      }
    }

    // Remove expired (reverse order to preserve indices)
    for (let i = expired.length - 1; i >= 0; i--) {
      const idx = expired[i];
      this.periodicAccumulators.delete(this.enchantments[idx].spellId);
      this.enchantments.splice(idx, 1);
    }

    return results;
  }

  /**
   * Dispel enchantments matching criteria.
   * @param maxLevel - remove enchantments up to this spell level
   * @param count - max number to remove (0 = all matching)
   * @returns number of enchantments removed
   */
  dispel(maxLevel = Infinity, count = 0): number {
    let removed = 0;
    const toRemove: number[] = [];

    for (let i = 0; i < this.enchantments.length; i++) {
      if (this.enchantments[i].spellLevel <= maxLevel) {
        toRemove.push(i);
        removed++;
        if (count > 0 && removed >= count) break;
      }
    }

    for (let i = toRemove.length - 1; i >= 0; i--) {
      const idx = toRemove[i];
      this.periodicAccumulators.delete(this.enchantments[idx].spellId);
      this.enchantments.splice(idx, 1);
    }

    return removed;
  }

  /**
   * Remove a specific enchantment by spell ID.
   */
  removeBySpellId(spellId: number): boolean {
    const idx = this.enchantments.findIndex(e => e.spellId === spellId);
    if (idx < 0) return false;
    this.periodicAccumulators.delete(spellId);
    this.enchantments.splice(idx, 1);
    return true;
  }

  /** Get count of active enchantments. */
  get count(): number {
    return this.enchantments.length;
  }

  /** Check if a specific spell is active. */
  hasSpell(spellId: number): boolean {
    return this.enchantments.some(e => e.spellId === spellId);
  }

  /** Clear all enchantments. */
  clear(): void {
    this.enchantments.length = 0;
    this.periodicAccumulators.clear();
  }

  /**
   * Remove all negative (debuff) enchantments.
   * Used on respawn — ACE removes negative enchantments after death.
   * @returns number removed
   */
  removeNegativeEnchantments(): number {
    const debuffCategories = new Set([
      EnchantmentCategory.AttributeDebuff,
      EnchantmentCategory.SkillDebuff,
      EnchantmentCategory.VitalDot,
      EnchantmentCategory.ResistanceDebuff,
      EnchantmentCategory.VitalDebuff,
    ]);
    const before = this.enchantments.length;
    this.enchantments = this.enchantments.filter(e => {
      if (debuffCategories.has(e.category)) {
        this.periodicAccumulators.delete(e.spellId);
        return false;
      }
      return true;
    });
    return before - this.enchantments.length;
  }

  // ─── Resistance Modifiers ─────────────────────────────────

  /**
   * Get total resistance modifier for a damage type.
   * Multiplicative stacking: all active resistance enchantments multiply together.
   *
   * @param damageType The damage type to check (maps to buffAttribute)
   * @returns Combined multiplier (< 1.0 = protected, > 1.0 = vulnerable, 1.0 = neutral)
   *
   * ACE EnchantmentManager.cs GetResistanceMod(), lines 886-898
   */
  getResistanceMod(damageType: number): number {
    let modifier = 1.0;
    for (const e of this.enchantments) {
      if (e.buffAttribute !== damageType) continue;
      if (e.category !== EnchantmentCategory.ResistanceBuff &&
          e.category !== EnchantmentCategory.ResistanceDebuff) continue;
      modifier *= (e.multiplier ?? 1.0);
    }
    return modifier;
  }

  /**
   * Get only the protection (damage reduction) component of resistance.
   * Only includes enchantments with multiplier < 1.0.
   *
   * ACE EnchantmentManager.cs GetProtectionResistanceMod(), lines 903-918
   */
  getProtectionResistanceMod(damageType: number): number {
    let modifier = 1.0;
    for (const e of this.enchantments) {
      if (e.buffAttribute !== damageType) continue;
      if (e.category !== EnchantmentCategory.ResistanceBuff) continue;
      const mult = e.multiplier ?? 1.0;
      if (mult < 1.0) modifier *= mult;
    }
    return modifier;
  }

  /**
   * Get only the vulnerability (damage increase) component of resistance.
   * Only includes enchantments with multiplier > 1.0.
   *
   * ACE EnchantmentManager.cs GetVulnerabilityResistanceMod(), lines 923-938
   */
  getVulnerabilityResistanceMod(damageType: number): number {
    let modifier = 1.0;
    for (const e of this.enchantments) {
      if (e.buffAttribute !== damageType) continue;
      if (e.category !== EnchantmentCategory.ResistanceDebuff) continue;
      const mult = e.multiplier ?? 1.0;
      if (mult > 1.0) modifier *= mult;
    }
    return modifier;
  }

  // ─── Vitae-Aware Stat Computation ─────────────────────────

  /**
   * Compute the effective stat value with vitae interaction.
   *
   * ACE formula (CreatureSkill.cs, CreatureVital.cs):
   *   1. Start with base value
   *   2. Multiply by multiplicative enchantments
   *   3. Multiply by vitae penalty
   *   4. Add additive enchantments (NOT affected by vitae)
   *
   * @param baseValue Base stat/skill/vital value
   * @param attrId Attribute/skill ID to look up enchantments for
   * @param domain Which key-space attrId belongs to (Attribute/Vital/Skill/...)
   * @param vitae Vitae penalty (1.0 = no penalty, 0.95 = 5% penalty, 0.60 = 40% penalty)
   * @returns Effective stat value after enchantments and vitae
   */
  computeEffectiveStat(baseValue: number, attrId: number, domain: EnchantmentStatDomain, vitae = 1.0): number {
    // Step 1: Get multiplicative modifiers for this attribute — TOP layer of
    // each category only. ACE never sums every entry for a key: its
    // Get*Mod lookups go through GetEnchantments_TopLayer, which groups by
    // SpellCategory and keeps the highest PowerLevel (then latest StartTime)
    // per group (PropertiesEnchantmentRegistryExtensions.cs:197-237). In this
    // simplified model the category (buff vs debuff of one key) plays the
    // SpellCategory role and spellLevel the PowerLevel role — the same rule
    // getTotalBonus applies. apply() already keeps one entry per
    // category+key, but entries pushed any other way must not stack.
    const top = new Map<EnchantmentCategory, ActiveEnchantment>();
    for (const e of this.enchantments) {
      if (e.buffAttribute !== attrId || CATEGORY_DOMAIN.get(e.category) !== domain) continue;
      const cur = top.get(e.category);
      if (!cur || e.spellLevel > cur.spellLevel) top.set(e.category, e);
    }
    let multiplier = 1.0;
    let additive = 0;
    for (const e of top.values()) {
      if (e.multiplier !== undefined && e.multiplier !== 1.0) {
        multiplier *= e.multiplier;
      } else {
        // Additive (magnitude-based) enchantments
        additive += e.magnitude;
      }
    }

    // Step 2: Apply multiplier and vitae to base
    let effective = baseValue * multiplier * vitae;

    // Step 3: Add additive bonuses (NOT affected by vitae)
    effective += additive;

    // ACE `.Round()` = MidpointRounding.AwayFromZero (FloatExtensions.cs:9).
    return Math.max(0, roundHalfAwayFromZero(effective));
  }

  /**
   * Get the additive bonus only (sum of magnitude-based enchantments).
   * Does not include multiplicative enchantments.
   */
  getAdditiveBonus(attrId: number, domain: EnchantmentStatDomain): number {
    let total = 0;
    for (const e of this.enchantments) {
      if (e.buffAttribute !== attrId || CATEGORY_DOMAIN.get(e.category) !== domain) continue;
      if (e.multiplier !== undefined && e.multiplier !== 1.0) continue;
      total += e.magnitude;
    }
    return total;
  }

  /**
   * Get the multiplicative modifier only (product of multiplier-based enchantments).
   * Does not include additive enchantments.
   */
  getMultiplierMod(attrId: number, domain: EnchantmentStatDomain): number {
    let mod = 1.0;
    for (const e of this.enchantments) {
      if (e.buffAttribute !== attrId || CATEGORY_DOMAIN.get(e.category) !== domain) continue;
      if (e.multiplier !== undefined && e.multiplier !== 1.0) {
        mod *= e.multiplier;
      }
    }
    return mod;
  }
}
