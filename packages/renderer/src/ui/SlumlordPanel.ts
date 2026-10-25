/**
 * CORE.17.k.b.b.c.c.a.a — the slumlord dialog's pure logic: gmSlumlordUI
 * (`gmSlumlordUI @ 004c7df0`, a UIElement_Panel + gmNoticeHandler +
 * ObjectRangeHandler + ItemListDragHandler) on layout 0x2100000e.
 *
 * Ground truth (decompiled EoL client + client_local_English.dat):
 *
 *  - The layout: root 0x1000008c (0,0) 800x110 on the dark leather 0x06004cc2,
 *    p46 = [(tab 0x1000008e, page 0x10000090, p50 default true), (tab
 *    0x1000008f, page 0x10000097, p50 false)] — the Buy pair opens first
 *    (UIElement_Panel::SetupTabPageHash @ 0046c2e0 → Update @ 0046bd00).
 *    The tab bar 0x1000008d (type 8, 800x20, 0x060012a8); the tabs 92x20
 *    at x 0 / 92 (base 0x2100003f:0x10000370, str 57002130 "Buy" /
 *    179239666 "Maintenance", 0xb 0x06004cbf / 0xc 0x06004cbe); the pages
 *    (0,20) 800x90 with the requirements text (0,3) 245x87 (base
 *    0x2100003f:0x10000376), the group (245,3) 555x87 holding the owner text
 *    (0,15) 150x16, the button (455,7) 94x22 (base 0x21000040:0x100002bd,
 *    str 263359758 "Buy" / 211030462 "Maintenance", state 1 / 3 / 0xd art
 *    0x06002344/45/46 and 0x06002347/48/49), the UIElement_ItemList (0,34)
 *    555x32 (base 0x2100003d:0x10000339) and its scrollbar (0,66) 555x16
 *    (base 0x2100003e:0x1000036d); the close button 0x1000009e (776,0) 22x20
 *    (0x060012aa / 0x060012a9).
 *  - `PostInit @ 004c82c0` binds the eight page children by id and
 *    registers the two item lists as drag targets; `RecvNotice_
 *    UpdateHouseProfile @ 004c9040` → `UpdateHouse @ 004c8fd0` (m_iidOwner =
 *    the slumlord, the profile copied) → `RefreshHouse @ 004c8b20`, then
 *    SetVisible(1) and an ObjectRangeHandler at MaxLordDistance whose
 *    `OnObjectRangeExit @ 004c7cb0` SetVisible(0)s the panel.
 *  - `RefreshHouse`: the Buy requirements text = `HouseProfile::ComposeText
 *    @ 005bb800`(Buy_House) = `HousePaymentList::ComposeText @ 005bb0b0`
 *    ("num name, …"); the Maintenance requirements text = `ComposeText2 @
 *    005bb830`(Rent_House) ("paid/num name, …"); both owner texts =
 *    "Owner: " + the profile name, or "None" when it is empty; then
 *    CleanItemLists + UpdateButtons.
 *  - `ListenToElementMessage @ 004c94b0`: message 0x18 (visibility) on the
 *    panel itself → CleanItemLists + UpdateButtons; on page 0x10000090
 *    shown → m_eCurrentHouseOp = Buy_House, m_pCurItemList = the Buy list;
 *    on 0x10000097 → Rent_House. Message 1 (click) from 0x1000009e →
 *    SetVisible(0); from 0x10000094 → `MakeBuyHouseConfirmationDialog @
 *    004c90b0` unless the profile's type is 4 (Apartment) → MakePayment;
 *    from 0x1000009b → `MakeRentPaymentByProxyConfirmationDialog @ 004c92b0`
 *    unless `AmIHouseOwner @ 004c7d30` (owner == SmartBox::player_id) →
 *    MakePayment.
 *  - `UpdateButtons @ 004c7fe0`: the Buy button SetState(1) only when an op
 *    is set, the profile exists, its owner is 0 and `HouseProfile::
 *    IsPaidInFull(Buy_House)` (the server-paid + staged amounts cover every
 *    requirement), else SetState(0xd); the Maintenance button SetState(1)
 *    when the Rent item list holds at least one item, else 0xd.
 *  - `IsPaymentAllowed @ 004c7d60`: Buy_House iff owner == 0, Rent_House
 *    iff owner != 0. `DragItemAcceptable @ 004c85f0`: an item the player
 *    does not carry → "You can only trade items you are carrying" (0x1a);
 *    already in the list → no; !IsPaymentAllowed → no; a container → yes;
 *    else `NeedsMore` for its wcid. `AddItem @ 004c80f0` → `AddPayment`
 *    (HouseProfile::Pay), SetTradeState(1), ItemList_AddItem;
 *    `RecvNotice_ItemListBeginDrag @ 004c84f0` (dragging a staged item back
 *    out) → RemoveItem + UpdateButtons.
 *  - `MakePayment @ 004c8940`: the staged guids, CleanItemLists,
 *    UpdateButtons, then `CM_House::Event_BuyHouse` / `Event_RentHouse`
 *    (m_iidOwner, guids). `CloseBuyHouseConfirmationDialog @ 004c8d90` /
 *    `CloseRentPaymentByProxyConfirmationDialog @ 004c8df0`: Yes → MakePayment
 *    (when paid in full / the list is non-empty); No → SetVisible(0).
 */
import { COINSTACK_WCID, ItemType, getAppropriateName } from '@ac/shared';
import { composeHousePaymentText, composeHousePaymentText2, type HousePaymentEntry } from './HousePanelText.js';
import { uiItemDragAcceptState } from './UIItemDragAccept.js';

export const SLUMLORD_LAYOUT_ID = 0x2100000e;

/** The element ids gmSlumlordUI::PostInit binds (+ the tab strip / close the panel handles itself). */
export const SLUMLORD_EL = {
  root: 0x1000008c,
  tabBar: 0x1000008d,
  buyTab: 0x1000008e,
  rentTab: 0x1000008f,
  buyPage: 0x10000090,
  buyRequirements: 0x10000091,
  buyGroup: 0x10000092,
  buyOwner: 0x10000093,
  buyButton: 0x10000094,
  buyList: 0x10000095,
  buyScroll: 0x10000096,
  rentPage: 0x10000097,
  rentRequirements: 0x10000098,
  rentGroup: 0x10000099,
  rentOwner: 0x1000009a,
  rentButton: 0x1000009b,
  rentList: 0x1000009c,
  rentScroll: 0x1000009d,
  close: 0x1000009e,
} as const;

/** The DAT string ids the layout's p23s name (table 0x23000001). */
export const SLUMLORD_STRING_IDS = {
  buyTab: 57002130,
  rentTab: 179239666,
  buyButton: 263359758,
  rentButton: 211030462,
} as const;

/** The authored geometry (the no-DAT fallback draws these; the DAT panel reads its own). */
export const SLUMLORD_GEOMETRY = {
  root: { x: 0, y: 0, w: 800, h: 110 },
  tabBar: { x: 0, y: 0, w: 800, h: 20 },
  buyTab: { x: 0, y: 0, w: 92, h: 20 },
  rentTab: { x: 92, y: 0, w: 92, h: 20 },
  page: { x: 0, y: 20, w: 800, h: 90 },
  requirements: { x: 0, y: 3, w: 245, h: 87 },
  group: { x: 245, y: 3, w: 555, h: 87 },
  owner: { x: 0, y: 15, w: 150, h: 16 },
  button: { x: 455, y: 7, w: 94, h: 22 },
  list: { x: 0, y: 34, w: 555, h: 32 },
  scroll: { x: 0, y: 66, w: 555, h: 16 },
  close: { x: 776, y: 0, w: 22, h: 20 },
} as const;

/** The exe's own literals (gmSlumlordUI). */
export const SLUMLORD_STRINGS = {
  ownerPrefix: 'Owner: ',
  ownerNone: 'None',
  buyConfirm: 'When you buy a landscape house like this one, you are restricted from buying another for 30 days. Are you sure you want to buy this house?',
  rentByProxyConfirm: "You are paying maintenance on someone else's house. Are you sure you wish to continue?",
  notCarrying: 'You can only trade items you are carrying',
  cannotSplit: 'Cannot split the stack for dwelling costs',
} as const;

/** HouseType 4 = Apartment: no 30-day landscape restriction, so no confirmation. */
export const APARTMENT_HOUSE_TYPE = 4;

/** UIElement_Button states the buttons enter (UpdateButtons). */
export const SLUMLORD_BUTTON_ENABLED = 0x1;
export const SLUMLORD_BUTTON_DISABLED = 0xd;

export type HouseOp = 'buy' | 'rent';

export interface SlumlordProfileLike {
  houseType: number;
  ownerName: string;
  ownerId: number;
  buy: readonly HousePaymentEntry[];
  rent: readonly HousePaymentEntry[];
}

export interface StagedHousePayment {
  guid: number;
  amount: number;
  weenieId: number;
}

/** RefreshHouse: "Owner: " + name, or "None" when the profile's name is empty. */
export function slumlordOwnerText(ownerName: string | null | undefined): string {
  return SLUMLORD_STRINGS.ownerPrefix + (ownerName ? ownerName : SLUMLORD_STRINGS.ownerNone);
}

/**
 * RefreshHouse's requirements text per page: the Buy page gets
 * HouseProfile::ComposeText(Buy_House) ("num name, …"), the Maintenance
 * page HouseProfile::ComposeText2(Rent_House) ("paid/num name, …").
 */
export function slumlordRequirementsText(op: HouseOp, profile: SlumlordProfileLike | null): string {
  if (!profile) return '';
  return op === 'buy' ? composeHousePaymentText(profile.buy) : composeHousePaymentText2(profile.rent);
}

/** IsPaymentAllowed: Buy_House iff the dwelling is unowned, Rent_House iff it is owned. */
export function isSlumlordPaymentAllowed(op: HouseOp, profile: SlumlordProfileLike | null): boolean {
  if (!profile) return false;
  return op === 'buy' ? profile.ownerId === 0 : profile.ownerId !== 0;
}

/**
 * HousePayment.Remaining for one requirement after the staged items
 * (HouseProfile::Pay adds to paid).
 *
 * CORE.17.k.b.b.c.c.a.a.c — the server's `paid` never counts here:
 * RefreshHouse @ 004c8b20 (after ComposeText2 has drawn "paid/num") and the
 * panel's visibility message both run `CleanItemLists @ 004c8080`, which
 * calls `HousePaymentList::ClearPayment @ 005ba680` on the profile's buy and
 * rent lists — every node's paid (+0xc) set to 0. From then on the ledger
 * NeedsMore / AttemptToPay / IsPaidInFull read holds only what the player
 * staged, so a requirement is owed in full (num) whatever the server sent.
 */
export function slumlordRemaining(req: HousePaymentEntry, staged: readonly StagedHousePayment[]): number {
  const stagedForReq = staged.filter((p) => p.weenieId === req.weenieId).reduce((sum, p) => sum + p.amount, 0);
  return req.num - stagedForReq;
}

/** HousePaymentList::IsPaidInFull over the profile's list with the staged items counted as paid. */
export function isSlumlordPaidInFull(required: readonly HousePaymentEntry[], staged: readonly StagedHousePayment[]): boolean {
  return required.every((r) => slumlordRemaining(r, staged) <= 0);
}

/**
 * UpdateButtons — the Buy button: state 1 only with an op set, a profile,
 * owner 0 and IsPaidInFull(Buy_House); otherwise 0xd.
 */
export function slumlordBuyButtonState(op: HouseOp | null, profile: SlumlordProfileLike | null, stagedBuy: readonly StagedHousePayment[]): number {
  if (op === null || !profile || profile.ownerId !== 0) return SLUMLORD_BUTTON_DISABLED;
  return isSlumlordPaidInFull(profile.buy, stagedBuy) ? SLUMLORD_BUTTON_ENABLED : SLUMLORD_BUTTON_DISABLED;
}

/** UpdateButtons — the Maintenance button: state 1 iff the Rent item list holds an item. */
export function slumlordRentButtonState(op: HouseOp | null, stagedRentCount: number): number {
  if (op === null) return SLUMLORD_BUTTON_DISABLED;
  return stagedRentCount > 0 ? SLUMLORD_BUTTON_ENABLED : SLUMLORD_BUTTON_DISABLED;
}

/** AmIHouseOwner: the profile's owner is the local player (owner == 0 when no player is known). */
export function amISlumlordHouseOwner(profile: SlumlordProfileLike | null, playerGuid: number): boolean {
  if (!profile) return false;
  return playerGuid ? profile.ownerId === playerGuid : profile.ownerId === 0;
}

/** The Buy click needs the 30-day confirmation unless the dwelling is an Apartment. */
export function slumlordBuyNeedsConfirmation(profile: SlumlordProfileLike | null): boolean {
  return !profile || profile.houseType !== APARTMENT_HOUSE_TYPE;
}

/* ────────────────────────────────────────────────────────────────────────
 * CORE.17.k.b.b.c.c.a.a.b — the payment-list drop edge cases: the retail
 * drag acceptance, container walks, trade-note matching and the split
 * gesture (decompiled EoL client + acclient.exe):
 *
 *  - `DragItemAcceptable @ 004c85f0`(id, silent): no current list → false;
 *    the object must resolve; `ACCWeenieObject::IsOwnedByPlayer @ 0058d160`
 *    (`IsOwnedByObject @ 0058ceb0`: the item is the player, is contained /
 *    wielded by the player, or sits in one of the player's packs) false →
 *    "You can only trade items you are carrying" as a 0x1a
 *    DisplayStringInfo unless silent, then false; `ItemList_IsInList` →
 *    false; `!IsPaymentAllowed` → false; `GetNumContainedItems > 0` (a
 *    container) → true; else `NeedsMore`(wcid).
 *  - `AcceptDragObject @ 004c87c0`: DragItemAcceptable(id, false) else
 *    false; `GenItemHolder::splitSize == maxSplitSize` (the toolbar's global
 *    split state, whatever the dragged object) → SetWaitingState(0) +
 *    `AddObject` + UpdateButtons, true; otherwise
 *    `ItemHolder::AttemptToPlaceInContainer @ 00588140`(id, player_id, the
 *    item's own containerID, 0, 0) — the split-in-place gesture
 *    (UIAttemptSplitToContainer(container, 0, splitSize)) — and on success
 *    the 0x1a notice "Splitting the %s before adding to housing panel" (%s =
 *    `GetObjectNameWide`(NAME_APPROPRIATE = 2): the plural name for a stack
 *    of 2+, else the name; the exe's wide string at .rdata 0x7b6bf0), true;
 *    on failure "Cannot split the stack for dwelling costs" (0x7b6b98), false.
 *    The split stack itself is NOT staged — the player drags the new stack.
 *  - `AddObject @ 004c85b0`: GetNumContainedItems == 0 → `AddItem`, else
 *    `AddContainer @ 004c86e0`: every id of `GetContainedItemsList` that
 *    passes DragItemAcceptable(id, silent = true) goes through AddObject
 *    (nested containers recurse); returns true for any non-empty container.
 *  - `AddItem @ 004c80f0`: a container (GetNumContainedItems ≥ 1) → false;
 *    in the list → false; HousePayment{wcid, `GetHousePayment @ 0058cf80` =
 *    stackSize (0 → 1)}; `AddPayment @ 004c7d90` = `HouseProfile::Pay @
 *    005bb7a0` → `HousePaymentList::Pay @ 005baa50` → `AttemptToPay @
 *    005ba850` must pay something; then `SetTradeState(1)` (the inventory
 *    UIItem shows its Icon_TradeState overlay — `UIElement_UIItem::Update`
 *    reads weenObj->tradeState), ItemList_AddItem, and the object's
 *    BeingDeleted notice (0x186af) is subscribed.
 *  - `HousePaymentList::NeedsMore @ 005ba790`(wcid): walks the list; for a
 *    coinstack requirement, `HouseSystem::IsTradeNote @ 005bb210`(wcid →
 *    value) → paid < num AND value ≤ num − paid (a note LARGER than the
 *    remaining amount is refused); an exact-wcid match → paid < num.
 *  - `AttemptToPay`(wcid, num): a trade note against a coinstack requirement
 *    → `HousePayment::PayWithTradeNote @ 005ba5e0`(num = the note stack,
 *    value): remaining = num − paid; value ≤ remaining; count = min(stack,
 *    floor(remaining / value)); paid += count × value; returns count. An
 *    exact match: paid += min(num, remaining), returns the amount paid
 *    (0 when the requirement is already met).
 *  - `RemoveItem @ 004c81b0` (`RecvNotice_ItemListBeginDrag @ 004c84f0`: a
 *    staged item dragged back out; `RecvNotice_ServerSaysMoveItem @
 *    004c8550`: an item of the CURRENT list that is no longer
 *    IsOwnedByPlayer; `RecvNotice_BeingDeleted @ 004c85a0`): SetTradeState(0),
 *    the BeingDeleted subscription dropped, ItemList_DeleteItem,
 *    `HouseProfile::RemovePayment`; the two move / delete notices then
 *    UpdateButtons. `CleanItemLists @ 004c8080` clears every trade state
 *    (`gmSalvageUI::ClearAllTradeStates @ 004cb270`) on both lists.
 *    `CPlayerSystem::RecvNotice_ServerSaysMoveItem @ 00563260` also clears
 *    the trade state of any object that left the player.
 *  - `RecvNotice_FailedHouseTransaction @ 004c7fc0` (the 0x226 HouseStatus):
 *    m_iidOwner != 0 → `CM_House::Event_QueryLord`(m_iidOwner) — the
 *    slumlord of the last HouseProfile, never cleared, dialog open or not.
 * ──────────────────────────────────────────────────────────────────────── */

/** An object offered to the payment list (the drag payload + what ACCWeenieObject answers about it). */
export interface SlumlordDragItem {
  guid: number;
  name: string;
  pluralName?: string;
  weenieClassId: number;
  itemType: number;
  stackSize: number;
  value: number;
  /** IsOwnedByPlayer — the item sits on the player / in the player's packs (an inventory drag: true). */
  ownedByPlayer?: boolean;
  /** GetContainedItemsList — a container's contents (absent / empty: GetNumContainedItems == 0). */
  contents?: readonly SlumlordDragItem[];
  iconDid?: number;
  iconOverlayDid?: number;
  iconUnderlayDid?: number;
}

export type SlumlordDragVerdict =
  | { acceptable: false; notice: string | null }
  | { acceptable: true; container: boolean };

/** GetNumContainedItems > 0. */
export function isSlumlordContainer(item: Pick<SlumlordDragItem, 'contents'>): boolean {
  return (item.contents?.length ?? 0) > 0;
}

/** HouseSystem::IsTradeNote — the DualEnumIDMap 0x10000001 maps trade-note wcids to their value; ours reads ItemType.PromissoryNote + the item's value. */
export function slumlordTradeNoteValue(item: Pick<SlumlordDragItem, 'itemType' | 'value'>): number {
  return (item.itemType & ItemType.PromissoryNote) !== 0 ? Math.max(0, Math.floor(item.value)) : 0;
}

/** ACCWeenieObject::GetHousePayment — the stack size, 0 → 1. */
export function slumlordHousePayment(item: Pick<SlumlordDragItem, 'stackSize'>): number {
  const n = Math.floor(item.stackSize);
  return n > 0 ? n : 1;
}

/** The staged entry's weenie id: a trade note counts against the coinstack requirement. */
export function slumlordPaymentWcid(item: Pick<SlumlordDragItem, 'itemType' | 'value' | 'weenieClassId'>): number {
  return slumlordTradeNoteValue(item) > 0 ? COINSTACK_WCID : item.weenieClassId;
}

/**
 * HousePaymentList::NeedsMore(wcid): for a coinstack requirement a trade
 * note needs paid < num and value ≤ remaining; an exact-wcid match needs
 * paid < num. The staged items count as paid (HouseProfile::Pay raised it).
 */
export function slumlordNeedsMore(
  required: readonly HousePaymentEntry[],
  staged: readonly StagedHousePayment[],
  item: Pick<SlumlordDragItem, 'itemType' | 'value' | 'weenieClassId'>,
): boolean {
  const noteValue = slumlordTradeNoteValue(item);
  for (const req of required) {
    if (req.weenieId === COINSTACK_WCID && noteValue > 0) {
      const remaining = slumlordRemaining(req, staged);
      return remaining > 0 && noteValue <= remaining;
    }
    if (req.weenieId === item.weenieClassId) return slumlordRemaining(req, staged) > 0;
  }
  return false;
}

/**
 * HousePaymentList::AttemptToPay(wcid, GetHousePayment) — the amount the
 * item adds to the requirement's paid: a trade note pays value × min(stack,
 * floor(remaining / value)) (PayWithTradeNote; 0 when the note is larger
 * than the remaining), an exact match pays min(stack, remaining). 0 means
 * AddPayment fails and the item is not staged.
 */
export function slumlordPaymentAmount(
  required: readonly HousePaymentEntry[],
  staged: readonly StagedHousePayment[],
  item: Pick<SlumlordDragItem, 'itemType' | 'value' | 'weenieClassId' | 'stackSize'>,
): number {
  const num = slumlordHousePayment(item);
  const noteValue = slumlordTradeNoteValue(item);
  for (const req of required) {
    if (req.weenieId === COINSTACK_WCID && noteValue > 0) {
      const remaining = slumlordRemaining(req, staged);
      if (remaining <= 0 || noteValue > remaining) return 0;
      const count = Math.min(num, Math.floor(remaining / noteValue));
      return count > 0 ? count * noteValue : 0;
    }
    if (req.weenieId === item.weenieClassId) {
      const remaining = slumlordRemaining(req, staged);
      return remaining > 0 ? Math.min(num, remaining) : 0;
    }
  }
  return 0;
}

/**
 * gmSlumlordUI::DragItemAcceptable(id, silent). `notice` carries the 0x1a
 * text the caller shows (null when silent or for the silent refusals).
 */
export function slumlordDragItemAcceptable(
  op: HouseOp | null,
  profile: SlumlordProfileLike | null,
  staged: readonly StagedHousePayment[],
  item: SlumlordDragItem,
  silent: boolean,
): SlumlordDragVerdict {
  if (op === null) return { acceptable: false, notice: null };
  if (item.ownedByPlayer === false) return { acceptable: false, notice: silent ? null : SLUMLORD_STRINGS.notCarrying };
  if (staged.some((p) => p.guid === item.guid)) return { acceptable: false, notice: null };
  if (!isSlumlordPaymentAllowed(op, profile) || !profile) return { acceptable: false, notice: null };
  if (isSlumlordContainer(item)) return { acceptable: true, container: true };
  const required = op === 'buy' ? profile.buy : profile.rent;
  return slumlordNeedsMore(required, staged, item) ? { acceptable: true, container: false } : { acceptable: false, notice: null };
}

/**
 * gmSlumlordUI::OnItemListDragOver @ 004c8770 on a Buy / Rent list cell:
 * DragItemAcceptable(id, silent = true) @ 004c85f0 → 0x10000040 / 0x10000041
 * (UIItemDragAccept.uiItemDragAcceptState); no object / an alias drag → null.
 */
export function slumlordDragAcceptState(
  op: HouseOp | null,
  profile: SlumlordProfileLike | null,
  staged: readonly StagedHousePayment[],
  item: SlumlordDragItem | null,
  isAlias = false,
): number | null {
  return uiItemDragAcceptState(item?.guid ?? 0, () => slumlordDragItemAcceptable(op, profile, staged, item!, true).acceptable, isAlias);
}

/**
 * ACCWeenieObject::GetObjectName(NAME_APPROPRIATE) @ 0058e6e0: a stack of 2+
 * is named plural — the server's PluralName, else the singular with "s" /
 * "es" appended client-side ("Pyreals": weenie 273 has no PluralName).
 */
export function slumlordAppropriateName(item: Pick<SlumlordDragItem, 'name' | 'pluralName' | 'stackSize'>): string {
  return getAppropriateName(item.name, item.pluralName, Math.floor(item.stackSize));
}

/** AcceptDragObject's success notice for the split gesture (.rdata 0x7b6bf0): a status line, not a refusal. */
export const SLUMLORD_SPLIT_NOTICE_TEMPLATE = 'Splitting the %s before adding to housing panel';

/** AcceptDragObject's success notice for the split gesture (.rdata 0x7b6bf0). */
export function slumlordSplitNotice(item: Pick<SlumlordDragItem, 'name' | 'pluralName' | 'stackSize'>): string {
  return SLUMLORD_SPLIT_NOTICE_TEMPLATE.replace('%s', () => slumlordAppropriateName(item));
}

/** RecvNotice_FailedHouseTransaction: the slumlord to QueryLord — m_iidOwner when one was ever set, else nothing. */
export function slumlordFailedTransactionQuery(iidOwner: number): number | null {
  return iidOwner ? iidOwner >>> 0 : null;
}
