/**
 * Collision Fix Tests — covers the four collision improvements:
 * 1. Window collision (building exterior BSP in dungeonCollision)
 * 2. Stair collision (floor detection with increased ranges)
 * 3. Object collision (placement frame composition, collision height)
 * 4. Frame composition correctness
 *
 * Pure math tests — no DAT files required.
 */
import { describe, it, expect } from 'vitest';
import {
  makePlane, posHitsSphere, sphereIntersectsPoly, findFloorHeight,
} from '@ac/shared';
import type {
  PhysicsPolygon, CollisionSphere, CollisionBSPNode,
} from '@ac/shared';
import { DungeonCollision } from '@ac/renderer/world/DungeonCollision.js';

// ── Helpers ────────────────────────────────────────────────────

function makeQuad(
  v0: [number, number, number], v1: [number, number, number],
  v2: [number, number, number], v3: [number, number, number],
): PhysicsPolygon {
  const vertices = [
    { x: v0[0], y: v0[1], z: v0[2] },
    { x: v1[0], y: v1[1], z: v1[2] },
    { x: v2[0], y: v2[1], z: v2[2] },
    { x: v3[0], y: v3[1], z: v3[2] },
  ];
  return { vertices, plane: makePlane(vertices), numPts: 4 };
}

/** Build a simple BSP leaf node with the given polygons. */
function makeLeafBSP(polys: PhysicsPolygon[]): CollisionBSPNode {
  // Compute bounding sphere enclosing all polygons
  let cx = 0, cy = 0, cz = 0, count = 0;
  for (const p of polys) {
    for (const v of p.vertices) { cx += v.x; cy += v.y; cz += v.z; count++; }
  }
  if (count > 0) { cx /= count; cy /= count; cz /= count; }
  let maxR = 0;
  for (const p of polys) {
    for (const v of p.vertices) {
      const dx = v.x - cx, dy = v.y - cy, dz = v.z - cz;
      maxR = Math.max(maxR, Math.sqrt(dx * dx + dy * dy + dz * dz));
    }
  }
  return {
    type: 'LEAF',
    solid: false,
    boundingSphere: { center: { x: cx, y: cy, z: cz }, radius: maxR + 1.0 },
    polygons: polys,
  };
}

// ── Frame Composition Tests ─────────────────────────────────────

describe('DungeonCollision.composeFrames', () => {
  const identity = { w: 1, x: 0, y: 0, z: 0 };
  const origin0 = { x: 0, y: 0, z: 0 };

  it('should return child frame when parent is identity', () => {
    const child = { x: 3, y: 4, z: 5 };
    const childQuat = { w: 0.707, x: 0, y: 0, z: 0.707 }; // ~90° around Z
    const result = DungeonCollision.composeFrames(origin0, identity, child, childQuat);
    expect(result.origin.x).toBeCloseTo(3, 4);
    expect(result.origin.y).toBeCloseTo(4, 4);
    expect(result.origin.z).toBeCloseTo(5, 4);
    expect(result.orientation.w).toBeCloseTo(childQuat.w, 4);
    expect(result.orientation.z).toBeCloseTo(childQuat.z, 4);
  });

  it('should translate child by parent origin when parent has no rotation', () => {
    const parentOrigin = { x: 10, y: 20, z: 30 };
    const child = { x: 1, y: 2, z: 3 };
    const result = DungeonCollision.composeFrames(parentOrigin, identity, child, identity);
    expect(result.origin.x).toBeCloseTo(11, 4);
    expect(result.origin.y).toBeCloseTo(22, 4);
    expect(result.origin.z).toBeCloseTo(33, 4);
  });

  it('should rotate child origin by parent rotation', () => {
    // 90° rotation around Z-axis: (x,y,z) → (-y,x,z)
    const parentQuat = { w: 0.7071067811865476, x: 0, y: 0, z: 0.7071067811865476 };
    const parentOrigin = { x: 10, y: 20, z: 0 };
    const child = { x: 1, y: 0, z: 0 };
    const result = DungeonCollision.composeFrames(parentOrigin, parentQuat, child, identity);
    // Child at (1,0,0) rotated 90° around Z → (0,1,0), then translated by (10,20,0)
    expect(result.origin.x).toBeCloseTo(10, 3);
    expect(result.origin.y).toBeCloseTo(21, 3);
    expect(result.origin.z).toBeCloseTo(0, 3);
  });

  it('should compose quaternion rotations correctly', () => {
    // Two 90° rotations around Z = 180° around Z
    const q90z = { w: 0.7071067811865476, x: 0, y: 0, z: 0.7071067811865476 };
    const result = DungeonCollision.composeFrames(origin0, q90z, origin0, q90z);
    // 180° around Z: w≈0, x=0, y=0, z≈1
    expect(result.orientation.w).toBeCloseTo(0, 3);
    expect(result.orientation.z).toBeCloseTo(1, 3);
  });

  it('should handle non-trivial parent + child composition', () => {
    // Parent: origin (5, 0, 0), 90° around Z
    // Child: origin (2, 0, 0), identity rotation
    // Expected: child rotated by parent → (0, 2, 0) + parent origin → (5, 2, 0)
    const parentQuat = { w: 0.7071067811865476, x: 0, y: 0, z: 0.7071067811865476 };
    const result = DungeonCollision.composeFrames(
      { x: 5, y: 0, z: 0 }, parentQuat,
      { x: 2, y: 0, z: 0 }, identity,
    );
    expect(result.origin.x).toBeCloseTo(5, 3);
    expect(result.origin.y).toBeCloseTo(2, 3);
    expect(result.origin.z).toBeCloseTo(0, 3);
  });
});

// ── Stair Floor Detection Tests ──────────────────────────────────

describe('Floor detection for stairs', () => {
  // Build a simple staircase: 3 steps, each 0.5m tall
  // Step 1: Z=0.5 at X=[0,2]
  // Step 2: Z=1.0 at X=[2,4]
  // Step 3: Z=1.5 at X=[4,6]
  function makeStairBSP(): CollisionBSPNode {
    const step1 = makeQuad([0, -1, 0.5], [2, -1, 0.5], [2, 1, 0.5], [0, 1, 0.5]);
    const step2 = makeQuad([2, -1, 1.0], [4, -1, 1.0], [4, 1, 1.0], [2, 1, 1.0]);
    const step3 = makeQuad([4, -1, 1.5], [6, -1, 1.5], [6, 1, 1.5], [4, 1, 1.5]);
    return makeLeafBSP([step1, step2, step3]);
  }

  it('should find first step at Z=0.5 when starting from ground (Z=0)', () => {
    const bsp = makeStairBSP();
    const floor = findFloorHeight(bsp, 1, 0, 0);
    expect(floor).toBeCloseTo(0.5, 4);
  });

  it('should find second step at Z=1.0 when standing on first step (fromZ=0.5)', () => {
    const bsp = makeStairBSP();
    const floor = findFloorHeight(bsp, 3, 0, 0.5);
    expect(floor).toBeCloseTo(1.0, 4);
  });

  it('should find third step at Z=1.5 when standing on second step (fromZ=1.0)', () => {
    const bsp = makeStairBSP();
    const floor = findFloorHeight(bsp, 5, 0, 1.0);
    expect(floor).toBeCloseTo(1.5, 4);
  });

  it('should find step 1.5m above with increased range (fromZ=0)', () => {
    const bsp = makeStairBSP();
    // The third step is 1.5m above ground — should be found with +2.0 range
    const floor = findFloorHeight(bsp, 5, 0, 0);
    expect(floor).toBeCloseTo(1.5, 4);
  });

  it('should NOT find step 2.5m above (beyond +2.0 range)', () => {
    // Create a very high step
    const highStep = makeQuad([0, -1, 2.5], [2, -1, 2.5], [2, 1, 2.5], [0, 1, 2.5]);
    const bsp = makeLeafBSP([highStep]);
    const floor = findFloorHeight(bsp, 1, 0, 0);
    expect(floor).toBeNull();
  });

  it('should prefer closest step when multiple are in range', () => {
    const bsp = makeStairBSP();
    // From Z=0.8, step1 (0.5) is 0.3 below, step2 (1.0) is 0.2 above → step2 is closer
    const floor = findFloorHeight(bsp, 3, 0, 0.8);
    expect(floor).toBeCloseTo(1.0, 4);
  });

  it('should find floor below when descending stairs (fromZ=1.5)', () => {
    const bsp = makeStairBSP();
    // Standing on step 3 (1.5), moved to X=1 → step 1 at 0.5 is 1.0 below → within -3.0 range
    const floor = findFloorHeight(bsp, 1, 0, 1.5);
    expect(floor).toBeCloseTo(0.5, 4);
  });
});

// ── Collision Height Tests ──────────────────────────────────────

describe('Collision sphere height for furniture', () => {
  // A table: 4 vertical sides from Z=0 to Z=0.8, at X,Y = ±0.5
  function makeTableSideBSP(): CollisionBSPNode {
    // North wall (Y = 0.5, facing +Y) — normal (0, 1, 0) → not walkable
    const north = makeQuad([-0.5, 0.5, 0], [0.5, 0.5, 0], [0.5, 0.5, 0.8], [-0.5, 0.5, 0.8]);
    // South wall (Y = -0.5, facing -Y)
    const south = makeQuad([0.5, -0.5, 0], [-0.5, -0.5, 0], [-0.5, -0.5, 0.8], [0.5, -0.5, 0.8]);
    // East wall (X = 0.5, facing +X)
    const east = makeQuad([0.5, -0.5, 0], [0.5, 0.5, 0], [0.5, 0.5, 0.8], [0.5, -0.5, 0.8]);
    // West wall (X = -0.5, facing -X)
    const west = makeQuad([-0.5, 0.5, 0], [-0.5, -0.5, 0], [-0.5, -0.5, 0.8], [-0.5, 0.5, 0.8]);
    return makeLeafBSP([north, south, east, west]);
  }

  it('should detect table side at body center height (Z=0.67)', () => {
    const tableBSP = makeTableSideBSP();
    // Sphere at (0.8, 0, 0.67) radius 0.4 → extends from X=0.4 to X=1.2
    // East wall at X=0.5, sphere center at 0.8, so dist from plane = 0.3
    // Sphere radius 0.4 > 0.3 → should hit
    const sphere: CollisionSphere = { center: { x: 0.8, y: 0, z: 0.67 }, radius: 0.4 };
    const movement = { x: -0.05, y: 0, z: 0 }; // moving west (into table)
    const hit = sphereIntersectsPoly(tableBSP, sphere, movement);
    expect(hit).not.toBeNull();
  });

  it('should NOT detect table side at eye height (Z=1.8)', () => {
    const tableBSP = makeTableSideBSP();
    // Table sides only go up to Z=0.8
    // Sphere at Z=1.8, radius 0.4 → Z extends 1.4 to 2.2 — no overlap with 0-0.8
    const sphere: CollisionSphere = { center: { x: 0.8, y: 0, z: 1.8 }, radius: 0.4 };
    const movement = { x: -0.05, y: 0, z: 0 };
    const hit = sphereIntersectsPoly(tableBSP, sphere, movement);
    expect(hit).toBeNull();
  });

  it('should detect table side at low height (Z=0.3)', () => {
    const tableBSP = makeTableSideBSP();
    // Sphere at Z=0.3, radius 0.4 → Z extends -0.1 to 0.7 — overlaps 0-0.8
    const sphere: CollisionSphere = { center: { x: 0.8, y: 0, z: 0.3 }, radius: 0.4 };
    const movement = { x: -0.05, y: 0, z: 0 };
    const hit = sphereIntersectsPoly(tableBSP, sphere, movement);
    expect(hit).not.toBeNull();
  });

  it('should skip walkable (horizontal) table top surface', () => {
    // Table top is horizontal → normal.z ≈ 1.0 → walkable → should NOT block movement
    const tableTop = makeQuad([-0.5, -0.5, 0.8], [0.5, -0.5, 0.8], [0.5, 0.5, 0.8], [-0.5, 0.5, 0.8]);
    const bsp = makeLeafBSP([tableTop]);
    const sphere: CollisionSphere = { center: { x: 0, y: 0, z: 0.67 }, radius: 0.4 };
    const movement = { x: 0.05, y: 0, z: 0 };
    const hit = sphereIntersectsPoly(bsp, sphere, movement);
    expect(hit).toBeNull(); // walkable surface should be skipped
  });

  it('should detect wall at all heights (walls span 0 to 3m)', () => {
    // Full-height wall
    const wall = makeQuad([0, -2, 0], [0, 2, 0], [0, 2, 3], [0, -2, 3]);
    const bsp = makeLeafBSP([wall]);
    // Test at body center (0.67)
    const hitLow: CollisionSphere = { center: { x: 0.3, y: 0, z: 0.67 }, radius: 0.4 };
    expect(sphereIntersectsPoly(bsp, hitLow, { x: -0.05, y: 0, z: 0 })).not.toBeNull();
    // Test at eye height (1.8) — wall still goes up to 3m
    const hitHigh: CollisionSphere = { center: { x: 0.3, y: 0, z: 1.8 }, radius: 0.4 };
    expect(sphereIntersectsPoly(bsp, hitHigh, { x: -0.05, y: 0, z: 0 })).not.toBeNull();
  });
});

// ── Window Collision (BSP data availability) ────────────────────

describe('Building exterior BSP for window collision', () => {
  it('should detect collision with building shell polygon at body height', () => {
    // Simulate a building exterior wall with a window opening
    // The window frame is solid, the center is open (portal polygon with stippling 0x04)
    // Only the solid frame should block movement
    const windowFrame = makeQuad([0, -2, 0], [0, 2, 0], [0, 2, 1.5], [0, -2, 1.5]);
    const bsp = makeLeafBSP([windowFrame]);
    // Player inside approaching window at body height
    const sphere: CollisionSphere = { center: { x: 0.3, y: 0, z: 0.67 }, radius: 0.4 };
    const movement = { x: -0.05, y: 0, z: 0 }; // moving toward window
    const hit = sphereIntersectsPoly(bsp, sphere, movement);
    expect(hit).not.toBeNull();
  });
});

// ── Multi-step stair climbing simulation ─────────────────────────

describe('Incremental stair climbing simulation', () => {
  function makeStairBSP(): CollisionBSPNode {
    const steps: PhysicsPolygon[] = [];
    for (let i = 0; i < 10; i++) {
      const z = (i + 1) * 0.3; // Each step is 0.3m
      const x0 = i * 1.0;
      const x1 = (i + 1) * 1.0;
      steps.push(makeQuad([x0, -1, z], [x1, -1, z], [x1, 1, z], [x0, 1, z]));
    }
    return makeLeafBSP(steps);
  }

  it('should climb 10 steps incrementally using tracking reference height', () => {
    const bsp = makeStairBSP();
    let currentFloor = 0; // Start at ground level

    for (let step = 0; step < 10; step++) {
      const playerX = step * 1.0 + 0.5; // Center of each step
      const floor = findFloorHeight(bsp, playerX, 0, currentFloor);
      expect(floor).not.toBeNull();
      const expectedZ = (step + 1) * 0.3;
      expect(floor).toBeCloseTo(expectedZ, 3);
      currentFloor = floor!; // Update reference for next iteration
    }
  });

  it('should descend stairs incrementally', () => {
    const bsp = makeStairBSP();
    let currentFloor = 3.0; // Start at top (step 10)

    for (let step = 9; step >= 0; step--) {
      const playerX = step * 1.0 + 0.5;
      const floor = findFloorHeight(bsp, playerX, 0, currentFloor);
      expect(floor).not.toBeNull();
      const expectedZ = (step + 1) * 0.3;
      expect(floor).toBeCloseTo(expectedZ, 3);
      currentFloor = floor!;
    }
  });
});
