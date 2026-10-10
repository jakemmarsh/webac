import { isInteriorCellIndex } from '@ac/shared';

/**
 * ObjectMaint — which server objects are "in the world" for this client, and
 * when an object that left it is destroyed (BUG.teleport-leaves-stale-objects).
 *
 * Retail (decompiled acclient, build ac1_sep13 — reference/client-eol):
 *  - An object lives in a CELL. When the cell is released the object leaves
 *    visibility: `CObjCell::release_objects` @ 0052b490 →
 *    `CObjectMaint::ReleaseObjCell` @ 00507bb0 → `CPhysicsObj::leave_visibility`
 *    @ 00514220 (every unparented, non-Static object in the cell). The same
 *    happens to an object whose new position has no loaded cell
 *    (`SetPositionInternal` @ 00515330 / 00515bd0) and to a CreateObject whose
 *    cell is not loaded (`SmartBox::HandleCreateObject` @ 00454c80).
 *  - `prepare_to_leave_visibility` @ 00511f40 takes it (and its children) out
 *    of the cell and queues it: `CObjectMaint::AddObjectToBeDestroyed`
 *    @ 00508f70 → destroy at now + NONVISIBLE_OBJECT_DESTRUCTION_TIME (25 s).
 *  - While it has no cell it is not drawn, its lights are out of every cell
 *    list, and `CPhysicsObj::update_object` @ 00515d10 returns at once: its
 *    animation, scripts, particles and hook sounds stand still.
 *  - Back in a loaded cell (`CObjectMaint::InitObjCell` → `reenter_visibility`,
 *    `prepare_to_enter_world` @ 00511fa0) it leaves the queue
 *    (`RemoveObjectToBeDestroyed` @ 00508440) and carries on.
 *  - `CObjectMaint::UseTime` @ 005089b0 pops expired entries and deletes the
 *    object outright (`DeleteObject` @ 00508460: exit_world, leave_world,
 *    unparent, destructor).
 *  - WHICH cells are loaded: `CellManager::ChangePosition` @ 004559b0. The
 *    viewer in a land cell, or an env cell that is SeenOutside, loads the
 *    landscape grid of `mid_radius` blocks around its (outside) block
 *    (`LScape::update_loadpoint`; mid_radius = Render.LandscapeDrawDistance,
 *    `SmartBox::set_mid_radius` @ 00453180). The viewer in a sealed env cell
 *    releases the whole landscape (`LScape::release_all`) — every outdoor
 *    object leaves visibility — and only env cells stay
 *    (`CEnvCell::flush_cells` @ 0052def0 keeps the viewer's visible cells).
 *
 * ACE mirrors this on the server (ObjectMaint.cs DestructionQueue, 25 s) and
 * never sends a DeleteObject for an object that merely left visibility; it
 * re-sends the CreateObject once its own queue dropped the object.
 *
 * Approximation: the env cells kept are the viewer's whole LANDBLOCK (retail
 * keeps the viewer cell's visible-cell set), so an object in a far room of
 * the same dungeon stays.
 */

/** CObjectMaint::AddObjectToBeDestroyed — seconds a non-visible object survives (globals: 25). */
export const NONVISIBLE_OBJECT_DESTRUCTION_TIME = 25;

export interface ViewerLoadPoint {
  /** The viewer's full cell id (0xXXYYcccc). */
  viewerCellId: number;
  /** The viewer is in an env cell WITHOUT SeenOutside (a dungeon) — the landscape is released. */
  sealed: boolean;
  /** LScape mid_radius in landblocks (Render.LandscapeDrawDistance). */
  midRadius: number;
  /** EnvCell SeenOutside flag for a full env-cell id. */
  isSeenOutside: (cellId: number) => boolean;
}

/**
 * Whether a full cell id is loaded for this viewer (CellManager::ChangePosition
 * + LScape grid + env-cell set, see the module doc).
 */
export function isCellLoaded(cellId: number, v: ViewerLoadPoint): boolean {
  const id = cellId >>> 0;
  if (id === 0) return false;
  const index = id & 0xFFFF;
  const bx = (id >>> 24) & 0xFF;
  const by = (id >>> 16) & 0xFF;
  const vx = (v.viewerCellId >>> 24) & 0xFF;
  const vy = (v.viewerCellId >>> 16) & 0xFF;
  const interior = isInteriorCellIndex(index);
  if (v.sealed) {
    // LScape::release_all — only the dungeon's env cells.
    return interior && bx === vx && by === vy;
  }
  if (Math.max(Math.abs(bx - vx), Math.abs(by - vy)) > v.midRadius) return false;
  if (!interior) return true;
  // An env cell under the landscape grid: a building interior (SeenOutside)
  // is part of the outdoor world; a sealed dungeon cell is not loaded.
  return v.isSeenOutside(id);
}
