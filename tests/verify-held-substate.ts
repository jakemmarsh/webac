/**
 * VISUAL.emote-poses-not-held — Sit (G), Crouch (H) and Lay Down (B) are
 * emote input actions (ACCmdInterp::InitializeEmoteInputActionHash @ 0058b510:
 * Ready 0x10000094 → 0x41000003, Crouch 0x10000095 → 0x41000012, Sitting
 * 0x10000096 → 0x41000013, Sleeping 0x10000097 → 0x41000014); OnAction
 * @ 0058b370 runs SetMotion(command, true). The substate is held as the idle
 * forward motion and sent as the MoveToState forward command until a forward,
 * backward or sidestep command overwrites it.
 */
import { describe, it, expect } from 'vitest';
import type { DatDatabase } from '@ac/dat-parser/DatDatabase.js';
import { parseMoveToStatePayload } from '@ac/network';
import { MotionManager } from '../packages/renderer/src/animation/MotionManager.js';
import { MotionCommand } from '../packages/renderer/src/animation/MotionCommands.js';
import { CharacterAnimController } from '../packages/renderer/src/animation/CharacterAnimController.js';
import { MovementSync, type MovementState } from '../packages/renderer/src/network/MovementSync.js';
import { ACT } from '../packages/renderer/src/input/KeybindDefaults.js';

const POS = { worldX: 100, worldZ: 200, groundY: 30, playerYaw: 0, landblock: 0, localX: 0, localY: 0, localZ: 0, inDungeon: false, onGround: true };
const IDLE: MovementState = { forward: false, backward: false, turnLeft: false, turnRight: false, strafeLeft: false, strafeRight: false, running: true };

type Input = { isMovingForward: boolean; isMovingBackward: boolean; isStrafingLeft: boolean; isStrafingRight: boolean; isTurningLeft: boolean; isTurningRight: boolean; isRunning: boolean };
const input = (over: Partial<Input> = {}): Input => ({
  isMovingForward: false, isMovingBackward: false, isStrafingLeft: false, isStrafingRight: false,
  isTurningLeft: false, isTurningRight: false, isRunning: true, ...over,
});

describe('held substate emote actions', () => {
  it('the ActionMap ids are the retail emote-input actions', () => {
    expect([ACT.Ready, ACT.Crouch, ACT.Sitting, ACT.Sleeping]).toEqual([0x10000094, 0x10000095, 0x10000096, 0x10000097]);
  });

  it('Sit holds as the idle forward motion; a forward key overwrites it; Ready releases it', () => {
    const mm = new MotionManager({} as DatDatabase);
    const forwards: number[] = [];
    mm.setForwardMotion = (key: number) => { forwards.push(key & 0xFFFFF); return true; };
    const c = new CharacterAnimController(mm);
    c.setHeldSubstate(MotionCommand.Sitting);
    expect(c.heldSubstate).toBe(MotionCommand.Sitting);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    c.update(0.016, input() as any);
    expect(forwards.at(-1)).toBe(MotionCommand.Sitting & 0xFFFFF);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    c.update(0.016, input({ isMovingForward: true }) as any);
    expect(c.heldSubstate).toBe(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    c.update(0.016, input() as any);
    expect(forwards.at(-1)).toBe(MotionCommand.Ready & 0xFFFFF);
    c.setHeldSubstate(MotionCommand.Crouch);
    c.setHeldSubstate(MotionCommand.Ready);
    expect(c.heldSubstate).toBe(0);
  });

  it('MoveToState carries the held substate as its forward command, and a change triggers the send', () => {
    const sent: Uint8Array[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sync = new MovementSync({ sendMessage: (b: Uint8Array) => { sent.push(b); } } as any, () => 1);
    sync.update(IDLE, POS, 0);
    const before = sent.length;
    sync.update({ ...IDLE, substate: MotionCommand.Sitting }, POS, 50);
    const mts = sent.slice(before).filter((b) => new DataView(b.buffer, b.byteOffset).getUint32(8, true) === 0xf61c);
    expect(mts.length).toBeGreaterThan(0);
    expect(parseMoveToStatePayload(mts[0].subarray(12)).motion.forwardCommand).toBe(MotionCommand.Sitting);
    // a forward key wins over the substate
    sent.length = 0;
    sync.sendMovementEventNow({ ...IDLE, forward: true, substate: MotionCommand.Sitting }, POS, 100);
    expect(parseMoveToStatePayload(sent[0].subarray(12)).motion.forwardCommand).toBe(MotionCommand.WalkForward);
  });
});
