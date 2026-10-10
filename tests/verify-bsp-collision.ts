/**
 * BSP Collision Detection Unit Tests
 *
 * Tests the sphere-BSP collision algorithms ported from ACE C# source.
 * Pure math tests — no DAT files required.
 */
import { describe, it, expect } from 'vitest';
import {
  makePlane, polygonHitsSpherePrecise, posHitsSphere,
  sphereIntersectsPoly, sphereIntersectsSolid, findFloorHeight,
  buildCollisionBSP,
} from '@ac/shared';
import type {
  PhysicsPolygon, CollisionSphere, CollisionBSPNode,
} from '@ac/shared';

// ── Helper: make a quad polygon from 4 vertices ─────────────

function makeQuad(v0: [number, number, number], v1: [number, number, number],
                  v2: [number, number, number], v3: [number, number, number]): PhysicsPolygon {
  const vertices = [
    { x: v0[0], y: v0[1], z: v0[2] },
    { x: v1[0], y: v1[1], z: v1[2] },
    { x: v2[0], y: v2[1], z: v2[2] },
    { x: v3[0], y: v3[1], z: v3[2] },
  ];
  return { vertices, plane: makePlane(vertices), numPts: 4 };
}

function makeTri(v0: [number, number, number], v1: [number, number, number],
                 v2: [number, number, number]): PhysicsPolygon {
  const vertices = [
    { x: v0[0], y: v0[1], z: v0[2] },
    { x: v1[0], y: v1[1], z: v1[2] },
    { x: v2[0], y: v2[1], z: v2[2] },
  ];
  return { vertices, plane: makePlane(vertices), numPts: 3 };
}

// ── makePlane tests ─────────────────────────────────────────

describe('makePlane', () => {
  it('should compute correct normal for XY-plane triangle (Z-up)', () => {
    const verts = [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
    ];
    const plane = makePlane(verts);
    // Normal should point in Z direction (up)
    expect(Math.abs(plane.normal.z)).toBeCloseTo(1, 4);
    expect(Math.abs(plane.normal.x)).toBeCloseTo(0, 4);
    expect(Math.abs(plane.normal.y)).toBeCloseTo(0, 4);
  });

  it('should compute correct normal for XZ-plane triangle (wall)', () => {
    const verts = [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 0, z: 1 },
    ];
    const plane = makePlane(verts);
    // Normal should point in -Y direction
    expect(Math.abs(plane.normal.y)).toBeCloseTo(1, 4);
    expect(Math.abs(plane.normal.x)).toBeCloseTo(0, 4);
    expect(Math.abs(plane.normal.z)).toBeCloseTo(0, 4);
  });

  it('should satisfy dot(normal, vertex) + distance ≈ 0 for all vertices', () => {
    // This is the KEY sign convention test
    const verts = [
      { x: 3, y: 1, z: 5 },
      { x: 7, y: 2, z: 5 },
      { x: 5, y: 8, z: 5 },
      { x: 2, y: 6, z: 5 },
    ];
    const plane = makePlane(verts);
    for (const v of verts) {
      const d = plane.normal.x * v.x + plane.normal.y * v.y + plane.normal.z * v.z + plane.distance;
      expect(d).toBeCloseTo(0, 4);
    }
  });

  it('should handle a quad polygon correctly', () => {
    const verts = [
      { x: 0, y: 0, z: 10 },
      { x: 10, y: 0, z: 10 },
      { x: 10, y: 10, z: 10 },
      { x: 0, y: 10, z: 10 },
    ];
    const plane = makePlane(verts);
    // Z=10 plane, normal should be (0,0,1) or (0,0,-1)
    expect(Math.abs(plane.normal.z)).toBeCloseTo(1, 4);
    // Distance should be -10 or 10 depending on normal direction
    // Check: dot(normal, vertex) + distance = 0
    const d = plane.normal.z * 10 + plane.distance;
    expect(d).toBeCloseTo(0, 4);
  });
});

// ── polygonHitsSpherePrecise tests ──────────────────────────

describe('polygonHitsSpherePrecise', () => {
  it('should detect sphere intersecting polygon center', () => {
    // Floor polygon at Z=0
    const floor = makeQuad([0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]);
    const sphere: CollisionSphere = { center: { x: 5, y: 5, z: 0.3 }, radius: 0.5 };
    const result = polygonHitsSpherePrecise(floor, sphere);
    expect(result.hit).toBe(true);
  });

  it('should miss when sphere is far from polygon plane', () => {
    const floor = makeQuad([0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]);
    const sphere: CollisionSphere = { center: { x: 5, y: 5, z: 5 }, radius: 0.5 };
    const result = polygonHitsSpherePrecise(floor, sphere);
    expect(result.hit).toBe(false);
  });

  it('should miss when sphere projection is outside polygon', () => {
    const floor = makeQuad([0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]);
    const sphere: CollisionSphere = { center: { x: 20, y: 20, z: 0.1 }, radius: 0.5 };
    const result = polygonHitsSpherePrecise(floor, sphere);
    expect(result.hit).toBe(false);
  });

  it('should detect sphere touching polygon edge', () => {
    const floor = makeQuad([0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]);
    // Sphere center just outside edge but within radius
    const sphere: CollisionSphere = { center: { x: -0.2, y: 5, z: 0 }, radius: 0.5 };
    const result = polygonHitsSpherePrecise(floor, sphere);
    expect(result.hit).toBe(true);
  });

  it('should detect sphere on a wall polygon (vertical)', () => {
    // Wall at Y=5, facing -Y
    const wall = makeQuad([0, 5, 0], [10, 5, 0], [10, 5, 3], [0, 5, 3]);
    const sphere: CollisionSphere = { center: { x: 5, y: 5.2, z: 1.5 }, radius: 0.4 };
    const result = polygonHitsSpherePrecise(wall, sphere);
    expect(result.hit).toBe(true);
  });
});

// ── posHitsSphere tests (movement-aware) ────────────────────

describe('posHitsSphere', () => {
  it('should hit when moving INTO wall', () => {
    // Wall at Y=5
    const wall = makeQuad([0, 5, 0], [10, 5, 0], [10, 5, 3], [0, 5, 3]);
    const sphere: CollisionSphere = { center: { x: 5, y: 5.2, z: 1.5 }, radius: 0.4 };
    const movement = { x: 0, y: 1, z: 0 }; // moving in +Y (into wall)
    const result = posHitsSphere(wall, sphere, movement);
    // Whether this hits depends on the wall normal direction
    // Wall normal should be perpendicular to YZ edges, pointing in ±Y
    if (wall.plane.normal.y < 0) {
      // Normal points -Y, movement is +Y → dot(movement, normal) < 0 → should hit
      expect(result).not.toBeNull();
    } else {
      // Normal points +Y, movement is +Y → dot(movement, normal) > 0 → backface, no hit
      // Try moving in -Y instead
      const result2 = posHitsSphere(wall, sphere, { x: 0, y: -1, z: 0 });
      expect(result2).not.toBeNull();
    }
  });

  it('should NOT hit when moving AWAY from wall', () => {
    const wall = makeQuad([0, 5, 0], [10, 5, 0], [10, 5, 3], [0, 5, 3]);
    const sphere: CollisionSphere = { center: { x: 5, y: 5.2, z: 1.5 }, radius: 0.4 };
    // Determine wall normal direction, then move AWAY
    const awayDir = { x: 0, y: wall.plane.normal.y > 0 ? 1 : -1, z: 0 };
    const result = posHitsSphere(wall, sphere, awayDir);
    expect(result).toBeNull();
  });

  it('should NOT hit when sphere is far from polygon', () => {
    const wall = makeQuad([0, 5, 0], [10, 5, 0], [10, 5, 3], [0, 5, 3]);
    const sphere: CollisionSphere = { center: { x: 5, y: 10, z: 1.5 }, radius: 0.4 };
    const result = posHitsSphere(wall, sphere, { x: 0, y: -1, z: 0 });
    expect(result).toBeNull();
  });
});

// ── BSP tree traversal tests ────────────────────────────────

describe('sphereIntersectsPoly', () => {
  it('should find hit in a single-leaf BSP with one polygon', () => {
    const wall = makeQuad([0, 5, 0], [10, 5, 0], [10, 5, 3], [0, 5, 3]);
    const leaf: CollisionBSPNode = {
      type: 'LEAF',
      polygons: [wall],
    };
    const sphere: CollisionSphere = { center: { x: 5, y: 5.2, z: 1.5 }, radius: 0.4 };
    // Move toward the wall (determine correct direction from normal)
    const movement = { x: 0, y: -wall.plane.normal.y, z: 0 };
    const hit = sphereIntersectsPoly(leaf, sphere, movement);
    expect(hit).not.toBeNull();
    expect(hit!.polygon).toBe(wall);
  });

  it('should return null when sphere misses all polygons', () => {
    const wall = makeQuad([0, 5, 0], [10, 5, 0], [10, 5, 3], [0, 5, 3]);
    const leaf: CollisionBSPNode = {
      type: 'LEAF',
      polygons: [wall],
    };
    const sphere: CollisionSphere = { center: { x: 5, y: 20, z: 1.5 }, radius: 0.4 };
    const hit = sphereIntersectsPoly(leaf, sphere, { x: 0, y: 1, z: 0 });
    expect(hit).toBeNull();
  });

  it('should traverse internal nodes using splitting plane', () => {
    // Create a simple 2-node BSP: splitting plane at Y=5
    // Positive side has a wall at Y=8, negative side has a wall at Y=2
    const wallPos = makeQuad([0, 8, 0], [10, 8, 0], [10, 8, 3], [0, 8, 3]);
    const wallNeg = makeQuad([0, 2, 0], [10, 2, 0], [10, 2, 3], [0, 2, 3]);

    const bsp: CollisionBSPNode = {
      type: 'BPnN',
      splittingPlane: { normal: { x: 0, y: 1, z: 0 }, distance: -5 },
      posNode: { type: 'LEAF', polygons: [wallPos] },
      negNode: { type: 'LEAF', polygons: [wallNeg] },
    };

    // Sphere near Y=8 wall, moving toward it
    const sphere: CollisionSphere = { center: { x: 5, y: 7.7, z: 1.5 }, radius: 0.4 };
    const hit = sphereIntersectsPoly(bsp, sphere, { x: 0, y: -wallPos.plane.normal.y, z: 0 });
    expect(hit).not.toBeNull();
    expect(hit!.polygon).toBe(wallPos);

    // Sphere near Y=2 wall
    const sphere2: CollisionSphere = { center: { x: 5, y: 2.3, z: 1.5 }, radius: 0.4 };
    const hit2 = sphereIntersectsPoly(bsp, sphere2, { x: 0, y: -wallNeg.plane.normal.y, z: 0 });
    expect(hit2).not.toBeNull();
    expect(hit2!.polygon).toBe(wallNeg);
  });

  it('should early-reject via bounding sphere', () => {
    const wall = makeQuad([0, 5, 0], [10, 5, 0], [10, 5, 3], [0, 5, 3]);
    const leaf: CollisionBSPNode = {
      type: 'LEAF',
      boundingSphere: { center: { x: 5, y: 5, z: 1.5 }, radius: 8 },
      polygons: [wall],
    };

    // Sphere far outside bounding sphere
    const sphere: CollisionSphere = { center: { x: 100, y: 100, z: 100 }, radius: 0.4 };
    const hit = sphereIntersectsPoly(leaf, sphere, { x: 0, y: -1, z: 0 });
    expect(hit).toBeNull();
  });
});

// ── sphereIntersectsSolid tests ─────────────────────────────

describe('sphereIntersectsSolid', () => {
  it('should detect sphere in solid leaf', () => {
    const solidLeaf: CollisionBSPNode = {
      type: 'LEAF',
      solid: true,
    };
    const sphere: CollisionSphere = { center: { x: 0, y: 0, z: 0 }, radius: 0.4 };
    expect(sphereIntersectsSolid(solidLeaf, sphere)).toBe(true);
  });

  it('should not detect sphere in non-solid leaf', () => {
    const emptyLeaf: CollisionBSPNode = {
      type: 'LEAF',
      solid: false,
    };
    const sphere: CollisionSphere = { center: { x: 0, y: 0, z: 0 }, radius: 0.4 };
    expect(sphereIntersectsSolid(emptyLeaf, sphere)).toBe(false);
  });
});

// ── findFloorHeight tests ───────────────────────────────────

describe('findFloorHeight', () => {
  it('should find floor height from walkable polygon', () => {
    // Floor polygon at Z=10 (upward facing in AC Z-up)
    const floor = makeQuad([0, 0, 10], [20, 0, 10], [20, 20, 10], [0, 20, 10]);
    const leaf: CollisionBSPNode = {
      type: 'LEAF',
      polygons: [floor],
    };
    // Query at center of the floor
    const height = findFloorHeight(leaf, 10, 10, 10);
    expect(height).not.toBeNull();
    expect(height!).toBeCloseTo(10, 1);
  });

  it('should return null when no walkable polygon at position', () => {
    const floor = makeQuad([0, 0, 10], [5, 0, 10], [5, 5, 10], [0, 5, 10]);
    const leaf: CollisionBSPNode = {
      type: 'LEAF',
      polygons: [floor],
    };
    // Query outside the polygon
    const height = findFloorHeight(leaf, 50, 50, 10);
    expect(height).toBeNull();
  });

  it('should ignore vertical (wall) polygons for floor detection', () => {
    // Wall polygon (vertical, Z-normal ≈ 0)
    const wall = makeQuad([5, 0, 0], [5, 10, 0], [5, 10, 5], [5, 0, 5]);
    const leaf: CollisionBSPNode = {
      type: 'LEAF',
      polygons: [wall],
    };
    const height = findFloorHeight(leaf, 5, 5, 2);
    expect(height).toBeNull();
  });
});

// ── Wall sliding math test ──────────────────────────────────

describe('Wall Sliding', () => {
  it('should project movement onto wall tangent plane', () => {
    // Wall normal pointing in +Y direction
    const wallNormal = { x: 0, y: 1, z: 0 };
    const movement = { x: 3, y: 4, z: 0 }; // diagonal into wall

    // Slide = movement - dot(movement, normal) * normal
    const dotMN = movement.x * wallNormal.x + movement.y * wallNormal.y + movement.z * wallNormal.z;
    const slideX = movement.x - dotMN * wallNormal.x;
    const slideY = movement.y - dotMN * wallNormal.y;
    const slideZ = movement.z - dotMN * wallNormal.z;

    // Should remove the Y component (into wall) and keep X (along wall)
    expect(slideX).toBeCloseTo(3, 4);
    expect(slideY).toBeCloseTo(0, 4);
    expect(slideZ).toBeCloseTo(0, 4);
  });

  it('should handle 45-degree wall correctly', () => {
    const n = 1 / Math.sqrt(2);
    const wallNormal = { x: n, y: n, z: 0 };
    const movement = { x: 1, y: 0, z: 0 }; // moving in +X

    const dotMN = movement.x * wallNormal.x + movement.y * wallNormal.y;
    const slideX = movement.x - dotMN * wallNormal.x;
    const slideY = movement.y - dotMN * wallNormal.y;

    // Should slide at 45 degrees along the wall
    expect(slideX).toBeCloseTo(0.5, 4);
    expect(slideY).toBeCloseTo(-0.5, 4);
  });

  it('should produce zero movement when hitting wall head-on', () => {
    const wallNormal = { x: 1, y: 0, z: 0 };
    const movement = { x: -1, y: 0, z: 0 }; // moving directly into wall

    const dotMN = movement.x * wallNormal.x;
    const slideX = movement.x - dotMN * wallNormal.x;
    const slideY = movement.y - dotMN * wallNormal.y;

    expect(slideX).toBeCloseTo(0, 4);
    expect(slideY).toBeCloseTo(0, 4);
  });

  it('should handle corner with two perpendicular walls', () => {
    // First wall: normal +Y
    const normal1 = { x: 0, y: 1, z: 0 };
    // Second wall: normal +X
    const normal2 = { x: 1, y: 0, z: 0 };
    // Moving diagonally into corner
    const movement = { x: -1, y: -1, z: 0 };

    // First slide against wall 1
    const dot1 = movement.x * normal1.x + movement.y * normal1.y;
    let slideX = movement.x - dot1 * normal1.x;
    let slideY = movement.y - dot1 * normal1.y;
    // After first slide: (-1, 0)

    // Second slide against wall 2
    const dot2 = slideX * normal2.x + slideY * normal2.y;
    slideX -= dot2 * normal2.x;
    slideY -= dot2 * normal2.y;
    // After second slide: (0, 0) — stuck in corner, correct behavior

    expect(slideX).toBeCloseTo(0, 4);
    expect(slideY).toBeCloseTo(0, 4);
  });
});
