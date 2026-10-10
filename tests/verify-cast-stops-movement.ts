/**
 * BUG.cast-while-moving-keeps-moving — retail stands the player still when a
 * cast (or an attack request) starts: ClientMagicSystem::CastSpell @ 00568040
 * / FreeHandsAndCastSpell @ 00566ef0 call cmdinterp->MaybeStopCompletely
 * @ 006b3b90 → StopCompletely @ 006b3b50 (ClearAllCommands, SetAutoRun(0),
 * CPhysicsObj::StopCompletely, SendMovementEvent) before the cast goes out.
 * The keys stay down, but move nothing until pressed again; their key-ups
 * send nothing. The golden traces of the retail recording are in
 * tests/verify-retail-movement-golden.ts; these drive the real pieces
 * without DATs.
 *
 * Also the client's run rate (MovementSystem::GetRunRate @ 006b0950): the
 * 18/4 cap is for a Run skill of exactly 800, unlike ACE's >= 800.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { GameActionType, parseMoveToStatePayload } from '@ac/network';
import { getClientRunRate, getPlayerRunRate, getRunRate } from '@ac/shared';
import { maybeStopCompletely, stopCompletely, type StopCompletelyDeps } from '../packages/renderer/src/controllers/StopCompletely.js';
import { CameraController } from '../packages/renderer/src/scene/CameraController.js';
import { MovementSync, type MovementState, type PlayerPosition } from '../packages/renderer/src/network/MovementSync.js';

function recorder(controlled = false) {
  const calls: string[] = [];
  const deps: StopCompletelyDeps = {
    controlledByServer: () => controlled,
    clearAllCommands: () => calls.push('clear'),
    stopPhysics: () => calls.push('physics'),
    sendMovementEvent: () => calls.push('send'),
  };
  return { calls, deps };
}

describe('CommandInterpreter::StopCompletely / MaybeStopCompletely', () => {
  it('StopCompletely: clear the command lists, stop the physics, send the movement event — in that order', () => {
    const r = recorder();
    stopCompletely(r.deps);
    expect(r.calls).toEqual(['clear', 'physics', 'send']);
  });

  it('MaybeStopCompletely stops unless the server controls the player (controlled_by_server)', () => {
    const free = recorder(false);
    expect(maybeStopCompletely(free.deps)).toBe(true);
    expect(free.calls).toEqual(['clear', 'physics', 'send']);
    const server = recorder(true);
    expect(maybeStopCompletely(server.deps)).toBe(false);
    expect(server.calls).toEqual([]);
  });
});

describe('casting while running: the held keys stop counting, the wire says Ready once', () => {
  const POS: PlayerPosition = { worldX: 85 + 169 * 192, worldZ: 20.5 + 180 * 192, groundY: 94, playerYaw: 0, landblock: 0, localX: 0, localY: 0, localZ: 0, inDungeon: false, onGround: true };
  function rig() {
    const cam = new CameraController(new THREE.PerspectiveCamera());
    const sent: Uint8Array[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sync = new MovementSync({ sendMessage: (b: Uint8Array) => { sent.push(b); } } as any, () => 1);
    const state = (): MovementState => ({ forward: cam.isMovingForward, backward: cam.isMovingBackward, turnLeft: cam.isTurningLeft, turnRight: cam.isTurningRight, strafeLeft: cam.isStrafingLeft, strafeRight: cam.isStrafingRight, running: cam.isRunning });
    const kind = (m: Uint8Array) => new DataView(m.buffer, m.byteOffset).getUint32(8, true);
    const mts = () => sent.filter((m) => kind(m) === GameActionType.MoveToState).map((m) => parseMoveToStatePayload(m.subarray(12)).motion);
    const cast = () => maybeStopCompletely({
      controlledByServer: () => false,
      clearAllCommands: () => cam.stopCompletely(),
      stopPhysics: () => {},
      sendMovementEvent: () => sync.sendMovementEventNow(state(), POS, 0),
    });
    return { cam, sync, state, mts, cast };
  }

  it('W + C held, cast: both stop at once, the keys are still down, one stopped MoveToState goes out', () => {
    const r = rig();
    r.cam.simulateKeyDown('KeyW');
    r.cam.simulateKeyDown('KeyC');
    r.sync.update(r.state(), POS, 0);
    expect(r.mts()).toHaveLength(1);
    expect(r.cam.isMovingForward && r.cam.isStrafingRight).toBe(true);

    r.cast();
    expect(r.cam.isMovingForward).toBe(false);
    expect(r.cam.isStrafingRight).toBe(false);
    expect(r.cam.isMoving).toBe(false);
    const motions = r.mts();
    expect(motions).toHaveLength(2);
    expect(motions[1].forwardCommand ?? 0).toBe(0);
    expect(motions[1].sidestepCommand ?? 0).toBe(0);

    // Frames go on with the keys down: no further MoveToState, and none at the key-ups.
    for (let t = 16; t < 4000; t += 16) r.sync.update(r.state(), POS, t);
    r.cam.simulateKeyUp('KeyC');
    r.cam.simulateKeyUp('KeyW');
    r.sync.update(r.state(), POS, 4016);
    expect(r.mts()).toHaveLength(2);
  });

  it('a fresh press after the cast moves again', () => {
    const r = rig();
    r.cam.simulateKeyDown('KeyW');
    r.cast();
    expect(r.cam.isMovingForward).toBe(false);
    r.cam.simulateKeyUp('KeyW');
    r.cam.simulateKeyDown('KeyW');
    expect(r.cam.isMovingForward).toBe(true);
  });

  it('autorun is switched off (SetAutoRun(0, 0))', () => {
    const r = rig();
    r.cam.setAutoRun(true);
    expect(r.cam.isMovingForward).toBe(true);
    r.cast();
    expect(r.cam.autoRun).toBe(false);
    expect(r.cam.isMovingForward).toBe(false);
  });
});

describe('MovementSystem::GetRunRate @ 006b0950 — the client caps at Run 800 exactly', () => {
  it('Run 800 is 18/4; just above it the curve continues below 4.5 (ACE caps from 800 up)', () => {
    expect(getClientRunRate(0, 800)).toBeCloseTo(4.5, 6);
    expect(getClientRunRate(0, 801)).toBeCloseTo((801 / 1001 * 11 + 4) / 4, 6);
    expect(getClientRunRate(0, 801)).toBeLessThan(4.5);
    expect(getRunRate(0, 801)).toBeCloseTo(4.5, 6);
  });

  it('an @god\'d Run of 15225 runs at 3.71 (14.9 m/s) — the retail capture\'s speed — not 4.5 (18 m/s)', () => {
    expect(getClientRunRate(0, 15225)).toBeCloseTo(3.7143, 3);
    expect(getPlayerRunRate(0, 15225, false)).toBeCloseTo(3.7143, 3);
  });

  it('below 800 it is ACE\'s formula, burden and exhaustion included', () => {
    for (const skill of [0, 50, 300, 799]) expect(getClientRunRate(1.5, skill)).toBeCloseTo(getRunRate(1.5, skill), 9);
    expect(getPlayerRunRate(0, 15225, true)).toBeCloseTo(1, 9);
  });
});
