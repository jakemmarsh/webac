import { isInteriorCellIndex } from '@ac/shared';
import { objectRingRadius } from './LandscapeDrawDistance.js';

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
 *  - …but only the FULL-DETAIL blocks of that grid have cells an object can
 *    stand in (BUG.ghost-objects, 2026-10-11): `LScape::get_landblock`
 *    @ 00505e40 returns null for any block whose side_cell_count is not 8,
 *    `CLandBlock::init_dyn_objs` @ 0052f3b0 runs only on those, and a block
 *    that drops out of full detail releases its objects
 *    (`CLandBlock::notify_change_size` @ 005302c0 → `release_objs` @ 0052f350
 *    → `CObjCell::release_objects`) and its building cells
 *    (`CEnvCell::release_visible`). Full detail is the 3×3 around the viewer
 *    (`LScape::get_block_orient` @ 00504f90, LandscapeDrawDistance.ts
 *    `objectRingRadius`), whatever the Landscape Draw Distance: the rest of
 *    the grid is terrain only.
 *  - A teleport (`SmartBox::TeleportPlayer` @ 00453910 → PlayerPositionUpdated
 *    (1) → `ChangePosition(…, 1)`) releases the whole landscape at once; what
 *    the destination's 3×3 loads again comes back, the rest is queued.
 *
 * ACE mirrors this on the server (ObjectMaint.cs DestructionQueue, 25 s; the
 * visible set outdoors is the player's landblock + its adjacents,
 * ObjectMaint.GetVisibleObjects — the same 3×3) and never sends a
 * DeleteObject for an object that merely left visibility: one that dies,
 * moves or is re-spawned (a landblock reload re-mints dynamic guids) while
 * the player is away is simply never mentioned again (Landblock.cs
 * RemoveWorldObjectInternal sends DeleteObject only to players that still
 * know it). It re-sends the CreateObject once its own queue dropped the
 * object. GDLE (Dark Majesty / AC1999 servers) does the same with its 3×3
 * ExchangePVS and 25 s awareness cache (WorldLandBlock.cpp, Player.cpp
 * AlreadyMadeAwareOf). A client that keeps objects past the 3×3 therefore
 * shows ghosts: monsters that died while the player was away, a fellow who
 * recalled to a lifestone, an NPC twice under two guids.
 *
 * A sealed viewer keeps only its own cell and that cell's visible cells
 * (`CEnvCell::grab_visible_cells` @ 0052e220 adds the cell and its stab
 * list to visible_cell_table; `release_cells` moves the old set to
 * cell_flush_table and `flush_cells` @ 0052def0 releases the objects of every
 * cell not grabbed again). ACE keys the dungeon's updates on the same set
 * (ObjectMaint.GetVisibleObjects(EnvCell): the cell + VisibleCells) and
 * forgets an object 25 s after it left it. Keeping the whole landblock (the
 * approximation before 2026-10-15) left ghosts in every far room: drudges
 * that died while out of sight stayed alive and targetable ("the server has
 * no Drudge Hoarder where you are", Arwic Mines 0x01E301F2, stream players
 * 2026-10-15). Without the viewer cell's stab list (`visibleCells` absent or
 * the cell unreadable) the whole landblock stays, as before.
 */

/** CObjectMaint::AddObjectToBeDestroyed — seconds a non-visible object survives (globals: 25). */
export const NONVISIBLE_OBJECT_DESTRUCTION_TIME = 25;

export interface ViewerLoadPoint {
  /** The viewer's full cell id (0xXXYYcccc). */
  viewerCellId: number;
  /** The viewer is in an env cell WITHOUT SeenOutside (a dungeon) — the landscape is released. */
  sealed: boolean;
  /**
   * LScape mid_radius in landblocks (Render.LandscapeDrawDistance). Only its
   * full-detail ring holds object cells (objectRingRadius: the 3×3).
   */
  midRadius: number;
  /** EnvCell SeenOutside flag for a full env-cell id. */
  isSeenOutside: (cellId: number) => boolean;
  /**
   * The viewer env cell's VisibleCells (its stab list: cell indices, low 16
   * bits) — what a sealed viewer keeps besides its own cell; null when the
   * cell can't be read.
   */
  visibleCells?: (cellId: number) => ReadonlySet<number> | readonly number[] | null;
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
    // LScape::release_all — only the dungeon's env cells, and of those the
    // viewer cell and its visible cells (CEnvCell::grab_visible_cells).
    if (!interior || bx !== vx || by !== vy) return false;
    if (id === (v.viewerCellId >>> 0) || !isInteriorCellIndex(v.viewerCellId & 0xFFFF)) return true;
    const seen = v.visibleCells?.(v.viewerCellId >>> 0);
    if (!seen) return true;
    return Array.isArray(seen) ? seen.includes(index) : (seen as ReadonlySet<number>).has(index);
  }
  // LScape::get_landblock: a block outside the full-detail ring has no cells.
  if (Math.max(Math.abs(bx - vx), Math.abs(by - vy)) > objectRingRadius(v.midRadius)) return false;
  if (!interior) return true;
  // An env cell under the landscape grid: a building interior (SeenOutside)
  // is part of the outdoor world; a sealed dungeon cell is not loaded.
  return v.isSeenOutside(id);
}
