/**
 * AGENT.walk-drops-jumps — the jump physics walk_to plans with
 * (packages/renderer/src/agent/jumpPlan.ts): ACE's fall damage, the safe drop
 * height, a flight through a small world, the charge time, and the client's
 * in-air collision height and head clamp (world/fallPhysics.ts).
 */
import { describe, expect, it } from 'vitest';
import { getJumpVelocity } from '@ac/shared';
import { ACE_FALL_MODEL, FALL_SPEED_MARGIN, LANDING_MARGIN_M, dropDamage, expectedFallDamage, fallBudget, fallDamage, fallModelFor, gdleFallModel, jumpOptions, reaimJump, safeDropHeight, simulateFlight, stableLanding, type JumpKit } from '../packages/renderer/src/agent/jumpPlan.ts';
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
    // A 20 m fall lands at 19.80 m/s: (19.80 − 15.754) / 11.254 × 87.29 = 31.4.
    expect(fallDamage(-Math.sqrt(2 * 9.8 * 20))).toBeCloseTo(31.4, 1);
    expect(fallDamage(-11.25434 - 4.5 - 11.25434)).toBeCloseTo(87.29381, 4);
    // ClassicACE's is ACE's; a GDLE jump velocity never reaches it.
    expect(fallModelFor('ace', 5.26)).toBe(ACE_FALL_MODEL);
  });
  it('the planner bills a landing FALL_SPEED_MARGIN faster than it flies it', () => {
    expect(FALL_SPEED_MARGIN).toBe(0.4);
    expect(dropDamage(12)).toBe(0);
    expect(dropDamage(12.6)).toBeGreaterThan(0); // 15.715 m/s + 0.4 is past ACE's 15.754
    expect(dropDamage(20)).toBeCloseTo(fallDamage(-Math.sqrt(2 * 9.8 * 20) - 0.4), 6);
    expect(expectedFallDamage(3)).toBe(0); // still rising
  });
  it('the safe drop height inverts it, and the budget is 40% of your health now (half, with room for a bludgeon weakness)', () => {
    expect(fallBudget({ current: 100, max: 100 })).toBe(40);
    expect(fallBudget({ current: 20, max: 100 })).toBe(8);
    expect(safeDropHeight(0)).toBeCloseTo(((15.75434 - 0.4) ** 2) / 19.6, 3); // 12.03 m
    expect(dropDamage(safeDropHeight(31.4))).toBeCloseTo(31.4, 3);
  });
});

describe('fall damage on GDLE-family servers (the AC1999 server, GDL-Classic: WeenieObject.cpp DoCollision)', () => {
  // The player's own full-power jump: sqrt(19.6 × GetJumpHeight(load, Jump, 1)).
  const jv85 = getJumpVelocity(0, 85, 1);
  it('divides by the player\'s own jump velocity and bills (int)(ratio × 40): the start-dungeon [FALLDMG] line', () => {
    // 2026-10-16: Claude, Jump 85, burden under capacity: jumpV=5.26, vz=-12.55, ratio=0.530, damage=21 (25 → 4 health).
    expect(jv85).toBeCloseTo(5.26, 2);
    const m = gdleFallModel(jv85);
    expect(-(m.jumpVelocity - 12.55 + 4.5) / m.jumpVelocity).toBeCloseTo(0.530, 3);
    expect(fallDamage(-12.55, m)).toBe(21);
    // ACE's curve, which the planner used, says that landing is free.
    expect(fallDamage(-12.55)).toBe(0);
  });
  it('matches the knowledge-base samples (Jump 104, jV 5.76): a max jump in place is free, a building drop 34', () => {
    const m = gdleFallModel(5.76);
    expect(fallDamage(-5.89, m)).toBe(0);
    expect(fallDamage(-15.19, m)).toBe(34);
  });
  it('a burdened or untrained jump floors at 2.62 m/s, where 5 m costs ~42', () => {
    const m = gdleFallModel(0);
    expect(m.jumpVelocity).toBeCloseTo(2.619, 3);
    expect(fallDamage(-Math.sqrt(19.6 * 5), m)).toBe(42);
  });
  it('the safe drop height for 25 health at Jump 85 is well under the dungeon\'s 7.8 m', () => {
    const m = fallModelFor('gdle', jv85);
    const budget = fallBudget({ current: 25, max: 25 });
    expect(safeDropHeight(budget, m)).toBeLessThan(6.5);
    expect(safeDropHeight(budget, m)).toBeGreaterThan(4.9);
    expect(dropDamage(7.8, m)).toBeGreaterThan(budget);
    expect(safeDropHeight(budget)).toBeGreaterThan(12); // ACE: no damage at all that deep
  });
  it('the planner refuses the 7.8 m drop at 25 health and takes it with health to spare, billing about 21', () => {
    // A ledge at z −4.2 over a floor at −12.0 (the start dungeon's numbers), Jump 85.
    const kit: JumpKit = { ...kitFor((x) => (x < 0 ? [-4.2, -12] : [-12]), 85), fall: gdleFallModel(jv85) };
    const from = { x: -0.1, y: 0, z: -4.2 };
    const down = (maxDamage: number) => jumpOptions(kit, from, { x: 1, y: 0 }, { maxDamage }).filter((o) => o.to.z === -12);
    expect(down(fallBudget({ current: 25, max: 25 }))).toEqual([]);
    const ok = down(fallBudget({ current: 80, max: 80 }));
    expect(ok.length).toBeGreaterThan(0);
    // The gentlest (a walking 0.15 charge, as the live walk flew it) bills about what the server did; a harder
    // charge goes higher and bills more, never past the budget.
    expect(ok[0].power).toBe(0.15);
    expect(ok[0].damage).toBeGreaterThanOrEqual(21);
    expect(ok[0].damage).toBeLessThanOrEqual(26);
    for (const o of ok) expect(o.damage).toBeLessThanOrEqual(fallBudget({ current: 80, max: 80 }));
    // On ACE the same drop costs nothing, and a 25-health character takes it.
    const ace: JumpKit = { ...kit, fall: undefined };
    expect(jumpOptions(ace, from, { x: 1, y: 0 }, { maxDamage: 10 }).filter((o) => o.to.z === -12).every((o) => o.damage === 0)).toBe(true);
    expect(jumpOptions(ace, from, { x: 1, y: 0 }, { maxDamage: 10 }).some((o) => o.to.z === -12)).toBe(true);
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
    // Never on the pit's lip: an edge landing slides the body off (stableLanding).
    const again = reaimJump(kit, { x: -0.6, y: 0.2, z: 0 }, plan, 20)!;
    expect(again).not.toBeNull();
    expect(again.to.x).toBeGreaterThanOrEqual(2.5 + LANDING_MARGIN_M);
    expect(Math.hypot(again.to.x - plan.to.x, again.to.y - plan.to.y)).toBeLessThan(1.5);
    expect(again.power).toBeGreaterThanOrEqual(plan.power);
  });
});

describe('landings that hold the body (2026-10-11: the dam pylons at 42.3N 78.35W)', () => {
  // Pylon tops 0.8 m wide every 3 m, 23 m over the riverbed (the dam: a "4.8 m drop" became a 28 m fall).
  const dam = (x: number): number[] => ((((x % 3) + 3) % 3) < 0.8 ? [23, 0] : [0]);
  it('a pylon top with a long drop all round is no landing; flat ground and a floor beside a wall are', () => {
    const kit = kitFor((x) => dam(x));
    expect(stableLanding(kit, { x: 0.4, y: 0, z: 23 })).toBe(false);
    expect(stableLanding(kit, { x: 1.5, y: 0, z: 0 })).toBe(true);
    // A wall's footing (no floor at all under it) is not a drop.
    expect(stableLanding({ floor: (x) => (x > 0.3 ? null : 5) }, { x: 0, y: 0, z: 5 })).toBe(true);
  });
  it('the planner never lands on a pylon: from a ledge at 27.9 m it drops to the ground, not onto a pylon top', () => {
    const kit = kitFor((x) => (x < 0 ? [27.9, 0] : dam(x)));
    const opts = jumpOptions(kit, { x: -0.1, y: 0, z: 27.9 }, { x: 1, y: 0 }, { maxDamage: 200 });
    expect(opts.length).toBeGreaterThan(0);
    for (const o of opts) expect(o.to.z).toBe(0);
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
