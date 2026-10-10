/**
 * FAITHFUL.205 — Camera collision against cylinder obstacles.
 *
 * After FAITHFUL.199 added cylinder collision for tree/rock scenery, the
 * camera-follow system still only consulted the mesh raycaster which has
 * NO scenery in it (scenery objects render via Three.js but don't register
 * as collision meshes). Result: when a tree stood behind the player, the
 * camera spawned INSIDE the tree, filling the right half of the viewport
 * with bark texture.
 *
 * getCameraDistance now does line-vs-cylinder intersection alongside the
 * mesh raycast and returns the nearest hit's distance (minus 0.3m padding,
 * floor 0.5m) so the camera pulls forward to clear the tree.
 *
 * Reference: standard line-cylinder intersection — parametrize the ray as
 * P(t) = origin + t·dir, solve (P.x-cx)² + (P.z-cz)² = (r+pad)² for the
 * smallest positive t.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { DungeonCollision } from '@ac/renderer/world/DungeonCollision.js';

describe('FAITHFUL.205 — getCameraDistance vs cylinder obstacles', () => {
  it('returns maxDist when no obstacle is in the ray path', () => {
    const c = new DungeonCollision();
    c.addCylinderObstacle(1, 100, 100, 2); // far away
    const pPos = new THREE.Vector3(0, 1, 0);
    expect(c.getCameraDistance(pPos, 0, -5, 5)).toBe(5);
  });

  it('pulls camera forward when a cylinder blocks the behind-direction ray', () => {
    const c = new DungeonCollision();
    // Cylinder at (0, 3) with radius 1 — player at (0, 0) looking south so
    // camera-behind ray goes (0, -dist). Cylinder is 3m behind player.
    c.addCylinderObstacle(1, 0, 3, 1);
    const pPos = new THREE.Vector3(0, 1, 0);
    // Asking for 5m camera distance — cylinder entry is at ~2m
    // (3 - radius 1 - 0.25 padding = 1.75), result should be < 5
    const dist = c.getCameraDistance(pPos, 0, 3, 5);
    expect(dist).toBeLessThan(5);
    // And it should be roughly the cylinder entry distance minus the 0.3 padding.
    expect(dist).toBeGreaterThan(1);
    expect(dist).toBeLessThan(3);
  });

  it('respects the bottomY/topY vertical filter — cylinder above camera does not block', () => {
    const c = new DungeonCollision();
    // Cylinder only blocks Y in [10, 20] — camera ray at Y=1 is below.
    c.addCylinderObstacle(1, 0, 3, 1, 10, 20);
    const pPos = new THREE.Vector3(0, 1, 0);
    expect(c.getCameraDistance(pPos, 0, 3, 5)).toBe(5);
  });

  it('a cylinder containing the player at start is ignored (camera stays at maxDist)', () => {
    // Player at center of a 5m-radius cylinder — c < 0 case in the math.
    const c = new DungeonCollision();
    c.addCylinderObstacle(1, 0, 0, 5);
    const pPos = new THREE.Vector3(0, 1, 0);
    expect(c.getCameraDistance(pPos, 0, 3, 5)).toBe(5);
  });

  it('picks the nearest of multiple cylinder hits along the ray', () => {
    const c = new DungeonCollision();
    c.addCylinderObstacle(1, 0, 8, 0.5);   // far
    c.addCylinderObstacle(2, 0, 3, 0.5);   // near
    c.addCylinderObstacle(3, 0, 100, 1);   // way off
    const pPos = new THREE.Vector3(0, 1, 0);
    const dist = c.getCameraDistance(pPos, 0, 5, 10);
    // The 3m cylinder should be the first hit (entry ~2.25m after radius+padding).
    expect(dist).toBeLessThan(3);
    expect(dist).toBeGreaterThan(1);
  });
});
