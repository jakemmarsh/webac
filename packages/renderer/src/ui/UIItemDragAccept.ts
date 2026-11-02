/**
 * UIElement_UIItem's drag-over accept state (m_elem_Icon_DragAccept, child
 * 0x1000045a bound in PostInit @ 004e1400; SetDragAcceptState @ 004e1290).
 *
 * Every ItemListDragHandler's OnItemListDragOver is the same shape —
 * gmSalvageUI @ 004cb740, gmSecureTradeUI @ 004ca980, VendorSellUI @
 * 004c2300, gmSlumlordUI @ 004c8770: a non-alias drag carrying an object →
 * the panel's DragItemAcceptable(id, silent = true) → SetDragAcceptState
 * 0x10000040 on the hovered cell when it passes, 0x10000041 when it does not;
 * no object or DROPITEM_IS_ALIAS leaves the cell untouched.
 * ListenToElementMessage @ 004e1390 resets the state to 0x1000003f when the
 * pointer leaves the cell.
 */

import { isMergeLegalQuiet, type PlacementWorld } from '../inventory/ItemHolderPlacement.js';
import {
  shortcutDropIntoContainer1999, shortcutDropRefusal1999,
  type ShortcutContainerFacts1999, type ShortcutDropItem1999,
} from '../network/itemShortcutRestore.js';

export const DRAG_ACCEPT_STATE = { none: 0x1000003f, accept: 0x10000040, refuse: 0x10000041 } as const;

/**
 * The state art. Every drag-handler list — salvage 0x2100000c:0x10000074,
 * the trade self list 0x2100000d:0x10000088, the vendor sell list
 * 0x21000012:0x100000ce, the slumlord buy / rent lists 0x2100000e:0x10000095
 * / 0x1000009c — bases 0x2100003d:0x10000339, whose p0x1000000e cell template
 * is 0x1000033a; its 0x1000045a bases 0x21000037:0x1000045d: state 0x10000040
 * draws the green ring 0x060011f9, 0x10000041 the red slashed circle
 * 0x060011f8, 0x1000003f nothing.
 */
export const UIITEM_DRAG_ACCEPT_TEX: Readonly<Record<number, number>> = {
  [DRAG_ACCEPT_STATE.accept]: 0x060011f9,
  [DRAG_ACCEPT_STATE.refuse]: 0x060011f8,
};

/**
 * OnItemListDragOver for the hovered cell: `draggedId` 0 (no object) or an
 * alias drag → null (untouched); otherwise the silent DragItemAcceptable
 * verdict as 0x10000040 / 0x10000041.
 */
export function uiItemDragAcceptState(draggedId: number, acceptable: () => boolean, isAlias = false): number | null {
  if (draggedId === 0 || isAlias) return null;
  return acceptable() ? DRAG_ACCEPT_STATE.accept : DRAG_ACCEPT_STATE.refuse;
}

/**
 * State 0x10000046 — the green "into" arrow. Only the pack-column cell's
 * drag-accept element has it: template 0x21000037:0x1000033e (the
 * 0x1000033f pack cell's 0x10000340) bases its 0x1000045a on 0x1000045e,
 * whose states are 0x10000040 → 0x060011f9, 0x10000041 → 0x060011f8 and
 * 0x10000046 → 0x060011f7. The pack-grid cell (0x1000033a) uses
 * 0x1000045d, which has no 0x10000046 state.
 */
export const DRAG_ACCEPT_INTO = 0x10000046;
export const CONTAINER_CELL_DRAG_ACCEPT_TEX: Readonly<Record<number, number>> = {
  ...UIITEM_DRAG_ACCEPT_TEX,
  [DRAG_ACCEPT_INTO]: 0x060011f7,
};

/**
 * The toolbar shortcut cells' drag-accept art. Every one of the 18 slots of
 * 0x21000016 names its own UIItem template (p0x1000000e: 0x1000043b..43,
 * 0x100006c1..c9), each based on 0x21000037:0x1000045c, whose 0x1000045a
 * bases 0x1000045f: 0x10000040 → 0x060011fa (the add-shortcut box),
 * 0x10000041 → 0x060011f8.
 */
export const TOOLBAR_CELL_DRAG_ACCEPT_TEX: Readonly<Record<number, number>> = {
  [DRAG_ACCEPT_STATE.accept]: 0x060011fa,
  [DRAG_ACCEPT_STATE.refuse]: 0x060011f8,
};

/**
 * The 1999 ShortcutSlot's drag-over art (DragOverAction @ 0x005004b0 puts one in the slot's
 * +0xc8 and Hilites it): the globals at 0x006578a4 / a8 / ac, handed over at 0x004d54a1..c3 from
 * UI_GetPermanentObjects @ 0x004d3430's +0x3e4 (0x060011fa, the add-shortcut box), +0x3dc
 * (0x060011f7, the arrow) and +0x3d8 (0x060011f8, the circle).
 */
export const SHORTCUT_SLOT_1999_DRAG_TEX: Readonly<Record<number, number>> = {
  [DRAG_ACCEPT_STATE.accept]: 0x060011fa,
  [DRAG_ACCEPT_INTO]: 0x060011f7,
  [DRAG_ACCEPT_STATE.refuse]: 0x060011f8,
};

/**
 * Which art table a cell's overlay draws: absent = 0x1000045d; '1000045e' / '1000045f' the DAT
 * bases of the pack column's and the toolbar's cells; 'shortcut1999' the 1999 ShortcutSlot's.
 */
export type DragAcceptTemplate = '1000045e' | '1000045f' | 'shortcut1999';

/** What the toolbar shortcut slot reads of the dragged object or the slot's own object. */
export type ShortcutSlotDragObject = ShortcutDropItem1999 & ShortcutContainerFacts1999;

/**
 * A toolbar shortcut slot's drag-over state and art table. Null = untouched.
 *
 * End of retail — gmToolbarUI::OnItemListDragOver @ 004bd150: 0x10000040 (0x1000045f's
 * add-shortcut box 0x060011fa) for any drag carrying an object.
 *
 * AC1999 — ShortcutSlot_DragOverAction @ 0x005004b0 (Region slot 42 of the slot's vtable
 * 0x601e28), for an item drag (UI_Item type 1) or a shortcut drag (type 2), until
 * StopDraggingOver @ 0x00500640 un-Hilites it:
 *  - the arrow 0x060011f7 when an item (not a shortcut) would go into the slot's container
 *    (shortcutDropIntoContainer1999, AcceptDragObject @ 0x00500240's first branch);
 *  - else the add-shortcut box 0x060011fa when the object can be a shortcut
 *    (ItemHolder_DetermineUseResult @ 0x004fe720, which AcceptDragObject asks the same:
 *    shortcutDropRefusal1999) and the toolbar holds no partial split;
 *  - else, or with no object known, the circle 0x060011f8.
 */
export function shortcutSlotDragOverState(
  rule: 'eor' | 'ac1999',
  d: {
    /** A drag carrying an object or a shortcut is over the slot. */
    carries: boolean;
    /** It is a shortcut moved off another slot (UI_Item type 2). */
    shortcutDrag: boolean;
    /** The dragged object (a shortcut drag: the shortcut's); undefined = unknown. */
    dragged?: ShortcutSlotDragObject;
    /** The object the slot holds; null = an empty slot. */
    slot?: ShortcutSlotDragObject | null;
    split: { splitSize: number; maxSplitSize: number };
  },
): { state: number; template: DragAcceptTemplate } | null {
  if (!d.carries) return null;
  if (rule === 'eor') return { state: DRAG_ACCEPT_STATE.accept, template: '1000045f' };
  const template = 'shortcut1999' as const;
  if (!d.dragged) return { state: DRAG_ACCEPT_STATE.refuse, template };
  if (!d.shortcutDrag && shortcutDropIntoContainer1999(d.dragged, d.slot ?? null)) return { state: DRAG_ACCEPT_INTO, template };
  return { state: shortcutDropRefusal1999(d.dragged, d.split) === null ? DRAG_ACCEPT_STATE.accept : DRAG_ACCEPT_STATE.refuse, template };
}

/** The PlacementWorld slice the pack lists' drag-over reads. */
export type ItemListDragWorld = Pick<PlacementWorld, 'object' | 'itemsOf' | 'containersOf'>;

export interface ItemListDragOverInput {
  /** The client era's rule (EraClientRules.itemListDragOver). */
  rule: 'eor' | 'ac1999';
  /** The object under the drag; 0 = none (a shortcut drag carries no object here). */
  draggedId: number;
  /** A shortcut (alias) drag. */
  isAlias?: boolean;
  /** End of retail's DROPITEM_IS_CONTAINER: the drag left the pack column (InqDropIconInfo @ 004e26f0). */
  fromContainerList: boolean;
  /** The hovered cell is in the pack column (UIElement_ItemList::containerList), not the pack grid. */
  containerList: boolean;
  /** The object the hovered cell shows; 0 = an empty cell. */
  cellObjectId: number;
}

/** Free item / pack slots in `holderId` (capacity -1 = unlimited → -1, as GetNumEmptyItemSlots). */
function emptySlots(capacity: number, used: number): number {
  return capacity < 0 ? -1 : capacity - used;
}

/**
 * The drag-over state of a pack-grid or pack-column cell (neither list has
 * a drag handler, so the list itself decides). Null = the cell is left
 * untouched.
 *
 * End of retail — UIElement_ItemList::ItemList_DragOver @ 004e3400 (called
 * by UIElement_UIItem::ListenToElementMessage @ 004e1390 on message 0x3e):
 * nothing for an alias or no object; on the grid the green ring 0x10000040
 * for any drag that did not leave the pack column (DROPITEM_IS_CONTAINER),
 * the red circle 0x10000041 for one that did; on the pack column a non-
 * pack-column drag gets the arrow 0x10000046 over a filled cell whose
 * object has empty item slots (ACCWeenieObject::GetNumEmptyItemSlots),
 * else the red circle, and a pack-column drag gets the ring. It never asks
 * whether the drop would merge: the ring over a stack is the ring over any
 * cell.
 *
 * AC1999 — the UI_Item draw @ 0x004e7d20, while the ItemList's drag loop
 * @ 0x0053a790 marks the cell under the pointer (+0xec): 0x00657868 =
 * 0x060011f9 (ring), 0x00657864 = 0x060011f7 (arrow), 0x00657860 =
 * 0x060011f8 (circle), loaded in UI_GetPermanentObjects @ 0x004d3430 and
 * handed over at 0x004d50c4..e6. `C` = the dragged object is a pack (+0xe0,
 * set in 0x004e6ed0), `S` = it holds packs (+0xe4, GetContainersCapacity
 * != 0), a pack-column cell = +0xcc:
 *  - an empty cell: pack column → ring for a pack that holds no packs, else
 *    circle; grid → circle for a pack, else ring;
 *  - a filled cell: ring for a non-pack on the grid, and for a pack that
 *    holds no packs on a pack-column cell that holds none (a side pack over
 *    a side pack); arrow on a pack-column cell with room for it (an item:
 *    empty item slots 0x004e24d0; a pack: empty pack slots 0x004e2520);
 *    otherwise ItemHolder_AttemptMergeIsLegal (0x004e4f70) of the dragged
 *    object onto the cell's → arrow, else circle.
 */
export function itemListDragOverState(w: ItemListDragWorld, d: ItemListDragOverInput): number | null {
  if (d.draggedId === 0 || d.isAlias) return null;
  const cell = d.cellObjectId ? w.object(d.cellObjectId) : undefined;
  const itemRoom = () => !!cell && emptySlots(cell.itemsCapacity, w.itemsOf(cell.id).length) !== 0;
  if (d.rule === 'eor') {
    if (!d.containerList) return d.fromContainerList ? DRAG_ACCEPT_STATE.refuse : DRAG_ACCEPT_STATE.accept;
    if (d.fromContainerList) return DRAG_ACCEPT_STATE.accept;
    return itemRoom() ? DRAG_ACCEPT_INTO : DRAG_ACCEPT_STATE.refuse;
  }
  const dragged = w.object(d.draggedId);
  if (!dragged) return null;
  const isPack = dragged.isContainer;
  const holdsPacks = dragged.containersCapacity !== 0;
  if (!cell) {
    if (d.containerList) return isPack && !holdsPacks ? DRAG_ACCEPT_STATE.accept : DRAG_ACCEPT_STATE.refuse;
    return isPack ? DRAG_ACCEPT_STATE.refuse : DRAG_ACCEPT_STATE.accept;
  }
  if (!d.containerList && !isPack) return DRAG_ACCEPT_STATE.accept;
  if (d.containerList && isPack && !holdsPacks && cell.containersCapacity === 0) return DRAG_ACCEPT_STATE.accept;
  if (d.containerList && !isPack && itemRoom()) return DRAG_ACCEPT_INTO;
  if (d.containerList && isPack && !holdsPacks
    && emptySlots(cell.containersCapacity, w.containersOf(cell.id).length) !== 0) return DRAG_ACCEPT_INTO;
  return isMergeLegalQuiet(dragged, cell) ? DRAG_ACCEPT_INTO : DRAG_ACCEPT_STATE.refuse;
}

/** ITEM_TYPE creature (the dragged object's vtable +0x18 type the 1999 InventoryButton compares). */
const TYPE_CREATURE = 0x10;

/** What the 1999 InventoryButton reads off the dragged object. */
export interface InventoryButtonDragObject {
  /** ITEM_TYPE (vtable +0x18). */
  itemType?: number;
  /** pwd._bitfield & 4 (BF_STUCK). */
  stuck?: boolean;
  /** The player (its type is TYPE_CREATURE). */
  isPlayer?: boolean;
}

/**
 * The toolbar backpack button's drag-over state. Null = no art.
 *
 * End of retail — gmToolbarUI::HandleInventoryButtonDragOver @ 004bd180: any
 * non-alias drag carrying an object sets m_pInventoryButtonDragOverlay
 * (0x1000046c) to 0x10000046, the arrow 0x060011f7.
 *
 * AC1999 — InventoryButton_DragOverAction @ 0x005014d0 (Region slot 42 of
 * vtable 0x6020d0, `this` = the button + 0xc): for an item drag (UI_Item type
 * 1) whose object is known, the red circle 0x060011f8 when the object's type
 * is 0 or exactly TYPE_CREATURE (0x10) or it is stuck (+0x70 & 4,
 * 0x004e4d70), else the arrow 0x060011f7 (both 32x32 Graphics made in the
 * ctor @ 0x00501030). It latches until InventoryButton_StopDraggingOver
 * @ 0x00501580 clears it.
 */
export function inventoryButtonDragOverState(
  rule: 'eor' | 'ac1999',
  draggedId: number,
  dragged: InventoryButtonDragObject | undefined,
  isAlias = false,
): number | null {
  if (draggedId === 0 || isAlias) return null;
  if (rule === 'eor') return DRAG_ACCEPT_INTO;
  if (!dragged) return null;
  const type = dragged.isPlayer ? TYPE_CREATURE : ((dragged.itemType ?? 0) >>> 0);
  return type === 0 || type === TYPE_CREATURE || dragged.stuck ? DRAG_ACCEPT_STATE.refuse : DRAG_ACCEPT_INTO;
}

/** The backpack button's overlay art per state (the arrow, the circle); absent = none. */
export const INVENTORY_BUTTON_DRAG_TEX: Readonly<Record<number, number>> = {
  [DRAG_ACCEPT_INTO]: 0x060011f7,
  [DRAG_ACCEPT_STATE.refuse]: 0x060011f8,
};

/**
 * Where the backpack button's 32x32 drag-over art sits on the 63x58 button.
 * End of retail: element 0x1000046c at (31,0) of 0x21000016 for every state.
 * AC1999 — InventoryButton_DrawThis @ 0x00501420: the arrow at (+0x1f, +0),
 * the top right as in end of retail; the circle at (+0xf, +0xd), centred.
 */
export function inventoryButtonDragArtAt(rule: 'eor' | 'ac1999', state: number): { x: number; y: number } {
  if (rule === 'ac1999' && state === DRAG_ACCEPT_STATE.refuse) return { x: 0xf, y: 0xd };
  return { x: 0x1f, y: 0 };
}

/**
 * The main-pack cell's own drag (the player, from the inventory's 36x36 top
 * list) lights the drag-over art of what it crosses, in every era.
 *
 * End of retail: gmInventoryUI's m_topContainer 0x100001c9 holds the player
 * (RecvNotice_SetDisplayInventory @ 004a6750) and is a container list
 * (0x21000022: p0x10000011 = true), so ItemList_BeginDrag @ 004e32d0 →
 * PrepareDragIcon @ 004e2a50 marks the icon 0x10000011 = the UIItem's
 * isContainer, and InqDropIconInfo @ 004e26f0 reads it back as
 * DROPITEM_IS_CONTAINER. Every handler asks only for an object and no alias:
 * gmToolbarUI::HandleInventoryButtonDragOver @ 004bd180 (the arrow),
 * ItemList_DragOver @ 004e3400 (a container-list drag: the circle on the grid,
 * the ring on the pack column), the paperdoll (HandlePaperDollDragOver
 * @ 004a3a70, OnItemListDragOver @ 004a4270: the player is not wearable → the
 * circle), and the panels' DragItemAcceptable (trade @ 004ca6a0, salvage
 * @ 004cb650, slumlord @ 004c85f0, vendor sell @ 004c20c0, external
 * container @ 004cbb60) for the player.
 *
 * AC1999: InventoryPanel_PlayerInitialized @ 0x005244c0 ItemList_AddItem's
 * the player into the top ItemList, so its drag is a UI_Item type 1 like any
 * other, and the ItemList drag-over (DragOverAction @ 0x0053a650, Global_Loop
 * @ 0x0053a790), the ShopLists, the backpack button, the paperdoll and the
 * combat button answer it as they answer an item. (The 1999 ItemList rule
 * never reads where a drag came from, so the container flag changes nothing there.)
 */
export const MAIN_PACK_DRAG_IS_CONTAINER_DRAG = true;

/**
 * VISUAL.ac1999-spellbar-drag-hover — the spell bar cell under a drag carrying
 * a spell: the green ring 0x060011f9 in both eras, nothing for any other drag.
 *
 * End of retail — SpellCastSubMenu::OnItemListDragOver @ 004c5990: 0x10000040
 * on the hovered cell (template 0x10000341's 0x1000045a on 0x1000045d: the ring).
 *
 * AC1999 — the spell list (class 0x6049b8): DragOverAction @ 0x00514ee0 sets
 * +0x180 for a spell drag (UI_Item type 4, a spellbook row, or 6, a bar
 * shortcut); Global_Loop @ 0x00515120 then hit-tests the pointer each frame,
 * clears the old cell's +0xc8 and sets the new one's to 1 through 0x00515f70
 * (which redraws); the cell (class 0x604ab8, 32x32, ctor @ 0x00515b80, draw
 * @ 0x00515ce0) paints g_ClientWorldMgr+0x3e0 at its origin for +0xc8 == 1:
 * 0x060011f9 (UI_GetPermanentObjects @ 0x004d3430). Every cell answers, the
 * empty pads too (0x00515a80 pads the row to the list's width). The drop
 * (0x00514fe0) and StopDraggingOver (0x005150c0) clear it.
 */
export function spellBarDragOverState(spellDrag: boolean): number | null {
  return spellDrag ? DRAG_ACCEPT_STATE.accept : null;
}

/** What the 1999 CombatButton reads off the dragged object. */
export interface CombatButtonDragObject {
  /** pwd._combatUse (0x004e4dd0: +0x5c). */
  combatUse?: number;
  /** ITEM_TYPE (vtable +0x18); TYPE_CASTER = 0x8000. */
  itemType?: number;
}

/** ITEM_TYPE caster. */
const TYPE_CASTER = 0x8000;

/** Whether the 1999 combat button would wield the object: a combat use, or the Caster type. */
function combatButtonWields(dragged: CombatButtonDragObject | undefined): boolean {
  if (!dragged) return false;
  return (dragged.combatUse ?? 0) !== 0 || (((dragged.itemType ?? 0) >>> 0) & TYPE_CASTER) !== 0;
}

/**
 * BUG.ac1999-combat-button-drop — the toolbar combat button's drag-over state.
 * Null = no art.
 *
 * End of retail (`takesDrop` false): the combat button has no drag handler.
 *
 * AC1999 — CombatButton DragOverAction @ 0x005020b0 (Region vtable 0x6022f8):
 * for an item drag (UI_Item type 1) it latches, until StopDraggingOver
 * @ 0x00502150 clears it, the ring 0x060011f9 (+0x138 of the button, made in
 * the ctor @ 0x00501950) when the object has a combat use or is a caster,
 * else the circle 0x060011f8 (+0x13c), the circle too when the object is not
 * known. DrawThis @ 0x00501fc0 centres it (combatButtonDragArtAt).
 */
export function combatButtonDragOverState(
  takesDrop: boolean,
  draggedId: number,
  dragged: CombatButtonDragObject | undefined,
  isAlias = false,
): number | null {
  if (!takesDrop || draggedId === 0 || isAlias) return null;
  return combatButtonWields(dragged) ? DRAG_ACCEPT_STATE.accept : DRAG_ACCEPT_STATE.refuse;
}

/**
 * The 1999 combat button's drop (AcceptDragObject @ 0x00502180), for an item
 * drag: true for an object with a combat use or the Caster type, and the
 * caller runs PanelUI_AutoWield(obj, 2, 0, 1, 1, 1), the double-click's
 * AutoWield; false (not known, or neither) prints "Only weaponry, shields,
 * and magic items can be auto-wielded" (ClientNotices.combatButtonNotWieldable)
 * through the UI's +0x114 line and takes nothing.
 */
export function combatButtonDropWields(dragged: CombatButtonDragObject | undefined): boolean {
  return combatButtonWields(dragged);
}

/** The combat button's ring / circle (UIItem_DRAG_ACCEPT_TEX's pair). */
export const COMBAT_BUTTON_DRAG_TEX: Readonly<Record<number, number>> = UIITEM_DRAG_ACCEPT_TEX;

/**
 * Where the 32x32 art sits on the combat button: DrawThis @ 0x00501fc0 draws
 * it at ((width - 0x20) / 2, (height - 0x20) / 2), C integer division; the
 * 55x58 button (ctor @ 0x00501950: art 0x37 x 0x3a) → (11, 13).
 */
export function combatButtonDragArtAt(width: number, height: number): { x: number; y: number } {
  return { x: Math.trunc((width - 0x20) / 2), y: Math.trunc((height - 0x20) / 2) };
}

/**
 * VISUAL.ac1999-paperdoll-figure-drag-art — the figure's overlay state for a
 * verdict of paperdollBandDragAcceptState (ring, circle, or null = "already
 * worn"). End of retail keeps the overlay's state on null
 * (HandlePaperDollDragOver @ 004a3a70 sets nothing); the 1999 PaperDollRegion
 * (DragOverAction @ 0x00526f90) draws nothing that frame, so the overlay is
 * cleared. Returns undefined to leave the overlay alone.
 */
export function paperdollFigureDragOverlayState(verdict: number | null, wornDrawsNothing: boolean): number | undefined {
  if (verdict !== null) return verdict;
  return wornDrawsNothing ? DRAG_ACCEPT_STATE.none : undefined;
}

/** The vendor bar's three lists: the wares, the buying list, the selling list. */
export type VendorDragList = 'items' | 'buy' | 'sell';

/**
 * Whether a vendor list's cells carry drag-over art at all. End of retail:
 * only the sell list registers an ItemListDragHandler
 * (VendorSellUI::OnItemListDragOver @ 004c2300). AC1999: all three are
 * ShopLists, whose DragOverAction @ 0x005a95b0 marks the cells for any item drag.
 */
export function vendorListHasDragArt(rule: 'eor' | 'ac1999', list: VendorDragList): boolean {
  return rule === 'ac1999' || list === 'sell';
}

/**
 * A vendor list cell's drag-over state. Null = untouched.
 *
 * End of retail: the sell list alone, VendorSellUI::OnItemListDragOver (`sell`).
 *
 * AC1999 — ShopList_DragOverAction @ 0x005a95b0: for an item drag (UI_Item
 * type 1, or the list's own drag item) every cell's +0x108 becomes 4 (the
 * ring) when ShopList_DragItemAcceptable @ 0x005aa1f0 (silent) passes, 5 (the
 * circle) when not; ShopList_Global_Loop @ 0x005a97f0 flags the cell under the
 * pointer, the only one the UI_Item draw @ 0x004e7d20 paints (a filled cell or
 * one of ShopList_Update @ 0x005aa110's empty pads). The lists' flags:
 *  - the vendor's wares (ItemsEnvPanel, 0x422) carry bit 2: every drag refused;
 *  - the buy list (BuyEnvPanel, 0x544) carries bit 4: only its own drag item,
 *    so an item from a pack, a chest or the paperdoll is refused;
 *  - the sell list (SellEnvPanel, 0x1af9) carries bits 8 and 0x10: an object
 *    the player carries goes on to VendorProfile_InqAcceptability (`sell`, the
 *    same shape as end of retail's DragItemAcceptable); one it does not carry
 *    is refused ("You can only sell items you are carrying" when not silent).
 * `sell` is null for an object the player does not carry. `isPlayer`: the
 * main-pack drag, whose sell-list verdict hangs on 0x004e5530 for the player
 * (not traced), so the sell list leaves it untouched.
 */
export function vendorListDragOverState(
  rule: 'eor' | 'ac1999',
  list: VendorDragList,
  d: { draggedId: number; isPlayer?: boolean; sell: () => number | null },
): number | null {
  if (rule === 'eor') return list === 'sell' ? d.sell() : null;
  if (d.draggedId === 0) return null;
  if (list !== 'sell') return DRAG_ACCEPT_STATE.refuse;
  if (d.isPlayer) return null;
  return d.sell() ?? DRAG_ACCEPT_STATE.refuse;
}

/** An open chest's / corpse's cell: its item row (filled or empty), or its 36x36 container cells. */
export type ExternalContainerCell = 'item' | 'emptyItem' | 'pack';

/**
 * Whether an external-container cell carries drag-over art. End of retail:
 * gmExternalContainerUI::OnItemListDragOver @ 004cbf80, on the item row's
 * filled cells (ours, unchanged). AC1999: the ItemEnvPanel's three lists
 * (ctor @ 0x00538e00: the container's own 36x36 cell, its nested packs' 36x36
 * row, the 32x32 item row) are ItemLists (ctor @ 0x0053a350, the class the
 * inventory's lists use), so every cell takes the ItemList drag-over.
 */
export function externalContainerCellHasDragArt(rule: 'eor' | 'ac1999', cell: ExternalContainerCell): boolean {
  return rule === 'ac1999' || cell === 'item';
}

/**
 * An external-container cell's drag-over state. End of retail: `eor` (the
 * panel's DragItemAcceptable verdict, item cells only). AC1999: `itemList`,
 * the inventory lists' rule (itemListDragOverState 'ac1999'); the 36x36 cells
 * are container cells (UI_Item +0xcc, the third argument of its ctor
 * @ 0x004e6d00, which sizes it 0x24), the item row's are grid cells.
 */
export function externalContainerDragOverState(
  rule: 'eor' | 'ac1999',
  cell: ExternalContainerCell,
  eor: () => number | null,
  itemList: (containerList: boolean) => number | null,
): number | null {
  if (rule === 'eor') return cell === 'item' ? eor() : null;
  return itemList(cell === 'pack');
}
