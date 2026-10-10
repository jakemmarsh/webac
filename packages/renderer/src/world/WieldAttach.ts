/**
 * Which held items another creature's model carries — the attach decisions
 * main.ts makes when a CreateObject lands (BUG.object-blobs-dropped-before-
 * create follow-up; FAITHFUL.574).
 *
 * SmartBox::HandleCreateObject @ 00454c80 parents a new object by its
 * PhysicsDesc Parent block alone (PhysicsDesc::get_parent_id +
 * get_parent_location_id → DoParentEvent / set_parent). ACE writes that
 * block exactly when the item has a ParentLocation (WorldObject_Networking.cs
 * `WielderId != null && ParentLocation != null`); a weenie Wielder without
 * it (worn armour, jewellery) is not drawn in a hand. Pre-fix an EquipMask
 * fallback attached by the weenie Wielder.
 */

/** The parent fields of a CreateObject. */
export interface ParentDesc {
  guid: number;
  physicsParentId?: number;
  parentLocation: number;
}

/** A held item's record, as the creature's own create scans for it. */
export interface HeldRecord {
  guid: number;
  wielderId: number;
  parentLocation: number;
}

/** The (holder, location) an item's create attaches it at, or null (no Parent block / our own character's item). */
export function attachOnItemCreate(data: ParentDesc, ownGuid: number | null): { holder: number; location: number } | null {
  const holder = data.physicsParentId ?? 0;
  if (!holder || holder === ownGuid || !data.parentLocation) return null;
  return { holder, location: data.parentLocation };
}

/** The items a creature's create attaches: records parented to it (the item arrived first). */
export function heldItemsOf(holderGuid: number, records: Iterable<HeldRecord>): Array<{ item: number; location: number }> {
  const out: Array<{ item: number; location: number }> = [];
  for (const r of records) if (r.wielderId === holderGuid && r.parentLocation) out.push({ item: r.guid, location: r.parentLocation });
  return out;
}
