/**
 * GAP.5 — ACE-exact terrain walkability.
 *
 * ACE PhysicsObj.is_valid_walkable (PhysicsObj.cs:2861):
 *   normal.Z >= PhysicsGlobals.FloorZ = 0.66417414618662751  (PhysicsGlobals.cs:50)
 * → maximum walkable slope ≈ 48.36°, i.e. gradient ≈ 1.1256 (rise per meter).
 *
 * The old isWalkable default (slope < 45°) was an invented threshold — a
 * uniform 45° slope is WALKABLE in ACE but was rejected by the old check.
 * These tests drive the real TerrainCollision with synthetic landblocks.
 */
import { describe, it, expect } from 'vitest';
import { TerrainCollision } from '../packages/shared/src/physics/TerrainCollision.js';

// 9×9 vertex heightmap, 24m cell pitch; heights in world meters.
function slopeBlock(gradient: number): number[] {
  const heights: number[] = [];
  for (let x = 0; x < 9; x++) {
    for (let y = 0; y < 9; y++) {
      heights.push(gradient * x * 24);
    }
  }
  return heights;
}

describe('GAP.5 — ACE FloorZ walkability threshold', () => {
  it('exposes the exact ACE constant', () => {
    expect(TerrainCollision.ACE_FLOOR_Z).toBe(0.66417414618662751);
  });

  it('flat terrain is walkable', () => {
    const tc = new TerrainCollision();
    tc.setLandblock(0, 0, { heights: new Array(81).fill(20), blockX: 0, blockY: 0 });
    expect(tc.isWalkable(96, 96)).toBe(true);
  });

  it('a 45° slope IS walkable (ACE ~48.4° limit; the old invented 45° cap rejected it)', () => {
    const tc = new TerrainCollision();
    tc.setLandblock(0, 0, { heights: slopeBlock(1.0), blockX: 0, blockY: 0 });
    // normal.y = 1/sqrt(1+1) ≈ 0.7071 >= 0.664174 → walkable
    expect(tc.isWalkable(96, 96)).toBe(true);
  });

  it('a gradient-1.3 slope (~52.4°) is NOT walkable', () => {
    const tc = new TerrainCollision();
    tc.setLandblock(0, 0, { heights: slopeBlock(1.3), blockX: 0, blockY: 0 });
    // normal.y = 1/sqrt(1+1.69) ≈ 0.6097 < 0.664174 → rejected
    expect(tc.isWalkable(96, 96)).toBe(false);
  });

  it('threshold straddle: gradients just inside/outside FloorZ split correctly', () => {
    // gradient g ↔ normal.y = 1/sqrt(1+g²); threshold g* = sqrt(1/FloorZ² - 1) ≈ 1.12559
    const inside = new TerrainCollision();
    inside.setLandblock(0, 0, { heights: slopeBlock(1.10), blockX: 0, blockY: 0 });
    expect(inside.isWalkable(96, 96)).toBe(true);
    const outside = new TerrainCollision();
    outside.setLandblock(0, 0, { heights: slopeBlock(1.15), blockX: 0, blockY: 0 });
    expect(outside.isWalkable(96, 96)).toBe(false);
  });

  it('unloaded terrain is not walkable (no data → no movement onto it)', () => {
    const tc = new TerrainCollision();
    expect(tc.isWalkable(5000, 5000)).toBe(false);
  });

  it('getTriangleNormalAt is the plane of the getHeightAt triangle, on both sides of every split', () => {
    // Uneven heights so each cell's two triangles differ; blocks chosen to
    // cover both split directions.
    for (const [bx, by] of [[0, 0], [17, 42], [200, 3]]) {
      const tc = new TerrainCollision();
      tc.setLandblock(bx, by, { heights: Array.from({ length: 81 }, (_, i) => ((i * 37) % 23) * 1.7), blockX: bx, blockY: by });
      for (let cell = 0; cell < 64; cell += 5) {
        const x0 = bx * 192 + Math.floor(cell / 8) * 24;
        const z0 = by * 192 + (cell % 8) * 24;
        // Off both diagonals, on both sides of each, so both triangles of either split are sampled.
        for (const [fx, fz] of [[0.8, 0.1], [0.1, 0.8], [0.1, 0.25], [0.9, 0.75]]) {
          const x = x0 + fx * 24, z = z0 + fz * 24, e = 0.05;
          const h = tc.getHeightAt(x, z)!;
          const n = tc.getTriangleNormalAt(x, z)!;
          expect(-n.x / n.y).toBeCloseTo((tc.getHeightAt(x + e, z)! - h) / e, 6);
          expect(-n.z / n.y).toBeCloseTo((tc.getHeightAt(x, z + e)! - h) / e, 6);
          expect(Math.hypot(n.x, n.y, n.z)).toBeCloseTo(1, 9);
        }
      }
    }
  });
});
