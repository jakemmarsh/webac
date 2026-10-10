/**
 * Decomp-diff sweep 2026-09-30 — local input, selection and jump
 * (docs/decomp-diff-sweep-2026-09-30.md rows P1, P4, P5, P6, P7).
 *
 *  - DECOMP.empty-click-deselects (P1): UIElement_SmartBoxWrapper::MouseDown
 *    @ 004e5700 finds on the left PRESS; RecvNotice_SmartBoxObjectFound
 *    @ 004e5ad0 never calls SetSelectedObject for a found id of 0.
 *  - DECOMP.autorun-cancel-notice (P4): CInputManager::ActivateActionKey
 *    @ 00432650 — the start of Move Forward / Backward / Stop Moving calls
 *    TurnOffRunLock; CommandInterpreter::SetAutoRun @ 006b4850 raises
 *    "AutoRun ON" / "AutoRun OFF" at 0x1a; a held key toggles once.
 *  - DECOMP.movement-key-lists (P5): CommandList::AddCommand @ 006b4b80
 *    pushes at the head, ApplyListHeadMovement @ 006b3510 applies the head.
 *  - DECOMP.standing-long-jump (P6): CMotionInterp::charge_jump @ 005281c0.
 *  - DECOMP.jump-blocked-by-actions (P7): motion_allows_jump @ 005279e0 +
 *    jump_is_allowed @ 005282b0 and the CommenceJump / DoJump lines.
 *
 * Behavioral: the real CameraController, CharacterAnimController,
 * MovementSync, ClientNotices and WorldSelectPress modules.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as THREE from 'three';
import { parseMoveToStatePayload, parseAutonomousPositionPayload, GameActionType } from '@ac/network';
import { CameraController } from '../packages/renderer/src/scene/CameraController.js';
import {
  CharacterAnimController, JumpError, motionAllowsJump, MIN_JUMP_EXTENT,
} from '../packages/renderer/src/animation/CharacterAnimController.js';
import { MotionManager } from '../packages/renderer/src/animation/MotionManager.js';
import { MotionCommand } from '../packages/renderer/src/animation/MotionCommands.js';
import { MovementSync, type MovementState } from '../packages/renderer/src/network/MovementSync.js';
import { CLIENT_NOTICES, jumpRefusalNotice, raiseClientNotice } from '../packages/renderer/src/ui/ClientNotices.js';
import { WORLD_SELECT_EVENT, isWorldSelectPress, selectionAfterFind } from '../packages/renderer/src/controllers/WorldSelectPress.js';
import { jumpLaunchVelocity } from '../packages/renderer/src/player/JumpLaunch.js';
import { RUN_ANIM_SPEED } from '../packages/shared/src/index.js';

const g = globalThis as unknown as { document?: unknown };
let savedDocument: unknown;
beforeAll(() => { savedDocument = g.document; g.document = { activeElement: null }; });
afterAll(() => { g.document = savedDocument; });

function cam(): CameraController {
  return new CameraController(new THREE.PerspectiveCamera(60, 1.6, 0.1, 1000));
}

function keyEvent(type: 'keydown' | 'keyup', code: string, repeat = false): Event {
  const e = new Event(type);
  Object.assign(e, { code, repeat, preventDefault: () => {} });
  return e;
}

function bound(): { cc: CameraController; el: EventTarget } {
  const cc = cam();
  const el = new EventTarget();
  cc.bind(el as unknown as HTMLElement);
  return { cc, el };
}

// ── P1 ──────────────────────────────────────────────────────────────────
describe('DECOMP.empty-click-deselects — select on the press; a miss keeps the selection', () => {
  it('the select rides on mousedown of the left button only', () => {
    expect(WORLD_SELECT_EVENT).toBe('mousedown');
    expect(isWorldSelectPress({ button: 0 })).toBe(true);
    expect(isWorldSelectPress({ button: 1 })).toBe(false);
    expect(isWorldSelectPress({ button: 2 })).toBe(false);
  });

  it('a found object becomes the selection', () => {
    expect(selectionAfterFind(0x50000001, 0x50000002)).toBe(0x50000002);
    expect(selectionAfterFind(null, 0x50000002)).toBe(0x50000002);
  });

  it('a press on nothing (found 0) leaves the selection alone', () => {
    expect(selectionAfterFind(0x50000001, 0)).toBe(0x50000001);
    expect(selectionAfterFind(null, 0)).toBeNull();
  });
});

// ── P4 ──────────────────────────────────────────────────────────────────
describe('DECOMP.autorun-cancel-notice — the run lock and its notices', () => {
  it('Move Forward cancels autorun (old code only cancelled on backward)', () => {
    const cc = cam();
    const changes: boolean[] = [];
    cc.onAutoRunChange = (on) => changes.push(on);
    cc.toggleAutoRun();
    expect(cc.autoRun).toBe(true);
    cc.simulateKeyDown('KeyW');
    expect(cc.autoRun).toBe(false);
    expect(changes).toEqual([true, false]);
    // The held forward key still moves the player (it is the head now).
    expect(cc.isMovingForward).toBe(true);
  });

  it('Move Backward and Stop Moving cancel it too; turning and strafing do not', () => {
    for (const cancel of [(c: CameraController) => c.simulateKeyDown('KeyS'), (c: CameraController) => c.stopMoving()]) {
      const cc = cam();
      cc.autoRun = true;
      cancel(cc);
      expect(cc.autoRun).toBe(false);
    }
    const cc = cam();
    cc.autoRun = true;
    for (const k of ['KeyA', 'KeyD', 'KeyZ', 'KeyC', 'ShiftLeft', 'Space']) cc.simulateKeyDown(k);
    expect(cc.autoRun).toBe(true);
  });

  it('SetAutoRun raises a notice only on a change', () => {
    const cc = cam();
    const changes: boolean[] = [];
    cc.onAutoRunChange = (on) => changes.push(on);
    cc.setAutoRun(false);
    cc.setAutoRun(true);
    cc.setAutoRun(true);
    cc.setAutoRun(false);
    expect(changes).toEqual([true, false]);
  });

  it('the Autorun key toggles once per press — OS key repeats are ignored', () => {
    const { cc, el } = bound();
    el.dispatchEvent(keyEvent('keydown', 'NumLock'));
    el.dispatchEvent(keyEvent('keydown', 'NumLock', true));
    el.dispatchEvent(keyEvent('keydown', 'NumLock', true));
    expect(cc.autoRun).toBe(true);
    el.dispatchEvent(keyEvent('keyup', 'NumLock'));
    el.dispatchEvent(keyEvent('keydown', 'NumLock'));
    expect(cc.autoRun).toBe(false);
  });

  it('a held forward key\'s repeats do not cancel an autorun turned on meanwhile', () => {
    const { cc, el } = bound();
    el.dispatchEvent(keyEvent('keydown', 'KeyW'));
    cc.toggleAutoRun();
    el.dispatchEvent(keyEvent('keydown', 'KeyW', true));
    expect(cc.autoRun).toBe(true);
  });

  it('the notices are the retail strings in the 0x1a spew sink', () => {
    expect(CLIENT_NOTICES.autoRunOn.text).toBe('AutoRun ON');
    expect(CLIENT_NOTICES.autoRunOff.text).toBe('AutoRun OFF');
    const spew: string[] = [];
    const chat: string[] = [];
    const surface = { displayErrorText: (t: string) => spew.push(t), addSystemMessage: (t: string) => chat.push(t) };
    raiseClientNotice(surface, CLIENT_NOTICES.autoRunOn);
    expect(spew).toEqual(['AutoRun ON']);
    expect(chat).toEqual([]);
  });
});

// ── P5 ──────────────────────────────────────────────────────────────────
describe('DECOMP.movement-key-lists — the latest press on each axis wins', () => {
  it('W then S: backward (S is the head); releasing S hands back to W', () => {
    const cc = cam();
    cc.simulateKeyDown('KeyW');
    cc.simulateKeyDown('KeyS');
    expect(cc.isMovingForward).toBe(false);
    expect(cc.isMovingBackward).toBe(true);
    cc.simulateKeyUp('KeyS');
    expect(cc.isMovingForward).toBe(true);
    expect(cc.isMovingBackward).toBe(false);
  });

  it('S then W: forward; W+S no longer creeps forward at the difference of the speeds', () => {
    const cc = cam();
    cc.simulateKeyDown('KeyS');
    cc.simulateKeyDown('KeyW');
    expect(cc.isMovingForward).toBe(true);
    expect(cc.isMovingBackward).toBe(false);
    expect(cc.stateVelocity().forward).toBeCloseTo(RUN_ANIM_SPEED, 6);
  });

  it('A then D turns right; releasing D turns left again (no stall)', () => {
    const cc = cam();
    cc.simulateKeyDown('KeyA');
    cc.simulateKeyDown('KeyD');
    expect(cc.isTurningRight).toBe(true);
    expect(cc.isTurningLeft).toBe(false);
    const yaw0 = cc.playerYaw;
    cc.update(0.1);
    expect(cc.playerYaw).toBeGreaterThan(yaw0);
    cc.simulateKeyUp('KeyD');
    expect(cc.isTurningLeft).toBe(true);
    const yaw1 = cc.playerYaw;
    cc.update(0.1);
    expect(cc.playerYaw).toBeLessThan(yaw1);
  });

  it('Z then C strafes right only', () => {
    const cc = cam();
    cc.simulateKeyDown('KeyZ');
    cc.simulateKeyDown('KeyC');
    expect(cc.isStrafingRight).toBe(true);
    expect(cc.isStrafingLeft).toBe(false);
    expect(cc.stateVelocity().side).toBeGreaterThan(0);
  });

  it('the axes are independent lists: forward + strafe still combine', () => {
    const cc = cam();
    cc.simulateKeyDown('KeyW');
    cc.simulateKeyDown('KeyC');
    expect(cc.isMovingForward).toBe(true);
    expect(cc.isStrafingRight).toBe(true);
  });

  it('the MoveToState forward command is the list head (W then S sends WalkBackwards)', () => {
    const cc = cam();
    cc.simulateKeyDown('KeyW');
    cc.simulateKeyDown('KeyS');
    const sent: Uint8Array[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sync = new MovementSync({ sendMessage: (b: Uint8Array) => { sent.push(b); } } as any, () => 1);
    const state: MovementState = {
      forward: cc.isMovingForward, backward: cc.isMovingBackward,
      turnLeft: cc.isTurningLeft, turnRight: cc.isTurningRight,
      strafeLeft: cc.isStrafingLeft, strafeRight: cc.isStrafingRight, running: cc.isRunning,
    };
    sync.sendMovementEventNow(state, POS, 0);
    expect(parseMoveToStatePayload(sent[0].subarray(12)).motion.forwardCommand).toBe(MotionCommand.WalkBackwards);
  });
});

const POS = {
  worldX: 100, worldZ: 200, groundY: 10, playerYaw: 0, landblock: 0xa9b4ffff,
  localX: 100, localY: 8, localZ: 20, inDungeon: false, onGround: true,
};

// ── Jump harness ────────────────────────────────────────────────────────
const STYLE = 0x3d;
const ck = (m: number): number => MotionManager.compositeKey(STYLE, m & 0xFFFFF);

function jumpRig(opts: { playing?: number; stance?: number } = {}) {
  const mm = {
    queueAction: () => {},
    setStanceFromId: () => {},
    changeStyle: () => true,
    requestMotion: (_key: number, _speed?: number): boolean => true,
    setForwardMotion: (_key: number, _speed?: number): boolean => true,
    removeLinkAnimations: (): void => {},
    isPlayingAction: opts.playing !== undefined,
    motion: opts.playing !== undefined ? opts.playing : ck(MotionCommand.Ready),
    stance: ck(opts.stance ?? MotionCommand.Ready),
    styleKey: STYLE,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cac = new CharacterAnimController(mm as any);
  const refused: number[] = [];
  cac.onJumpRefused = (code) => refused.push(code);
  return { cac, mm, refused };
}

/** Press the jump key (edge), charge `seconds`, and return the controller's input object. */
function charge(cac: CharacterAnimController, cc: CameraController, seconds = 0.5): void {
  cc.simulateKeyDown('Space');
  cac.update(0, cc);
  cac.update(seconds, cc);
}

// ── P6 ──────────────────────────────────────────────────────────────────
describe('DECOMP.standing-long-jump — CMotionInterp::charge_jump', () => {
  it('a charge begun standing still is a standing long jump', () => {
    const { cac } = jumpRig();
    const cc = cam();
    charge(cac, cc);
    expect(cac.jumpCharging).toBe(true);
    expect(cac.standingLongJump).toBe(true);
  });

  it('not when moving, turning or strafing at the press', () => {
    for (const k of ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'KeyZ', 'KeyC']) {
      const { cac } = jumpRig();
      const cc = cam();
      cc.simulateKeyDown(k);
      charge(cac, cc);
      expect(cac.standingLongJump, k).toBe(false);
    }
  });

  it('not in the air', () => {
    const { cac } = jumpRig();
    cac.leaveGround();
    const cc = cam();
    charge(cac, cc);
    expect(cac.jumpCharging).toBe(true);
    expect(cac.standingLongJump).toBe(false);
  });

  it('keys pressed during the charge do not move the body, the animation stays Ready', () => {
    const requested: number[] = [];
    const { cac, mm } = jumpRig();
    mm.requestMotion = (k: number) => { requested.push(k); return true; };
    mm.setForwardMotion = (k: number) => { requested.push(k); return true; };
    const cc = cam();
    charge(cac, cc);
    cc.simulateKeyDown('KeyW');
    cc.standingLongJump = cac.standingLongJump; // main.ts mirrors it every frame
    const before = cc.camera.position.clone();
    cc.update(0.25);
    expect(cc.camera.position.distanceTo(before)).toBe(0);
    requested.length = 0;
    cac.update(0.016, cc);
    expect(requested.every((k) => k === ck(MotionCommand.Ready))).toBe(true);
  });

  it('the release launches with the held keys\' full run velocity, and the flag clears', () => {
    const { cac } = jumpRig();
    const cc = cam();
    cc.runRate = 2;
    charge(cac, cc);
    cc.simulateKeyDown('KeyW');
    cc.simulateKeyUp('Space');
    const extent = cac.triggerJump(cc);
    expect(extent).not.toBeNull();
    expect(cac.standingLongJump).toBe(false);
    expect(jumpLaunchVelocity(cc, 4).local.y).toBeCloseTo(RUN_ANIM_SPEED * 2, 6);
  });

  it('the MoveToState carries the 0x2 bit while it is set; the AutonomousPosition never does', () => {
    const sent: Uint8Array[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sync = new MovementSync({ sendMessage: (b: Uint8Array) => { sent.push(b); } } as any, () => 1);
    const idle: MovementState = {
      forward: false, backward: false, turnLeft: false, turnRight: false,
      strafeLeft: false, strafeRight: false, running: true,
    };
    sync.update(idle, POS, 0); // first frame: an AutonomousPosition
    // CommenceJump's movement event (the charge start) carries the flag.
    sync.update({ ...idle, standingLongJump: true, jumpCharging: true }, POS, 16);
    const kind = (m: Uint8Array) => new DataView(m.buffer, m.byteOffset).getUint32(8, true);
    const mts = sent.filter((m) => kind(m) === GameActionType.MoveToState);
    expect(mts).toHaveLength(1);
    const tail = parseMoveToStatePayload(mts[0].subarray(12)).position;
    expect(tail.standingLongJump).toBe(true);
    expect(tail.contact).toBe(true);
    const ap = sent.filter((m) => kind(m) === GameActionType.AutonomousPosition);
    expect(ap.length).toBeGreaterThan(0);
    for (const m of ap) expect(parseAutonomousPositionPayload(m.subarray(12)).standingLongJump).toBeUndefined();
  });
});

// ── P7 ──────────────────────────────────────────────────────────────────
describe('DECOMP.jump-blocked-by-actions — motion_allows_jump and the refusal lines', () => {
  it('motion_allows_jump blocks exactly the retail ranges', () => {
    const blocked = [
      MotionCommand.MagicPowerUp01, MotionCommand.MagicPowerUp10, MotionCommand.TripleThrustLow,
      MotionCommand.MagicPowerUp07Purple, MotionCommand.Fallen, MotionCommand.Reload, MotionCommand.Pickup,
      MotionCommand.AimLevel, MotionCommand.MagicBlast, MotionCommand.MagicPray,
      MotionCommand.Crouch, MotionCommand.Sitting, MotionCommand.Sleeping,
    ];
    for (const m of blocked) expect(motionAllowsJump(m), m.toString(16)).toBe(JumpError.YouCantJumpFromThisPosition);
    const allowed = [
      MotionCommand.Ready, MotionCommand.WalkForward, MotionCommand.RunForward, MotionCommand.SlashHigh,
      MotionCommand.MagicPowerUp08Purple, MotionCommand.Falling, MotionCommand.Interpolating,
    ];
    for (const m of allowed) expect(motionAllowsJump(m), m.toString(16)).toBe(JumpError.None);
  });

  it('a melee swing in progress does not block the jump (the old code refused any action)', () => {
    const { cac, refused } = jumpRig({ playing: MotionCommand.SlashHigh });
    const cc = cam();
    charge(cac, cc);
    expect(cac.jumpCharging).toBe(true);
    cc.simulateKeyUp('Space');
    expect(cac.triggerJump(cc)).not.toBeNull();
    expect(refused).toEqual([]);
  });

  it('a spell windup in progress: the charge starts, the release is refused "from this position"', () => {
    const { cac, refused } = jumpRig({ playing: MotionCommand.MagicPowerUp03 });
    const cc = cam();
    charge(cac, cc);
    expect(cac.jumpCharging).toBe(true);
    cc.simulateKeyUp('Space');
    expect(cac.triggerJump(cc)).toBeNull();
    expect(cac.jumpCharging).toBe(false);
    expect(cac.airborne).toBe(false);
    expect(refused).toEqual([JumpError.YouCantJumpFromThisPosition]);
  });

  it('sitting refuses the charge at once', () => {
    const { cac, refused } = jumpRig({ stance: MotionCommand.Sitting });
    charge(cac, cam());
    expect(cac.jumpCharging).toBe(false);
    expect(refused).toEqual([JumpError.YouCantJumpFromThisPosition]);
  });

  it('a load of 2.0 or more refuses the charge "too loaded down"', () => {
    const { cac, refused } = jumpRig();
    cac.load = 2.0;
    charge(cac, cam());
    expect(cac.jumpCharging).toBe(false);
    expect(refused).toEqual([JumpError.CantJumpLoadedDown]);
  });

  it('a charge held into the air is refused at the release "while in the air"', () => {
    const { cac, refused } = jumpRig();
    const cc = cam();
    cac.leaveGround();
    charge(cac, cc);
    cc.simulateKeyUp('Space');
    expect(cac.triggerJump(cc)).toBeNull();
    expect(refused).toEqual([JumpError.YouCantJumpWhileInTheAir]);
  });

  it('a tap still jumps at MIN_JUMP_EXTENT', () => {
    const { cac } = jumpRig();
    const cc = cam();
    cc.simulateKeyDown('Space');
    cac.update(0, cc);
    cc.simulateKeyUp('Space');
    expect(cac.triggerJump(cc)).toBe(MIN_JUMP_EXTENT);
  });

  it('the refusal lines are the retail strings, in the 0x1a sink; other codes are silent', () => {
    expect(jumpRefusalNotice(0x48)?.text).toBe("You can't jump from this position");
    expect(jumpRefusalNotice(0x24)?.text).toBe("You can't jump while in the air");
    expect(jumpRefusalNotice(0x49)?.text).toBe("You're too loaded down to jump");
    for (const c of [0x24, 0x48, 0x49]) expect(jumpRefusalNotice(c)?.sink).toBe('spew');
    expect(jumpRefusalNotice(0x47)).toBeNull();
  });
});
