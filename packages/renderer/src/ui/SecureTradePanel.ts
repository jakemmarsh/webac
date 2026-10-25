/**
 * CORE.17.k.b.b.c.c.a.a.c.a.b — gmSecureTradeUI (layout 0x2100000d, dock slot
 * 0x1000005f): the element bindings and the state rules of the EoL panel.
 *
 * gmSecureTradeUI::PostInit @ 004ca160 binds the RIGHT half to the local
 * player and the LEFT half to the partner:
 *   0x10000086 m_pTradeButton             (right, the player's accept toggle)
 *   0x10000085 m_pSelfPlayerName          (right, the DAT's "You")
 *   0x10000087 m_pSelfTotalItemsLabel     (right)
 *   0x10000088 m_pSelfItemsList           (right — the only drop target)
 *   0x1000007f m_pOtherTradeStatusIndicator (left, the partner's accepted lamp)
 *   0x1000007e m_pOtherPlayerName         (left, "..." until SetTradePartner)
 *   0x10000080 m_pOtherTotalItemsLabel    (left)
 *   0x10000081 m_pOtherItemsList          (left)
 *   0x1000008a m_pClearAllItemsButton     (centre, ClientTradeSystem::ResetTrade)
 *   0x1000008b the close box              (SetVisible(0) → CloseTradeNegotiations)
 * The lists' bars are 0x10000089 (self) and 0x10000082 (partner).
 */
import { acStringHash, getStringParts } from '@ac/dat-parser/file-types/LayoutDesc.js';
import { getAppropriateName } from '@ac/shared';
import { UI_STATE_DISABLED, UI_STATE_NORMAL } from './DatTextStyle.js';
import { uiItemDragAcceptState } from './UIItemDragAccept.js';

export const SECURE_TRADE_EL = {
  root: 0x1000007a,
  partnerHalf: 0x1000007b, divider: 0x1000007d,
  partnerName: 0x1000007e, partnerIndicator: 0x1000007f, partnerTotal: 0x10000080,
  partnerList: 0x10000081, partnerBar: 0x10000082,
  selfHalf: 0x10000083,
  selfName: 0x10000085, tradeButton: 0x10000086, selfTotal: 0x10000087,
  selfList: 0x10000088, selfBar: 0x10000089,
  clearAll: 0x1000008a, close: 0x1000008b,
} as const;

/** The UIItem cell of both lists (m_cellW of template 0x10000339). */
export const TRADE_CELL = 32;

/** UIElement_Button state 6: the Trade toggle pressed (the player accepted) / the partner's lamp lit. */
export const TRADE_STATE_ACCEPTED = 6;

/**
 * UIElement_ItemList::UpdateEmptySlots @ 004e3700 for one horizontal row
 * (p95 = -1): the view is padded with empty tiles to floor(viewW / cell);
 * attr 0x10000017 — TRUE on the self list 0x10000088 only — keeps one empty
 * tile after a filled last cell (where the next drop lands).
 */
export function tradeListCellCount(itemCount: number, viewW: number, trailingEmpty: boolean, cell = TRADE_CELL): number {
  return Math.max(Math.floor(viewW / cell), itemCount + (trailingEmpty ? 1 : 0));
}

/**
 * gmSecureTradeUI::UpdateTradeButtonState @ 004c9700: nothing on the table
 * (both lists empty) → 0xd (disabled); otherwise the toggle shows the
 * player's acceptance — 6 after AcceptTheTrade / RecvNotice_AcceptTrade(self),
 * 1 after DeclineTheTrade and whenever an item is added or removed (AddMyItem
 * / AddPartnerItem / RemoveAddedItem / RemovePartnerItem SetState(1)).
 */
export function tradeButtonState(selfCount: number, partnerCount: number, selfAccepted: boolean): number {
  if (selfCount + partnerCount === 0) return UI_STATE_DISABLED;
  return selfAccepted ? TRADE_STATE_ACCEPTED : UI_STATE_NORMAL;
}

/**
 * m_pOtherTradeStatusIndicator 0x1000007f: 0xd (art 0x06004cb9) until the
 * partner accepts, 6 (0x06004cba) once they have; every item change and
 * Reset put it back to 0xd.
 */
export function partnerIndicatorState(partnerAccepted: boolean): number {
  return partnerAccepted ? TRADE_STATE_ACCEPTED : UI_STATE_DISABLED;
}

/**
 * ListenToElementMessage @ 004cae80, message 1 on 0x10000086: the toggle has
 * already flipped when the message arrives (it tests 6 → AcceptTheTrade,
 * 1 → DeclineTheTrade), so a press on a RESTING state 1 accepts and a press
 * on a resting 6 declines; a disabled (0xd) button sends nothing.
 */
export function tradeButtonPressAction(restingState: number): 'accept' | 'decline' | null {
  const state = restingState;
  if (state === UI_STATE_NORMAL) return 'accept';
  if (state === TRADE_STATE_ACCEPTED) return 'decline';
  return null;
}

/**
 * SetMyItemNumber @ 004c98d0 / SetOtherItemNumber @ 004c9970: the string
 * ID_SecureTrade_TotalItemsLabel (table 0x23000001: "Total Items: " %Items "")
 * with the list's item count.
 */
export const TRADE_TOTAL_ITEMS_STRING_ID = acStringHash('ID_SecureTrade_TotalItemsLabel');

export function tradeTotalItemsText(count: number): string {
  const parts = getStringParts(TRADE_TOTAL_ITEMS_STRING_ID);
  if (parts && parts.length >= 1) return `${parts[0]}${count}${parts.slice(1).join('')}`;
  return `Total Items: ${count}`;
}

/* ────────────────────────────────────────────────────────────────────────
 * CORE.17.k.b.b.c.c.a.a.c.a.b.a — gmSecureTradeUI's drag / add rules
 * (decompiled EoL client + acclient.exe .rdata):
 *
 *  - `DragItemAcceptable @ 004ca6a0`(id, silent): the object must resolve;
 *    not `IsOwnedByPlayer` (carried, wielded, or in one of the player's
 *    packs) → the 0x1a notice "You can only trade items you are carrying"
 *    unless silent; already `ItemList_IsInList(m_pSelfItemsList)` → refused;
 *    anything else → accepted (a pack too).
 *  - `OnItemListDragOver @ 004ca980`: DragItemAcceptable(id, true) →
 *    `SetDragAcceptState(0x10000040)`, refused → 0x10000041 (an alias drag —
 *    a shortcut — is ignored).
 *  - `AcceptDragObject @ 004caa40` (the drop, HandleDropRelease @ 004cae10):
 *    DragItemAcceptable(id, false) or nothing; the toolbar's split state at
 *    its maximum (GenItemHolder::splitSize == maxSplitSize) → AddItem(id, 0,
 *    walk = true); otherwise `ItemHolder::AttemptToPlaceInContainer`(id,
 *    player, the item's own container) — the split in place — failing →
 *    "Cannot split the stack to trade it" (.rdata 0x7b7438), false;
 *    succeeding → splitItemID / splitItemClassID (wcid) / splitItemStackSize
 *    (GetObjectSplitSize) are remembered and "Splitting the %s before trading
 *    them" (0x7b7480, %s = GetObjectNameWide(NAME_APPROPRIATE)) is shown.
 *  - `ItemAttributesChanged @ 004ca9d0`: with a split pending, the object of
 *    that wcid whose stack size (0 → 1) equals the remembered size goes
 *    through AddItem (no walk) and the pending split clears — the split-off
 *    stack joins the trade on its own.
 *  - `AddItem @ 004ca780`(id, pos, …, walk): an object with no contained
 *    items AND no contained containers, not already listed → SetTradeState(1),
 *    the cell, ClientTradeSystem::AddItemToSelfTradeList (the server's
 *    AddToTrade). With walk and contained items: the 0x1a notice "Trading
 *    contents of %s" (0x7b7408) and every GetContainedItemsList id through
 *    AddItem WITHOUT walk (a non-empty nested pack is neither listed nor
 *    opened). A pack is never listed itself unless it is empty.
 *  - `TradeAnItemForDummies @ 004cad50` (ClientTradeSystem::
 *    AttemptToTradeItem — the item used on the trade partner): not listed →
 *    the selected object with its split state below the maximum refuses with
 *    "You must split the stack before trading it." (0x7b74d0); otherwise
 *    AddItem(id, 0, walk = true).
 * ──────────────────────────────────────────────────────────────────────── */

/** ITEM_TYPE::TYPE_CONTAINER. */
const TYPE_CONTAINER = 0x200;

/** What gmSecureTradeUI asks ACCWeenieObject about a dragged object. */
export interface TradeDragItem {
  guid: number;
  name: string;
  pluralName?: string;
  weenieClassId: number;
  stackSize: number;
  itemType?: number;
  /** IsOwnedByPlayer (an inventory or paperdoll drag: true). */
  ownedByPlayer?: boolean;
  /** pwd._containerID — where a split in place lands (0: the player). */
  containerId?: number;
  /** GetContainedItemsList. */
  contents?: readonly TradeDragItem[];
}

export const TRADE_STRINGS = {
  notCarrying: 'You can only trade items you are carrying',
  cannotSplit: 'Cannot split the stack to trade it',
  mustSplit: 'You must split the stack before trading it.',
} as const;

/**
 * ACCWeenieObject::GetObjectName(NAME_APPROPRIATE) @ 0058e6e0: a stack of 2+
 * is named plural — the server's PluralName, else the singular with "s" /
 * "es" appended client-side ("Pyreals": weenie 273 has no PluralName).
 */
export function tradeAppropriateName(item: Pick<TradeDragItem, 'name' | 'pluralName' | 'stackSize'>): string {
  return getAppropriateName(item.name, item.pluralName, Math.floor(item.stackSize));
}

/**
 * gmSecureTradeUI's two status lines (SendNotice_DisplayStringInfo 0x1a), %s = NAME_APPROPRIATE: AddItem's walk
 * notice "Trading contents of %s" (.rdata 0x7b7408) as a pack's contents go on the list, and AcceptDragObject's
 * "Splitting the %s before trading them" (.rdata 0x7b7480) as the split request goes out. Both report a step that
 * is going ahead, not a refusal: the refusal telemetry reads them from here (RefusalTemplates SPEW_STATUS_TEMPLATES).
 */
export const TRADE_NOTICE_TEMPLATES = Object.freeze({
  contents: 'Trading contents of %s',
  split: 'Splitting the %s before trading them',
});

/** AddItem's walk notice (.rdata 0x7b7408). */
export function tradeContentsNotice(item: Pick<TradeDragItem, 'name' | 'pluralName' | 'stackSize'>): string {
  return TRADE_NOTICE_TEMPLATES.contents.replace('%s', () => tradeAppropriateName(item));
}

/** AcceptDragObject's split notice (.rdata 0x7b7480). */
export function tradeSplitNotice(item: Pick<TradeDragItem, 'name' | 'pluralName' | 'stackSize'>): string {
  return TRADE_NOTICE_TEMPLATES.split.replace('%s', () => tradeAppropriateName(item));
}

function isTradeContainer(item: TradeDragItem): boolean {
  return ((item.itemType ?? 0) & TYPE_CONTAINER) !== 0;
}

/** GetNumContainedItems / GetNumContainedContainers. */
function tradeContainedCounts(item: TradeDragItem): { items: number; containers: number } {
  let items = 0;
  let containers = 0;
  for (const child of item.contents ?? []) {
    if (isTradeContainer(child)) containers++;
    else items++;
  }
  return { items, containers };
}

/** DragItemAcceptable(id, silent); `notice` is the 0x1a text to show (null when silent). */
export function tradeDragItemAcceptable(
  item: TradeDragItem | null,
  listed: ReadonlySet<number>,
  silent: boolean,
): { acceptable: boolean; notice: string | null } {
  if (!item) return { acceptable: false, notice: null };
  if (item.ownedByPlayer === false) return { acceptable: false, notice: silent ? null : TRADE_STRINGS.notCarrying };
  if (listed.has(item.guid)) return { acceptable: false, notice: null };
  return { acceptable: true, notice: null };
}

/**
 * gmSecureTradeUI::OnItemListDragOver @ 004ca980 on a self-list cell:
 * DragItemAcceptable(id, silent = true) @ 004ca6a0 → 0x10000040 / 0x10000041
 * (UIItemDragAccept.uiItemDragAcceptState); no object / an alias drag → null.
 */
export function tradeDragAcceptState(item: TradeDragItem | null, listed: ReadonlySet<number>, isAlias = false): number | null {
  return uiItemDragAcceptState(item?.guid ?? 0, () => tradeDragItemAcceptable(item, listed, true).acceptable, isAlias);
}

/** The objects AddItem puts on the self list (each one AddToTrade) and the notices it shows. */
export interface TradeAddPlan {
  guids: number[];
  notices: string[];
}

/** AddItem(id, pos, …, walk). `listed` is not modified. */
export function planTradeAddItem(item: TradeDragItem, listed: ReadonlySet<number>, walk: boolean): TradeAddPlan {
  const taken = new Set(listed);
  const plan: TradeAddPlan = { guids: [], notices: [] };
  const add = (obj: TradeDragItem, doWalk: boolean): void => {
    const counts = tradeContainedCounts(obj);
    if (counts.items === 0 && counts.containers === 0) {
      if (taken.has(obj.guid)) return;
      taken.add(obj.guid);
      plan.guids.push(obj.guid);
    }
    if (doWalk && counts.items > 0) {
      plan.notices.push(tradeContentsNotice(obj));
      for (const child of obj.contents ?? []) add(child, false);
    }
  };
  add(item, walk);
  return plan;
}

/** splitItemClassID / splitItemStackSize — the stack AcceptDragObject is waiting for. */
export interface PendingTradeSplit {
  weenieClassId: number;
  stackSize: number;
}

/**
 * AcceptDragObject(id). `splitWhole` is GenItemHolder::splitSize ==
 * maxSplitSize; `splitSize` is GetObjectSplitSize. The caller issues the
 * split in place when the result is 'split' (and reports 'cannot-split'
 * with TRADE_STRINGS.cannotSplit when the request could not go out).
 */
export function planTradeDrop(
  item: TradeDragItem | null,
  listed: ReadonlySet<number>,
  splitWhole: boolean,
  splitSize: number,
):
  | { kind: 'refused'; notice: string | null }
  | { kind: 'add'; plan: TradeAddPlan }
  | { kind: 'split'; pending: PendingTradeSplit; notice: string } {
  const verdict = tradeDragItemAcceptable(item, listed, false);
  if (!verdict.acceptable || !item) return { kind: 'refused', notice: verdict.notice };
  if (splitWhole) return { kind: 'add', plan: planTradeAddItem(item, listed, true) };
  return {
    kind: 'split',
    pending: { weenieClassId: item.weenieClassId, stackSize: Math.max(1, Math.floor(splitSize)) },
    notice: tradeSplitNotice(item),
  };
}

/** ItemAttributesChanged: does this object complete the pending split? (stack size 0 counts as 1) */
export function tradeSplitArrived(pending: PendingTradeSplit | null, obj: Pick<TradeDragItem, 'weenieClassId' | 'stackSize'>): boolean {
  if (!pending) return false;
  const size = Math.floor(obj.stackSize) || 1;
  return obj.weenieClassId === pending.weenieClassId && size === pending.stackSize;
}

/** TradeAnItemForDummies(id). `selectedUnsplit`: the object is the selection and the split state is below the maximum. */
export function planTradeAnItemForDummies(
  item: TradeDragItem,
  listed: ReadonlySet<number>,
  selectedUnsplit: boolean,
): { kind: 'refused'; notice: string | null } | { kind: 'add'; plan: TradeAddPlan } {
  if (listed.has(item.guid)) return { kind: 'refused', notice: null };
  if (selectedUnsplit) return { kind: 'refused', notice: TRADE_STRINGS.mustSplit };
  return { kind: 'add', plan: planTradeAddItem(item, listed, true) };
}
