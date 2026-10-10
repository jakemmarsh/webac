/**
 * Collision Improvement Tests — covers the four remaining collision fixes:
 * 1. Outdoor static object collision (BSP registration + cleanup)
 * 2. NPC/creature cylinder collision (push-out logic)
 * 3. Indoor stair step-up (elevated sphere retry)
 * 4. Ground clipping fixes (terrain clamping)
 *
 * Pure math tests — no DAT files required.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  makePlane, posHitsSphere, sphereIntersectsPoly, findFloorHeight,
} from '@ac/shared';
import type {
  PhysicsPolygon, CollisionSphere, CollisionBSPNode,
} from '@ac/shared';
import { DungeonCollision } from '@ac/renderer/world/DungeonCollision.js';
import { openDat } from './_harness/dat.js';

const REPO = resolve(__dirname, '..');
const PORTAL = resolve(REPO, 'dat/client_portal.dat');

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

/** Create a mock GfxObj with physics BSP for testing. */
function makeMockGfxObj(polys: PhysicsPolygon[]) {
  // Build a minimal GfxObj-like object with physics data
  const physicsPolygons = new Map<number, any>();
  const vertices = new Map<number, any>();
  let vidx = 0;

  for (let pi = 0; pi < polys.length; pi++) {
    const poly = polys[pi];
    const vertexIndices: number[] = [];
    for (const v of poly.vertices) {
      vertices.set(vidx, { origin: v, normal: { x: 0, y: 0, z: 1 }, uvs: [] });
      vertexIndices.push(vidx);
      vidx++;
    }
    physicsPolygons.set(pi, {
      vertexIndices,
      numVertices: poly.vertices.length,
      stippling: 0,
      sidesType: 0,
      portalIndex: -1,
      polyId: pi,
    });
  }

  // Build BSP root node with inline polygons
  const bspNode = {
    type: 'LEAF' as const,
    solid: 0,
    sphere: {
      origin: { x: 0, y: 0, z: 0 },
      radius: 100,
    },
    inPolys: Array.from(physicsPolygons.keys()),
  };

  return {
    physicsBSP: { rootNode: bspNode },
    physicsPolygons,
    vertexArray: { vertices },
  } as any;
}

// Helper: make a wall facing -X (toward player approaching from -X side).
// Vertices wound so cross product yields normal (-1, 0, 0).
function makeWallFacingNegX(x: number, yMin: number, yMax: number, zMin: number, zMax: number): PhysicsPolygon {
  return makeQuad(
    [x, yMax, zMin], [x, yMin, zMin],
    [x, yMin, zMax], [x, yMax, zMax],
  );
}

// ── Step-Up Collision Tests ───────────────────────────────────────

describe('Step-up collision (stair climbing)', () => {
  // A low step riser: vertical wall from Z=0 to Z=0.3, at X=2
  // facing -X direction (blocks movement in +X)
  function makeStepRiserBSP(): CollisionBSPNode {
    const riser = makeQuad(
      [2, -1, 0], [2, 1, 0],
      [2, 1, 0.3], [2, -1, 0.3],
    );
    return makeLeafBSP([riser]);
  }

  // A tall wall from Z=0 to Z=2.0
  function makeTallWallBSP(): CollisionBSPNode {
    const wall = makeQuad(
      [2, -1, 0], [2, 1, 0],
      [2, 1, 2.0], [2, -1, 2.0],
    );
    return makeLeafBSP([wall]);
  }

  it('should allow movement over a low step via step-up', () => {
    const dc = new DungeonCollision();
    // Step riser at X=2, Z=0-0.3, facing -X, with its walkable tread (the
    // step up lands on a walkable: RECON.transition-stepup-stepdown-port.c.a)
    const tread = makeQuad([2, -1, 0.3], [3, -1, 0.3], [3, 1, 0.3], [2, 1, 0.3]);
    const gfx = makeMockGfxObj([makeWallFacingNegX(2, -1, 1, 0, 0.3), tread]);
    dc.addGfxObjCollision(1, gfx, { x: 0, y: 0, z: 0 }, { w: 1, x: 0, y: 0, z: 0 }, 0, 0);

    // Player at floor Y=0 (1.5, 0, 0), moving +X toward the step — the two
    // DAT body spheres (LOWER_SPHERE_HEIGHT/UPPER_SPHERE_HEIGHT) are tested
    // stacked above this floor reference, not a single guessed point.
    const pos = new THREE.Vector3(1.5, 0, 0);
    const [adjX, adjZ] = dc.getAdjustedMovement(pos, 0.5, 0);

    // Step-up should allow the movement (0.3m step < 0.6m step-up height)
    expect(adjX).toBeCloseTo(0.5, 1);
    expect(adjZ).toBeCloseTo(0, 4);
  });

  it('should block movement at a tall wall (no step-up)', () => {
    const dc = new DungeonCollision();
    // Tall wall at X=2, Z=0-2.0, facing -X
    const gfx = makeMockGfxObj([makeWallFacingNegX(2, -1, 1, 0, 2.0)]);
    dc.addGfxObjCollision(1, gfx, { x: 0, y: 0, z: 0 }, { w: 1, x: 0, y: 0, z: 0 }, 0, 0);

    const pos = new THREE.Vector3(1.5, 0, 0);
    const [adjX] = dc.getAdjustedMovement(pos, 0.5, 0);

    // Tall wall blocks even with step-up attempt (2.0m >> 0.6m step-up)
    expect(Math.abs(adjX)).toBeLessThan(0.1);
  });

  it('should step-up with ramp behind step riser', () => {
    const dc = new DungeonCollision();
    // Step riser at X=2, Z=0-0.3, facing -X
    const riser = makeWallFacingNegX(2, -1, 1, 0, 0.3);
    // Ramp from Z=0.3 at X=2 to Z=0.5 at X=4 (walkable surface — normal.z > 0)
    const ramp = makeQuad([2, -1, 0.3], [4, -1, 0.5], [4, 1, 0.5], [2, 1, 0.3]);
    const gfx = makeMockGfxObj([riser, ramp]);
    dc.addGfxObjCollision(1, gfx, { x: 0, y: 0, z: 0 }, { w: 1, x: 0, y: 0, z: 0 }, 0, 0);

    const pos = new THREE.Vector3(1.5, 0, 0);
    const [adjX] = dc.getAdjustedMovement(pos, 0.5, 0);

    // Should allow movement (step-up clears the riser, ramp is walkable)
    expect(adjX).toBeCloseTo(0.5, 1);
  });

  it('should step-up on wall-slide direction', () => {
    const dc = new DungeonCollision();
    // Diagonal step facing toward the player's approach direction
    const step = makeQuad(
      [3, 1, 0], [2, 0, 0],
      [2, 0, 0.3], [3, 1, 0.3],
    );
    const gfx = makeMockGfxObj([step]);
    dc.addGfxObjCollision(1, gfx, { x: 0, y: 0, z: 0 }, { w: 1, x: 0, y: 0, z: 0 }, 0, 0);

    // Moving diagonally into the step
    const pos = new THREE.Vector3(1.5, 0, 0);
    const [adjX, adjZ] = dc.getAdjustedMovement(pos, 0.5, 0.5);

    // Should get some movement (either direct step-up or slide+step-up)
    const totalMove = Math.sqrt(adjX * adjX + adjZ * adjZ);
    expect(totalMove).toBeGreaterThan(0.01);
  });

  it('should not step-up through ceiling wall', () => {
    const dc = new DungeonCollision();
    // Step riser at X=2, Z=0-0.3, facing -X
    const riser = makeWallFacingNegX(2, -1, 1, 0, 0.3);
    // Wall at X=2 covering the elevated zone (Z=0.8-1.4, facing -X). At
    // floor Y=0, elevated pos.y=STEP_UP_HEIGHT=0.6 — elevated lower sphere
    // center=1.075 (range 0.595-1.555) overlaps this wall's Z=0.8-1.4.
    const ceilingWall = makeWallFacingNegX(2, -2, 2, 0.8, 1.4);
    const gfx = makeMockGfxObj([riser, ceilingWall]);
    dc.addGfxObjCollision(1, gfx, { x: 0, y: 0, z: 0 }, { w: 1, x: 0, y: 0, z: 0 }, 0, 0);

    const pos = new THREE.Vector3(1.5, 0, 0);
    const [adjX] = dc.getAdjustedMovement(pos, 0.5, 0);

    // Should NOT step up — the elevated sphere hits the ceiling wall
    expect(Math.abs(adjX)).toBeLessThan(0.1);
  });

  it('step-up + floor detection pipeline finds elevated floor', () => {
    const dc = new DungeonCollision();
    // Floor at Z=0, step riser at X=2 (Z=0-0.3, facing -X), elevated floor at Z=0.3
    const floor0 = makeQuad([-1, -1, 0], [2, -1, 0], [2, 1, 0], [-1, 1, 0]);
    const riser = makeWallFacingNegX(2, -1, 1, 0, 0.3);
    const floor1 = makeQuad([2, -1, 0.3], [5, -1, 0.3], [5, 1, 0.3], [2, 1, 0.3]);
    const gfx = makeMockGfxObj([floor0, riser, floor1]);
    dc.addGfxObjCollision(1, gfx, { x: 0, y: 0, z: 0 }, { w: 1, x: 0, y: 0, z: 0 }, 0, 0);

    // Step 1: Movement — player at X=1.5, moving +X past the step
    const pos = new THREE.Vector3(1.5, 0, 0);
    const [adjX] = dc.getAdjustedMovement(pos, 1.0, 0);

    // Step-up should allow movement
    expect(adjX).toBeCloseTo(1.0, 1);

    // Step 2: Floor detection at new position (X=2.5)
    const floorY = dc.getFloorHeight(2.5, 0, 0);
    expect(floorY).toBeCloseTo(0.3, 2);
  });

  it('should set lastStepUp flag when step-up resolves a wall hit', () => {
    const dc = new DungeonCollision();
    const tread = makeQuad([2, -1, 0.3], [3, -1, 0.3], [3, 1, 0.3], [2, 1, 0.3]);
    const gfx = makeMockGfxObj([makeWallFacingNegX(2, -1, 1, 0, 0.3), tread]);
    dc.addGfxObjCollision(1, gfx, { x: 0, y: 0, z: 0 }, { w: 1, x: 0, y: 0, z: 0 }, 0, 0);

    const pos = new THREE.Vector3(1.5, 0, 0);
    // No-hit movement — lastStepUp should remain 0
    dc.getAdjustedMovement(pos, 0, 0);
    expect(dc.lastStepUp).toBe(0);

    // Step-up movement — lastStepUp is the real lift onto the 0.3 m tread
    dc.getAdjustedMovement(pos, 0.5, 0);
    expect(dc.lastStepUp).toBeCloseTo(0.3, 1);
  });

  it('should NOT get stuck at first step when foundation extends under stairs', () => {
    // This is the real AC case that breaks naive step-up: the basement
    // foundation slab continues under the staircase, so every XZ along the
    // stairs has BOTH the foundation floor AND the step floor. findFloorHeight
    // picks "closest to fromY" — at fromY=0 the basement (0) is closer than
    // step 1 (0.3), so without a step-up bias the player gets stuck.
    const dc = new DungeonCollision();
    // Foundation slab Z=0 extending from X=-1 to X=10 (under the whole stairs)
    const foundation = makeQuad([-1, -2, 0], [10, -2, 0], [10, 2, 0], [-1, 2, 0]);
    // Step 1 riser + tread at Z=0.3
    const riser1 = makeWallFacingNegX(2, -2, 2, 0, 0.3);
    const tread1 = makeQuad([2, -2, 0.3], [3, -2, 0.3], [3, 2, 0.3], [2, 2, 0.3]);
    const gfx = makeMockGfxObj([foundation, riser1, tread1]);
    dc.addGfxObjCollision(1, gfx, { x: 0, y: 0, z: 0 }, { w: 1, x: 0, y: 0, z: 0 }, 0, 0);

    // Player sphere at X=1.5 moving 0.5m in +X toward the step riser at X=2.
    // Delta chosen so the destination sphere (center X=2.0, radius 0.4) actually
    // overlaps the short 0.3m riser — larger deltas would skip past it entirely.
    const pos = new THREE.Vector3(1.5, 0, 0);
    const [adjX] = dc.getAdjustedMovement(pos, 0.5, 0);
    expect(adjX).toBeCloseTo(0.5, 1);
    expect(dc.lastStepUp).toBeGreaterThan(0);

    // With the stair-aware floor preference (prefer highest walkable within
    // STEP_UP_HEIGHT above fromY), plain getFloorHeight at the new XZ picks
    // the elevated tread (0.3) rather than the foundation (0). Before this
    // fix the player got stuck on step 1 forever — naive "closest to fromY"
    // kept returning 0 even after step-up said the move was legal.
    const floor = dc.getFloorHeight(2.5, 0, 0);
    expect(floor).toBeCloseTo(0.3, 2);

    // A higher fromY (player already on the step) still returns the tread.
    const floorFromStep = dc.getFloorHeight(2.5, 0, 0.3);
    expect(floorFromStep).toBeCloseTo(0.3, 2);
  });

  it('should pick lower floor when descending (no preference inversion)', () => {
    // Player at Y=0.3 (on top of step) moves off the edge → only foundation
    // at Y=0 is under new XZ. Must return 0, not stay stuck at 0.3.
    const dc = new DungeonCollision();
    const foundation = makeQuad([-1, -2, 0], [10, -2, 0], [10, 2, 0], [-1, 2, 0]);
    const tread = makeQuad([0, -2, 0.3], [1.5, -2, 0.3], [1.5, 2, 0.3], [0, 2, 0.3]);
    const gfx = makeMockGfxObj([foundation, tread]);
    dc.addGfxObjCollision(1, gfx, { x: 0, y: 0, z: 0 }, { w: 1, x: 0, y: 0, z: 0 }, 0, 0);

    // Off the tread edge (X=3) — only foundation under here
    expect(dc.getFloorHeight(3, 0, 0.3)).toBeCloseTo(0, 2);
    // On the tread (X=0.5) — tread wins because it's within step reach above fromY=0
    expect(dc.getFloorHeight(0.5, 0, 0)).toBeCloseTo(0.3, 2);
  });
});

// ── Outdoor Object Collision Tests ────────────────────────────────

describe('Outdoor static object collision', () => {
  it('should block movement through registered GfxObj BSP', () => {
    const dc = new DungeonCollision();
    // Wall at X=3 facing -X (toward player)
    const wall = makeQuad([3, 2, 0], [3, -2, 0], [3, -2, 2], [3, 2, 2]);
    const gfx = makeMockGfxObj([wall]);
    dc.addGfxObjCollision(100, gfx, { x: 0, y: 0, z: 0 }, { w: 1, x: 0, y: 0, z: 0 }, 0, 0);

    // Player near the wall: dest at X=2.9+0.3=3.2, sphere radius 0.4 → overlaps wall at X=3
    const pos = new THREE.Vector3(2.9, 1.0, 0);
    const [adjX] = dc.getAdjustedMovement(pos, 0.3, 0);

    // Should be blocked (wall-slide along Y only, no X movement)
    expect(Math.abs(adjX)).toBeLessThan(0.1);
  });

  it('should not block after BSP entry is removed', () => {
    const dc = new DungeonCollision();
    const wall = makeQuad([3, 2, 0], [3, -2, 0], [3, -2, 2], [3, 2, 2]);
    const gfx = makeMockGfxObj([wall]);
    dc.addGfxObjCollision(100, gfx, { x: 0, y: 0, z: 0 }, { w: 1, x: 0, y: 0, z: 0 }, 0, 0);

    // Remove the entry
    dc.removeCell(100);

    const pos = new THREE.Vector3(2.9, 1.0, 0);
    const [adjX] = dc.getAdjustedMovement(pos, 0.3, 0);

    // Should pass through — no collision
    expect(adjX).toBeCloseTo(0.3, 4);
  });

  it('should handle multiple objects with independent keys', () => {
    const dc = new DungeonCollision();
    // Wall A at X=3, facing -X
    const wallA = makeQuad([3, 2, 0], [3, -2, 0], [3, -2, 2], [3, 2, 2]);
    const gfxA = makeMockGfxObj([wallA]);
    dc.addGfxObjCollision(100, gfxA, { x: 0, y: 0, z: 0 }, { w: 1, x: 0, y: 0, z: 0 }, 0, 0);

    // Wall B at X=10, facing -X
    const wallB = makeQuad([10, 2, 0], [10, -2, 0], [10, -2, 2], [10, 2, 2]);
    const gfxB = makeMockGfxObj([wallB]);
    dc.addGfxObjCollision(200, gfxB, { x: 0, y: 0, z: 0 }, { w: 1, x: 0, y: 0, z: 0 }, 0, 0);

    // Remove wall A
    dc.removeCell(100);

    // Wall A should be gone
    const posA = new THREE.Vector3(2.9, 1.0, 0);
    const [adjXA] = dc.getAdjustedMovement(posA, 0.3, 0);
    expect(adjXA).toBeCloseTo(0.3, 4);

    // Wall B should still block
    const posB = new THREE.Vector3(9.9, 1.0, 0);
    const [adjXB] = dc.getAdjustedMovement(posB, 0.3, 0);
    expect(Math.abs(adjXB)).toBeLessThan(0.1);
  });

  it('should include GfxObj BSPs in floor height scans', () => {
    const dc = new DungeonCollision();
    // A walkable floor at Z=2.0 (like a bridge or platform)
    const floor = makeQuad([0, -2, 2.0], [4, -2, 2.0], [4, 2, 2.0], [0, 2, 2.0]);
    const gfx = makeMockGfxObj([floor]);
    dc.addGfxObjCollision(100, gfx, { x: 0, y: 0, z: 0 }, { w: 1, x: 0, y: 0, z: 0 }, 0, 0);

    // Floor detection should find the platform
    const floorY = dc.getFloorHeight(2, 0, 1.5);
    expect(floorY).toBeCloseTo(2.0, 2);
  });
});

// ── NPC/Creature Cylinder Collision Tests ─────────────────────────

describe('NPC/creature cylinder collision', () => {
  /** Simulate the push-out logic from main.ts */
  function applyCreatureCollision(
    playerX: number, playerZ: number,
    creatures: Array<{ worldX: number; worldZ: number; collisionRadius: number }>,
    playerRadius = DungeonCollision.PLAYER_RADIUS,
  ): { x: number; z: number } {
    let px = playerX, pz = playerZ;
    for (const npc of creatures) {
      if (npc.collisionRadius <= 0) continue;
      const dx = px - npc.worldX;
      const dz = pz - npc.worldZ;
      const dist = Math.sqrt(dx * dx + dz * dz);
      const minDist = playerRadius + npc.collisionRadius;
      if (dist < minDist && dist > 0.001) {
        const push = minDist - dist;
        px += (dx / dist) * push;
        pz += (dz / dist) * push;
      }
    }
    return { x: px, z: pz };
  }

  it('should push player out when overlapping NPC', () => {
    const result = applyCreatureCollision(5.0, 0.0, [
      { worldX: 5.0, worldZ: 0.5, collisionRadius: 0.3 },
    ]);
    // Player and NPC overlap, player should be pushed away
    const dist = Math.sqrt((result.x - 5.0) ** 2 + (result.z - 0.5) ** 2);
    expect(dist).toBeCloseTo(DungeonCollision.PLAYER_RADIUS + 0.3, 2); // playerRadius + npcRadius
  });

  it('should not affect player when out of range', () => {
    const result = applyCreatureCollision(0.0, 0.0, [
      { worldX: 5.0, worldZ: 0.0, collisionRadius: 0.3 },
    ]);
    // Far away — no change
    expect(result.x).toBeCloseTo(0.0, 4);
    expect(result.z).toBeCloseTo(0.0, 4);
  });

  it('should handle multiple NPCs', () => {
    // Two NPCs close to player
    const result = applyCreatureCollision(5.0, 5.0, [
      { worldX: 5.0, worldZ: 5.3, collisionRadius: 0.3 },
      { worldX: 5.3, worldZ: 5.0, collisionRadius: 0.3 },
    ]);
    // Player should be pushed away from both
    const dist1 = Math.sqrt((result.x - 5.0) ** 2 + (result.z - 5.3) ** 2);
    const dist2 = Math.sqrt((result.x - 5.3) ** 2 + (result.z - 5.0) ** 2);
    const minDist = DungeonCollision.PLAYER_RADIUS + 0.3; // ~0.98
    expect(dist1).toBeGreaterThanOrEqual(minDist - 0.01);
    expect(dist2).toBeGreaterThanOrEqual(minDist - 0.01);
  });

  it('should ignore zero-radius objects', () => {
    const result = applyCreatureCollision(5.0, 5.0, [
      { worldX: 5.0, worldZ: 5.1, collisionRadius: 0 },
    ]);
    // No collision — zero radius means no push
    expect(result.x).toBeCloseTo(5.0, 4);
    expect(result.z).toBeCloseTo(5.0, 4);
  });

  it('should push radially outward from NPC center', () => {
    // Player directly east of NPC, overlapping
    const result = applyCreatureCollision(5.2, 0.0, [
      { worldX: 5.0, worldZ: 0.0, collisionRadius: 0.3 },
    ]);
    // Should push in +X direction (east)
    expect(result.x).toBeGreaterThan(5.2);
    expect(result.z).toBeCloseTo(0.0, 4);
    // Final distance should be minDist
    expect(result.x - 5.0).toBeCloseTo(DungeonCollision.PLAYER_RADIUS + 0.3, 2);
  });

  it('dead creature (radius=0) should not block', () => {
    // Simulate death by setting collisionRadius to 0
    const result = applyCreatureCollision(5.1, 0.0, [
      { worldX: 5.0, worldZ: 0.0, collisionRadius: 0 }, // dead
    ]);
    expect(result.x).toBeCloseTo(5.1, 4);
    expect(result.z).toBeCloseTo(0.0, 4);
  });
});

// ── Ground Clipping Tests ─────────────────────────────────────────

describe('Ground clipping fixes', () => {
  describe('DAT object terrain clamping', () => {
    /** Simulate the terrain clamping logic for DAT-placed objects */
    function clampDatObject(posZ: number, terrainY: number | null): number {
      let y = posZ;
      if (terrainY !== null && terrainY > posZ && (terrainY - posZ) < 2.0) {
        y = terrainY + 0.02;
      }
      return y;
    }

    it('should snap up when object is below terrain', () => {
      // Object at Z=1.0, terrain at 1.5 → 0.5m below → snap up
      const y = clampDatObject(1.0, 1.5);
      expect(y).toBeCloseTo(1.52, 4);
    });

    it('should not change when object is above terrain', () => {
      // Object at Z=2.0, terrain at 1.5 → above terrain → no change
      const y = clampDatObject(2.0, 1.5);
      expect(y).toBeCloseTo(2.0, 4);
    });

    it('should not change for deeply underground objects', () => {
      // Object at Z=0, terrain at 3.0 → 3m below → beyond 2m threshold
      const y = clampDatObject(0.0, 3.0);
      expect(y).toBeCloseTo(0.0, 4);
    });

    it('should not change when terrain is null', () => {
      const y = clampDatObject(1.0, null);
      expect(y).toBeCloseTo(1.0, 4);
    });
  });
  // 'Server object clampToTerrain' (a local copy of the old 5 m snap) moved to
  // tests/verify-decomp-world-object-lifecycle.ts as behavioral tests of the real
  // ServerObjectManager: server positions are used as sent
  // (DECOMP.invented-terrain-snap).
});

// ── Dual body-sphere collision (BUG.collision-height-single-point-not-dual-sphere) ──

describe('Dual body-sphere wall collision', () => {
  it('blocks on a low overhang the lower sphere alone would miss', () => {
    // Overhang from Z=1.6 to Z=1.9 at X=2 — above the lower sphere's reach
    // (range ~[-0.005,0.955]) but squarely inside the upper sphere's range
    // (center 1.35, radius 0.48 → [0.87,1.83]).
    const dc = new DungeonCollision();
    const overhang = makeWallFacingNegX(2, -1, 1, 1.6, 1.9);
    const gfx = makeMockGfxObj([overhang]);
    dc.addGfxObjCollision(1, gfx, { x: 0, y: 0, z: 0 }, { w: 1, x: 0, y: 0, z: 0 }, 0, 0);

    const pos = new THREE.Vector3(1.5, 0, 0);
    const [adjX] = dc.getAdjustedMovement(pos, 0.5, 0);

    // Step-up (elevated by 0.6) doesn't clear it either: elevated upper
    // sphere range [1.47,2.43] still overlaps Z=1.6-1.9.
    expect(Math.abs(adjX)).toBeLessThan(0.1);
  });

  it('blocks on a low obstacle the upper sphere alone would miss', () => {
    // Low block from Z=0.1 to Z=0.4 at X=2 — inside the lower sphere's
    // range but well below the upper sphere's range [0.87,1.83], and taller
    // than STEP_UP_HEIGHT-clearable in combination with its own riser depth
    // being checked at the base (non-elevated) sphere position.
    const dc = new DungeonCollision();
    const lowBlock = makeWallFacingNegX(2, -1, 1, 0.1, 0.4);
    const gfx = makeMockGfxObj([lowBlock]);
    dc.addGfxObjCollision(1, gfx, { x: 0, y: 0, z: 0 }, { w: 1, x: 0, y: 0, z: 0 }, 0, 0);

    const pos = new THREE.Vector3(1.5, 0, 0);
    const [adjX] = dc.getAdjustedMovement(pos, 0.5, 0);

    // The lower sphere alone (not the upper) detects it, and with no
    // walkable top and no terrain to land on the step up fails
    // (RECON.transition-stepup-stepdown-port.c.a: step_up_slide).
    expect(Math.abs(adjX)).toBeLessThan(0.1);
  });
});

// ── DAT ground truth ──────────────────────────────────────────────

describe.skipIf(!existsSync(PORTAL))('BUG.dungeon-step-up-height-hardcoded-wrong — StepUpHeight is DAT ground truth', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let setup: any;

  beforeAll(async () => {
    const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase');
    const { SetupModel } = await import('../packages/dat-parser/src/file-types/SetupModel');
    const db = openDat(PORTAL);
    const reader = db.getReader(0x02000001);
    setup = new (SetupModel as any)(reader);
  });

  it('DungeonCollision.STEP_UP_HEIGHT equals human player Setup 0x02000001 StepUpHeight', () => {
    expect(setup.stepUpHeight).toBeCloseTo(DungeonCollision.STEP_UP_HEIGHT, 6);
    // Discriminating check — the sibling field must NOT match, proving we
    // read the right offset (stepUp is 0.6, not the 1.5 stepDown).
    expect(setup.stepDownHeight).not.toBeCloseTo(DungeonCollision.STEP_UP_HEIGHT, 2);
  });
});

describe.skipIf(!existsSync(PORTAL))('BUG.outdoor-player-radius-hardcoded-wrong — player radius is DAT ground truth', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let setup: any;

  beforeAll(async () => {
    const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase');
    const { SetupModel } = await import('../packages/dat-parser/src/file-types/SetupModel');
    const db = openDat(PORTAL);
    const reader = db.getReader(0x02000001);
    setup = new (SetupModel as any)(reader);
  });

  it('DungeonCollision.PLAYER_RADIUS equals human player Setup 0x02000001 radius', () => {
    expect(setup.radius).toBeCloseTo(DungeonCollision.PLAYER_RADIUS, 6);
    // Discriminating check — must not match the old 0.4m approximation.
    expect(DungeonCollision.PLAYER_RADIUS).not.toBeCloseTo(0.4, 2);
  });

  it('BUG.melee-cylinder-distance-ignores-height — DungeonCollision.PLAYER_HEIGHT equals human player Setup 0x02000001 height', () => {
    expect(setup.height).toBeCloseTo(DungeonCollision.PLAYER_HEIGHT, 6);
    // Discriminating check — height and radius are genuinely different DAT fields.
    expect(DungeonCollision.PLAYER_HEIGHT).not.toBeCloseTo(DungeonCollision.PLAYER_RADIUS, 2);
  });
});

describe.skipIf(!existsSync(PORTAL))('BUG.collision-height-single-point-not-dual-sphere — body spheres are DAT ground truth', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let setup: any;

  beforeAll(async () => {
    const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase');
    const { SetupModel } = await import('../packages/dat-parser/src/file-types/SetupModel');
    const db = openDat(PORTAL);
    const reader = db.getReader(0x02000001);
    setup = new (SetupModel as any)(reader);
  });

  it('SetupModel 0x02000001 has exactly two body spheres', () => {
    expect(setup.spheres.length).toBe(2);
  });

  it('DungeonCollision body-sphere heights/radius equal Setup 0x02000001 Spheres[0..1]', () => {
    expect(setup.spheres[0].origin.z).toBeCloseTo(DungeonCollision.LOWER_SPHERE_HEIGHT, 6);
    expect(setup.spheres[0].radius).toBeCloseTo(DungeonCollision.BODY_SPHERE_RADIUS, 6);
    expect(setup.spheres[1].origin.z).toBeCloseTo(DungeonCollision.UPPER_SPHERE_HEIGHT, 6);
    expect(setup.spheres[1].radius).toBeCloseTo(DungeonCollision.BODY_SPHERE_RADIUS, 6);
    // Discriminating check — must not match the old single-point COLLISION_HEIGHT=0.67 guess.
    expect(DungeonCollision.LOWER_SPHERE_HEIGHT).not.toBeCloseTo(0.67, 2);
    expect(DungeonCollision.UPPER_SPHERE_HEIGHT).not.toBeCloseTo(0.67, 2);
  });
});

// ── BUG.collision-radius-step-up-hardcoded-human ────────────────────
//
// setPlayerDimensions(setup, scaleZ) resolves the real per-character
// collision radius / step-up height / body spheres (ACE PartArray.cs:191-
// 247 GetRadius/GetStepUpHeight = Setup._dat.* * Scale.Z; body spheres
// scaled the same way via SpherePath.InitSphere) instead of the permanent
// Human-only statics.

describe('BUG.collision-radius-step-up-hardcoded-human — setPlayerDimensions', () => {
  it('scales playerRadius by the setup radius and Scale.Z', () => {
    const dc = new DungeonCollision();
    dc.setPlayerDimensions({ radius: 0.83, height: 1.9, stepUpHeight: 0.85, spheres: [] }, 1);
    expect(dc.playerRadius).toBeCloseTo(0.83, 6);

    const dc2 = new DungeonCollision();
    dc2.setPlayerDimensions({ radius: 0.5, height: 1.9, stepUpHeight: 0.6, spheres: [] }, 2);
    expect(dc2.playerRadius).toBeCloseTo(1.0, 6);
  });

  it('falls back to the Human statics when setup is null/undefined', () => {
    const dc = new DungeonCollision();
    dc.setPlayerDimensions({ radius: 2.0, height: 2.0, stepUpHeight: 2.0, spheres: [] }, 1);
    expect(dc.playerRadius).toBeCloseTo(2.0, 6);

    dc.setPlayerDimensions(null, 1);
    expect(dc.playerRadius).toBeCloseTo(DungeonCollision.PLAYER_RADIUS, 6);

    dc.setPlayerDimensions({ radius: 3.0, height: 3.0, stepUpHeight: 3.0, spheres: [] }, 1);
    dc.setPlayerDimensions(undefined, 1);
    expect(dc.playerRadius).toBeCloseTo(DungeonCollision.PLAYER_RADIUS, 6);
  });

  it('a taller-than-human resolved step-up height clears a wall the Human default would block', () => {
    // Wall from Z=0 to Z=0.92 with a walkable top the feet sphere overlaps
    // (its top is at 0.955): the lift is past Human's 1.5 x 0.6 cap
    // (adjust_sphere_to_plane, blocked) and within a larger heritage's
    // resolved 1.5 stepUpHeight (clears). The step up does not raise the
    // check position, so a top above the feet sphere is never reached.
    const top = makeQuad([2, -1, 0.92], [3, -1, 0.92], [3, 1, 0.92], [2, 1, 0.92]);
    const gfx = makeMockGfxObj([makeWallFacingNegX(2, -1, 1, 0, 0.92), top]);

    const dcHuman = new DungeonCollision();
    dcHuman.addGfxObjCollision(1, gfx, { x: 0, y: 0, z: 0 }, { w: 1, x: 0, y: 0, z: 0 }, 0, 0);
    const [adjXHuman] = dcHuman.getAdjustedMovement(new THREE.Vector3(1.5, 0, 0), 0.5, 0);
    expect(Math.abs(adjXHuman)).toBeLessThan(0.1);

    const dcTall = new DungeonCollision();
    dcTall.setPlayerDimensions({ radius: DungeonCollision.PLAYER_RADIUS, height: DungeonCollision.PLAYER_HEIGHT, stepUpHeight: 1.5, spheres: [] }, 1);
    dcTall.addGfxObjCollision(1, gfx, { x: 0, y: 0, z: 0 }, { w: 1, x: 0, y: 0, z: 0 }, 0, 0);
    const [adjXTall] = dcTall.getAdjustedMovement(new THREE.Vector3(1.5, 0, 0), 0.5, 0);
    expect(adjXTall).toBeCloseTo(0.5, 1);
    expect(dcTall.lastStepUp).toBeCloseTo(0.925, 2);
  });

  it('a smaller resolved body sphere clears a cylinder obstacle the Human default would block', () => {
    // ACE CylSphere.IntersectsSphere (Physics/CylSphere.cs:239): the reach is
    // cylinder radius − EPSILON + the BODY SPHERE's radius (GlobalSphere[0]
    // .Radius — Human 0.48), not the Setup's bounding Radius.
    const dcHuman = new DungeonCollision();
    // Cylinder placed so its edge sits just inside the Human body-sphere
    // reach (0.3 + 0.48 = 0.78 > 0.75) but outside a much smaller resolved one.
    dcHuman.addCylinderObstacle(1, 0.8, 0, 0.3);
    const [adjXHuman] = dcHuman.getAdjustedMovement(new THREE.Vector3(0, 0, 0), 0.05, 0);
    expect(Math.abs(adjXHuman)).toBeLessThan(0.01);

    const dcSmall = new DungeonCollision();
    dcSmall.setPlayerDimensions({
      radius: 0.1, height: DungeonCollision.PLAYER_HEIGHT, stepUpHeight: DungeonCollision.STEP_UP_HEIGHT,
      spheres: [{ origin: { z: 0.2 }, radius: 0.1 }, { origin: { z: 0.5 }, radius: 0.1 }],
    }, 1);
    dcSmall.addCylinderObstacle(1, 0.8, 0, 0.3);
    const [adjXSmall] = dcSmall.getAdjustedMovement(new THREE.Vector3(0, 0, 0), 0.05, 0);
    expect(adjXSmall).toBeCloseTo(0.05, 4);
  });

  it('scales body-sphere heights by Scale.Z when 2 spheres are given', () => {
    // Wall at Z=1.9-2.5 — above the unscaled Human upper sphere's reach
    // (center 1.35, radius 0.48 -> tops out at 1.83, clears) but within
    // reach once scaleZ=1.5 lifts the upper sphere center to 2.025 (blocks).
    const wall = makeMockGfxObj([makeWallFacingNegX(2, -1, 1, 1.9, 2.5)]);

    const dcUnscaled = new DungeonCollision();
    dcUnscaled.addGfxObjCollision(1, wall, { x: 0, y: 0, z: 0 }, { w: 1, x: 0, y: 0, z: 0 }, 0, 0);
    const [adjXUnscaled] = dcUnscaled.getAdjustedMovement(new THREE.Vector3(1.5, 0, 0), 0.5, 0);
    expect(adjXUnscaled).toBeCloseTo(0.5, 1);

    const dcScaled = new DungeonCollision();
    dcScaled.setPlayerDimensions(
      { radius: DungeonCollision.PLAYER_RADIUS, height: DungeonCollision.PLAYER_HEIGHT, stepUpHeight: DungeonCollision.STEP_UP_HEIGHT, spheres: [
        { origin: { z: DungeonCollision.LOWER_SPHERE_HEIGHT }, radius: DungeonCollision.BODY_SPHERE_RADIUS },
        { origin: { z: DungeonCollision.UPPER_SPHERE_HEIGHT }, radius: DungeonCollision.BODY_SPHERE_RADIUS },
      ] },
      1.5,
    );
    dcScaled.addGfxObjCollision(1, wall, { x: 0, y: 0, z: 0 }, { w: 1, x: 0, y: 0, z: 0 }, 0, 0);
    const [adjXScaled] = dcScaled.getAdjustedMovement(new THREE.Vector3(1.5, 0, 0), 0.5, 0);
    expect(Math.abs(adjXScaled)).toBeLessThan(0.1);
  });
});

describe.skipIf(!existsSync(PORTAL))('BUG.collision-radius-step-up-hardcoded-human — DAT ground truth', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let humanSetup: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let olthoiSetup: any;

  beforeAll(async () => {
    const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase');
    const { SetupModel } = await import('../packages/dat-parser/src/file-types/SetupModel');
    const db = openDat(PORTAL);
    humanSetup = new (SetupModel as any)(db.getReader(0x02000001));
    olthoiSetup = new (SetupModel as any)(db.getReader(0x02001a21));
  });

  it('setPlayerDimensions(humanSetup, 1) reproduces the existing DAT-verified Human PLAYER_RADIUS/PLAYER_HEIGHT', () => {
    const dc = new DungeonCollision();
    dc.setPlayerDimensions(humanSetup, 1);
    expect(dc.playerRadius).toBeCloseTo(DungeonCollision.PLAYER_RADIUS, 6);
    expect(dc.playerHeight).toBeCloseTo(DungeonCollision.PLAYER_HEIGHT, 6);
  });

  it('Olthoi (0x02001a21) radius/height/step-up genuinely differ from the Human defaults (real non-Human heritage)', () => {
    expect(olthoiSetup.radius).not.toBeCloseTo(DungeonCollision.PLAYER_RADIUS, 2);
    expect(olthoiSetup.height).not.toBeCloseTo(DungeonCollision.PLAYER_HEIGHT, 2);
    expect(olthoiSetup.stepUpHeight).not.toBeCloseTo(DungeonCollision.STEP_UP_HEIGHT, 2);
    expect(olthoiSetup.spheres.length).toBeGreaterThanOrEqual(1);
  });
});
