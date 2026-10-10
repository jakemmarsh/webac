/**
 * BUG.melee-approach-speed-hardcoded — melee auto-approach must close
 * distance at the same ACE-derived run speed (RunAnimSpeed x runRate) as
 * normal WASD movement, not an unsourced flat guess.
 *
 * Pre-fix `main.ts` hardcoded a flat MELEE_APPROACH_SPEED = 6.0, wrong
 * across the entire Run-skill range (~50% too fast at 0 Run skill, ~3x too
 * slow at maxed Run skill >=800) and never scaling with burden.
 *
 * ACE.Server/Physics/Animation/MotionInterp.cs:28 RunAnimSpeed=4.0f;
 * packages/shared/src/physics/MovementSystem.ts getRunRate(burden, runSkill)
 * (true speed range 4.0-18.0 units/sec, runRate 1.0-4.5). CameraController's
 * WASD forward-run branch already computes RUN_ANIM_SPEED * this.runRate —
 * computeMeleeApproachStep mirrors that same formula for the approach loop.
 */
import { describe, it, expect } from 'vitest';
import { computeMeleeApproachStep } from '../packages/renderer/src/controllers/CombatController.js';
import { RUN_ANIM_SPEED } from '../packages/shared/src/index.js';
import { getRunRate } from '@ac/shared';

describe('computeMeleeApproachStep (BUG.melee-approach-speed-hardcoded)', () => {
  it('scales with runRate, not a flat constant', () => {
    const dt = 1 / 30;
    const farAway = 100;
    const stepAt1x = computeMeleeApproachStep(RUN_ANIM_SPEED, 1.0, dt, farAway);
    const stepAt2x = computeMeleeApproachStep(RUN_ANIM_SPEED, 2.0, dt, farAway);
    expect(stepAt2x).toBeCloseTo(stepAt1x * 2, 10);
  });

  it('matches RUN_ANIM_SPEED x runRate x dt when clear of the remaining-distance clamp', () => {
    const dt = 1 / 60;
    const runRate = 3.0;
    const step = computeMeleeApproachStep(RUN_ANIM_SPEED, runRate, dt, 1000);
    expect(step).toBeCloseTo(RUN_ANIM_SPEED * runRate * dt, 10);
  });

  it('clamps to the remaining distance so it never overshoots the target', () => {
    const step = computeMeleeApproachStep(RUN_ANIM_SPEED, 4.5, 1 / 10, 0.05);
    expect(step).toBe(0.05);
  });

  it('tracks real getRunRate output across the Run-skill range (0 vs maxed skill)', () => {
    const dt = 1 / 30;
    const lowSkillRate = getRunRate(0, 50); // floor: unraised Run skill
    const maxSkillRate = getRunRate(0, 800); // Run skill cap
    const lowStep = computeMeleeApproachStep(RUN_ANIM_SPEED, lowSkillRate, dt, 1000);
    const maxStep = computeMeleeApproachStep(RUN_ANIM_SPEED, maxSkillRate, dt, 1000);
    // A flat 6.0 guess split these into "50% too fast at 0 skill, 3x too
    // slow at max skill" — the real formula must NOT collapse to a constant.
    expect(maxStep).toBeGreaterThan(lowStep);
    expect(lowStep).toBeCloseTo(RUN_ANIM_SPEED * lowSkillRate * dt, 10);
    expect(maxStep).toBeCloseTo(RUN_ANIM_SPEED * maxSkillRate * dt, 10);
  });
});
