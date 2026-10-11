/**
 * UtilityBelt's tinkering (docs/vtank-parity-gaps.md §7): its Tinker tab's
 * plan (the lowest-workmanship bag of the chosen salvage that still clears
 * AutoTinker.MinPercentage, or for a melee weapon the better of iron and
 * granite each step), `/ub tinkcalc` and `/ub getjob`. UtilityBelt is MIT
 * (Lib/Salvage/TinkerCalc.cs, Lib/Tinker/TinkerJobManager.cs,
 * Tools/AutoTinker.cs at 5fe9825a).
 *
 * The chance is the server's own (ACE RecipeManager.GetTinkerChance, which
 * credits Endy's Tinkering Calculator, as UB does):
 *   difficulty = floor((mod·5 + itemWork·mod·2 − bagWork·wMod·mod/5) · attemptMod[tinks])
 *   wMod = 2 when the bag's workmanship ≥ the item's, else 1
 *   chance = 1 − 1 / (1 + e^(0.03·(skill − difficulty)))   (SkillCheck.GetSkillChance)
 *   an imbue (the recipe's salvage type 2) divides it by 3.
 * Which skill each salvage uses, and which salvage imbues, come from the
 * era's own recipe table (tools/build-tinker-tables.ts), so an era without
 * tinkering has none to plan with.
 */
import { MaterialType, getMaterialName } from '@ac/shared';

/** [materialType, skill, salvageType (1 tinker, 2 imbue)] (tools/build-tinker-tables.ts). */
export type TinkerRow = [number, number, number];

/** ACE RecipeManager.TinkeringDifficulty: the multiplier for each attempt (index = times tinkered so far). */
export const TINKERING_DIFFICULTY: readonly number[] = [1.0, 1.1, 1.3, 1.6, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5];

/** ACE RecipeManager.GetMaterialMod. */
export function materialMod(material: number): number {
  switch (material) {
    case MaterialType.Gold: case MaterialType.Oak: return 10;
    case MaterialType.Alabaster: case MaterialType.ArmoredilloHide: case MaterialType.Brass: case MaterialType.Bronze:
    case MaterialType.Ceramic: case MaterialType.Granite: case MaterialType.Linen: case MaterialType.Marble:
    case MaterialType.Moonstone: case MaterialType.Opal: case MaterialType.Pine: case MaterialType.ReedSharkHide:
    case MaterialType.Velvet: case MaterialType.Wool: return 11;
    case MaterialType.Ebony: case MaterialType.GreenGarnet: case MaterialType.Iron: case MaterialType.Mahogany:
    case MaterialType.Porcelain: case MaterialType.Satin: case MaterialType.Steel: case MaterialType.Teak: return 12;
    case MaterialType.Bloodstone: case MaterialType.Carnelian: case MaterialType.Citrine: case MaterialType.Hematite:
    case MaterialType.LavenderJade: case MaterialType.Malachite: case MaterialType.RedJade: case MaterialType.RoseQuartz: return 25;
    default: return 20;
  }
}

/** SkillCheck.GetSkillChance (factor 0.03), clamped to 0..1. */
export function skillChance(skill: number, difficulty: number, factor = 0.03): number {
  const c = 1 - 1 / (1 + Math.exp(factor * (skill - difficulty)));
  return Math.min(1, Math.max(0, c));
}

export const TINKER_SKILL_NAMES: Readonly<Record<number, string>> = { 18: 'Item Tinkering', 28: 'Weapon Tinkering', 29: 'Armor Tinkering', 30: 'Magic Item Tinkering' };

/** What the era's table says of one material: the skill it tinkers with and whether it imbues. */
export function tinkerRule(table: readonly TinkerRow[], material: number): { skill: number; imbue: boolean } | null {
  const rows = table.filter((r) => r[0] === material);
  if (!rows.length) return null;
  const tink = rows.find((r) => r[2] === 1) ?? rows[0]!;
  return { skill: tink[1], imbue: rows.every((r) => r[2] === 2) };
}

/**
 * The server's chance to apply a bag of `material` (workmanship `bagWork`) to an item of workmanship
 * `itemWork` tinkered `tinks` times, for a character with `skill` in the recipe's skill.
 */
export function tinkerChance(o: { material: number; bagWork: number; itemWork: number; tinks: number; skill: number; imbue: boolean; imbueAugs?: number }): number {
  if (o.tinks >= TINKERING_DIFFICULTY.length) return 0;
  const mod = materialMod(o.material);
  const wMod = o.bagWork >= o.itemWork ? 2 : 1;
  const difficulty = Math.floor((mod * 5 + o.itemWork * mod * 2 - (o.bagWork * wMod * mod) / 5) * TINKERING_DIFFICULTY[o.tinks]!);
  let c = skillChance(o.skill, difficulty);
  if (o.imbue) c = c / 3 + (o.imbueAugs ?? 0) * 0.05;
  return c;
}

/** UB's GetDPS: average of a hit with 10 % crits at double damage. */
export function tinkDps(maxDamage: number, variance: number): number {
  const min = maxDamage * (1 - variance);
  return 0.9 * ((maxDamage + min) / 2) + 0.1 * (maxDamage * 2);
}

/** The Blood Thirst cantrips' max-damage bonus (UB GetMaxDamage, spell ids 2598 / 2586 / 4661 / 6089), by name. */
const BLOOD_THIRST: ReadonlyArray<[RegExp, number]> = [[/^Minor Blood Thirst$/i, 2], [/^Major Blood Thirst$/i, 4], [/^Epic Blood Thirst$/i, 7], [/^Legendary Blood Thirst$/i, 10]];
export function bloodThirstBonus(spells: readonly string[]): number {
  let n = 0;
  for (const s of spells) for (const [re, b] of BLOOD_THIRST) if (re.test(s.trim())) n += b;
  return n;
}

/**
 * `/ub tinkcalc` (AutoTinker.CalculateBestDamage): for a melee weapon, each tink left up to 10 goes to iron
 * (+1 max damage) or granite (variance × 0.8), whichever gives the higher damage then. UB adds 24 to the
 * max damage first (its GetMaxDamage: a buffed Blood Drinker), plus the Blood Thirst cantrips.
 */
export function bestGraniteIron(o: { maxDamage: number; variance: number; tinks: number; spells: readonly string[] }): { granite: number; iron: number; finalDps: number; order: Array<'granite' | 'iron'> } {
  let max = o.maxDamage + bloodThirstBonus(o.spells) + 24;
  let variance = o.variance;
  let granite = 0, iron = 0, finalDps = 0;
  const order: Array<'granite' | 'iron'> = [];
  for (let i = o.tinks + 1; i <= 10; i++) {
    const ironDps = tinkDps(max + 1, variance);
    const graniteDps = tinkDps(max, variance * 0.8);
    if (ironDps >= graniteDps) { finalDps = ironDps; max += 1; iron++; order.push('iron'); }
    else { finalDps = graniteDps; variance *= 0.8; granite++; order.push('granite'); }
  }
  return { granite, iron, finalDps, order };
}

export interface TinkerBag { guid: number; name: string; material: number; workmanship: number }
export interface TinkerTarget { guid: number; name: string; workmanship: number; tinks: number; melee: boolean; maxDamage?: number; variance?: number; spells?: readonly string[] }
export interface TinkerStep { bag: TinkerBag; chance: number; tinkNo: number }

/**
 * The Tinker tab's Populate: the bags to apply, in order, each the lowest-workmanship bag of the wanted
 * material (or the granite / iron pick for "best" on a melee weapon) whose chance still clears `minChance`.
 * Stops at the first step that can't, at `maxTinks` total tinks, or after one imbue (an item takes one).
 */
export function planTinkers(o: {
  table: readonly TinkerRow[];
  target: TinkerTarget;
  bags: readonly TinkerBag[];
  material: number | 'best';
  skillOf: (skill: number) => number;
  minChance: number;
  maxTinks: number;
  imbueAugs?: number;
}): { steps: TinkerStep[]; stop: string } {
  const steps: TinkerStep[] = [];
  const used = new Set<number>();
  let tinks = o.target.tinks;
  let max = (o.target.maxDamage ?? 0) + bloodThirstBonus(o.target.spells ?? []) + 24;
  let variance = o.target.variance ?? 0;
  const limit = Math.min(o.maxTinks, TINKERING_DIFFICULTY.length);
  while (tinks < limit) {
    let want: number;
    if (o.material === 'best') {
      if (!o.target.melee) return { steps, stop: 'granite / iron is for melee weapons: name a salvage' };
      want = tinkDps(max + 1, variance) >= tinkDps(max, variance * 0.8) ? MaterialType.Iron : MaterialType.Granite;
    } else want = o.material;
    const rule = tinkerRule(o.table, want);
    if (!rule) return { steps, stop: `${getMaterialName(want)} doesn't tinker in this world` };
    const skill = o.skillOf(rule.skill);
    const candidates = o.bags.filter((b) => b.material === want && !used.has(b.guid)).sort((a, b) => a.workmanship - b.workmanship);
    const pick = candidates
      .map((bag) => ({ bag, chance: tinkerChance({ material: want, bagWork: bag.workmanship, itemWork: o.target.workmanship, tinks, skill, imbue: rule.imbue, imbueAugs: o.imbueAugs }) }))
      .find((x) => x.chance * 100 >= o.minChance);
    if (!pick) return { steps, stop: candidates.length ? `no ${getMaterialName(want)} bag clears ${o.minChance}% for tink ${tinks + 1}` : `no ${getMaterialName(want)} salvage carried` };
    used.add(pick.bag.guid);
    steps.push({ bag: pick.bag, chance: pick.chance, tinkNo: tinks + 1 });
    tinks++;
    if (want === MaterialType.Iron) max += 1;
    else if (want === MaterialType.Granite) variance *= 0.8;
    if (rule.imbue) return { steps, stop: 'an item takes one imbue' };
  }
  return { steps, stop: `reached ${limit} tinks` };
}
