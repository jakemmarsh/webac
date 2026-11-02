/**
 * BUG.ac1999-placement-item-not-valid — what the placement port (ItemHolderPlacement) reads of an
 * object the client knows from a server record, not from our pack or paperdoll.
 *
 * Retail looks the item up in its one object table (1999 ObjMgr_GetWeenieObjectById, end of
 * retail CObjectMaint::GetWeenieObject), which holds every object the server created and has not
 * deleted, wherever it is: in the world, in an open corpse or chest, carried. The 1999
 * ItemHolder_AttemptPlaceInContainerIsLegal @ 0x004e57b0 refuses an object missing from it out
 * loud ("The item to be placed in the %s is not valid"), so ours must miss only what retail
 * would. The client keeps that table in three parts: the world records (ServerObjectManager), the
 * kept CreateObject of each movable world object (WorldObjectRecords, for the pick-up) and the
 * CreateObject of every object created without a world record (NonWorldObjectRecords: an open
 * container's contents, our own pack). The third was never read here, so an object known only
 * by it (a Stuck or creature-typed object in a chest; anything a world record was dropped for)
 * read as unknown.
 */
import { ObjectDescriptionFlag } from '@ac/shared';
import type { PlacementObject } from './ItemHolderPlacement.js';

/** The PublicWeenieDesc / PhysicsDesc slice a placement reads off one server record. */
export interface PlacementRecord {
  name?: string;
  weenieClassId?: number;
  stackSize?: number;
  maxStackSize?: number;
  itemsCapacity?: number;
  containersCapacity?: number;
  objectDescFlags?: number;
  itemType?: number;
  hookType?: number;
  hookItemTypes?: number;
  houseOwnerId?: number;
  /** The holder wielding it (0 = none). */
  wielderId?: number;
  /** pwd._location: the wielded slot (0 = not wielded). */
  wieldedLocation?: number;
  /** pwd._containerID (0 = in no container). */
  containerId?: number;
}

/**
 * The placement's view of an object from its server records, the world record first, then the
 * kept world CreateObject, then the CreateObject of an object created without a world record.
 * Undefined only when none holds it (an object the server never created, or deleted).
 */
export function placementObjectFromRecords(
  id: number,
  records: { world?: PlacementRecord | null; kept?: PlacementRecord | null; created?: PlacementRecord | null },
  ctx: { inTrade: boolean; inOpenContainer: boolean },
): PlacementObject | undefined {
  const o = records.world ?? undefined;
  const src = records.kept ?? undefined;
  const made = records.created ?? undefined;
  if (!o && !src && !made) return undefined;
  const pick = <K extends keyof PlacementRecord>(k: K): PlacementRecord[K] => o?.[k] ?? src?.[k] ?? made?.[k];
  const flags = pick('objectDescFlags') ?? 0;
  const itemsCapacity = pick('itemsCapacity') ?? 0;
  // The world record's own fields (a hook's, a wielded object's); the created record stands in for it.
  const body = o ?? made;
  const containersCapacity = body?.containersCapacity ?? 0;
  return {
    id, name: pick('name') ?? '', weenieClassId: pick('weenieClassId') ?? 0,
    stackSize: pick('stackSize') ?? 0, maxStackSize: pick('maxStackSize') ?? 0,
    itemsCapacity, containersCapacity,
    isContainer: (flags & 0x800000) !== 0 || itemsCapacity !== 0 || containersCapacity !== 0,
    holder: (flags & ObjectDescriptionFlag.Openable) !== 0, inTrade: ctx.inTrade,
    isPlayer: (flags & ObjectDescriptionFlag.Player) !== 0,
    // A housing hook's _hook_type / _hook_item_types / _house_owner_iid.
    hookType: pick('hookType') ?? 0, hookItemTypes: body?.hookItemTypes ?? 0,
    houseOwnerId: body?.houseOwnerId ?? 0, itemType: pick('itemType') ?? 0,
    // _IsItemLegal's inputs: BF_STUCK, in a container (the open ground container's contents, or
    // the container the created record names) or wielded, and the wielded slot.
    stuck: (flags & ObjectDescriptionFlag.Stuck) !== 0,
    contained: (body?.wielderId ?? 0) !== 0 || ctx.inOpenContainer || (!o && (made?.containerId ?? 0) !== 0),
    wieldedLocation: body?.wieldedLocation ?? 0,
  };
}
