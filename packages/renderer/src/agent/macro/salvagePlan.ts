/**
 * VirindiTank's salvaging (docs/vtank-parity-gaps.md §3.1): items a loot
 * rule took to Salvage go into the Ust, and with CombineSalvage (on by
 * default) partial bags of one material are put back through the Ust
 * together, which merges them (ACE Player_Crafting.HandleSalvaging: a salvage
 * bag salvaged with other bags of its material fills new bags).
 *
 * Facts from VTClassic's UTLBlock_SalvageCombine.cs (MIT; TryCombineMultiple)
 * and openac-mosstank (Looting.cs, SalvageBagCombinePlanner; read for facts
 * only, no code copied); server rules from ACE:
 * - the Ust: an item with ItemType TinkeringTool (0x20000000); ACE accepts
 *   only the Ust weenie (W_TINKERINGTOOL_CLASS 20646) the player owns;
 * - never salvaged: a tinkered item (PropertyInt NumTimesTinkered 171 > 0;
 *   VTank changelog 0.3.0.13), a Retained one (ACE skips it: ObjectDescription
 *   flag 0x01000000 / PropertyBool 91), one with no material or workmanship
 *   (ACE skips it), anything worn;
 * - combining: bags of one material (partial: under 100 units), binned by the
 *   profile's workmanship bands; the first band with two or more bags is
 *   combined. Normally its bags are taken in order until they hold 100 units
 *   (VTClassic's "maximum bags" mode); with a value mode for the material,
 *   the whole band once its bags are worth that much together, else the
 *   first two bags under 100 units together (VTClassic tries random pairs;
 *   MOSS the first such pair, as here, so a run is repeatable).
 */
import { parseSalvageBands, salvageBandIndex, salvageBandsFor, type SalvageCombine } from '@ac/shared';

/** ACE ItemType.TinkeringTool (the Ust) and TinkeringMaterial (salvage bags). */
export const ITEM_TYPE_TINKERING_TOOL = 0x20000000;
export const ITEM_TYPE_TINKERING_MATERIAL = 0x40000000;
/** ACE WeenieClassName.W_TINKERINGTOOL_CLASS: the only tool HandleSalvaging accepts (ToolIsValidUst). */
export const UST_WCID = 20646;
/** ObjectDescriptionFlag.Retained (the PublicWeenieDesc bitfield) and PropertyBool.Retained. */
export const RETAINED_FLAG = 0x01000000;
export const PROP_BOOL_RETAINED = 91;
/** PropertyInt.NumTimesTinkered. */
export const PROP_INT_NUM_TIMES_TINKERED = 171;
/** A full salvage bag's units (ACE TryAddSalvage: MaxStructure ?? 100). */
export const BAG_UNITS = 100;

export interface SalvageItem {
  guid: number;
  name: string;
  /** Worn or wielded. */
  equipped?: boolean;
  itemType?: number;
  wcid?: number;
  materialType?: number;
  /** Units in a salvage bag (PublicWeenieDesc structure). */
  structure?: number;
  /** PublicWeenieDesc workmanship: an item's, or a bag's average. */
  workmanship?: number;
  value?: number;
  objectDescFlags?: number;
}

/** The Ust you carry (a tinkering tool; the Ust weenie first), or undefined. */
export function findUst<T extends SalvageItem>(items: T[]): T | undefined {
  const tools = items.filter((i) => !i.equipped && ((i.itemType ?? 0) & ITEM_TYPE_TINKERING_TOOL) !== 0);
  return tools.find((i) => i.wcid === UST_WCID) ?? tools[0];
}

/**
 * Whether a carried item a Salvage rule took may go into the Ust: null when it may, else why not.
 * `props` is its appraisal (NumTimesTinkered and Retained are only known from one).
 */
export function salvageRefusal(item: SalvageItem, props: { int?: Record<number, number>; bool?: Record<number, boolean> } | null): string | null {
  if (item.equipped) return 'it is worn';
  if (!item.materialType) return 'it has no material';
  if (!item.workmanship) return 'it has no workmanship';
  if (((item.objectDescFlags ?? 0) & RETAINED_FLAG) !== 0 || props?.bool?.[PROP_BOOL_RETAINED]) return 'it is retained';
  if ((props?.int?.[PROP_INT_NUM_TIMES_TINKERED] ?? 0) > 0) return 'it has been tinkered';
  return null;
}

/** A partial salvage bag you carry: a TinkeringMaterial with a material, a workmanship and under 100 units. */
export function isPartialBag(i: SalvageItem): boolean {
  return !i.equipped && ((i.itemType ?? 0) & ITEM_TYPE_TINKERING_MATERIAL) !== 0 && /^salvage/i.test(i.name)
    && !!i.materialType && !!i.workmanship && (i.structure ?? 0) > 0 && (i.structure ?? 0) < BAG_UNITS;
}

export interface CombinePlan { guids: number[]; material: number; names: string[] }

/** The next bags to put through the Ust together, or null (nothing to combine). */
export function planSalvageCombine(items: SalvageItem[], settings: SalvageCombine, skip: ReadonlySet<number> = new Set()): CombinePlan | null {
  const bags = items.filter((i) => isPartialBag(i) && !skip.has(i.guid))
    .sort((a, b) => a.materialType! - b.materialType! || a.workmanship! - b.workmanship! || a.guid - b.guid);
  const byMaterial = new Map<number, SalvageItem[]>();
  for (const b of bags) { const l = byMaterial.get(b.materialType!); if (l) l.push(b); else byMaterial.set(b.materialType!, [b]); }
  for (const [material, list] of byMaterial) {
    const bands = parseSalvageBands(salvageBandsFor(settings, material));
    const bins = new Map<number, SalvageItem[]>();
    for (const b of list) { const k = salvageBandIndex(bands, b.workmanship!); const l = bins.get(k); if (l) l.push(b); else bins.set(k, [b]); }
    for (const k of [...bins.keys()].sort((x, y) => x - y)) {
      const bin = bins.get(k)!;
      if (bin.length < 2) continue;
      let chosen: SalvageItem[] = [];
      const target = settings.valueModes?.[String(material)];
      if (target !== undefined) {
        if (bin.reduce((t, b) => t + (b.value ?? 0), 0) >= target) chosen = bin;
        else {
          for (let x = 0; x < bin.length - 1 && !chosen.length; x++) for (let y = x + 1; y < bin.length; y++) {
            if ((bin[x].structure ?? 0) + (bin[y].structure ?? 0) < BAG_UNITS) { chosen = [bin[x], bin[y]]; break; }
          }
          if (!chosen.length) continue;
        }
      } else {
        let units = 0;
        for (const b of bin) { chosen.push(b); units += Math.max(0, b.structure ?? 0); if (units >= BAG_UNITS) break; }
      }
      if (chosen.length < 2) continue;
      return { guids: chosen.map((b) => b.guid), material, names: chosen.map((b) => b.name) };
    }
  }
  return null;
}
