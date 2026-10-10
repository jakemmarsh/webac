/**
 * BUG.diagonal-run-velocity-unclamped: combined forward+strafe velocity must
 * be clamped to RunAnimSpeed × runRate, exactly as ACE's get_state_velocity
 * (MotionInterp.cs:678-700) does after building the per-axis vector:
 *
 *   var maxSpeed = RunAnimSpeed * rate;
 *   if (velocity.Length() > maxSpeed) velocity = Normalize(velocity) * maxSpeed;
 *
 * Pre-fix the client summed the axes independently, so running diagonally
 * (W + Z/C) moved √(4.0² + 1.56²) = 4.293 m/s at runRate 1.0 instead of 4.0 —
 * ~7% faster than the server-authoritative speed, causing rubber-banding.
 *
 * Behavioral: drives the real CameraController and measures displacement.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { CameraController } from '../packages/renderer/src/scene/CameraController.js';
import { RUN_ANIM_SPEED } from '../packages/shared/src/index.js';

/** Metres travelled horizontally in 1 simulated second. */
function travel(runRate: number, keys: string[], running = true): number {
  const camera = new THREE.PerspectiveCamera(60, 1.6, 0.1, 1000);
  const cc = new CameraController(camera);
  cc.runRate = runRate;
  cc.runIsDefault = running;
  for (const key of keys) cc.simulateKeyDown(key);
  const start = camera.position.clone();
  for (let i = 0; i < 100; i++) cc.update(0.01);
  return Math.hypot(camera.position.x - start.x, camera.position.z - start.z);
}

describe('BUG.diagonal-run-velocity-unclamped: ACE combined-velocity clamp', () => {
  it('diagonal run (W+C) travels exactly RunAnimSpeed × runRate, not the vector sum', () => {
    // runRate 1.0: unclamped would be √(4.0² + 1.56²) = 4.293
    expect(travel(1.0, ['KeyW', 'KeyC'])).toBeCloseTo(4.0, 6);
    // runRate 2.65: unclamped would be √(10.6² + 3.75²) = 11.24
    expect(travel(2.65, ['KeyW', 'KeyC'])).toBeCloseTo(RUN_ANIM_SPEED * 2.65, 6);
  });

  it('diagonal run with left strafe (W+Z) is clamped identically', () => {
    expect(travel(1.0, ['KeyW', 'KeyZ'])).toBeCloseTo(4.0, 6);
  });

  it('straight-line run is unaffected by the clamp', () => {
    expect(travel(1.0, ['KeyW'])).toBeCloseTo(4.0, 6);
    expect(travel(2.65, ['KeyW'])).toBeCloseTo(10.6, 6);
  });

  it('walking diagonal stays under the cap and is untouched (ACE clamps unconditionally)', () => {
    // walk 3.12 + strafe 1.56 → √(3.12² + 1.56²) = 3.488 < 4.0 × runRate
    expect(travel(1.0, ['KeyW', 'KeyC'], false)).toBeCloseTo(Math.hypot(3.12, 1.56), 6);
  });

  it('backward+strafe run stays under the cap (no distortion from the clamp)', () => {
    // back 3.12×0.65×r + strafe: at runRate 1.0 → √(2.028² + 1.56²) = 2.559 < 4.0
    expect(travel(1.0, ['KeyS', 'KeyC'])).toBeCloseTo(Math.hypot(3.12 * 0.65, 1.56), 6);
  });
});
