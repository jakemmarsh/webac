/**
 * VirindiTank's CombineSalvage bands: which salvage bags of one material may
 * be merged, from a VTClassic loot profile's SalvageCombine block.
 *
 * Facts from VTClassic's UTLBlock_SalvageCombine.cs (MIT, Virindi's public
 * repository; docs/vtank-formats.md §3.5) and openac-mosstank's
 * SalvageBagCombinePlanner (read for facts only, no code copied):
 * - the defaults: "1-6, 7-8, 9, 10" for every material, "1-10" for the
 *   imbue, weapon- and armour-tinkering materials and Leather / Ivory;
 * - a bag's band: the first range whose start is above its workmanship ends
 *   the search and the bag joins the range before it (a gap goes with the
 *   range below it); past the last range is a band of its own.
 */
import type { SalvageCombine } from './RoutineDoc.js';

/**
 * VTClassic's materials with the "1-10" band (any workmanship combines), by ACE MaterialType:
 * Agate, Azurite, Black Opal, Bloodstone, Carnelian, Citrine, Fire Opal, Hematite, Lavender Jade,
 * Malachite, Red Jade, Rose Quartz, Sunstone (magic item tinkering); White Sapphire, Red Garnet, Jet,
 * Imperial Topaz, Emerald, Black Garnet, Aquamarine (weapon tinkering); Zircon, Yellow Topaz, Peridot
 * (armour tinkering); Leather, Ivory. The same 25 ids every corpus .utl's block lists.
 */
export const SALVAGE_COMBINE_ANY_WORKMANSHIP = [10, 14, 16, 17, 18, 19, 22, 25, 29, 30, 36, 37, 41, 47, 35, 27, 26, 21, 15, 13, 50, 49, 34, 52, 51] as const;

/** A new VTClassic profile's SalvageCombine block (the UTLBlock_SalvageCombine constructor). */
export const SALVAGE_COMBINE_DEFAULTS: SalvageCombine = Object.freeze({
  default: '1-6, 7-8, 9, 10',
  materials: Object.freeze(Object.fromEntries(SALVAGE_COMBINE_ANY_WORKMANSHIP.map((m) => [String(m), '1-10']))) as Record<string, string>,
}) as SalvageCombine;

/** A band string's ranges, in order ("1-6, 7-8, 9, 10" → [1,6] [7,8] [9,9] [10,10]); unreadable pieces are skipped. */
export function parseSalvageBands(text: string | undefined): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const tok of (text ?? '').split(/[,;]/)) {
    const parts = tok.split('-').map((x) => x.trim()).filter((x) => x !== '');
    if (!parts.length) continue;
    const a = Number(parts[0]);
    if (!Number.isFinite(a)) continue;
    const b = parts.length > 1 ? Number(parts[1]) : a;
    out.push([a, Number.isFinite(b) ? b : a]);
  }
  return out;
}

/** Which band a workmanship falls in (VTClassic GetRangeIndex): -1 below the first range, ranges.length past the last. */
export function salvageBandIndex(bands: Array<[number, number]>, workmanship: number): number {
  for (let i = 0; i < bands.length; i++) {
    if (bands[i][0] > workmanship) return i - 1;
    if (bands[i][0] <= workmanship && bands[i][1] >= workmanship) return i;
  }
  return bands.length;
}

/** The band string for a material: its own, else the block's default. */
export function salvageBandsFor(settings: SalvageCombine, material: number): string {
  return settings.materials?.[String(material)] ?? settings.default;
}
