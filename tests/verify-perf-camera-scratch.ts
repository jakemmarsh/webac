/**
 * ASSESS: CameraController.update() used to allocate 3-7 THREE.Vector3 per
 * frame (fresh-eyes audit 2026-06-10 §performance). The math now runs on
 * instance-scoped scratch vectors. These tests pin (a) movement math is
 * byte-identical to the ACE MotionInterp formulas the old allocating code
 * computed, and (b) no state aliases across frames through the reused
 * scratch vectors (idle frames move nothing, split frames sum exactly).
 *
 * Speed constants per ACE MotionInterp (reference/ACE/Source/
 * ACE.Server/Physics/Animation/MotionInterp.cs): RunAnimSpeed 4.0,
 * WalkAnimSpeed 3.12, BackwardsFactor 0.65, SidestepAnimSpeed 1.25,
 * SidestepFactor 0.5, MaxSidestepAnimRate 3.0.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { CameraController } from '@ac/renderer/scene/CameraController.js';

const RUN_ANIM_SPEED = 4.0;
const WALK_ANIM_SPEED = 3.12;
const BACKWARDS_FACTOR = 0.65;
const SIDESTEP_ANIM_SPEED = 1.25;
const SIDESTEP_FACTOR = 0.5;

function makeController(): CameraController {
  const camera = new THREE.PerspectiveCamera(90, 1, 0.1, 1000);
  return new CameraController(camera);
}

describe('CameraController movement math (scratch-vector refactor)', () => {
  it('forward run moves -Z at RunAnimSpeed × runRate (yaw 0)', () => {
    const c = makeController();
    c.runRate = 1.5;
    c.simulateKeyDown('KeyW');
    c.update(0.5);
    expect(c.camera.position.x).toBeCloseTo(0, 6);
    expect(c.camera.position.z).toBeCloseTo(-RUN_ANIM_SPEED * 1.5 * 0.5, 6);
  });

  it('forward walk (shift with run-default) moves at WalkAnimSpeed', () => {
    const c = makeController();
    c.simulateKeyDown('KeyW');
    c.simulateKeyDown('ShiftLeft');
    c.update(1.0);
    expect(c.camera.position.z).toBeCloseTo(-WALK_ANIM_SPEED, 6);
  });

  it('backward run moves +Z at WalkAnimSpeed × BackwardsFactor × runRate', () => {
    const c = makeController();
    c.runRate = 2.0;
    c.simulateKeyDown('KeyS');
    c.update(1.0);
    expect(c.camera.position.z).toBeCloseTo(WALK_ANIM_SPEED * BACKWARDS_FACTOR * 2.0, 6);
  });

  it('walking strafe moves ±X at SidestepAnimSpeed × SidestepFactor × (Walk/Sidestep)', () => {
    const c = makeController();
    c.simulateKeyDown('KeyZ'); // strafe left
    c.simulateKeyDown('ShiftLeft'); // walk
    c.update(1.0);
    const walkStrafeSpeed = SIDESTEP_ANIM_SPEED * (SIDESTEP_FACTOR * (WALK_ANIM_SPEED / SIDESTEP_ANIM_SPEED));
    // CORE.18 — yaw 0 faces AC south (−Z); the player's left is AC east (+X).
    expect(c.camera.position.x).toBeCloseTo(walkStrafeSpeed, 6);
    expect(c.camera.position.z).toBeCloseTo(0, 6);
  });

  it('forward + strafe add independently (AC sliding)', () => {
    const c = makeController();
    c.simulateKeyDown('KeyW');
    c.simulateKeyDown('KeyC'); // strafe right
    c.simulateKeyDown('ShiftLeft'); // walk both
    c.update(1.0);
    const walkStrafeSpeed = SIDESTEP_ANIM_SPEED * (SIDESTEP_FACTOR * (WALK_ANIM_SPEED / SIDESTEP_ANIM_SPEED));
    expect(c.camera.position.z).toBeCloseTo(-WALK_ANIM_SPEED, 6);
    // CORE.18 — facing AC south, strafe right heads AC west (−X).
    expect(c.camera.position.x).toBeCloseTo(-walkStrafeSpeed, 6);
  });

  it('movement honors player yaw direction', () => {
    const c = makeController();
    c.playerYaw = Math.PI / 2; // facing -X
    c.simulateKeyDown('KeyW');
    c.update(1.0);
    expect(c.camera.position.x).toBeCloseTo(-RUN_ANIM_SPEED, 5);
    expect(c.camera.position.z).toBeCloseTo(0, 5);
  });
});

describe('CameraController scratch vectors do not alias across frames', () => {
  it('an idle frame after a moving frame moves nothing (move vector fully reset)', () => {
    const c = makeController();
    c.simulateKeyDown('KeyW');
    c.update(1.0);
    const afterMove = c.camera.position.clone();
    c.simulateKeyUp('KeyW');
    c.update(1.0);
    c.update(1.0);
    expect(c.camera.position.x).toBe(afterMove.x);
    expect(c.camera.position.y).toBe(afterMove.y);
    expect(c.camera.position.z).toBe(afterMove.z);
  });

  it('two half-frames equal one full frame exactly (no residue in scratch state)', () => {
    const a = makeController();
    a.simulateKeyDown('KeyW');
    a.simulateKeyDown('KeyC');
    a.update(0.25);
    a.update(0.25);

    const b = makeController();
    b.simulateKeyDown('KeyW');
    b.simulateKeyDown('KeyC');
    b.update(0.5);

    expect(a.camera.position.x).toBeCloseTo(b.camera.position.x, 10);
    expect(a.camera.position.z).toBeCloseTo(b.camera.position.z, 10);
  });

  it('direction changes between frames use fresh forward/right vectors', () => {
    const c = makeController();
    c.simulateKeyDown('KeyW');
    c.update(1.0); // yaw 0 → -Z
    c.playerYaw = Math.PI; // about-face → +Z
    c.update(1.0);
    // the two frames cancel on Z, nothing bleeds onto X
    expect(c.camera.position.z).toBeCloseTo(0, 5);
    expect(c.camera.position.x).toBeCloseTo(0, 5);
  });

  it('1000 idle updates allocate no movement drift', () => {
    const c = makeController();
    for (let i = 0; i < 1000; i++) c.update(0.016);
    expect(c.camera.position.length()).toBe(0);
  });
});
