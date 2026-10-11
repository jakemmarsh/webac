/**
 * AGENT.vtank-crafting — VirindiTank's AutoCraftItems, from facts in
 * openac-mosstank's reading of VTank (MOSS; docs/vtank-macro-behavior.md
 * "Crafting"). Pure: the macro (vtMacro.ts) feeds it what you carry and the
 * era's recipe table, and does the one step it returns with the client's own
 * use-item-on-item.
 *
 * - A recipe makes `count` of `result` when `first` is used on `second`.
 * - The want: each listed name you carry fewer than `count` of, in name order.
 * - A recipe needing a skill needs it trained (or specialized); Fletching (37)
 *   also needs your current skill ≥ difficulty + ArrowheadFletchDiffExcessThreshold.
 * - A missing ingredient is crafted first when a recipe makes it (no cycles).
 * - One step at a time: the next decision sees the new inventory.
 * - Not built: a recipe that uses an item on another of the same name when
 *   only one stack is carried (VTank splits the stack first).
 */
import type { PlanSkill } from '@ac/shared';

/** [first, second, result, count, skill, difficulty, recipe id] rows (tools/build-craft-tables.ts). */
export type CraftRow = [string, string, string, number, number, number, number];
export interface CraftItem { guid: number; name: string; stack?: number }
export interface CraftStep { first: CraftItem; second: CraftItem; result: string; count: number; for: string; why: string }

export const FLETCHING_SKILL = 37;

/** The recipes making each result, by lower-cased name (built once per table). */
export function indexRecipes(rows: CraftRow[]): Map<string, CraftRow[]> {
  const by = new Map<string, CraftRow[]>();
  for (const r of rows) {
    const k = r[2].toLowerCase();
    const list = by.get(k);
    if (list) list.push(r); else by.set(k, [r]);
  }
  for (const list of by.values()) list.sort((a, b) => a[6] - b[6]);
  return by;
}

function canCraft(skills: PlanSkill[], skill: number, difficulty: number, fletchExcess: number): boolean {
  if (!skill) return true;
  const s = skills.find((x) => x.id === skill);
  if (!s || s.training === 'untrained') return false;
  return skill !== FLETCHING_SKILL || s.buffed >= Math.max(0, difficulty) + fletchExcess;
}

/**
 * The next craft for the first wanted item you're short of, or null.
 * `want`: names and how many to have (1 for "when out"; the IdleCraftCount_* numbers when idle).
 */
export function planCraft(input: {
  recipes: Map<string, CraftRow[]>;
  items: CraftItem[];
  skills: PlanSkill[];
  want: Array<{ name: string; count: number }>;
  fletchExcess: number;
}): CraftStep | null {
  const carried = (name: string): number => input.items.filter((i) => i.name.toLowerCase() === name.toLowerCase()).reduce((n, i) => n + Math.max(1, i.stack ?? 1), 0);
  const find = (name: string, not = 0): CraftItem | undefined => input.items.find((i) => i.guid !== not && (i.stack ?? 1) > 0 && i.name.toLowerCase() === name.toLowerCase());
  const step = (result: string, wanted: string, visiting: Set<string>): CraftStep | null => {
    const key = result.toLowerCase();
    if (visiting.has(key)) return null;
    visiting.add(key);
    try {
      for (const r of input.recipes.get(key) ?? []) {
        const [first, second, made, count, skill, difficulty] = r;
        if (!canCraft(input.skills, skill, difficulty, input.fletchExcess)) continue;
        const a = find(first);
        if (!a) { const pre = step(first, wanted, visiting); if (pre) return pre; continue; }
        const b = find(second, first.toLowerCase() === second.toLowerCase() ? a.guid : 0);
        if (!b) {
          if (first.toLowerCase() === second.toLowerCase()) continue; // needs a stack split first (not built)
          const pre = step(second, wanted, visiting); if (pre) return pre; continue;
        }
        return { first: a, second: b, result: made, count, for: wanted, why: made.toLowerCase() === wanted.toLowerCase() ? `crafting ${made} (${a.name} on ${b.name})` : `crafting ${made} for ${wanted} (${a.name} on ${b.name})` };
      }
      return null;
    } finally { visiting.delete(key); }
  };
  const wants = [...new Map(input.want.filter((w) => w.name.trim() && w.count > 0).map((w) => [w.name.toLowerCase(), w])).values()]
    .sort((x, y) => x.name.localeCompare(y.name, undefined, { sensitivity: 'base' }));
  for (const w of wants) {
    if (carried(w.name) >= w.count) continue;
    const s = step(w.name, w.name, new Set());
    if (s) return s;
  }
  return null;
}

/** Which IdleCraftCount_* option a consumable's name falls under (VTank's kit names; food by its examined BoosterEnum). */
export function idleCraftCategory(name: string, boosterEnum?: number): 'HealthKits' | 'StamKits' | 'ManaKits' | 'HealthFood' | 'StamFood' | 'ManaFood' | null {
  if (/ Kit$/.test(name)) return /stamina/i.test(name) ? 'StamKits' : /mana/i.test(name) ? 'ManaKits' : 'HealthKits';
  // ACE BoosterEnum (PropertyInt 89): 2 Health, 4 Stamina, 6 Mana.
  return boosterEnum === 2 ? 'HealthFood' : boosterEnum === 4 ? 'StamFood' : boosterEnum === 6 ? 'ManaFood' : null;
}
