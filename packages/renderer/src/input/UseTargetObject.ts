/**
 * BUG.use-with-blank-target-name (every era) — ClientObjMaintSystem::GetWeenieObject as
 * ItemHolder::TargetCompatibleWithObject @ 00587520 (the 1999 one @ 0x004e6630) reads a
 * use-with-target's target: the object's NAME_APPROPRIATE name (GetObjectNameWide(…, 2)), its
 * ITEM_TYPE, IsOwnedByPlayer and IsPlayer, from the one weenie the client keeps for it.
 *
 * Pre-fix each caller handed consumePendingUseWithTarget a name and an ItemType of its own, and
 * three of them fell back to '' / 0 for an object outside the 3D world and the pack: an item in
 * an open corpse or chest (kept with the open container, never in the ServerObjectManager), a
 * vendor's merchandise, a trade partner's item, or a fellow out of sight on the Fellowship panel.
 * A kit armed and then pressed on one printed "Cannot use the Healing Kit with the " (Coldeve,
 * 2026-11-24): step 5 failed on ItemType 0 and the name was blank.
 *
 * Retail starts the check with `GetWeenieObject(target) == 0 → return false` before any line:
 * an object the client does not know takes the use silently (TargetAcquired sends nothing). So
 * {@link resolveUseTarget} is the single lookup, every kind of known object answers it, and null
 * means exactly "retail has no weenie": nothing printed, nothing sent.
 */
import { getAppropriateName, ItemType, ObjectDescriptionFlag } from '@ac/shared';

/** One object as a lookup knows it (the PublicWeenieDesc fields the check reads). */
export interface UseTargetRecord {
  name: string;
  pluralName?: string;
  stackSize?: number;
  itemType?: number;
  objectDescFlags?: number;
}

export interface UseTargetSources {
  playerGuid: number;
  playerName: string;
  /** The player's own PublicWeenieDesc bitfield (Player set). */
  playerDescFlags?: number;
  /** An item the player owns (pack, side pack, wielded). */
  held(id: number): UseTargetRecord | null | undefined;
  /** Every other object the client keeps a weenie for, in lookup order (world, open container, records, trade, vendor). */
  others: ReadonlyArray<(id: number) => UseTargetRecord | null | undefined>;
}

export interface UseTargetObject {
  guid: number;
  /** GetObjectNameWide(…, NAME_APPROPRIATE = 2). */
  name: string;
  itemType: number;
  /** pwd._stackSize (0 = not sent). */
  stackSize: number;
  /** pwd._bitfield; undefined = the lookup that knew the object did not keep it. */
  objectDescFlags?: number;
  ownedByPlayer: boolean;
  isPlayer: boolean;
}

/** GetWeenieObject(id) for a use-with target; null = not known (retail: no line, nothing sent). */
export function resolveUseTarget(id: number, s: UseTargetSources): UseTargetObject | null {
  const guid = id >>> 0;
  if (guid === 0) return null;
  if (s.playerGuid && guid === s.playerGuid >>> 0) {
    // The player owns itself (IsOwnedByObject compares the id) and IsPlayer.
    return {
      guid, name: s.playerName, itemType: ItemType.Creature, stackSize: 0,
      objectDescFlags: ((s.playerDescFlags ?? 0) | ObjectDescriptionFlag.Player) >>> 0, ownedByPlayer: true, isPlayer: true,
    };
  }
  const held = s.held(guid);
  if (held) return fromRecord(guid, held, true);
  for (const look of s.others) {
    const r = look(guid);
    if (r) return fromRecord(guid, r, false);
  }
  return null;
}

function fromRecord(guid: number, r: UseTargetRecord, owned: boolean): UseTargetObject {
  const flags = r.objectDescFlags === undefined ? undefined : r.objectDescFlags >>> 0;
  return {
    guid,
    name: getAppropriateName(r.name, r.pluralName, r.stackSize),
    itemType: (r.itemType ?? 0) >>> 0,
    stackSize: r.stackSize ?? 0,
    objectDescFlags: flags,
    ownedByPlayer: owned,
    isPlayer: ((flags ?? 0) & ObjectDescriptionFlag.Player) !== 0,
  };
}
