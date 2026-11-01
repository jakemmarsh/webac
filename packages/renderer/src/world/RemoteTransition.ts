/**
 * BUG.remote-creature-obstacle-collision — the transition of ANOTHER object's move: retail moves
 * every active physics object, not only the player, through the static world.
 *
 * `CPhysicsObj::update_object @ 00515d10` makes an object within MAX_PHYSICS_DISTANCE (96 m) of the
 * player active (farther ones stop updating), and `UpdateObjectInternal @ 005156b0` then, for an
 * object with physics spheres whose frame moved, runs `CPhysicsObj::transition @ 00512dc0`
 * (`CTransition::find_valid_position` → find_transitional_position → the cells' find_env_collisions
 * and each object's FindObjCollisions) from where it stands to where its motion took it. A failed
 * transition keeps the old origin (set_frame with m_position's origin, the new heading); a
 * successful one places it where the sphere path ended (SetPositionInternal). An object with no
 * spheres is never transitioned (set_frame).
 *
 * Before this a remote creature had none of it: the server's copy (the same physics) stopped at a
 * rock, a tree or a wall while ours ran on through, and every correction (each 0.2 s for a creature
 * mid-moveto on the AC1999 server) pulled it back, a monster "jumping back and forth" that never
 * reached an archer behind a boulder (Jake, AC1999, 2026-11-01).
 *
 * The move goes through the local player's port of the same transition (player/OutdoorMovement.ts
 * stepPlayerMovement: the retail step subdivision, wall slide, step up / step down, the walkable
 * slope rule, open sea, edge slide) with the mover's own shape in the collider
 * (DungeonCollision.withBody), and its ground is found the way the player's is (traceGroundAlongPath
 * / interiorGroundY over getBodyFloorHeight) so it climbs stairs and ramps instead of pushing into
 * them. Which objects stop it is `CPhysicsObj::FindObjCollisions @ 0050f050` (moverBlockedBy).
 */
import { PhysicsState, ObjectDescriptionFlag } from '@ac/shared';
import {
  stepPlayerMovement, type MovementCreatureObstacles, type MovementServices, type MovementTerrain, type MovementWater, type SlideState,
} from '../player/OutdoorMovement.js';
import type { CollisionBodyShape, DungeonCollision } from './DungeonCollision.js';
import { interiorGroundY, outdoorGroundY, standsOnTerrain, traceGroundAlongPath, type OutdoorGroundSources } from './outdoorGround.js';

/** `MAX_PHYSICS_DISTANCE` (m): past this from the player an object is inactive (update_object). */
export const REMOTE_TRANSITION_RANGE = 96;

/** A moving object's shape, × its scale (Setup radius / height / step heights / first two spheres). */
export type RemoteBodyShape = Omit<CollisionBodyShape, 'cell'> & { stepDownHeight: number };

/**
 * The mover's transition shape from its Setup, × scale; null when it has no physics spheres
 * (CPhysicsObj::transition is never run for it: UpdateObjectInternal only set_frames it).
 * CTransition::init_sphere takes at most two spheres; ours are centred on the body's axis (their
 * x / y offsets are dropped, as for the player).
 */
export function remoteBodyShape(
  setup: {
    radius?: number; height?: number; stepUpHeight?: number; stepDownHeight?: number;
    spheres?: readonly { origin?: { z: number }; radius: number }[];
  } | null | undefined,
  scale = 1,
): RemoteBodyShape | null {
  const s = scale || 1;
  const spheres = (setup?.spheres ?? []).filter((sp) => sp.radius > 0);
  if (!setup || spheres.length === 0) return null;
  const h0 = (spheres[0].origin?.z ?? 0) * s;
  const h1 = spheres.length > 1 ? (spheres[1].origin?.z ?? 0) * s : h0;
  return {
    radius: (setup.radius ?? 0) * s,
    height: (setup.height ?? 0) * s,
    stepUpHeight: (setup.stepUpHeight ?? 0) * s,
    stepDownHeight: (setup.stepDownHeight ?? 0) * s,
    sphereRadius: spheres[0].radius * s,
    sphereHeights: [h0, h1],
  };
}

/** The PhysicsState / ObjectDescription bits FindObjCollisions reads of a mover or an obstacle. */
export interface CollisionParty {
  physicsState: number;
  objectDescFlags: number;
}

const PK = ObjectDescriptionFlag.PlayerKiller;
const PKL = ObjectDescriptionFlag.PkLiteStatus;

/**
 * `CPhysicsObj::FindObjCollisions @ 0050f050` from the obstacle's side, for a mover (no viewer,
 * no missile — missiles fly in MissilePhysics):
 *  - an Ethereal obstacle (state 0x4) never stops it, and an Ethereal mover passes every obstacle
 *    that is not Static (state 0x1) (the `local_c` branch: the hit is recorded and passed);
 *  - a player moving into a player is exempt unless both are PK or both PK-Lite (OBJECTINFO
 *    0x100 IsPlayer with the weenie's IsPlayer / IsPK / IsPKLite; the `bVar9` branch);
 *  - every other pair collides: a creature is stopped by creatures and by players alike (retail's
 *    client sets no IgnoreCreatures, OBJECTINFO 0x400, for any object it moves).
 */
export function moverBlockedBy(mover: CollisionParty, obstacle: CollisionParty): boolean {
  if (obstacle.physicsState & PhysicsState.Ethereal) return false;
  if ((mover.physicsState & PhysicsState.Ethereal) && !(obstacle.physicsState & PhysicsState.Static)) return false;
  if ((mover.objectDescFlags & ObjectDescriptionFlag.Player) && (obstacle.objectDescFlags & ObjectDescriptionFlag.Player)) {
    const bothPk = (mover.objectDescFlags & PK) !== 0 && (obstacle.objectDescFlags & PK) !== 0;
    const bothPkl = (mover.objectDescFlags & PKL) !== 0 && (obstacle.objectDescFlags & PKL) !== 0;
    return bothPk || bothPkl;
  }
  return true;
}

/** The static world a remote move collides with (main.ts wires the player's own). */
export interface RemoteTransitionWorld {
  /** The landscape's collision: buildings, their cells, statics, scenery. */
  readonly outdoor: DungeonCollision;
  /** The dungeon's collision while the player is in one (null outdoors). */
  readonly dungeon: DungeonCollision | null;
  readonly terrain: MovementTerrain;
  readonly water: MovementWater;
  /** ObjCell::get_water_depth at three.js (x, z): how deep a body on the terrain there wades (0 = dry). */
  waterDepthAt(worldX: number, worldZ: number): number;
}

/** One remote move: AC axes (x east, y north, z up; the origin is the feet). */
export interface RemoteMove {
  shape: RemoteBodyShape;
  /** The mover's cell (0xXXYYcccc). */
  cell: number;
  from: { x: number; y: number; z: number };
  /** Where its motion took it this frame (only x / y are collided). */
  to: { x: number; y: number };
  /** Off the ground (no contact): the move is collided without the walkable rules (stepPlayerMovement's airborne branch). */
  airborne: boolean;
  /** PhysicsState EdgeSlide (0x400000) → OBJECTINFO 0x200 (get_object_info @ 00511cc0). */
  edgeSlide: boolean;
  /** CPhysicsObj::sliding_normal, kept between the mover's transitions. */
  slide: SlideState;
  /** Register what stops the mover near (x, z) for this move (creatures, doors, our character); null = nothing. */
  obstacles: MovementCreatureObstacles | null;
  /** Also find the ground under the result (a grounded body walking on its own motion). */
  wantGround: boolean;
}

export interface RemoteMoveResult {
  /** Where the transition left the mover (AC x / y). */
  x: number;
  y: number;
  /** The ground under it (AC z), or null when not asked / none found. */
  groundZ: number | null;
  /** The ground is the terrain itself (not a building's or a cell's floor). */
  onTerrain: boolean;
  /** The transition stopped or turned the move. */
  blocked: boolean;
}

/** Which collision world holds a body in `cell`: the landscape, the dungeon, or none we know of. */
export function remoteCollider(world: RemoteTransitionWorld, cell: number): { collider: DungeonCollision; inDungeon: boolean } | null {
  if ((cell & 0xffff) < 0x100) return { collider: world.outdoor, inDungeon: false };
  if (world.outdoor.hasCell(cell)) return { collider: world.outdoor, inDungeon: false };
  if (world.dungeon?.hasCell(cell)) return { collider: world.dungeon, inDungeon: true };
  return null;
}

/**
 * Run one remote move through the transition. Null when the mover's cell is in no collision world
 * we hold (a dungeon the player is not in): its motion then stands as before.
 */
export function remoteTransition(world: RemoteTransitionWorld, move: RemoteMove): RemoteMoveResult | null {
  const where = remoteCollider(world, move.cell);
  if (!where) return null;
  const { collider, inDungeon } = where;
  const { shape } = move;
  const dx = move.to.x - move.from.x;
  const dy = move.to.y - move.from.y;
  // three.js axes: x = AC x, z = AC y, y = AC z.
  const fx = move.from.x, fz = move.from.y, feet = move.from.z;
  return collider.withBody({ ...shape, cell: move.cell }, () => {
    const outdoor = world.outdoor;
    const landReachable = (x: number, z: number, footY: number): boolean => outdoor.reachesLandCells(x, z, footY);
    const cellAt = (x: number, z: number, footY: number): number => outdoor.findCellContaining(x, z, footY + outdoor.lowerSphereHeight, move.cell);
    const groundSources: OutdoorGroundSources = {
      terrainHeight: (x, z) => world.terrain.getHeightAt(x, z),
      floorHeight: outdoor.hasCells
        ? (x, z, fromY, maxDrop, bodyFeetY) => outdoor.getBodyFloorHeight(x, z, fromY, shape.stepDownHeight, maxDrop, bodyFeetY)
        : null,
      cellAt,
      landReachable,
    };
    const services: MovementServices = {
      dungeonCollision: inDungeon ? collider : null,
      outdoorCollision: outdoor,
      terrain: world.terrain,
      water: world.water,
      creatureObstacles: move.obstacles,
      defaultPlayerRadius: shape.radius,
      slide: move.slide,
      edgeSlide: move.edgeSlide,
      stepDownHeight: shape.stepDownHeight,
      groundAt: (x, z, fromY) => outdoorGroundY(groundSources, x, z, fromY),
      landReachable,
      dungeonGroundAt: (x, z, fromY) => (inDungeon ? collider.getFloorHeight(x, z, fromY, Infinity) : null),
    };
    const step = stepPlayerMovement(
      { x: fx, z: fz, floorY: feet, inDungeon, airborne: move.airborne, jumpVelocityX: dx, jumpVelocityZ: dy },
      dx, dy, 1, services,
    );
    const blocked = Math.abs(step.x - move.to.x) > 1e-6 || Math.abs(step.z - move.to.y) > 1e-6;
    let groundZ: number | null = null;
    let onTerrain = false;
    if (move.wantGround && !move.airborne) {
      // The floor search starts at the last ground plus the move's step up (floorSearchFromY).
      const fromY = feet + collider.lastStepUp;
      if (inDungeon) {
        groundZ = collider.hasCells
          ? interiorGroundY(
            {
              floorHeight: (x, z, y, maxDrop) => collider.getBodyFloorHeight(x, z, y, shape.stepDownHeight, maxDrop),
              cellAt: (x, z, footY) => collider.findCellContaining(x, z, footY + collider.lowerSphereHeight, move.cell),
            },
            fx, fz, step.x, step.z, fromY, collider.transitionSphereRadius, feet,
          )
          : null;
      } else {
        groundZ = traceGroundAlongPath(
          (x, z, y) => outdoorGroundY(groundSources, x, z, y, { fallbackY: feet }),
          fx, fz, step.x, step.z, fromY, outdoor.transitionSphereRadius,
        );
        // GAP.6 — on the terrain a body wades: its contact plane is the water depth under the surface.
        if (groundZ !== null && standsOnTerrain(groundSources, step.x, step.z, groundZ)) {
          onTerrain = true;
          groundZ -= world.waterDepthAt(step.x, step.z);
        }
      }
    }
    return { x: step.x, y: step.z, groundZ, onTerrain, blocked };
  });
}
