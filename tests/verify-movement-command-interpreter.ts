/**
 * MOVE.combination-sweep — the retail CommandInterpreter rules the
 * combination sweep's decomp diff turned up (docs/movement-ab.md
 * "Combination sweep"), driven through the real CameraController,
 * MovementSync and AttackRequestController:
 *
 *  - the server-control hand-off: LoseControlToServer @ 006b3170,
 *    TakeControlFromServer @ 006b32d0 / ACCmdInterp @ 0058b160, UseTime
 *    @ 006b3bf0, HandleKeyboardCommand @ 006b3690;
 *  - Stop Moving (ACCmdInterp::OnAction @ 0058b370 case 0x2b → SetMotion(Ready));
 *  - autorun's forward hold key (ApplyCurrentMovement @ 006b3430, RawMotionState::Pack @ 0051ed10);
 *  - one movement event per key event (HandleKeyboardCommand → SendMovementEvent);
 *  - postures (AddCommand @ 006b39a0's transient_state);
 *  - PlayerIsDead @ 006b3d70;
 *  - StartAttackRequest @ 0056c040's FinishJump, and UseTime @ 0056c1f0's CancelAttack
 *    when a build leaves the ready position.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CameraController } from '../packages/renderer/src/scene/CameraController.js';
import { MovementSync, type MovementState, type PlayerPosition } from '../packages/renderer/src/network/MovementSync.js';
import { AttackRequestController, type AttackRequestDeps } from '../packages/renderer/src/controllers/AttackRequest.js';
import { decodeMessage } from '../tools/lib/ac-wire.ts';

function cam() {
  const c = new CameraController(new THREE.PerspectiveCamera());
  const log = { aborts: 0, takeBacks: 0, finishJumps: 0, dead: false };
  c.onAbortAutomaticAttack = () => { log.aborts++; };
  c.onTakeControlFromServer = () => { log.takeBacks++; };
  c.onFinishJump = () => { log.finishJumps++; };
  c.playerIsDead = () => log.dead;
  return { c, log };
}

const POS: PlayerPosition = { worldX: 85 + 169 * 192, worldZ: 20.5 + 180 * 192, groundY: 94, playerYaw: 0, landblock: 0, localX: 0, localY: 0, localZ: 0, inDungeon: false, onGround: true };
const stateOf = (c: CameraController): MovementState => ({
  forward: c.isMovingForward, backward: c.isMovingBackward, turnLeft: c.isTurningLeft, turnRight: c.isTurningRight,
  strafeLeft: c.isStrafingLeft, strafeRight: c.isStrafingRight, running: c.isRunning, forwardHoldRun: c.rawForwardHoldRun,
  runToggle: c.runToggle, serverControlled: c.controlledByServer || c.consumeSilentTakeBack(), movementEvent: c.movementEvents,
});
function wire() {
  const sent: Uint8Array[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sync = new MovementSync({ sendMessage: (b: Uint8Array) => { sent.push(b); } } as any, () => 1);
  const mts = () => sent.map((b) => decodeMessage(b)).filter((a) => a?.kind === 'moveToState');
  return { sync, mts };
}

describe('server control (LoseControlToServer / TakeControlFromServer / UseTime)', () => {
  it('a server motion ends autorun and a jump charge, and held keys move nothing', () => {
    const { c, log } = cam();
    c.handleKeyDown('KeyW');
    c.toggleAutoRun();
    c.loseControlToServer();
    expect(c.autoRun).toBe(false);
    expect(log.finishJumps).toBe(1);
    expect(c.controlledByServer).toBe(true);
    expect(c.isMovingForward).toBe(false);
  });

  it('a key-up under server control only leaves its list: no movement event, no attack abort', () => {
    const { c, log } = cam();
    c.handleKeyDown('KeyC');
    c.loseControlToServer();
    const events = c.movementEvents; const aborts = log.aborts;
    c.handleKeyUp('KeyC');
    expect(c.movementEvents).toBe(events);
    expect(log.aborts).toBe(aborts);
    expect(c.controlledByServer).toBe(true);
  });

  it('a fresh key-down takes control back: abort, stop the body, then the key applies and is sent', () => {
    const { c, log } = cam();
    c.handleKeyDown('KeyW');
    c.loseControlToServer();
    const events = c.movementEvents;
    c.handleKeyDown('KeyC');
    expect(log.takeBacks).toBe(1);
    expect(log.aborts).toBeGreaterThan(0);
    expect(c.controlledByServer).toBe(false);
    expect(c.isMovingForward).toBe(true); // the held W applies again
    expect(c.isStrafingRight).toBe(true);
    expect(c.movementEvents).toBe(events + 1);
  });

  it('UseTime takes control back once the motions are done, only with something held, and silently', () => {
    const { c, log } = cam();
    c.loseControlToServer();
    c.useTime(false, false);
    expect(c.controlledByServer).toBe(true); // nothing held: the server keeps control
    c.handleKeyDown('KeyD'); // a key-down takes it back itself
    c.loseControlToServer();
    c.useTime(true, false);
    expect(c.controlledByServer).toBe(true); // a motion still playing
    c.useTime(false, true);
    expect(c.controlledByServer).toBe(true); // a MoveTo running
    const events = c.movementEvents;
    c.useTime(false, false);
    expect(c.controlledByServer).toBe(false);
    expect(c.isTurningRight).toBe(true);
    expect(c.movementEvents).toBe(events);
    expect(c.consumeSilentTakeBack()).toBe(true);
    expect(c.consumeSilentTakeBack()).toBe(false);
    expect(log.takeBacks).toBe(2);
  });

  it('the dead stay the server\'s (PlayerIsDead)', () => {
    const { c, log } = cam();
    c.loseControlToServer();
    log.dead = true;
    c.handleKeyDown('KeyW');
    expect(c.controlledByServer).toBe(true);
    expect(c.isMovingForward).toBe(false);
  });

  it('MovementSync absorbs the changes under server control and the silent take-back; the next key event sends the whole state', () => {
    const { c } = cam();
    const { sync, mts } = wire();
    sync.update(stateOf(c), POS, 0);
    c.handleKeyDown('KeyW');
    sync.update(stateOf(c), POS, 16);
    expect(mts()).toHaveLength(1);
    c.loseControlToServer();
    sync.update(stateOf(c), POS, 32); // the run stops under the server: no MoveToState
    c.useTime(false, false); // W still held: take-back
    sync.update(stateOf(c), POS, 48);
    expect(mts()).toHaveLength(1);
    c.handleKeyDown('KeyC');
    sync.update(stateOf(c), POS, 64);
    const all = mts();
    expect(all).toHaveLength(2);
    const last = all[1]!;
    expect(last.kind === 'moveToState' && last.raw.forward).toBe(0x45000005);
    expect(last.kind === 'moveToState' && last.raw.sidestep).toBe(0x6500000f);
  });
});

describe('every movement key event aborts an automatic attack (ACCmdInterp::TakeControlFromServer)', () => {
  it('turn and strafe keys too, presses and releases', () => {
    const { c, log } = cam();
    c.handleKeyDown('KeyD');
    c.handleKeyUp('KeyD');
    c.handleKeyDown('KeyZ');
    expect(log.aborts).toBe(3);
  });
});

describe('Stop Moving (S, 0x2b): DoMotion(Ready) with Move Forward still held', () => {
  it('the held W stops; its release changes nothing; a fresh press runs again', () => {
    const { c } = cam();
    c.handleKeyDown('KeyW');
    c.stopMoving();
    expect(c.isMovingForward).toBe(false);
    c.handleKeyUp('KeyW');
    expect(c.isMovingForward).toBe(false);
    c.handleKeyDown('KeyW');
    expect(c.isMovingForward).toBe(true);
  });

  it('a release that hands the list head to another held key applies it (NukeCommand)', () => {
    const { c } = cam();
    c.handleKeyDown('KeyW');
    c.handleKeyDown('KeyS'); // canonical backward on top
    c.stopMoving();
    expect(c.isMovingBackward).toBe(false);
    c.handleKeyUp('KeyS');
    expect(c.isMovingForward).toBe(true);
  });

  it('a strafe keeps going, autorun ends, and a movement event is raised even standing still', () => {
    const { c } = cam();
    const before = c.movementEvents;
    c.stopMoving();
    expect(c.movementEvents).toBe(before + 1);
    c.handleKeyDown('KeyC');
    c.toggleAutoRun();
    c.stopMoving();
    expect(c.isStrafingRight).toBe(true);
    expect(c.autoRun).toBe(false);
  });
});

describe('autorun runs the forward command only (HoldKey_Run on the forward command)', () => {
  it('Shift with autorun: the forward still runs, the turn is a walk turn', () => {
    const { c } = cam();
    c.toggleAutoRun();
    c.handleKeyDown('ShiftLeft');
    expect(c.isForwardRunning).toBe(true);
    expect(c.isRunning).toBe(false);
    c.handleKeyDown('KeyD');
    const yaw0 = c.playerYaw;
    for (let i = 0; i < 60; i++) c.update(1 / 60);
    // 1.5 rad/s walking (× 1.5 run_turn_factor only with the Run hold key).
    expect(c.playerYaw - yaw0).toBeCloseTo(1.5, 2);
  });

  it('the autorun MoveToState packs ForwardHoldKey Run (flag 0x8)', () => {
    const { c } = cam();
    const { sync, mts } = wire();
    sync.update(stateOf(c), POS, 0);
    c.toggleAutoRun();
    sync.update(stateOf(c), POS, 16);
    const m = mts()[0]!;
    expect(m.kind === 'moveToState' && (m.raw.flags & 0x8)).toBe(0x8);
    expect(m.kind === 'moveToState' && m.raw.forwardHold).toBe(2);
  });
});

describe('one MoveToState per key event (HandleKeyboardCommand → SendMovementEvent)', () => {
  it('W, then X on top, then W up (not the head): three MoveToStates, the last unchanged', () => {
    const { c } = cam();
    const { sync, mts } = wire();
    sync.update(stateOf(c), POS, 0);
    c.handleKeyDown('KeyW'); sync.update(stateOf(c), POS, 16);
    c.handleKeyDown('KeyS'); sync.update(stateOf(c), POS, 32);
    c.handleKeyUp('KeyW'); sync.update(stateOf(c), POS, 48);
    const all = mts();
    expect(all).toHaveLength(3);
    expect(all[1]!.kind === 'moveToState' && all[1]!.bytes).toBe(all[2]!.kind === 'moveToState' && all[2]!.bytes);
  });
});

describe('postures (Sit / Crouch / Sleep): transient_state', () => {
  it('a posture stops a held W, ends autorun, and W\'s release hands nothing back', () => {
    const { c } = cam();
    c.handleKeyDown('KeyW');
    c.handleKeyDown('KeyS');
    c.toggleAutoRun();
    c.applyPosture();
    expect(c.autoRun).toBe(false);
    expect(c.isMovingForward || c.isMovingBackward).toBe(false);
    c.handleKeyUp('KeyS');
    expect(c.isMovingForward).toBe(false);
    c.handleKeyDown('KeyX'); // not a movement key: still seated
    expect(c.isMovingForward).toBe(false);
    c.handleKeyUp('KeyW');
    c.handleKeyDown('KeyW');
    expect(c.isMovingForward).toBe(true);
  });
});

describe('the long-jump charge keeps the stop coast (standing_longjump blocks new motions only)', () => {
  it('the sequence offset still moves the body; the interpreted state holds Ready', () => {
    const { c } = cam();
    c.handleKeyDown('KeyW');
    c.standingLongJump = true;
    expect(c.interpretedMotion().forward).toBe(0x41000003);
    c.sequenceStep = () => ({ x: 0, y: 0.05 });
    const z0 = c.camera.position.z;
    c.update(1 / 60);
    expect(c.camera.position.z).not.toBe(z0);
  });
});

function attack(over: Partial<AttackRequestDeps> = {}) {
  const st = { ready: true, repeat: true, cancels: 0, calls: [] as string[] };
  const deps: AttackRequestDeps = {
    now: () => 100, getTarget: () => 0x80000001, isAttackable: () => true, inReadyPosition: () => st.ready,
    combatMode: () => 'missile', currentStyle: () => 0x8000003f, sliderPower: () => 0.5, autoRepeat: () => st.repeat,
    sendAttack: () => {}, setPowerBarLevel: () => {}, showError: () => {}, sendCancelAttack: () => { st.cancels++; },
    autoTarget: () => true, lastAttacker: () => 0, objectPresent: () => true, selectObject: () => {}, selectNextCompassItem: () => {},
    finishJump: () => st.calls.push('finishJump'), maybeStopCompletely: () => st.calls.push('maybeStop'),
    ...over,
  };
  return { c: new AttackRequestController(deps), st };
}

describe('ClientCombatSystem against movement', () => {
  it('StartAttackRequest ends a jump charge (FinishJump), then stops the player', () => {
    const { c, st } = attack();
    c.setRequestedAttackHeight('medium');
    expect(st.calls).toEqual(['finishJump', 'maybeStop']);
  });

  it('a build that leaves the ready position (a missile build while running) cancels the attack under Repeat Attacks', () => {
    const { c, st } = attack();
    c.setRequestedAttackHeight('medium');
    st.ready = false;
    c.useTime();
    expect(st.cancels).toBe(1);
  });

  it('without Repeat Attacks nothing is sent', () => {
    const { c, st } = attack();
    st.repeat = false;
    c.setRequestedAttackHeight('medium');
    st.ready = false;
    c.useTime();
    expect(st.cancels).toBe(0);
  });
});

describe('Alt chords: the retail KeyMap binds Strafe Right / Left to Alt+D / Alt+A', () => {
  it('Alt held at the D press strafes; D alone turns', async () => {
    const { KeybindRegistry } = await import('../packages/renderer/src/input/KeybindRegistry.js');
    const { DEFAULT_KEYBINDS, MOVEMENT_CANONICAL } = await import('../packages/renderer/src/input/KeybindDefaults.js');
    const reg = new KeybindRegistry(DEFAULT_KEYBINDS);
    const { c } = cam();
    c.keyTranslator = (code) => { const id = reg.resolve(code); return id != null ? MOVEMENT_CANONICAL[id] ?? null : null; };
    c.handleKeyDown('KeyD', false, true);
    expect(c.isStrafingRight).toBe(true);
    expect(c.isTurningRight).toBe(false);
    c.handleKeyUp('KeyD');
    expect(c.isStrafingRight).toBe(false);
    c.handleKeyDown('KeyD');
    expect(c.isTurningRight).toBe(true);
  });
});

describe('only a key bound to a movement command moves', () => {
  it('S (Stop Moving in the retail keymap) does not walk backwards; X does', async () => {
    const { KeybindRegistry } = await import('../packages/renderer/src/input/KeybindRegistry.js');
    const { DEFAULT_KEYBINDS, MOVEMENT_CANONICAL } = await import('../packages/renderer/src/input/KeybindDefaults.js');
    const reg = new KeybindRegistry(DEFAULT_KEYBINDS);
    const { c } = cam();
    c.keyTranslator = (code) => { const id = reg.resolve(code); return id != null ? MOVEMENT_CANONICAL[id] ?? null : null; };
    const events = c.movementEvents;
    c.handleKeyDown('KeyS');
    expect(c.isMovingBackward).toBe(false);
    c.handleKeyUp('KeyS');
    expect(c.movementEvents).toBe(events); // its release sends nothing either
    c.handleKeyDown('KeyX');
    expect(c.isMovingBackward).toBe(true);
  });
});

describe('a modifier chord with no binding of its own answers as the bare key (KeybindRegistry.resolveOrBare)', () => {
  it('Shift+1 is Spell Slot 1 (retail casts while walking); Alt+D keeps its own Strafe Right binding', async () => {
    const { KeybindRegistry } = await import('../packages/renderer/src/input/KeybindRegistry.js');
    const { DEFAULT_KEYBINDS, ACT } = await import('../packages/renderer/src/input/KeybindDefaults.js');
    const { CombatMode } = await import('@ac/shared');
    const { activeInputMaps } = await import('../packages/renderer/src/input/KeybindDefaults.js');
    const reg = new KeybindRegistry(DEFAULT_KEYBINDS);
    reg.setActiveInputMaps(activeInputMaps(CombatMode.Magic));
    expect(reg.resolve('Shift+Digit1')).toBeNull();
    expect(reg.resolveOrBare('Shift+Digit1')).toBe(ACT.SpellSlot1);
    expect(reg.resolveOrBare('Alt+KeyD')).toBe(ACT.StrafeRight);
    expect(reg.resolveOrBare('Shift+Escape')).toBe(reg.resolve('Shift+Escape'));
  });
});
