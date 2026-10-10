/**
 * VitalSystem — Health, Stamina, Mana with exact ACE regeneration.
 *
 * Health = Endurance / 2 (base from formula)
 * Stamina = Endurance (base from formula)
 * Mana = Self (base from formula)
 *
 * Regen formula per tick:
 *   perTick = baseRate × attributeMod × stanceMod × enchantmentMod × augMod
 *   Fractional amounts carry over between ticks.
 *
 * Reference: ACE Creature_Vitals.cs, Player_Vitals.cs
 */

import { AttributeId, type AttributeSystem } from './AttributeSystem.js';
import { roundHalfAwayFromZero } from '../util/round.js';
import type { SkillFormula } from '@ac/dat-parser';
import { computeSkillFormula } from './SkillSystem.js';
import { getAttributeCurrent, type PlayerStatMods } from './CreatureStats.js';
import type { EnchantmentManager } from '../magic/EnchantmentManager.js';

export enum VitalId {
  Health = 1,
  Stamina = 2,
  Mana = 3,
}

export interface Vital {
  id: VitalId;
  current: number;
  raises: number;       // bonus max from XP spending
  /** ACE CreatureVital.StartingValue (InitLevel) — added to max (CreatureVital.cs:49-53, :131). */
  startingValue: number;
  partialRegen: number; // fractional regen accumulator
}

/**
 * ACE PropertyAttribute2nd key of each vital's MAX — the StatModKey the
 * SecondAtt enchantments carry (MaxHealth 1 / MaxStamina 3 / MaxMana 5).
 */
export const VITAL_MAX_KEY: Readonly<Record<VitalId, number>> = {
  [VitalId.Health]: 1,
  [VitalId.Stamina]: 3,
  [VitalId.Mana]: 5,
};

/**
 * PropertyFloat HealthRate (3) / StaminaRate (4) / ManaRate (5) — the vital's
 * RegenRate property (ACE CreatureVital.cs:35-46) and the StatModKey of the
 * regeneration enchantments (EnchantmentManager.GetVitalRateKey :607-619).
 */
export const VITAL_RATE_KEY: Readonly<Record<VitalId, number>> = {
  [VitalId.Health]: 3,
  [VitalId.Stamina]: 4,
  [VitalId.Mana]: 5,
};

/** The DAT SecondaryAttributeTable (0x0E000003) formulas. */
export interface VitalFormulaTable {
  maxHealth: SkillFormula;
  maxStamina: SkillFormula;
  maxMana: SkillFormula;
}

/**
 * What the enchanted max needs beyond ranks + attributes: the local player's
 * enchantment registry (multipliers / additives / vitae) and its PropertyInt
 * mods (Enlightenment, GearMaxHealth). mods present => the vitals are a
 * PLAYER's (ACE's `creature as Player` branches).
 */
export interface VitalStatContext {
  enchantments?: EnchantmentManager | null;
  mods?: PlayerStatMods | null;
}

/** Regen stance for vital regeneration */
export enum RegenStance {
  Combat = 'combat',
  Running = 'running',
  Standing = 'standing',
  Crouching = 'crouching',
  Sitting = 'sitting',
  Sleeping = 'sleeping',
}

/**
 * Player vital RegenRate per 5-second tick when the server hasn't sent one.
 *
 * ACE sources CreatureVital.RegenRate from PropertyFloat HealthRate /
 * StaminaRate / ManaRate (CreatureVital.cs:35-46, `?? 0`). Those floats are
 * NOT [SendOnLogin] (PropertyFloat.cs:14-17), so the client never receives
 * them at login; every player biota inherits them from its creation weenie —
 * "human" (ACE-World 00001 Clay.sql:31-33), "admin" (00004), "sentinel"
 * (03648), "olthoiplayer"/"olthoiacidplayer" (43480/43481) all carry
 * HealthRate 0.3, StaminaRate 3, ManaRate 1 (CharacterHandler.cs:78-110 picks
 * one of them). Pre-fix this table was an invented 1 / 2 / 1.
 */
export const PLAYER_WEENIE_REGEN_RATES: Readonly<Record<VitalId, number>> = {
  [VitalId.Health]: 0.3,
  [VitalId.Stamina]: 3,
  [VitalId.Mana]: 1,
};

/** Regen interval in seconds */
export const REGEN_INTERVAL = 5.0;

// ─── Regen Modifiers (exact ACE formulas) ───────────────────

/**
 * Get health regen attribute modifier.
 * Only applies to Health, only for players.
 *
 * Formula: 1.0 + (Str + 2*End - 200) / 600, clamped [1.0, 2.1]
 *
 * Reference: ACE Creature_Vitals.cs GetNaturalRegenModifier()
 */
export function getHealthRegenAttributeMod(strengthBase: number, enduranceBase: number): number {
  const strAndEnd = strengthBase + enduranceBase * 2;
  if (strAndEnd <= 200) return 1.0;
  const modifier = 1.0 + (strAndEnd - 200) / 600;
  return Math.max(1.0, Math.min(2.1, modifier));
}

/**
 * Get regen stance modifier.
 * Applies to Health and Stamina only (NOT Mana).
 *
 * Combat/running: 0.5x | Standing: 1.0x | Crouching: 2.0x
 * Sitting: 2.5x | Sleeping: 3.0x
 *
 * Reference: ACE Player_Vitals.cs GetRegenStanceMod()
 */
export function getRegenStanceMod(stance: RegenStance): number {
  switch (stance) {
    case RegenStance.Combat:
    case RegenStance.Running:
      return 0.5;
    case RegenStance.Standing:
      return 1.0;
    case RegenStance.Crouching:
      return 2.0;
    case RegenStance.Sitting:
      return 2.5;
    case RegenStance.Sleeping:
      return 3.0;
  }
}

/**
 * Get augmentation regen modifier (Innate Renewal / AugmentationFasterRegen).
 * Each level adds +1.0x (max 2, per AugmentationDevice.cs MaxAugs[RegenBonus]).
 *
 * 0 augs = 1.0x, 1 aug = 2.0x, 2 augs = 3.0x
 *
 * Applies in EVERY stance. STATS.regen-prediction-diverges — the earlier
 * docblock quoted a `&& ForwardCommand == MotionCommand.Sleeping` gate that
 * is not in ACE; Creature_Vitals.cs:129-131 reads:
 *   `var augMod = 1.0f;
 *    if (this is Player player && player.AugmentationFasterRegen > 0)
 *        augMod += player.AugmentationFasterRegen;`
 */
export function getAugmentationRegenMod(augmentationLevel: number): number {
  return 1.0 + Math.min(augmentationLevel, 2);
}

// ─── VitalSystem Class ──────────────────────────────────────

export class VitalSystem {
  private vitals: Map<VitalId, Vital> = new Map();
  private regenAccumulator = 0;

  private formulaTable: VitalFormulaTable | null = null;
  private statContext: (() => VitalStatContext) | null = null;

  constructor() {
    this.vitals.set(VitalId.Health, { id: VitalId.Health, current: 0, raises: 0, startingValue: 0, partialRegen: 0 });
    this.vitals.set(VitalId.Stamina, { id: VitalId.Stamina, current: 0, raises: 0, startingValue: 0, partialRegen: 0 });
    this.vitals.set(VitalId.Mana, { id: VitalId.Mana, current: 0, raises: 0, startingValue: 0, partialRegen: 0 });
  }

  /**
   * Drive the attribute formulas from the DAT SecondaryAttributeTable
   * (0x0E000003) — ACE AttributeFormula.GetFormula(creature, vital)
   * (AttributeFormula.cs:34-49) reads exactly these. Without a table the
   * built-in fallback is the EoL table's own content (MaxHealth End/2,
   * MaxStamina End, MaxMana Self — asserted against the DAT in tests).
   */
  setFormulaTable(table: VitalFormulaTable | null): void {
    this.formulaTable = table;
  }

  /** Attach the local player's enchantment registry + PropertyInt mods (see VitalStatContext). */
  setStatContext(provider: (() => VitalStatContext) | null): void {
    this.statContext = provider;
  }

  /**
   * Compute base max for a vital from attribute values.
   * Health = round(Endurance / 2)  [half away from zero — ACE AttributeFormula]
   * Stamina = Endurance
   * Mana = Self
   *
   * ACE AttributeFormula.GetFormula (ACE.Server/Entity/AttributeFormula.cs:67)
   * divides by the SecondaryAttributeTable divisor (Z=2 for MaxHealth) then calls
   * `.Round()` = Math.Round(n,0,MidpointRounding.AwayFromZero) (FloatExtensions.cs:9).
   * For odd Endurance, x.5 rounds UP — a plain floor was off by 1 (End 101 -> 51,
   * not 50). Stamina/Mana use divisor 1 (no rounding).
   */
  getBase(id: VitalId, attributes: AttributeSystem): number {
    return this.formulaValue(id, (attr) => attributes.getCurrent(attr));
  }

  private formulaValue(id: VitalId, attrValue: (attr: AttributeId) => number): number {
    const t = this.formulaTable;
    if (t) {
      const formula = id === VitalId.Health ? t.maxHealth : id === VitalId.Stamina ? t.maxStamina : t.maxMana;
      // ACE AttributeFormula.GetFormula(creature, formula): `if (formula.X == 0) return 0;`
      if (formula.x === 0) return 0;
      return computeSkillFormula(formula, attrValue);
    }
    switch (id) {
      case VitalId.Health:
        return roundHalfAwayFromZero(attrValue(AttributeId.Endurance) / 2);
      case VitalId.Stamina:
        return attrValue(AttributeId.Endurance);
      case VitalId.Mana:
        return attrValue(AttributeId.Self);
    }
  }

  /**
   * ACE CreatureVital.GetMaxValue(enchanted) (CreatureVital.cs:127-174):
   *   total  = StartingValue + Ranks + AttributeFormula(vital, enchanted)
   *            (+ Enlightenment*2 + GearMaxHealth for a player's health —
   *             added BEFORE the multipliers, so vitae/benediction scale them)
   *   fTotal = total * GetVitalMod_Multiplier (float) * Vitae (player)
   *   max    = Round(fTotal + GetVitalMod_Additives), floored at 5 (1 when
   *            total < 5) — "a creature cannot fall below 5 MaxVital".
   * The formula reads BUFFED attributes when enchanted (Endurance buffs raise
   * max health). Vitae applies even to the unenchanted value, as in ACE.
   */
  getMaxValue(id: VitalId, attributes: AttributeSystem, enchanted = true): number {
    const vital = this.vitals.get(id);
    if (!vital) return 0;
    const ctx = this.statContext?.() ?? null;
    const ench = ctx?.enchantments ?? null;
    const attrValue = enchanted && ench
      ? (attr: AttributeId) => getAttributeCurrent(attributes, attr, ench)
      : (attr: AttributeId) => attributes.getCurrent(attr);
    let total = vital.startingValue + vital.raises + this.formulaValue(id, attrValue);
    const mods = ctx?.mods ?? null;
    if (mods && id === VitalId.Health) total += mods.enlightenment * 2 + mods.gearMaxHealth;

    const key = VITAL_MAX_KEY[id];
    const multiplier = enchanted && ench ? ench.getVitalModMultiplier(key) : 1.0;
    let fTotal = Math.fround(total * multiplier);
    if (mods && ench) {
      const vitae = ench.getVitae();
      if (vitae !== 1.0) fTotal = Math.fround(fTotal * vitae);
    }
    const additives = enchanted && ench ? ench.getVitalModAdditive(key) : 0;
    const iTotal = roundHalfAwayFromZero(Math.fround(fTotal + additives));
    const minVital = total >= 5 ? 5 : 1;
    return Math.max(minVital, iTotal);
  }

  /** The enchanted max (ACE CreatureVital.MaxValue = GetMaxValue(true)). */
  getMax(id: VitalId, attributes: AttributeSystem): number {
    return this.getMaxValue(id, attributes, true);
  }

  /** ACE CreatureVital.StartingValue (PrivateUpdateVital / PlayerDescription InitLevel). */
  getStartingValue(id: VitalId): number {
    return this.vitals.get(id)?.startingValue ?? 0;
  }

  setStartingValue(id: VitalId, startingValue: number): void {
    const vital = this.vitals.get(id);
    if (vital) vital.startingValue = startingValue;
  }

  /** Get the current value. */
  getCurrent(id: VitalId): number {
    return this.vitals.get(id)?.current ?? 0;
  }

  /** Set the current value (clamped to [0, max]). */
  setCurrent(id: VitalId, value: number, attributes: AttributeSystem): void {
    const vital = this.vitals.get(id);
    if (!vital) return;
    const max = this.getMax(id, attributes);
    vital.current = Math.max(0, Math.min(value, max));
  }

  /** Initialize vitals to max (called after character creation). */
  initToMax(attributes: AttributeSystem): void {
    for (const [id, vital] of this.vitals) {
      vital.current = this.getMax(id, attributes);
      vital.partialRegen = 0;
    }
  }

  /** Apply damage (reduce health). */
  takeDamage(amount: number): number {
    const vital = this.vitals.get(VitalId.Health)!;
    const prev = vital.current;
    vital.current = Math.max(0, vital.current - amount);
    return prev - vital.current;
  }

  /**
   * Use stamina (e.g., from jumping, attacking).
   *
   * Unlike mana, ACE never gates an action on insufficient stamina — the
   * cost is always applied and clamped to 0. Player.cs HandleActionJump's
   * only stamina check (`if (staminaCost > Stamina.Current) { ... }`,
   * Player.cs:883-894) is commented out in ACE source itself, and every
   * other stamina-cost site (Player_Combat.cs swing costs, Healer.cs first-
   * aid) calls `UpdateVitalDelta(Stamina, -cost)` unconditionally, which
   * clamps via `Math.Clamp(newVal, 0, MaxValue)` (Creature_Vitals.cs
   * UpdateVital) rather than rejecting. Always deduct and clamp; never
   * refuse — matches ACE's asymmetry between stamina (never gated) and
   * mana (gated — see useMana below / CalculateManaUsage in
   * Player_Magic.cs, which does reject with WeenieError.YouDontHaveEnoughManaToCast).
   */
  useStamina(amount: number): boolean {
    const vital = this.vitals.get(VitalId.Stamina)!;
    vital.current = Math.max(0, vital.current - amount);
    return true;
  }

  /** Use mana (e.g., from casting spells). */
  useMana(amount: number): boolean {
    const vital = this.vitals.get(VitalId.Mana)!;
    if (vital.current < amount) return false;
    vital.current -= amount;
    return true;
  }

  /** Get the number of raises applied to a vital. */
  getRaises(id: VitalId): number {
    return this.vitals.get(id)?.raises ?? 0;
  }

  /** Set raises for a vital (used by save/load). */
  setRaises(id: VitalId, raises: number): void {
    const vital = this.vitals.get(id);
    if (vital) vital.raises = raises;
  }

  /** Check if the character is dead. */
  isDead(): boolean {
    return this.getCurrent(VitalId.Health) <= 0;
  }

  /** Check if exhausted (stamina = 0). */
  isExhausted(): boolean {
    return this.getCurrent(VitalId.Stamina) <= 0;
  }

  /**
   * Raise a vital's max by spending XP.
   * @returns XP spent, or 0 if cannot afford
   */
  raiseVital(id: VitalId, xpCostTable: number[], availableXp: number): number {
    const vital = this.vitals.get(id);
    if (!vital) return 0;

    const nextIndex = vital.raises + 1;
    if (nextIndex >= xpCostTable.length) return 0;

    const cost = xpCostTable[nextIndex] - xpCostTable[vital.raises];
    if (cost > availableXp) return 0;

    vital.raises++;
    return cost;
  }

  /**
   * Calculate regen amount per tick for a specific vital.
   *
   * Formula: baseRate × attributeMod × stanceMod × enchantmentMod × augMod
   *
   * - attributeMod: Health only, from Str + 2*End
   * - stanceMod: Health and Stamina only (NOT Mana)
   * - baseRate: the vital's RegenRate (getRegenRate — server value, else
   *   the player weenie's)
   * - enchantmentMod: from active regen spells (default: the attached
   *   registry's GetRegenerationMod, 1.0 without one)
   * - augMod: from Innate Renewal augmentations (every stance)
   *
   * STATS.regen-prediction-diverges — pre-fix this read a constant table and
   * never the rate setRegenRate stored, and gated augMod on Sleeping.
   */
  getRegenPerTick(
    id: VitalId,
    attributes: AttributeSystem,
    stance: RegenStance = RegenStance.Standing,
    enchantmentMod: number = this.getRegenEnchantmentMod(id),
    augmentationLevel = 0,
  ): number {
    // ACE `vital.RegenRate * attributeMod * stanceMod * enchantmentMod * augMod`
    // (Creature_Vitals.cs:133).
    const baseRate = this.getRegenRate(id);

    // Attribute mod: Health only. ACE reads Strength.Base + Endurance.Base
    // (Creature_Vitals.cs:186-189), where CreatureAttribute.Base = StartingValue + Ranks
    // (CreatureAttribute.cs:93-97) — the creation value PLUS XP-bought raises. Our
    // getCurrent() returns innate + raises (no buff layer), so it equals ACE's Base;
    // getInnate() drops the raises, which understated regen for any leveled character.
    let attributeMod = 1.0;
    if (id === VitalId.Health) {
      attributeMod = getHealthRegenAttributeMod(
        attributes.getCurrent(AttributeId.Strength),
        attributes.getCurrent(AttributeId.Endurance),
      );
    }

    // Stance mod: Health and Stamina only (NOT Mana)
    let stanceMod = 1.0;
    if (id !== VitalId.Mana) {
      stanceMod = getRegenStanceMod(stance);
    }

    // Augmentation mod — Innate Renewal (AugmentationFasterRegen), applied
    // in every stance (Creature_Vitals.cs:129-131 has no stance test).
    const augMod = getAugmentationRegenMod(augmentationLevel);

    return baseRate * attributeMod * stanceMod * enchantmentMod * augMod;
  }

  /**
   * Process regeneration over dt seconds.
   * Uses partial tick accumulation for fractional amounts.
   *
   * Reference: ACE Creature_Vitals.cs VitalHeartBeat()
   */
  regenTick(
    dt: number,
    attributes: AttributeSystem,
    stance: RegenStance = RegenStance.Standing,
    enchantmentMods?: Partial<Record<VitalId, number>>,
    augmentationLevel = 0,
  ): void {
    this.regenAccumulator += dt;

    while (this.regenAccumulator >= REGEN_INTERVAL) {
      this.regenAccumulator -= REGEN_INTERVAL;

      for (const [id, vital] of this.vitals) {
        const max = this.getMax(id, attributes);
        if (vital.current >= max) {
          vital.partialRegen = 0;
          continue;
        }

        const enchMod = enchantmentMods?.[id] ?? this.getRegenEnchantmentMod(id);
        const perTick = this.getRegenPerTick(id, attributes, stance, enchMod, augmentationLevel);

        // Accumulate with partial regen
        const totalTick = perTick + vital.partialRegen;
        const intTick = Math.floor(totalTick);
        vital.partialRegen = totalTick - intTick;

        if (intTick > 0) {
          vital.current = Math.min(max, vital.current + intTick);
        }
      }
    }
  }

  /**
   * FAITHFUL.377 — server-sent regen rate per vital, set via
   * PrivateUpdatePropertyFloat for PropertyFloat.HealthRate (3),
   * StaminaRate (4), and ManaRate (5). ACE Entity/CreatureVital.cs:35-46
   * sources `RegenRate` from these exact keys. (Premise correction: ACE
   * does NOT re-broadcast them when a regen spell lands — EnchantmentManager.
   * cs:607-619 is GetVitalRateKey; the spell is an enchantment on the rate
   * key, read via getRegenEnchantmentMod.) Falls back to
   * PLAYER_WEENIE_REGEN_RATES when no value has arrived.
   */
  private serverRegenRates = new Map<VitalId, number>();

  /** Get the base regen rate per tick for a vital. */
  getRegenRate(id: VitalId): number {
    const live = this.serverRegenRates.get(id);
    if (live !== undefined) return live;
    return PLAYER_WEENIE_REGEN_RATES[id] ?? 0;
  }

  /**
   * ACE EnchantmentManager.GetRegenerationMod(vital) (EnchantmentManager.cs:
   * 944-956) over the attached registry — Regeneration / Rejuvenation / Mana
   * Renewal (and their debuffs) multiply the rate. 1.0 without a registry.
   */
  getRegenEnchantmentMod(id: VitalId): number {
    const ench = this.statContext?.()?.enchantments;
    return ench ? ench.getRegenerationMod(VITAL_RATE_KEY[id]) : 1.0;
  }

  /**
   * FAITHFUL.377 — Set the live regen rate from a server broadcast.
   * Called from main.ts onPrivateUpdatePropertyFloat for keys 3/4/5.
   */
  setRegenRate(id: VitalId, rate: number): void {
    this.serverRegenRates.set(id, rate);
  }
}
