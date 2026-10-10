/**
 * CORE.18.b — the default 3rd-person camera is the retail rig, and the world
 * projection is retail's.
 *
 * acclient.exe: CameraSet::SetDefaultOffsets @ 00458f80 (pivot 1.5 m, viewer
 * (0, −2.5, 0.75)), gmGamePlayUI::UseTime @ 004ea3a0 (SetScale 1.1),
 * CameraSet::SetTargetForOffset @ 004576e0 (z > 0.75 → LOOK_AT_PIVOT),
 * CameraSet::Farther / Closer (× (1 ± 0.2), CAMERA_FAR_LIMIT 10),
 * SmartBox → Render::SetFOVRad(m_fGameFOV / (aspect − 0.1)) as the vertical
 * angle (PrimD3DRender::SetFOVInternal → D3DXMatrixPerspectiveFovLH).
 *
 * Drives the real CameraController / SceneManager / collision classes and
 * checks the composed frame against the retail 1600x900 A/B capture
 * (verification/retail-client/ab/retail-holtburg.png: horizon ≈ y 200, the
 * character's hat ≈ y 345, boots ≈ y 870).
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { CameraController } from '../packages/renderer/src/scene/CameraController.js';
import { RetailCameraRig } from '../packages/renderer/src/scene/RetailCameraRig.js';
import { SceneManager } from '../packages/renderer/src/scene/SceneManager.js';
import { DungeonCollision } from '../packages/renderer/src/world/DungeonCollision.js';
import { TerrainCollision } from '@ac/shared/physics/TerrainCollision.js';
import {
  CAMERA_DEFAULT_PIVOT_Z, DEFAULT_VIEWER_BACK, DEFAULT_VIEWER_UP, DEFAULT_VIEWER_ELEVATION,
  looksAtPivot, retailVerticalFovDeg, viewPitchForOffset,
} from '../packages/renderer/src/scene/RetailCamera.js';

/** A controller whose frame-rate meter has 60 fps of history (the zoom tick is 1 / fps). */
function at60(c: CameraController): CameraController {
  for (let i = 0; i < 20; i++) c.frameRate.push(1 / 60);
  return c;
}

function settle(c: CameraController, frames = 300): void {
  for (let i = 0; i < frames; i++) c.update(1 / 60);
}

/**
 * Compose the frame the way main.ts does: feet at the origin, facing yaw 0,
 * the camera on the boom from the pivot, rotated by the controller.
 */
function composedCamera(c: CameraController, sm: SceneManager): THREE.PerspectiveCamera {
  const cam = sm.camera;
  const boom = c.thirdPersonBoom();
  const yaw = c.yaw;
  cam.position.set(Math.sin(yaw) * boom.back, CAMERA_DEFAULT_PIVOT_Z + boom.up, Math.cos(yaw) * boom.back);
  cam.rotation.set(c.viewPitch, yaw, 0, 'YXZ');
  cam.updateMatrixWorld(true);
  return cam;
}

function screenY(cam: THREE.PerspectiveCamera, p: THREE.Vector3, h: number): number {
  const v = p.clone().project(cam);
  return (1 - v.y) / 2 * h;
}

describe('CORE.18.b — retail camera constants and targeting', () => {
  it('the in-world default offset is SetDefaultOffsets × SetScale(1.1)', () => {
    expect(DEFAULT_VIEWER_BACK).toBeCloseTo(2.75, 6);
    expect(DEFAULT_VIEWER_UP).toBeCloseTo(0.825, 6);
    expect(CAMERA_DEFAULT_PIVOT_Z).toBe(1.5);
  });

  it('SetTargetForOffset: above 0.75 or below −0.5 looks at the pivot, the band between looks level', () => {
    expect(looksAtPivot(0.825)).toBe(true);
    expect(looksAtPivot(0.75)).toBe(false);
    expect(looksAtPivot(0)).toBe(false);
    expect(looksAtPivot(-0.5)).toBe(false);
    expect(looksAtPivot(-0.6)).toBe(true);
    expect(viewPitchForOffset(3, 0.5)).toBeCloseTo(-0.5, 9);
    expect(viewPitchForOffset(3, 0.1)).toBe(0);
  });

  it('the default view looks 16.7° down at the pivot', () => {
    const c = new CameraController(new THREE.PerspectiveCamera());
    settle(c);
    expect(c.viewPitch).toBeCloseTo(-Math.atan(0.3), 4);
    expect(c.viewPitch * 180 / Math.PI).toBeCloseTo(-16.7, 1);
  });

  it('lowering the viewer into the level band turns the view level (the target at once, the view eased at r_stiffness)', () => {
    const c = new CameraController(new THREE.PerspectiveCamera());
    settle(c);
    const rig = new RetailCameraRig();
    const pivot = new THREE.Vector3(0, CAMERA_DEFAULT_PIVOT_Z, 0);
    const step = () => {
      const boom = c.thirdPersonBoom();
      rig.update({
        pivot, facing: 0, back: boom.back, up: boom.up, inHead: false, inHeadAhead: 0.18,
        lookPitch: 0, align: false, velocity: { x: 0, y: 0, z: 0 },
        contactNormal: null, tStiffness: c.tStiffness, rStiffness: c.rStiffness, dt: 1 / 60,
      });
      rig.commit(rig.soughtPosition);
      return new THREE.Euler().setFromQuaternion(rig.soughtQuaternion, 'YXZ').x;
    };
    expect(step()).toBeCloseTo(-DEFAULT_VIEWER_ELEVATION, 4);
    // Mouse up raises the look (pitch +) = lowers the viewer around the pivot.
    c.pitch = DEFAULT_VIEWER_ELEVATION - 0.1; // elevation 0.1 rad → up ≈ 0.29 m
    c.update(1 / 60);
    expect(c.viewPitch).toBe(0);                   // SetTargetForOffset: level target
    const first = step();
    expect(first).toBeLessThan(0);                 // the view is still easing
    expect(first).toBeGreaterThan(-DEFAULT_VIEWER_ELEVATION);
    for (let i = 0; i < 300; i++) step();
    expect(step()).toBeCloseTo(0, 4);
  });

  it('the boom never passes under the pivot plane inside CAMERA_MIN_CHAR_GROUNDDIST', () => {
    const c = at60(new CameraController(new THREE.PerspectiveCamera()));
    let t = 100; c.clock = () => (t += 1 / 60);
    // Retail mouse-look (held middle button): mouse DOWN is CameraSet::Lower
    // (MouseLookHandler y > 0) — the viewer sinks, the view tilts up. Each
    // axis acts after 5 consecutive non-zero calls.
    const lower = () => { c.setMouseLook(true); for (let i = 0; i < 6; i++) { c.simulateMouseMove(0, 100000); c.update(1 / 60); } c.setMouseLook(false); };
    c.zoomBy(-3); settle(c); // ≈ 1.87 m boom
    lower();
    settle(c);
    const { back, up } = c.thirdPersonBoom();
    expect(up).toBeLessThan(0);
    expect(back).toBeCloseTo(1.2, 3);
    c.zoomBy(-4); settle(c); // ≈ 1.05 m, inside 1.2 → cannot go under
    lower(); settle(c);
    expect(c.thirdPersonBoom().up).toBeGreaterThanOrEqual(-1e-9);
  });
});

describe('CORE.18.b — retail world projection', () => {
  it('vertical FOV = GameFOV / (aspect − 0.1): 90 at 16:9 → 53.6°', () => {
    expect(retailVerticalFovDeg(90, 1600 / 900)).toBeCloseTo(53.64, 2);
    expect(retailVerticalFovDeg(90, 4 / 3)).toBeCloseTo(72.97, 2);
    // SetFOVRad rejects angles outside (0, π): keep the previous projection.
    expect(retailVerticalFovDeg(90, 0.5)).toBeNull();
  });

  it('SceneManager applies it on resize and on a Field of View change', () => {
    const sm = new SceneManager();
    sm.resize(1600, 900);
    expect(sm.camera.fov).toBeCloseTo(53.64, 2);
    expect(sm.gameFov).toBe(90);
    sm.setGameFov(120);
    expect(sm.camera.fov).toBeCloseTo(71.52, 2);
    sm.resize(1024, 768);
    expect(sm.camera.fov).toBeCloseTo(retailVerticalFovDeg(120, 1024 / 768)!, 6);
    const before = sm.camera.fov;
    sm.resize(400, 900); // aspect 0.44 → out of range → rejected
    expect(sm.camera.fov).toBe(before);
  });

  it('the composed default frame matches the retail 1600x900 capture', () => {
    const sm = new SceneManager();
    sm.resize(1600, 900);
    const c = new CameraController(sm.camera);
    settle(c);
    const cam = composedCamera(c, sm);
    // The player faces yaw 0 → forward is (−sin 0, 0, −cos 0) = −z.
    const horizon = screenY(cam, new THREE.Vector3(0, CAMERA_DEFAULT_PIVOT_Z + DEFAULT_VIEWER_UP, -1e5), 900);
    const boots = screenY(cam, new THREE.Vector3(0, 0, 0), 900);
    const hat = screenY(cam, new THREE.Vector3(0, 1.9, 0), 900);
    // Retail: horizon ≈ 200, hat ≈ 345, boots ≈ 870 (the old 5 m / 90°-vertical
    // camera put the horizon at 450 and the character at 450–615).
    expect(horizon).toBeGreaterThan(160);
    expect(horizon).toBeLessThan(230);
    expect(hat).toBeGreaterThan(300);
    expect(hat).toBeLessThan(380);
    expect(boots).toBeGreaterThan(800);
    expect(boots).toBeLessThan(900);
  });
});

describe('CORE.18.b — the rising boom collides along its own direction', () => {
  it('terrain: a flat plane under a rising boom never clips it; a descending one clips where it meets the ground', () => {
    const tc = new TerrainCollision();
    tc.setLandblock(0, 0, { heights: new Array<number>(81).fill(0), blockX: 0, blockY: 0 });
    // Pivot 1.5 m up, boom rising 0.3 m per metre back.
    expect(tc.getCameraDistance(96, 1.5, 96, 0, 2.75, 2.871, 0.825)).toBe(2.871);
    // Boom falling 1 m per metre back from 1.5 m: sphere (r 0.3) meets the
    // ground where 1.5 − s = 0.3 along the ground, s = 1.2 → boom 1.2·√2.
    const d = tc.getCameraDistance(96, 1.5, 96, 0, 1, 4, -1);
    expect(d).toBeCloseTo(1.2 * Math.SQRT2, 2);
    // behindY omitted = the old horizontal boom.
    expect(tc.getCameraDistance(96, 1.5, 96, 0, 1, 4)).toBe(4);
  });

  it('cylinders: the horizontal entry distance is converted to boom length', () => {
    const c = new DungeonCollision();
    c.addCylinderObstacle(1, 0, 3, 1); // centre 3 m behind, radius 1 (+0.25 pad)
    const pivot = new THREE.Vector3(0, 1.5, 0);
    const flat = c.getCameraDistance(pivot, 0, 3, 5);
    const rising = c.getCameraDistance(pivot, 0, 3, 5, 3); // 45° boom
    // Entry at 1.75 m of ground track; the 45° boom reaches it at 1.75·√2.
    expect(flat).toBeCloseTo(1.75 - 0.3, 5);
    expect(rising).toBeCloseTo(1.75 * Math.SQRT2 - 0.3, 5);
  });
});
