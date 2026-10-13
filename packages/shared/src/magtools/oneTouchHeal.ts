/**
 * Mag-Tools' One Touch Heal (docs/plugin-specs/magtools.md §9.5), rebuilt from the spec (clean
 * room): what one press does, from injected vitals and inventory. A hotkey with no default key
 * upstream (no `/mt` command).
 *
 * 1. missing = max health − health; nothing when 0.
 * 2. With Healing trained, the kit is the appraised healing kit with the fewest uses left, else the
 *    first kit (and its appraisal is asked for).
 * 3. required = 2 × missing in peace mode, ceil(2.6 × missing) otherwise; with
 *    kit = Healing (current, buffed) + the kit's BoostValue (PropertyInt 90): use the kit on
 *    yourself when required < kit, or when there is no healing food.
 * 4. Otherwise eat the first Food item whose name contains `Heal` or `Meat`.
 * 5. Upstream never casts a heal spell (a TODO there), so neither does this.
 */

export interface MtHealKit {
  id: number;
  name: string;
  /** Appraised: BoostValue (PropertyInt 90) and uses left (Structure, PropertyInt 92) are known. */
  appraised: boolean;
  boost?: number;
  usesLeft?: number;
}

export interface MtHealFood { id: number; name: string }

export interface MtHealInput {
  health: number;
  maxHealth: number;
  /** Healing is trained or specialized. */
  healingTrained: boolean;
  /** Healing's current (buffed) value. */
  healingSkill: number;
  /** Not in peace mode (any combat stance). */
  inCombat: boolean;
  /** Healing kits in inventory (ObjectClass HealingKit), in inventory order. */
  kits: readonly MtHealKit[];
  /** Food items in inventory (ObjectClass Food), in inventory order. */
  food: readonly MtHealFood[];
}

export type MtHealDecision =
  | { kind: 'none'; reason: 'full' | 'nothing' }
  /** Apply the kit to yourself (use it on your own character). `appraise` = ask for its appraisal too. */
  | { kind: 'kit'; id: number; appraise: boolean; required: number; chance: number }
  /** Eat / drink it (use it). */
  | { kind: 'food'; id: number };

/** Food that heals: the name contains `Heal` or `Meat` (case-sensitive, as the spec writes them). */
export function mtIsHealingFood(name: string): boolean {
  return name.includes('Heal') || name.includes('Meat');
}

/** What one press of One Touch Heal does. */
export function mtOneTouchHeal(i: MtHealInput): MtHealDecision {
  const missing = i.maxHealth - i.health;
  if (missing <= 0) return { kind: 'none', reason: 'full' };
  let kit: MtHealKit | null = null;
  if (i.healingTrained && i.kits.length) {
    const appraised = i.kits.filter((k) => k.appraised);
    kit = appraised.length
      ? appraised.reduce((best, k) => ((k.usesLeft ?? Infinity) < (best.usesLeft ?? Infinity) ? k : best))
      : i.kits[0]!;
  }
  const food = i.food.find((f) => mtIsHealingFood(f.name)) ?? null;
  if (kit) {
    const required = i.inCombat ? Math.ceil(2.6 * missing) : 2 * missing;
    const chance = i.healingSkill + (kit.boost ?? 0);
    if (required < chance || !food) return { kind: 'kit', id: kit.id, appraise: !kit.appraised, required, chance };
  }
  if (food) return { kind: 'food', id: food.id };
  return { kind: 'none', reason: 'nothing' };
}
