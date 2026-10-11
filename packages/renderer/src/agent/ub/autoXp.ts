/**
 * UtilityBelt's AutoXp (`/ub xp`; Tools/AutoXp.cs at 5fe9825a, MIT): spend
 * unassigned experience by a weighted policy. Each step raises the target
 * with the lowest cost ÷ weight next; a target stops StopBeforeMax ranks
 * short of its table's end (at least one short); a weight of 0 or less is
 * left alone.
 *
 * UB sends arbitrary experience into a target (AddExp, up to MaxXpChunk at a
 * time for `level`). A player can only press the character panel's Raise, so
 * here every step is one raise through it (the same request the button
 * sends): `slow` paces raises TriesTime apart, `level` goes as fast as the
 * server answers. The plan and its order are UB's.
 */

/** The cost of the next `steps` raises of a target, in order (shorter when its table ends sooner), or null when it can't be raised. */
export type RaiseCosts = (target: string, steps: number) => number[] | null;

/** UB's XpTarget names (its enum): attributes, vitals, skills. */
export const XP_TARGETS: readonly string[] = [
  'Strength', 'Endurance', 'Coordination', 'Quickness', 'Focus', 'Self', 'Health', 'Stamina', 'Mana',
  'Alchemy', 'ArcaneLore', 'ArmorTinkering', 'AssessCreature', 'AssessPerson', 'Cooking', 'CreatureEnchantment',
  'Deception', 'DirtyFighting', 'DualWield', 'FinesseWeapons', 'Fletching', 'Healing', 'HeavyWeapons',
  'ItemEnchantment', 'ItemTinkering', 'Jump', 'Leadership', 'LifeMagic', 'LightWeapons', 'Lockpick', 'Loyalty',
  'MagicDefense', 'MagicItemTinkering', 'ManaConversion', 'MeleeDefense', 'MissileDefense', 'MissileWeapons',
  'Recklessness', 'Run', 'Salvaging', 'Shield', 'SneakAttack', 'Summoning', 'TwoHandedCombat', 'VoidMagic',
  'WarMagic', 'WeaponTinkering',
];

/** The raise name the character panel takes for a UB target ("ArcaneLore" → "Arcane Lore", "Health" → "Health"). */
export function xpTargetLabel(t: string): string {
  return t.replace(/([a-z])([A-Z])/g, '$1 $2');
}

/**
 * UB GetPlan: how many raises of each target `xp` buys under `policy`. Costs come `stopBeforeMax` ranks
 * short of each table's end (the last `max(1, stopBeforeMax)` ranks are never bought).
 */
export function planXp(o: { xp: number; policy: Record<string, number>; costs: RaiseCosts; stopBeforeMax: number; maxSteps?: number }): Map<string, number[]> {
  const plan = new Map<string, number[]>();
  const cache = new Map<string, number[]>();
  const keep = Math.max(1, Math.floor(o.stopBeforeMax));
  const costAt = (t: string, i: number): number | null => {
    let c = cache.get(t);
    if (!c) {
      const all = o.costs(xpTargetLabel(t), 400) ?? [];
      // Every cost but the last `keep` (CostToLevel returns null within StopBeforeMax of the end).
      c = all.length > keep ? all.slice(0, all.length - keep) : [];
      cache.set(t, c);
    }
    const v = c[i];
    return v !== undefined && v > 0 ? v : null;
  };
  const weighted = new Map<string, number>();
  for (const [t, w] of Object.entries(o.policy)) {
    if (!(w > 0)) continue;
    const c = costAt(t, 0);
    if (c === null) continue;
    plan.set(t, []);
    weighted.set(t, c / w);
  }
  let xp = o.xp;
  for (let i = 0; i < (o.maxSteps ?? 9999) && weighted.size; i++) {
    let next: string | null = null;
    let best = Infinity;
    for (const [t, wc] of weighted) if (wc < best) { best = wc; next = t; }
    if (next === null || best === Infinity) break;
    const done = plan.get(next)!;
    const cost = costAt(next, done.length);
    if (cost === null || xp < cost) break;
    done.push(cost);
    xp -= cost;
    const after = costAt(next, done.length);
    weighted.set(next, after === null ? Infinity : after / o.policy[next]!);
  }
  for (const [t, steps] of plan) if (!steps.length) plan.delete(t);
  return plan;
}

/** UB's flat plan, cheapest step first (SpendExperience sorts by cost). */
export function flattenXpPlan(plan: Map<string, number[]>): Array<{ target: string; cost: number }> {
  const flat: Array<{ target: string; cost: number }> = [];
  for (const [target, steps] of plan) for (const cost of steps) flat.push({ target, cost });
  return flat.sort((a, b) => a.cost - b.cost);
}

/** `/ub xp export`: `Target=weight;…` in policy order. */
export function exportXpPolicy(policy: Record<string, number>): string {
  return Object.entries(policy).map(([k, v]) => `${k}=${v}`).join(';');
}

/** `/ub xp import`: each valid `Target=weight` pair overrides; the rest are reported as UB does. */
export function importXpPolicy(policy: Record<string, number>, text: string): { policy: Record<string, number>; errors: string[] } {
  const out = { ...policy };
  const errors: string[] = [];
  for (const pair of text.split(';')) {
    const parts = pair.split('=');
    if (parts.length !== 2) continue;
    const name = XP_TARGETS.find((t) => t === parts[0]!.trim());
    if (!name) { errors.push(`Unable to parse XpTarget ${parts[0]!.trim()}`); continue; }
    const w = Number(parts[1]!.trim());
    if (!parts[1]!.trim() || !Number.isFinite(w)) { errors.push(`Unable to parse ${parts[1]!.trim()} for ${name}`); continue; }
    out[name] = w;
  }
  return { policy: out, errors };
}
