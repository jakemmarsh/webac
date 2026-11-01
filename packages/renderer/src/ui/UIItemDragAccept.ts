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

/** Which 0x1000045a base a cell's overlay draws: absent = 0x1000045d. */
export type DragAcceptTemplate = '1000045e' | '1000045f';

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
