/**
 * VirindiTank's Drain Auto: the cheapest run of health drains, martyrs and
 * self-heals that finishes the monster without your own health falling below
 * the Vitals tab's "Heal at" level (docs/vtank-parity-gaps.md §1.7; facts
 * from MOSS `CorpseDrainPlan` and `CombatController.PlanDrain`, no code
 * copied). Only the plan's first step is cast; the next decision plans again
 * from what happened, so a monster that behaves differently is re-planned
 * rather than followed.
 *
 * The steps, on (your health, your maximum, the monster's health left):
 * - a drain takes `factor` × the monster's health left (at most `cap`; ACE
 *   HandleCastSpell_Transfer: Proportion of the source's current vital,
 *   TransferCap) and gives you that × `multiplier` (1 - LossPercent), trimmed
 *   to what you are missing (the drain is cut back to match, as ACE scales it);
 * - a martyr spends `factor` × your current health and takes that ×
 *   `multiplier` (DamageRatio) off the monster (ACE HandleCastSpell_Projectile);
 * - healing yourself (VTank's model: 115 points, 2.45 s) does nothing to the
 *   monster; a plan that starts with it means "don't drain now": the macro
 *   leaves the fight to the recharge rules (the step answers null).
 * Each cast costs its cast time plus 0.8 s. The drain and martyr numbers come
 * from the era's spell data (tools/build-drain-tables.ts). The cast times are
 * not in any era's data, so every drain and martyr counts the same 1 s (INF;
 * VTank's database has a time per spell); the search then prefers fewer casts.
 *
 * Under 300 health left, a bounded search (the time allowance grows by 0.6 s
 * a round, at most 2000 plans) finds the cheapest finishing plan (casts + ms);
 * a plan is pruned when its time plus 1000 × health left / 106 passes the
 * allowance, or it drops you below the floor (unless nothing keeps you above
 * it from there). Above 300, or when the search runs out, one greedy step:
 * the most health taken off per millisecond, a step that finishes the monster
 * winning outright, a martyr counted 180 points better and 3.2 s dearer. At
 * full health no drain or heal is planned (nothing to drain into), nor a drain
 * on a monster with under 25 left. A monster immune to drains (the era's
 * monster table) or whose health isn't known is never drained.
 */

/** One drain or martyr the era has: [spellId, kind, factor, cap, multiplier] (tools/build-drain-tables.ts). 'r' is a martyr fired as a ring. */
export type DrainRow = [number, 'd' | 'm' | 'r', number, number, number];

export interface DrainPlanInput {
  health: number;
  maxHealth: number;
  /** Your health may not drop below this. */
  floor: number;
  /** The monster's health left in points (Infinity when not known). */
  target: number;
  canDrain: boolean;
  /** A ring plan: only ring martyrs may be used. */
  ring: boolean;
  rows: DrainRow[];
  /** Whether you can cast this spell now (known, skill, components). */
  castable: (spellId: number) => boolean;
}

const OVERHEAD_MS = 800;
const CAST_MS = 1000;
const HEAL_MS = 2450;
const HEAL_POINTS = 115;
const DRAIN_FLOOR = 25;
const SEARCH_CEILING = 300;
const BUDGET_STEP = 600;
const NODE_BUDGET = 2000;
const MARTYR_BIAS = 180;
const MARTYR_BIAS_COST = 3200;

interface State { hp: number; max: number; target: number; ms: number }
type Step = { id: number; kind: 'drain' | 'martyr' | 'heal'; factor: number; cap: number; mult: number; ms: number };

function apply(s: State, st: Step): State {
  if (st.kind === 'heal') return { ...s, hp: Math.min(s.max, s.hp + HEAL_POINTS), ms: s.ms + st.ms };
  if (st.kind === 'martyr') {
    const spent = Math.round(s.hp * st.factor);
    return { ...s, hp: s.hp - spent, target: Math.max(0, s.target - Math.round(spent * st.mult)), ms: s.ms + st.ms };
  }
  let drained = Math.min(Math.round(s.target * st.factor), s.target, st.cap > 0 ? st.cap : Infinity);
  let gained = Math.round(drained * st.mult);
  const missing = s.max - s.hp;
  if (gained > missing) {
    drained = Math.max(0, drained - Math.round((gained - missing) / st.mult));
    gained = missing;
  }
  return { ...s, hp: s.hp + gained, target: s.target - drained, ms: s.ms + st.ms };
}

const skip = (s: State, st: Step): boolean => (s.hp === s.max && st.kind !== 'martyr') || (st.kind === 'drain' && s.target < DRAIN_FLOOR);
const done = (s: State): boolean => s.target <= 0;

/** The spell to cast now, or null when nothing beats healing (leave it to the recharge rules). */
export function planDrain(input: DrainPlanInput): number | null {
  const steps: Step[] = [];
  for (const [id, kind, factor, cap, mult] of input.rows) {
    if (!input.castable(id)) continue;
    if (kind === 'd') { if (input.canDrain) steps.push({ id, kind: 'drain', factor, cap, mult, ms: CAST_MS + OVERHEAD_MS }); continue; }
    if ((kind === 'r') !== input.ring) continue;
    steps.push({ id, kind: 'martyr', factor, cap, mult, ms: CAST_MS + OVERHEAD_MS });
  }
  steps.push({ id: 0, kind: 'heal', factor: 0, cap: 0, mult: 0, ms: HEAL_MS + OVERHEAD_MS });
  // An unknown health left is a very large number (VTank's int.MaxValue), so the arithmetic stays finite.
  const start: State = { hp: input.health, max: input.maxHealth, target: Number.isFinite(input.target) ? input.target : 0x7fffffff, ms: 0 };
  const first = (input.target < SEARCH_CEILING ? search(start, input.floor, steps) : null) ?? greedy(start, input.floor, steps);
  return first && first.kind !== 'heal' ? first.id : null;
}

/** The first step of the cheapest finishing plan within a growing time allowance, or null when the node budget runs out first. */
function search(start: State, floor: number, steps: Step[]): Step | null {
  let visited = 0;
  for (let budget = BUDGET_STEP; ; budget += BUDGET_STEP) {
    const found: { best: { first: Step; cost: number } | null } = { best: null };
    const stack: Array<{ s: State; first: Step | null; n: number }> = [{ s: start, first: null, n: 0 }];
    while (stack.length) {
      const node = stack.pop()!;
      if (++visited >= NODE_BUDGET) return found.best?.first ?? null;
      const next = (keepFloor: boolean): boolean => {
        let any = false;
        for (const st of steps) {
          if (skip(node.s, st)) continue;
          const s = apply(node.s, st);
          if (s.ms + Math.floor((1000 * s.target) / 106) > budget || (keepFloor && s.hp < floor)) continue;
          any = true;
          const first = node.first ?? st;
          if (!done(s)) stack.push({ s, first, n: node.n + 1 });
          else { const cost = node.n + 1 + s.ms; if (!found.best || cost < found.best.cost) found.best = { first, cost }; }
        }
        return any;
      };
      // Nothing keeps you above the floor from here: the floor is dropped for this node, not the branch.
      if (!next(true)) next(false);
    }
    if (found.best) return found.best.first;
  }
}

/** One step: the most monster health per millisecond (a finishing step wins; martyrs get a head start and a charge). */
function greedy(start: State, floor: number, steps: Step[]): Step {
  const rank = (keepFloor: boolean): Step | null => {
    let chosen: { st: Step; s: State; rate: number } | null = null;
    for (const st of steps) {
      if (skip(start, st)) continue;
      const s = apply(start, st);
      if (keepFloor && s.hp < floor) continue;
      if (!chosen) { chosen = { st, s, rate: 0 }; continue; }
      if (!done(chosen.s)) {
        if (done(s)) { chosen = { st, s, rate: 0 }; continue; }
        const martyr = st.kind === 'martyr';
        const rate = ((martyr ? MARTYR_BIAS : 0) + start.target - s.target) / ((martyr ? MARTYR_BIAS_COST : 0) + s.ms - start.ms);
        if (rate > chosen.rate) chosen = { st, s, rate };
      } else if (done(s) && s.ms < chosen.s.ms) chosen = { st, s, rate: 0 };
    }
    return chosen?.st ?? null;
  };
  return rank(true) ?? rank(false) ?? steps[steps.length - 1];
}
