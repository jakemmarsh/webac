/**
 * FAITHFUL.199 — Cylinder-based scenery collision tests.
 *
 * AC tree/rock GfxObjs typically have NO physicsBSP (flags 0x0a = HasDrawing
 * + DIDDegrade, no 0x1 HasPhysics). The retail physics system uses sphere /
 * cylinder approximation for these via the Setup's cylSpheres/spheres.
 *
 * We add a parallel `cylinders` track to DungeonCollision so scenery
 * objects without physicsBSP still block player movement. The player is
 * treated as a 0.4m-radius sphere; collision triggers when the player's
 * footprint would overlap any registered cylinder.
 *
 * Reference: ACE.Server/Physics/Animation/Sphere.cs collision tests.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { DungeonCollision } from '@ac/renderer/world/DungeonCollision.js';

describe('DungeonCollision.addCylinderObstacle', () => {
  it('blocks straight-line movement into a cylinder', () => {
    const c = new DungeonCollision();
    // Cylinder at (5, 5), radius 2. Player at (3, 3) moving directly toward
    // the cylinder center — the player+cylinder radius sum is 2.4 (2 + 0.4),
    // current distance is sqrt(8)=2.83, so any movement closer overlaps.
    c.addCylinderObstacle(1, 5, 5, 2);
    expect(c.cylinderCount).toBe(1);
    const pos = new THREE.Vector3(3, 1, 3);
    // Move toward the cylinder by 5m — should be fully blocked.
    const [adjX, adjZ] = c.getAdjustedMovement(pos, 2, 2);
    // Direct radial movement → slide tangent is zero, so result is [0, 0].
    expect(adjX).toBe(0);
    expect(adjZ).toBe(0);
  });

  it('allows movement perpendicular to the cylinder (slide)', () => {
    const c = new DungeonCollision();
    c.addCylinderObstacle(1, 10, 0, 2);
    // Player just outside cylinder; movement perpendicular to the
    // player→cylinder vector (no overlap) should pass.
    const pos = new THREE.Vector3(7.5, 1, 0);
    const [adjX, adjZ] = c.getAdjustedMovement(pos, 0, 1);
    // Perpendicular movement on Z axis — no XZ overlap at z=1.
    expect(adjZ).toBeCloseTo(1, 2);
    expect(Math.abs(adjX)).toBeLessThan(0.1);
  });

  it('respects bottomY / topY vertical filter for canopy obstacles', () => {
    const c = new DungeonCollision();
    // Cylinder only blocks Y in [10, 20] — anything outside should pass.
    c.addCylinderObstacle(1, 5, 5, 3, 10, 20);
    const posBelow = new THREE.Vector3(0, 5, 0);
    const [adjX, adjZ] = c.getAdjustedMovement(posBelow, 5, 5);
    // At Y=5 (below the cylinder), movement should be unblocked.
    expect(adjX).toBeCloseTo(5, 2);
    expect(adjZ).toBeCloseTo(5, 2);
  });

  it('removeCylinderObstacle clears collision', () => {
    const c = new DungeonCollision();
    c.addCylinderObstacle(1, 10, 10, 2);
    expect(c.cylinderCount).toBe(1);
    c.removeCylinderObstacle(1);
    expect(c.cylinderCount).toBe(0);
    // Movement should now be unblocked.
    const pos = new THREE.Vector3(0, 1, 0);
    const [adjX, adjZ] = c.getAdjustedMovement(pos, 5, 5);
    expect(adjX).toBeCloseTo(5, 2);
    expect(adjZ).toBeCloseTo(5, 2);
  });

  it('hasCells returns true when only cylinders are present', () => {
    const c = new DungeonCollision();
    expect(c.hasCells).toBe(false);
    c.addCylinderObstacle(1, 0, 0, 1);
    expect(c.hasCells).toBe(true);
  });

  it('cylinder with radius<=0 is silently skipped', () => {
    const c = new DungeonCollision();
    c.addCylinderObstacle(1, 0, 0, 0);
    c.addCylinderObstacle(2, 0, 0, -1);
    expect(c.cylinderCount).toBe(0);
  });
});
