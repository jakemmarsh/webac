/**
 * VISUAL3.69 / CORE.18.b.a.a — Config "Camera Options" drive the live camera.
 *
 * Camera Stiffness (Camera.Stiffness, retail units 0.2857..1, default 0.45)
 * → CameraController.setStiffness = CameraSet::SetStiffness @ 004577f0: the
 * viewer frame's t / r_stiffness, which RetailCameraRig blends by
 * stiffness × dt × 10 per update (CameraManager::UpdateCamera @ 00456660).
 * Camera Adjustment Speed (Camera.AdjustmentSpeed 5..80, default 40) scales
 * the Closer / Farther zoom tick.
 *
 * BEHAVIORAL: the real CameraController and RetailCameraRig (THREE is
 * headless-safe).
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { CameraController } from '../packages/renderer/src/scene/CameraController.js';
import { RetailCameraRig } from '../packages/renderer/src/scene/RetailCameraRig.js';
import { CAMERA_DEFAULT_PIVOT_Z } from '../packages/renderer/src/scene/RetailCamera.js';

function make(): CameraController {
  const cc = new CameraController(new THREE.PerspectiveCamera(75, 1, 0.1, 1000));
  for (let i = 0; i < 20; i++) cc.frameRate.push(1 / 60);
  return cc;
}

/** One rig update for `cc` with the player at `x`; returns the sought viewer. */
function rigStep(rig: RetailCameraRig, cc: CameraController, x: number): THREE.Vector3 {
  const boom = cc.thirdPersonBoom();
  rig.update({
    pivot: new THREE.Vector3(x, CAMERA_DEFAULT_PIVOT_Z, 0), facing: 0, back: boom.back, up: boom.up,
    inHead: cc.isFirstPerson, inHeadAhead: 0.18, lookPitch: 0,
    align: false, velocity: { x: 0, y: 0, z: 0 }, contactNormal: null,
    tStiffness: cc.tStiffness, rStiffness: cc.rStiffness, dt: 1 / 60,
  });
  rig.commit(rig.soughtPosition);
  return rig.soughtPosition.clone();
}

describe('Camera Options drive the retail camera', () => {
  it('the stiffness defaults to 0.45 on both axes and follows setStiffness', () => {
    const cc = make();
    expect(cc.cameraStiffness).toBe(0.45);
    expect(cc.tStiffness).toBe(0.45);
    expect(cc.rStiffness).toBe(0.45);
    cc.setStiffness(0.9);
    expect(cc.tStiffness).toBe(0.9);
    expect(cc.rStiffness).toBe(0.9);
    cc.setStiffness(2); // SetTranslationalStiffness rejects outside [0, 1]
    expect(cc.cameraStiffness).toBe(0.9);
  });

  it('a stiffer camera closes more of the gap to a moved player per frame', () => {
    const moved = (stiffness: number) => {
      const cc = make();
      cc.setStiffness(stiffness);
      const rig = new RetailCameraRig();
      const start = rigStep(rig, cc, 0);
      const next = rigStep(rig, cc, 5); // the player jumped 5 m east
      return (next.x - start.x) / 5;
    };
    expect(moved(0.45)).toBeCloseTo(0.45 * 10 / 60, 6);
    expect(moved(0.2857143)).toBeCloseTo(0.2857143 * 10 / 60, 6);
    expect(moved(1)).toBeCloseTo(1, 6); // at 1 the viewer snaps
  });

  it('the adjustment speed scales the zoom tick', () => {
    const slow = make(); slow.adjustmentSpeed = 5;
    const fast = make(); fast.adjustmentSpeed = 80;
    const home = slow.cameraDistance;
    slow.zoomBy(1); fast.zoomBy(1);
    expect(slow.cameraDistance / home).toBeCloseTo(1 + 5 * 0.2 / 60, 6);
    expect(fast.cameraDistance / home).toBeCloseTo(1 + 80 * 0.2 / 60, 6);
  });
});
