/**
 * BUG.seen-outside-arrival-dungeon-mode — which movement mode an arrival
 * (login or teleport) puts the player in, from the arrival cell.
 *
 * Retail has no "dungeon mode": every cell lives in one cell array, and a
 * body walking out of a building's doorway joins the landscape because
 * CEnvCell::find_transit_cells @ 0052c820 calls
 * CLandCell::add_all_outside_cells for a portal whose other_cell_id is
 * 0xFFFFFFFF. Our client keeps two collision worlds: the outdoor one
 * (terrain + every registered surface interior cell, what a walk-in uses)
 * and the interior one (a sealed landblock's cells only, no terrain). An
 * interior cell with SeenOutside set (EnvCellFlags 0x01 — a surface
 * building: the Holtburg tavern vestibule 0xA9B40165) is reachable from
 * the landscape, so arriving in it must use the outdoor world; otherwise
 * the doorway's floor edge reads as a ledge (no terrain beyond it) and the
 * player can never walk out. Only a sealed cell (SeenOutside clear — a real
 * dungeon) is interior mode. AC1999 and Dark Majesty read the same DAT
 * flag, so the rule is era-independent.
 */

import { isInteriorCellIndex, cellIndexOf } from '@ac/shared';

export type ArrivalMode =
  /** Outdoor movement: terrain + surface cells. `surfaceCellId` is the full arrival
   *  cell id when it is a SeenOutside interior cell (seeds the surface-cell state), else 0. */
  | { readonly kind: 'outdoor'; readonly surfaceCellId: number }
  /** Interior ("dungeon") movement: the arrival landblock's cells, no terrain. */
  | { readonly kind: 'interior' };

/**
 * The movement mode for arriving at full cell id `cellId` (0xXXYYCCCC).
 * `isSeenOutside` reads the EnvCell's SeenOutside flag from the DAT
 * (unreadable → false, i.e. sealed).
 */
export function arrivalMode(cellId: number, isSeenOutside: (cellId: number) => boolean): ArrivalMode {
  const id = cellId >>> 0;
  if (!isInteriorCellIndex(cellIndexOf(id))) return { kind: 'outdoor', surfaceCellId: 0 };
  if (isSeenOutside(id)) return { kind: 'outdoor', surfaceCellId: id };
  return { kind: 'interior' };
}

/**
 * The arrival after the landscape objects around it are built: a surface
 * arrival whose cell the outdoor collision does not hold (a SeenOutside
 * cell no building doorway reaches, so the streamer registered no
 * collision for it) falls back to interior mode, which builds the whole
 * landblock's cells — the body keeps a floor instead of dropping to the
 * terrain under the building.
 */
export function confirmSurfaceArrival(mode: ArrivalMode, cellRegistered: (cellId: number) => boolean): ArrivalMode {
  if (mode.kind === 'outdoor' && mode.surfaceCellId !== 0 && !cellRegistered(mode.surfaceCellId)) {
    return { kind: 'interior' };
  }
  return mode;
}
