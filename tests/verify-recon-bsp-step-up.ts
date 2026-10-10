/**
 * RECON.transition-stepup-stepdown-port.c: the BSP step up is retail's
 * CTransition::step_up @ 0050b610 (ACE Transition.cs:744), not a raise and
 * retest. step_down runs with step_up set, so BSPTREE::step_sphere_down
 * @ 0053a210 → find_walkable lifts the feet sphere at the destination onto
 * the walkable polygon it overlaps (CPolygon::adjust_sphere_to_plane
 * @ 00538210, capped at 1.5 × the step), and the Placement insert
 * (sphere_intersects_solid on both body spheres) must pass where it lands.
 * Otherwise SPHEREPATH::step_up_slide slides.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { makePlane, findWalkable, FLOOR_WALKABLE_Z } from '@ac/shared';
import type { PhysicsPolygon, CollisionBSPNode, CollisionSphere } from '@ac/shared';
import { DungeonCollision, terrainStepUpLift } from '@ac/renderer/world/DungeonCollision.js';

type V = [number, number, number];

function quad(v0: V, v1: V, v2: V, v3: V): PhysicsPolygon {
  const vertices = [v0, v1, v2, v3].map(([x, y, z]) => ({ x, y, z }));
  return { vertices, plane: makePlane(vertices), numPts: 4 };
}

/** A floor (normal +Z) over [x0, x1] × [-2, 2] at height z. */
const floor = (x0: number, x1: number, z: number) => quad([x0, -2, z], [x1, -2, z], [x1, 2, z], [x0, 2, z]);
/** A ceiling (normal −Z) over [x0, x1] × [-2, 2] at height z. */
const ceiling = (x0: number, x1: number, z: number) => quad([x0, 2, z], [x1, 2, z], [x1, -2, z], [x0, -2, z]);
/** A riser facing −X at x, spanning z0..z1. */
const riser = (x: number, z0: number, z1: number) => quad([x, 2, z0], [x, -2, z0], [x, -2, z1], [x, 2, z1]);

function leaf(polys: PhysicsPolygon[]): CollisionBSPNode {
  return { type: 'LEAF', solid: false, boundingSphere: { center: { x: 0, y: 0, z: 0 }, radius: 100 }, polygons: polys };
}

/** A GfxObj-shaped physics source holding `polys` in one leaf (addGfxObjCollision input). */
function gfx(polys: PhysicsPolygon[]) {
  const physicsPolygons = new Map<number, unknown>();
  const vertices = new Map<number, unknown>();
  let vi = 0;
  polys.forEach((p, pi) => {
    const ids: number[] = [];
    for (const v of p.vertices) { vertices.set(vi, { origin: v, normal: { x: 0, y: 0, z: 1 }, uvs: [] }); ids.push(vi++); }
    physicsPolygons.set(pi, { vertexIndices: ids, numVertices: ids.length, stippling: 0, sidesType: 0, portalIndex: -1, polyId: pi });
  });
  return {
    physicsBSP: { rootNode: { type: 'LEAF', solid: 0, sphere: { origin: { x: 0, y: 0, z: 0 }, radius: 100 }, inPolys: [...physicsPolygons.keys()] } },
    physicsPolygons,
    vertexArray: { vertices },
  } as never;
}

function collider(polys: PhysicsPolygon[]): DungeonCollision {
  const dc = new DungeonCollision();
  dc.addGfxObjCollision(1, gfx(polys), { x: 0, y: 0, z: 0 }, { w: 1, x: 0, y: 0, z: 0 }, 0, 0);
  return dc;
}

const UP = { x: 0, y: 0, z: 1 };
const R = DungeonCollision.BODY_SPHERE_RADIUS;
const H = DungeonCollision.STEP_UP_HEIGHT;
const FEET = DungeonCollision.LOWER_SPHERE_HEIGHT;

describe('findWalkable (BSPLEAF::find_walkable + CPolygon::adjust_sphere_to_plane)', () => {
  it('sets a sphere pushed into a tread down onto its plane and spends walk_interp', () => {
    const path = { walkInterp: 1, walkableAllowance: FLOOR_WALKABLE_Z };
    const sphere: CollisionSphere = { center: { x: 2.5, y: 0, z: FEET }, radius: R };
    const poly = findWalkable(leaf([floor(2, 5, 0.3)]), path, sphere, { x: 0, y: 0, z: -H }, UP);
    expect(poly).not.toBeNull();
    expect(sphere.center.z).toBeCloseTo(0.3 + R, 6);
    // interp = 1 − lift / H
    expect(path.walkInterp).toBeCloseTo(1 - (0.3 + R - FEET) / H, 6);
  });

  it('leaves a sphere resting on the plane (not pushed in) alone', () => {
    const path = { walkInterp: 1, walkableAllowance: FLOOR_WALKABLE_Z };
    const sphere: CollisionSphere = { center: { x: 2.5, y: 0, z: R }, radius: R };
    expect(findWalkable(leaf([floor(0, 5, 0)]), path, sphere, { x: 0, y: 0, z: -H }, UP)).toBeNull();
    expect(sphere.center.z).toBe(R);
    expect(path.walkInterp).toBe(1);
  });

  it('caps the lift at 1.5 × the movement (interp ≥ −0.5)', () => {
    const lift = (tread: number) => {
      const path = { walkInterp: 1, walkableAllowance: FLOOR_WALKABLE_Z };
      const sphere: CollisionSphere = { center: { x: 2.5, y: 0, z: FEET }, radius: R };
      return findWalkable(leaf([floor(2, 5, tread)]), path, sphere, { x: 0, y: 0, z: -H }, UP) ? sphere.center.z - FEET : 0;
    };
    expect(lift(0.85)).toBeCloseTo(0.85 + R - FEET, 6); // under 1.5 × 0.6 = 0.9
    expect(lift(0.92)).toBe(0); // over it
  });

  it('skips a face no flatter than the walkable allowance (FloorZ on the ground)', () => {
    // A 51° ramp: N.z = cos 51° ≈ 0.63 < FloorZ 0.664.
    const t = Math.tan((51 * Math.PI) / 180);
    const ramp = quad([2, -2, 0], [4, -2, 2 * t], [4, 2, 2 * t], [2, 2, 0]);
    expect(ramp.plane.normal.z).toBeLessThan(FLOOR_WALKABLE_Z);
    const path = { walkInterp: 1, walkableAllowance: FLOOR_WALKABLE_Z };
    const sphere: CollisionSphere = { center: { x: 2.5, y: 0, z: FEET }, radius: R };
    expect(findWalkable(leaf([ramp]), path, sphere, { x: 0, y: 0, z: -H }, UP)).toBeNull();
  });
});

describe('DungeonCollision BSP step up = CTransition::step_up', () => {
  it('lifts the body by the tread height it lands on, not the full StepUpHeight', () => {
    const dc = collider([floor(-1, 2, 0), riser(2, 0, 0.3), floor(2, 5, 0.3)]);
    const [dx] = dc.getAdjustedMovement(new THREE.Vector3(1.5, 0, 0), 0.6, 0);
    expect(dx).toBeCloseTo(0.6, 6);
    // Retail feet sphere sits 5 mm into the floor (0.475 centre, 0.48 radius).
    expect(dc.lastStepUp).toBeCloseTo(0.3 + R - FEET, 4);
    expect(dc.lastStepUp).toBeLessThan(H);
  });

  it('steps onto a ledge up to 1.5 × StepUpHeight that the old raise-and-retest refused', () => {
    const dc = collider([floor(-1, 2, 0), riser(2, 0, 0.85), floor(2, 5, 0.85)]);
    const [dx] = dc.getAdjustedMovement(new THREE.Vector3(1.5, 0, 0), 0.6, 0);
    expect(dx).toBeCloseTo(0.6, 6);
    expect(dc.lastStepUp).toBeCloseTo(0.85 + R - FEET, 4);
    // The floor search biased by the lift lands on the ledge (main.ts floorSearchFromY).
    expect(dc.getFloorHeight(2.1, 0, dc.lastStepUp)).toBeCloseTo(0.85, 4);
  });

  it('refuses a ledge above 1.5 × StepUpHeight: the body stays on its floor', () => {
    const dc = collider([floor(-1, 2, 0), riser(2, 0, 0.95), floor(2, 5, 0.95)]);
    const [dx, dz] = dc.getAdjustedMovement(new THREE.Vector3(1.5, 0, 0), 0.6, 0);
    expect(Math.hypot(dx, dz)).toBeLessThan(1e-6);
    expect(dc.lastStepUp).toBe(0);
  });

  it('fails the step when the body does not fit where it lands (Placement: a ceiling over the tread)', () => {
    const open = collider([floor(-1, 2, 0), riser(2, 0, 0.3), floor(2, 5, 0.3)]);
    open.getAdjustedMovement(new THREE.Vector3(1.5, 0, 0), 0.6, 0);
    expect(open.lastStepUp).toBeGreaterThan(0);

    // Head sphere at the landing: 0.305 + 1.35 = 1.655, top 2.135 — a 1.9 m ceiling cuts it.
    // The raise-and-retest never saw it (pos_hits_sphere skips downward faces).
    const low = collider([floor(-1, 2, 0), riser(2, 0, 0.3), floor(2, 5, 0.3), ceiling(2, 5, 1.9)]);
    const [dx, dz] = low.getAdjustedMovement(new THREE.Vector3(1.5, 0, 0), 0.6, 0);
    expect(low.lastStepUp).toBe(0);
    expect(Math.hypot(dx, dz)).toBeLessThan(1e-6); // step_up_slide along a wall met head-on: no motion
  });

  it('step_up_slide: a failed step slides along the riser', () => {
    const dc = collider([floor(-1, 2, 0), riser(2, 0, 0.95), floor(2, 5, 0.95)]);
    const [dx, dz] = dc.getAdjustedMovement(new THREE.Vector3(1.5, 0, 0), 0.4, 0.4);
    expect(dc.lastStepUp).toBe(0);
    expect(dx).toBeCloseTo(0, 6);
    expect(dz).toBeCloseTo(0.4, 6);
  });
});

/**
 * RECON.transition-stepup-stepdown-port.c.a — outside every EnvCell, the
 * step up's step_down also runs the land cell (CheckOtherCells →
 * CLandCell::find_env_collisions → OBJECTINFO::validate_walkable; ACE
 * LandCell.cs:37-66, ObjectInfo.cs:104-155). With step_up set the check
 * position is not lowered, so the terrain only lifts a feet sphere embedded
 * in it, and the Placement insert decides as for a BSP landing. A riser
 * with no walkable top is slid along, not stepped over by a raised retest.
 */
describe('terrainStepUpLift (validate_walkable during the step up)', () => {
  const flat = (height: number, waterDepth = 0) => ({ height, normal: { x: 0, y: 1, z: 0 }, waterDepth });

  it('a sphere above the terrain sets no contact plane: the step fails', () => {
    expect(terrainStepUpLift(0.01, flat(0), H)).toBeNull();
  });

  it('a sphere within EPSILON of the terrain lands without moving', () => {
    expect(terrainStepUpLift(0.0001, flat(0), H)).toBe(0);
    expect(terrainStepUpLift(-0.0001, flat(0), H)).toBe(0);
  });

  it('an embedded sphere is lifted onto the plane by -zDist', () => {
    expect(terrainStepUpLift(0, flat(0.35), H)).toBeCloseTo(0.35, 6);
  });

  it('refuses a lift past 1.1 × StepUpHeight (interp < -0.1)', () => {
    expect(terrainStepUpLift(0, flat(1.1 * H - 0.01), H)).toBeCloseTo(1.1 * H - 0.01, 6);
    expect(terrainStepUpLift(0, flat(1.1 * H + 0.01), H)).toBeNull();
  });

  it('needs a walkable plane (contact_plane.N.z ≥ FloorZ)', () => {
    const steep = { height: 0.2, normal: { x: Math.sqrt(1 - 0.6 * 0.6), y: 0.6, z: 0 } };
    expect(terrainStepUpLift(0, steep, H)).toBeNull();
  });

  it('adds the wading depth to the contact distance', () => {
    // 0.1 m under a flooded cell's 0.45 m depth: dist = -0.1 + 0.45 > EPSILON.
    expect(terrainStepUpLift(-0.1, flat(0, 0.45), H)).toBeNull();
    expect(terrainStepUpLift(-0.5, flat(0, 0.45), H)).toBeCloseTo(0.05, 6);
  });
});

describe('outdoor step up lands on the terrain (no BSP walkable under the feet)', () => {
  function outdoor(polys: PhysicsPolygon[], terrainAt: (x: number) => number | null, normalY = 1): DungeonCollision {
    const dc = collider(polys);
    dc.setTerrainLanding((x) => {
      const height = terrainAt(x);
      return height === null ? null : { height, normal: { x: Math.sqrt(1 - normalY * normalY), y: normalY, z: 0 } };
    });
    return dc;
  }

  it('a bare fence on flat terrain is not stepped over (the old raised retest cleared it)', () => {
    const dc = outdoor([riser(2, 0, 0.3)], () => 0);
    const [dx, dz] = dc.getAdjustedMovement(new THREE.Vector3(1.5, 0, 0), 0.6, 0);
    expect(dc.lastStepUp).toBe(0);
    expect(Math.hypot(dx, dz)).toBeLessThan(1e-6);
  });

  it('step_up_slide: a diagonal step into the bare fence slides along it', () => {
    const dc = outdoor([riser(2, 0, 0.3)], () => 0);
    const [dx, dz] = dc.getAdjustedMovement(new THREE.Vector3(1.5, 0, 0), 0.4, 0.4);
    expect(dc.lastStepUp).toBe(0);
    expect(dx).toBeCloseTo(0, 6);
    expect(dz).toBeCloseTo(0.4, 6);
  });

  it('lifts onto terrain rising past a low riser (a rock buried in a slope), by the terrain lift', () => {
    const dc = outdoor([riser(2, 0, 0.3)], (x) => (x >= 2 ? 0.35 : 0));
    const [dx] = dc.getAdjustedMovement(new THREE.Vector3(1.5, 0, 0), 0.6, 0);
    expect(dx).toBeCloseTo(0.6, 6);
    expect(dc.lastStepUp).toBeCloseTo(0.35 + R - FEET, 4);
  });

  it('refuses terrain more than 1.1 × StepUpHeight above the feet sphere', () => {
    const dc = outdoor([riser(2, 0, 0.3)], (x) => (x >= 2 ? 0.7 : 0));
    const [dx, dz] = dc.getAdjustedMovement(new THREE.Vector3(1.5, 0, 0), 0.6, 0);
    expect(dc.lastStepUp).toBe(0);
    expect(Math.hypot(dx, dz)).toBeLessThan(1e-6);
  });

  it('refuses an unwalkable terrain face at the landing', () => {
    const dc = outdoor([riser(2, 0, 0.3)], (x) => (x >= 2 ? 0.35 : 0), 0.6);
    const [dx, dz] = dc.getAdjustedMovement(new THREE.Vector3(1.5, 0, 0), 0.6, 0);
    expect(dc.lastStepUp).toBe(0);
    expect(Math.hypot(dx, dz)).toBeLessThan(1e-6);
  });

  it('with no terrain source (a dungeon collider outside its cells) the step fails', () => {
    const dc = collider([riser(2, 0, 0.3)]);
    const [dx, dz] = dc.getAdjustedMovement(new THREE.Vector3(1.5, 0, 0), 0.6, 0);
    expect(dc.lastStepUp).toBe(0);
    expect(Math.hypot(dx, dz)).toBeLessThan(1e-6);
  });

  it('a BSP tread still wins over the terrain beneath it', () => {
    const dc = outdoor([floor(-1, 2, 0), riser(2, 0, 0.3), floor(2, 5, 0.3)], () => 0);
    const [dx] = dc.getAdjustedMovement(new THREE.Vector3(1.5, 0, 0), 0.6, 0);
    expect(dx).toBeCloseTo(0.6, 6);
    expect(dc.lastStepUp).toBeCloseTo(0.3 + R - FEET, 4);
  });
});

/**
 * RECON.transition-stepup-stepdown-port.c.b — a CylSphere / Sphere obstacle
 * met by the feet sphere runs the same CTransition::step_up
 * (CCylSphere::step_sphere_up @ 0053b310 / CSphere::step_sphere_up @ 00537900): the
 * step down lands the feet sphere on the cylinder's top
 * (CCylSphere::step_sphere_down @ 0053a9b0: deltaz = Height + r − disp.Z) or
 * on a walkable spot of the sphere (CSphere::step_sphere_down @ 00536d20:
 * contact normal Z above FloorZ), then the Placement insert. The old raise
 * by the full StepUpHeight and retest is gone.
 */
describe('obstacle step up = CTransition::step_up (CylSphere / Sphere)', () => {
  it('lands on a knee-high cylinder top: the lift is Height + r − disp.Z, not StepUpHeight', () => {
    const dc = new DungeonCollision();
    dc.addCylinderObstacle('stump', 10, 10, 0.5, 0, 0.3);
    const [dx, dz] = dc.getAdjustedMovement(new THREE.Vector3(10, 0, 8.5), 0, 0.6);
    expect(dx).toBe(0);
    expect(dz).toBeCloseTo(0.6, 6);
    expect(dc.lastStepUp).toBeCloseTo(0.3 + R - FEET, 5);
    expect(dc.lastStepUp).toBeLessThan(H);
  });

  it('a cylinder raised off the ground lifts by its top above the feet sphere', () => {
    const dc = new DungeonCollision();
    dc.addCylinderObstacle('ledge', 10, 10, 0.5, 0.2, 0.5);
    dc.getAdjustedMovement(new THREE.Vector3(10, 0, 8.5), 0, 0.6);
    expect(dc.lastStepUp).toBeCloseTo(0.5 + R - FEET, 5);
  });

  it('fails the step when the body does not fit on the cylinder (Placement: a ceiling over it)', () => {
    // Head sphere on the top: 0.305 + 1.35 = 1.655, top 2.135 — a 1.9 m ceiling cuts it.
    const dc = collider([ceiling(5, 15, 1.9)]);
    dc.addCylinderObstacle('stump', 10, 0, 0.5, 0, 0.3);
    const [dx, dz] = dc.getAdjustedMovement(new THREE.Vector3(8.5, 0, 0), 0.6, 0);
    expect(dc.lastStepUp).toBe(0);
    expect(Math.hypot(dx, dz)).toBeLessThan(1e-6); // head-on: step_up_slide has no tangent
  });

  it('a body meeting a low sphere at its side finds no walkable spot and slides round it', () => {
    // Boulder radius 0.3 centred on the ground: radsum 0.78, rise 0.305 ≤ StepUpHeight,
    // so the step up is tried. At 0.6 m off its axis the surface normal Z is
    // ~0.64 < FloorZ: no contact plane, the step fails (the raised retest cleared it).
    const dc = new DungeonCollision();
    dc.addSphereObstacle('boulder', 10, 0, 10, 0.3);
    const [dx, dz] = dc.getAdjustedMovement(new THREE.Vector3(10, 0, 9.35), 0, 0.05);
    expect(dc.lastStepUp).toBe(0);
    expect(Math.hypot(dx, dz)).toBeLessThan(1e-6);
    // Met off-centre, the body slides along the tangent instead.
    const [sx, sz] = dc.getAdjustedMovement(new THREE.Vector3(10.3, 0, 9.35), 0, 0.12); // to 0.61 m off: normal Z 0.62
    expect(dc.lastStepUp).toBe(0);
    expect(Math.abs(sx)).toBeGreaterThan(0);
    expect(Math.hypot(sx, sz)).toBeLessThan(0.12);
  });

  it('a step deep enough onto the sphere top lands on its walkable spot by sqrt(reach² − dxy²) − disp.Z', () => {
    const dc = new DungeonCollision();
    dc.addSphereObstacle('boulder', 10, 0, 10, 0.3);
    // 0.65 m off the axis (clear) to 0.4 m: normal Z 0.86 > FloorZ.
    const [, dz] = dc.getAdjustedMovement(new THREE.Vector3(10, 0, 9.35), 0, 0.25);
    expect(dz).toBeCloseTo(0.25, 6);
    const reach = 0.3 + R;
    expect(dc.lastStepUp).toBeCloseTo(Math.sqrt(reach * reach - 0.4 * 0.4) - FEET, 4);
  });

  it('a creature-sized sphere (rise past StepUpHeight) is never stepped onto', () => {
    const dc = new DungeonCollision();
    dc.addSphereObstacle('body', 10, 1.0, 10, 1.0);
    const [dx, dz] = dc.getAdjustedMovement(new THREE.Vector3(10, 0, 8.4), 0, 0.2);
    expect(dc.lastStepUp).toBe(0);
    expect(Math.hypot(dx, dz)).toBeLessThan(1e-6);
  });
});
