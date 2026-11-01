import type { BSPNodeBase } from '@ac/dat-parser';

/**
 * BUG.10 — point-in-cell containment, mirroring ACE's physics exactly:
 *
 *   - BSPNode.point_inside_cell_bsp (ACE Physics/BSP/BSPNode.cs:191): walk
 *     the CELL BSP; Front/Close of the splitting plane recurses the positive
 *     child (or accepts at a leaf), Behind rejects.
 *   - PlaneExtensions.GetSide (Physics/Extensions/PlaneExtensions.cs:20):
 *     dist = dot(normal, p) + D; Front if dist > EPSILON, Behind if
 *     dist < -EPSILON, else Close. EPSILON = 0.0002 (PhysicsGlobals.cs:9).
 *   - EnvCell.point_in_cell (Physics/Common/EnvCell.cs:418): the point is
 *     transformed into CELL-LOCAL space first (AFrame.GlobalToLocal —
 *     rotate (p - origin) by the inverse orientation).
 *
 * All math is in AC coordinates (x east, y north, z up) — no Three.js
 * conversion belongs here.
 */

export const PHYSICS_EPSILON = 0.0002;

export interface ACVec3 { x: number; y: number; z: number }
export interface ACQuat { w: number; x: number; y: number; z: number }

/** Rotate vector v by the INVERSE of quaternion q (AFrame.GlobalToLocalVec). */
export function inverseRotate(q: ACQuat, v: ACVec3): ACVec3 {
  // q⁻¹ = conjugate for unit quaternions
  const cw = q.w, cx = -q.x, cy = -q.y, cz = -q.z;
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (cy * v.z - cz * v.y);
  const ty = 2 * (cz * v.x - cx * v.z);
  const tz = 2 * (cx * v.y - cy * v.x);
  // v' = v + w*t + cross(q.xyz, t)
  return {
    x: v.x + cw * tx + (cy * tz - cz * ty),
    y: v.y + cw * ty + (cz * tx - cx * tz),
    z: v.z + cw * tz + (cx * ty - cy * tx),
  };
}

/**
 * ACE BSPNode.point_inside_cell_bsp — point in CELL-LOCAL coordinates.
 *
 * Leaf nodes have no splitting plane in the DAT; ACE materializes them with
 * a default zero plane, so GetSide yields dist=0 → Close → (PosNode is
 * null) → true. Structurally that means: reaching a leaf = inside.
 */
export function pointInsideCellBsp(node: BSPNodeBase | undefined, p: ACVec3): boolean {
  if (!node) return true;
  const internal = node as { splittingPlane?: { normal: ACVec3; distance: number }; posNode?: BSPNodeBase };
  const plane = internal.splittingPlane;
  if (!plane) return true; // LEAF — ACE's default-plane path returns Close → true
  const dist = plane.normal.x * p.x + plane.normal.y * p.y + plane.normal.z * p.z + plane.distance;
  if (dist < -PHYSICS_EPSILON) return false; // Side.Behind
  // Side.Front / Side.Close
  if (internal.posNode) return pointInsideCellBsp(internal.posNode, p);
  return true;
}

/**
 * EnvCell.point_in_cell — `point` in LANDBLOCK-LOCAL AC coordinates, cell
 * frame = the EnvCell's position (origin + orientation, landblock-local).
 */
export function pointInCell(
  cellRoot: BSPNodeBase | undefined,
  cellOrigin: ACVec3,
  cellOrientation: ACQuat,
  point: ACVec3,
): boolean {
  const local = inverseRotate(cellOrientation, {
    x: point.x - cellOrigin.x,
    y: point.y - cellOrigin.y,
    z: point.z - cellOrigin.z,
  });
  return pointInsideCellBsp(cellRoot, local);
}

/** BSPNODE::sphere_intersects_cell_bsp's slack added to the sphere's radius (0.01, `___real_3c23d70a`). */
export const CELL_SPHERE_SLACK = 0.01;

/**
 * BUG.walkin-cave-invisible-walls — BSPNODE::sphere_intersects_cell_bsp
 * @ 0053c260 (ACE BSPNode.cs:219) through CCellStruct::sphere_intersects_cell
 * @ 00533900: whether a sphere (CELL-LOCAL centre) reaches the cell's volume,
 * i.e. the BoundingType is not OUTSIDE (PARTIALLY_INSIDE or ENTIRELY_INSIDE).
 * Behind a splitting plane by radius + 0.01 or more is outside; otherwise the
 * positive child decides, and a missing one (a leaf) is inside.
 */
export function sphereIntersectsCellBsp(node: BSPNodeBase | undefined, center: ACVec3, radius: number): boolean {
  if (!node) return true;
  const internal = node as { splittingPlane?: { normal: ACVec3; distance: number }; posNode?: BSPNodeBase };
  const plane = internal.splittingPlane;
  if (!plane) return true; // a leaf: ACE's default zero plane → PartiallyInside
  const dist = plane.normal.x * center.x + plane.normal.y * center.y + plane.normal.z * center.z + plane.distance;
  if (dist <= -(radius + CELL_SPHERE_SLACK)) return false;
  return internal.posNode ? sphereIntersectsCellBsp(internal.posNode, center, radius) : true;
}

/** EnvCell.check_building_transit's test: sphereIntersectsCellBsp with the sphere in LANDBLOCK-LOCAL coordinates. */
export function sphereIntersectsCell(
  cellRoot: BSPNodeBase | undefined,
  cellOrigin: ACVec3,
  cellOrientation: ACQuat,
  center: ACVec3,
  radius: number,
): boolean {
  const local = inverseRotate(cellOrientation, {
    x: center.x - cellOrigin.x,
    y: center.y - cellOrigin.y,
    z: center.z - cellOrigin.z,
  });
  return sphereIntersectsCellBsp(cellRoot, local, radius);
}
