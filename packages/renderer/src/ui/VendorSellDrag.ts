/**
 * CORE.17.k.b.b.c.c.a.a.c.a.a.a.a.a.a — VendorSellUI's drag / add rules
 * (decompiled EoL client + acclient.exe .rdata):
 *
 *  - `VendorProfile::InqAcceptability @ 005d1a90`(pwd): 1 unless the item's
 *    type shares a bit with the vendor's `item_types` and the bitfield has no
 *    Retained bit (0x01000000); the per-unit value (`_value / _stackSize`,
 *    unsigned) 0 → 2; `max_value != -1 && max_value < unit` → 4 — except a
 *    TYPE_PROMISSORY_NOTE (0x40000: `~(type >> 16) & 4` is 0), which passes;
 *    `min_value != -1 && unit < min_value` → 3; else 0. `IsAcceptable @
 *    005d1b50` is `InqAcceptability == 0`.
 *  - `DragItemAcceptable @ 004c20c0`(id, silent): the object must resolve;
 *    not `IsOwnedByPlayer` → the 0x1a notice "You can only sell items you are
 *    carrying" unless silent; `GetNumContainedItems > 0` → accepted (a pack
 *    with contents skips the vendor's profile); `InqAcceptability == 0` →
 *    accepted; otherwise, unless silent, 1 "That item cannot be sold here",
 *    2 "That item has no value and cannot be sold", 3 "That item is too cheap
 *    to sell here", 4 "That item is too valuable to sell here", any other
 *    "You cannot sell that here".
 *  - `OnItemListDragOver @ 004c2300`: DragItemAcceptable(id, true) → the
 *    hovered cell's 0x10000040, refused → 0x10000041 (an alias is ignored).
 *  - `AcceptDragObject @ 004c4f00` (the drop): DragItemAcceptable(id, false)
 *    or nothing; the toolbar's split state at its maximum
 *    (GenItemHolder::splitSize == maxSplitSize) → AddItemToSell(id);
 *    otherwise `ItemHolder::AttemptToPlaceInContainer`(id, player, the item's
 *    own container) — the split in place — failing → "Cannot split the stack
 *    to sell it" (false); succeeding → m_splitItemClassID (wcid) /
 *    m_splitItemStackSize (GetObjectSplitSize) are remembered, "Splitting the
 *    %s before selling them" (%s = GetObjectNameWide(NAME_APPROPRIATE)) is
 *    shown, the ORIGINAL goes through AddItemToSell and its cell becomes
 *    m_splitItem.
 *  - `AddItemToSell @ 004c4a20` → `gmVendorUI::AddItem @ 004c14b0`(sell list,
 *    id, pos -1, replace = 1, walk = 1, checkAcceptable = 0): an object
 *    already listed is deleted first (a re-drop moves it to the end); an
 *    object with no contained items and no contained containers is listed;
 *    with walk and contained items, the 0x1a notice "Selling contents of %s"
 *    and every GetContainedItemsList id through AddItem(replace = 1, walk =
 *    0, checkAcceptable = 1) — a content the vendor's profile refuses is
 *    skipped, a nested pack with contents is neither listed nor walked.
 *    (checkAcceptable also passes an object whose ACCWeenieObject vtable
 *    slot +0x10 answers non-zero; that slot is unresolved in the decomp and
 *    is taken as false here.)
 *  - `ItemAttributesChanged @ 004c3fd0`: with m_splitItem set, the object of
 *    that wcid whose stack size (0 → 1) equals the remembered size is listed
 *    at the original's position (if it holds no contents) and the original's
 *    cell is deleted — the split-off stack replaces the whole one.
 */

import { getAppropriateName, vendorSellRejectionReason, vendorBuyPrice, unitValueOf, type InventoryItem } from '@ac/shared';
import { uiItemDragAcceptState } from './UIItemDragAccept.js';

/** ITEM_TYPE::TYPE_CONTAINER. */
const TYPE_CONTAINER = 0x200;
/** ITEM_TYPE::TYPE_PROMISSORY_NOTE — exempt from the vendor's max_value. */
const TYPE_PROMISSORY_NOTE = 0x40000;
/** PublicWeenieDesc bitfield BF_RETAINED (ACE ObjectDescriptionFlag.Retained). */
const BF_RETAINED = 0x01000000;

/** The VendorProfile fields InqAcceptability reads (GameEventApproachVendor). */
export interface VendorSellProfile {
  /** item_types — MerchandiseItemTypes. */
  itemTypes: number;
  /** min_value — MerchandiseMinValue (-1 / 0xFFFFFFFF = no floor). */
  minValue: number;
  /** max_value — MerchandiseMaxValue (-1 / 0xFFFFFFFF = no ceiling). */
  maxValue: number;
}

/** What VendorSellUI asks ACCWeenieObject about a dragged object. */
export interface VendorSellDragItem {
  guid: number;
  name: string;
  pluralName?: string;
  weenieClassId: number;
  stackSize: number;
  itemType?: number;
  /** pwd._value — the whole stack's value. */
  value?: number;
  /** pwd._bitfield (ObjectDescriptionFlag). */
  objectDescFlags?: number;
  /** IsOwnedByPlayer (an inventory drag: true). */
  ownedByPlayer?: boolean;
  /** pwd._containerID — where a split in place lands (0: the player). */
  containerId?: number;
  /** GetContainedItemsList. */
  contents?: readonly VendorSellDragItem[];
}

export const VENDOR_SELL_STRINGS = {
  notCarrying: 'You can only sell items you are carrying',
  cannotSellHere: 'That item cannot be sold here',
  noValue: 'That item has no value and cannot be sold',
  tooCheap: 'That item is too cheap to sell here',
  tooValuable: 'That item is too valuable to sell here',
  cannotSell: 'You cannot sell that here',
  cannotSplit: 'Cannot split the stack to sell it',
} as const;

/**
 * gmVendorUI::HandleMousePresses @ 004c40d0 — a double-click on a Buying-
 * or Selling-list entry: "Removing %s from shopping list" (acclient.exe
 * 0x3b5a6c, the only such string) with GetObjectNameWide(NAME_APPROPRIATE).
 */
export function vendorRemovingFromListText(appropriateName: string): string {
  return `Removing ${appropriateName} from shopping list`;
}

/** InqAcceptability's result codes. */
export const VENDOR_ACCEPTABILITY = { ok: 0, wrongType: 1, noValue: 2, tooCheap: 3, tooValuable: 4 } as const;

/** VendorProfile::InqAcceptability @ 005d1a90. A missing profile refuses (1). */
export function vendorInqAcceptability(
  item: Pick<VendorSellDragItem, 'itemType' | 'value' | 'stackSize' | 'objectDescFlags'>,
  profile: VendorSellProfile | null,
): number {
  if (!profile) return VENDOR_ACCEPTABILITY.wrongType;
  const type = (item.itemType ?? 0) >>> 0;
  if ((type & (profile.itemTypes >>> 0)) === 0 || ((item.objectDescFlags ?? 0) & BF_RETAINED) !== 0) {
    return VENDOR_ACCEPTABILITY.wrongType;
  }
  const value = Math.max(0, Math.floor(item.value ?? 0)) >>> 0;
  const stack = Math.max(0, Math.floor(item.stackSize ?? 0)) >>> 0;
  const unit = stack !== 0 ? Math.floor(value / stack) : value;
  if (unit === 0) return VENDOR_ACCEPTABILITY.noValue;
  const max = profile.maxValue | 0;
  const min = profile.minValue | 0;
  if (max !== -1 && max < (unit | 0)) {
    return (type & TYPE_PROMISSORY_NOTE) !== 0 ? VENDOR_ACCEPTABILITY.ok : VENDOR_ACCEPTABILITY.tooValuable;
  }
  if (min !== -1 && (unit | 0) < min) return VENDOR_ACCEPTABILITY.tooCheap;
  return VENDOR_ACCEPTABILITY.ok;
}

/** DragItemAcceptable's refusal text for an InqAcceptability code. */
export function vendorAcceptabilityNotice(code: number): string {
  switch (code) {
    case VENDOR_ACCEPTABILITY.wrongType: return VENDOR_SELL_STRINGS.cannotSellHere;
    case VENDOR_ACCEPTABILITY.noValue: return VENDOR_SELL_STRINGS.noValue;
    case VENDOR_ACCEPTABILITY.tooCheap: return VENDOR_SELL_STRINGS.tooCheap;
    case VENDOR_ACCEPTABILITY.tooValuable: return VENDOR_SELL_STRINGS.tooValuable;
    default: return VENDOR_SELL_STRINGS.cannotSell;
  }
}

export function vendorSellAppropriateName(item: Pick<VendorSellDragItem, 'name' | 'pluralName' | 'stackSize'>): string {
  return getAppropriateName(item.name, item.pluralName, Math.floor(item.stackSize));
}

/** AddItem's walk notice. */
export function vendorSellContentsNotice(item: Pick<VendorSellDragItem, 'name' | 'pluralName' | 'stackSize'>): string {
  return `Selling contents of ${vendorSellAppropriateName(item)}`;
}

/** AcceptDragObject's split notice. */
export function vendorSellSplitNotice(item: Pick<VendorSellDragItem, 'name' | 'pluralName' | 'stackSize'>): string {
  return `Splitting the ${vendorSellAppropriateName(item)} before selling them`;
}

function isVendorContainer(item: VendorSellDragItem): boolean {
  return ((item.itemType ?? 0) & TYPE_CONTAINER) !== 0;
}

/** GetNumContainedItems / GetNumContainedContainers. */
function vendorContainedCounts(item: VendorSellDragItem): { items: number; containers: number } {
  let items = 0;
  let containers = 0;
  for (const child of item.contents ?? []) {
    if (isVendorContainer(child)) containers++;
    else items++;
  }
  return { items, containers };
}

/** DragItemAcceptable(id, silent); `notice` is the 0x1a text to show (null when silent). */
export function vendorSellDragItemAcceptable(
  item: VendorSellDragItem | null,
  profile: VendorSellProfile | null,
  silent: boolean,
): { acceptable: boolean; notice: string | null } {
  if (!item) return { acceptable: false, notice: null };
  if (item.ownedByPlayer === false) return { acceptable: false, notice: silent ? null : VENDOR_SELL_STRINGS.notCarrying };
  if (vendorContainedCounts(item).items > 0) return { acceptable: true, notice: null };
  const code = vendorInqAcceptability(item, profile);
  if (code === VENDOR_ACCEPTABILITY.ok) return { acceptable: true, notice: null };
  return { acceptable: false, notice: silent ? null : vendorAcceptabilityNotice(code) };
}

/** OnItemListDragOver @ 004c2300: 0x10000040 / 0x10000041; no object / an alias → null. */
export function vendorSellDragAcceptState(item: VendorSellDragItem | null, profile: VendorSellProfile | null, isAlias = false): number | null {
  return uiItemDragAcceptState(item?.guid ?? 0, () => vendorSellDragItemAcceptable(item, profile, true).acceptable, isAlias);
}

/** The objects AddItemToSell lists (each re-listed at the end) and the notices it shows. */
export interface VendorSellAddPlan {
  guids: number[];
  notices: string[];
}

/** AddItemToSell(id) — gmVendorUI::AddItem(pos -1, replace, walk, no acceptability check). */
export function planVendorAddItemToSell(item: VendorSellDragItem, profile: VendorSellProfile | null): VendorSellAddPlan {
  const plan: VendorSellAddPlan = { guids: [], notices: [] };
  const add = (obj: VendorSellDragItem, walk: boolean, checkAcceptable: boolean): void => {
    if (checkAcceptable && vendorInqAcceptability(obj, profile) !== VENDOR_ACCEPTABILITY.ok) return;
    const counts = vendorContainedCounts(obj);
    if (counts.items === 0 && counts.containers === 0) {
      const at = plan.guids.indexOf(obj.guid);
      if (at >= 0) plan.guids.splice(at, 1);
      plan.guids.push(obj.guid);
    }
    if (walk && counts.items > 0) {
      plan.notices.push(vendorSellContentsNotice(obj));
      for (const child of obj.contents ?? []) add(child, false, true);
    }
  };
  add(item, true, false);
  return plan;
}

/** m_splitItemClassID / m_splitItemStackSize and the original's cell (m_splitItem). */
export interface PendingVendorSplit {
  weenieClassId: number;
  stackSize: number;
  originalGuid: number;
}

/**
 * AcceptDragObject(id). `splitWhole` is GenItemHolder::splitSize ==
 * maxSplitSize; `splitSize` is GetObjectSplitSize. On 'split' the caller
 * issues the split in place (reporting VENDOR_SELL_STRINGS.cannotSplit when
 * it could not go out) and then applies `plan` — the original is listed too.
 */
export function planVendorSellDrop(
  item: VendorSellDragItem | null,
  profile: VendorSellProfile | null,
  splitWhole: boolean,
  splitSize: number,
):
  | { kind: 'refused'; notice: string | null }
  | { kind: 'add'; plan: VendorSellAddPlan }
  | { kind: 'split'; pending: PendingVendorSplit; notice: string; plan: VendorSellAddPlan } {
  const verdict = vendorSellDragItemAcceptable(item, profile, false);
  if (!verdict.acceptable || !item) return { kind: 'refused', notice: verdict.notice };
  const plan = planVendorAddItemToSell(item, profile);
  if (splitWhole) return { kind: 'add', plan };
  return {
    kind: 'split',
    pending: { weenieClassId: item.weenieClassId, stackSize: Math.max(1, Math.floor(splitSize)), originalGuid: item.guid },
    notice: vendorSellSplitNotice(item),
    plan,
  };
}

/** ItemAttributesChanged: does this object complete the pending split? (stack size 0 counts as 1) */
export function vendorSplitArrived(pending: PendingVendorSplit | null, obj: Pick<VendorSellDragItem, 'weenieClassId' | 'stackSize'>): boolean {
  if (!pending) return false;
  const size = Math.floor(obj.stackSize) || 1;
  return obj.weenieClassId === pending.weenieClassId && size === pending.stackSize;
}

/**
 * The sell list after ItemAttributesChanged lists `arrivedGuid` at the
 * original's position (WhatNum; -1 → the end) and deletes the original.
 * `listable` is false when the arrival holds contents (it is not listed).
 */
export function applyVendorSplitArrival(
  list: readonly number[],
  pending: PendingVendorSplit,
  arrivedGuid: number,
  listable: boolean,
): number[] {
  const out = [...list];
  const at = out.indexOf(pending.originalGuid);
  if (listable && !out.includes(arrivedGuid)) {
    if (at >= 0) out.splice(at, 0, arrivedGuid);
    else out.push(arrivedGuid);
  }
  const orig = out.indexOf(pending.originalGuid);
  if (orig >= 0) out.splice(orig, 1);
  return out;
}

/** One Selling-tab price row (GameUI.updateVendorSellItems / showVendorWindow). */
export interface VendorSellRow {
  guid: number;
  weenieClassId: number;
  name: string;
  pluralName?: string;
  price: number;
  unitValue?: number;
  priceRate?: number;
  pricing?: 'vendorSells' | 'vendorBuys';
  burden: number;
  stackSize?: number;
  itemType?: number;
  iconDid?: number;
  iconOverlayDid?: number;
  iconUnderlayDid?: number;
  uiEffects?: number;
  cooldownId?: number;
  cooldownDuration?: number;
  structure?: number;
  maxStructure?: number;
}

/**
 * The price rows of everything the player could put on the Selling list:
 * pack contents AND worn items. VendorSellUI::DragItemAcceptable @ 004c20c0
 * takes any IsOwnedByPlayer object, and ACCWeenieObject::IsOwnedByObject @
 * 0058ceb0 counts `_wielderID == player`, so a paperdoll item can be listed;
 * ACE Player_Commerce.VerifySellItems looks it up in GetAllPossessions
 * (equipped included). Each row passes ACE's own gate (the item-type mask and
 * value >= 1; vendorSellRejectionReason) and is priced whole-stack by
 * VendorProfile::VendorBuyPrice. An object listed twice keeps its first row.
 */
export function buildVendorSellRows(
  owned: Iterable<InventoryItem>,
  merchandiseItemTypes: number,
  buyRate: number,
): VendorSellRow[] {
  const rows: VendorSellRow[] = [];
  const seen = new Set<number>();
  for (const it of owned) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    const rejection = vendorSellRejectionReason({ value: it.value ?? 0, itemType: it.itemType ?? 0 }, { merchandiseItemTypes });
    if (rejection) continue;
    rows.push({
      guid: it.id,
      weenieClassId: it.weenieClassId ?? 0,
      name: it.name,
      // CORE.10.f — the selection-seeding fields.
      pluralName: it.pluralName,
      stackSize: it.stackSize,
      itemType: it.itemType,
      price: vendorBuyPrice({ value: it.value ?? 0, stackSize: it.stackSize, itemType: it.itemType ?? 0 }, buyRate),
      unitValue: unitValueOf({ value: it.value ?? 0, stackSize: it.stackSize }),
      priceRate: buyRate,
      pricing: 'vendorBuys',
      burden: it.burden ?? 0,
      iconDid: it.iconDid,
      iconOverlayDid: it.iconOverlayDid,
      iconUnderlayDid: it.iconUnderlayDid,
      uiEffects: it.uiEffects,
      // BUG.cooldown-id-duration-discarded — decile meter inputs.
      cooldownId: it.cooldownId,
      cooldownDuration: it.cooldownDuration,
      // BUG.structure-maxstructure-discarded — uses-remaining bar inputs.
      structure: it.structure,
      maxStructure: it.maxStructure,
    });
  }
  return rows;
}
