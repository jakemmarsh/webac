/**
 * CORE.18.b.a.a.a.a — the last retail camera-rig modes:
 *   - CameraSet::LookDown @ 00457ff0 (Overhead View, action 0x3b, Numpad5):
 *     viewer_offset (0, −2, 0.75), direction (0, 0.5, −1.8), LOOK_IN_DIRECTION
 *     only; the saved offset comes back on the way out; Closer / Farther /
 *     Rotate / SetInHead / SetDefaultOffsets end it; Raise / Lower slide it
 *     (corrected by CORE.18.b.a.a.a.a.a — see verify-core18baaaaa-camera-keys.ts).
 *   - CameraSet::Rotate @ 00458310 in the head: TurnToHeading(heading ±
 *     CAMERA_TURN_INCREMENT) — mouse-look turns the player, not the view.
 *   - CameraSet::SetTargetForOffset's targeting branch (LOOK_AT_PIVOT |
 *     LOOK_AT_OBJECT): UpdateCamera heads the offset frame from the pivot
 *     toward the tracked object and looks at the pivot;
 *     ClientCombatSystem::UpdateTargetTracking's gate.
 * Behavioral: drives the shipped RetailCamera / RetailCameraRig /
 * CameraController / InteractionSystem code.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { CombatMode, ItemType, ObjectDescriptionFlag } from '@ac/shared';
import { CameraController } from '../packages/renderer/src/scene/CameraController.js';
import { RetailCameraRig, type RigInput } from '../packages/renderer/src/scene/RetailCameraRig.js';
import {
  CAMERA_DEFAULT_PIVOT_Z, CAMERA_DEFAULT_STIFFNESS, CAMERA_ROTATE_RADIANS, CAMERA_TURN_INCREMENT, DEFAULT_VIEWER_BACK, DEFAULT_VIEWER_UP, MOUSE_LOOK_SCALE,
  LOOK_DOWN_OFFSET, LOOK_DOWN_PITCH, TRACK_TARGET_OFFSET_Z, targetForOffset,
} from '../packages/renderer/src/scene/RetailCamera.js';
import { tracksCombatTarget } from '../packages/renderer/src/input/InteractionSystem.js';
import { ACT } from '../packages/renderer/src/input/KeybindDefaults.js';

const DEG = Math.PI / 180;

function rigInput(over: Partial<RigInput> = {}): RigInput {
  return {
    pivot: new THREE.Vector3(0, CAMERA_DEFAULT_PIVOT_Z, 0), facing: 0,
    back: DEFAULT_VIEWER_BACK, up: DEFAULT_VIEWER_UP, inHead: false, inHeadAhead: 0.18,
    lookPitch: 0, align: false, velocity: { x: 0, y: 0, z: 0 },
    contactNormal: { x: 0, y: 1, z: 0 }, tStiffness: 0.45, rStiffness: 0.45, dt: 1 / 60,
    ...over,
  };
}

const eulerOf = (q: THREE.Quaternion) => new THREE.Euler().setFromQuaternion(q, 'YXZ');

function controller(): CameraController {
  const cc = new CameraController(new THREE.PerspectiveCamera());
  cc.frameRate.push(1 / 60);
  // A clock that advances 1/60 s per read-heavy step (CameraSet's F_EPSILON
  // gates on elapsed Timer::cur_time).
  let t = 100;
  cc.clock = () => (t += 1 / 60);
  return cc;
}

/** CameraSet::MouseLookHandler's per-count magnitude at the default sensitivity (0.55 × 0.0667). */
const ML = 0.55 * MOUSE_LOOK_SCALE;

/**
 * Retail mouse-look: on (held middle button / F2), then `n` updates each
 * carrying (dx, dy). The first 5 non-zero calls per axis are the
 * mouselook_x/y_extent dead band; the 6th onward act.
 */
function look(cc: CameraController, dx: number, dy: number, n = 6): void {
  cc.setMouseLook(true);
  for (let i = 0; i < n; i++) { cc.simulateMouseMove(dx, dy); cc.update(1 / 60); }
}

describe('CORE.18.b.a.a.a.a — SetTargetForOffset modes', () => {
  it('looking down → LOOK_IN_DIRECTION only, ahead of every other test', () => {
    const lookOnly = { align: false, lookInDirection: true, lookAtPivot: false, lookAtObject: false };
    expect(targetForOffset(0, -2, 0.75, false, { lookingDown: true })).toEqual(lookOnly);
    expect(targetForOffset(0, 0.18, 0, true, { lookingDown: true })).toEqual(lookOnly);
    expect(targetForOffset(0, -2, 0.75, false, { lookingDown: true, targeting: true })).toEqual(lookOnly);
  });

  it('targeting → LOOK_AT_PIVOT | LOOK_AT_OBJECT for any 3rd-person offset; the head keeps its own flags', () => {
    const tracked = { align: false, lookInDirection: false, lookAtPivot: true, lookAtObject: true };
    expect(targetForOffset(0, -2.75, 0.825, false, { targeting: true })).toEqual(tracked);
    expect(targetForOffset(0, -2.75, 0.5, false, { targeting: true })).toEqual(tracked); // level band too
    expect(targetForOffset(2, 1, 0.5, false, { targeting: true })).toEqual(tracked);
    expect(targetForOffset(0, 0.18, 0, true, { targeting: true }))
      .toEqual({ align: true, lookInDirection: true, lookAtPivot: false, lookAtObject: false });
  });

  it('Overhead View is action 0x3b and the retail constants hold', () => {
    expect(ACT.OverheadView).toBe(0x3b);
    expect(LOOK_DOWN_OFFSET).toEqual({ back: 2, up: 0.75 });
    expect(LOOK_DOWN_PITCH / DEG).toBeCloseTo(-74.476, 2); // atan2(−1.8, 0.5)
    expect(CAMERA_TURN_INCREMENT).toBe(8);
    expect(TRACK_TARGET_OFFSET_Z).toBe(0.5);
  });
});

describe('CORE.18.b.a.a.a.a — the rig in the overhead view', () => {
  it('sits (0, −2, 0.75) in the pitched frame and looks 74.5° down along the player', () => {
    for (const facing of [0, 1.1, -2.4]) {
      const rig = new RetailCameraRig();
      rig.update(rigInput({ facing, back: 2, up: 0.75, lookingDown: true, align: true, velocity: { x: 0, y: 0, z: -5 } }));
      expect(rig.target).toEqual({ align: false, lookInDirection: true, lookAtPivot: false, lookAtObject: false });
      const e = eulerOf(rig.targetQuaternion);
      expect(e.x).toBeCloseTo(LOOK_DOWN_PITCH, 9);
      expect(e.y).toBeCloseTo(facing, 9);
      // Frame: forward f = level·cos p + up·sin p, frame up u ⟂ f (no roll).
      const c = Math.cos(LOOK_DOWN_PITCH), s = Math.sin(LOOK_DOWN_PITCH);
      const level = new THREE.Vector3(-Math.sin(facing), 0, -Math.cos(facing));
      const f = level.clone().multiplyScalar(c).setY(s);
      const u = level.clone().multiplyScalar(-s).setY(c);
      const want = new THREE.Vector3(0, CAMERA_DEFAULT_PIVOT_Z, 0).addScaledVector(f, -2).addScaledVector(u, 0.75);
      expect(rig.targetPosition.distanceTo(want)).toBeLessThan(1e-9);
      // High above the pivot, a little behind it.
      expect(rig.targetPosition.y - CAMERA_DEFAULT_PIVOT_Z).toBeCloseTo(-2 * s + 0.75 * c, 9);
    }
  });
});

describe('CORE.18.b.a.a.a.a — the rig tracking a combat target', () => {
  it('heads the offset frame from the pivot toward the target and looks at the pivot', () => {
    const rig = new RetailCameraRig();
    // Player faces −z (facing 0) but the target stands off to +x, level with the pivot.
    const target = new THREE.Vector3(10, CAMERA_DEFAULT_PIVOT_Z, 0);
    rig.update(rigInput({ facing: 0, trackTarget: target, align: true, velocity: { x: 0, y: 0, z: -5 } }));
    expect(rig.target).toEqual({ align: false, lookInDirection: false, lookAtPivot: true, lookAtObject: true });
    expect(rig.frameForward.x).toBeCloseTo(1, 9);
    // The viewer sits behind the pivot on the far side from the target…
    expect(rig.targetPosition.x).toBeCloseTo(-DEFAULT_VIEWER_BACK, 9);
    expect(rig.targetPosition.z).toBeCloseTo(0, 9);
    expect(rig.targetPosition.y).toBeCloseTo(CAMERA_DEFAULT_PIVOT_Z + DEFAULT_VIEWER_UP, 9);
    // …and looks through the pivot toward the target (yaw of +x = −π/2).
    const e = eulerOf(rig.targetQuaternion);
    expect(e.y).toBeCloseTo(-Math.PI / 2, 9);
    expect(e.x).toBeCloseTo(-Math.atan2(DEFAULT_VIEWER_UP, DEFAULT_VIEWER_BACK), 9);
  });

  it('a target above the pivot pitches the offset frame (set_vector_heading)', () => {
    const rig = new RetailCameraRig();
    const target = new THREE.Vector3(0, CAMERA_DEFAULT_PIVOT_Z + 5, -5); // 45° up, straight ahead
    rig.update(rigInput({ facing: 0, trackTarget: target }));
    expect(Math.asin(rig.frameForward.y) / DEG).toBeCloseTo(45, 9);
    // The viewer drops below / behind: pivot − 2.75 f + 0.825 u.
    const f = new THREE.Vector3(0, Math.SQRT1_2, -Math.SQRT1_2);
    const u = new THREE.Vector3(0, Math.SQRT1_2, Math.SQRT1_2);
    const want = new THREE.Vector3(0, CAMERA_DEFAULT_PIVOT_Z, 0).addScaledVector(f, -DEFAULT_VIEWER_BACK).addScaledVector(u, DEFAULT_VIEWER_UP);
    expect(rig.targetPosition.distanceTo(want)).toBeLessThan(1e-9);
  });

  it('a target on the pivot falls back to the player direction', () => {
    const rig = new RetailCameraRig();
    rig.update(rigInput({ facing: 0.7, trackTarget: new THREE.Vector3(0, CAMERA_DEFAULT_PIVOT_Z, 0) }));
    expect(Math.atan2(-rig.frameForward.x, -rig.frameForward.z)).toBeCloseTo(0.7, 9);
  });

  it('without a target the rig is unchanged (null trackTarget)', () => {
    const a = new RetailCameraRig();
    const b = new RetailCameraRig();
    a.update(rigInput({ facing: 0.3, orbit: 0.4 }));
    b.update(rigInput({ facing: 0.3, orbit: 0.4, trackTarget: null, lookingDown: false }));
    expect(a.targetPosition.distanceTo(b.targetPosition)).toBe(0);
    expect(a.targetQuaternion.angleTo(b.targetQuaternion)).toBe(0);
  });
});

describe('CORE.18.b.a.a.a.a — ClientCombatSystem::UpdateTargetTracking gate', () => {
  const monster = { itemType: ItemType.Creature, objectDescFlags: ObjectDescriptionFlag.Attackable, inWorld: true };
  it('tracks an attackable world creature in melee / missile with Target In View on', () => {
    expect(tracksCombatTarget(true, CombatMode.Melee, monster)).toBe(true);
    expect(tracksCombatTarget(true, CombatMode.Missile, monster)).toBe(true);
  });
  it('not with the option off, in peace or magic mode, without a target, or on a non-attackable / carried one', () => {
    expect(tracksCombatTarget(false, CombatMode.Melee, monster)).toBe(false);
    expect(tracksCombatTarget(true, CombatMode.NonCombat, monster)).toBe(false);
    expect(tracksCombatTarget(true, CombatMode.Magic, monster)).toBe(false);
    expect(tracksCombatTarget(true, CombatMode.Melee, null)).toBe(false);
    expect(tracksCombatTarget(true, CombatMode.Melee, { ...monster, objectDescFlags: 0 })).toBe(false); // a vendor
    expect(tracksCombatTarget(true, CombatMode.Melee, { ...monster, inWorld: false })).toBe(false);
  });
});

describe('CORE.18.b.a.a.a.a — CameraController overhead view', () => {
  it('toggles on with the look-down offset and pitch, and restores the saved offset', () => {
    const cc = controller();
    cc.cameraYawOffset = 0.6;
    cc.pitch = 0.2;
    cc.update(1 / 60);
    const before = { boom: cc.thirdPersonBoom(), orbit: cc.cameraYawOffset, view: cc.viewPitch };
    cc.toggleLookDown();
    expect(cc.isLookingDown).toBe(true);
    expect(cc.thirdPersonBoom()).toEqual({ back: 2, up: 0.75 });
    expect(cc.cameraYawOffset).toBe(0);
    expect(cc.viewPitch).toBe(LOOK_DOWN_PITCH);
    expect(cc.looksAtPivot).toBe(false);
    cc.update(1 / 60);
    expect(cc.viewPitch).toBe(LOOK_DOWN_PITCH);
    cc.toggleLookDown();
    expect(cc.isLookingDown).toBe(false);
    expect(cc.thirdPersonBoom().back).toBeCloseTo(before.boom.back, 12);
    expect(cc.thirdPersonBoom().up).toBeCloseTo(before.boom.up, 12);
    expect(cc.cameraYawOffset).toBe(before.orbit);
    expect(cc.viewPitch).toBeCloseTo(before.view, 12);
  });

  // CORE.18.b.a.a.a.a.a corrected this: Raise / Lower's looking_down branch
  // slides viewer_offset.y by CAMERA_MOUSELOOK_INC (the view pitch and the
  // orbit pitch stay put).
  it('Raise / Lower (mouse Y) slide the viewer 0.2 m per acting update while looking down — mouse down is Lower (MouseLookHandler: y > 0 → Lower), exactly the Rotate Camera Down key', () => {
    const cc = controller();
    cc.toggleLookDown();
    const pitch = cc.pitch;
    const back0 = cc.thirdPersonBoom().back;
    look(cc, 0, 40, 5); // the 5-call dead band: nothing moves yet
    expect(cc.thirdPersonBoom().back).toBeCloseTo(back0, 12);
    look(cc, 0, 40, 1); // 6th consecutive call acts: Lower
    expect(cc.isLookingDown).toBe(true);
    expect(cc.pitch).toBe(pitch);
    expect(cc.viewPitch).toBe(LOOK_DOWN_PITCH);
    const afterLower = cc.thirdPersonBoom().back;
    // The key does the same thing.
    const key = controller();
    key.toggleLookDown();
    key.startRaiseLower('lower'); key.stopRaiseLower();
    expect(afterLower).toBeCloseTo(key.thirdPersonBoom().back, 12);
    expect(Math.abs(afterLower - back0)).toBeCloseTo(0.2, 6);
    look(cc, 0, -40, 2); // mouse up (the extent keeps counting): Raise twice
    expect(cc.thirdPersonBoom().back).toBeCloseTo(afterLower + 2 * (back0 - afterLower), 6);
    expect(cc.thirdPersonBoom().up).toBe(0.75);
  });

  it('Rotate (mouse X), a zoom step, First Person and Move Camera to Default end it', () => {
    const rotate = controller();
    rotate.cameraYawOffset = 0.3;
    rotate.toggleLookDown();
    look(rotate, 10, 0, 5);
    expect(rotate.isLookingDown).toBe(true); // still inside the dead band
    look(rotate, 10, 0, 1);
    expect(rotate.isLookingDown).toBe(false);
    // restored, then Rotate Camera Right by |x| = 10 × 0.55 × 0.0667 steps
    expect(rotate.cameraYawOffset).toBeCloseTo(0.3 - 10 * ML * CAMERA_ROTATE_RADIANS, 9);

    const zoom = controller();
    zoom.toggleLookDown();
    zoom.zoomBy(1);
    expect(zoom.isLookingDown).toBe(false);

    const head = controller();
    head.toggleLookDown();
    head.enterHead();
    expect(head.isLookingDown).toBe(false);
    expect(head.isFirstPerson).toBe(true);

    const reset = controller();
    reset.toggleLookDown();
    reset.resetZoom();
    expect(reset.isLookingDown).toBe(false);
  });

  it('from the head: eases out at the current stiffness, and back in at stiffness 1', () => {
    const cc = controller();
    cc.enterHead();
    expect(cc.tStiffness).toBe(1);
    cc.toggleLookDown();
    expect(cc.isFirstPerson).toBe(false);
    expect(cc.tStiffness).toBe(CAMERA_DEFAULT_STIFFNESS);
    expect(cc.rStiffness).toBe(CAMERA_DEFAULT_STIFFNESS);
    expect(cc.cameraDistance).toBeCloseTo(Math.hypot(2, 0.75), 12);
    cc.toggleLookDown();
    expect(cc.isFirstPerson).toBe(true);
    expect(cc.tStiffness).toBe(1);
    expect(cc.rStiffness).toBe(1);
  });
});

describe('CORE.18.b.a.a.a.a — in-head mouse-look turns the player (TurnToHeading)', () => {
  it('a mouse X step turns the player CAMERA_TURN_INCREMENT at the turn rate; the orbit stays 0', () => {
    const cc = controller();
    cc.enterHead();
    cc.playerYaw = 1;
    look(cc, 5, 0, 5);
    expect(cc.playerYaw).toBe(1); // dead band
    look(cc, 5, 0, 1);
    cc.setMouseLook(false);
    expect(cc.cameraYawOffset).toBe(0);
    expect(cc.isTurningRight).toBe(true);
    expect(cc.playerYaw).toBeGreaterThan(1);
    for (let i = 0; i < 60; i++) cc.update(1 / 60);
    expect(cc.playerYaw).toBeCloseTo(1 + CAMERA_TURN_INCREMENT * DEG, 12);
    expect(cc.isTurningRight).toBe(false);
    expect(cc.yaw).toBeCloseTo(cc.playerYaw, 12);
  });

  it('mouse left turns left; each mouse-look update re-aims 8° from the current heading', () => {
    const cc = controller();
    cc.enterHead();
    look(cc, -3, 0, 6);
    expect(cc.isTurningLeft).toBe(true);
    const first = cc.playerYaw;
    expect(first).toBeLessThan(0);
    look(cc, -3, 0, 1);
    cc.setMouseLook(false);
    for (let i = 0; i < 60; i++) cc.update(1 / 60);
    // TurnToHeading(get_heading − 8°) from the heading at the second update.
    expect(cc.playerYaw).toBeCloseTo(first - CAMERA_TURN_INCREMENT * DEG, 12);
  });

  it('entering the head drops the orbit; out of the head mouse X still orbits', () => {
    const cc = controller();
    cc.cameraYawOffset = 0.9;
    cc.enterHead();
    expect(cc.cameraYawOffset).toBe(0);
    const third = controller();
    look(third, 10, 0, 6);
    expect(third.playerYaw).toBe(0);
    // 3rd person mouse right = Rotate Camera Right: the orbit offset goes negative.
    expect(third.cameraYawOffset).toBeCloseTo(-10 * ML * CAMERA_ROTATE_RADIANS, 9);
  });
});
