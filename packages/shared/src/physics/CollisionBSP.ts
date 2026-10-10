/**
 * CollisionBSP — sphere-BSP collision detection using AC's physics BSP trees.
 *
 * Implements the core collision algorithms from ACE C# source:
 *   - Polygon.make_plane()                → makePlane()
 *   - Polygon.polygon_hits_sphere_precise → polygonHitsSpherePrecise()
 *   - Polygon.pos_hits_sphere             → posHitsSphere()
 *   - BSPNode.sphere_intersects_poly      → sphereIntersectsPoly()
 *   - BSPLeaf.sphere_intersects_solid     → sphereIntersectsSolid()
 *
 * All coordinates are in AC's Z-up local cell space.
 * Transform to/from Three.js Y-up at call boundaries only.
 *
 * Reference: ACE.Server/Physics/Polygon.cs, BSP/BSPNode.cs, BSP/BSPLeaf.cs
 */

import type { BSPNodeBase, BSPInternalNode, BSPLeafNode } from '@ac/dat-parser/file-types/BSPTree.js';
import type { Polygon } from '@ac/dat-parser/file-types/Polygon.js';
import type { CVertexArray } from '@ac/dat-parser/file-types/Vertex.js';

// ── Vector math helpers (AC Z-up space) ─────────────────────

interface Vec3 { x: number; y: number; z: number }

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function lengthSq(v: Vec3): number {
  return v.x * v.x + v.y * v.y + v.z * v.z;
}

function mulScalar(v: Vec3, k: number): Vec3 {
  return { x: v.x * k, y: v.y * k, z: v.z * k };
}

// ── Collision primitives ────────────────────────────────────

const EPSILON = 0.0002; // PhysicsGlobals.EPSILON from ACE

export interface CollisionPlane {
  normal: Vec3;
  distance: number; // D in: dot(normal, point) + D = 0 on plane
}

export interface CollisionSphere {
  center: Vec3;
  radius: number;
}

/** A physics polygon with resolved vertex positions and computed plane. */
export interface PhysicsPolygon {
  vertices: Vec3[];
  plane: CollisionPlane;
  numPts: number;
}

/** Result of a sphere-polygon intersection test. */
export interface CollisionHit {
  polygon: PhysicsPolygon;
  contactPoint: Vec3;
}

// ── Plane computation (ACE Polygon.make_plane) ──────────────

/**
 * Compute a plane from polygon vertices.
 * Reference: ACE Polygon.cs:210-232
 */
export function makePlane(vertices: Vec3[]): CollisionPlane {
  const n = vertices.length;
  if (n < 3) return { normal: { x: 0, y: 0, z: 1 }, distance: 0 };

  // Sum cross products of consecutive edge pairs from vertex 0
  let nx = 0, ny = 0, nz = 0;
  for (let spreadIdx = 1, i = n - 2; i > 0; i--, spreadIdx++) {
    const v1 = sub(vertices[spreadIdx], vertices[0]);
    const v2 = sub(vertices[spreadIdx + 1], vertices[0]);
    const c = cross(v1, v2);
    nx += c.x; ny += c.y; nz += c.z;
  }

  // Normalize
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len < 1e-10) return { normal: { x: 0, y: 0, z: 1 }, distance: 0 };
  const normal: Vec3 = { x: nx / len, y: ny / len, z: nz / len };

  // Distance = -(average of dot(normal, vertex))
  let distSum = 0;
  for (let i = 0; i < n; i++) {
    distSum += dot(normal, vertices[i]);
  }
  const distance = -(distSum / n);

  return { normal, distance };
}

// ── Polygon-sphere intersection (ACE Polygon.cs:331-397) ────

/**
 * Precise sphere-polygon intersection test.
 * Reference: ACE Polygon.polygon_hits_sphere_precise (lines 331-384)
 */
export function polygonHitsSpherePrecise(
  poly: PhysicsPolygon,
  sphere: CollisionSphere,
): { hit: boolean; contactPoint: Vec3 } {
  const result = { hit: false, contactPoint: { x: 0, y: 0, z: 0 } };
  if (poly.numPts === 0) { result.hit = true; return result; }

  const { normal, distance } = poly.plane;

  // Signed distance from sphere center to polygon plane
  const dpPos = dot(normal, sphere.center) + distance;
  const rad = sphere.radius - EPSILON;
  if (Math.abs(dpPos) > rad) return result; // sphere doesn't reach plane

  // Squared radius of sphere's cross-section circle at the plane
  const diff = rad * rad - dpPos * dpPos;

  // Project sphere center onto the plane
  const contactPoint: Vec3 = {
    x: sphere.center.x - normal.x * dpPos,
    y: sphere.center.y - normal.y * dpPos,
    z: sphere.center.z - normal.z * dpPos,
  };
  result.contactPoint = contactPoint;

  const verts = poly.vertices;
  const numPts = poly.numPts;

  // Edge containment test
  let prevIdx = numPts - 1;
  for (let i = 0; i < numPts; i++) {
    const vertex = verts[i];
    const lastVertex = verts[prevIdx];
    prevIdx = i;

    const edge = sub(vertex, lastVertex);
    const disp = sub(contactPoint, lastVertex);
    const edgeCross = cross(normal, edge);

    if (dot(disp, edgeCross) >= 0) continue; // inside this edge

    // Contact point is outside this edge — enter inner loop
    // to check if sphere's cross-section circle still reaches the polygon
    let innerPrevIdx = numPts - 1;
    for (let j = 0; j < numPts; j++) {
      const v = verts[j];
      const lv = verts[innerPrevIdx];
      innerPrevIdx = j;

      const e = sub(v, lv);
      const d = sub(contactPoint, lv);
      const c = cross(normal, e);
      const dispDot = dot(d, c);

      if (dispDot < 0) {
        // Outside this edge — check if circle reaches the edge line
        if (lengthSq(c) * diff < dispDot * dispDot) {
          return result; // too far from edge
        }
        // Check if we're alongside the edge (between endpoints)
        const dispEdge = dot(d, e);
        if (dispEdge >= 0 && dispEdge <= lengthSq(e)) {
          result.hit = true;
          return result; // sphere reaches edge segment
        }
      }

      // Check if we're close enough to this vertex
      if (lengthSq(d) <= diff) {
        result.hit = true;
        return result;
      }
    }
    return result; // exhausted inner loop without hit
  }

  // Passed all edge tests — contact point is inside polygon
  result.hit = true;
  return result;
}

/**
 * Movement-aware polygon-sphere hit test.
 * Returns true only if sphere intersects AND is moving INTO the polygon face.
 * Skips walkable surfaces (floors, stair tops) — only reports wall hits.
 * Reference: ACE Polygon.pos_hits_sphere (lines 386-397)
 *
 * `walkableZ` is the mover's walkable allowance (SpherePath.WalkableAllowance):
 * an upward face at least that flat is a floor it stands on, a steeper one a
 * wall. BUG.moveto-wall-climb-flying-target — a body on the ground has
 * CPhysicsObj::get_walkable_z = PhysicsGlobals.FloorZ (ACE PhysicsObj.cs
 * get_walkable_z, Transition.cs:758/852); LandingZ (the default) let a 51°
 * alcove wall in the Holtburg academy pass as floor, and the body climbed it
 * out of every cell. Downward faces (ceilings, overhangs) stay skipped.
 */
export function posHitsSphere(
  poly: PhysicsPolygon,
  sphere: CollisionSphere,
  movement: Vec3,
  walkableZ: number = WALKABLE_Z,
): CollisionHit | null {
  // Skip walkable surfaces — floors and stair tops should not block
  // horizontal movement. In AC Z-up coords, walkable = normal.z >= threshold.
  const nz = poly.plane.normal.z;
  if (nz >= walkableZ || nz <= -WALKABLE_Z) return null;

  const { hit, contactPoint } = polygonHitsSpherePrecise(poly, sphere);

  // Backface cull: if moving away from or parallel to the polygon, ignore
  if (dot(movement, poly.plane.normal) >= 0) return null;

  if (!hit) return null;
  return { polygon: poly, contactPoint };
}

// ── Collision BSP tree node ─────────────────────────────────

export interface CollisionBSPNode {
  type: string;
  splittingPlane?: CollisionPlane;
  boundingSphere?: CollisionSphere;
  posNode?: CollisionBSPNode;
  negNode?: CollisionBSPNode;
  // Leaf-only
  solid?: boolean;
  polygons?: PhysicsPolygon[];
}

// ── Build collision BSP from parsed DAT data ────────────────

/**
 * Build a collision-ready BSP tree from parsed DAT data.
 * Resolves polygon indices to PhysicsPolygons with precomputed planes.
 */
export function buildCollisionBSP(
  root: BSPNodeBase,
  physicsPolygons: Map<number, Polygon>,
  vertexArray: CVertexArray,
): CollisionBSPNode {
  return buildNode(root, physicsPolygons, vertexArray);
}

function resolvePolygon(poly: Polygon, vertexArray: CVertexArray): PhysicsPolygon {
  const vertices: Vec3[] = [];
  for (const idx of poly.vertexIndices) {
    const v = vertexArray.vertices.get(idx);
    if (v) {
      vertices.push({ x: v.origin.x, y: v.origin.y, z: v.origin.z });
    }
  }
  return {
    vertices,
    plane: makePlane(vertices),
    numPts: vertices.length,
  };
}

function resolvePolygons(
  inPolys: number[] | undefined,
  physicsPolygons: Map<number, Polygon>,
  vertexArray: CVertexArray,
): PhysicsPolygon[] | undefined {
  if (!inPolys || inPolys.length === 0) return undefined;
  const result: PhysicsPolygon[] = [];
  for (const idx of inPolys) {
    const poly = physicsPolygons.get(idx);
    if (poly) result.push(resolvePolygon(poly, vertexArray));
  }
  return result.length > 0 ? result : undefined;
}

function buildNode(
  node: BSPNodeBase,
  physicsPolygons: Map<number, Polygon>,
  vertexArray: CVertexArray,
): CollisionBSPNode {
  if (node.type === 'LEAF') {
    const leaf = node as BSPLeafNode;
    return {
      type: 'LEAF',
      solid: leaf.solid === 1,
      boundingSphere: leaf.sphere ? {
        center: leaf.sphere.origin,
        radius: leaf.sphere.radius,
      } : undefined,
      polygons: resolvePolygons(leaf.inPolys, physicsPolygons, vertexArray),
    };
  }

  const internal = node as BSPInternalNode;
  return {
    type: internal.type,
    splittingPlane: internal.splittingPlane ? {
      normal: internal.splittingPlane.normal,
      distance: internal.splittingPlane.distance,
    } : undefined,
    boundingSphere: internal.sphere ? {
      center: internal.sphere.origin,
      radius: internal.sphere.radius,
    } : undefined,
    posNode: internal.posNode ? buildNode(internal.posNode, physicsPolygons, vertexArray) : undefined,
    negNode: internal.negNode ? buildNode(internal.negNode, physicsPolygons, vertexArray) : undefined,
    polygons: resolvePolygons(internal.inPolys, physicsPolygons, vertexArray),
  };
}

// ── BSP traversal: sphere_intersects_poly ───────────────────

/**
 * Test if a moving sphere intersects any polygon in the BSP tree.
 * Returns the first hit polygon and contact point, or null.
 *
 * Reference: ACE BSPNode.sphere_intersects_poly (lines 242-263)
 *            ACE BSPLeaf.sphere_intersects_poly (lines 67-78)
 */
export function sphereIntersectsPoly(
  node: CollisionBSPNode | undefined,
  sphere: CollisionSphere,
  movement: Vec3,
  walkableZ: number = WALKABLE_Z,
): CollisionHit | null {
  if (!node) return null;

  // Bounding sphere early rejection
  if (node.boundingSphere) {
    const d = sub(sphere.center, node.boundingSphere.center);
    const combinedR = sphere.radius + node.boundingSphere.radius;
    if (lengthSq(d) > combinedR * combinedR) return null;
  }

  // Leaf node — test polygons directly
  if (node.type === 'LEAF') {
    if (!node.polygons || node.polygons.length === 0) return null;
    for (const poly of node.polygons) {
      const hit = posHitsSphere(poly, sphere, movement, walkableZ);
      if (hit) return hit;
    }
    return null;
  }

  // Internal node — split by plane
  if (!node.splittingPlane) return null;
  const plane = node.splittingPlane;
  const dist = dot(plane.normal, sphere.center) + plane.distance;
  const reach = sphere.radius - EPSILON;

  if (dist >= reach) {
    // Sphere entirely on positive side
    return sphereIntersectsPoly(node.posNode, sphere, movement, walkableZ);
  }
  if (dist <= -reach) {
    // Sphere entirely on negative side
    return sphereIntersectsPoly(node.negNode, sphere, movement, walkableZ);
  }

  // Sphere straddles the splitting plane — check both sides
  const posHit = sphereIntersectsPoly(node.posNode, sphere, movement, walkableZ);
  if (posHit) return posHit;
  return sphereIntersectsPoly(node.negNode, sphere, movement, walkableZ);
}

/**
 * BUG.spell-projectile-physics — `sphereIntersectsPoly` WITHOUT the
 * player-movement walkable-surface skip: ACE Polygon.pos_hits_sphere itself
 * (Physics/Polygon.cs) tests every polygon the sphere moves into, floors and
 * roofs included. A missile is stopped by a floor or ramp exactly like by a
 * wall.
 */
export function sphereIntersectsAnyPoly(
  node: CollisionBSPNode | undefined,
  sphere: CollisionSphere,
  movement: Vec3,
): CollisionHit | null {
  if (!node) return null;
  if (node.boundingSphere) {
    const d = sub(sphere.center, node.boundingSphere.center);
    const combinedR = sphere.radius + node.boundingSphere.radius;
    if (lengthSq(d) > combinedR * combinedR) return null;
  }
  if (node.type === 'LEAF') {
    if (!node.polygons) return null;
    for (const poly of node.polygons) {
      if (dot(movement, poly.plane.normal) >= 0) continue;
      const { hit, contactPoint } = polygonHitsSpherePrecise(poly, sphere);
      if (hit) return { polygon: poly, contactPoint };
    }
    return null;
  }
  if (!node.splittingPlane) return null;
  const dist = dot(node.splittingPlane.normal, sphere.center) + node.splittingPlane.distance;
  const reach = sphere.radius - EPSILON;
  if (dist >= reach) return sphereIntersectsAnyPoly(node.posNode, sphere, movement);
  if (dist <= -reach) return sphereIntersectsAnyPoly(node.negNode, sphere, movement);
  return sphereIntersectsAnyPoly(node.posNode, sphere, movement)
    ?? sphereIntersectsAnyPoly(node.negNode, sphere, movement);
}

// ── BSP traversal: find_walkable (the step-down / step-up lift) ──

/** The SPHEREPATH fields find_walkable reads and writes. */
export interface WalkablePath {
  /** SPHEREPATH::walk_interp: the unused fraction of the step-down (1 at the start). */
  walkInterp: number;
  /** SPHEREPATH::walkable_allowance: a face with N·up above this is walkable. */
  walkableAllowance: number;
}

/**
 * CPolygon::adjust_sphere_to_plane @ 00538210 (ACE Polygon.cs:73): move the
 * sphere back along `movement` until it rests on the plane. Only a sphere
 * already pushed into the plane moves (interp below walk_interp), and by no
 * more than 1.5 × the movement (interp ≥ −0.5).
 */
function adjustSphereToPlane(poly: PhysicsPolygon, path: WalkablePath, validPos: CollisionSphere, movement: Vec3): boolean {
  const dpPos = dot(validPos.center, poly.plane.normal) + poly.plane.distance;
  const dpMove = dot(movement, poly.plane.normal);
  let dist: number;
  if (dpMove <= EPSILON) {
    if (dpMove >= -EPSILON) return false;
    dist = dpPos - validPos.radius;
  } else {
    dist = -validPos.radius - dpPos;
  }
  const iDist = dist / dpMove;
  const interp = (1 - iDist) * path.walkInterp;
  if (interp >= path.walkInterp || interp < -0.5) return false;
  validPos.center = {
    x: validPos.center.x - movement.x * iDist,
    y: validPos.center.y - movement.y * iDist,
    z: validPos.center.z - movement.z * iDist,
  };
  path.walkInterp = interp;
  return true;
}

/**
 * BSPNODE / BSPLEAF::find_walkable (@ 0053d6f0; ACE BSPNode.cs:146,
 * BSPLeaf.cs:29): every walkable polygon the sphere overlaps
 * (CPolygon::walkable_hits_sphere: N·up above the walkable allowance and
 * polygon_hits_sphere_precise) sets the sphere down on its plane along
 * `movement`. `validPos.center` is moved in place; the return is the last
 * polygon that moved it (retail's hitPoly), or null when nothing did
 * (`changed` = 0). BSPTREE::step_sphere_down runs it with movement =
 * up × −(step_down_amt × walk_interp), which is how CTransition::step_up
 * lifts a body onto a stair tread. `skip` drops polygons the caller rules out
 * (DungeonCollision: a roof the body stands under).
 */
export function findWalkable(
  node: CollisionBSPNode | undefined,
  path: WalkablePath,
  validPos: CollisionSphere,
  movement: Vec3,
  up: Vec3,
  skip?: (poly: PhysicsPolygon) => boolean,
): PhysicsPolygon | null {
  if (!node) return null;
  if (node.boundingSphere) {
    const d = sub(validPos.center, node.boundingSphere.center);
    const combinedR = validPos.radius + node.boundingSphere.radius;
    if (lengthSq(d) > combinedR * combinedR) return null;
  }
  if (node.type === 'LEAF') {
    let hitPoly: PhysicsPolygon | null = null;
    for (const poly of node.polygons ?? []) {
      if (dot(up, poly.plane.normal) <= path.walkableAllowance) continue;
      if (skip?.(poly)) continue;
      if (!polygonHitsSpherePrecise(poly, validPos).hit) continue;
      if (adjustSphereToPlane(poly, path, validPos, movement)) hitPoly = poly;
    }
    return hitPoly;
  }
  if (!node.splittingPlane) return null;
  const dist = dot(node.splittingPlane.normal, validPos.center) + node.splittingPlane.distance;
  const reach = validPos.radius - EPSILON;
  if (dist >= reach) return findWalkable(node.posNode, path, validPos, movement, up, skip);
  if (dist <= -reach) return findWalkable(node.negNode, path, validPos, movement, up, skip);
  const pos = findWalkable(node.posNode, path, validPos, movement, up, skip);
  const neg = findWalkable(node.negNode, path, validPos, movement, up, skip);
  return neg ?? pos;
}

/**
 * RECON.transition-stepup-stepdown-port.e — the polygons
 * CPolygon::walkable_hits_sphere accepts for `sphere` (N·up above
 * `walkableAllowance`, polygon_hits_sphere_precise), found by the same BSP
 * walk as findWalkable but without moving the sphere: the walkables a
 * step-down sphere lands on. Each polygon once, in visit order.
 */
export function collectWalkableSphereHits(
  node: CollisionBSPNode | undefined,
  sphere: CollisionSphere,
  up: Vec3,
  walkableAllowance: number,
  out: PhysicsPolygon[] = [],
): PhysicsPolygon[] {
  if (!node) return out;
  if (node.boundingSphere) {
    const d = sub(sphere.center, node.boundingSphere.center);
    const combinedR = sphere.radius + node.boundingSphere.radius;
    if (lengthSq(d) > combinedR * combinedR) return out;
  }
  if (node.type === 'LEAF') {
    for (const poly of node.polygons ?? []) {
      if (dot(up, poly.plane.normal) <= walkableAllowance) continue;
      if (out.includes(poly)) continue;
      if (polygonHitsSpherePrecise(poly, sphere).hit) out.push(poly);
    }
    return out;
  }
  if (!node.splittingPlane) return out;
  const dist = dot(node.splittingPlane.normal, sphere.center) + node.splittingPlane.distance;
  const reach = sphere.radius - EPSILON;
  if (dist >= reach) return collectWalkableSphereHits(node.posNode, sphere, up, walkableAllowance, out);
  if (dist <= -reach) return collectWalkableSphereHits(node.negNode, sphere, up, walkableAllowance, out);
  collectWalkableSphereHits(node.posNode, sphere, up, walkableAllowance, out);
  return collectWalkableSphereHits(node.negNode, sphere, up, walkableAllowance, out);
}

/**
 * RECON.transition-stepup-stepdown-port.e — how far along `up` a sphere of
 * `radius` at `center` must move to rest on `poly` (the polygon itself, not
 * its plane carried past its edges): the highest place, coming down `up`,
 * where it first touches the face, an edge or a vertex. Negative = it is
 * already above that place; null = the line along `up` never comes within
 * `radius` of the polygon.
 */
export function sphereRestLift(poly: PhysicsPolygon, center: Vec3, up: Vec3, radius: number): number | null {
  const n = poly.plane.normal;
  const r2 = radius * radius;
  let best: number | null = null;
  const take = (t: number) => { if (best === null || t > best) best = t; };
  // The face: the centre `radius` off the plane, its foot inside every edge.
  const nUp = dot(n, up);
  if (nUp > EPSILON) {
    const t = (radius - (dot(n, center) + poly.plane.distance)) / nUp;
    const foot = {
      x: center.x + up.x * t - n.x * radius,
      y: center.y + up.y * t - n.y * radius,
      z: center.z + up.z * t - n.z * radius,
    };
    let inside = true;
    const verts = poly.vertices;
    for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
      if (dot(sub(foot, verts[j]), cross(n, sub(verts[i], verts[j]))) < 0) { inside = false; break; }
    }
    if (inside) take(t);
  }
  const verts = poly.vertices;
  for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
    const a = verts[j];
    // The vertex: |center + t·up − a| = radius (up is unit).
    const w = sub(center, a);
    const bq = dot(up, w);
    const disc = bq * bq - (dot(w, w) - r2);
    if (disc >= 0) take(-bq + Math.sqrt(disc));
    // The edge a→b: the centre `radius` from the segment's line, its foot between the ends.
    const e = sub(verts[i], a);
    const eLen2 = lengthSq(e);
    if (eLen2 < 1e-12) continue;
    const uPerp = sub(up, mulScalar(e, dot(up, e) / eLen2));
    const wPerp = sub(w, mulScalar(e, dot(w, e) / eLen2));
    const qa = lengthSq(uPerp);
    if (qa < 1e-12) continue;
    const qb = dot(uPerp, wPerp);
    const qd = qb * qb - qa * (lengthSq(wPerp) - r2);
    if (qd < 0) continue;
    const t = (-qb + Math.sqrt(qd)) / qa;
    const s = dot({ x: w.x + up.x * t, y: w.y + up.y * t, z: w.z + up.z * t }, e) / eLen2;
    if (s >= 0 && s <= 1) take(t);
  }
  return best;
}

// ── BSP traversal: sphere_intersects_solid ──────────────────

/**
 * Test if a sphere overlaps any solid region in the BSP tree.
 * Used for containment/placement tests.
 *
 * Reference: ACE BSPNode.sphere_intersects_solid (lines 265-293)
 *            ACE BSPLeaf.sphere_intersects_solid (lines 80-91)
 */
export function sphereIntersectsSolid(
  node: CollisionBSPNode | undefined,
  sphere: CollisionSphere,
  checkCenter = true,
): boolean {
  if (!node) return false;

  // Bounding sphere early rejection
  if (node.boundingSphere) {
    const d = sub(sphere.center, node.boundingSphere.center);
    const combinedR = sphere.radius + node.boundingSphere.radius;
    if (lengthSq(d) > combinedR * combinedR) return false;
  }

  // Leaf node
  if (node.type === 'LEAF') {
    if (checkCenter && node.solid) return true;
    if (!node.polygons || node.polygons.length === 0) return false;
    for (const poly of node.polygons) {
      const { hit } = polygonHitsSpherePrecise(poly, sphere);
      if (hit) return true;
    }
    return false;
  }

  // Internal node
  if (!node.splittingPlane) return false;
  const plane = node.splittingPlane;
  const dist = dot(plane.normal, sphere.center) + plane.distance;
  const reach = sphere.radius - EPSILON;

  if (dist >= reach) {
    return sphereIntersectsSolid(node.posNode, sphere, checkCenter);
  }
  if (dist <= -reach) {
    return sphereIntersectsSolid(node.negNode, sphere, checkCenter);
  }

  // Straddles — check both
  if (sphereIntersectsSolid(node.posNode, sphere, checkCenter)) return true;
  return sphereIntersectsSolid(node.negNode, sphere, false);
}

// ── Floor detection: find walkable surface ──────────────────

/** PhysicsGlobals.LandingZ: the flattest-to-steepest face anything can land on (the default allowance). */
const WALKABLE_Z = 0.0871557;
/** PhysicsGlobals.FloorZ — CPhysicsObj::get_walkable_z: the steepest face a body on the ground walks on. */
export const FLOOR_WALKABLE_Z = 0.66417414618662751;

/**
 * Find the floor height at a given XY position by scanning the BSP tree
 * for walkable polygons (upward-facing normals with Z >= WALKABLE_Z).
 *
 * Returns the Z height of the closest walkable surface to fromZ, or null.
 * Coordinates are in AC Z-up cell-local space.
 */
export function findFloorHeight(
  node: CollisionBSPNode | undefined,
  x: number,
  y: number,
  fromZ: number,
): number | null {
  if (!node) return null;

  // Collect all walkable polygon hits at this XY
  const hits: number[] = [];
  collectWalkableHeights(node, x, y, hits);
  if (hits.length === 0) return null;

  // Find the closest floor to fromZ (within 2m above for stairs, 3m below for drops)
  let bestZ: number | null = null;
  let bestDist = Infinity;
  for (const z of hits) {
    if (z > fromZ + 2.0 || z < fromZ - 3.0) continue;
    const dist = Math.abs(z - fromZ);
    if (dist < bestDist) {
      bestDist = dist;
      bestZ = z;
    }
  }
  return bestZ;
}

/**
 * Collect every walkable floor Z at the given (x, y) in the BSP. Unlike
 * findFloorHeight (which returns only the one closest to fromZ within a
 * narrow range), this returns all candidates. Callers can then implement
 * stair-aware preference — e.g. prefer the highest floor within step-up
 * reach when a foundation slab overlaps a stair tread at the same XY.
 */
export function collectWalkableFloorHeights(
  node: CollisionBSPNode | undefined,
  x: number,
  y: number,
  walkableZ: number = WALKABLE_Z,
): number[] {
  const results: number[] = [];
  collectWalkableHeights(node, x, y, results, undefined, walkableZ);
  return results;
}

/** A walkable floor under (x, y): its height and its plane normal (AC axes, unit). */
export interface WalkableFloor {
  z: number;
  normal: { x: number; y: number; z: number };
  /** The walkable polygon itself (SPHEREPATH::walkable for precipice_slide). */
  poly: PhysicsPolygon;
}

/**
 * collectWalkableFloorHeights with each floor's plane normal — the contact
 * plane (CPhysicsObj::contact_plane) a body standing on that polygon has.
 */
export function collectWalkableFloors(
  node: CollisionBSPNode | undefined,
  x: number,
  y: number,
  walkableZ: number = WALKABLE_Z,
): WalkableFloor[] {
  const results: WalkableFloor[] = [];
  collectWalkableHeights(node, x, y, undefined, results, walkableZ);
  return results;
}

function collectWalkableHeights(
  node: CollisionBSPNode | undefined,
  x: number,
  y: number,
  results: number[] | undefined,
  floors?: WalkableFloor[],
  walkableZ: number = WALKABLE_Z,
): void {
  if (!node) return;

  // Check polygons at this node (leaf or internal with inPolys)
  if (node.polygons) {
    for (const poly of node.polygons) {
      // Only consider upward-facing (walkable) polygons
      if (poly.plane.normal.z < walkableZ) continue;
      // Compute Z height at (x, y) from plane equation:
      // dot(normal, point) + D = 0  →  nz*z = -(nx*x + ny*y + D)
      if (Math.abs(poly.plane.normal.z) < 1e-10) continue;
      const z = -(poly.plane.normal.x * x + poly.plane.normal.y * y + poly.plane.distance) / poly.plane.normal.z;
      // Simple point-in-polygon check via edge cross products
      if (pointInPolygonXY(poly, x, y)) {
        results?.push(z);
        floors?.push({ z, normal: poly.plane.normal, poly });
      }
    }
  }

  // Recurse into children
  if (node.type !== 'LEAF') {
    if (node.splittingPlane) {
      // For floor detection we need to check both sides since we're
      // looking for polygons at a specific XY, not moving a sphere
      collectWalkableHeights(node.posNode, x, y, results, floors, walkableZ);
      collectWalkableHeights(node.negNode, x, y, results, floors, walkableZ);
    }
  }
}

/**
 * CPolygon::find_crossed_edge (ACE Polygon.cs:175): project `center` along
 * `up` onto the polygon's plane and return plane.N x edge, normalized
 * (pointing back inside for retail's counter-clockwise winding), for the
 * first edge it lies outside of, in the polygon's own frame. Null when `up` is parallel to the plane or the point
 * is inside every edge. SPHEREPATH::precipice_slide slides along that edge.
 */
export function findCrossedEdge(
  poly: PhysicsPolygon, center: Vec3, up: Vec3,
): { x: number; y: number; z: number } | null {
  const n = poly.plane.normal;
  const angleUp = n.x * up.x + n.y * up.y + n.z * up.z;
  if (Math.abs(angleUp) < CROSSED_EDGE_EPSILON) return null;
  const angle = (n.x * center.x + n.y * center.y + n.z * center.z + poly.plane.distance) / angleUp;
  const cx = center.x - up.x * angle;
  const cy = center.y - up.y * angle;
  const cz = center.z - up.z * angle;
  const verts = poly.vertices;
  let prevIdx = verts.length - 1;
  for (let i = 0; i < verts.length; i++) {
    const v = verts[i];
    const lv = verts[prevIdx];
    prevIdx = i;
    const ex = v.x - lv.x, ey = v.y - lv.y, ez = v.z - lv.z;
    // cross = plane.N x edge
    const kx = n.y * ez - n.z * ey;
    const ky = n.z * ex - n.x * ez;
    const kz = n.x * ey - n.y * ex;
    if ((cx - lv.x) * kx + (cy - lv.y) * ky + (cz - lv.z) * kz < 0) {
      const len = Math.hypot(kx, ky, kz);
      if (len === 0) continue;
      return { x: kx / len, y: ky / len, z: kz / len };
    }
  }
  return null;
}

/** PhysicsGlobals.EPSILON (ACE PhysicsGlobals.cs: 0.0002). */
const CROSSED_EDGE_EPSILON = 0.0002;

/** Simple 2D point-in-polygon test (XY plane, AC Z-up). */
function pointInPolygonXY(poly: PhysicsPolygon, px: number, py: number): boolean {
  const verts = poly.vertices;
  const n = verts.length;
  if (n < 3) return false;

  let prevIdx = n - 1;
  for (let i = 0; i < n; i++) {
    const v = verts[i];
    const lv = verts[prevIdx];
    prevIdx = i;
    // Edge vector
    const ex = v.x - lv.x;
    const ey = v.y - lv.y;
    // Point to vertex vector
    const dx = px - lv.x;
    const dy = py - lv.y;
    // 2D cross product (Z component of 3D cross)
    const crossZ = ex * dy - ey * dx;
    if (crossZ < 0) return false; // outside this edge
  }
  return true;
}
