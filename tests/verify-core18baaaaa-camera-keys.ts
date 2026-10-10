/**
 * CORE.18.b.a.a.a.a.a — the retail keyboard camera actions and Map View:
 *   - CameraManager::OnAction @ 00455f40 0x35 / 0x36 → CameraSet::Rotate
 *     (left = 1, keyboard) / StopRotating; 0x37 / 0x38 → Raise / Lower /
 *     StopRaising / StopLowering; CameraSet::UpdateCamera @ 00458ae0 ticks
 *     the held ones once per frame.
 *   - Rotate @ 00458310: orbit by (elapsed × m_rCameraAdjustmentSpeed) ×
 *     CAMERA_ROTATE_DEGREES; in the head TurnToHeading(heading ± 8°).
 *   - Raise @ 00457980 / Lower @ 00457cf0: viewer pitch by the same step
 *     (× 0.25 with UseMouseTurning); in the head direction.z ∓ 0.2 within
 *     ±CAMERA_MOUSELOOK_LIMIT; looking down, viewer_offset.y ∓ 0.2.
 *   - SetMapMode @ 004581d0 / LookDown @ 00457ff0 map branch: offset
 *     (0, −450, 0.75), stiffness 1, DisableDegrades / DisableFogging.
 * Behavioral: drives the shipped CameraController / RetailCamera /
 * RetailCameraRig / SceneManager / KeybindRegistry code.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { CameraController } from '../packages/renderer/src/scene/CameraController.js';
import { RetailCameraRig, type RigInput } from '../packages/renderer/src/scene/RetailCameraRig.js';
import { SceneManager } from '../packages/renderer/src/scene/SceneManager.js';
import { SkyboxRenderer } from '../packages/renderer/src/effects/SkyboxRenderer.js';
import {
  CAMERA_DEFAULT_PIVOT_Z, CAMERA_DEFAULT_STIFFNESS, CAMERA_MAP_DISTANCE, CAMERA_MOUSELOOK_LIMIT,
  CAMERA_ROTATE_DEGREES, CAMERA_ROTATE_RADIANS, DEFAULT_VIEWER_BACK, DEFAULT_VIEWER_UP,
  LOOK_DOWN_PITCH, MOUSE_TURNING_RAISE_SCALE, inHeadRaiseLower, lookDownSlide,
} from '../packages/renderer/src/scene/RetailCamera.js';
import { ACT, DEFAULT_KEYBINDS, HELD_CAMERA_ACTIONS } from '../packages/renderer/src/input/KeybindDefaults.js';
import { KeybindRegistry } from '../packages/renderer/src/input/KeybindRegistry.js';

const DEG = Math.PI / 180;

/** A controller on a fake clock at 60 fps. */
function controller(): { cc: CameraController; advance: (s: number) => void } {
  const cc = new CameraController(new THREE.PerspectiveCamera());
  for (let i = 0; i < 20; i++) cc.frameRate.push(1 / 60); // SceneTool::m_FramesPerSecond = 60
  let now = 100;
  cc.clock = () => now;
  return { cc, advance: (s) => { now += s; } };
}

describe('CORE.18.b.a.a.a.a.a — actions, bindings and constants', () => {
  it('0x35–0x38 and 0x3c are the retail Numpad 4 / 6 / 8 / 2 / Enter bindings', () => {
    const reg = new KeybindRegistry(DEFAULT_KEYBINDS);
    expect(reg.resolve('Numpad4')).toBe(ACT.RotateCameraLeft);
    expect(reg.resolve('Numpad6')).toBe(ACT.RotateCameraRight);
    expect(reg.resolve('Numpad8')).toBe(ACT.RotateCameraUp);
    expect(reg.resolve('Numpad2')).toBe(ACT.RotateCameraDown);
    expect(reg.resolve('NumpadEnter')).toBe(ACT.MapView);
    expect([ACT.RotateCameraLeft, ACT.RotateCameraRight, ACT.RotateCameraUp, ACT.RotateCameraDown, ACT.MapView])
      .toEqual([0x35, 0x36, 0x37, 0x38, 0x3c]);
  });

  it('press-and-release actions ignore key repeat; the toggles do not', () => {
    for (const id of [0x33, 0x34, 0x35, 0x36, 0x37, 0x38]) expect(HELD_CAMERA_ACTIONS.has(id)).toBe(true);
    for (const id of [0x39, 0x3a, 0x3b, 0x3c]) expect(HELD_CAMERA_ACTIONS.has(id)).toBe(false);
  });

  it('the retail constants', () => {
    expect(CAMERA_ROTATE_DEGREES).toBe(8);
    expect(CAMERA_ROTATE_RADIANS).toBeCloseTo(8 * DEG, 12);
    expect(CAMERA_MAP_DISTANCE).toBe(450);
    expect(CAMERA_MOUSELOOK_LIMIT).toBe(0.8);
    expect(MOUSE_TURNING_RAISE_SCALE).toBe(0.25);
  });

  it('lookDownSlide: Raise backs off to 10 m, Lower comes forward to 0.8 m ahead', () => {
    expect(lookDownSlide(2, true)).toBeCloseTo(2.2, 6);
    expect(lookDownSlide(2, false)).toBeCloseTo(1.8, 6);
    let back = 2;
    for (let i = 0; i < 100; i++) back = lookDownSlide(back, true);
    expect(back).toBeCloseTo(10, 4); // y ≥ −9.8 → one more step to −10, then refused
    back = 2;
    for (let i = 0; i < 100; i++) back = lookDownSlide(back, false);
    // float32 steps from −2 land on 0.8000001 > (float)0.8, so it stops there.
    expect(back).toBeCloseTo(-0.8, 5);
    expect(lookDownSlide(CAMERA_MAP_DISTANCE, true)).toBe(CAMERA_MAP_DISTANCE); // Map View: Raise refused
    expect(lookDownSlide(CAMERA_MAP_DISTANCE, false)).toBeCloseTo(449.8, 3);
  });

  it('inHeadRaiseLower: direction.z steps 0.2, Raise looks down, clamped at ±0.8', () => {
    expect(Math.tan(inHeadRaiseLower(0, true))).toBeCloseTo(-0.2, 12);
    expect(Math.tan(inHeadRaiseLower(0, false))).toBeCloseTo(0.2, 12);
    let p = 0;
    for (let i = 0; i < 10; i++) p = inHeadRaiseLower(p, true);
    expect(p).toBeCloseTo(Math.atan(-0.8), 12); // −38.66°
    expect(inHeadRaiseLower(60 * DEG, true)).toBeCloseTo(Math.atan(0.8), 12); // tan 60° − 0.2 > 0.8 → clamp
  });
});

describe('CORE.18.b.a.a.a.a.a — Rotate Camera Left / Right', () => {
  it('orbits on press by one 1 / fps tick, then by the frame time until released', () => {
    const { cc, advance } = controller();
    cc.startRotate('left');
    const perTick = (1 / 60) * 40 * CAMERA_ROTATE_RADIANS; // 5.33°
    expect(cc.cameraYawOffset).toBeCloseTo(perTick, 12);
    cc.tickHeldActions(); // same instant: under F_EPSILON, no step
    expect(cc.cameraYawOffset).toBeCloseTo(perTick, 12);
    advance(0.1);
    cc.tickHeldActions();
    expect(cc.cameraYawOffset).toBeCloseTo(perTick + 0.1 * 40 * CAMERA_ROTATE_RADIANS, 12); // +32°
    cc.stopRotate();
    advance(0.1);
    cc.tickHeldActions();
    expect(cc.cameraYawOffset).toBeCloseTo(perTick + 0.1 * 40 * CAMERA_ROTATE_RADIANS, 12);
    expect(cc.isCameraActionHeld).toBe(false);
  });

  it('left swings the viewer to the player\'s left (the view turns right); right the other way', () => {
    const { cc, advance } = controller();
    cc.startRotate('right');
    advance(0.05);
    cc.tickHeldActions();
    expect(cc.cameraYawOffset).toBeLessThan(0);
    const rig = new RetailCameraRig();
    const input: RigInput = {
      pivot: new THREE.Vector3(0, CAMERA_DEFAULT_PIVOT_Z, 0), facing: 0, orbit: 0.5,
      back: DEFAULT_VIEWER_BACK, up: DEFAULT_VIEWER_UP, inHead: false, inHeadAhead: 0.18,
      lookPitch: 0, align: false, velocity: { x: 0, y: 0, z: 0 },
      contactNormal: { x: 0, y: 1, z: 0 }, tStiffness: 1, rStiffness: 1, dt: 1 / 60,
    };
    rig.update(input);
    // facing 0: forward (0, 0, −1), the player's right (−1, 0, 0) — CameraController's `right`.
    expect(rig.targetPosition.x).toBeGreaterThan(0); // on the player's left
  });

  it('adjustment speed scales the step (Config Camera Adjustment Speed)', () => {
    const { cc, advance } = controller();
    cc.adjustmentSpeed = 80;
    cc.startRotate('left');
    const first = cc.cameraYawOffset;
    advance(0.1);
    cc.tickHeldActions();
    expect(cc.cameraYawOffset - first).toBeCloseTo(0.1 * 80 * CAMERA_ROTATE_RADIANS, 12);
  });

  it('in the head it turns the player 8° a tick instead (left = heading + 8 = clockwise)', () => {
    const { cc } = controller();
    cc.enterHead();
    const yaw0 = cc.playerYaw;
    cc.startRotate('left');
    expect(cc.cameraYawOffset).toBe(0);
    expect(cc.isTurningRight).toBe(true);
    cc.update(1 / 60);
    expect(cc.playerYaw).toBeGreaterThan(yaw0);
    cc.stopRotate();
    cc.startRotate('right');
    expect(cc.isTurningLeft).toBe(true);
  });

  it('keeps turning while held in the head: every frame re-aims 8° from the current heading', () => {
    const { cc, advance } = controller();
    cc.enterHead();
    cc.startRotate('left');
    for (let i = 0; i < 120; i++) {
      advance(1 / 60);
      cc.tickHeldActions();
      cc.update(1 / 60);
    }
    // 2 s at the 1.5 × 1.5 rad/s running turn rate, never stopping at 8°.
    expect(cc.playerYaw).toBeCloseTo(2 * 1.5 * 1.5, 6);
  });

  it('ends the overhead view', () => {
    const { cc } = controller();
    cc.toggleLookDown();
    cc.startRotate('left');
    expect(cc.isLookingDown).toBe(false);
  });
});

describe('CORE.18.b.a.a.a.a.a — Rotate Camera Up / Down (Raise / Lower)', () => {
  it('raises and lowers the viewer about the pivot by the time step', () => {
    const { cc, advance } = controller();
    const e0 = cc.orbitElevation;
    cc.startRaiseLower('raise');
    const tick = (1 / 60) * 40 * CAMERA_ROTATE_RADIANS;
    expect(cc.orbitElevation).toBeCloseTo(e0 + tick, 12);
    advance(0.05);
    cc.tickHeldActions();
    expect(cc.orbitElevation).toBeCloseTo(e0 + tick + 0.05 * 40 * CAMERA_ROTATE_RADIANS, 12);
    cc.stopRaiseLower();
    const e1 = cc.orbitElevation;
    cc.startRaiseLower('lower');
    expect(cc.orbitElevation).toBeCloseTo(e1 - tick, 12);
  });

  it('a quarter step with Use Mouse Turning (ICIDM m_UseMouseTurning)', () => {
    const { cc } = controller();
    CameraController.setUseMouseTurning(true);
    try {
      const e0 = cc.orbitElevation;
      cc.startRaiseLower('raise');
      expect(cc.orbitElevation - e0).toBeCloseTo((1 / 60) * 40 * CAMERA_ROTATE_RADIANS * 0.25, 12);
    } finally {
      CameraController.setUseMouseTurning(false);
    }
  });

  it('stops at the ground-distance limit going down and short of the top going up', () => {
    const { cc, advance } = controller();
    cc.startRaiseLower('lower');
    for (let i = 0; i < 300; i++) { advance(1 / 60); cc.tickHeldActions(); }
    const { up } = cc.thirdPersonBoom();
    expect(up).toBeLessThan(0);
    expect(Math.hypot(cc.thirdPersonBoom().back, 0)).toBeGreaterThanOrEqual(1.2 - 1e-9); // CAMERA_MIN_CHAR_GROUNDDIST
    cc.stopRaiseLower();
    cc.startRaiseLower('raise');
    for (let i = 0; i < 300; i++) { advance(1 / 60); cc.tickHeldActions(); }
    expect(cc.orbitElevation).toBeLessThan(Math.PI / 2);
    expect(cc.orbitElevation).toBeGreaterThan(80 * DEG);
  });

  it('switching Raise → Lower while held keeps the tick clock (m_ttLastRaiseOrLower only set when 0)', () => {
    const { cc, advance } = controller();
    cc.startRaiseLower('raise');
    advance(0.1);
    const e = cc.orbitElevation;
    cc.startRaiseLower('lower'); // 0.1 s since the last tick
    expect(cc.orbitElevation).toBeCloseTo(e - 0.1 * 40 * CAMERA_ROTATE_RADIANS, 12);
  });

  it('in the head: the view pitch steps by direction.z 0.2 a tick — Raise looks down — to ±38.7°', () => {
    const { cc, advance } = controller();
    cc.enterHead();
    cc.startRaiseLower('raise');
    expect(Math.tan(cc.viewPitch)).toBeCloseTo(-0.2, 12);
    for (let i = 0; i < 10; i++) { advance(1 / 60); cc.tickHeldActions(); }
    expect(cc.viewPitch).toBeCloseTo(Math.atan(-0.8), 12);
    cc.stopRaiseLower();
    cc.startRaiseLower('lower');
    expect(Math.tan(cc.viewPitch)).toBeCloseTo(-0.6, 12);
    cc.update(1 / 60);
    expect(Math.tan(cc.viewPitch)).toBeCloseTo(-0.6, 12);
  });

  it('looking down: slides the viewer 0.2 m per frame, the direction unchanged', () => {
    const { cc, advance } = controller();
    cc.toggleLookDown();
    cc.startRaiseLower('raise');
    expect(cc.thirdPersonBoom().back).toBeCloseTo(2.2, 6);
    advance(1 / 60);
    cc.tickHeldActions();
    expect(cc.thirdPersonBoom().back).toBeCloseTo(2.4, 6);
    expect(cc.viewPitch).toBe(LOOK_DOWN_PITCH);
    expect(cc.isLookingDown).toBe(true);
    // The overhead view's next toggle restores the saved 3rd-person offset.
    cc.stopRaiseLower();
    cc.toggleLookDown();
    expect(cc.cameraDistance).toBeCloseTo(Math.hypot(DEFAULT_VIEWER_BACK, DEFAULT_VIEWER_UP), 12);
    // Re-entering starts from LookDown's own (0, −2, 0.75).
    cc.toggleLookDown();
    expect(cc.thirdPersonBoom().back).toBe(2);
  });
});

describe('CORE.18.b.a.a.a.a.a — Map View (SetMapMode)', () => {
  it('toggles the look-down offset out to 450 m at stiffness 1 with degrades / fog off, and back', () => {
    const { cc } = controller();
    const events: boolean[] = [];
    cc.onMapModeChange = (on) => events.push(on);
    cc.cameraYawOffset = 0.4;
    cc.update(1 / 60);
    const before = { d: cc.cameraDistance, orbit: cc.cameraYawOffset, e: cc.orbitElevation };
    cc.toggleMapMode();
    expect(cc.isInMapMode).toBe(true);
    expect(cc.isLookingDown).toBe(true);
    expect(cc.thirdPersonBoom()).toEqual({ back: CAMERA_MAP_DISTANCE, up: 0.75 });
    expect(cc.viewPitch).toBe(LOOK_DOWN_PITCH);
    expect(cc.cameraYawOffset).toBe(0);
    expect([cc.tStiffness, cc.rStiffness]).toEqual([1, 1]);
    expect(events).toEqual([true]);
    cc.toggleMapMode();
    expect(cc.isInMapMode).toBe(false);
    expect(cc.isLookingDown).toBe(false);
    expect(cc.cameraDistance).toBeCloseTo(before.d, 12);
    expect(cc.cameraYawOffset).toBe(before.orbit);
    expect(cc.orbitElevation).toBeCloseTo(before.e, 12);
    expect([cc.tStiffness, cc.rStiffness]).toEqual([CAMERA_DEFAULT_STIFFNESS, CAMERA_DEFAULT_STIFFNESS]);
    expect(events).toEqual([true, false]);
  });

  it('from the Overhead View: moves out to 450 m; leaving restores the pre-overhead offset', () => {
    const { cc } = controller();
    const events: boolean[] = [];
    cc.onMapModeChange = (on) => events.push(on);
    const d0 = cc.cameraDistance;
    cc.toggleLookDown();
    cc.toggleMapMode();
    expect(cc.thirdPersonBoom().back).toBe(CAMERA_MAP_DISTANCE);
    expect(events).toEqual([true]);
    cc.toggleMapMode();
    expect(cc.isLookingDown).toBe(false);
    expect(cc.cameraDistance).toBeCloseTo(d0, 12);
    expect(events).toEqual([true, false]);
  });

  it('Overhead View, a zoom step, Rotate, First Person and Move Camera to Default all end it', () => {
    const enders: Array<(cc: CameraController) => void> = [
      (cc) => cc.toggleLookDown(),
      (cc) => cc.zoomBy(1),
      (cc) => cc.startRotate('left'),
      (cc) => cc.enterHead(),
      (cc) => cc.resetZoom(),
    ];
    for (const end of enders) {
      const { cc } = controller();
      const events: boolean[] = [];
      cc.onMapModeChange = (on) => events.push(on);
      cc.toggleMapMode();
      end(cc);
      expect(cc.isInMapMode).toBe(false);
      expect(cc.isLookingDown).toBe(false);
      expect(events).toEqual([true, false]);
    }
  });

  it('from the head: back into the head at stiffness 1', () => {
    const { cc } = controller();
    cc.enterHead();
    cc.toggleMapMode();
    expect(cc.isFirstPerson).toBe(false);
    expect([cc.tStiffness, cc.rStiffness]).toEqual([1, 1]);
    cc.toggleMapMode();
    expect(cc.isFirstPerson).toBe(true);
    expect(cc.tStiffness).toBe(1);
  });

  it('the rig puts the Map View viewer ~434 m above and 120 m behind the pivot, looking 74.5° down', () => {
    const rig = new RetailCameraRig();
    rig.update({
      pivot: new THREE.Vector3(0, CAMERA_DEFAULT_PIVOT_Z, 0), facing: 0, lookingDown: true,
      back: CAMERA_MAP_DISTANCE, up: 0.75, inHead: false, inHeadAhead: 0.18, lookPitch: 0, align: false,
      velocity: { x: 0, y: 0, z: 0 }, contactNormal: { x: 0, y: 1, z: 0 }, tStiffness: 1, rStiffness: 1, dt: 1 / 60,
    });
    const p = rig.targetPosition;
    const f = { h: Math.cos(LOOK_DOWN_PITCH), v: Math.sin(LOOK_DOWN_PITCH) };
    // viewer = pivot − 450·forward + 0.75·up, both in the pitched frame.
    expect(p.y - CAMERA_DEFAULT_PIVOT_Z).toBeCloseTo(-450 * f.v + 0.75 * f.h, 6);
    expect(p.y - CAMERA_DEFAULT_PIVOT_Z).toBeGreaterThan(430);
    expect(p.z).toBeCloseTo(450 * f.h + 0.75 * f.v, 6); // behind the player (facing −z)
    expect(p.z).toBeGreaterThan(110);
    const e = new THREE.Euler().setFromQuaternion(rig.targetQuaternion, 'YXZ');
    expect(e.x).toBeCloseTo(LOOK_DOWN_PITCH, 6);
  });
});

describe('CORE.18.b.a.a.a.a.a — SceneManager fog system (SmartBox::DisableFogging)', () => {
  const fogOf = (sm: SceneManager) => sm.scene.fog as THREE.Fog | null;

  it('hides every fog while disabled and brings the same fog back', () => {
    const sm = new SceneManager({ fogColor: 0x808080, fogNear: 100, fogFar: 500 });
    const fog = fogOf(sm);
    expect(fog).not.toBeNull();
    sm.setFogSystemDisabled(true);
    expect(sm.scene.fog).toBeNull();
    expect(sm.isFogSystemDisabled).toBe(true);
    sm.setFogSystemDisabled(false);
    expect(sm.scene.fog).toBe(fog);
  });

  it('the Disable Distance Fog preference toggled meanwhile wins on the way out', () => {
    const sm = new SceneManager({ fogColor: 0x808080 });
    const fog = fogOf(sm);
    sm.setFogSystemDisabled(true);
    sm.setFogEnabled(false);
    sm.setFogSystemDisabled(false);
    expect(sm.scene.fog).toBeNull();
    sm.setFogEnabled(true);
    expect(sm.scene.fog).toBe(fog);
    // Enabling it while the system is off keeps it hidden until the system is back.
    sm.setFogEnabled(false);
    sm.setFogSystemDisabled(true);
    sm.setFogEnabled(true);
    expect(sm.scene.fog).toBeNull();
    sm.setFogSystemDisabled(false);
    expect(sm.scene.fog).toBe(fog);
  });

  it('an EnvironChange override written while the fog system is off stays hidden, then shows on the one fog object', () => {
    const sm = new SceneManager({ fogColor: 0x808080 });
    const fog = fogOf(sm)!;
    // DECOMP.environs-* — the override is blended into THE fog object by the
    // sky ticks (SkyboxRenderer.setEnvironOverride), never swapped in.
    const frame = { begin: 0, dirBright: 0.5, dirHeading: 90, dirPitch: 45, dirColor: 0xffffffff,
      ambBright: 0.3, ambColor: 0xffffffff, minWorldFog: 100, maxWorldFog: 1000,
      worldFogColor: 0xff808080, worldFog: 1, skyObjReplace: [] };
    const sky = new SkyboxRenderer({ tickSize: 0.8, lightTickSize: 15, dayGroups: [{ chanceOfOccur: 1,
      dayName: 'S', skyObjects: [], skyTime: [frame, { ...frame, begin: 0.5 }] }] } as never,
      { dayLength: 1e9, zeroTimeOfYear: 0, zeroYear: 10, daysPerYear: 360 } as never);
    sky.setFog(fog);
    sm.setFogSystemDisabled(true);
    sky.setEnvironOverride({ fogColor: 0xff0000, fogMin: 1, fogMax: 50, ambientColor: 0xff0000, ambientLevel: 0.4 });
    for (let i = 0; i < 40; i++) sky.update(0.8);
    expect(sm.scene.fog).toBeNull();
    sm.setFogSystemDisabled(false);
    expect(fogOf(sm)).toBe(fog);
    expect(fog.far).toBe(50);
    sm.setFogSystemDisabled(true);
    sky.setEnvironOverride(null);
    sky.update(0.8);
    expect(sm.scene.fog).toBeNull();
    sm.setFogSystemDisabled(false);
    expect(sm.scene.fog).toBe(fog);
    expect(fog.far).toBe(1000);
  });
});
