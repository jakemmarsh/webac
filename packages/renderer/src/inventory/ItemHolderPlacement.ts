/**
 * SWEEP1006B placement — retail's one path for putting an object into a
 * container, as the decompiled client (reference/client-eol, build
 * ac1_sep13) runs it for every pick-up, unwield and pack drop:
 *
 *   CPlayerSystem::PlaceInBackpack @ 0055d8c0
 *     → AttemptToPlaceInContainer(item, player, mOpenContainerID (or the
 *       player when MainPackPreferred), autoMerge = 1, placement = 0)
 *   UIElement_ItemList::AcceptDragObject @ 004e4250
 *     → AttemptMerge(item, cell item, quiet), else
 *       AttemptToPlaceInContainer(item, list container | the cell's pack,
 *       0, autoMerge = cell is a pack, placement = the cell's index)
 *
 *   ItemHolder::AttemptToPlaceInContainer @ 00588140 (decomp :377084)
 *     1. a requested container that is not a holder (bitfield & 1, or the
 *        player), is the item itself, is being traded or fails
 *        CheckHookStatus becomes 0;
 *     2. autoMerge → AttemptAutoMerge(item, holder, requested);
 *     3. the first of requested → holder → each of the holder's packs that
 *        WillItemFitInContainer gets UIAttemptPutInContainer (or
 *        UIAttemptSplitToContainer for a partial split);
 *     4. none fits → a 0x1a line built from the HOLDER's name, nothing sent:
 *        holder IsPlayer (vtable +0x10) → '%s is completely full!' /
 *        '%s can carry no more containers!'; else 'The %s is completely
 *        full!' / 'The %s can fit no more containers!' (acclient.exe .rdata
 *        0x7e2848 / 0x7e2878 / 0x7e27c8 / 0x7e2800, picked by
 *        IsContainer(item) — disassembly 5882c1..588377).
 *   ItemHolder::AttemptAutoMerge @ 00587c40 (:376779) — a stackable merges
 *     into the first legal stack of the holder's exhaustive list (its own
 *     items, then each pack's items: ACCWeenieObject::
 *     GetExhaustiveContainedItemsList @ 0058bf10) whose room is at least
 *     GenItemHolder::splitSize, through AttemptMerge @ 005878f0 (amount =
 *     the split size for the selected object, else its whole stack, capped
 *     at the room).
 *   ItemHolder::WillItemFitInContainer @ 00587d60 (:376835) — a full
 *     container (capacity != -1 and count >= capacity) still "fits" an
 *     object already inside it, and for a non-container only when the split
 *     is the whole stack.
 *
 * ACE never merges on PutItemInContainer and refuses a full side pack
 * (Player_Inventory.cs:1320 "Unable to put X into container"), so the
 * client has to make both decisions, as retail did.
 *
 * House hooks: ItemHolder::CheckHookStatus @ 00586e90 (:376138) gates
 *   _IsContainerLegal, WillItemFitInContainer and AttemptToPlaceInContainer's
 *   requested container, and gmExternalContainerUI::DragItemAcceptable
 *   @ 004cbb60 (:197399) — a hook only takes items while its house is owned
 *   and the item's hook type / ITEM_TYPE match the hook's.
 *
 * Not ported (ACE enforces the same refusals server-side; it needs the
 * stuck bit, ownership and location): the head gate
 * AttemptToPlaceInContainer_IsItemLegal @ 005870c0. Nor
 * IsDragIntoContainerAttemptLegal @ 00587e90 (:376924), which only decides
 * AcceptDragObject's pending placeholder cell.
 */

/** The PublicWeenieDesc / ACCWeenieObject slice the placement reads. */
export interface PlacementObject {
  id: number;
  name: string;
  weenieClassId: number;
  /** pwd._stackSize (0 → 1). */
  stackSize: number;
  /** pwd._maxStackSize (merges need > 1). */
  maxStackSize: number;
  /** pwd._itemsCapacity (-1 = unlimited, 0 = holds no items). */
  itemsCapacity: number;
  /** pwd._containersCapacity. */
  containersCapacity: number;
  /** ACCWeenieObject::IsContainer @ 004a4530 (RequiresPackSlot or a capacity). */
  isContainer: boolean;
  /** pwd._bitfield & 1 — a holder (Openable). The player is always one. */
  holder: boolean;
  /** tradeState == 1. */
  inTrade: boolean;
  /** vtable +0x10 ACCWeenieObject::IsPlayer. */
  isPlayer: boolean;
  /** pwd._hook_type (HookType, PropertyInt 151): a hook's accepted mounts, an item's mount kinds. 0/absent = none. */
  hookType?: number;
  /** pwd._hook_item_types (PropertyInt 152): the ITEM_TYPE mask a hook accepts. 0/absent = not a hook. */
  hookItemTypes?: number;
  /** pwd._house_owner_iid: the owner of the hook's house (0/absent = unowned). */
  houseOwnerId?: number;
  /** ITEM_TYPE (vtable +0x18, pwd._type). */
  itemType?: number;
}

export interface PlacementWorld {
  playerId: number;
  object(id: number): PlacementObject | undefined;
  /** CObjectInventory._itemsList — the non-container objects directly inside. */
  itemsOf(holderId: number): readonly number[];
  /** CObjectInventory._containersList — the packs directly inside. */
  containersOf(holderId: number): readonly number[];
  /** GenItemHolder::splitSize / maxSplitSize (the toolbar split). */
  splitSize: number;
  maxSplitSize: number;
  /** ItemHolder::GetObjectSplitSize — the amount a merge of `id` carries. */
  objectSplitSize(id: number): number;
  /** The amount and whether it is a partial split, for the put/split choice. */
  dragSplit(id: number): { amount: number; partial: boolean };
}

export type PlacementResult =
  /** UIAttemptMerge → StackableMerge(item, target, amount). */
  | { kind: 'merge'; targetId: number; amount: number }
  /** UIAttemptPutInContainer → PutItemInContainer(item, container, placement). */
  | { kind: 'put'; containerId: number; placement: number }
  /** UIAttemptSplitToContainer → StackableSplitToContainer(item, container, placement, amount). */
  | { kind: 'split'; containerId: number; placement: number; amount: number }
  /** Nothing sent; `notice` is the 0x1a line (absent = silent). */
  | { kind: 'refused'; notice?: string };

/**
 * ItemHolder::CheckHookStatus(item, ground, &noOwner) @ 00586e90 (:376138).
 * Either missing → refused. A ground object that is not a hook (hook_type 0
 * or hook_item_types 0) → ok. An unowned hook → refused with noOwner. Else
 * the item's hook_type must overlap the hook's and its ITEM_TYPE be in
 * hook_item_types.
 */
export function checkHookStatus(
  item: PlacementObject | undefined, ground: PlacementObject | undefined,
): { ok: boolean; noOwner: boolean } {
  if (!item || !ground) return { ok: false, noOwner: false };
  const hookType = ground.hookType ?? 0;
  const hookItemTypes = ground.hookItemTypes ?? 0;
  if (hookType === 0 || hookItemTypes === 0) return { ok: true, noOwner: false };
  if ((ground.houseOwnerId ?? 0) === 0) return { ok: false, noOwner: true };
  const itemHook = item.hookType ?? 0;
  if (itemHook !== 0 && (hookType & itemHook) !== 0) {
    return { ok: ((item.itemType ?? 0) & hookItemTypes) !== 0, noOwner: false };
  }
  return { ok: false, noOwner: false };
}

/**
 * gmExternalContainerUI::DragItemAcceptable @ 004cbb60 (:197399): no ground
 * object, or one the client does not know → true; an unknown item → false;
 * else CheckHookStatus.
 */
export function externalContainerDragAcceptable(
  groundObjectId: number, ground: PlacementObject | undefined, item: PlacementObject | undefined,
): boolean {
  if (groundObjectId === 0 || !ground) return true;
  if (!item) return false;
  return checkHookStatus(item, ground).ok;
}

/** _IsContainerLegal's 0x1a lines (acclient.exe .rdata 0x7e2778 / 0x7e2720 / 0x7e237c / 0x7e26f0 / 0x7e26a0 / 0x7e2640, UTF-16). */
export const CONTAINER_LEGAL_STRINGS = {
  invalid: 'The destination container is not valid!',
  withinItself: 'You cannot place an object within itself!',
  locked: 'The %s is locked',
  traded: 'The %s is being traded',
  hook: 'That item cannot be placed on the hook.',
  /** sprintf_append'ed to `hook` when CheckHookStatus reports no owner (disassembly 587bcd..587be4). */
  hookNoOwner: ' You must own the house to manipulate the hook.',
} as const;

/**
 * ItemHolder::AttemptToPlaceInContainer_IsContainerLegal(item, container,
 * quiet) @ 005879b0 (:376674). `notice` is the 0x1a line (never when quiet).
 * Order: unknown container, the item itself, not a holder (bitfield & 1,
 * unless the player) → "The %s is locked", being traded, CheckHookStatus.
 */
export function isContainerLegal(
  itemId: number, containerId: number, quiet: boolean, w: PlacementWorld,
): { ok: boolean; notice?: string } {
  const c = w.object(containerId);
  const no = (notice: string) => (quiet ? { ok: false } : { ok: false, notice });
  if (!c) return no(CONTAINER_LEGAL_STRINGS.invalid);
  if (itemId === containerId) return no(CONTAINER_LEGAL_STRINGS.withinItself);
  if (!validHolder(c, containerId, w)) return no(CONTAINER_LEGAL_STRINGS.locked.replace('%s', c.name));
  if (c.inTrade) return no(CONTAINER_LEGAL_STRINGS.traded.replace('%s', c.name));
  const hook = checkHookStatus(w.object(itemId), c);
  if (hook.ok) return { ok: true };
  return no(CONTAINER_LEGAL_STRINGS.hook + (hook.noOwner ? CONTAINER_LEGAL_STRINGS.hookNoOwner : ''));
}

/** ItemHolder::IsMergeAttemptLegal @ 00586f30, quiet (param_3 = 1). */
export function isMergeLegalQuiet(item: PlacementObject | undefined, target: PlacementObject | undefined): boolean {
  if (!item || !target || item.id === target.id) return false;
  if (!(item.maxStackSize > 1) || !(target.maxStackSize > 1)) return false;
  if (item.inTrade || target.inTrade) return false;
  if (item.weenieClassId !== target.weenieClassId) return false;
  return target.stackSize < target.maxStackSize;
}

/** ItemHolder::AttemptMerge @ 005878f0's amount: GetObjectSplitSize capped at the room. */
export function attemptMergeAmount(itemId: number, target: PlacementObject, w: PlacementWorld): number {
  const send = Math.max(1, Math.floor(w.objectSplitSize(itemId)) || 1);
  const room = target.maxStackSize - Math.max(1, target.stackSize);
  return Math.max(0, Math.min(send, room));
}

/** ItemHolder::AttemptMerge(item, target, quiet): the merge, or null when it is not legal. */
export function attemptMerge(itemId: number, targetId: number, w: PlacementWorld): PlacementResult | null {
  const target = w.object(targetId);
  if (!isMergeLegalQuiet(w.object(itemId), target)) return null;
  return { kind: 'merge', targetId, amount: attemptMergeAmount(itemId, target!, w) };
}

/** ACCWeenieObject::GetExhaustiveContainedItemsList @ 0058bf10. */
export function exhaustiveContainedItems(holderId: number, w: PlacementWorld): number[] {
  const out = [...w.itemsOf(holderId)];
  for (const pack of w.containersOf(holderId)) out.push(...w.itemsOf(pack));
  return out;
}

/** ItemHolder::AttemptAutoMerge @ 00587c40. */
export function attemptAutoMerge(itemId: number, holderId: number, w: PlacementWorld): PlacementResult | null {
  const item = w.object(itemId);
  if (!item || !w.object(holderId) || !(item.maxStackSize > 1)) return null;
  for (const id of exhaustiveContainedItems(holderId, w)) {
    if (id === itemId) continue;
    const target = w.object(id);
    if (!target || !isMergeLegalQuiet(item, target)) continue;
    if (w.splitSize <= target.maxStackSize - Math.max(1, target.stackSize)) {
      return { kind: 'merge', targetId: id, amount: attemptMergeAmount(itemId, target, w) };
    }
  }
  return null;
}

/** A holder the placement may target: a holder bit, or the player. */
function validHolder(o: PlacementObject | undefined, id: number, w: PlacementWorld): boolean {
  return !!o && (o.holder || id === w.playerId);
}

/** ItemHolder::WillItemFitInContainer @ 00587d60. */
export function willItemFitInContainer(itemId: number, targetId: number, w: PlacementWorld): boolean {
  const target = w.object(targetId);
  if (!target || itemId === targetId) return false;
  if (!validHolder(target, targetId, w)) return false;
  if (target.inTrade) return false;
  const item = w.object(itemId);
  if (!checkHookStatus(item, target).ok) return false;
  if (!item) return false;
  if (!item.isContainer) {
    const cap = target.itemsCapacity;
    if (cap !== -1 && cap <= w.itemsOf(targetId).length) {
      if (w.splitSize !== w.maxSplitSize) return false;
      return w.itemsOf(targetId).includes(itemId);
    }
    return true;
  }
  const cap = target.containersCapacity;
  if (cap !== -1 && cap <= w.containersOf(targetId).length) {
    return w.containersOf(targetId).includes(itemId);
  }
  return true;
}

/** The four "full" 0x1a lines (acclient.exe .rdata, UTF-16). */
export const PLACEMENT_FULL_STRINGS = {
  playerItems: '%s is completely full!',
  playerContainers: '%s can carry no more containers!',
  items: 'The %s is completely full!',
  containers: 'The %s can fit no more containers!',
} as const;

/** AttemptToPlaceInContainer's no-room line for `holder`. */
export function placementFullNotice(holder: PlacementObject, itemIsContainer: boolean): string {
  const fmt = holder.isPlayer
    ? (itemIsContainer ? PLACEMENT_FULL_STRINGS.playerContainers : PLACEMENT_FULL_STRINGS.playerItems)
    : (itemIsContainer ? PLACEMENT_FULL_STRINGS.containers : PLACEMENT_FULL_STRINGS.items);
  return fmt.replace('%s', holder.name);
}

/**
 * ItemHolder::AttemptToPlaceInContainer(item, holder, requested, autoMerge,
 * placement) @ 00588140 — after the readiness gate, which the caller runs
 * (and _IsItemLegal, not ported), then _IsContainerLegal(item, holder).
 */
export function attemptToPlaceInContainer(
  itemId: number, holderId: number, requestedId: number, autoMerge: boolean, placement: number, w: PlacementWorld,
): PlacementResult {
  const legal = isContainerLegal(itemId, holderId, false, w);
  if (!legal.ok) return { kind: 'refused', notice: legal.notice };
  const requested = w.object(requestedId);
  let preferred = requestedId;
  if (!requested || itemId === requestedId || !validHolder(requested, requestedId, w) || requested.inTrade
    || !checkHookStatus(w.object(itemId), requested).ok) preferred = 0;
  if (autoMerge) {
    const merge = attemptAutoMerge(itemId, holderId, w);
    if (merge) return merge;
  }
  const item = w.object(itemId);
  const holder = w.object(holderId);
  if (!item || !holder) return { kind: 'refused' };
  let dest = 0;
  if (preferred && willItemFitInContainer(itemId, preferred, w)) dest = preferred;
  else if (willItemFitInContainer(itemId, holderId, w)) dest = holderId;
  else dest = w.containersOf(holderId).find((pack) => willItemFitInContainer(itemId, pack, w)) ?? 0;
  if (!dest) return { kind: 'refused', notice: placementFullNotice(holder, item.isContainer) };
  const split = w.dragSplit(itemId);
  if (split.partial) return { kind: 'split', containerId: dest, placement, amount: split.amount };
  return { kind: 'put', containerId: dest, placement };
}

/**
 * CPlayerSystem::PlaceInBackpack @ 0055d8c0: the shown pack, or the player
 * when MainPackPreferred is on (or none is shown), auto-merge on, placement 0.
 */
export function placeInBackpack(
  itemId: number, shownPackId: number, mainPackPreferred: boolean, w: PlacementWorld,
): PlacementResult {
  const requested = mainPackPreferred || !shownPackId ? w.playerId : shownPackId;
  return attemptToPlaceInContainer(itemId, w.playerId, requested, true, 0, w);
}

/** acclient.exe .rdata 0x7bfd04 / 0x7bfd88 / 0x7bfdd0 — AcceptDragObject's refusals. */
export const ITEM_LIST_DROP_STRINGS = {
  cannotAcceptItems: 'The %s cannot accept items',
  containerInItemList: 'Cannot place container in item list',
  itemInContainerList: 'Cannot place item in container list',
} as const;

export interface ItemListDrop {
  itemId: number;
  /** The object in the cell under the mouse (0 = an empty cell). */
  cellItemId: number;
  /** UIElement_ItemList::parentContainerID — the pack the list shows. */
  listContainerId: number;
  /** The placement for a drop into the list's own container (the cell's slot). */
  cellPlacement: number;
  /** The list is the pack strip (containerList) rather than the item grid. */
  containerList: boolean;
}

/**
 * UIElement_ItemList::AcceptDragObject @ 004e4250 (decomp :219367): merge
 * onto the cell's stack, else into the cell's pack (auto-merge on) or the
 * list's container at the cell, through AttemptToPlaceInContainer with no
 * preferred container — so a full main pack falls back to the side packs,
 * and a full side pack refuses with its "The %s is completely full!".
 */
export function acceptItemListDrop(d: ItemListDrop, w: PlacementWorld): PlacementResult {
  const item = w.object(d.itemId);
  if (!item) return { kind: 'refused' };
  const draggingContainer = item.isContainer;
  if (!d.containerList && draggingContainer) return { kind: 'refused', notice: ITEM_LIST_DROP_STRINGS.containerInItemList };
  if (d.containerList && !draggingContainer && d.cellItemId === 0) return { kind: 'refused', notice: ITEM_LIST_DROP_STRINGS.itemInContainerList };
  if (d.cellItemId) {
    const merge = attemptMerge(d.itemId, d.cellItemId, w);
    if (merge) return merge;
  }
  let dest = d.listContainerId;
  let autoMerge = false;
  const cell = d.cellItemId ? w.object(d.cellItemId) : undefined;
  if (cell) {
    if (!draggingContainer) {
      if (cell.itemsCapacity !== 0) { dest = d.cellItemId; autoMerge = true; }
      else if (cell.isContainer) return { kind: 'refused', notice: ITEM_LIST_DROP_STRINGS.cannotAcceptItems.replace('%s', cell.name) };
    } else if (cell.containersCapacity !== 0) {
      dest = d.cellItemId;
    }
  }
  if (!dest) return { kind: 'refused' };
  return attemptToPlaceInContainer(d.itemId, dest, 0, autoMerge, dest === d.listContainerId ? d.cellPlacement : 0, w);
}
