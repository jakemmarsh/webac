/**
 * BUG.bunker-camera-in-head — the surface camera boom's collision sweep with
 * retail's cell rule (SmartBox::update_viewer @ 00453ce0: CTransition with
 * init_object(player, 0x5c) IsViewer | PathClipped | FreeRotate |
 * PerfectClip, the 0.3 m viewer sphere, from the player's cell).
 *
 * Outdoors the boom meets everything: building shells and land objects
 * (DungeonCollision's render meshes and cylinders) and the terrain. From an
 * env cell the viewer meets its cell's geometry always, and the land cells
 * only out through an outside portal (viewerLandFrom); the terrain then only
 * where the step crosses its plane (viewerTerrainStepCollides). Before this,
 * from the stairs of a classic town bunker (A9B4 0x187) or the top of the end
 * of retail drudge statue ramp (A9B4 0x176–0x178) the terrain overhead and
 * the hut's / pedestal's shell clipped the whole boom and the camera sat in
 * the player's head.
 */
import type * as THREE from 'three';
import type { TerrainCollision } from '@ac/shared';
import { DungeonCollision } from '../world/DungeonCollision.js';
import { viewerBeginsIndoors, viewerLandFrom } from './RetailCamera.js';

/** What the sweep reads: the surface collision world (shells, cells, land objects), the terrain, each cell's SeenOutside flag. */
export interface SurfaceViewerWorld {
  collision: Pick<DungeonCollision, 'getCameraDistance' | 'findCellContaining' | 'viewerReachesLand'>;
  terrain: Pick<TerrainCollision, 'getCameraDistance'>;
  seenOutside(cellId: number): boolean;
}

/**
 * The clipped boom length from `pivot` (THREE world) along (behindX, behindY
 * up, behindZ) for a sought length `maxDist`, with the player in
 * `playerCellId` (an outdoor cell, or a surface building's env cell).
 */
export function surfaceViewerDistance(
  world: SurfaceViewerWorld, playerCellId: number, pivot: THREE.Vector3,
  behindX: number, behindY: number, behindZ: number, maxDist: number,
): number {
  let landFrom = 0;
  let beganIndoors = false;
  if ((playerCellId & 0xffff) >= 0x100) {
    // AC global (x, y, z up) = THREE (x, z, y).
    const pivotCell = world.collision.findCellContaining(pivot.x, pivot.z, pivot.y, playerCellId);
    beganIndoors = viewerBeginsIndoors(playerCellId, pivotCell, world.seenOutside(playerCellId));
    const len = Math.sqrt(behindX * behindX + behindY * behindY + behindZ * behindZ);
    if (beganIndoors && len > 0.001) {
      const ux = behindX / len, uy = behindY / len, uz = behindZ / len;
      const r = DungeonCollision.VIEWER_SPHERE_RADIUS;
      landFrom = viewerLandFrom(maxDist, r,
        (t) => world.collision.viewerReachesLand(pivot.x + ux * t, pivot.z + uz * t, pivot.y + uy * t, r));
    }
  }
  return Math.min(
    world.collision.getCameraDistance(pivot, behindX, behindZ, maxDist, behindY, landFrom),
    world.terrain.getCameraDistance(pivot.x, pivot.y, pivot.z, behindX, behindZ, maxDist, behindY,
      beganIndoors ? { landFrom, beganIndoors } : undefined),
  );
}

/**
 * The viewer's cell for SmartBox::RenderNormalMode @ 00453aa0 (outdoors:
 * useSunlightSet(1), no pool lights; else the cell's lights): the camera's
 * position, not the player's. An outdoor player's viewer stays outdoors; from
 * an env cell, the env cell holding the clipped camera, else outdoors for a
 * SeenOutside cell (the boom left by its doorway) or the player's own cell
 * (a sealed cell holds its viewer; AdjustPosition, ACE PhysicsObj.cs:232-262).
 * 0 = outdoors.
 */
export function surfaceViewerCell(
  world: Pick<SurfaceViewerWorld, 'seenOutside'> & { collision: Pick<DungeonCollision, 'findCellContaining'> },
  playerCellId: number, camera: THREE.Vector3,
): number {
  if ((playerCellId & 0xffff) < 0x100) return playerCellId;
  const cell = world.collision.findCellContaining(camera.x, camera.z, camera.y, playerCellId);
  if (cell !== 0) return cell;
  return world.seenOutside(playerCellId) ? 0 : playerCellId;
}
