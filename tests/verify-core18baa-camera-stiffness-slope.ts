/**
 * CORE.18.b.a.a — the remaining retail camera-rig pieces (acclient.exe):
 *   - CameraManager::UpdateCamera @ 00456660: the viewer frame eases toward
 *     its target by stiffness × dt × 10 (t_stiffness / r_stiffness), snapping
 *     at 1 − F_EPSILON; ALIGN_WITH_PLANE tilts the offset frame's heading along
 *     the contact plane while the averaged velocity (old_velocities[5]) is
 *     non-trivial on both horizontal axes.
 *   - CameraSet::Closer / Farther: a tick scales the offset by
 *     1 ∓ elapsed × m_rCameraAdjustmentSpeed × 0.2; a wheel notch's tick is
 *     1 / SceneTool::m_FramesPerSecond (the 20-frame average); offsets at or
 *     below z −1.8 force stiffness 1.
 *   - CameraSet::SetInHead forces translational stiffness 1; SetStiffness in
 *     the head only sets the rotational one.
 *   - SmartBox::PlayerPositionUpdated → set_viewer(player position): after a
 *     teleport the viewer eases out from the player's own frame.
 *
 * Drives the real RetailCamera / RetailCameraRig / CameraController.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { CameraController } from '../packages/renderer/src/scene/CameraController.js';
import { RetailCameraRig, type RigInput } from '../packages/renderer/src/scene/RetailCameraRig.js';
import {
  CAMERA_DEFAULT_PIVOT_Z, DEFAULT_VIEWER_BACK, DEFAULT_VIEWER_UP, F_EPSILON, FrameRateMeter,
  SlopeAlignment, offsetAlignsWithPlane, stiffnessBlend, zoomStepFactor,
} from '../packages/renderer/src/scene/RetailCamera.js';

function rigInput(over: Partial<RigInput> = {}): RigInput {
  return {
    pivot: new THREE.Vector3(0, CAMERA_DEFAULT_PIVOT_Z, 0), facing: 0,
    back: DEFAULT_VIEWER_BACK, up: DEFAULT_VIEWER_UP, inHead: false, inHeadAhead: 0.18,
    lookPitch: 0, align: false, velocity: { x: 0, y: 0, z: 0 },
    contactNormal: { x: 0, y: 1, z: 0 }, tStiffness: 0.45, rStiffness: 0.45, dt: 1 / 60,
    ...over,
  };
}

/** A slope rising toward −z (the facing-0 forward) at `deg` degrees. */
function slopeNormal(deg: number): { x: number; y: number; z: number } {
  const a = deg * Math.PI / 180;
  return { x: 0, y: Math.cos(a), z: Math.sin(a) };
}

describe('CORE.18.b.a.a — stiffness blend and zoom tick', () => {
  it('stiffness × dt × 10, clamped to 1, snapping at 1 − F_EPSILON', () => {
    expect(stiffnessBlend(0.45, 1 / 60)).toBeCloseTo(0.075, 9);
    expect(stiffnessBlend(0.2857143, 1 / 30)).toBeCloseTo(0.095238, 5);
    expect(stiffnessBlend(0.45, 0.5)).toBe(1);
    expect(stiffnessBlend(1, 1 / 60)).toBe(1);
    expect(stiffnessBlend(1 - F_EPSILON / 2, 1 / 60)).toBe(1);
    expect(stiffnessBlend(0.99, 1 / 60)).toBeCloseTo(0.165, 9);
  });

  it('zoom tick: 1 ∓ elapsed × speed × 0.2; refused under F_EPSILON', () => {
    expect(zoomStepFactor(true, 1 / 60, 40)).toBeCloseTo(1 - 8 / 60, 9);
    expect(zoomStepFactor(false, 1 / 60, 40)).toBeCloseTo(1 + 8 / 60, 9);
    expect(zoomStepFactor(true, 0.1, 50)).toBeCloseTo(0, 9);
    expect(zoomStepFactor(true, F_EPSILON / 2, 40)).toBeNull();
  });

  it('m_FramesPerSecond is 20 / the sum of the last 20 frame times', () => {
    const m = new FrameRateMeter();
    expect(m.fps).toBe(0);
    for (let i = 0; i < 40; i++) m.push(1 / 30);
    expect(m.fps).toBeCloseTo(30, 6);
    for (let i = 0; i < 10; i++) m.push(1 / 60);
    // 10 frames at 1/60 + 10 at 1/30 = 0.5 s → 40 fps.
    expect(m.fps).toBeCloseTo(40, 6);
  });
});

describe('CORE.18.b.a.a — ALIGN_WITH_PLANE', () => {
  it('SetTargetForOffset aligns an offset behind the pivot (|x| < 1, y < 0) and the in-head offset', () => {
    expect(offsetAlignsWithPlane(0, -2.75, false)).toBe(true);
    expect(offsetAlignsWithPlane(1.2, -2.75, false)).toBe(false);
    expect(offsetAlignsWithPlane(0, 0.5, false)).toBe(false);
    expect(offsetAlignsWithPlane(0, 0.18, true)).toBe(true);
  });

  it('averages up to five velocity samples', () => {
    const s = new SlopeAlignment();
    expect(s.push({ x: 5, y: 0, z: 0 }).x).toBe(5);
    expect(s.push({ x: 0, y: 0, z: 0 }).x).toBe(2.5);
    for (let i = 0; i < 4; i++) s.push({ x: 0, y: 0, z: 0 });
    expect(s.push({ x: 10, y: 0, z: 0 }).x).toBeCloseTo(2, 9); // [0,0,0,0,10] / 5
  });

  it('standing still or moving along a world axis keeps the level heading; level flight out of contact stays level', () => {
    const fwd = { x: 0, y: 0, z: -1 };
    const n = slopeNormal(20);
    expect(SlopeAlignment.alignedForward(fwd, { x: 0, y: 0, z: 0 }, n)).toBeNull();
    expect(SlopeAlignment.alignedForward(fwd, { x: 0, y: 0, z: -4 }, n)).toBeNull();
    // CORE.18.b.a.a.a — out of contact the plane comes from the velocity; a
    // horizontal velocity gives the world-up plane, i.e. the level forward.
    const air = SlopeAlignment.alignedForward(fwd, { x: 1, y: 0, z: -4 }, null)!;
    expect(air.x).toBeCloseTo(0, 9);
    expect(air.y).toBeCloseTo(0, 9);
    expect(air.z).toBeCloseTo(-1, 9);
  });

  it('moving on a slope tilts the heading along it: forward − (forward·N) N', () => {
    const f = SlopeAlignment.alignedForward({ x: 0, y: 0, z: -1 }, { x: 0.3, y: 0, z: -4 }, slopeNormal(20))!;
    expect(Math.atan2(f.y, -f.z) * 180 / Math.PI).toBeCloseTo(20, 6); // climbs at the slope's angle
    expect(Math.hypot(f.x, f.y, f.z)).toBeCloseTo(1, 9);
  });

  it('running uphill puts the viewer lower behind the pivot and looks up the slope', () => {
    const rig = new RetailCameraRig();
    const moving = { x: 0.5, y: 0, z: -5 };
    for (let i = 0; i < 5; i++) {
      rig.update(rigInput({ align: true, velocity: moving, contactNormal: slopeNormal(20), up: 0.5 }));
    }
    const aligned = rig.targetPosition.clone();
    const alignedPitch = new THREE.Euler().setFromQuaternion(rig.targetQuaternion, 'YXZ').x;
    const flat = new RetailCameraRig();
    flat.update(rigInput({ align: false, up: 0.5 }));
    expect(aligned.y).toBeLessThan(flat.targetPosition.y);
    expect(alignedPitch * 180 / Math.PI).toBeCloseTo(20, 4);
    expect(new THREE.Euler().setFromQuaternion(flat.targetQuaternion, 'YXZ').x).toBeCloseTo(0, 9);
  });
});

describe('CORE.18.b.a.a — the viewer eases toward its target', () => {
  it('the first update snaps; later ones move the committed viewer by the stiffness blend', () => {
    const rig = new RetailCameraRig();
    rig.update(rigInput());
    expect(rig.soughtPosition.distanceTo(rig.targetPosition)).toBe(0);
    rig.commit(rig.soughtPosition);
    const before = rig.soughtPosition.clone();
    rig.update(rigInput({ pivot: new THREE.Vector3(4, CAMERA_DEFAULT_PIVOT_Z, 0) }));
    const gap = rig.targetPosition.x - before.x;
    expect(rig.soughtPosition.x - before.x).toBeCloseTo(gap * 0.075, 9);
  });

  it('a running player drags the camera back: a steady lag of speed / (stiffness × 10)', () => {
    const rig = new RetailCameraRig();
    const speed = 6;
    let x = 0;
    for (let i = 0; i < 600; i++) {
      x += speed / 60;
      rig.update(rigInput({ pivot: new THREE.Vector3(x, CAMERA_DEFAULT_PIVOT_Z, 0) }));
      rig.commit(rig.soughtPosition);
    }
    // Discrete steady state: gap × blend = speed × dt × (1 − blend) → lag = v·dt·(1 − b) / b.
    const b = 0.075;
    expect(rig.targetPosition.x - rig.soughtPosition.x).toBeCloseTo(speed / 60 * (1 - b) / b, 6);
  });

  it('the rotation eases at r_stiffness when the heading turns', () => {
    const rig = new RetailCameraRig();
    rig.update(rigInput({ up: 0.5 }));
    rig.commit(rig.soughtPosition);
    rig.update(rigInput({ up: 0.5, facing: 1 }));
    const yaw = new THREE.Euler().setFromQuaternion(rig.soughtQuaternion, 'YXZ').y;
    expect(yaw).toBeCloseTo(0.075, 3);
  });

  it('the collision sweep runs from the pivot toward the viewer — behind the player, not ahead', () => {
    const rig = new RetailCameraRig();
    const pivot = new THREE.Vector3(10, CAMERA_DEFAULT_PIVOT_Z, 20);
    rig.update(rigInput({ pivot }));
    const sweep = rig.sweepFrom(pivot);
    // facing 0 looks toward −z, so behind is +z and the boom rises 0.825 m.
    expect(sweep.z).toBeCloseTo(DEFAULT_VIEWER_BACK, 9);
    expect(sweep.y).toBeCloseTo(DEFAULT_VIEWER_UP, 9);
    expect(sweep.x).toBeCloseTo(0, 9);
    expect(pivot.clone().add(sweep).distanceTo(rig.soughtPosition)).toBeLessThan(1e-9);
  });

  it('after a teleport the viewer starts on the player and eases out', () => {
    const rig = new RetailCameraRig();
    const feet = new THREE.Vector3(100, 20, 50);
    rig.snapTo(feet, 0);
    rig.update(rigInput({ pivot: new THREE.Vector3(100, 20 + CAMERA_DEFAULT_PIVOT_Z, 50) }));
    const expected = feet.clone().lerp(rig.targetPosition, 0.075);
    expect(rig.soughtPosition.distanceTo(expected)).toBeLessThan(1e-9);
  });
});

describe('CORE.18.b.a.a — CameraController stiffness rules', () => {
  function make(): CameraController {
    const c = new CameraController(new THREE.PerspectiveCamera());
    for (let i = 0; i < 20; i++) c.frameRate.push(1 / 60);
    return c;
  }

  it('SetInHead forces translational stiffness 1; SetStiffness in the head only moves the rotational one', () => {
    const c = make();
    c.enterHead();
    expect(c.tStiffness).toBe(1);
    expect(c.rStiffness).toBe(0.45);
    c.setStiffness(0.7);
    expect(c.tStiffness).toBe(1);
    expect(c.rStiffness).toBe(0.7);
    c.zoomBy(1); // Farther out of the head restores current_stiffness on both
    expect(c.tStiffness).toBe(0.7);
    expect(c.rStiffness).toBe(0.7);
  });

  it('an offset at or below z −1.8 forces stiffness 1; back above restores current', () => {
    const c = make();
    for (let i = 0; i < 12; i++) c.zoomBy(1); // ≈ 10 m boom
    // Retail mouse-look (held middle button): mouse DOWN is CameraSet::Lower,
    // the viewer sinks around the pivot; the 6th consecutive call acts.
    let t = 100; c.clock = () => (t += 1 / 60);
    c.setMouseLook(true);
    for (let i = 0; i < 6; i++) { c.simulateMouseMove(0, 250); c.update(1 / 60); }
    c.setMouseLook(false);
    const { up } = c.thirdPersonBoom();
    expect(up).toBeLessThanOrEqual(-1.8);
    expect(c.tStiffness).toBe(1);
    expect(c.rStiffness).toBe(1);
    c.resetZoom();
    c.update(1 / 60);
    expect(c.tStiffness).toBe(0.45);
  });

  it('Camera.AlignToSlope defaults on', () => {
    expect(make().alignToSlope).toBe(true);
  });
});
