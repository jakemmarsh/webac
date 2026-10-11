/**
 * VirindiTank's pea splitting (SplitPeas, the Consumables tab's spell
 * components and Add All Peas), as a pure planner (docs/vtank-macro-behavior.md §6).
 *
 * VTank (the wiki's Advanced Options): "Specifies if the macro should
 * automatically split peas. Components you would like to keep supplied by
 * splitting peas should be added to your Consumables panel." SpellCompMin-
 * Critical / -Normal / -Idle: "The minimum number of each type of spell
 * component. If you have fewer, a pea will be split." Critical splitting comes
 * before healing, Normal after normal buffing, Idle only when idle.
 *
 * What a split is, in the server's data (ACE world CraftTable, recipes
 * 1678-1752): the Splitting Tool (weenie 8283) used on a pea makes 20 or 50 of
 * one spell component and uses up the pea; no skill, so it never fails. Every
 * one of the 75 pea recipes names its component by the pea's name less " Pea":
 * "Gold Pea" makes Gold Scarab, "Ashwood Pea" Ashwood Talisman, "Powdered
 * Bloodstone Pea" Powdered Bloodstone, "Yellow Pea" Yellow Taper. No other
 * component starts with the same words, so the item names the client already
 * shows are enough to pair them. Peas arrived with Hollow Victory (Oct 2000):
 * a 1999 character carries none, and nothing here happens.
 *
 * A Consumables entry may be the component ("Gold Scarab") or the pea itself
 * ("Gold Pea", what Add All Peas adds); either keeps that component supplied.
 */
import { vtOption, vtStoredValue } from '@ac/shared';

/** The tool a player uses on a pea to split it (ACE world weenie 8283). */
export const SPLITTING_TOOL = 'Splitting Tool';
const PEA_SUFFIX = ' Pea';

export interface PeaItem {
  guid: number;
  name: string;
  stack?: number;
  /** The item-type label, when known ('Spell Components' for peas and components). */
  type?: string;
  where?: string;
}

export type SplitTier = 'critical' | 'normal' | 'idle';

export interface PeaSplit {
  tool: PeaItem;
  pea: PeaItem;
  /** The component it keeps supplied (the listed name, or the pea's stem when the pea is listed). */
  component: string;
  have: number;
  min: number;
  why: string;
}

const lc = (s: string): string => s.trim().toLowerCase();

/** A pea: a spell component named "<stem> Pea". */
export function isPea(it: { name: string; type?: string }): boolean {
  return it.name.endsWith(PEA_SUFFIX) && it.name.length > PEA_SUFFIX.length && (it.type === undefined || it.type === 'Spell Components');
}

/** "Gold Pea" → "Gold". */
export function peaStem(peaName: string): string {
  return peaName.endsWith(PEA_SUFFIX) ? peaName.slice(0, -PEA_SUFFIX.length) : peaName;
}

/** Whether splitting this pea makes this component (the component's name begins with the pea's stem as whole words). */
export function peaMakes(peaName: string, component: string): boolean {
  const stem = lc(peaStem(peaName));
  const c = lc(component);
  return !!stem && (c === stem || c.startsWith(`${stem} `));
}

/** Add All Peas: every pea you carry, by name, that the list doesn't hold yet (in pack order). */
export function addAllPeas(listed: readonly string[], inventory: ReadonlyArray<Pick<PeaItem, 'name' | 'type' | 'where'>>): string[] {
  const have = new Set(listed.map(lc));
  const out: string[] = [];
  for (const it of inventory) {
    if (it.where === 'equipped' || !isPea(it) || have.has(lc(it.name))) continue;
    have.add(lc(it.name));
    out.push(it.name);
  }
  return out;
}

function setting(settings: Record<string, string | number | boolean>, name: string): string | number | boolean {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(settings)) if (k.toLowerCase() === want || vtOption(k)?.name.toLowerCase() === want) return vtStoredValue(name, v);
  return vtOption(name)!.default;
}

const MIN_FOR: Record<SplitTier, string> = { critical: 'SpellCompMin-Critical', normal: 'SpellCompMin-Normal', idle: 'SpellCompMin-Idle' };

/**
 * The split to make now at this tier, or null: the first Consumables entry
 * whose component you carry fewer of than the tier's minimum, when you carry a
 * pea that makes it and a Splitting Tool.
 */
export function planPeaSplit(input: {
  inventory: readonly PeaItem[];
  /** The Consumables tab's names. */
  listed: readonly string[];
  settings: Record<string, string | number | boolean>;
  tier: SplitTier;
}): PeaSplit | null {
  if (setting(input.settings, 'SplitPeas') !== true) return null;
  const minName = MIN_FOR[input.tier];
  const min = Number(setting(input.settings, minName));
  if (!(min > 0)) return null;
  const carried = input.inventory.filter((i) => i.where !== 'equipped');
  const tool = carried.find((i) => lc(i.name) === lc(SPLITTING_TOOL));
  if (!tool) return null;
  const peas = carried.filter(isPea);
  if (!peas.length) return null;
  const seen = new Set<string>();
  for (const entry of input.listed) {
    const key = lc(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    const listedPea = isPea({ name: entry });
    // A listed pea keeps its own component supplied: whatever component it makes (its stem's words).
    const makes = (pea: string, comp: string): boolean => (listedPea ? lc(pea) === key && peaMakes(pea, comp) : peaMakes(pea, comp) && lc(comp) === key);
    const pea = peas.find((p) => (listedPea ? lc(p.name) === key : peaMakes(p.name, entry)));
    if (!pea) continue;
    const have = carried.filter((i) => !isPea(i) && (i.type === undefined || i.type === 'Spell Components') && makes(pea.name, i.name)).reduce((n, i) => n + (i.stack ?? 1), 0);
    if (have >= min) continue;
    const component = listedPea ? peaStem(pea.name) : entry;
    return { tool, pea, component, have, min, why: `${component}: ${have} < ${min} (${minName}), splitting ${pea.name}` };
  }
  return null;
}
