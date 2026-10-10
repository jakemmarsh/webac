/**
 * AGENT.walk-drops-jumps — the jump physics walk_to plans with
 * (packages/renderer/src/agent/jumpPlan.ts): ACE's fall damage, the safe drop
 * height, a flight through a small world, the charge time, and the client's
 * in-air collision height and head clamp (world/fallPhysics.ts).
 */
import { describe, expect, it } from 'vitest';
import { getJumpVelocity } from '@ac/shared';
import { dropDamage, fallBudget, fallDamage, jumpOptions, reaimJump, safeDropHeight, simulateFlight, type JumpKit } from '../packages/renderer/src/agent/jumpPlan.ts';
import { airborneReferenceY, headroomClamp } from '../packages/renderer/src/world/fallPhysics.ts';
import { jumpChargeSeconds } from '../packages/renderer/src/animation/CharacterAnimController.ts';
import { MotionStance } from '../packages/renderer/src/animation/MotionCommands.ts';

/** A world of floors (heights at x, y); the body is blocked where a floor top stands above its feet. */
function kitFor(floors: (x: number, y: number) => number[], skill = 100): JumpKit {
  const below = (x: number, y: number, z: number): number | null => {
    const fs = floors(x, y).filter((f) => f <= z + 0.05);
    return fs.length ? Math.max(...fs) : null;
  };
  return {
    floor: below,
    airStep: (from, dx, dy) => {
      const n = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 0.05));
      let p = { x: from.x, y: from.y };
      for (let i = 1; i <= n; i++) {
        const t = { x: from.x + (dx * i) / n, y: from.y + (dy * i) / n };
        if (floors(t.x, t.y).some((f) => f > from.z + 0.05 && f < from.z + 1.8)) break;
        p = t;
      }
      return p;
    },
    launch: (power, walk) => ({ forward: walk ? 3.12 : 8, up: getJumpVelocity(0, skill, power) }),
    chargeSeconds: 1,
  };
}

describe('fall damage (ACE Player_Move.cs HandleFallingDamage)', () => {
  it('is nothing until the landing is faster than 15.75 m/s (a 12.66 m fall), then grows with the overspeed', () => {
    expect(fallDamage(-15.7)).toBe(0);
    expect(dropDamage(12.6)).toBe(0);
    // A 20 m fall lands at 19.80 m/s: (19.80 − 15.754) / 11.254 × 87.29 = 31.4.
    expect(dropDamage(20)).toBeCloseTo(31.4, 1);
    expect(fallDamage(-11.25434 - 4.5 - 11.25434)).toBeCloseTo(87.29381, 4);
  });
  it('the safe drop height inverts it, and the budget is half your health with room for a bludgeon weakness', () => {
    expect(fallBudget({ current: 100, max: 100 })).toBe(40);
    expect(fallBudget({ current: 20, max: 100 })).toBe(8);
    expect(safeDropHeight(0)).toBeCloseTo(12.66, 2);
    expect(dropDamage(safeDropHeight(31.4))).toBeCloseTo(31.4, 3);
  });
});

describe('the jump charge time (ClientCombatSystem::GetJumpPowerLevel)', () => {
  it('is 1 s, and 0.8 s in dual wield', () => {
    expect(jumpChargeSeconds(MotionStance.NonCombat)).toBe(1);
    expect(jumpChargeSeconds(MotionStance.DualWieldCombat)).toBe(0.8);
  });
});

describe('a flight through the world', () => {
  it('a standing jump on flat ground comes down where it left, as fast as it went up', () => {
    const kit = kitFor(() => [0]);
    const v = getJumpVelocity(0, 100, 1);
    const l = simulateFlight(kit, { x: 0, y: 0, z: 0 }, 0, 0, v)!;
    expect(l).toMatchObject({ x: 0, y: 0, z: 0 });
    expect(l.vz).toBeCloseTo(-v, 0);
    expect(l.t).toBeCloseTo((2 * v) / 9.8, 1);
  });
  it('off a ledge it falls to the floor below; into a wall it stops and falls', () => {
    const ledge = kitFor((x) => (x < 2 ? [5, 0] : [0]));
    const l = simulateFlight(ledge, { x: 1.9, y: 0, z: 5 }, 3, 0, 2.6)!;
    expect(l.z).toBe(0);
    expect(l.x).toBeGreaterThan(3);
    expect(fallDamage(l.vz)).toBe(0);
    const wall = kitFor((x) => (x > 3 ? [0, 1.5] : [0])); // a block 1.5 m tall: higher than this hop
    expect(simulateFlight(wall, { x: 0, y: 0, z: 0 }, 8, 0, 3)!.x).toBeLessThanOrEqual(3);
  });
  it('a rising head stops under the floor above (no jumping up through it)', () => {
    // A 3 m room with the upper floor at 3.2: a 22 m/s launch would carry the feet past it.
    const kit = kitFor(() => [0, 3.2]);
    const l = simulateFlight(kit, { x: 0, y: 0, z: 0 }, 0, 0, 22)!;
    expect(l.z).toBe(0);
  });
});

describe('jump options and re-aiming', () => {
  const gap = (x: number): number[] => (x < 0 || x > 2.5 ? [0, -30] : [-30]);
  it('across a 2.5 m gap over a 30 m pit: only jumps that land on the far side, and never one into the pit', () => {
    const kit = kitFor((x) => gap(x));
    const opts = jumpOptions(kit, { x: -0.1, y: 0, z: 0 }, { x: 1, y: 0 }, { maxDamage: 20 });
    expect(opts.length).toBeGreaterThan(0);
    for (const o of opts) {
      expect(o.to.z).toBe(0);
      expect(o.to.x).toBeGreaterThan(2.5);
      expect(o.holdMs).toBe(Math.round(o.power * 1000));
    }
    // Walking jumps come first, so the gentlest that clears it is tried before a running one.
    expect(opts[0].walk).toBe(true);
  });
  it('re-aims from where the body really stopped, landing near the planned spot', () => {
    const kit = kitFor((x) => gap(x));
    const plan = jumpOptions(kit, { x: -0.1, y: 0, z: 0 }, { x: 1, y: 0 }, { maxDamage: 20 })[0];
    const again = reaimJump(kit, { x: -0.6, y: 0.2, z: 0 }, plan, 20)!;
    expect(again).not.toBeNull();
    expect(Math.hypot(again.to.x - plan.to.x, again.to.y - plan.to.y)).toBeLessThan(1.5);
    expect(again.power).toBeGreaterThanOrEqual(plan.power);
  });
});

describe('the client\'s in-air collision height (fallPhysics)', () => {
  it('is the feet in the air and the floor on the ground', () => {
    expect(airborneReferenceY(true, 10, 1.25, 0)).toBe(11.25);
    expect(airborneReferenceY(false, 10, 1.25, 4)).toBe(4);
  });
  it('the head clamp stops a rising body under a floor above, and leaves floors it stands on or ramps alone', () => {
    expect(headroomClamp(2, 3, 3.5, 1.835)).toEqual({ feetY: 1.665, velocityY: 0, hit: true });
    expect(headroomClamp(2, 3, 2.4, 1.835).hit).toBe(false); // a ramp or floor under the body
    expect(headroomClamp(2, -3, 3.5, 1.835).hit).toBe(false); // falling
    expect(headroomClamp(2, 3, null, 1.835).hit).toBe(false);
  });
});
