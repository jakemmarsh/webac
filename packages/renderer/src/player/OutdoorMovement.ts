/**
 * DEBT.main-ts-extractions — one physics substep of the local player's
 * horizontal movement, lifted out of main.ts animate() (the retail MAX_QUANTUM
 * substep loop) as a pure function of (state, input delta, collision
 * services) → new position.
 *
 * Grounded: the camera controller's input delta for the substep is wall-slid
 * through the active collision world (dungeon cells, or the outdoor
 * building / static / scenery world), then — outdoors — GAP.5 rejects
 * ascending onto unwalkable terrain and GAP.6 rejects entering a
 * landblock of open sea (EntirelyWater); finally the player is pushed out of creature
 * cylinders (only when it moved — retail never displaces an idle player).
 *
 * Airborne: the preserved jump momentum drives the step instead of input.
 * ACE runs every airborne transition through the same environment +
 * object collision as a grounded one — LandCell.FindEnvCollisions returns
 * Collided for a non-viewer, non-missile object entering an EntirelyWater
 * landblock regardless of contact (LandCell.cs:54-58), and FindObjCollisions
 * stops the sphere at walls. The in-closure code this replaces applied jump
 * momentum with no check at all, so a jump carried the player through
 * building walls and out over deep water (fixed here: the momentum delta is
 * wall-slid and water-gated like a grounded step). GAP.5's slope rule is a
 * contact-plane rule (is_valid_walkable on the landing polygon), so it does
 * not gate the airborne step.
 */
import * as THREE from 'three';
import { LandWaterType, TerrainCollision } from '@ac/shared';
import { bounceVelocity, slideStep, type Vec3 } from './SteepSlide.js';

/** A collision world that slides a horizontal move along its walls (DungeonCollision). */
export interface MovementCollider {
  /** `pos.y` is the floor height the body spheres stack on; returns the adjusted (dx, dz). */
  getAdjustedMovement(pos: THREE.Vector3, deltaX: number, deltaZ: number): [number, number];
  /** Per-heritage player cylinder radius (BUG.collision-radius-step-up-hardcoded-human). */
  readonly playerRadius: number;
  /**
   * The body-sphere radius a transition is subdivided by (retail
   * CTransition::calc_num_steps uses local_sphere[0].radius). Falls back to
   * playerRadius when a collider doesn't expose one.
   */
  readonly transitionSphereRadius?: number;
  /** Step-up height the last getAdjustedMovement resolved (0 = none); main.ts biases floor search by it. */
  lastStepUp?: number;
  /**
   * COLLISIONINFO::collision_normal: the horizontal outward normal (XZ, unit)
   * of the last wall / obstacle getAdjustedMovement slid on or stopped at.
   * The sweep clears it when a transition starts; the collider only sets it.
   */
  collisionNormal?: { x: number; z: number } | null;
  /**
   * RECON.transition-stepup-stepdown-port.b — the walkable BSP polygon under
   * the body and the edge a step to (destX, destZ) crosses
   * (DungeonCollision.precipiceEdge). Null = not on a BSP floor.
   */
  precipiceEdge?(
    x: number, z: number, floorY: number, destX: number, destZ: number,
  ): { edge: Normal | null; floorNormal: Normal } | null;
  /**
   * RECON.transition-stepup-stepdown-port.e — the step down at (destX,
   * destZ) for a body at (x, z) whose ground was `fromY` lands on a walkable it does
   * not fit on (StepDown's Placement insert fails), so the step has no
   * contact plane and is refused (DungeonCollision.stepDownBlocked).
   */
  stepDownBlocked?(x: number, z: number, destX: number, destZ: number, fromY: number, stepDownHeight: number): boolean;
}

/**
 * The player's sliding normal (CPhysicsObj::sliding_normal + transient_state
 * Sliding, 0x4): what the last transition ended with, carried into the next
 * one (CPhysicsObj::get_object_info @ 00511cc0 → CTransition::init_sliding_normal).
 */
export interface SlideState {
  slidingNormal: { x: number; z: number } | null;
}

export interface MovementTerrain {
  /** GAP.5 — normal.Z >= PhysicsGlobals.FloorZ (PhysicsObj.cs:2861). */
  isWalkable(worldX: number, worldZ: number): boolean;
  getHeightAt(worldX: number, worldZ: number): number | null;
  /** The terrain triangle's plane normal, Three.js Y-up (CLandCell::find_terrain_poly's polygon). */
  getTriangleNormalAt(worldX: number, worldZ: number): { x: number; y: number; z: number } | null;
}

export interface MovementWater {
  /**
   * GAP.6 — the water type of the LANDBLOCK under a world position (shared/physics/WaterMap): retail's gate is
   * CObjCell::get_block_water_type, so only a block of open sea (every cell fully flooded) stops a player; a
   * flooded cell of a river or lake is waded.
   */
  blockWaterTypeAt(worldX: number, worldZ: number): LandWaterType | null;
}

/**
 * Register the creatures that block us near (x, z) in `collider` for one
 * transition; returns the undo (VERIFY.position-drift-beside-fighting-
 * creature.a.a — they collide inside the transition, like scenery).
 */
export type MovementCreatureObstacles = (collider: MovementCollider, x: number, z: number, range: number) => () => void;

export interface MovementServices {
  dungeonCollision: MovementCollider | null;
  outdoorCollision: MovementCollider;
  terrain: MovementTerrain;
  water: MovementWater;
  /** Adds the creatures near (x, z) to a collider for one step; null before the server object manager exists. */
  creatureObstacles: MovementCreatureObstacles | null;
  /** Radius used when no collision world resolved one (DungeonCollision.PLAYER_RADIUS). */
  defaultPlayerRadius: number;
  /** The player's sliding normal, kept between transitions (MOVE.slide-speed-around-sphere). */
  slide?: SlideState;
  /**
   * The player's PhysicsState carries EdgeSlide (0x00400000): get_object_info
   * then sets OBJECTINFO 0x200, which arms CTransition::edge_slide. ACE sends
   * it for every player (PhysicsGlobals.DefaultState).
   */
  readonly edgeSlide: boolean;
  /** Setup.StepDownHeight * scale (ObjectInfo.StepDownHeight), m. */
  readonly stepDownHeight: number;
  /**
   * The outdoor ground at (x, z) searched from fromY (outdoorGroundY: a BSP
   * floor or the terrain). The terrain edge rule only runs where the terrain
   * is the contact; null/absent = terrain only.
   */
  groundAt?: (worldX: number, worldZ: number, fromY: number) => number | null;
  /**
   * The nearest walkable below fromY inside a dungeon (DungeonCollision
   * getFloorHeight with no drop limit); null/absent = none known. The
   * dungeon step's precipice rule measures the drop with it.
   */
  dungeonGroundAt?: (worldX: number, worldZ: number, fromY: number) => number | null;
}

export interface MovementStepState {
  /** Player world X / Z (three.js axes: AC X / AC Y). */
  x: number;
  z: number;
  /** Last floor-aware ground Y — the collision probe's floor height. */
  floorY: number;
  inDungeon: boolean;
  airborne: boolean;
  /** Preserved horizontal jump momentum, m/s (used while airborne). */
  jumpVelocityX: number;
  jumpVelocityZ: number;
  /**
   * RECON.transition-stepup-stepdown-port.a — in contact with an unwalkable
   * terrain face (player/SteepSlide.ts): the body's velocity, three.js axes.
   * Null / absent = on a walkable.
   */
  slideVelocity?: Vec3 | null;
}

export interface MovementStepResult {
  x: number;
  z: number;
  /** The camera's own input motion must be undone (position is driven by momentum / dungeon collision). */
  revertCamera: boolean;
  /** The slide's velocity after the substep (only when state.slideVelocity was set). */
  slideVelocity?: Vec3;
  /** The slide substep's transition moved the body (validate_transition's _redo); false = stationary. */
  slideMoved?: boolean;
}

/** Creatures are only registered as obstacles within this range of the player, m. */
export const CREATURE_OBSTACLE_RANGE = 15;

const scratchProbe = new THREE.Vector3();

/**
 * BUG.max-quantum-server-value — retail CTransition::calc_num_steps
 * @0050a0b0 (ACE Transition.CalcNumSteps, Transition.cs:97-127): a
 * non-viewer transition of length `dist` is swept in
 * ceil(dist / (TRANSITIONAL_PERCENT_OF_RADIUS * sphere.radius)) equal steps
 * when that ratio exceeds 1 (TRANSITIONAL_PERCENT_OF_RADIUS = 1.0,
 * globals.tsv), otherwise as one step. Our collision world only tests the
 * destination of each call, so this subdivision is what keeps a hitch
 * substep (up to MAX_QUANTUM = 0.2s of travel) from tunnelling through a
 * wall or post. A normal frame's move is shorter than the ~0.48m body
 * sphere radius and stays a single call — behaviour identical to before.
 */
export const TRANSITIONAL_PERCENT_OF_RADIUS = 1.0;

/** Number of transition steps retail sweeps a (dx, dz) move in; 0 for no motion. */
export function transitionNumSteps(dx: number, dz: number, sphereRadius: number): number {
  if (dx === 0 && dz === 0) return 0;
  const ratio = Math.sqrt(dx * dx + dz * dz) / (TRANSITIONAL_PERCENT_OF_RADIUS * sphereRadius);
  return ratio > 1 ? Math.ceil(ratio) : 1;
}

/** F_EPSILON (0.0002): find_transitional_position stops on a step offset shorter than this. */
const F_EPSILON = 0.0002;

/**
 * Run `adjust` over the retail transition steps of (dx, dz), advancing the
 * probe position through each step's adjusted result. A fully-blocked step
 * ends the sweep (every later step would re-test the same position and
 * delta). The collider's lastStepUp is left at the largest step-up any step
 * resolved, so main.ts's floor-search bias still sees it.
 *
 * MOVE.slide-speed-around-sphere — CTransition::find_transitional_position
 * @ 0050bdf0 runs each step's offset through CTransition::adjust_offset
 * @ 0050a370 first: while the sliding normal is valid and the step still
 * pushes into it (offset · normal < 0) the offset is projected onto the
 * slide line, cross(contact normal, sliding normal); a step that no longer
 * pushes into it clears it. The sliding normal is then cleared, the step is
 * inserted, and validate_transition @ 0050aa70 makes the transition's
 * collision normal (kept for the whole transition, COLLISIONINFO::init only
 * runs when a transition starts) the sliding normal again. What the last step
 * leaves is the player's sliding normal for its next transition
 * (get_object_info → init_sliding_normal). So a step after a slide off a
 * round obstacle follows the tangent at the previous contact, which leads
 * away from it, and the next one hits it again and slides from where the
 * body is: retail loses ground going round a sphere that a fresh per-step
 * tangent slide does not.
 *
 * BUG.airborne-head-on-slide-sticks — an airborne body's offset is 3-D in
 * retail: adjust_offset (no contact plane) removes only its part into the
 * sliding normal, so a step pushing straight into it keeps its vertical part
 * and is still inserted, with SlidingNormalValid cleared first (ACE
 * Transition.cs FindTransitionalPosition), and a step that hits nothing
 * leaves no sliding normal. Here the vertical part is the frame's arc
 * (advanceAirborneFrame), so an `airborne` step whose sideways part
 * projects to nothing is that vertical-only step: it hits nothing sideways
 * and clears the sliding normal, and the next step tries the full offset
 * again. Without that, a jump straight at a fence (the AC1999 balcony,
 * 2026-10-16) kept the fence's normal from its first contact for the whole
 * flight and never went over it. A grounded step still ends there.
 */
function sweepTransition(
  collider: MovementCollider,
  x: number, z: number, dx: number, dz: number,
  adjust: (x: number, z: number, dx: number, dz: number) => [number, number],
  slide?: SlideState,
  airborne = false,
): [number, number] {
  const n = transitionNumSteps(dx, dz, collider.transitionSphereRadius ?? collider.playerRadius);
  if (n === 0) return [0, 0];
  const sx = dx / n;
  const sz = dz / n;
  let totX = 0;
  let totZ = 0;
  let maxStepUp = 0;
  collider.collisionNormal = null;
  let sliding = slide?.slidingNormal ?? null;
  for (let i = 0; i < n; i++) {
    let ox = sx;
    let oz = sz;
    if (sliding) {
      const into = ox * sliding.x + oz * sliding.z;
      if (into < 0) {
        // The slide line on a level contact plane: the normal's horizontal perpendicular.
        const tx = -sliding.z;
        const tz = sliding.x;
        const along = ox * tx + oz * tz;
        ox = along * tx;
        oz = along * tz;
      }
    }
    if (ox * ox + oz * oz < F_EPSILON * F_EPSILON) {
      if (!airborne) break;
      sliding = null;
      continue;
    }
    const [ax, az] = adjust(x + totX, z + totZ, ox, oz);
    maxStepUp = Math.max(maxStepUp, collider.lastStepUp ?? 0);
    sliding = collider.collisionNormal ?? null;
    if (ax === 0 && az === 0) break;
    totX += ax;
    totZ += az;
  }
  if (slide) slide.slidingNormal = sliding;
  if (collider.lastStepUp !== undefined) collider.lastStepUp = maxStepUp;
  return [totX, totZ];
}

/**
 * Outdoor wall-slide + GAP.5 slope + GAP.6 water for one horizontal delta,
 * swept in retail transition steps (sweepTransition).
 * `slopeGate` is false for airborne steps (a contact-plane rule).
 */
function outdoorAdjusted(
  state: MovementStepState, dx: number, dz: number, services: MovementServices, slopeGate: boolean,
): [number, number] {
  return withCreatures(services, services.outdoorCollision, state, () =>
    sweepTransition(services.outdoorCollision, state.x, state.z, dx, dz,
      (x, z, sx, sz) => outdoorAdjustedStep(x === state.x && z === state.z ? state : { ...state, x, z },
        sx, sz, services, slopeGate), services.slide, state.airborne));
}

/**
 * Run one collided move with the nearby creatures registered in `collider`
 * (ACE PhysicsObj.FindObjCollisions runs inside the mover's transition), and
 * take them out again whatever happens.
 */
function withCreatures<T>(
  services: MovementServices, collider: MovementCollider, state: MovementStepState, move: () => T,
): T {
  const undo = services.creatureObstacles?.(collider, state.x, state.z, CREATURE_OBSTACLE_RANGE);
  try {
    return move();
  } finally {
    undo?.();
  }
}

/** PhysicsGlobals.EPSILON (0.0002): ObjectInfo.ValidateWalkable's contact tolerance. */
const PHYSICS_EPSILON = 0.0002;
/** CTransition::transitional_insert(3) — the insertion attempts of one transition step. */
const TRANSITION_INSERT_ATTEMPTS = 3;
/** ObjCell.get_water_depth's deepest wade (0.45 m): a feet height this far under the terrain is still on it. */
const MAX_WADE_DEPTH = 0.45;
/** PhysicsGlobals.FloorZ — the walkable z (ObjectInfo.GetWalkableZ). */
const FLOOR_Z = TerrainCollision.ACE_FLOOR_Z;

type Normal = { x: number; y: number; z: number };

/**
 * The terrain under (x, z) when it is the player's contact plane and
 * walkable (ObjectInfo OnWalkable on a land cell): no BSP floor stands over
 * it there. Its height is the feet height the step-down measures from (a
 * wade sinks both ends of a step alike). The per-frame floorY is not used:
 * it is stale for every substep but the frame's first.
 */
function walkableTerrainContact(
  x: number, z: number, fromY: number, services: MovementServices,
): { n: Normal; h: number } | null {
  const h = services.terrain.getHeightAt(x, z);
  if (h === null) return null;
  const ground = services.groundAt?.(x, z, fromY) ?? null;
  // A BSP floor is the contact: one over the terrain, or an interior cell's under it.
  if (ground !== null && Math.abs(ground - h) > 0.01) return null;
  const n = services.terrain.getTriangleNormalAt(x, z);
  return n && n.y >= FLOOR_Z ? { n, h } : null;
}

/**
 * CTransition::cliff_slide @ 0050a6d0 for a horizontal step, in AC axes
 * (x = three X, y = three Z, z = three Y). `n` is the unwalkable contact
 * plane, `last` the last known (walkable) one. The slide normal is the
 * horizontal perpendicular of the planes' crossing line; the step loses
 * |offset·normal| along it (both branches add normal * -|angle|). Null when
 * the cross is too small to normalize (cliff_slide returns OK unchanged).
 */
export function cliffSlideOffset(dx: number, dz: number, n: Normal, last: Normal): [number, number] | null {
  return cliffSlide(dx, dz, n, last)?.offset ?? null;
}

/**
 * cliff_slide's offset and the collision normal it sets
 * (COLLISIONINFO::set_collision_normal: the crossing normal when the step
 * pushed against it, its negation otherwise), XZ.
 */
function cliffSlide(
  dx: number, dz: number, n: Normal, last: Normal,
): { offset: [number, number]; normal: { x: number; z: number } } | null {
  // c = N x L (cliff_slide's fVar2 / fVar3); collide = (-c.y, c.x, 0).
  const nx = n.x, ny = n.z, nz = n.y;
  const lx = last.x, ly = last.z, lz = last.y;
  const cx = ny * lz - nz * ly;
  const cy = nz * lx - nx * lz;
  let colX = -cy;
  let colY = cx;
  const len = Math.hypot(colX, colY);
  if (len < 0.0002) return null; // normalize_check_small
  colX /= len;
  colY /= len;
  const angle = colX * dx + colY * dz;
  const k = angle <= 0 ? angle : -angle;
  return {
    offset: [dx + colX * k, dz + colY * k],
    normal: angle <= 0 ? { x: colX, z: colY } : { x: -colX, z: -colY },
  };
}

/**
 * BUG.holtburg-statue-tunnel-wall — the body at (x, z) stands on an interior
 * cell's floor under the terrain (outdoorGroundY's cell rule: the only
 * ground below it). Retail's cell array then holds no land cell
 * (CEnvCell::find_transit_cells @ 0052c820), so the terrain's slope and water
 * rules (CLandCell::find_env_collisions @ 00532f20) do not apply there.
 */
function onCellFloorUnderTerrain(services: MovementServices, x: number, z: number, fromY: number): boolean {
  const h = services.terrain.getHeightAt(x, z);
  if (h === null || fromY >= h + 0.5) return false;
  const ground = services.groundAt?.(x, z, fromY) ?? null;
  return ground !== null && ground < h - 0.01;
}

function outdoorAdjustedStep(
  state: MovementStepState, dx: number, dz: number, services: MovementServices, slopeGate: boolean,
): [number, number] {
  // RECON.transition-stepup-stepdown-port — an EdgeSlide object standing on
  // walkable terrain runs CTransition::transitional_insert's step-down /
  // edge_slide for the step: the last known contact plane is the terrain
  // triangle under it.
  // The contact is resolved lazily: only a step that descends onto an
  // unwalkable face needs it (keeps the BSP floor search off ordinary steps).
  let contact: { n: Normal; h: number } | null | undefined;
  let tryX = dx;
  let tryZ = dz;
  for (let attempt = 0; attempt < TRANSITION_INSERT_ATTEMPTS; attempt++) {
    const checkPos = scratchProbe.set(state.x, state.floorY, state.z);
    let [adjX, adjZ] = services.outdoorCollision.getAdjustedMovement(checkPos, tryX, tryZ);
    if (adjX === 0 && adjZ === 0) return [0, 0];
    const destX = state.x + adjX;
    const destZ = state.z + adjZ;
    // GAP.5 — ACE slope rejection (was dead code in the un-instantiated
    // MovementSystem): a destination whose terrain normal fails
    // is_valid_walkable (normal.Z >= PhysicsGlobals.FloorZ,
    // PhysicsObj.cs:2861) cannot be ASCENDED onto: ValidateWalkable
    // neither lifts an OnWalkable sphere onto an unwalkable plane nor takes
    // it as the contact plane, so every insertion attempt stays Adjusted and
    // ValidateTransition puts the sphere back.
    if (slopeGate && !services.terrain.isWalkable(destX, destZ)) {
      const destH = services.terrain.getHeightAt(destX, destZ);
      const curH = services.terrain.getHeightAt(state.x, state.z);
      if (destH !== null && curH !== null && destH > curH + 0.001
        && !onCellFloorUnderTerrain(services, destX, destZ, state.floorY)) return [0, 0];
    }
    // GAP.6 — open sea is impassable: CLandCell::find_env_collisions
    // @ 00532f20 (ACE LandCell.cs:54-58) returns Collided for any
    // non-missile, non-viewer object on a land cell whose LANDBLOCK
    // is EntirelyWater (get_block_water_type). AC1 has no swimming;
    // a fully flooded cell inside a block with any dry land (a river,
    // a lake) is waded, 0.9 m deep (get_water_depth).
    if (services.water.blockWaterTypeAt(destX, destZ) === LandWaterType.EntirelyWater
      && !onCellFloorUnderTerrain(services, destX, destZ, state.floorY)) return [0, 0];
    if (slopeGate && stepDownRefused(services.outdoorCollision, state.x, state.z, destX, destZ, state.floorY, services)) return [0, 0];
    if (!slopeGate || !services.edgeSlide || (services.outdoorCollision.lastStepUp ?? 0) > 0) return [adjX, adjZ];

    // RECON.transition-stepup-stepdown-port.b — on a BSP floor (a roof, a
    // bridge, a stair landing) a step past its edge with no walkable in
    // reach slides along the edge (precipice_slide). The outdoor ground is
    // below the terrain only on an interior cell's floor (a tunnel, a
    // cellar), so only a destination whose terrain lies out of step-down
    // reach, or a body on such a floor, can be one; ordinary steps skip the
    // BSP search.
    const destTerrain = services.terrain.getHeightAt(destX, destZ);
    if (destTerrain !== null && (state.floorY - destTerrain > services.stepDownHeight
      || (state.floorY < destTerrain - 0.01 && onCellFloorUnderTerrain(services, state.x, state.z, state.floorY)))) {
      const precipice = precipiceStep(services.outdoorCollision, state.x, state.z, state.floorY, adjX, adjZ,
        services.stepDownHeight, services.groundAt);
      if (precipice === 'collided') return [0, 0];
      if (precipice !== null) {
        [tryX, tryZ] = precipice;
        continue;
      }
    }

    // Step-down onto the terrain under the destination. A plane below the
    // feet is no contact, so transitional_insert steps down by
    // StepDownHeight (two half steps for a two-sphere body). A walkable
    // plane in reach keeps contact (main.ts's floor follow); one beyond it is
    // a walk-off (main.ts losesContact) — both accept the step as before.
    const destH = services.terrain.getHeightAt(destX, destZ);
    const startH = services.terrain.getHeightAt(state.x, state.z);
    if (destH === null || startH === null || destH >= startH - PHYSICS_EPSILON) return [adjX, adjZ];
    const destN = services.terrain.getTriangleNormalAt(destX, destZ);
    if (!destN || destN.y >= FLOOR_Z) return [adjX, adjZ];
    if (contact === undefined) contact = walkableTerrainContact(state.x, state.z, state.floorY, services);
    if (!contact) return [adjX, adjZ];
    const ground = services.groundAt?.(destX, destZ, contact.h) ?? null;
    if (ground !== null && Math.abs(ground - destH) > 0.01) return [adjX, adjZ]; // a BSP floor is the contact there
    // The step-down lands on an unwalkable plane (Normal.Z < walkable z), so
    // step_down fails and edge_slide runs. Within StepDownHeight the probe
    // made it the contact plane: cliff_slide along the walkable/unwalkable
    // crossing and retry the insert. Out of reach there is no contact and a
    // land cell sets no walkable polygon, so the step is Collided.
    if (contact.h - destH > services.stepDownHeight) return [0, 0];
    const slid = cliffSlide(adjX, adjZ, destN, contact.n);
    if (!slid) return [adjX, adjZ];
    services.outdoorCollision.collisionNormal = slid.normal;
    [tryX, tryZ] = slid.offset;
  }
  // Every attempt was Adjusted: ValidateTransition restores the start.
  return [0, 0];
}

/**
 * RECON.transition-stepup-stepdown-port.e — a grounded step that did not
 * step up runs the step down at its destination (transitional_insert); a
 * walkable in reach that the body does not fit on (a stair stringer running
 * under the floor above) gives no contact plane, and the step is Collided.
 */
function stepDownRefused(
  collider: MovementCollider, x: number, z: number, destX: number, destZ: number, floorY: number,
  services: MovementServices,
): boolean {
  if ((collider.lastStepUp ?? 0) > 0 || !collider.stepDownBlocked) return false;
  return collider.stepDownBlocked(x, z, destX, destZ, floorY, services.stepDownHeight);
}

/** Dungeon wall-slide for one horizontal delta, swept in retail transition steps. */
function dungeonAdjusted(
  collider: MovementCollider, state: MovementStepState, dx: number, dz: number, services: MovementServices,
): [number, number] {
  return withCreatures(services, collider, state, () => sweepTransition(collider, state.x, state.z, dx, dz,
    (x, z, sx, sz) => dungeonAdjustedStep(collider, x, z, state.floorY, sx, sz, services, !state.airborne), services.slide, state.airborne));
}

/** One dungeon transition step: the wall slide, then (grounded) the precipice rule. */
function dungeonAdjustedStep(
  collider: MovementCollider, x: number, z: number, floorY: number, dx: number, dz: number,
  services: MovementServices, grounded: boolean,
): [number, number] {
  let tryX = dx;
  let tryZ = dz;
  for (let attempt = 0; attempt < TRANSITION_INSERT_ATTEMPTS; attempt++) {
    const [adjX, adjZ] = collider.getAdjustedMovement(scratchProbe.set(x, floorY, z), tryX, tryZ);
    if (adjX === 0 && adjZ === 0) return [0, 0];
    if (grounded && stepDownRefused(collider, x, z, x + adjX, z + adjZ, floorY, services)) return [0, 0];
    if (!grounded || !services.edgeSlide || (collider.lastStepUp ?? 0) > 0) return [adjX, adjZ];
    const p = precipiceStep(collider, x, z, floorY, adjX, adjZ, services.stepDownHeight, services.dungeonGroundAt);
    if (p === null) return [adjX, adjZ];
    if (p === 'collided') return [0, 0];
    [tryX, tryZ] = p;
  }
  return [0, 0];
}

/**
 * RECON.transition-stepup-stepdown-port.b — CTransition::edge_slide @
 * 0050b3d0 for an EdgeSlide body (OBJECTINFO 0x200) on a walkable BSP
 * polygon. transitional_insert steps the destination down by
 * StepDownHeight; when no walkable is in reach, step_down fails and
 * edge_slide runs: with no contact plane it steps down from the current
 * position, finds the polygon the body stands on (SPHEREPATH::walkable) and
 * runs SPHEREPATH::precipice_slide @ 0050cc80: find_crossed_edge on that
 * polygon, the edge normal turned against the step, then
 * CSphere::slide_sphere along the edge on the floor's plane (offset
 * projected onto normal x floorNormal) and the insert retried. No crossed
 * edge, or a slide shorter than sqrt(EPSILON), is Collided. So the body
 * cannot walk off a roof, bridge or dungeon ledge; it jumps off.
 *
 * Returns null when the rule does not apply (a walkable in reach, the drop
 * not known, or the body not on a BSP floor — terrain's own branch and the
 * GAP.7 walk-off cover those), 'collided', or the slid (dx, dz).
 */
export function precipiceStep(
  collider: Pick<MovementCollider, 'precipiceEdge' | 'collisionNormal'>,
  x: number, z: number, floorY: number, dx: number, dz: number,
  stepDownHeight: number,
  groundAt: ((x: number, z: number, fromY: number) => number | null) | undefined,
): [number, number] | 'collided' | null {
  if (!groundAt || !collider.precipiceEdge) return null;
  const destX = x + dx;
  const destZ = z + dz;
  // The floor under this transition step's start: floorY is the frame's,
  // and a sloped floor has moved on by the later substeps.
  const standY = groundAt(x, z, floorY) ?? floorY;
  const ground = groundAt(destX, destZ, standY);
  if (ground !== null && standY - ground <= stepDownHeight) return null;
  const pe = collider.precipiceEdge(x, z, standY, destX, destZ);
  if (!pe) return null;
  if (!pe.edge) return 'collided';
  // precipice_slide: turn the edge normal against the offset.
  let { x: ex, y: ey, z: ez } = pe.edge;
  if (ex * dx + ez * dz > 0) { ex = -ex; ey = -ey; ez = -ez; }
  // slide_sphere: direction = collisionNormal x contactPlane.N.
  const f = pe.floorNormal;
  const cx = ey * f.z - ez * f.y;
  const cy = ez * f.x - ex * f.z;
  const cz = ex * f.y - ey * f.x;
  const lenSq = cx * cx + cy * cy + cz * cz;
  if (lenSq < PHYSICS_EPSILON) return 'collided';
  const along = (cx * dx + cz * dz) / lenSq;
  const ox = cx * along;
  const oz = cz * along;
  if (ox * ox + cy * along * cy * along + oz * oz < PHYSICS_EPSILON) return 'collided';
  const hl = Math.hypot(ex, ez);
  collider.collisionNormal = hl > 0 ? { x: ex / hl, z: ez / hl } : null;
  return [ox, oz];
}

/**
 * RELEASE.gdle-npc-use-teleport — a server MoveTo's forward motion, moved
 * through the same collided transitions as keyed movement. Retail moves every
 * motion through CPhysicsObj::UpdateObjectInternal @ 005156b0
 * (UpdatePositionInternal, then transition(); a failed transition leaves the
 * frame where it was); MoveToManager::UseTime only issues the motion
 * commands. The walk used to be added straight along the heading after the
 * collided substeps, so a Use of a distant NPC walked through walls and
 * reported positions outside every cell (GDLE's AdjustPosition then lost the
 * cell, teleported the player back and cancelled the use).
 */
export function stepMoveToMotion(
  state: MovementStepState,
  yaw: number,
  speed: number,
  steps: readonly number[],
  services: MovementServices,
): { x: number; z: number } {
  let x = state.x;
  let z = state.z;
  // Airborne, the body follows its jump momentum (stepPlayerMovement's
  // airborne branch, already run by the frame's substeps), not the motion;
  // sliding off a walkable, the animation offset is zeroed
  // (RECON.transition-stepup-stepdown-port.a).
  if (state.airborne || (state.slideVelocity && !state.inDungeon)) return { x, z };
  const dirX = -Math.sin(yaw);
  const dirZ = -Math.cos(yaw);
  for (const stepDt of steps) {
    const r = stepPlayerMovement({ ...state, x, z }, dirX * speed * stepDt, dirZ * speed * stepDt, stepDt, services);
    x = r.x;
    z = r.z;
  }
  return { x, z };
}

/**
 * One substep. `moveDeltaX/Z` is the camera controller's input motion this
 * substep (ignored while airborne); `stepDt` the substep's seconds.
 */
export function stepPlayerMovement(
  state: MovementStepState,
  moveDeltaX: number,
  moveDeltaZ: number,
  stepDt: number,
  services: MovementServices,
): MovementStepResult {
  if (state.airborne) {
    // Position is driven by jump momentum, not input — and (ACE: every
    // transition collides) the momentum step is collided like any other.
    const dx = state.jumpVelocityX * stepDt;
    const dz = state.jumpVelocityZ * stepDt;
    let x = state.x;
    let z = state.z;
    if (dx !== 0 || dz !== 0) {
      if (state.inDungeon) {
        if (services.dungeonCollision) {
          const [adjX, adjZ] = dungeonAdjusted(services.dungeonCollision, state, dx, dz, services);
          x += adjX;
          z += adjZ;
        } else {
          x += dx;
          z += dz;
        }
      } else {
        const [adjX, adjZ] = outdoorAdjusted(state, dx, dz, services, false);
        x += adjX;
        z += adjZ;
      }
    }
    return { x, z, revertCamera: true };
  }

  if (state.slideVelocity && !state.inDungeon) return stepSlide(state, state.slideVelocity, stepDt, services);

  let x = state.x;
  let z = state.z;
  let revertCamera = false;
  // Wall collision — wall-sliding for buildings and dungeon walls.
  // checkPos.y is the floor Y; DungeonCollision.getAdjustedMovement
  // tests the DAT-sourced dual body spheres (LOWER_SPHERE_HEIGHT /
  // UPPER_SPHERE_HEIGHT) stacked above it, not a single guessed point.
  if (state.inDungeon && services.dungeonCollision && (moveDeltaX !== 0 || moveDeltaZ !== 0)) {
    const [adjX, adjZ] = dungeonAdjusted(services.dungeonCollision, state, moveDeltaX, moveDeltaZ, services);
    x += adjX;
    z += adjZ;
    revertCamera = true;
  } else if (!state.inDungeon && (moveDeltaX !== 0 || moveDeltaZ !== 0)) {
    const [adjX, adjZ] = outdoorAdjusted(state, moveDeltaX, moveDeltaZ, services, true);
    x += adjX;
    z += adjZ;
  } else {
    x += moveDeltaX;
    z += moveDeltaZ;
  }

  // Creatures collide inside the transitions above (withCreatures). Only a
  // substep the player itself moves runs one — VERIFY.position-drift-beside-
  // fighting-creature.a: retail CPhysicsObj::UpdateObjectInternal only
  // set_frame()s an unmoved object, and another object's transition stops
  // that mover without displacing us, so a creature walking into a standing
  // player never moves the player.
  return { x, z, revertCamera };
}

/**
 * RECON.transition-stepup-stepdown-port.a — a substep in contact with an
 * unwalkable terrain face (SteepSlide.ts): the held keys move nothing
 * (UpdatePositionInternal zeroes the animation offset off a walkable), the
 * gravity offset is projected onto the face (adjust_offset) and collided like
 * any transition. The slope gate stays on, so a slide into a face rising
 * against it (a crease) stops — a stationary transition, which also stops the
 * velocity (ObjectInfo.StopVelocity) — and a wall's collision normal bounces
 * the velocity (handle_all_collisions).
 */
function stepSlide(state: MovementStepState, velocity: Vec3, stepDt: number, services: MovementServices): MovementStepResult {
  const n = services.terrain.getTriangleNormalAt(state.x, state.z);
  if (!n) return { x: state.x, z: state.z, revertCamera: true, slideVelocity: velocity, slideMoved: false };
  const step = slideStep(velocity, n, stepDt);
  let [ax, az] = outdoorAdjusted(state, step.offset.x, step.offset.z, services, true);
  // A slide across a crease onto an unwalkable face that rises against the
  // move hits that face's polygon (the sphere cannot pass through it), so the
  // transition is Collided. The plane's horizontal normal points downhill: a
  // face rises along the move when the move opposes it.
  let gentler: { x: number; y: number; z: number } | null = null;
  if (ax !== 0 || az !== 0) {
    const dest = services.terrain.getTriangleNormalAt(state.x + ax, state.z + az);
    if (dest && dest.y < FLOOR_Z && ax * dest.x + az * dest.z < 0) [ax, az] = [0, 0];
    // Onto a gentler face (a concave bend) the sphere moving along the old
    // plane meets the new one: its collision normal bounces the velocity.
    else if (dest && dest.y > n.y + 1e-6) gentler = dest;
  }
  // Stationary = the collision world refused a real offset. An offset under
  // F_EPSILON (a slide from rest on a near-vertical face, at our sub-1/30 s
  // quanta — SteepSlide.ts's deviation note) is not a blocked transition.
  const requested = Math.hypot(step.offset.x, step.offset.z);
  const moved = requested < F_EPSILON || ax !== 0 || az !== 0;
  let v = step.velocity;
  if (!moved) {
    v = { x: 0, y: 0, z: 0 };
  } else {
    const wall = services.outdoorCollision.collisionNormal;
    if (wall) v = bounceVelocity(v, { x: wall.x, y: 0, z: wall.z });
    if (gentler) v = bounceVelocity(v, gentler);
  }
  return { x: state.x + ax, z: state.z + az, revertCamera: true, slideVelocity: v, slideMoved: moved };
}
