/**
 * RECON.inventory-grid-dat-cells.b.a — when the inventory's item list shows an
 * object pending (UIElement_ItemList::m_pendingItem: its icon ghosted with
 * 0x10000349 in the cell it is headed for, until the server answers).
 *
 *  - CPlayerSystem::PlaceInBackpack @ 0055d8c0 sends ShowPendingInPlayer
 *    before AttemptToPlaceInContainer, and EndPendingInPlayer when that sends
 *    nothing. gmInventoryUI::RecvNotice_ShowPendingInPlayer @ 004a6b50 skips a
 *    container (IsContainer) and inserts the rest at index 0.
 *  - UIElement_ItemList::AcceptDragObject @ 004e4250 inserts the dragged
 *    object at the drop cell (WhatNum, clamped to GetNumUIItems) only when the
 *    placement goes into the list's own container (uVar9 == parentContainerID:
 *    not a merge, not onto a pack cell).
 */
import type { PlacementResult } from './ItemHolderPlacement.js';

/** RecvNotice_ShowPendingInPlayer's index (null = no pending item: a container). */
export function placeInBackpackPendingIndex(isContainer: boolean): number | null {
  return isContainer ? null : 0;
}

/**
 * AcceptDragObject's pending index for a drop on the item list of
 * `listContainerId`, or null when the placement shows none. `cellIndex` is the
 * drop cell's index (undefined = an empty cell past the items).
 */
export function itemListDropPendingIndex(
  result: PlacementResult, listContainerId: number, cellIndex: number | undefined, itemCount: number,
): number | null {
  if (result.kind !== 'put' && result.kind !== 'split') return null;
  if (result.containerId !== listContainerId) return null;
  const at = cellIndex === undefined ? itemCount : cellIndex;
  return Math.max(0, Math.min(at, itemCount));
}
