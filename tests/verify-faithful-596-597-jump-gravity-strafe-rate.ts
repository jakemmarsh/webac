/**
 * FAITHFUL.596 + FAITHFUL.597 — movement-physics constants vs ACE
 * (faithfulness sweep 2026-06-03 findings #9, #10; hardcoded-vs-dat shape).
 *
 * 596: the airborne integration used GRAVITY = -19.6 ("ACE gravity constant"
 *      — false; that's 2g from the LAUNCH formula sqrt(height·19.6) in
 *      WeenieObject.cs:95). ACE PhysicsGlobals.cs:13 integrates g = -9.8
 *      (PhysicsObj.cs:2080, :1858). Launch with sqrt(2·g·h) but integrate
 *      with 2g and the peak is v0²/(2·2g) = h/2 — every jump reached half
 *      its intended height.
 *
 * 597: the running-strafe branch multiplied by a hardcoded 2.0 in BOTH
 *      MotionManager.applyStanceToMotion and CameraController. ACE
 *      MotionInterp.cs:550-560 multiplies SideStepRight by speedMod — the
 *      character's run rate, the same scalar the forward branch uses —
 *      then clamps to MaxSidestepAnimRate (3.0).
 */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { integrateAirborneStep, getJumpVelocity, getJumpHeight } from '@ac/shared';
import { CameraController } from '../packages/renderer/src/scene/CameraController.js';
import { MotionManager } from '../packages/renderer/src/animation/MotionManager.js';
import { MotionCommand, MotionSpeed } from '../packages/renderer/src/animation/MotionCommands.js';

describe('FAITHFUL.596: jump gravity matches ACE PhysicsGlobals.Gravity', () => {
  it('the shipped airborne step defaults to g = -9.8 (PhysicsGlobals.cs:13), not 2g', () => {
    // One second of free fall from rest: -½·g·1² = -4.9m under ACE gravity,
    // -9.8m under the pre-fix 2g constant.
    const after = integrateAirborneStep(0, 0, 1.0);
    expect(after.y).toBeCloseTo(-4.9, 10);
    expect(after.velocityY).toBeCloseTo(-9.8, 10);
  });

  it('launch velocity stays sqrt(height * 19.6) = sqrt(2·g·h) (WeenieObject.cs:95)', () => {
    const height = getJumpHeight(0, 200, 1.0);
    expect(getJumpVelocity(0, 200, 1.0)).toBeCloseTo(Math.sqrt(height * 19.6), 10);
  });

  it('uses the ACE-exact kinematic step (PhysicsObj.cs:1854-1858), not Euler', () => {
    // y += v·dt + ½g·dt² THEN v += g·dt. Semi-implicit Euler (v first) would
    // put the step at v·dt + g·dt² — a full ½g·dt² lower.
    const v0 = 7.0, dt = 0.25, g = -9.8;
    const stepped = integrateAirborneStep(0, v0, dt, g);
    expect(stepped.y).toBeCloseTo(v0 * dt + g * 0.5 * dt * dt, 12);
    expect(stepped.y).not.toBeCloseTo(v0 * dt + g * dt * dt, 6); // Euler
  });

  it('launch + integration are consistent: peak == jump height even at 12fps', () => {
    // Drives the SHIPPED integrateAirborneStep (the exact helper main.ts's
    // airborne branch calls) — exact for constant g at any dt, where the old
    // Euler step lost ~33% of peak at 12fps.
    const GRAVITY = -9.8;
    const height = 2.5; // meters — a strong jump
    for (const dt of [1 / 60, 1 / 12]) { // healthy and heavily-loaded frame rates
      let v = Math.sqrt(height * 19.6);
      let y = 0;
      let peak = 0;
      for (let t = 0; t < 5; t += dt) {
        ({ y, velocityY: v } = integrateAirborneStep(y, v, dt, GRAVITY));
        peak = Math.max(peak, y);
        if (y < 0) break;
      }
      // Frame-boundary sampling can miss the apex by at most g·dt²/8
      // (0.0085m at 12fps); the pre-fix errors were 1.25m (2g constant)
      // and ~0.1-0.3m (Euler undershoot at low fps).
      const apexQuantization = (9.8 * dt * dt) / 8;
      expect(peak).toBeGreaterThan(height - apexQuantization - 1e-9);
      expect(peak).toBeLessThanOrEqual(height + 1e-9);
    }
  });
});

describe('FAITHFUL.597: running strafe scales by run rate (MotionInterp.cs:550-560)', () => {
  /** Real MotionManager.adjustMotion output for a running sidestep. */
  const strafeAnimSpeed = (runRate: number): number =>
    MotionManager.adjustMotion(MotionCommand.SideStepRight, 1.0, true, runRate).speed;

  /** Metres actually travelled sideways in 1s by the real CameraController. */
  function strafeSpeed(runRate: number): number {
    const camera = new THREE.PerspectiveCamera(60, 1.6, 0.1, 1000);
    const cc = new CameraController(camera);
    cc.runRate = runRate;
    cc.runIsDefault = true; // running without synthesizing a Shift state
    cc.simulateKeyDown('KeyC'); // strafe right
    const start = camera.position.clone();
    for (let i = 0; i < 100; i++) cc.update(0.01);
    return Math.hypot(camera.position.x - start.x, camera.position.z - start.z);
  }

  it('MotionManager strafe anim rate tracks runRate, not a hardcoded 2.0', () => {
    // Pre-fix every running sidestep produced the same 2.0-scaled speed
    // regardless of the character's Run skill.
    expect(strafeAnimSpeed(2.0) / strafeAnimSpeed(1.0)).toBeCloseTo(2.0, 10);
    expect(strafeAnimSpeed(1.0)).not.toBeCloseTo(strafeAnimSpeed(2.0), 6);
  });

  it('MotionManager clamps the running sidestep at MaxSidestepAnimRate (3.0)', () => {
    expect(strafeAnimSpeed(4.5)).toBeCloseTo(MotionSpeed.MaxSidestepAnimRate, 10);
    expect(strafeAnimSpeed(9.0)).toBeCloseTo(MotionSpeed.MaxSidestepAnimRate, 10);
  });

  it('CameraController strafe velocity tracks runRate and clamps identically', () => {
    // 0-Run character strafes at ~1x its base rate (retail), not 2x.
    expect(strafeSpeed(2.0) / strafeSpeed(1.0)).toBeCloseTo(2.0, 6);
    // High Run: clamped, so raising runRate further changes nothing.
    expect(strafeSpeed(9.0)).toBeCloseTo(strafeSpeed(4.5), 6);
    expect(strafeSpeed(4.5)).toBeGreaterThan(strafeSpeed(1.0));
  });
});
