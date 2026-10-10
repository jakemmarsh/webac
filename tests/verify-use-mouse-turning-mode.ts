/**
 * CORE.18.b.a.a.a.a.a.b — Use Mouse Turning (CInputManager::m_UseMouseTurning,
 * ICIDM+0x89; Config "Use Mouse Turning", default off). Retail, EoL decomp:
 *  - UIElement_SmartBoxWrapper::MouseDown / MouseUp @ 004e5700 / 004e5820,
 *    button 8: with the option on, the RIGHT button holds mouse-look
 *    (ToggleMouseLook(1) / (0)) and its release never examines.
 *  - CameraSet::Rotate @ 00458310, non-keyboard branch: mouse X turns the
 *    PLAYER — Rotate(right) = TurnLeft 0x6500000e, Rotate(left) = TurnRight
 *    0x6500000d — at min(2 × |x|, 1.5); |x| < 0.02 stops; the movement event
 *    is resent at most every 0.5 s.
 *  - CameraSet::MouseLookHandler @ 00458d80: the (0, 0) call (mouse still for
 *    > 0.2 s, CInputManager_WIN32) stops the turn.
 *  - CommandInterpreter::HandleSelectLeft @ 006b3630: with mouse-look on the
 *    LEFT button runs forward (0x45000005) instead of selecting.
 *  - MovePlayer @ 006b3f40 (0xc0000c1): held Turn keys run as Sidesteps.
 * Drives the real CameraController / MovementSync / WorldRightClick.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import * as THREE from 'three';
import { loadDomWindow, restoreDomGlobals } from './_harness/dom.js';
import { GameActionType, parseMoveToStatePayload } from '@ac/network';
import { CameraController } from '../packages/renderer/src/scene/CameraController.js';
import { MOUSE_LOOK_SCALE } from '../packages/renderer/src/scene/RetailCamera.js';
import { MovementSync } from '../packages/renderer/src/network/MovementSync.js';
import type { MovementState, PlayerPosition } from '../packages/renderer/src/network/MovementSync.js';
import { WorldRightClick } from '../packages/renderer/src/ui/WorldRightClick.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const SENS = 0.55;
/** The mouse-look magnitude one move of `dx` pixels produces. */
const mag = (dx: number) => Math.abs(dx) * SENS * MOUSE_LOOK_SCALE;

describe('Use Mouse Turning — the mouse buttons and the turn (real DOM events)', () => {
  const saved: Record<string, unknown> = {};
  const GLOBALS = ['window', 'document', 'HTMLElement', 'Event'] as const;
  let c: CameraController;
  let canvas: HTMLElement;
  let t = 100;
  afterAll(() => { restoreDomGlobals(GLOBALS, saved); });
  beforeEach(() => {
    const g = globalThis as Record<string, unknown>;
    for (const key of GLOBALS) { if (!(key in saved)) saved[key] = g[key]; g[key] = key === 'window' ? domWindow : domWindow[key]; }
    domWindow.document.body.innerHTML = '<canvas></canvas><div id="panel"></div>';
    canvas = domWindow.document.querySelector('canvas');
    c = new CameraController(new THREE.PerspectiveCamera());
    c.frameRate.push(1 / 60);
    t = 100;
    c.clock = () => t; // advanced explicitly by step()
    c.bind(domWindow.document.body);
    CameraController.setUseMouseTurning(true);
  });
  afterEach(() => { CameraController.setUseMouseTurning(false); });

  const press = (type: 'mousedown' | 'mouseup', b: number, el: HTMLElement = canvas) =>
    el.dispatchEvent(new domWindow.MouseEvent(type, { button: b, bubbles: true, cancelable: true }));
  const move = (dx: number, dy = 0) => {
    const e = new domWindow.MouseEvent('mousemove', { bubbles: true });
    Object.defineProperty(e, 'movementX', { value: dx });
    Object.defineProperty(e, 'movementY', { value: dy });
    canvas.dispatchEvent(e);
  };
  const step = (dt = 1 / 60) => { t += dt; c.update(dt); };
  /** Six moves: past MouseLookHandler's 5-call dead band. */
  const turnMouse = (dx: number) => { for (let i = 0; i < 6; i++) { move(dx); step(); } };

  it('the right button over the world holds mouse-look; over a panel it does not', () => {
    press('mousedown', 2, domWindow.document.getElementById('panel'));
    expect(c.isMouseLookActive).toBe(false);
    press('mousedown', 2);
    expect(c.isMouseLookActive).toBe(true);
    press('mouseup', 2);
    expect(c.isMouseLookActive).toBe(false);
  });

  it('without the option the right button leaves mouse-look alone', () => {
    CameraController.setUseMouseTurning(false);
    press('mousedown', 2);
    expect(c.isMouseLookActive).toBe(false);
  });

  it('mouse right turns the player (TurnLeft) at min(2|x|, 1.5) instead of orbiting', () => {
    press('mousedown', 2);
    const yaw0 = c.playerYaw;
    turnMouse(10);
    expect(c.cameraYawOffset).toBe(0);
    expect(c.isTurningLeft).toBe(true);
    expect(c.isTurningRight).toBe(false);
    expect(c.turnSpeed).toBeCloseTo(2 * mag(10), 12);
    expect(c.playerYaw).toBeLessThan(yaw0); // TurnLeft lowers yaw (KeyA does too)
    // A fast mouse caps at 1.5.
    move(200); step();
    expect(c.turnSpeed).toBe(1.5);
    // Mouse left = TurnRight.
    turnMouse(-10);
    expect(c.isTurningRight).toBe(true);
  });

  it('the turn rate is the run turn rate × the mouse speed', () => {
    press('mousedown', 2);
    turnMouse(10);
    const before = c.playerYaw;
    t += 0.1; c.update(0.1); // no new delta, not yet 0.2 s still
    expect(before - c.playerYaw).toBeCloseTo(1.5 * 1.5 * 2 * mag(10) * 0.1, 9);
  });

  it('a movement under 0.02 stops the turn', () => {
    press('mousedown', 2);
    turnMouse(10);
    expect(c.isTurningLeft).toBe(true);
    move(0.5); step(); // 0.5 × 0.55 × 0.0667 ≈ 0.018
    expect(c.isTurningLeft).toBe(false);
    expect(c.turnSpeed).toBe(1);
  });

  it('a mouse still for more than 0.2 s stops the turn; a shorter pause keeps it', () => {
    press('mousedown', 2);
    turnMouse(10);
    step(0.15);
    expect(c.isTurningLeft).toBe(true);
    step(0.1);
    expect(c.isTurningLeft).toBe(false);
  });

  it('releasing the right button stops the turn', () => {
    press('mousedown', 2);
    turnMouse(10);
    press('mouseup', 2);
    expect(c.isTurningLeft).toBe(false);
  });

  it('the left button runs forward only while mouse-look is on, and does not select', () => {
    press('mousedown', 0);
    expect(c.isMovingForward).toBe(false);
    expect(c.leftButtonRunsForward).toBe(false);
    press('mouseup', 0);
    press('mousedown', 2);
    press('mousedown', 0);
    expect(c.isMovingForward).toBe(true);
    expect(c.leftButtonRunsForward).toBe(true);
    press('mouseup', 0);
    expect(c.isMovingForward).toBe(false);
    // Left held first, then mouse-look (MovePlayer 0xc0000c1 with mouseleft_down).
    press('mouseup', 2);
    press('mousedown', 0);
    press('mousedown', 2);
    expect(c.isMovingForward).toBe(true);
    press('mouseup', 2);
    expect(c.isMovingForward).toBe(false);
  });

  it('held Turn keys sidestep while mouse-look is on', () => {
    c.simulateKeyDown('KeyA');
    expect(c.isTurningLeft).toBe(true);
    press('mousedown', 2);
    expect(c.isTurningLeft).toBe(false);
    expect(c.isStrafingLeft).toBe(true);
    const yaw0 = c.playerYaw;
    step();
    expect(c.playerYaw).toBe(yaw0);
    press('mouseup', 2);
    expect(c.isTurningLeft).toBe(true);
    expect(c.isStrafingLeft).toBe(false);
  });
});

describe('Use Mouse Turning — the right release never examines (MouseUp @ 004e5820)', () => {
  const ev = (type: string) => ({ button: 2, clientX: 10, clientY: 10, type }) as unknown as MouseEvent;
  it('examines without the option, not with it', () => {
    let on = false;
    const examined: number[] = [];
    const rc = new WorldRightClick({
      isReady: () => true,
      rightButtonIsMouseLook: () => on,
      pick: () => ({ guid: 7 }),
      onExamine: (h) => examined.push(h.guid),
    });
    rc.onCanvasMouseUp(ev('mouseup'));
    expect(examined).toEqual([7]);
    on = true;
    rc.onCanvasMouseUp(ev('mouseup'));
    expect(examined).toEqual([7]);
  });
});

describe('Use Mouse Turning — the turn speed on the wire', () => {
  const IDLE: MovementState = {
    forward: false, backward: false, turnLeft: false, turnRight: false,
    strafeLeft: false, strafeRight: false, running: true,
  };
  const pos: PlayerPosition = {
    worldX: 100.5, worldZ: 200.5, groundY: 10, playerYaw: 0, landblock: 0, localX: 0, localY: 0, localZ: 0,
    inDungeon: false, onGround: true,
  };
  function harness() {
    const sent: Uint8Array[] = [];
    let seq = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sync = new MovementSync({ sendMessage: (b: Uint8Array) => { sent.push(b); } } as any, () => ++seq);
    const moveToStates = () => sent
      .filter((m) => new DataView(m.buffer, m.byteOffset).getUint32(8, true) === GameActionType.MoveToState)
      .map((m) => parseMoveToStatePayload(m.subarray(12)).motion);
    return { sync, moveToStates };
  }

  it('MoveToState carries the mouse turn speed (TurnLeft 0x6500000e)', () => {
    const { sync, moveToStates } = harness();
    sync.update({ ...IDLE, turnLeft: true, turnSpeed: 0.73 }, pos, 1000);
    const [m] = moveToStates();
    expect(m.turnCommand).toBe(0x6500000e);
    expect(m.turnSpeed).toBeCloseTo(0.73, 6);
  });

  it('a keyboard turn stays at speed 1.0', () => {
    const { sync, moveToStates } = harness();
    sync.update({ ...IDLE, turnRight: true }, pos, 1000);
    expect(moveToStates()[0].turnSpeed).toBe(1);
  });

  it('speed changes resend at most every 0.5 s (m_LastServerMessage)', () => {
    const { sync, moveToStates } = harness();
    sync.update({ ...IDLE, turnLeft: true, turnSpeed: 0.5 }, pos, 1000);
    sync.update({ ...IDLE, turnLeft: true, turnSpeed: 0.6 }, pos, 1100);
    sync.update({ ...IDLE, turnLeft: true, turnSpeed: 0.7 }, pos, 1400);
    expect(moveToStates().length).toBe(1);
    sync.update({ ...IDLE, turnLeft: true, turnSpeed: 0.8 }, pos, 1501);
    expect(moveToStates().length).toBe(2);
    expect(moveToStates()[1].turnSpeed).toBeCloseTo(0.8, 6);
    // Stopping is a state change: it goes out at once.
    sync.update({ ...IDLE }, pos, 1520);
    expect(moveToStates().length).toBe(3);
    expect(moveToStates()[2].turnCommand).toBe(0);
  });
});
