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
