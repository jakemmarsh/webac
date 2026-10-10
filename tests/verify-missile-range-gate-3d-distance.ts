/**
 * BUG.missile-range-gate-ignores-height — the missile-attack range gate must
 * use ACE's full 3D distance, not a horizontal-only (x,z) distance.
 *
 * ACE.Server/WorldObjects/Player_Missile.cs:346-354 TargetInRange compares
 * against ACE.Entity/Position.cs:468-489 DistanceTo, a true 3D Euclidean
 * distance: `Math.Sqrt(dx*dx + dy*dy + dz*dz)`. A horizontal-only distance is
 * always <= the true 3D distance, so dropping height one-directionally lets
 * the client send missile-attacks the server would reject via
 * MissileOutOfRange for elevated/lowered targets (cliffs, towers,
 * multi-level dungeons).
 */
import { describe, it, expect } from 'vitest';
import { getMissileTargetDistance } from '../packages/renderer/src/controllers/CombatController.js';

describe('getMissileTargetDistance (BUG.missile-range-gate-ignores-height)', () => {
  it('matches ACE Position.DistanceTo: sqrt(dx*dx + dy*dy + dz*dz)', () => {
    expect(getMissileTargetDistance(3, 4, 0)).toBeCloseTo(5, 10);
    expect(getMissileTargetDistance(3, 0, 4)).toBeCloseTo(5, 10);
    expect(getMissileTargetDistance(2, 3, 6)).toBeCloseTo(7, 10);
  });

  it('a purely vertical offset (same horizontal position) is not reported as zero distance', () => {
    // A target directly overhead (a tower archer, a cliff edge) at dx=dz=0
    // must still register its height as distance — a horizontal-only
    // (x,z)-only calculation would wrongly report 0.
    expect(getMissileTargetDistance(0, 10, 0)).toBe(10);
  });

  it('the 3D distance is always >= the horizontal-only (x,z) distance for any nonzero height offset', () => {
    const dx = 12;
    const dz = 9;
    const horizontalOnly = Math.sqrt(dx * dx + dz * dz);
    for (const dy of [1, 5, 20, -8]) {
      expect(getMissileTargetDistance(dx, dy, dz)).toBeGreaterThan(horizontalOnly);
    }
  });

  it('with zero height offset, the 3D distance reduces to the flat horizontal distance', () => {
    const dx = 12;
    const dz = 9;
    expect(getMissileTargetDistance(dx, 0, dz)).toBeCloseTo(Math.sqrt(dx * dx + dz * dz), 10);
  });

  it('a target elevated just enough to push the true distance past max range would be wrongly in-range under a horizontal-only calc', () => {
    // Regression scenario: horizontal distance sits just under a max range of
    // 50, but a 20m height offset (cliff/tower) pushes the true distance over.
    const maxRange = 50;
    const dx = 45;
    const dz = 15;
    const dy = 20;
    const horizontalOnly = Math.sqrt(dx * dx + dz * dz);
    expect(horizontalOnly).toBeLessThan(maxRange); // old buggy calc: in range
    expect(getMissileTargetDistance(dx, dy, dz)).toBeGreaterThan(maxRange); // real 3D calc: out of range
  });
});
