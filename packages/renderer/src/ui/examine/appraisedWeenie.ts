/**
 * The examined object's own weenie fields, for the item page
 * (BUG.ac1999-appraisal-details). Retail reads them off the object's
 * PublicWeenieDesc (ACCWeenieObject get_valid_locations / get_ammoType /
 * get_location …), wherever the client holds it. Ours are spread over:
 *  - the world object (ServerObjectManager): no valid locations of its own;
 *  - the item in our packs or worn (inventory / equipment rows);
 *  - the world object's CreateObject record (WorldObjectRecords.sourceOf),
 *    which keeps the valid locations the world object lacks;
 *  - the open vendor's merchandise row: a shop ware is none of the above.
 * Before this, a shop ware had no source at all and a ground item had no
 * valid locations, so the weapon / armor / ammunition sections, which are gated
 * on them, came out empty (a vendor's Yumi showed only Value and Burden).
 *
 * Each field is the first non-zero value across the sources, in the order given.
 */
import type { AppraisedWeenieInfo } from './ItemAppraisalText.js';

type Source = object | null | undefined | false;

function num(o: object, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = (o as Record<string, unknown>)[k];
    if (typeof v === 'number') return v;
  }
  return undefined;
}

export function resolveAppraisedWeenie(sources: readonly Source[], isHooked: boolean): AppraisedWeenieInfo | undefined {
  const present = sources.filter((s): s is object => !!s);
  if (!present.length) return undefined;
  const first = (...keys: string[]): number | undefined => {
    let fallback: number | undefined;
    for (const s of present) {
      const v = num(s, ...keys);
      if (v === undefined) continue;
      if (v !== 0) return v;
      fallback ??= v;
    }
    return fallback;
  };
  return {
    validLocations: first('validLocations'),
    ammoType: first('ammoType'),
    priority: first('clothingPriority', 'priority'),
    objectDescriptionFlags: first('objectDescFlags', 'objectDescriptionFlags'),
    itemsCapacity: first('itemsCapacity'),
    containersCapacity: first('containersCapacity'),
    location: first('wieldedLocation', 'currentWieldedLocation', 'slot', 'location'),
    // ACE AppraiseInfo.cs:290 builds a HookProfile only for a hook holding an item — the weenie's IsHooked (vtable +0x74).
    isHooked,
  };
}
