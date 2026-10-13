/**
 * The outdoor ground the player stands on: the terrain heightmap, or a
 * walkable polygon of a building / static / cell physics BSP (the
 * outdoor collision world) when one lies at or above the terrain.
 *
 * VISUAL.landblock-statics-missing-vs-retail — a teleport's arrival height
 * is where the floor search starts. Retail places the player at the
 * server's position, so a POI whose destination stands on a building's
 * walkable surface (Xarabydun: the pit rim 0x01002bef, z 18.1 over terrain
 * at 16) arrives ON it. Seeding the search from the terrain height instead
 * left the rim beyond the search's reach and dropped the player through it.
 */
import { transitionNumSteps } from '../player/OutdoorMovement.js';

export interface OutdoorGroundSources {
  /** Terrain heightmap height (renderer Y) at renderer (x, z), or null before the block loads. */
  terrainHeight(worldX: number, worldZ: number): number | null;
  /** Walkable BSP floor nearest `fromY` (DungeonCollision.getFloorHeight); null = no collision world. */
  floorHeight: ((worldX: number, worldZ: number, fromY: number) => number | null) | null;
  /**
   * The registered interior cell holding a body whose feet are at `footY`
   * (DungeonCollision.findCellContaining at the feet sphere's centre), 0 for
   * none. Absent = no cells known (the terrain rule alone).
   */
  cellAt?: (worldX: number, worldZ: number, footY: number) => number;
}

/**
 * The per-frame outdoor ground rule: a BSP floor wins when it sits no more
 * than 0.5 m below the terrain (and never below it); else the terrain.
 *
 * BUG.holtburg-statue-tunnel-wall — except inside an interior cell: a BSP
 * floor whose body stands in a registered EnvCell is the ground however far
 * below the terrain it lies. Retail tests the terrain only for the land
 * cells in the body's cell array, and a body in an EnvCell has them only
 * while a sphere is within its radius of an outside portal's plane
 * (CEnvCell::find_transit_cells @ 0052c820 → CLandCell::add_all_outside_cells;
 * the terrain is CLandCell::find_env_collisions @ 00532f20). The Holtburg
 * drudge statue's tunnel ramp (cell 0xA9B40177) runs down to 5.2 m under
 * the town's terrain: on the terrain rule the body walked level on the
 * terrain over the ramp until the sloped ceiling stopped it at x 66.8.
 */
export function outdoorGroundY(src: OutdoorGroundSources, worldX: number, worldZ: number, fromY: number): number | null {
  const terrainY = src.terrainHeight(worldX, worldZ);
  if (src.floorHeight) {
    const bspFloor = src.floorHeight(worldX, worldZ, fromY);
    if (bspFloor !== null && terrainY !== null && bspFloor < terrainY && src.cellAt?.(worldX, worldZ, bspFloor)) return bspFloor;
    if (bspFloor !== null && bspFloor >= (terrainY ?? 0) - 0.5) return Math.max(bspFloor, terrainY ?? 0);
  }
  return terrainY;
}

/**
 * Where this frame's floor search starts: the pending teleport arrival
 * height while one is unresolved (outdoors), else the last ground plus the
 * step-up bias.
 */
export function floorSearchFromY(pendingArrivalZ: number | null, lastGroundY: number, stepBias: number): number {
  return pendingArrivalZ !== null ? pendingArrivalZ : lastGroundY + stepBias;
}

/**
 * Longer moves are not walks (a server snap or teleport moved the body) and
 * are not traced: ACE refuses a transition of more than 1000 steps
 * (Transition.cs:505-511). 64 steps of a 0.48 m sphere = 30 m, more than
 * 0.2 s of the fastest run.
 */
export const MAX_GROUND_TRACE_STEPS = 64;

/** A floor query: the walkable height nearest `fromY` at (worldX, worldZ), or null. */
export type FloorQuery = (worldX: number, worldZ: number, fromY: number) => number | null;

/**
 * BUG.academy-stairs-fall-through — the ground under a frame's move, found
 * by walking the floor search along the path rather than once at its end.
 * Retail sweeps every transition in steps of at most the body sphere's
 * radius (CTransition::calc_num_steps; ACE Transition.cs:97-125), each step
 * keeping contact with the walkable it stands on, so a ramp is followed
 * however far one frame carries the body. A single query at the end of a
 * long frame (a hitch: up to 0.1 s per physics chunk, several chunks per
 * frame) looked for the floor only within the search window around the
 * OLD floor height, and on the academy's 42° stair ramp a 2.2 m move left
 * the ramp above that window. Each step searches from the floor the
 * previous step found; a step with no floor (a polygon seam) keeps the
 * previous height. Returns the last step's floor (null when none there).
 * A normal frame's move is shorter than the radius: one query, as before.
 */
export function traceGroundAlongPath(
  floorAt: FloorQuery,
  fromX: number, fromZ: number, toX: number, toZ: number,
  fromY: number, sphereRadius: number,
): number | null {
  const dx = toX - fromX;
  const dz = toZ - fromZ;
  const steps = transitionNumSteps(dx, dz, sphereRadius);
  if (steps <= 1 || steps > MAX_GROUND_TRACE_STEPS) return floorAt(toX, toZ, fromY);
  let y = fromY;
  let floor: number | null = null;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    floor = floorAt(fromX + dx * t, fromZ + dz * t, y);
    if (floor !== null) y = floor;
  }
  return floor;
}

/** The interior (dungeon) collision world, as interiorGroundY reads it. */
export interface InteriorGroundSources {
  /** Walkable floor nearest `fromY`, searching at most `maxDrop` below (DungeonCollision.getFloorHeight). */
  floorHeight(worldX: number, worldZ: number, fromY: number, maxDrop?: number): number | null;
  /**
   * The registered EnvCell holding a body whose feet are at `footY`, 0 for
   * none: retail finds the cell from the lower body sphere's centre
   * (CObjCell::find_cell_list over the global sphere), so footY plus that
   * sphere's height goes to DungeonCollision.findCellContaining.
   */
  cellAt(worldX: number, worldZ: number, footY: number): number;
}

/**
 * The ground an interior body stands on after moving (fromX, fromZ) →
 * (toX, toZ), its floor search starting at `fromY`:
 *  - the floor traced along the move (traceGroundAlongPath);
 *  - else, when the body is inside a cell of the collision world, the
 *    nearest walkable anywhere below: the cell is open under it (the
 *    academy's stair shafts are floor portals over a 6 m drop), and retail
 *    finds no contact plane within StepDownHeight and falls until it lands
 *    (ACE Transition.cs StepDown, then gravity). The caller's walk-off check
 *    turns the drop into a fall;
 *  - else `fallbackY`, the floor the body stood on (no collision
 *    geometry around it yet, or a step ending exactly on a doorway's
 *    shared polygon edge, where no polygon contains the point;
 *    BUG.academy-olthoi-leg-upper-floor). Never the arrival height.
 */
export function interiorGroundY(
  src: InteriorGroundSources,
  fromX: number, fromZ: number, toX: number, toZ: number,
  fromY: number, sphereRadius: number, fallbackY: number,
): number {
  const traced = traceGroundAlongPath((x, z, y) => src.floorHeight(x, z, y), fromX, fromZ, toX, toZ, fromY, sphereRadius);
  if (traced !== null) return traced;
  if (src.cellAt(toX, toZ, fromY) !== 0) {
    const below = src.floorHeight(toX, toZ, fromY, Infinity);
    if (below !== null) return below;
  }
  return fallbackY;
}

/** A collision world as objectLandingZ reads it (DungeonCollision). */
export interface SurfaceCollision {
  /** Whether cell `cellId`'s BSP is registered. */
  hasCell(cellId: number): boolean;
  /** Whether any source is registered. */
  readonly hasCells: boolean;
  /** The highest walkable surface at or below `fromY` (DungeonCollision.floorBelow). */
  floorBelow(worldX: number, worldZ: number, fromY: number): number | null;
  /** Does any of these spheres (AC landblock-global centres) overlap a registered source as it stands? */
  spheresOverlap(spheres: readonly { x: number; y: number; z: number; radius: number }[]): boolean;
  /** The registered interior cell holding the point, 0 for none. */
  findCellContaining(acX: number, acY: number, acZ: number, preferredCellId?: number): number;
}

/** The collision worlds a server object can stand in. */
export interface ObjectSurfaceSources {
  /** The interior (dungeon) collision world, when one is built. */
  readonly dungeon: SurfaceCollision | null;
  /** The outdoor collision world: buildings, their cells, statics. */
  readonly outdoor: SurfaceCollision;
  /** Terrain heightmap height at (x, y), or null before the block loads. */
  terrainHeight(worldX: number, worldZ: number): number | null;
}

/** An object's physics sphere relative to its origin (rotated and scaled; AC axes). */
export interface ObjectSphereOffset {
  x: number;
  y: number;
  z: number;
  radius: number;
}

/** The sweep step a falling object's spheres are tested at (m). */
const LANDING_SWEEP_STEP = 0.02;

/**
 * BUG.gravity-item-placed-midair — where a Gravity object placed at
 * (x, y, z) in `cell` comes to rest: the stand-in for the transitions
 * `CPhysicsObj::UpdateObjectInternal @ 005156b0` runs as it falls. Its
 * spheres drop straight down until the lowest one rests on the walkable
 * surface beneath (a desk top, a floor; DungeonCollision.floorBelow), or
 * until they first meet any other geometry on the way (a branch, a
 * shelf's edge — retail's transition stops there too), tested every
 * LANDING_SWEEP_STEP. Returns the origin z it rests at:
 *  - z itself when it already touches something (resting, or sunk into a
 *    wall or the floor — a transition that starts in collision never
 *    moves), when nothing walkable lies under it, or when the resting
 *    point leaves its interior cell (a position that does not match the
 *    cell's geometry);
 *  - null while the collision world holding the cell is not resident (an
 *    interior cell answers once its BSP is registered; its statics — the
 *    desk — are added in the same pass, DungeonCollisionBuild).
 */
export function objectLandingZ(
  src: ObjectSurfaceSources, cell: number, x: number, y: number, z: number,
  spheres: readonly ObjectSphereOffset[],
): number | null {
  if (spheres.length === 0) return z;
  const interior = (cell & 0xffff) >= 0x100;
  let world: SurfaceCollision | null = null;
  if (interior) {
    if (src.dungeon?.hasCell(cell)) world = src.dungeon;
    else if (src.outdoor.hasCell(cell)) world = src.outdoor;
    else return null;
  } else {
    world = src.outdoor.hasCells ? src.outdoor : null;
  }
  let bottom = Infinity, top = -Infinity;
  for (const s of spheres) { bottom = Math.min(bottom, s.z - s.radius); top = Math.max(top, s.z); }
  const at = (oz: number) => spheres.map((s) => ({ x: x + s.x, y: y + s.y, z: oz + s.z, radius: s.radius }));
  if (world?.spheresOverlap(at(z))) return z;
  let surface = world ? world.floorBelow(x, y, z + top) : null;
  if (!interior) {
    const terrain = src.terrainHeight(x, y);
    if (terrain === null && surface === null) return null;
    if (terrain !== null && terrain <= z + top && (surface === null || terrain > surface)) surface = terrain;
  }
  if (surface === null) return z;
  const rest = surface - bottom;
  if (rest >= z) return z;
  if (interior && world!.findCellContaining(x, y, rest + top, cell) !== cell) return z;
  // The spheres meet nothing on the way down (the last step stops short of
  // the surface, whose own polygon the resting sphere touches).
  if (world) {
    for (let oz = z - LANDING_SWEEP_STEP; oz > rest + LANDING_SWEEP_STEP; oz -= LANDING_SWEEP_STEP) {
      if (world.spheresOverlap(at(oz))) return oz + LANDING_SWEEP_STEP;
    }
  }
  return rest;
}

