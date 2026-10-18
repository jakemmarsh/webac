import * as THREE from 'three';
import type { CellStruct } from '@ac/dat-parser/file-types/Environment.js';
import type { Frame } from '@ac/dat-parser/file-types/Frame.js';
import type { GfxObj } from '@ac/dat-parser/file-types/GfxObj.js';
import { pointInCell } from './cellContainment.js';
import {
  buildCollisionBSP, sphereIntersectsPoly, sphereIntersectsAnyPoly, sphereIntersectsSolid, findFloorHeight, collectWalkableFloorHeights, collectWalkableFloors, findCrossedEdge, findWalkable, collectWalkableSphereHits, sphereRestLift, FLOOR_WALKABLE_Z,
  landblockX, landblockY,
} from '@ac/shared';
import type { CollisionBSPNode, CollisionSphere, PhysicsPolygon } from '@ac/shared';
import { CollisionGrid, type GridEntry } from './CollisionGrid.js';

/**
 * DungeonCollision — BSP-based wall collision and floor detection.
 *
 * Uses AC's native physics BSP trees for collision. The sphere is tested at
 * the PROPOSED destination position (not along a ray), matching how ACE's
 * EnvCell.FindEnvCollisions works.
 *
 * Coordinate flow (verified by tests/verify-bsp-transform.ts):
 *   Three.js world (Y-up) → AC landblock-local (Z-up) → cell-local (Z-up)
 *   Transform: subtract cell origin, rotate by inverse cell quaternion
 *   Reference: ACE AFrame.GlobalToLocal (AFrame.cs:57-68)
 *
 * Falls back to Three.js raycasting for outdoor collision.
 */

// ── Quaternion math (AC Z-up space) ─────────────────────────

function quatConjugate(q: { w: number; x: number; y: number; z: number }) {
  return { w: q.w, x: -q.x, y: -q.y, z: -q.z };
}

function quatMultiply(
  a: { w: number; x: number; y: number; z: number },
  b: { w: number; x: number; y: number; z: number },
) {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

function quatRotate(
  q: { w: number; x: number; y: number; z: number },
  v: { x: number; y: number; z: number },
) {
  const { w: qw, x: qx, y: qy, z: qz } = q;
  const tw = -qx * v.x - qy * v.y - qz * v.z;
  const tx = qw * v.x + qy * v.z - qz * v.y;
  const ty = qw * v.y + qz * v.x - qx * v.z;
  const tz = qw * v.z + qx * v.y - qy * v.x;
  return {
    x: tx * qw - tw * qx - ty * qz + tz * qy,
    y: ty * qw - tw * qy - tz * qx + tx * qz,
    z: tz * qw - tw * qz - tx * qy + ty * qx,
  };
}

/** ACE AFrame.GlobalToLocal: subtract origin, rotate by inverse quaternion */
function globalToLocal(
  origin: { x: number; y: number; z: number },
  quat: { w: number; x: number; y: number; z: number },
  point: { x: number; y: number; z: number },
) {
  const offset = { x: point.x - origin.x, y: point.y - origin.y, z: point.z - origin.z };
  return quatRotate(quatConjugate(quat), offset);
}

/** ACE AFrame.LocalToGlobalVec: rotate vector by quaternion */
function localToGlobalVec(
  quat: { w: number; x: number; y: number; z: number },
  v: { x: number; y: number; z: number },
) {
  return quatRotate(quat, v);
}

/** The largest radius of these spheres (0 for none). */
function maxRadius(spheres: readonly { radius: number }[]): number {
  let r = 0;
  for (const s of spheres) r = Math.max(r, s.radius);
  return r;
}

function scaleVec(v: { x: number; y: number; z: number }, k: number) {
  return k === 1 ? v : { x: v.x * k, y: v.y * k, z: v.z * k };
}

/**
 * XZ padding for a floor-column query against the BSP sources' bounding
 * discs (belt-and-braces over the physics BSP root sphere, which encloses
 * every polygon of the tree).
 */
const FLOOR_QUERY_PAD = 0.5;

// ── Cell collision data ─────────────────────────────────────

/**
 * REND.collision-key-collisions — a collision source's registry key. EnvCells
 * register under their numeric cell id (findCellContaining returns it);
 * every other source (building / static / scenery part BSPs, obstacles)
 * uses a structured string key (see `collisionKey`), so two sources can
 * never alias each other the way the old packed-number keys did.
 */
export type CollisionKey = number | string;

/**
 * Structured, collision-free keys for non-EnvCell sources. Each segment is a
 * separate integer, so no index can spill into a neighbour's range.
 */
export const collisionKey = {
  /** Landblock static object (LandblockInfo.objects[objIdx]); `kind`/`sub` = ObjectCollision source ('p' part BSP / 'c' cylsphere / 's' sphere + index). */
  landblockStatic: (blockKey: number, objIdx: number, kind: CollisionSourceKind, sub: number): string =>
    `st:${blockKey}:${objIdx}:${kind}${sub}`,
  /** Building exterior (LandblockInfo.buildings[bldgIdx]) of block `blockKey`. */
  building: (blockKey: number, bldgIdx: number, kind: CollisionSourceKind, sub: number): string =>
    `bl:${blockKey}:${bldgIdx}:${kind}${sub}`,
  /** EnvCell static object (EnvCell.staticObjects[stabIdx]). */
  cellStatic: (cellId: number, stabIdx: number, kind: CollisionSourceKind, sub: number): string =>
    `cs:${cellId >>> 0}:${stabIdx}:${kind}${sub}`,
  /** Scenery placement `placementIdx` of landblock `landblockId`. */
  scenery: (landblockId: number, placementIdx: number, kind: CollisionSourceKind, sub: number): string =>
    `sc:${landblockId >>> 0}:${placementIdx}:${kind}${sub}`,
};

/** Which part of an object a collision source is: part BSP, CylSphere or Sphere. */
export type CollisionSourceKind = 'p' | 'c' | 's';

interface CellCollision extends GridEntry {
  bsp: CollisionBSPNode;
  /**
   * REND.per-frame-allocations — XY bounds (AC landblock-local, i.e. after
   * the cell frame) of every physics polygon vertex in `bsp`, or null when
   * the BSP has no polygons. A vertical floor probe outside them can hit no
   * polygon (pointInPolygonXY needs the point inside every edge), so floor
   * queries skip the cell before the per-cell transform + BSP walk.
   */
  floorBounds: FloorBoundsXY | null;
  /** BUG.10 — CELL BSP root for point-in-cell containment queries. */
  cellBspRoot: import('@ac/dat-parser').BSPNodeBase | undefined;
  origin: { x: number; y: number; z: number };
  quat: { w: number; x: number; y: number; z: number };
  blockOffsetX: number;
  blockOffsetY: number;
  /**
   * Uniform scale the source's GfxObj is drawn/collided at (ACE
   * PhysicsPart.FindObjCollisions → CacheLocalSpaceSphere(Pos, GfxObjScale.Z)
   * + GfxObj.FindObjCollisions(transition, GfxObjScale.Z)). 1 for EnvCells.
   */
  scale: number;
  /**
   * RECON.transition-stepup-stepdown-port.d — a building's own shell
   * (BuildingObj::find_building_collisions sets SPHEREPATH::bldg_check while
   * it tests these parts). Its Placement test ignores the shell's solid
   * leaves when the body is in an interior cell (BSPTREE::find_collisions
   * @ 0053a440: clearCell = !hits_interior_cell).
   */
  building: boolean;
  /**
   * The source stands in the landscape's land cells: a building's shell
   * (`building`), a landblock static (LandblockInfo.objects) or a scenery
   * placement. A body in an env cell meets these only near one of that
   * cell's outside portals (bodyScope): CEnvCell::find_transit_cells
   * @ 0052c820 adds the land cells to its cell array only there, and
   * CObjCell::find_obj_collisions tests each cell's own objects.
   */
  landCell: boolean;
  /**
   * BUG.bunker-sealed-at-ground — an env cell's outside portals (EnvCell
   * portals whose OtherCellId is 0xFFFF) as cell-local planes, n·p + d = 0.
   * Undefined for a source that is no env cell, or one registered without
   * its portals (then every building shell counts, as before).
   */
  outsidePlanes?: readonly OutsidePortalPlane[];
  /** An env cell's portal neighbours (full cell ids), or undefined when registered without them (componentOf). */
  neighbors?: readonly number[];
  /**
   * An env cell's vertex bounds, AC landblock-global (x, y, z up): no point
   * outside them is in the cell (its CELL BSP is closed by its polygons; 0 of
   * 57 M points sampled just outside every 10th cell of the end-of-retail and
   * Classic Dereth cell.dats were), so findCellContaining tests a point
   * against the cell's BSP only inside them.
   */
  cellBox?: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };
  /** The env cell this source is (an EnvCell) or stands in (one of its statics, collisionKey.cellStatic); 0 for any other. */
  envCellId: number;
}

/** An env cell's entry in DungeonCollision's envCellGrid. */
interface EnvCellSlot extends GridEntry {
  cellId: number;
}

/** Which cell a source stands in, for a body's scope (DungeonCollision.inScope). */
interface ScopedSource {
  /** It stands in the land cells (a building shell, a landblock static, scenery). */
  landCell: boolean;
  /** The env cell it is or stands in; 0 for none. */
  envCellId: number;
}

/**
 * What a test of a body meets: the land cells (`land`: it is in no env
 * cell, or near one of its cell's outside portals) and which group of
 * portal-joined env cells it stands in (`home`, -1 = none or unknown).
 */
interface BodyScope {
  land: boolean;
  home: number;
}

/** A body that meets every source (outdoors, or in a cell registered without its portals). */
const EVERYTHING: BodyScope = { land: true, home: -1 };

/** Whether the source belongs to a cell (land or env) a body's scope decides on. */
function scoped(src: ScopedSource): boolean {
  return src.landCell || src.envCellId !== 0;
}

/** The env cell a source under `key` is or stands in (an EnvCell's numeric key, or a cellStatic key's cell); 0 otherwise. */
function envCellOfKey(key: CollisionKey): number {
  if (typeof key === 'number') return key >>> 0;
  return key.startsWith('cs:') ? parseInt(key.slice(3), 10) >>> 0 : 0;
}

/** Whether a source under `key` stands in the land cells by its key (a landblock static or scenery placement). */
function landKey(key: CollisionKey): boolean {
  return typeof key === 'string' && (key.startsWith('st:') || key.startsWith('sc:'));
}

/** A cell-local plane through an outside portal polygon (unit normal n, n·p + d = 0). */
interface OutsidePortalPlane { nx: number; ny: number; nz: number; d: number }

/** CellCollision.cellBox: the cell's vertices carried out of its frame, padded by a centimetre; undefined with none. */
function cellBoxOf(cellStruct: CellStruct, position: Frame, offX: number, offY: number): CellCollision['cellBox'] {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const v of cellStruct.vertexArray.vertices.values()) {
    const g = quatRotate(position.orientation, v.origin);
    const x = g.x + position.origin.x + offX, y = g.y + position.origin.y + offY, z = g.z + position.origin.z;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  if (!(minX <= maxX)) return undefined;
  const pad = 0.01;
  return { minX: minX - pad, maxX: maxX + pad, minY: minY - pad, maxY: maxY + pad, minZ: minZ - pad, maxZ: maxZ + pad };
}

/** The plane through a portal polygon's first three vertices, or null for a degenerate one. */
function portalPlane(cellStruct: CellStruct, polygonId: number): OutsidePortalPlane | null {
  const poly = cellStruct.polygons.get(polygonId);
  if (!poly || poly.vertexIndices.length < 3) return null;
  const v = poly.vertexIndices.slice(0, 3).map((i) => cellStruct.vertexArray.vertices.get(i)?.origin);
  if (v.some((o) => !o)) return null;
  const [a, b, c] = v as { x: number; y: number; z: number }[];
  const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
  const wx = c.x - a.x, wy = c.y - a.y, wz = c.z - a.z;
  let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-9) return null;
  nx /= len; ny /= len; nz /= len;
  return { nx, ny, nz, d: -(nx * a.x + ny * a.y + nz * a.z) };
}

/** Extra facts about a GfxObj collision source (addGfxObjCollision). */
export interface GfxObjCollisionOptions {
  /** The part belongs to a building's shell (LandblockInfo.buildings), not a static object. */
  building?: boolean;
}

/**
 * Cylinder-shaped obstacle for sphere-collision objects (trees, rocks,
 * lamp posts — AC GfxObjs without a physicsBSP but with visible XZ extent).
 * Coordinates in world space (post block-offset), AC Z-up height optional.
 */
interface CylinderObstacle extends GridEntry {
  /** World X (THREE space). */
  x: number;
  /** World Z (THREE space; AC Y after offset). */
  z: number;
  /** Cylinder radius in meters. */
  radius: number;
  /** Bottom Y (CylSphere LowPoint height); -Infinity = unbounded. */
  bottomY: number;
  /** Top Y (LowPoint + Height); +Infinity = unbounded. */
  topY: number;
  /**
   * BUG.bunker-camera-in-head — an env cell's static (collisionKey.cellStatic):
   * the camera meets it from its cell. Every other cylinder (scenery, land
   * statics) stands in a land cell, which a viewer in an env cell reaches only
   * near an outside portal (getCameraDistance's `landFrom`).
   */
  inCell: boolean;
  /** ScopedSource: a landblock static's or scenery placement's (bodyScope's land cells). */
  landCell: boolean;
  /** ScopedSource: the env cell whose static it is, 0 for none. */
  envCellId: number;
}

/** A Setup `Sphere` obstacle (ACE Sphere.IntersectsSphere), world THREE space. */
interface SphereObstacle extends GridEntry {
  x: number;
  y: number;
  z: number;
  radius: number;
  /** ScopedSource, as CylinderObstacle's. */
  landCell: boolean;
  envCellId: number;
}

/** ACE PhysicsGlobals.EPSILON (Physics/PhysicsGlobals.cs:9) — the radsum slack in CylSphere/Sphere tests. */
const PHYSICS_EPSILON = 0.0002;

/**
 * BUG.bunker-camera-in-head — a camera contact `surfaceDist` along the boom
 * (where the ray meets the surface) with a land-cell object counts when the
 * viewer sphere's centre there (surfaceDist − its 0.3 m radius) has reached
 * the land cells (at or past `landFrom`).
 */
function landContactCounts(surfaceDist: number, landFrom: number): boolean {
  return surfaceDist - DungeonCollision.VIEWER_SPHERE_RADIUS >= landFrom - PHYSICS_EPSILON;
}

/** How far below the search height getFloorHeight looks for a BSP floor by default. */
const FLOOR_SEARCH_MAX_DROP = 5.0;
/** How far above the search height a floor still counts as the one the body is on (getFloorHeight's stair window). */
const STEP_SEARCH_SLACK = 0.05;
/** stepDownBlocked: a landing this far above the search height raises the body. */
const STEP_DOWN_RAISE_EPS = 0.01;
/** AC +Z: the up axis step_sphere_down moves the feet sphere along. */
const AC_UP = { x: 0, y: 0, z: 1 };
const scratchLanding = new THREE.Vector3();
/** riseLimit's sweep step (m): a few cm of headroom lost at most. */
const RISE_STEP_M = 0.05;
/** riseLimit: a face stops the rise when its normal points down by more than this (cos): ceilings, not walls. */
const RISE_GRAZE = 0.1;

/** The terrain under (x, z) (three.js world): height, Y-up plane normal, wade depth. */
export type TerrainLandingSource = (x: number, z: number) => {
  height: number;
  normal: { x: number; y: number; z: number };
  waterDepth?: number;
} | null;

/**
 * RECON.transition-stepup-stepdown-port.c.a — CLandCell::find_env_collisions
 * → OBJECTINFO::validate_walkable (ACE LandCell.cs:37-66, ObjectInfo.cs:104-155)
 * for the step up's step_down: the transition runs with step_up set, so the
 * check position is not lowered (CTransition::step_down @ 0050b3d0 only lowers
 * it without step_up). The feet sphere at the destination therefore lands on
 * the terrain only when it is embedded in it, lifted by -zDist, and stays put
 * within EPSILON of it; a sphere above the terrain sets no contact plane, so
 * the step fails (step_up_slide). The lift is bounded by the step_down interp
 * (1 - zDist / (StepDownAmt · walk_interp)) · walk_interp ≥ -0.1, StepDownAmt
 * being the StepUpHeight step_up passes; the plane must then be walkable
 * (contact_plane.N.z ≥ the walkable z). Returns the lift in metres, or null.
 * `sphereBottom` is the feet sphere's lowest point (three.js Y).
 */
export function terrainStepUpLift(
  sphereBottom: number,
  terrain: { height: number; normal: { y: number }; waterDepth?: number },
  stepUpHeight: number,
  walkableZ: number = FLOOR_WALKABLE_Z,
): number | null {
  const nz = terrain.normal.y;
  if (!(nz > 0)) return null;
  const zDist = sphereBottom - terrain.height;
  const dist = zDist * nz + (terrain.waterDepth ?? 0);
  if (dist > PHYSICS_EPSILON) return null; // above the terrain: no contact plane
  if (nz < walkableZ) return null;
  if (dist >= -PHYSICS_EPSILON) return 0; // touching: contact plane, no adjust
  const lift = -(dist / nz);
  const interp = 1 + (dist / nz) / stepUpHeight;
  if (interp >= 1 || interp < -0.1) return null;
  return lift;
}

interface FloorBoundsXY { minX: number; maxX: number; minY: number; maxY: number }

/** Slack on floorBounds so float noise in the cell transform can never reject a real hit. */
const FLOOR_BOUNDS_MARGIN = 0.01;

/**
 * XY bounds of every polygon vertex in a collision BSP, taken through the
 * cell frame (origin + quat) into landblock-local AC coordinates.
 */
/** GfxObj → its resolved physics BSP (addGfxObjCollision). */
const gfxBspCache = new WeakMap<GfxObj, CollisionBSPNode>();

function computeFloorBounds(
  root: CollisionBSPNode,
  origin: { x: number; y: number; z: number },
  quat: { w: number; x: number; y: number; z: number },
  scale = 1,
): FloorBoundsXY | null {
  let b: FloorBoundsXY | null = null;
  const seen = new Set<object>();
  const stack: CollisionBSPNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.polygons) {
      for (const poly of node.polygons) {
        if (seen.has(poly)) continue;
        seen.add(poly);
        for (const v of poly.vertices) {
          const g = quatRotate(quat, scale === 1 ? v : { x: v.x * scale, y: v.y * scale, z: v.z * scale });
          const x = g.x + origin.x;
          const y = g.y + origin.y;
          if (!b) b = { minX: x, maxX: x, minY: y, maxY: y };
          else {
            if (x < b.minX) b.minX = x;
            if (x > b.maxX) b.maxX = x;
            if (y < b.minY) b.minY = y;
            if (y > b.maxY) b.maxY = y;
          }
        }
      }
    }
    if (node.posNode) stack.push(node.posNode);
    if (node.negNode) stack.push(node.negNode);
  }
  if (b) {
    b.minX -= FLOOR_BOUNDS_MARGIN; b.maxX += FLOOR_BOUNDS_MARGIN;
    b.minY -= FLOOR_BOUNDS_MARGIN; b.maxY += FLOOR_BOUNDS_MARGIN;
  }
  return b;
}

/**
 * Is `p` (source-local) under `poly` and behind it: below its plane with its
 * projection along `up` inside the polygon? A body there stands under that
 * walkable (an attic's roof seen from inside) and can reach its top only
 * through it, so it is never the body's floor or step-up landing.
 */
function underFromBehind(poly: PhysicsPolygon, p: { x: number; y: number; z: number }, up: { x: number; y: number; z: number }): boolean {
  const n = poly.plane.normal;
  if (n.x * p.x + n.y * p.y + n.z * p.z + poly.plane.distance >= 0) return false;
  return findCrossedEdge(poly, p, up) === null;
}

/** Can a vertical probe at landblock-local (acX, acY) reach one of the cell's polygons? */
function floorProbeMayHit(cell: CellCollision, acX: number, acY: number): boolean {
  const b = cell.floorBounds;
  return b !== null && acX >= b.minX && acX <= b.maxX && acY >= b.minY && acY <= b.maxY;
}

export class DungeonCollision {
  private cells = new Map<CollisionKey, CellCollision>();
  /** BUG.10 — the EnvCell subset (numeric cell ids with a CELL BSP), for findCellContaining. */
  private envCells = new Map<number, CellCollision>();
  /** Scenery/static CylSphere obstacles keyed by CollisionKey. */
  private cylinders = new Map<CollisionKey, CylinderObstacle>();
  /** Scenery/static Sphere obstacles keyed by CollisionKey. */
  private spheres = new Map<CollisionKey, SphereObstacle>();
  /**
   * REND.scenery-collision-never-removed — XZ hash grids over the sources, so
   * a query visits only nearby ones (results are identical: see CollisionGrid).
   */
  private readonly spatialIndex: boolean;
  private cellGrid = new CollisionGrid<CellCollision>();
  /** The env cells by their vertex bounds (cellBox), for findCellContaining's search past the preferred cell's portals. */
  private envCellGrid = new CollisionGrid<EnvCellSlot>();
  private envCellSlots = new Map<number, EnvCellSlot>();
  private cylinderGrid = new CollisionGrid<CylinderObstacle>();
  private sphereGrid = new CollisionGrid<SphereObstacle>();
  private nextSeq = 0;
  /** Largest cylinder / sphere radius registered (query padding for the camera boom). */
  private maxObstacleRadius = 0;

  /**
   * @param options.spatialIndex false = scan every source linearly (the
   *   pre-index behaviour; kept so tests can prove the index is invisible).
   */
  constructor(options: { spatialIndex?: boolean } = {}) {
    this.spatialIndex = options.spatialIndex ?? true;
  }
  /**
   * Step-up height for stair climbing (ACE Sphere.StepSphereUp), sourced
   * from the human player SetupModel (0x02000001) StepUpHeight in
   * portal.dat (0.6000000238418579 as float32; ACE.DatLoader/FileTypes/
   * SetupModel.cs:33,93).
   */
  public static readonly STEP_UP_HEIGHT = 0.6;
  /**
   * Player collision cylinder radius, sourced from the human player
   * SetupModel (0x02000001) radius in portal.dat (0.6788225173950195 as
   * float32; ACE.DatLoader/FileTypes/SetupModel.cs:33,90) — NOT the 0.4m
   * approximation used before BUG.outdoor-player-radius-hardcoded-wrong.
   */
  public static readonly PLAYER_RADIUS = 0.6788225173950195;
  /**
   * BUG.melee-cylinder-distance-ignores-height — player collision cylinder
   * height, sourced from the human player SetupModel (0x02000001) height in
   * portal.dat (1.8350000381469727 as float32; ACE.DatLoader/FileTypes/
   * SetupModel.cs:33,87). Feeds Physics/Common/Position.cs CylinderDistance's
   * height-aware diffZ term (PhysicsObj.GetHeight() = Setup._dat.Height *
   * Scale.Z) via main.ts's getMeleeCylinderDistance call sites.
   */
  public static readonly PLAYER_HEIGHT = 1.8350000381469727;
  /**
   * Public (not private) so main.ts's getMeleeCylinderDistance call sites can
   * thread the resolved per-heritage radius instead of the static Human-only
   * DungeonCollision.PLAYER_RADIUS default — see setPlayerDimensions below.
   */
  playerRadius = DungeonCollision.PLAYER_RADIUS;
  /** Same per-heritage resolution as playerRadius, for PLAYER_HEIGHT. */
  playerHeight = DungeonCollision.PLAYER_HEIGHT;
  /**
   * Wall/obstacle collision-probe body spheres, sourced from the human
   * player SetupModel (0x02000001) Spheres[0..1] in portal.dat (z=
   * 0.4749999940395355 r=0.48 and z=1.350000023841858 r=0.48 as float32;
   * ACE.DatLoader/FileTypes/SetupModel.cs Spheres block) — a feet/head
   * capsule, NOT the single COLLISION_HEIGHT=0.67 point estimate used
   * before BUG.collision-height-single-point-not-dual-sphere. ACE's own
   * physics (Physics/SpherePath.cs InitSphere, PartArray.GetSphere() ->
   * Setup.Sphere -> setupModel.Spheres) caps NumSphere at
   * min(setup.NumSphere,2), and every BSPTree/Sphere/CylSphere collision
   * routine branches on NumSphere>1 to test both spheres — a hit on
   * either blocks movement.
   */
  public static readonly BODY_SPHERE_RADIUS = 0.48;
  public static readonly LOWER_SPHERE_HEIGHT = 0.4749999940395355;
  public static readonly UPPER_SPHERE_HEIGHT = 1.350000023841858;
  /**
   * BUG.collision-radius-step-up-hardcoded-human — the STEP_UP_HEIGHT /
   * BODY_SPHERE_RADIUS / body-sphere-heights statics above are only the
   * Human fallback used until setPlayerDimensions() resolves the local
   * player's real per-heritage SetupModel + Scale.Z (ACE PartArray.cs:191-
   * 247 GetHeight/GetRadius/GetStepUpHeight = Setup._dat.* * Scale.Z; body
   * spheres scaled the same way via SpherePath.InitSphere, PhysicsObj.cs:
   * 1161/2209). These instance fields are what collision math actually
   * reads; the statics stay as the pre-resolve default + the existing
   * test pins' anchor values.
   */
  private stepUpHeight = DungeonCollision.STEP_UP_HEIGHT;
  private bodySphereRadius = DungeonCollision.BODY_SPHERE_RADIUS;
  /**
   * The (resolved) body-sphere radius — retail CTransition::calc_num_steps
   * @0050a0b0 divides a transition into steps of local_sphere[0].radius.
   */
  get transitionSphereRadius(): number { return this.bodySphereRadius; }
  /** Height of the (resolved) lower body sphere's centre above the feet. */
  get lowerSphereHeight(): number { return this.bodySphereHeights[0]; }
  private bodySphereHeights: readonly [number, number] = [
    DungeonCollision.LOWER_SPHERE_HEIGHT,
    DungeonCollision.UPPER_SPHERE_HEIGHT,
  ];
  /**
   * Set to the current stepUpHeight when the last getAdjustedMovement call
   * resolved a wall hit via step-up; 0 otherwise. Callers read this after
   * movement to bias floor detection upward so the new elevated step is
   * selected instead of the old floor beneath it (which still overlaps the
   * new XZ position).
   */
  public lastStepUp = 0;
  /**
   * MOVE.slide-speed-around-sphere — COLLISIONINFO::collision_normal: the
   * horizontal outward normal (three.js XZ, unit) of the last obstacle or
   * wall a getAdjustedMovement call slid against or stopped on, or null.
   * Like retail's collision_normal_valid it is cleared only when a
   * transition starts (CTransition::init @ 00509dd0; the movement sweep sets
   * it to null), never per step, so every later step of the same transition
   * still sees it (CTransition::validate_transition @ 0050aa70 then makes it
   * the sliding normal).
   */
  public collisionNormal: { x: number; z: number } | null = null;

  /**
   * RECON.transition-stepup-stepdown-port.c.a — the land cell's terrain
   * polygon under a point (CLandCell::find_terrain_poly): its height, its
   * plane normal (three.js Y-up) and the water depth ObjectInfo::
   * validate_walkable adds to the contact distance. Set for the outdoor
   * collider only; a step up outside every EnvCell lands on it.
   */
  private terrainLanding: TerrainLandingSource | null = null;

  /** Give the step up its terrain landing source (null = none: such a step fails). */
  setTerrainLanding(source: TerrainLandingSource | null): void {
    this.terrainLanding = source;
  }

  /** COLLISIONINFO::set_collision_normal for a horizontal (x, z) normal. */
  /**
   * `up`: the face normal's vertical (AC z) part. BUG.ramp-sliding-normal-stuck —
   * a walkable face is never carried as the sliding normal. Retail keeps the
   * 3-D normal and runs the next step's offset along the contact plane
   * (CTransition::adjust_offset @ 0050a370; ACE Transition.AdjustOffset), so a
   * step up a ramp whose step-up failed once does not push into the ramp's own
   * normal and clears it. Flattened to its horizontal part, the ramp's normal
   * (0.59 across, 0.81 up under the drudge statues) became a wall straight
   * ahead of every uphill step, which projected to nothing and stopped the
   * player on the ramp for good (2026-10-18, Yaraq's statue ramp 0x7D640151).
   */
  private setCollisionNormal(x: number, z: number, up = 0): void {
    if (up >= FLOOR_WALKABLE_Z) return;
    const len = Math.hypot(x, z);
    if (len > 1e-6) this.collisionNormal = { x: x / len, z: z / len };
  }

  // Legacy raycaster for outdoor/camera collision
  private raycaster = new THREE.Raycaster();
  private renderMeshes: THREE.Mesh[] = [];

  /**
   * BUG.collision-radius-step-up-hardcoded-human — resolve the local
   * player's real collision dimensions from their SetupModel + Scale.Z,
   * matching ACE PartArray.GetRadius/GetStepUpHeight (Setup._dat.Radius/
   * StepUpHeight * Scale.Z) and the body-sphere scaling SpherePath.InitSphere
   * applies (both a sphere's origin.z and its radius scaled by the same
   * factor). Call whenever the local player's setupId changes (character
   * load / enter-world) — mirrors resolvePlayerStepDownHeight's usage in
   * fallPhysics.ts for the sibling fall-detection fix. Passing `null`/
   * `undefined` (setup not resolved yet) restores the Human-derived statics.
   */
  setPlayerDimensions(
    setup: {
      radius: number;
      height: number;
      stepUpHeight: number;
      spheres: Array<{ origin: { z: number }; radius: number }>;
    } | null | undefined,
    scaleZ: number,
  ): void {
    this.scopeEpoch++; // bodyScope's spheres
    if (!setup) {
      this.playerRadius = DungeonCollision.PLAYER_RADIUS;
      this.playerHeight = DungeonCollision.PLAYER_HEIGHT;
      this.stepUpHeight = DungeonCollision.STEP_UP_HEIGHT;
      this.bodySphereRadius = DungeonCollision.BODY_SPHERE_RADIUS;
      this.bodySphereHeights = [DungeonCollision.LOWER_SPHERE_HEIGHT, DungeonCollision.UPPER_SPHERE_HEIGHT];
      return;
    }
    this.playerRadius = setup.radius * scaleZ;
    this.playerHeight = setup.height * scaleZ;
    this.stepUpHeight = setup.stepUpHeight * scaleZ;
    if (setup.spheres.length >= 2) {
      this.bodySphereRadius = setup.spheres[0].radius * scaleZ;
      this.bodySphereHeights = [setup.spheres[0].origin.z * scaleZ, setup.spheres[1].origin.z * scaleZ];
    }
  }

  // ── BSP cell management ───────────────────────────────────

  /**
   * `outsidePortalPolygonIds`: the cell's portal polygons that lead outside
   * (EnvCell cellPortals with OtherCellId 0xFFFF); see bodyScope.
   * `neighborCellIds`: the cells its other portals lead to (full ids); see componentOf.
   */
  addCell(
    cellId: number, cellStruct: CellStruct, position: Frame, outsidePortalPolygonIds?: readonly number[], neighborCellIds?: readonly number[],
  ): void {
    const bsp = buildCollisionBSP(
      cellStruct.physicsBSP.rootNode,
      cellStruct.physicsPolygons,
      cellStruct.vertexArray,
    );
    this.registerCell(cellId, {
      bsp,
      floorBounds: computeFloorBounds(bsp, position.origin, position.orientation),
      // BUG.10 — keep the CELL BSP so findCellContaining can answer
      // point-in-cell queries (ACE EnvCell.point_in_cell semantics).
      cellBspRoot: cellStruct.cellBSP.rootNode,
      origin: position.origin,
      quat: position.orientation,
      blockOffsetX: landblockX(cellId) * 192,
      blockOffsetY: landblockY(cellId) * 192,
      scale: 1,
      building: false,
      outsidePlanes: outsidePortalPolygonIds?.map((id) => portalPlane(cellStruct, id))
        .filter((pl): pl is OutsidePortalPlane => pl !== null),
      neighbors: neighborCellIds?.map((id) => id >>> 0),
      cellBox: cellBoxOf(cellStruct, position, landblockX(cellId) * 192, landblockY(cellId) * 192),
    });
  }

  /**
   * BUG.bunker-sealed-at-ground — what a test of the body stacked on `baseY`
   * at AC landblock-global (gx, gy) meets (scopeFor with the player's body
   * spheres). Retail tests a building's shell from its landcell only
   * (SortCell::find_collisions → BuildingObj::find_building_collisions; ACE
   * SortCell.cs / BuildingObj.cs). A body in an env cell reaches the
   * landcells only when one of its spheres lies within its radius of the
   * plane of one of that cell's outside portals (EnvCell::find_transit_cells
   * → LandCell::add_all_outside_cells; ACE EnvCell.cs:311-371). Away from
   * those, nothing outside the cell is tested: the lid the Holtburg drudge
   * statue's pedestal puts over its ramp (GfxObj 0x01002A1B, a solid plate
   * at ground level) stopped the head of a player walking back up from the
   * Mannikin Foundry room under it (2026-10-18 report: "it seals you in at
   * ground level"). Outdoors, or in a cell registered without its portals,
   * the shells always count.
   */
  private bodyScope(gx: number, gy: number, baseY: number): BodyScope {
    // One step asks it several times at one spot (the move, its step up, the placement, the floor).
    const m = this.lastBodyScope;
    if (m && m.gx === gx && m.gy === gy && m.baseY === baseY && m.epoch === this.scopeEpoch) return m.scope;
    const scope = this.scopeFor(this.bodySphereHeights.map((h) => ({ x: gx, y: gy, z: baseY + h })), this.bodySphereRadius);
    this.lastBodyScope = { gx, gy, baseY, epoch: this.scopeEpoch, scope };
    return scope;
  }
  private lastBodyScope: { gx: number; gy: number; baseY: number; epoch: number; scope: BodyScope } | null = null;
  /** Bumped whenever what bodyScope reads changes (a source, the body cell, the body's spheres). */
  private scopeEpoch = 0;

  /**
   * Whether a body whose feet are at `feetY` at (gx, gy) (AC landblock-global,
   * the player's body spheres) has the landscape's land cells in its cell
   * array: it stands in no registered env cell, or in one with a sphere
   * within its radius of an outside portal's plane (bodyScope). Only
   * then do the terrain's rules (height, slope, water:
   * CLandCell::find_env_collisions @ 00532f20) apply to it.
   */
  reachesLandCells(gx: number, gy: number, feetY: number): boolean {
    return this.bodyScope(gx, gy, feetY).land;
  }

  /**
   * bodyScope for any spheres of radius `radius` (AC landblock-global
   * centres): a missile's too. `home` is the portal-connected group of the
   * env cell the first centre in one stands in (componentOf), found from the
   * body's cell (setBodyCell) through its portals.
   */
  private scopeFor(centres: readonly { x: number; y: number; z: number }[], radius: number): BodyScope {
    const r = radius + PHYSICS_EPSILON;
    let home = -1;
    let inCell = false;
    for (const c of centres) {
      const id = this.findCellContaining(c.x, c.y, c.z, this.bodyCell || this.lastShellCell);
      if (id === 0) continue;
      if (!inCell) home = this.componentOf(id);
      inCell = true;
      this.lastShellCell = id;
      const cell = this.envCells.get(id)!;
      if (!cell.outsidePlanes) return EVERYTHING;
      for (const cc of centres) {
        const p = globalToLocal(cell.origin, cell.quat, { x: cc.x - cell.blockOffsetX, y: cc.y - cell.blockOffsetY, z: cc.z });
        for (const pl of cell.outsidePlanes) {
          const dist = pl.nx * p.x + pl.ny * p.y + pl.nz * p.z + pl.d;
          if (dist > -r && dist < r) return EVERYTHING;
        }
      }
    }
    return inCell ? { land: false, home } : EVERYTHING;
  }
  /** scopeFor's preferred cell when no body cell is set: the last one it found a body in. */
  private lastShellCell = 0;

  /**
   * The cell the player's body is in (0 = outdoors / unknown): where
   * findCellContaining starts for every test of a body (scopeFor), so a
   * point where two unconnected cells overlap is placed in the player's
   * own group of cells (CTransition::find_cell_list starts at the object's
   * cell; CEnvCell::find_transit_cells walks only its portals).
   */
  setBodyCell(cellId: number): void {
    if (this.bodyCell !== cellId >>> 0) this.scopeEpoch++;
    this.bodyCell = cellId >>> 0;
  }
  private bodyCell = 0;

  /**
   * Whether source `src` takes part in a test of a body with `scope`.
   * A land-cell source only when the body reaches the land cells. An env
   * cell (or one of its statics) of a group of cells no portal joins to the
   * body's own (componentOf) only then too: retail's cell array holds the
   * body's cell, the cells its portals lead to, and the land cells near an
   * outside portal (CEnvCell::find_transit_cells @ 0052c820), never a cell
   * that merely overlaps it. Before this, the rooms of Eastham's two portal
   * bunkers under the town (0xCE94 0x0102 / 0x0107, Env 0x0D0003F4, both
   * eras) and the basements of the olthoi mounds (building 0x01004031) at
   * 0xC4B5 and 0xE6D3 stood in each other's space: one's walls blocked a
   * player walking in the other, and its floors held them up.
   */
  private inScope(src: ScopedSource, scope: BodyScope): boolean {
    if (src.landCell) return scope.land;
    if (scope.land || scope.home < 0) return true;
    const c = this.componentOf(src.envCellId);
    return c < 0 || c === scope.home;
  }

  /**
   * The group of registered env cells joined to `cellId` by portals that
   * lead both ways (EnvCell cellPortals), as a number; -1 when the cell was
   * registered without its portals (then nothing is set apart from it). A
   * cell only one of whose portals names another (a dangling cell such as
   * 0xD2D403B4, whose one portal leads to 0x03B3 but not back) is a group
   * of its own: a body in the other never reaches it.
   */
  private componentOf(cellId: number): number {
    if (!this.components) {
      const comp = new Map<number, number>();
      let next = 0;
      for (const [id, cell] of this.envCells) {
        if (!cell.neighbors || comp.has(id)) continue;
        const group = next++;
        comp.set(id, group);
        const queue = [id];
        while (queue.length > 0) {
          const at = queue.pop()!;
          for (const n of this.envCells.get(at)!.neighbors!) {
            if (comp.has(n)) continue;
            const other = this.envCells.get(n);
            if (!other?.neighbors?.includes(at)) continue;
            comp.set(n, group);
            queue.push(n);
          }
        }
      }
      this.components = comp;
    }
    return this.components.get(cellId >>> 0) ?? -1;
  }
  /** componentOf's groups; null = rebuild (an env cell was added or removed). */
  private components: Map<number, number> | null = null;

  /**
   * BUG.bunker-camera-in-head — whether the camera's viewer sphere at AC
   * landblock-global (x, y, z) reaches the land cells (the terrain, building
   * shells, land objects): in no env cell, in a cell registered without its
   * portals, or within `radius` of one of its cell's outside portal planes
   * (CEnvCell::find_transit_cells @ 0052c820 → CLandCell::add_all_outside_cells;
   * ACE EnvCell.cs:311-371). The probe viewerLandFrom steps along the boom;
   * a missile's terrain sweep (main.ts missileEnvironmentSweep) asks it of
   * the missile's sphere.
   */
  viewerReachesLand(x: number, y: number, z: number, radius: number): boolean {
    return this.scopeFor([{ x, y, z }], radius).land;
  }

  /** Map.set semantics (a re-registered key keeps its original scan position) + the spatial grid. */
  private registerCell(key: CollisionKey, data: Omit<CellCollision, 'seq' | 'gridCells' | 'landCell' | 'envCellId'>): void {
    const prev = this.cells.get(key);
    const landCell = data.building || landKey(key);
    const entry: CellCollision = { ...data, landCell, envCellId: landCell ? 0 : envCellOfKey(key), seq: prev ? prev.seq : this.nextSeq++, gridCells: [] };
    if (prev) this.cellGrid.remove(prev);
    this.cells.set(key, entry);
    this.scopeEpoch++;
    if (typeof key === 'number') {
      this.components = null;
      if (entry.cellBspRoot) {
        this.envCells.set(key, entry);
        let slot = this.envCellSlots.get(key);
        if (!slot) { slot = { cellId: key, seq: entry.seq, gridCells: [] }; this.envCellSlots.set(key, slot); }
        const b = entry.cellBox;
        if (b) this.envCellGrid.insert(slot, (b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, Math.hypot(b.maxX - b.minX, b.maxY - b.minY) / 2);
        else this.envCellGrid.insert(slot, NaN, NaN, NaN);
      } else {
        this.dropEnvCell(key);
      }
    }
    // World XZ footprint: the physics BSP root's bounding sphere, scaled and
    // carried out of the source's frame. No sphere → always scanned.
    const bs = data.bsp.boundingSphere;
    if (!bs) {
      this.cellGrid.insert(entry, NaN, NaN, NaN);
      return;
    }
    const c = quatRotate(data.quat, { x: bs.center.x * data.scale, y: bs.center.y * data.scale, z: bs.center.z * data.scale });
    this.cellGrid.insert(entry,
      data.blockOffsetX + data.origin.x + c.x,
      data.blockOffsetY + data.origin.y + c.y,
      bs.radius * data.scale);
  }

  private dropEnvCell(cellId: number): void {
    this.envCells.delete(cellId);
    const slot = this.envCellSlots.get(cellId);
    if (slot) { this.envCellGrid.remove(slot); this.envCellSlots.delete(cellId); }
  }

  removeCell(key: CollisionKey): void {
    const prev = this.cells.get(key);
    if (!prev) return;
    this.cellGrid.remove(prev);
    this.cells.delete(key);
    this.scopeEpoch++;
    if (typeof key === 'number') { this.dropEnvCell(key); this.components = null; }
  }

  /** Remove whatever source (BSP cell, cylinder or sphere obstacle) is registered under `key`. */
  removeKey(key: CollisionKey): void {
    this.removeCell(key);
    this.removeCylinderObstacle(key);
    this.removeSphereObstacle(key);
  }

  get cellCount(): number {
    return this.cells.size;
  }

  /** BSP sources whose XZ footprint can reach the disc (x, z, r) — AC landblock-global XY = world X/Z. */
  private cellsNear(x: number, z: number, r: number): Iterable<CellCollision> {
    return this.spatialIndex ? this.cellGrid.queryDisc(x, z, r) : this.cells.values();
  }

  /**
   * BUG.10 — which registered interior cell contains the given AC-world
   * point? Containment core of ACE EnvCell.find_visible_child_cell
   * (Physics/Common/EnvCell.cs:195-221): test the preferred cell first (the
   * player's current cell — the overwhelmingly common answer), then scan
   * the rest. Returns 0 when no registered cell contains the point (e.g.
   * mid-portal, or outside the dungeon).
   *
   * After the preferred cell come the cells its portals lead to, outward
   * through theirs (CTransition::find_cell_list → CEnvCell::find_transit_cells
   * @ 0052c820 walks the current cell's portals), and only then the rest.
   * Where two unconnected cells overlap (Eastham's two bunker rooms, 0xC4B5's
   * olthoi mound basements; a dangling cell like 0xD2D403B4 over a house's stairs)
   * a body stepping on from its cell stays in its own group of cells: by id
   * order the scan put it in the other one, and the cell tracking followed.
   */
  findCellContaining(acX: number, acY: number, acZ: number, preferredCellId = 0): number {
    const test = (cellId: number): boolean => {
      const cell = this.envCells.get(cellId);
      if (!cell || !cell.cellBspRoot) return false;
      const b = cell.cellBox;
      if (b && (acX < b.minX || acX > b.maxX || acY < b.minY || acY > b.maxY || acZ < b.minZ || acZ > b.maxZ)) return false;
      return pointInCell(
        cell.cellBspRoot,
        cell.origin,
        cell.quat,
        { x: acX - cell.blockOffsetX, y: acY - cell.blockOffsetY, z: acZ },
      );
    };
    const start = preferredCellId ? this.envCells.get(preferredCellId >>> 0) : undefined;
    if (start && test(preferredCellId)) return preferredCellId;
    let tried: Set<number> | null = null;
    if (start?.neighbors) {
      tried = new Set([preferredCellId >>> 0]);
      const queue = [...start.neighbors];
      for (let i = 0; i < queue.length; i++) {
        const id = queue[i];
        if (tried.has(id)) continue;
        tried.add(id);
        const cell = this.envCells.get(id);
        if (!cell) continue;
        if (test(id)) return id;
        if (cell.neighbors) for (const n of cell.neighbors) if (!tried.has(n)) queue.push(n);
      }
    }
    if (this.spatialIndex) {
      // The cells whose bounds reach the point, in registration order (as the scan below visits them).
      for (const slot of this.envCellGrid.queryDisc(acX, acY, 0)) {
        if (slot.cellId !== preferredCellId && !tried?.has(slot.cellId) && test(slot.cellId)) return slot.cellId;
      }
      return 0;
    }
    for (const cellId of this.envCells.keys()) {
      if (cellId !== preferredCellId && !tried?.has(cellId) && test(cellId)) return cellId;
    }
    return 0;
  }

  /**
   * Add a cylinder obstacle for sphere-collision objects (trees, rocks,
   * lamps — AC GfxObjs without physicsBSP). The player is approximated as a
   * sphere with `playerRadius`; collision triggers when the player's
   * footprint would overlap the cylinder. Vertical-range filtering via
   * bottomY/topY lets canopy-style obstacles (only the lower trunk blocks)
   * be modeled without blocking under-the-leaves passage.
   */
  addCylinderObstacle(
    key: CollisionKey,
    worldX: number,
    worldZ: number,
    radius: number,
    bottomY = -Infinity,
    topY = Infinity,
  ): void {
    if (radius <= 0) return;
    const prev = this.cylinders.get(key);
    if (prev) this.cylinderGrid.remove(prev);
    const entry: CylinderObstacle = {
      x: worldX, z: worldZ, radius, bottomY, topY,
      inCell: typeof key === 'string' && key.startsWith('cs:'),
      landCell: landKey(key), envCellId: envCellOfKey(key),
      seq: prev ? prev.seq : this.nextSeq++, gridCells: [],
    };
    this.cylinders.set(key, entry);
    this.cylinderGrid.insert(entry, worldX, worldZ, radius);
    if (radius > this.maxObstacleRadius) this.maxObstacleRadius = radius;
  }

  removeCylinderObstacle(key: CollisionKey): void {
    const prev = this.cylinders.get(key);
    if (!prev) return;
    this.cylinderGrid.remove(prev);
    this.cylinders.delete(key);
  }

  get cylinderCount(): number {
    return this.cylinders.size;
  }

  /**
   * A Setup `Sphere` obstacle (ACE PhysicsObj.FindObjCollisions' sphere
   * branch → Sphere.IntersectsSphere): blocks a body sphere whose centre
   * comes within (body radius + radius − EPSILON). World THREE coordinates
   * (Y = height).
   */
  addSphereObstacle(key: CollisionKey, worldX: number, worldY: number, worldZ: number, radius: number): void {
    if (radius <= 0) return;
    const prev = this.spheres.get(key);
    if (prev) this.sphereGrid.remove(prev);
    const entry: SphereObstacle = {
      x: worldX, y: worldY, z: worldZ, radius,
      landCell: landKey(key), envCellId: envCellOfKey(key),
      seq: prev ? prev.seq : this.nextSeq++, gridCells: [],
    };
    this.spheres.set(key, entry);
    this.sphereGrid.insert(entry, worldX, worldZ, radius);
    if (radius > this.maxObstacleRadius) this.maxObstacleRadius = radius;
  }

  removeSphereObstacle(key: CollisionKey): void {
    const prev = this.spheres.get(key);
    if (!prev) return;
    this.sphereGrid.remove(prev);
    this.spheres.delete(key);
  }

  get sphereCount(): number {
    return this.spheres.size;
  }

  /**
   * Add a GfxObj's physics BSP as a collision source (building exterior parts,
   * static objects like furniture/columns). Each GfxObj has its own physicsBSP
   * that AC tests separately via BuildingObj.find_building_collisions and
   * PhysicsPart.FindObjCollisions.
   *
   * @param key Unique key for this collision source (e.g., "bldg_cellId_partIdx")
   * @param gfxObj The GfxObj with physicsBSP and physicsPolygons
   * @param worldOrigin World position in AC Z-up landblock-local coords
   * @param worldQuat Orientation quaternion in AC Z-up
   * @param blockOffsetX Landblock X offset (blockX * 192)
   * @param blockOffsetY Landblock Y offset (blockY * 192)
   */
  addGfxObjCollision(
    key: CollisionKey,
    gfxObj: GfxObj,
    worldOrigin: { x: number; y: number; z: number },
    worldQuat: { w: number; x: number; y: number; z: number },
    blockOffsetX: number,
    blockOffsetY: number,
    scale = 1,
    options: GfxObjCollisionOptions = {},
  ): void {
    if (!gfxObj.physicsBSP || !gfxObj.vertexArray || gfxObj.physicsPolygons.size === 0) return;
    if (!(scale > 0)) return;
    // A server object's part BSPs are registered for every movement step
    // (CreatureCollision.addCreatureObstacles); the resolved tree depends
    // only on the GfxObj, so build it once per GfxObj.
    let bsp = gfxBspCache.get(gfxObj);
    if (!bsp) {
      bsp = buildCollisionBSP(gfxObj.physicsBSP.rootNode, gfxObj.physicsPolygons, gfxObj.vertexArray);
      gfxBspCache.set(gfxObj, bsp);
    }
    this.registerCell(key, {
      bsp,
      floorBounds: computeFloorBounds(bsp, worldOrigin, worldQuat, scale),
      // GfxObj collision sources are not EnvCells — no CELL BSP, so
      // findCellContaining never matches them.
      cellBspRoot: undefined,
      origin: worldOrigin,
      quat: worldQuat,
      blockOffsetX,
      blockOffsetY,
      scale,
      building: options.building === true,
    });
  }

  /** Whether cell `cellId`'s BSP is registered (BUG.seen-outside-arrival-dungeon-mode). */
  hasCell(cellId: number): boolean {
    return this.cells.has(cellId >>> 0);
  }

  get hasCells(): boolean {
    return this.cells.size > 0 || this.cylinders.size > 0 || this.spheres.size > 0;
  }

  /**
   * Compose a parent frame with a child frame to get the child's position/orientation
   * in the parent's coordinate space. Used for SetupModel part placement: compose
   * the stab frame (landblock-local) with the part's placement frame (model-local)
   * to get the part's landblock-local position.
   *
   * Result origin = parentOrigin + rotate(parentQuat, childOrigin)
   * Result quat = parentQuat * childQuat
   */
  static composeFrames(
    parentOrigin: { x: number; y: number; z: number },
    parentQuat: { w: number; x: number; y: number; z: number },
    childOrigin: { x: number; y: number; z: number },
    childQuat: { w: number; x: number; y: number; z: number },
  ) {
    const rotated = quatRotate(parentQuat, childOrigin);
    return {
      origin: {
        x: parentOrigin.x + rotated.x,
        y: parentOrigin.y + rotated.y,
        z: parentOrigin.z + rotated.z,
      },
      orientation: quatMultiply(parentQuat, childQuat),
    };
  }

  // ── Legacy mesh setters (outdoor/camera) ──────────────────

  setDungeonGroup(group: THREE.Group): void {
    this.renderMeshes = [];
    this.landCellMeshes.clear();
    this.meshCells.clear();
    group.traverse(child => {
      if (!(child instanceof THREE.Mesh && child.userData.cellGeometry)) return;
      this.renderMeshes.push(child);
      for (let o: THREE.Object3D | null = child; o; o = o.parent) {
        if (o.userData.envCellId !== undefined) { this.meshCells.set(child, o.userData.envCellId >>> 0); break; }
      }
    });
  }

  /**
   * `objects`: building exteriors (land-cell objects) and interior cell
   * meshes (EnvCellRenderer.createCellMesh roots, tagged
   * userData.envCellId; their statics are children).
   */
  setMeshes(objects: THREE.Object3D[]): void {
    this.renderMeshes = [];
    this.landCellMeshes.clear();
    this.meshCells.clear();
    for (const obj of objects) {
      obj.updateMatrixWorld(true);
      const land = obj.userData.envCellId === undefined;
      obj.traverse(child => {
        if (!(child instanceof THREE.Mesh)) return;
        this.renderMeshes.push(child);
        if (land) this.landCellMeshes.add(child);
        else this.meshCells.set(child, obj.userData.envCellId >>> 0);
      });
    }
  }

  /** BUG.bunker-camera-in-head — the render meshes of land-cell objects (building shells), not of any env cell. */
  private readonly landCellMeshes = new Set<THREE.Object3D>();
  /** The env cell each interior render mesh (a cell's geometry or one of its statics) belongs to (inScope for the camera). */
  private readonly meshCells = new Map<THREE.Object3D, number>();

  /**
   * The camera / wall rays hit both faces of every collision mesh. Building
   * materials are shared and back-face culled for drawing (retail culls
   * single-sided polygons), so the double-siding lasts only for the cast
   * instead of being written into the materials.
   */
  private intersectRenderMeshes(): THREE.Intersection[] {
    const restore: Array<[THREE.Material, THREE.Side]> = [];
    for (const mesh of this.renderMeshes) {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        if (m.side !== THREE.DoubleSide) { restore.push([m, m.side]); m.side = THREE.DoubleSide; }
      }
    }
    try {
      return this.raycaster.intersectObjects(this.renderMeshes, false);
    } finally {
      for (const [m, side] of restore) m.side = side;
    }
  }

  setPhysicsMeshes(_objects: THREE.Object3D[]): void {
    // No longer needed — BSP handles collision directly
  }

  refreshMeshes(group: THREE.Group): void {
    this.setDungeonGroup(group);
  }

  // ── Wall collision ────────────────────────────────────────

  /**
   * Test movement and return adjusted deltas with wall sliding.
   *
   * For BSP cells: tests sphere at proposed destination position.
   * Falls back to raycaster for outdoor collision.
   */
  getAdjustedMovement(pos: THREE.Vector3, deltaX: number, deltaZ: number): [number, number] {
    this.lastStepUp = 0;
    if (Math.abs(deltaX) < 0.001 && Math.abs(deltaZ) < 0.001) return [deltaX, deltaZ];

    if (this.cells.size > 0 || this.cylinders.size > 0 || this.spheres.size > 0) {
      return this.bspGetAdjustedMovement(pos, deltaX, deltaZ);
    }
    return this.raycastGetAdjustedMovement(pos, deltaX, deltaZ);
  }

  /**
   * Test the proposed destination against the CylSphere + Sphere obstacles
   * (ACE PhysicsObj.FindObjCollisions' cylsphere / sphere branches). Each
   * body sphere (feet/head) is tested at the destination:
   *  - CylSphere.CollidesWithSphere (Physics/CylSphere.cs:205): horizontal
   *    distance ≤ R − EPS + r, and the sphere's centre within r − EPS of the
   *    cylinder's [LowPoint, LowPoint + Height] span;
   *  - Sphere.IntersectsSphere (Physics/Sphere.cs:288): centre distance ≤
   *    R + r − EPS.
   * Escape rule: a hit on an obstacle the body ALREADY overlaps at `pos` does
   * not block a move that doesn't bring it closer (distance at the
   * destination ≥ distance now) — ACE lets an interpenetrating sphere move
   * out instead of pinning it in every heading.
   * Returns the first blocking hit (registration order) with the XZ outward
   * normal and which body sphere (0 = feet) it hit, or null.
   *
   * MOVE.run-turn-collision-stop — the normal is taken at the body's CURRENT
   * position, not at the destination: retail `CSphere::slide_sphere
   * @ 00536f40` (ACE Sphere.SlideSphere, Physics/Sphere.cs) and
   * `CCylSphere::slide_sphere @ 0053b2a0` (ACE CylSphere.CollisionNormal)
   * both build it from `global_curr_center − center`. A tangent of the
   * current position's normal never brings the body closer to the obstacle,
   * so a body resting against it slides on. The destination's normal tilts
   * the tangent back into the obstacle: once the body touched (distance =
   * the radius sum), every slide re-tested as a hit and the step returned
   * [0, 0], so a player running into Pathwarden Thorolf in Holtburg stopped
   * dead where retail ran round him.
   *
   * `rise` is how far the body sphere would have to climb to stand on the
   * obstacle — StepSphereUp's test (ACE Sphere.StepSphereUp: radsum −
   * disp.Z; CylSphere.StepSphereUp: radius + Height − disp.Z): only when it
   * is within StepUpHeight is a step up tried, otherwise the body slides.
   */
  private obstacleTestMovement(
    pos: THREE.Vector3,
    deltaX: number,
    deltaZ: number,
  ): { nx: number; nz: number; sphere: number; rise: number } | null {
    if (this.cylinders.size === 0 && this.spheres.size === 0) return null;
    const destX = pos.x + deltaX;
    const destZ = pos.z + deltaZ;
    const r = this.bodySphereRadius;
    const pad = r + this.maxObstacleRadius;
    // The current position's outward normal (cx, cz); the destination's only
    // when the body stands on the obstacle's axis (no direction to take).
    const radialNormal = (cx: number, cz: number, dx: number, dz: number): { nx: number; nz: number } => {
      const c = Math.sqrt(cx * cx + cz * cz);
      if (c > 0.001) return { nx: cx / c, nz: cz / c };
      const d = Math.sqrt(dx * dx + dz * dz);
      return d > 0.001 ? { nx: dx / d, nz: dz / d } : { nx: 1, nz: 0 };
    };

    // A tree or a landblock static is in the land cells, another cell's static in that cell (inScope).
    let scope: BodyScope | undefined;
    if (this.cylinders.size > 0) {
      const cyls = this.spatialIndex
        ? this.cylinderGrid.queryDisc(destX, destZ, r + this.maxObstacleRadius)
        : this.cylinders.values();
      for (const cyl of cyls) {
        if (scoped(cyl) && !this.inScope(cyl, scope ??= this.bodyScope(destX, destZ, pos.y))) continue;
        const radsum = cyl.radius - PHYSICS_EPSILON + r;
        for (let si = 0; si < this.bodySphereHeights.length; si++) {
          const cy = pos.y + this.bodySphereHeights[si];
          // Vertical span test (CollidesWithSphere's |H/2 − dz| ≤ r − EPS + H/2).
          if (cy < cyl.bottomY - (r - PHYSICS_EPSILON) || cy > cyl.topY + (r - PHYSICS_EPSILON)) continue;
          const dx = destX - cyl.x;
          const dz = destZ - cyl.z;
          const dist2 = dx * dx + dz * dz;
          if (dist2 > radsum * radsum) continue;
          const cx = pos.x - cyl.x;
          const cz = pos.z - cyl.z;
          const cur2 = cx * cx + cz * cz;
          if (cur2 <= radsum * radsum && dist2 >= cur2) continue; // escaping an overlap
          return { ...radialNormal(cx, cz, dx, dz), sphere: si, rise: r + cyl.topY - cy };
        }
      }
    }

    if (this.spheres.size > 0) {
      const sphs = this.spatialIndex ? this.sphereGrid.queryDisc(destX, destZ, pad) : this.spheres.values();
      for (const sph of sphs) {
        if (scoped(sph) && !this.inScope(sph, scope ??= this.bodyScope(destX, destZ, pos.y))) continue;
        const radsum = sph.radius + r - PHYSICS_EPSILON;
        for (let si = 0; si < this.bodySphereHeights.length; si++) {
          const dy = pos.y + this.bodySphereHeights[si] - sph.y;
          const dx = destX - sph.x;
          const dz = destZ - sph.z;
          const dist2 = dx * dx + dy * dy + dz * dz;
          if (dist2 > radsum * radsum) continue;
          const cx = pos.x - sph.x;
          const cz = pos.z - sph.z;
          const cur2 = cx * cx + dy * dy + cz * cz;
          if (cur2 <= radsum * radsum && dist2 >= cur2) continue; // escaping an overlap
          return { ...radialNormal(cx, cz, dx, dz), sphere: si, rise: sph.radius + r - dy };
        }
      }
    }
    return null;
  }

  private bspGetAdjustedMovement(pos: THREE.Vector3, deltaX: number, deltaZ: number): [number, number] {
    // Convert movement to AC Z-up: Three.js (dX, 0, dZ) → AC (dX, dZ, 0)
    const acMovement = { x: deltaX, y: deltaZ, z: 0 };

    // FAITHFUL.199 — CylSphere / Sphere obstacles (scenery, statics) are
    // checked BEFORE BSP cells. A feet-sphere hit first tries to step up
    // (ACE CylSphere/Sphere.IntersectsSphere → StepSphereUp on a walkable
    // contact); otherwise slide along the obstacle's tangent. The step up is
    // only tried for an obstacle no taller than StepUpHeight above the feet
    // sphere (StepSphereUp's rise test): a creature's body spheres are never
    // stepped onto, however the raised body would clear them.
    // RECON.transition-stepup-stepdown-port.c.b: the step up is
    // CTransition::step_up (CCylSphere::step_sphere_up @ 0053b310,
    // CSphere::step_sphere_up @ 00537900): the feet sphere lands on the cylinder's top,
    // a walkable spot of the sphere, a BSP walkable or the terrain, then the
    // body must fit there. Else step_up_slide (the slide below).
    const cylHit = this.obstacleTestMovement(pos, deltaX, deltaZ);
    if (cylHit && cylHit.sphere === 0 && cylHit.rise <= this.stepUpHeight) {
      const lift = this.bspStepUp(pos, deltaX, deltaZ);
      if (lift !== null) {
        this.lastStepUp = lift;
        return [deltaX, deltaZ];
      }
    }
    if (cylHit) {
      this.setCollisionNormal(cylHit.nx, cylHit.nz);
      // Slide along the cylinder tangent (perpendicular to the outward normal).
      // Tangent direction: rotate normal 90° in XZ plane → (-nz, nx).
      // Project movement onto tangent: t = (delta · tangent) * tangent.
      const tx = -cylHit.nz;
      const tz = cylHit.nx;
      const dot = deltaX * tx + deltaZ * tz;
      const slideX = dot * tx;
      const slideZ = dot * tz;
      // Test slide direction against cylinders + BSP.
      if (Math.abs(slideX) > 0.001 || Math.abs(slideZ) > 0.001) {
        const slideCylHit = this.obstacleTestMovement(pos, slideX, slideZ);
        if (!slideCylHit) {
          // Still need to check BSP for the slide direction.
          const slideBspHit = this.bspTestMovement(pos, slideX, slideZ, { x: slideX, y: slideZ, z: 0 });
          if (!slideBspHit) return [slideX, slideZ];
        }
      }
      return [0, 0];
    }

    // Test sphere at proposed destination
    const hit = this.bspTestMovement(pos, deltaX, deltaZ, acMovement);
    if (!hit) return [deltaX, deltaZ];

    // BSPTREE::find_collisions on a body in contact: a feet-sphere hit runs
    // step_sphere_up (CTransition::step_up, else step_up_slide = the slide
    // below); a head-sphere hit only slides (slide_sphere).
    if (hit.sphere === 0) {
      const lift = this.bspStepUp(pos, deltaX, deltaZ);
      if (lift !== null) {
        this.lastStepUp = lift;
        return [deltaX, deltaZ];
      }
    }

    // Wall hit — compute slide direction
    // Transform hit normal from cell-local to AC landblock space
    const hitCell = hit.cell;
    const localNormal = hit.hit.polygon.plane.normal;
    const acNormal = localToGlobalVec(hitCell.quat, localNormal);

    // Project movement onto wall tangent: slide = move - dot(move, N)*N
    const dotMN = acMovement.x * acNormal.x + acMovement.y * acNormal.y;
    if (dotMN >= 0) return [deltaX, deltaZ]; // moving away
    this.setCollisionNormal(acNormal.x, acNormal.y, acNormal.z);

    const slideX = acMovement.x - dotMN * acNormal.x;
    const slideY = acMovement.y - dotMN * acNormal.y;

    // Test slide movement
    if (Math.abs(slideX) > 0.001 || Math.abs(slideY) > 0.001) {
      const slideHit = this.bspTestMovement(pos, slideX, slideY, { x: slideX, y: slideY, z: 0 });
      if (!slideHit) return [slideX, slideY]; // AC (x,y) → Three.js (deltaX, deltaZ)

      // Try step-up on slide direction too (diagonal stair approach)
      if (slideHit.sphere === 0) {
        const slideLift = this.bspStepUp(pos, slideX, slideY);
        if (slideLift !== null) {
          this.lastStepUp = slideLift;
          return [slideX, slideY];
        }
      }

      // Corner — project against second wall
      const n2 = localToGlobalVec(slideHit.cell.quat, slideHit.hit.polygon.plane.normal);
      const dot2 = slideX * n2.x + slideY * n2.y;
      if (dot2 < 0) {
        this.setCollisionNormal(n2.x, n2.y, n2.z);
        const sx2 = slideX - dot2 * n2.x;
        const sy2 = slideY - dot2 * n2.y;
        if (Math.abs(sx2) > 0.001 || Math.abs(sy2) > 0.001) {
          const finalHit = this.bspTestMovement(pos, sx2, sy2, { x: sx2, y: sy2, z: 0 });
          if (!finalHit) return [sx2, sy2];
        }
      }
    }

    return [0, 0];
  }

  /**
   * BUG.spell-projectile-physics — sweep a free sphere (a missile's Setup
   * sphere) from `from` to `to` (THREE world) against every source this
   * instance holds: BSP cells / building + static part BSPs, CylSphere and
   * Sphere obstacles. Like retail CTransition (calc_num_steps @ 0050a0b0
   * divides the move into steps of the sphere radius) the sphere is tested at
   * radius-sized steps; the result is the last free fraction `t` of the move
   * and the contact normal (THREE world), or null when the path is clear.
   */
  sweepSphere(
    from: { x: number; y: number; z: number },
    to: { x: number; y: number; z: number },
    radius: number,
  ): { t: number; normal: { x: number; y: number; z: number } } | null {
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const len = Math.hypot(dx, dy, dz);
    if (!(len > 0) || !(radius > 0)) return null;
    const n = Math.max(1, Math.ceil(len / radius));
    // Step movement in AC axes (Three (x, y, z) → AC (x, z, y)).
    const acStep = { x: dx / n, y: dz / n, z: dy / n };
    for (let i = 1; i <= n; i++) {
      const px = from.x + dx * (i / n), py = from.y + dy * (i / n), pz = from.z + dz * (i / n);
      const normal = this.sphereContactAt(px, py, pz, radius, acStep);
      if (normal) return { t: (i - 1) / n, normal };
    }
    return null;
  }

  /** The contact normal (THREE world) of a sphere at (x, y, z) moving by `acStep`, or null. */
  private sphereContactAt(
    x: number, y: number, z: number, radius: number, acStep: { x: number; y: number; z: number },
  ): { x: number; y: number; z: number } | null {
    let scope: BodyScope | undefined;
    for (const cell of this.cellsNear(x, z, radius)) {
      // BUG.bunker-sealed-at-ground — a missile in an env cell meets the shells only near its outside portals.
      if (scoped(cell) && !this.inScope(cell, scope ??= this.scopeFor([{ x, y: z, z: y }], radius))) continue;
      const inv = 1 / cell.scale;
      const local = scaleVec(globalToLocal(cell.origin, cell.quat,
        { x: x - cell.blockOffsetX, y: z - cell.blockOffsetY, z: y }), inv);
      const move = scaleVec(quatRotate(quatConjugate(cell.quat), acStep), inv);
      const hit = sphereIntersectsAnyPoly(cell.bsp, { center: local, radius: radius * inv }, move);
      if (hit) {
        const g = localToGlobalVec(cell.quat, hit.polygon.plane.normal);
        return { x: g.x, y: g.z, z: g.y };
      }
    }
    const cyls = this.spatialIndex
      ? this.cylinderGrid.queryDisc(x, z, radius + this.maxObstacleRadius)
      : this.cylinders.values();
    for (const c of cyls) {
      if (scoped(c) && !this.inScope(c, scope ??= this.scopeFor([{ x, y: z, z: y }], radius))) continue;
      if (y < c.bottomY - radius || y > c.topY + radius) continue;
      const ox = x - c.x, oz = z - c.z;
      const r = c.radius + radius - PHYSICS_EPSILON;
      const d2 = ox * ox + oz * oz;
      if (d2 >= r * r) continue;
      const d = Math.sqrt(d2) || 1;
      return { x: ox / d, y: 0, z: oz / d };
    }
    const sphs = this.spatialIndex
      ? this.sphereGrid.queryDisc(x, z, radius + this.maxObstacleRadius)
      : this.spheres.values();
    for (const s of sphs) {
      if (scoped(s) && !this.inScope(s, scope ??= this.scopeFor([{ x, y: z, z: y }], radius))) continue;
      const ox = x - s.x, oy = y - s.y, oz = z - s.z;
      const r = s.radius + radius - PHYSICS_EPSILON;
      const d2 = ox * ox + oy * oy + oz * oz;
      if (d2 >= r * r) continue;
      const d = Math.sqrt(d2) || 1;
      return { x: ox / d, y: oy / d, z: oz / d };
    }
    return null;
  }

  /**
   * RECON.transition-stepup-stepdown-port.c — CTransition::step_up
   * @ 0050b610 (ACE Transition.cs:744) for the building, static and
   * EnvCell BSPs this collider holds. The check position is NOT raised:
   * step_down runs with step_up set, so BSPTREE::step_sphere_down's (@ 0053a210)
   * find_walkable sets the feet sphere at the destination down onto (that
   * is, lifts it up onto) every walkable polygon it overlaps, along
   * up × −(step_up_height × walk_interp), with the walkable allowance
   * get_walkable_z (FloorZ for a body on the ground). CPolygon::
   * adjust_sphere_to_plane caps the lift at 1.5 × StepUpHeight. The step
   * then needs a contact plane (some walkable moved the sphere) and the
   * body must fit where it lands: the Placement insert
   * (sphere_intersects_solid on both body spheres), plus the CylSphere /
   * Sphere obstacles (CheckOtherCells). Returns the lift (metres up), or
   * null when the step fails (the caller then slides: step_up_slide).
   *
   * Outside every EnvCell with no BSP walkable under the feet, the landing
   * is the terrain (LandCell::find_env_collisions; terrainStepUpLift), then
   * the same Placement test: a riser with no walkable top (a fence, a rock
   * face) is slid along, never stepped over
   * (RECON.transition-stepup-stepdown-port.c.a).
   * The CylSphere / Sphere obstacles take part in the same step down
   * (obstacleStepDownLift), and a step up begun by an obstacle hit runs
   * this too (RECON.transition-stepup-stepdown-port.c.b).
   * BUG.moveto-wall-climb-flying-target: a 51° academy alcove wall is not
   * walkable at FloorZ, so the raised body no longer climbs it.
   */
  private bspStepUp(
    pos: THREE.Vector3, deltaX: number, deltaZ: number,
  ): number | null {
    const destX = pos.x + deltaX;
    const destZ = pos.z + deltaZ;
    const footY = pos.y + this.lowerSphereHeight;
    const path = { walkInterp: 1, walkableAllowance: FLOOR_WALKABLE_Z };
    // The feet sphere's centre in AC landblock axes (Z-up), moved in place.
    let gx = destX;
    let gy = destZ;
    let gz = footY;
    let landed = false;
    // CTransition::transitional_insert(5): insert until nothing adjusts.
    const scope = this.bodyScope(destX, destZ, pos.y);
    for (let attempt = 0; attempt < 5; attempt++) {
      let changed = false;
      for (const cell of this.cellsNear(destX, destZ, this.bodySphereRadius)) {
        if (scoped(cell) && !this.inScope(cell, scope)) continue;
        const inv = 1 / cell.scale;
        const localUp = quatRotate(quatConjugate(cell.quat), AC_UP);
        const movement = scaleVec(localUp, -(this.stepUpHeight * path.walkInterp) * inv);
        const start = scaleVec(globalToLocal(cell.origin, cell.quat,
          { x: gx - cell.blockOffsetX, y: gy - cell.blockOffsetY, z: gz }), inv);
        const sphere: CollisionSphere = { center: start, radius: this.bodySphereRadius * inv };
        // Never onto a walkable the body stands under (a roof over an attic,
        // seen from inside): it is reached only through the polygon itself.
        const here = scaleVec(globalToLocal(cell.origin, cell.quat,
          { x: pos.x - cell.blockOffsetX, y: pos.z - cell.blockOffsetY, z: footY }), inv);
        if (!findWalkable(cell.bsp, path, sphere, movement, localUp, (poly) => underFromBehind(poly, here, localUp))) continue;
        const off = localToGlobalVec(cell.quat, {
          x: (sphere.center.x - start.x) * cell.scale,
          y: (sphere.center.y - start.y) * cell.scale,
          z: (sphere.center.z - start.z) * cell.scale,
        });
        gx += off.x;
        gy += off.y;
        gz += off.z;
        changed = true;
        landed = true;
      }
      // CheckOtherCells: the CylSphere / Sphere obstacles step the sphere
      // down onto (that is, up onto) their tops too.
      const obstacleLift = this.obstacleStepDownLift(gx, gy, gz, path);
      if (obstacleLift === null) return null; // COLLIDED_TS: the step fails
      if (obstacleLift > 0) {
        gz += obstacleLift;
        changed = true;
        landed = true;
      }
      if (!changed) break;
    }

    if (!landed) {
      // Inside an EnvCell no walkable means no contact plane. Outside every
      // cell the land cell's terrain polygon is the other step_down
      // candidate (CheckOtherCells); with none the step fails too.
      if (this.findCellContaining(destX, destZ, footY) !== 0) return null;
      const terrain = this.terrainLanding?.(destX, destZ) ?? null;
      if (!terrain) return null;
      const terrainLift = terrainStepUpLift(footY - this.bodySphereRadius, terrain, this.stepUpHeight);
      if (terrainLift === null) return null;
      gz = footY + terrainLift;
    }

    const lift = gz - footY;
    const baseY = pos.y + lift;
    if (!this.bodyFitsAt(gx, gy, baseY)) return null;
    if (this.obstacleTestMovement(scratchLanding.set(pos.x, baseY, pos.z), deltaX, deltaZ)) return null;
    return lift;
  }

  /**
   * RECON.transition-stepup-stepdown-port.c.b — the CylSphere / Sphere
   * obstacles' part of a step up's step_down (step_up set, so the feet
   * sphere is not lowered first): the first obstacle that the feet sphere
   * at (gx, gy, gz) — AC landblock-global, Z up — or the head sphere
   * stacked on it overlaps lifts it.
   *  - CCylSphere::step_sphere_down @ 0053a9b0 (ACE CylSphere.StepSphereDown):
   *    up by deltaz = Height + radius − disp.Z, onto the flat top (contact
   *    plane +Z, always walkable);
   *  - CSphere::step_sphere_down @ 00536d20 (ACE Sphere.StepSphereDown): up
   *    by sqrt(reach² − dxy²) − disp.Z (reach = radsum + F_EPSILON), onto the
   *    sphere's surface; a spot whose normal Z is not above the walkable
   *    allowance is no contact (OK_TS), so a body meeting a boulder at its
   *    side slides round it.
   * Both refuse (COLLIDED_TS) a lift past 1.1 × the step amount
   * (step_down_amt × walk_interp, interp < −0.1), and a head-only overlap
   * the lift cannot resolve (the sphere's NaN interp fails the same test).
   * Returns the lift (> 0) and advances path.walkInterp, 0 when no obstacle
   * adjusts the sphere, or null when one collides.
   */
  private obstacleStepDownLift(
    gx: number, gy: number, gz: number, path: { walkInterp: number; walkableAllowance: number },
  ): number | null {
    if (this.cylinders.size === 0 && this.spheres.size === 0) return 0;
    const r = this.bodySphereRadius;
    const headZ = gz - this.bodySphereHeights[0] + this.bodySphereHeights[1];
    const stepScale = this.stepUpHeight * path.walkInterp;
    let scope: BodyScope | undefined;
    const scopeHere = (): BodyScope => this.bodyScope(gx, gy, gz - this.bodySphereHeights[0]);
    const cyls = this.spatialIndex
      ? this.cylinderGrid.queryDisc(gx, gy, r + this.maxObstacleRadius)
      : this.cylinders.values();
    for (const cyl of cyls) {
      if (scoped(cyl) && !this.inScope(cyl, scope ??= scopeHere())) continue;
      const radsum = cyl.radius - PHYSICS_EPSILON + r;
      const dx = gx - cyl.x;
      const dy = gy - cyl.z;
      if (dx * dx + dy * dy > radsum * radsum) continue;
      const height = cyl.topY - cyl.bottomY;
      if (!Number.isFinite(height)) continue; // an unbounded column has no top
      // CCylSphere::collides_with_sphere's vertical test: |H/2 − dz| ≤ r − EPS + H/2.
      const spans = (z: number): boolean => Math.abs(height / 2 - (z - cyl.bottomY)) <= r - PHYSICS_EPSILON + height / 2;
      if (!spans(gz) && !spans(headZ)) continue;
      if (Math.abs(stepScale) < PHYSICS_EPSILON) return null;
      const deltaz = height + r - (gz - cyl.bottomY);
      const interp = (1 - deltaz / stepScale) * path.walkInterp;
      if (!(interp < path.walkInterp && interp >= -0.1)) return null;
      path.walkInterp = interp;
      return deltaz;
    }
    const sphs = this.spatialIndex
      ? this.sphereGrid.queryDisc(gx, gy, r + this.maxObstacleRadius)
      : this.spheres.values();
    for (const sph of sphs) {
      if (scoped(sph) && !this.inScope(sph, scope ??= scopeHere())) continue;
      const radsum = sph.radius + r - PHYSICS_EPSILON;
      const dx = gx - sph.x;
      const dy = gy - sph.z;
      const dz = gz - sph.y;
      const dxy2 = dx * dx + dy * dy;
      const dzHead = headZ - sph.y;
      if (dxy2 + dz * dz > radsum * radsum && dxy2 + dzHead * dzHead > radsum * radsum) continue;
      if (Math.abs(stepScale) < PHYSICS_EPSILON) return null;
      const reach = radsum + PHYSICS_EPSILON;
      const lift = Math.sqrt(reach * reach - dxy2) - dz;
      const interp = (1 - lift / stepScale) * path.walkInterp;
      if (!(interp < path.walkInterp && interp >= -0.1)) return null;
      if ((dz + lift) / reach <= path.walkableAllowance) continue; // no contact plane
      path.walkInterp = interp;
      return lift;
    }
    return 0;
  }

  /**
   * The Placement insert (CTransition::transitional_insert with
   * PLACEMENT_INSERT) for the BSP sources: neither body sphere, stacked on
   * `baseY` at AC landblock-global (gx, gy), may overlap a polygon (or sit
   * in a solid leaf). A building's shell is tested with bldg_check: when the
   * body is in an interior cell (hits_interior_cell) its solid leaves are
   * cleared and only its polygons count (BSPTREE::find_collisions
   * @ 0053a440; ACE BSPTree.cs:143-150), so the shell's own solid does not
   * refuse a step up its stairs (RECON.transition-stepup-stepdown-port.d).
   */
  private bodyFitsAt(gx: number, gy: number, baseY: number): boolean {
    let hitsInteriorCell: boolean | undefined;
    let scope: BodyScope | undefined;
    for (const cell of this.cellsNear(gx, gy, this.bodySphereRadius)) {
      if (scoped(cell) && !this.inScope(cell, scope ??= this.bodyScope(gx, gy, baseY))) continue;
      const inv = 1 / cell.scale;
      let checkSolid = true;
      if (cell.building) {
        hitsInteriorCell ??= this.bodySphereHeights.some((h) => this.findCellContaining(gx, gy, baseY + h) !== 0);
        checkSolid = !hitsInteriorCell;
      }
      for (const h of this.bodySphereHeights) {
        const center = scaleVec(globalToLocal(cell.origin, cell.quat,
          { x: gx - cell.blockOffsetX, y: gy - cell.blockOffsetY, z: baseY + h }), inv);
        if (sphereIntersectsSolid(cell.bsp, { center, radius: this.bodySphereRadius * inv }, checkSolid)) return false;
      }
    }
    return true;
  }

  /**
   * BUG.door-collision-static-pose-no-hold — does any of these spheres (AC
   * landblock-global centre, metres) overlap a registered source as it
   * stands? A BSP source: CPolygon::pos_hits_sphere on its polygons, or a
   * solid leaf (BSPTREE::find_collisions with the sphere at rest); a
   * cylinder: its disc and its vertical span; a sphere: centre distance.
   * CPhysicsObj::check_collision @ 00512ed0 runs a transition whose begin
   * and end are the same position — the at-rest overlap test that
   * CPhysicsObj::ethereal_check_for_collisions @ 00510a40 asks of every
   * object around one that is turning solid.
   */
  spheresOverlap(spheres: readonly { x: number; y: number; z: number; radius: number }[]): boolean {
    let scope: BodyScope | undefined;
    for (const s of spheres) {
      for (const cell of this.cellsNear(s.x, s.y, s.radius)) {
        // A body in an env cell meets land-cell sources only near its outside portals.
        if (scoped(cell) && !this.inScope(cell, scope ??= this.scopeFor(spheres, maxRadius(spheres)))) continue;
        const inv = 1 / cell.scale;
        const center = scaleVec(globalToLocal(cell.origin, cell.quat,
          { x: s.x - cell.blockOffsetX, y: s.y - cell.blockOffsetY, z: s.z }), inv);
        if (sphereIntersectsSolid(cell.bsp, { center, radius: s.radius * inv }, !cell.building)) return true;
      }
      const cyls = this.spatialIndex ? this.cylinderGrid.queryDisc(s.x, s.y, s.radius + this.maxObstacleRadius) : this.cylinders.values();
      for (const c of cyls) {
        if (scoped(c) && !this.inScope(c, scope ??= this.scopeFor(spheres, maxRadius(spheres)))) continue;
        const reach = s.radius + c.radius;
        const dx = s.x - c.x, dz = s.y - c.z;
        if (dx * dx + dz * dz < reach * reach && s.z + s.radius > c.bottomY && s.z - s.radius < c.topY) return true;
      }
      const sphs = this.spatialIndex ? this.sphereGrid.queryDisc(s.x, s.y, s.radius + this.maxObstacleRadius) : this.spheres.values();
      for (const o of sphs) {
        if (scoped(o) && !this.inScope(o, scope ??= this.scopeFor(spheres, maxRadius(spheres)))) continue;
        const reach = s.radius + o.radius;
        const dx = s.x - o.x, dy = s.z - o.y, dz = s.y - o.z;
        if (dx * dx + dy * dy + dz * dz < reach * reach) return true;
      }
    }
    return false;
  }

  /** The (resolved) body spheres: their radius and their centres' heights above the feet. */
  get bodySphereLayout(): { radius: number; heights: readonly number[] } {
    return { radius: this.bodySphereRadius, heights: this.bodySphereHeights };
  }

  /**
   * BUG.jump-through-ceiling — a body rising at (worldX, worldZ) from feet
   * height `fromY` toward `toY` meets the ceiling: the highest feet height
   * (≤ toY) its spheres reach before one moves into a polygon over it, or
   * null when nothing stops it. Retail's airborne transition sweeps every
   * body sphere along the whole offset, the vertical part included
   * (CPhysicsObj::UpdateObjectInternal @ 005156b0 → CTransition::
   * find_valid_position; ACE Transition.FindTransitionalPosition), so the
   * head sphere hits a room's ceiling and the jump stops rising there
   * (handle_all_collisions takes the velocity into the face away). Our
   * airborne step moved the spheres only sideways at the feet height, so a
   * high jump (Jump 400+: 4.9 m) in Mountain Keep's 3 m corridor 0x01D202A2
   * rose through the ceiling, over the wall and out of every cell, where
   * the floor search finds nothing and the body hung at its take-off height
   * (2026-10-17). Only faces the rise moves into count (movement · N < 0,
   * pos_hits_sphere): a floor seen from below or a wall beside the body
   * never stops it. Swept in RISE_STEP_M steps.
   */
  riseLimit(worldX: number, worldZ: number, fromY: number, toY: number): number | null {
    if (this.cells.size === 0 || !(toY > fromY)) return null;
    const n = Math.max(1, Math.ceil((toY - fromY) / RISE_STEP_M));
    const dy = (toY - fromY) / n;
    const scope = this.bodyScope(worldX, worldZ, fromY);
    const cells = [...this.cellsNear(worldX, worldZ, this.bodySphereRadius)].filter((c) => !scoped(c) || this.inScope(c, scope));
    let prev = fromY;
    for (let i = 1; i <= n; i++) {
      const y = fromY + dy * i;
      for (const cell of cells) {
        const inv = 1 / cell.scale;
        const move = scaleVec(quatRotate(quatConjugate(cell.quat), { x: 0, y: 0, z: dy }), inv);
        for (const h of this.bodySphereHeights) {
          const center = scaleVec(globalToLocal(cell.origin, cell.quat,
            { x: worldX - cell.blockOffsetX, y: worldZ - cell.blockOffsetY, z: y + h }), inv);
          // A face counts only when the rise goes into it, not along it (a wall: N·up ≈ 0).
          if (sphereIntersectsAnyPoly(cell.bsp, { center, radius: this.bodySphereRadius * inv }, move, RISE_GRAZE * dy * inv)) return prev;
        }
      }
      prev = y;
    }
    return null;
  }

  /**
   * Test both body spheres (feet/head capsule) at the proposed destination
   * against all BSP cells — a hit on either sphere blocks movement, mirroring
   * ACE's NumSphere>1 dual-sphere collision test (see BODY_SPHERE_HEIGHTS).
   * `worldPos.y` is the floor-relative base Y the spheres are stacked above.
   */
  private bspTestMovement(
    worldPos: THREE.Vector3,
    dxWorld: number,
    dzWorld: number,
    acMovement: { x: number; y: number; z: number },
  ) {
    // Proposed destination in Three.js world
    const destX = worldPos.x + dxWorld;
    const destZ = worldPos.z + dzWorld;

    let scope: BodyScope | undefined;
    for (const cell of this.cellsNear(destX, destZ, this.bodySphereRadius)) {
      if (scoped(cell) && !this.inScope(cell, scope ??= this.bodyScope(destX, destZ, worldPos.y))) continue;
      // Transform movement to cell-local (rotation only) — same for both spheres
      const inv = 1 / cell.scale;
      const cellMovement = scaleVec(quatRotate(quatConjugate(cell.quat), acMovement), inv);

      for (let si = 0; si < this.bodySphereHeights.length; si++) {
        const sphereHeight = this.bodySphereHeights[si];
        // Convert destination to AC landblock-local (Z-up)
        const acDest = {
          x: destX - cell.blockOffsetX,
          y: destZ - cell.blockOffsetY,
          z: worldPos.y + sphereHeight,
        };

        // Transform to cell-local via GlobalToLocal; a scaled source tests
        // the sphere in its unscaled local space (ACE SpherePath.
        // CacheLocalSpaceSphere(pos, scale): centre and radius ÷ scale).
        const cellLocal = scaleVec(globalToLocal(cell.origin, cell.quat, acDest), inv);

        // Test sphere at destination position in cell-local space
        const sphere: CollisionSphere = { center: cellLocal, radius: this.bodySphereRadius * inv };
        // RECON.transition-stepup-stepdown-port.e — CPolygon::pos_hits_sphere
        // @ 005394f0 filters no face by its slope: a feet sphere moving into a
        // walkable face (a stair ramp, a stringer's sloped top) hits it and
        // BSPTREE::find_collisions steps it up onto it (step_sphere_up); a
        // head sphere moving into a sloped ceiling (an attic's roof, from
        // inside) hits it and slides, so the body never walks into the eave
        // and out through the roof. A body moving along a level floor or
        // under a level ceiling does not move into it (movement · N = 0).
        const hit = sphereIntersectsAnyPoly(cell.bsp, sphere, cellMovement);
        if (hit) return { hit, cell, sphere: si };
      }
    }
    return null;
  }

  // ── Floor detection (BSP-based) ───────────────────────────

  /**
   * Find floor height at a world position using BSP walkable surface detection.
   * Returns Three.js world Y coordinate of the floor, or null.
   * `maxDrop` bounds how far below `fromY` a BSP floor may lie (default 5 m;
   * Infinity = the nearest walkable anywhere below, for a body falling
   * through an open cell — outdoorGround.ts interiorGroundY).
   * `bodyFeetY` = where the asking body's feet are (default `fromY`): a body
   * in an env cell finds no land-cell floor (a building shell's, a static's)
   * away from the cell's outside portals (floorCandidates). A search from
   * the head (the storey over a jump) passes the feet.
   */
  getFloorHeight(
    worldX: number, worldZ: number, fromY: number, maxDrop = FLOOR_SEARCH_MAX_DROP, bodyFeetY = fromY,
  ): number | null {
    if (this.cells.size > 0) {
      return this.bspGetFloorHeight(worldX, worldZ, fromY, maxDrop, bodyFeetY);
    }
    return this.raycastGetFloorHeight(worldX, worldZ, fromY);
  }

  /**
   * BUG.gravity-item-placed-midair — the highest walkable surface (cell
   * floors, static objects' tops, building floors) at or below `fromY`
   * under (worldX, worldZ), or null when none lies there (or in raycast
   * mode). What a falling object's transition lands on. With the object's
   * `spheres` (AC global centres where it stands), a land-cell source's
   * floor counts only when they reach the land cells (scopeFor).
   */
  floorBelow(
    worldX: number, worldZ: number, fromY: number,
    spheres?: readonly { x: number; y: number; z: number; radius: number }[],
  ): number | null {
    if (this.cells.size === 0) return null;
    let best: number | null = null;
    // The falling object's own spheres decide whether it reaches the land cells' floors.
    const landCells = (): BodyScope => (spheres && spheres.length > 0 ? this.scopeFor(spheres, maxRadius(spheres)) : EVERYTHING);
    for (const y of this.floorCandidates(worldX, worldZ, fromY, fromY, -Infinity, landCells)) {
      if (best === null || y > best) best = y;
    }
    return best;
  }

  /**
   * RECON.transition-stepup-stepdown-port.e — the ground the player's body
   * stands on at (worldX, worldZ) after a step whose floor search starts at
   * `fromY` (the last ground plus any step-up lift): the contact plane
   * CTransition::step_down @ 0050b3d0 finds for the feet sphere
   * (stepDownContact), else the centre-point floor search (getFloorHeight).
   * A floor under the centre that lies above the contact (getFloorHeight's
   * stair preference) still wins: the sphere overlaps it, and retail's
   * neg-poly hit steps it up onto it (SPHEREPATH::set_neg_poly_hit
   * @ 005398e0 → CTransition::step_up).
   */
  getBodyFloorHeight(
    worldX: number, worldZ: number, fromY: number, stepDownHeight: number, maxDrop = FLOOR_SEARCH_MAX_DROP,
    bodyFeetY = fromY,
  ): number | null {
    const contact = this.stepDownContact(worldX, worldZ, fromY, stepDownHeight);
    // Only CylSphere / Sphere obstacles registered: their tops are the contact.
    if (this.cells.size === 0) return contact?.y ?? this.getFloorHeight(worldX, worldZ, fromY, maxDrop);
    const candidates = this.floorCandidates(worldX, worldZ, fromY, fromY + 2.0, fromY - maxDrop,
      () => this.bodyScope(worldX, worldZ, bodyFeetY));
    // A floor under the centre counts above the search height only while
    // the feet sphere's centre is still above it (a tread the body's centre
    // has crossed onto); one higher than that is the underside of something
    // over the body (an attic's roof seen from inside) and is never a floor.
    // Real risers are climbed by the step up, whose lift is in `fromY`.
    const above = this.stairFloorAbove(candidates, fromY, this.lowerSphereHeight);
    // The contact stands even where the body does not fit (pressed under an
    // attic's eave): it is the floor the body is on; stepDownBlocked keeps
    // it from walking there.
    if (contact) return above !== null && above > contact.y + STEP_SEARCH_SLACK ? above : contact.y;
    if (above !== null) return above;
    // No contact: the nearest floor below (a walk-off or drop), never one overhead.
    let below: number | null = null;
    for (const y of candidates) if (y <= fromY + STEP_SEARCH_SLACK && (below === null || y > below)) below = y;
    return below;
  }

  /**
   * CTransition::step_down @ 0050b3d0 → BSPTREE::step_sphere_down
   * @ 0053a210 → find_walkable for the BSP sources, for a body whose feet
   * sphere starts at `fromY` + its height: the sphere is lowered by
   * `stepDownHeight` and every walkable polygon it then meets
   * (walkable_hits_sphere: N·up above FloorZ) sets it back up along up
   * until it rests on it. The body's ground is
   * where its feet sphere rests, not a vertical probe under its centre: a
   * sphere whose centre has passed a stair stringer's side edge still stands
   * on it, as retail's does.
   *
   * Deviations from retail, which are deliberate:
   *  - the sphere rests on the polygon (face, edge or vertex:
   *    sphereRestLift), where adjust_sphere_to_plane rests it on the
   *    polygon's infinite plane. Past the top edge of a ramp the plane is
   *    above the floor beyond it, and the body would bump up. A polygon the
   *    sphere meets anywhere on its way down counts (a rest against an edge
   *    beside the body is kept from step to step), where retail tests only
   *    the lowered sphere;
   *  - the highest landing wins, where retail keeps the first one
   *    find_walkable visits in BSP order (walk_interp);
   *  - a landing more than STEP_SEARCH_SLACK above `fromY` is no landing (the
   *    step up, not the step down, lifts the body);
   *  - the sphere rests its centre lowerSphereHeight from the polygon, as a
   *    body stands on a level floor here (retail's 0.48 radius floats it 5 mm).
   * `fits` = the body fits there (StepDown's Placement insert, bodyFitsAt,
   * with the spheres where retail's rest). Returns the ground (three.js Y)
   * with the polygon's normal, or null when no walkable is within step-down
   * reach.
   */
  stepDownContact(
    worldX: number, worldZ: number, fromY: number, stepDownHeight: number,
  ): { y: number; normal: { x: number; y: number; z: number }; fits: boolean } | null {
    const lowH = this.lowerSphereHeight;
    const r = this.bodySphereRadius;
    const startZ = fromY + lowH - stepDownHeight;
    const landings: { y: number; placeY: number; normal: { x: number; y: number; z: number } }[] = [];
    let scope: BodyScope | undefined;
    for (const cell of this.cellsNear(worldX, worldZ, lowH)) {
      // A body in an env cell steps down onto no land-cell source away from its outside portals.
      if (scoped(cell) && !this.inScope(cell, scope ??= this.bodyScope(worldX, worldZ, fromY))) continue;
      const s = cell.scale;
      const inv = 1 / s;
      const upL = quatRotate(quatConjugate(cell.quat), AC_UP);
      const c = scaleVec(globalToLocal(cell.origin, cell.quat,
        { x: worldX - cell.blockOffsetX, y: worldZ - cell.blockOffsetY, z: startZ }), inv);
      // Every walkable the sphere's sweep from its place down to the lowered
      // one (plus the slack above) can touch.
      const half = (stepDownHeight / 2 + STEP_SEARCH_SLACK) * inv;
      const sweep = { center: { x: c.x + upL.x * half, y: c.y + upL.y * half, z: c.z + upL.z * half }, radius: lowH * inv + half };
      const polys = collectWalkableSphereHits(cell.bsp, sweep, upL, FLOOR_WALKABLE_Z);
      // The feet sphere's centre where the body stands now (at `fromY`).
      const here = { x: c.x + upL.x * stepDownHeight * inv, y: c.y + upL.y * stepDownHeight * inv, z: c.z + upL.z * stepDownHeight * inv };
      for (const poly of polys) {
        if (underFromBehind(poly, here, upL)) continue; // a roof over the body is no floor
        // Lift along up until the sphere (lowH) rests on the polygon.
        const t = sphereRestLift(poly, c, upL, lowH * inv);
        if (t === null || t < -1e-9) continue; // already above its resting place: beyond step-down reach
        const y = startZ + t * s - lowH;
        if (y > fromY + STEP_SEARCH_SLACK) continue;
        // Placement runs where retail's sphere rests: its full radius off the polygon.
        const tPlace = sphereRestLift(poly, c, upL, r * inv) ?? t;
        const g = quatRotate(cell.quat, poly.plane.normal);
        landings.push({ y, placeY: startZ + tPlace * s - lowH, normal: { x: g.x, y: g.z, z: g.y } });
      }
    }
    this.obstacleLandings(worldX, worldZ, startZ, stepDownHeight, fromY, landings);
    if (landings.length === 0) return null;
    let top = landings[0];
    for (const l of landings) if (l.y > top.y) top = l;
    // StepDown's Placement insert (ACE Transition.cs:731-740): the body must
    // fit where it lands, or the step down fails.
    return { y: top.y, normal: top.normal, fits: this.bodyFitsAt(worldX, worldZ, top.placeY) };
  }

  /**
   * RECON.transition-stepup-stepdown-port.c.b.a — the CylSphere / Sphere
   * obstacles' part of CTransition::step_down (CheckOtherCells runs every
   * object, not only the BSPs): the feet sphere lowered to `startZ` (AC Z,
   * three.js Y) that overlaps an obstacle is set back up onto it.
   *  - CCylSphere::step_sphere_down @ 0053a9b0 (ACE CylSphere.StepSphereDown):
   *    horizontal reach radius − EPSILON + r and the vertical span test of
   *    collides_with_sphere; up by Height + r − disp.Z onto the flat top
   *    (contact plane +Z);
   *  - CSphere::step_sphere_down @ 00536d20 (ACE Sphere.StepSphereDown): up
   *    to sqrt(reach² − dxy²) above the centre (reach = radsum + EPSILON); a
   *    spot whose normal Z is not above FloorZ sets no contact plane.
   * Both refuse a lift past 1.1 × the step-down amount (interp < −0.1); such
   * an obstacle is no landing here. The sphere rests its full radius off the
   * obstacle as retail's does (5 mm above where a BSP floor rests it,
   * lowerSphereHeight), so the body standing there no longer overlaps it and
   * its next step is not taken for a collision.
   */
  private obstacleLandings(
    worldX: number, worldZ: number, startZ: number, stepDownHeight: number, fromY: number,
    out: { y: number; placeY: number; normal: { x: number; y: number; z: number } }[],
  ): void {
    if ((this.cylinders.size === 0 && this.spheres.size === 0) || stepDownHeight < PHYSICS_EPSILON) return;
    const r = this.bodySphereRadius;
    const lowH = this.lowerSphereHeight;
    const maxLift = 1.1 * stepDownHeight;
    const land = (centerZ: number, normal: { x: number; y: number; z: number }): void => {
      const y = centerZ - lowH;
      if (y > fromY + STEP_SEARCH_SLACK) return; // the step up, not the step down, lifts the body
      out.push({ y, placeY: y, normal });
    };
    let scope: BodyScope | undefined;
    const cyls = this.spatialIndex
      ? this.cylinderGrid.queryDisc(worldX, worldZ, r + this.maxObstacleRadius)
      : this.cylinders.values();
    for (const cyl of cyls) {
      if (scoped(cyl) && !this.inScope(cyl, scope ??= this.bodyScope(worldX, worldZ, fromY))) continue;
      const radsum = cyl.radius - PHYSICS_EPSILON + r;
      const dx = worldX - cyl.x;
      const dy = worldZ - cyl.z;
      if (dx * dx + dy * dy > radsum * radsum) continue;
      const height = cyl.topY - cyl.bottomY;
      if (!Number.isFinite(height)) continue; // an unbounded column has no top
      const dz = startZ - cyl.bottomY;
      if (Math.abs(height / 2 - dz) > r - PHYSICS_EPSILON + height / 2) continue;
      const lift = height + r - dz;
      if (lift <= 0 || lift > maxLift) continue;
      land(cyl.topY + r, { x: 0, y: 1, z: 0 });
    }
    const sphs = this.spatialIndex
      ? this.sphereGrid.queryDisc(worldX, worldZ, r + this.maxObstacleRadius)
      : this.spheres.values();
    for (const sph of sphs) {
      if (scoped(sph) && !this.inScope(sph, scope ??= this.bodyScope(worldX, worldZ, fromY))) continue;
      const reach = sph.radius + r;
      const dx = worldX - sph.x;
      const dy = worldZ - sph.z;
      const dz = startZ - sph.y;
      const dxy2 = dx * dx + dy * dy;
      const radsum = reach - PHYSICS_EPSILON;
      if (dxy2 + dz * dz > radsum * radsum) continue;
      const up = Math.sqrt(reach * reach - dxy2);
      const lift = up - dz;
      if (lift <= 0 || lift > maxLift) continue;
      if (up / reach <= FLOOR_WALKABLE_Z) continue; // no contact plane: the body slides off
      land(sph.y + up, { x: dx / reach, y: up / reach, z: dy / reach });
    }
  }

  /**
   * A grounded step to (destX, destZ) whose step down lands on a walkable
   * the body does not fit on (StepDown's Placement insert fails): retail's
   * transitional_insert then has no contact plane and edge_slide refuses the
   * step, so the body never walks under a ceiling its step-down would lift it
   * into. False when no walkable is in step-down reach (a walk-off: the
   * precipice / fall rules decide) or the landing fits. Only a landing that
   * raises the body is refused (the case the step up alone cannot see: a
   * plane the sphere rides up without moving into it); a body that already
   * does not fit where it stands at (x, z) (pressed into a wall) is not held
   * by it: like an obstacle's escape rule, an overlap it already has does not
   * pin it.
   */
  stepDownBlocked(
    x: number, z: number, destX: number, destZ: number, fromY: number, stepDownHeight: number,
  ): boolean {
    if (this.cells.size === 0) return false;
    const dest = this.stepDownContact(destX, destZ, fromY, stepDownHeight);
    if (dest === null || dest.fits || dest.y <= fromY + STEP_DOWN_RAISE_EPS) return false;
    return this.stepDownContact(x, z, fromY, stepDownHeight)?.fits === true;
  }

  private bspGetFloorHeight(worldX: number, worldZ: number, fromY: number, maxDrop: number, bodyFeetY: number): number | null {
    // Collect every walkable floor height at this XZ across every cell.
    // findFloorHeight only returns the one closest to fromZ inside each cell,
    // which loses stair treads when a foundation slab shares the XY footprint.
    // For correct stair climbing we need ALL candidates.
    const candidates = this.floorCandidates(worldX, worldZ, fromY, fromY + 2.0, fromY - maxDrop,
      () => this.bodyScope(worldX, worldZ, bodyFeetY));
    if (candidates.length === 0) return null;

    // Stair/step preference: when multiple floors overlap the same XZ (e.g.
    // a foundation slab extending under a staircase PLUS the stair tread
    // above it), the "closest to fromY" heuristic gets stuck on the lower
    // floor forever — the player moves forward but their Y never rises.
    // Instead, prefer the HIGHEST floor that's within step-up reach of fromY.
    // If none are above fromY, fall back to closest-to-fromY (descending /
    // flat ground works unchanged).
    const bestAbove = this.stairFloorAbove(candidates, fromY);
    if (bestAbove !== null) return bestAbove;

    let bestClosest = candidates[0];
    let bestDist = Math.abs(bestClosest - fromY);
    for (let i = 1; i < candidates.length; i++) {
      const d = Math.abs(candidates[i] - fromY);
      if (d < bestDist) { bestDist = d; bestClosest = candidates[i]; }
    }
    return bestClosest;
  }

  /** The highest floor candidate within `reach` (default step-up reach) above `fromY` (no lower than STEP_SEARCH_SLACK under it), or null. */
  private stairFloorAbove(candidates: number[], fromY: number, reach = this.stepUpHeight + STEP_SEARCH_SLACK): number | null {
    let bestAbove: number | null = null;
    for (const y of candidates) {
      if (y > fromY - STEP_SEARCH_SLACK && y <= fromY + reach) {
        if (bestAbove === null || y > bestAbove) bestAbove = y;
      }
    }
    return bestAbove;
  }

  /**
   * Every walkable floor height (THREE world y) under (worldX, worldZ) within
   * [minY, maxY]; `fromY` is the query height. `landCells` = what the
   * asking body meets (bodyScope, asked only when a land-cell or env-cell
   * source lies near).
   */
  private floorCandidates(
    worldX: number, worldZ: number, fromY: number, maxY: number, minY: number, landCells: () => BodyScope,
  ): number[] {
    const candidates: number[] = [];
    let scope: BodyScope | undefined;
    for (const cell of this.cellsNear(worldX, worldZ, FLOOR_QUERY_PAD)) {
      if (scoped(cell) && !this.inScope(cell, scope ??= landCells())) continue;
      if (!floorProbeMayHit(cell, worldX - cell.blockOffsetX, worldZ - cell.blockOffsetY)) continue;
      const acLocal = {
        x: worldX - cell.blockOffsetX,
        y: worldZ - cell.blockOffsetY,
        z: fromY,
      };
      const cellLocal = globalToLocal(cell.origin, cell.quat, acLocal);

      const s = cell.scale;
      // BUG.moveto-wall-climb-flying-target — only faces a body can stand on
      // (normal z ≥ FloorZ, CPhysicsObj::get_walkable_z) are floors.
      const localZs = collectWalkableFloorHeights(cell.bsp, cellLocal.x / s, cellLocal.y / s, FLOOR_WALKABLE_Z);
      for (const lz of localZs) {
        const acFloor = quatRotate(cell.quat, { x: cellLocal.x, y: cellLocal.y, z: lz * s });
        const worldFloorY = acFloor.z + cell.origin.z;
        if (worldFloorY <= maxY && worldFloorY >= minY) {
          candidates.push(worldFloorY);
        }
      }
    }

    return candidates;
  }

  /**
   * How far a body standing at `floorY` is from the walkable plane at
   * `planeY` (normal z `nz`) under its centre: it stands either on the plane
   * itself (the centre-point floor search) or where its feet sphere rests on
   * it (getBodyFloorHeight's contact: lowerSphereHeight off the plane along
   * its normal, higher than the plane on a slope).
   */
  private floorDistance(planeY: number, nz: number, floorY: number): number {
    const lowH = this.lowerSphereHeight;
    const restY = nz > 1e-6 ? planeY + lowH / nz - lowH : planeY;
    return Math.min(Math.abs(planeY - floorY), Math.abs(restY - floorY));
  }

  /**
   * CORE.18.b.a.a.a — the contact plane's normal (CPhysicsObj::contact_plane.N)
   * for a body standing at (worldX, worldZ) on the floor at world height
   * `floorY` (the height getFloorHeight chose): the walkable BSP polygon at
   * that height (or the one its feet sphere rests on there, floorDistance),
   * rotated out of its cell. Returned in renderer axes (y up); null when no
   * cell floor sits within 0.05 m of `floorY` (raycast mode, or the body is
   * on terrain).
   */
  getFloorNormal(worldX: number, worldZ: number, floorY: number): { x: number; y: number; z: number } | null {
    let best: { x: number; y: number; z: number } | null = null;
    let bestDist = 0.05;
    let scope: BodyScope | undefined;
    for (const cell of this.cellsNear(worldX, worldZ, FLOOR_QUERY_PAD)) {
      if (scoped(cell) && !this.inScope(cell, scope ??= this.bodyScope(worldX, worldZ, floorY))) continue;
      // REND.per-frame-allocations — the slope-aligned camera asks every
      // frame; skip cells whose polygons can't lie under this XY.
      if (!floorProbeMayHit(cell, worldX - cell.blockOffsetX, worldZ - cell.blockOffsetY)) continue;
      const cellLocal = globalToLocal(cell.origin, cell.quat, {
        x: worldX - cell.blockOffsetX,
        y: worldZ - cell.blockOffsetY,
        z: floorY,
      });
      const s = cell.scale;
      for (const floor of collectWalkableFloors(cell.bsp, cellLocal.x / s, cellLocal.y / s, FLOOR_WALKABLE_Z)) {
        const acFloor = quatRotate(cell.quat, { x: cellLocal.x, y: cellLocal.y, z: floor.z * s });
        const n = quatRotate(cell.quat, floor.normal);
        const d = this.floorDistance(acFloor.z + cell.origin.z, n.z, floorY);
        if (d > bestDist) continue;
        bestDist = d;
        // AC (x, y, z-up) → renderer (x, y-up, z).
        best = { x: n.x, y: n.z, z: n.y };
      }
    }
    return best;
  }

  /**
   * Every upward-facing BSP polygon under (worldX, worldZ) whose normal z is
   * at least `minNormalZ` (0 = all, FLOOR_WALKABLE_Z = floors only): its
   * world height there and normal z, highest first. Debug / probe use.
   */
  floorPlanesAt(worldX: number, worldZ: number, minNormalZ = 1e-6): { y: number; normalZ: number }[] {
    const out: { y: number; normalZ: number }[] = [];
    for (const cell of this.cellsNear(worldX, worldZ, FLOOR_QUERY_PAD)) {
      if (!floorProbeMayHit(cell, worldX - cell.blockOffsetX, worldZ - cell.blockOffsetY)) continue;
      const local = globalToLocal(cell.origin, cell.quat, { x: worldX - cell.blockOffsetX, y: worldZ - cell.blockOffsetY, z: 0 });
      const s = cell.scale;
      for (const floor of collectWalkableFloors(cell.bsp, local.x / s, local.y / s, minNormalZ)) {
        const ac = quatRotate(cell.quat, { x: local.x, y: local.y, z: floor.z * s });
        out.push({ y: ac.z + cell.origin.z, normalZ: quatRotate(cell.quat, floor.normal).z });
      }
    }
    return out.sort((a, b) => b.y - a.y);
  }

  /**
   * RECON.transition-stepup-stepdown-port.b — SPHEREPATH::precipice_slide @
   * 0050cc80's edge for a body standing on the walkable BSP polygon at
   * (worldX, worldZ, floorY) and stepping to (destX, destZ): the polygon is
   * SPHEREPATH::walkable (the floor the step-down probe found under the
   * body), CPolygon::find_crossed_edge projects the destination along the
   * cell's up onto it and returns plane.N x edge for the first edge it lies
   * beyond. Renderer axes (y up), with the floor's own normal (the
   * contact plane slide_sphere slides on).
   *
   * Returns null when no BSP floor lies within 0.05 m of floorY (the body is
   * on terrain, or raycast mode), and `{ edge: null }` when the body is on a
   * walkable but the destination crosses none of its edges (precipice_slide
   * then returns Collided).
   */
  precipiceEdge(
    worldX: number, worldZ: number, floorY: number, destX: number, destZ: number,
  ): { edge: { x: number; y: number; z: number } | null; floorNormal: { x: number; y: number; z: number } } | null {
    let best: { cell: CellCollision; poly: PhysicsPolygon; normal: { x: number; y: number; z: number } } | null = null;
    let bestDist = 0.05;
    let scope: BodyScope | undefined;
    for (const cell of this.cellsNear(worldX, worldZ, FLOOR_QUERY_PAD)) {
      if (scoped(cell) && !this.inScope(cell, scope ??= this.bodyScope(worldX, worldZ, floorY))) continue;
      if (!floorProbeMayHit(cell, worldX - cell.blockOffsetX, worldZ - cell.blockOffsetY)) continue;
      const cellLocal = globalToLocal(cell.origin, cell.quat, {
        x: worldX - cell.blockOffsetX,
        y: worldZ - cell.blockOffsetY,
        z: floorY,
      });
      const s = cell.scale;
      for (const floor of collectWalkableFloors(cell.bsp, cellLocal.x / s, cellLocal.y / s, FLOOR_WALKABLE_Z)) {
        const acFloor = quatRotate(cell.quat, { x: cellLocal.x, y: cellLocal.y, z: floor.z * s });
        const d = this.floorDistance(acFloor.z + cell.origin.z, quatRotate(cell.quat, floor.normal).z, floorY);
        if (d > bestDist) continue;
        bestDist = d;
        best = { cell, poly: floor.poly, normal: floor.normal };
      }
    }
    if (!best) return null;
    const { cell, poly } = best;
    const s = cell.scale;
    const destLocal = globalToLocal(cell.origin, cell.quat, {
      x: destX - cell.blockOffsetX,
      y: destZ - cell.blockOffsetY,
      z: floorY,
    });
    // SPHEREPATH::walkable_up: the global up in the walkable's frame.
    const up = quatRotate(quatConjugate(cell.quat), { x: 0, y: 0, z: 1 });
    const local = findCrossedEdge(poly, { x: destLocal.x / s, y: destLocal.y / s, z: destLocal.z / s }, up);
    const n = quatRotate(cell.quat, best.normal);
    const floorNormal = { x: n.x, y: n.z, z: n.y };
    if (!local) return { edge: null, floorNormal };
    const e = quatRotate(cell.quat, local); // walkable_pos.frame.localtoglobalvec
    return { edge: { x: e.x, y: e.z, z: e.y }, floorNormal };
  }

  // ── Camera distance (raycaster) ───────────────────────────

  /**
   * CORE.18.b — the boom may rise: (behindX, behindY, behindZ) is its 3D
   * direction (behindY defaults to 0, the old horizontal boom) and distances
   * are measured along it.
   *
   * BUG.camera-corner-zoom-flicker — retail sweeps the 0.3 m viewer sphere
   * from the pivot to the sought position and stops where it first touches
   * (SmartBox::update_viewer @ 00453ce0, viewer_sphere.radius 0.3), so a
   * wall at w caps every request at w − 0.3, the same answer each frame.
   * The old test only saw hits closer than the requested distance and then
   * subtracted 0.3: a request between w − 0.3 and w passed untouched, so the
   * rig, easing outward from last frame's clipped position, crept out and
   * snapped back 0.3 m every few frames. Contacts now count out to
   * maxDist + 0.3 and the result is min(maxDist, contact − 0.3).
   *
   * BUG.bunker-camera-in-head — `landFrom`: the boom distance (sphere centre)
   * from which the land cells count. A viewer that starts in an env cell
   * (SmartBox::update_viewer @ 00453ce0) meets a building shell or a land
   * object only once it has come within its radius of an outside portal plane
   * (viewerLandFrom); interior geometry (cell meshes, their statics) always
   * counts. 0 (outdoors): everything, as before.
   */
  getCameraDistance(
    playerPos: THREE.Vector3, behindX: number, behindZ: number, maxDist: number, behindY = 0, landFrom = 0,
  ): number {
    const hLen = Math.sqrt(behindX * behindX + behindZ * behindZ);
    const len = Math.sqrt(hLen * hLen + behindY * behindY);
    if (len < 0.001) return maxDist;
    const reach = maxDist + DungeonCollision.VIEWER_SPHERE_RADIUS;
    let bestDist = reach;
    // An env cell no portal joins to the pivot's is met like the land cells (inScope): past landFrom, or not at all
    // from a cell with no way out (a dungeon).
    let scope: BodyScope | undefined;
    const apart = (envCellId: number): boolean =>
      !this.inScope({ landCell: false, envCellId }, scope ??= this.scopeFor([{ x: playerPos.x, y: playerPos.z, z: playerPos.y }], DungeonCollision.VIEWER_SPHERE_RADIUS));

    // Mesh raycaster (BSP cells + buildings + indoor geometry).
    if (this.renderMeshes.length > 0) {
      const dir = new THREE.Vector3(behindX / len, behindY / len, behindZ / len);
      this.raycaster.set(playerPos, dir);
      this.raycaster.far = reach;
      const hits = this.intersectRenderMeshes();
      for (const hit of hits) {
        if (hit.distance >= bestDist) break;
        if (landFrom > 0 && this.landCellMeshes.has(hit.object)
          && !landContactCounts(hit.distance, landFrom)) continue;
        const cellId = this.meshCells.get(hit.object);
        if (cellId !== undefined && apart(cellId) && (landFrom === 0 || !landContactCounts(hit.distance, landFrom))) continue;
        bestDist = hit.distance;
        break;
      }
    }

    // FAITHFUL.205 — cylinder obstacles (scenery: trees/rocks/etc). The
    // mesh raycaster does NOT see these because scenery objects have no
    // physicsBSP and aren't registered as collision meshes. Without this
    // check the camera spawns INSIDE trees standing behind the player.
    //
    // Line-vs-cylinder intersection in the horizontal plane: parametrize the
    // boom's ground track as P(s) = playerPos + s * dir2D and solve
    //   (P(s).x - cx)² + (P(s).z - cz)² = (r + playerRadius)²
    // for the smallest positive s, then convert the horizontal distance s to
    // boom length (s × len / hLen). Player radius adds a bit of buffer so
    // the camera doesn't clip the cylinder's side.
    if (this.cylinders.size > 0 && hLen > 0.001) {
      const dirX = behindX / hLen;
      const dirZ = behindZ / hLen;
      const px = playerPos.x;
      const pz = playerPos.z;
      const py = playerPos.y;
      const toBoom = len / hLen;
      // The boom's ground track (s ≤ maxDist ≥ its horizontal length), padded by any cylinder's radius + 0.25.
      const pad = this.maxObstacleRadius + 0.25;
      const ex = px + dirX * reach;
      const ez = pz + dirZ * reach;
      const cyls = this.spatialIndex
        ? this.cylinderGrid.queryBox(Math.min(px, ex) - pad, Math.max(px, ex) + pad, Math.min(pz, ez) - pad, Math.max(pz, ez) + pad)
        : this.cylinders.values();
      for (const cyl of cyls) {
        // Skip cylinders entirely above or below the camera's vertical range
        // — the boom starts at the pivot, so use py.
        if (py < cyl.bottomY - 0.5 || py > cyl.topY + 0.5) continue;
        const ox = px - cyl.x;
        const oz = pz - cyl.z;
        const r = cyl.radius + 0.25; // small padding so the camera doesn't clip side
        // Quadratic: a*s² + 2*b*s + c = 0 where a=1, b=ox*dirX + oz*dirZ, c=ox²+oz²-r²
        const b = ox * dirX + oz * dirZ;
        const c = ox * ox + oz * oz - r * r;
        if (c <= 0) {
          // Player is already inside the cylinder's XZ disk — keep maxDist
          // since we can't sensibly pull camera back from where it can't go.
          continue;
        }
        const disc = b * b - c;
        if (disc <= 0) continue; // ray misses
        const sqrtDisc = Math.sqrt(disc);
        const s1 = -b - sqrtDisc;
        // We want the smallest positive s (entry point into the cylinder).
        const t1 = s1 * toBoom;
        if (landFrom > 0 && !cyl.inCell && !landContactCounts(t1, landFrom)) continue;
        if (cyl.envCellId !== 0 && apart(cyl.envCellId) && (landFrom === 0 || !landContactCounts(t1, landFrom))) continue;
        if (s1 > 0 && t1 < bestDist) bestDist = t1;
      }
    }

    if (bestDist >= reach) return maxDist;
    return Math.min(maxDist, Math.max(bestDist - DungeonCollision.VIEWER_SPHERE_RADIUS, 0.5));
  }

  /** The camera's viewer sphere (SmartBox viewer_sphere.radius; TerrainCollision.VIEWER_SPHERE_RADIUS). */
  static readonly VIEWER_SPHERE_RADIUS = 0.3;

  // ── Raycaster fallback (outdoor collision) ────────────────

  private static readonly _wallNormal = new THREE.Vector3();

  private raycastGetAdjustedMovement(pos: THREE.Vector3, deltaX: number, deltaZ: number): [number, number] {
    if (this.renderMeshes.length === 0) return [deltaX, deltaZ];
    const hit = this.raycastCastMovement(pos, deltaX, deltaZ);
    if (!hit) return [deltaX, deltaZ];

    const normal = DungeonCollision._wallNormal.copy(hit.face!.normal);
    normal.transformDirection(hit.object.matrixWorld);
    normal.y = 0;
    if (normal.lengthSq() < 0.0001) return [0, 0];
    normal.normalize();

    const dot = deltaX * normal.x + deltaZ * normal.z;
    if (dot >= 0) return [deltaX, deltaZ];

    const slideX = deltaX - dot * normal.x;
    const slideZ = deltaZ - dot * normal.z;

    if (Math.abs(slideX) > 0.001 || Math.abs(slideZ) > 0.001) {
      const slideHit = this.raycastCastMovement(pos, slideX, slideZ);
      if (!slideHit) return [slideX, slideZ];
    }
    return [0, 0];
  }

  private raycastCastMovement(pos: THREE.Vector3, dx: number, dz: number): THREE.Intersection | null {
    const moveLen = Math.sqrt(dx * dx + dz * dz);
    if (moveLen < 0.001) return null;
    const dirX = dx / moveLen, dirZ = dz / moveLen;
    const reach = moveLen + this.playerRadius;
    const perpX = -dirZ, perpZ = dirX;
    const r = this.playerRadius;

    for (const yOff of [0, -0.3]) {
      for (const side of [0, -r, r]) {
        const origin = new THREE.Vector3(pos.x + perpX * side, pos.y + yOff, pos.z + perpZ * side);
        const dir = new THREE.Vector3(dirX, 0, dirZ);
        this.raycaster.set(origin, dir);
        this.raycaster.far = reach;
        const hits = this.intersectRenderMeshes();
        for (const hit of hits) {
          if (hit.distance >= reach || !hit.face) continue;
          const n = DungeonCollision._wallNormal.copy(hit.face.normal);
          n.transformDirection(hit.object.matrixWorld);
          if (Math.abs(n.y) >= 0.3) continue; // skip floors/ramps
          return hit;
        }
      }
    }
    return null;
  }

  private raycastGetFloorHeight(worldX: number, worldZ: number, fromY: number): number | null {
    if (this.renderMeshes.length === 0) return null;
    const origin = new THREE.Vector3(worldX, fromY + 20, worldZ);
    this.raycaster.set(origin, new THREE.Vector3(0, -1, 0));
    this.raycaster.far = 40;
    const hits = this.intersectRenderMeshes();
    if (hits.length === 0) return null;
    let bestY: number | null = null;
    let bestDist = Infinity;
    for (const hit of hits) {
      const hy = hit.point.y;
      if (hy > fromY + 0.6 || hy < fromY - 5.0) continue;
      const dist = Math.abs(hy - fromY);
      if (dist < bestDist) { bestDist = dist; bestY = hy; }
    }
    return bestY;
  }
}
