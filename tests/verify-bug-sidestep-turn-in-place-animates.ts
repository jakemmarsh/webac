/**
 * BUG.sidestep-turn-in-place-never-animates — peer/creature sidestep and
 * turn-in-place motion must actually drive the MotionManager.
 *
 * ACE ground truth:
 *  - ACE.Server/Network/Motion/InterpretedMotionState.cs:119-122 (HasMovement:
 *    TurnCommand/SidestepCommand count as movement independent of
 *    ForwardCommand) and :140-144 (Write emits SideStepCommand before
 *    TurnCommand — CurrentStyle, ForwardCommand, SideStepCommand, TurnCommand,
 *    then the three speeds in the same order).
 *  - ACE.Server/Physics/Animation/InterpretedMotionState.cs:32-40 (ApplyMotion:
 *    when a creature only strafes or pivots in place, ForwardCommand stays
 *    Ready rather than being omitted).
 *
 * Before the fix, ServerObjectManager.handleMovementEvent parsed
 * sidestepCmd/sidestepSpeed/turnCmd/turnSpeed out of the bitfield but never
 * referenced them again — only forwardCmd fed MotionManager.setForwardMotion,
 * so a peer strafing or turning in place with no active ForwardCommand (or
 * ForwardCommand == Ready) sat in its current idle/forward cycle with no
 * strafe/turn animation while position/quaternion interpolation slid it.
 */
import { describe, it, expect } from 'vitest';
import { MotionManager } from '../packages/renderer/src/animation/MotionManager.js';
import { MotionCommand } from '../packages/renderer/src/animation/MotionCommands.js';

const STANCE_INDEX = 0x03; // NonCombat wire index (arbitrary valid outer style)
const READY_WIRE = MotionCommand.Ready & 0xFFFF; // 0x0003
const SIDESTEP_LEFT_WIRE = 0x8f; // arbitrary non-zero MotionCommand wire index
const TURN_RIGHT_WIRE = 0x91; // arbitrary non-zero MotionCommand wire index
const WALK_FORWARD_WIRE = 0x05;

// Build a MovementEvent buffer: 6-byte header + type/options/outerStyle +
// InterpretedMotionState bitfield, with only the requested fields present —
// mirrors InterpretedMotionState.Write's flag-gated field order (u16 command
// fields in CurrentStyle/ForwardCommand/SideStepCommand/TurnCommand order,
// then f32 speed fields in ForwardSpeed/SideStepSpeed/TurnSpeed order).
function movementBuffer(opts: {
  outerStyle?: number;
  forwardCmd?: number;
  sidestepCmd?: number;
  turnCmd?: number;
  forwardSpeed?: number;
  sidestepSpeed?: number;
  turnSpeed?: number;
}): Uint8Array {
  let flags = 0;
  const u16Fields: number[] = [];
  if (opts.forwardCmd !== undefined) { flags |= 0x2; u16Fields.push(opts.forwardCmd); }
  if (opts.sidestepCmd !== undefined) { flags |= 0x8; u16Fields.push(opts.sidestepCmd); }
  if (opts.turnCmd !== undefined) { flags |= 0x20; u16Fields.push(opts.turnCmd); }

  const f32Fields: number[] = [];
  if (opts.forwardSpeed !== undefined) { flags |= 0x4; f32Fields.push(opts.forwardSpeed); }
  if (opts.sidestepSpeed !== undefined) { flags |= 0x10; f32Fields.push(opts.sidestepSpeed); }
  if (opts.turnSpeed !== undefined) { flags |= 0x40; f32Fields.push(opts.turnSpeed); }

  const size = 6 + 1 + 1 + 2 + 4 + u16Fields.length * 2 + f32Fields.length * 4;
  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  let o = 6;
  view.setUint8(o, 0); o += 1;        // movement_type 0 = InterpretedMotionState
  view.setUint8(o, 0); o += 1;        // options
  view.setUint16(o, opts.outerStyle ?? STANCE_INDEX, true); o += 2; // outer style
  view.setUint32(o, flags, true); o += 4;
  for (const v of u16Fields) { view.setUint16(o, v, true); o += 2; }
  for (const v of f32Fields) { view.setFloat32(o, v, true); o += 4; }
  return buf;
}

async function makeSOM() {
  const { ServerObjectManager } = await import('../packages/renderer/src/world/ServerObjectManager.js');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const som = new ServerObjectManager({} as any, {} as any, { add: () => {}, remove: () => {} } as any);
  const forward: Array<{ key: number; speed: number }> = [];
  const mm = {
    queueAction: () => {},
    setForwardMotion: (key: number, speed: number) => { forward.push({ key, speed }); return true; },
    setStanceFromId: () => {},
    isPlayingAction: false,
    currentStyleId: 0,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  som.registerAnimatedEntity(0x60000001, { motionManager: mm } as any, false); // non-local creature
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  som.registerAnimatedEntity(0x50000001, { motionManager: mm } as any, true); // local player
  return { som, forward };
}

describe('BUG.sidestep-turn-in-place-never-animates', () => {
  it('sidestep-only (no ForwardCommand at all) drives motion for a non-local creature', async () => {
    const { som, forward } = await makeSOM();
    som.handleMovementEvent({
      guid: 0x60000001,
      movementData: movementBuffer({ sidestepCmd: SIDESTEP_LEFT_WIRE, sidestepSpeed: 1.25 }),
    } as never);
    expect(forward.length).toBe(1);
    expect(forward[0].key).toBe(MotionManager.compositeKey(STANCE_INDEX, SIDESTEP_LEFT_WIRE));
    expect(forward[0].speed).toBe(1.25);
  });

  it('turn-in-place-only (no ForwardCommand at all) drives motion for a non-local creature', async () => {
    const { som, forward } = await makeSOM();
    som.handleMovementEvent({
      guid: 0x60000001,
      movementData: movementBuffer({ turnCmd: TURN_RIGHT_WIRE, turnSpeed: 0.8 }),
    } as never);
    expect(forward.length).toBe(1);
    expect(forward[0].key).toBe(MotionManager.compositeKey(STANCE_INDEX, TURN_RIGHT_WIRE));
    expect(forward[0].speed).toBeCloseTo(0.8, 6);
  });

  it('sidestep is preferred over a bare ForwardCommand==Ready (ACE keeps ForwardCommand at Ready during a pure strafe)', async () => {
    const { som, forward } = await makeSOM();
    som.handleMovementEvent({
      guid: 0x60000001,
      movementData: movementBuffer({ forwardCmd: READY_WIRE, sidestepCmd: SIDESTEP_LEFT_WIRE }),
    } as never);
    expect(forward.length).toBe(1);
    expect(forward[0].key).toBe(MotionManager.compositeKey(STANCE_INDEX, SIDESTEP_LEFT_WIRE));
  });

  it('a real (non-Ready) ForwardCommand still takes priority over sidestep/turn', async () => {
    const { som, forward } = await makeSOM();
    som.handleMovementEvent({
      guid: 0x60000001,
      movementData: movementBuffer({ forwardCmd: WALK_FORWARD_WIRE, sidestepCmd: SIDESTEP_LEFT_WIRE, turnCmd: TURN_RIGHT_WIRE }),
    } as never);
    expect(forward.length).toBe(1);
    expect(forward[0].key).toBe(MotionManager.compositeKey(STANCE_INDEX, WALK_FORWARD_WIRE));
  });

  it('bare ForwardCommand==Ready with no sidestep/turn still applies the Ready cycle (pre-existing behavior preserved)', async () => {
    const { som, forward } = await makeSOM();
    som.handleMovementEvent({
      guid: 0x60000001,
      movementData: movementBuffer({ forwardCmd: READY_WIRE }),
    } as never);
    expect(forward.length).toBe(1);
    expect(forward[0].key).toBe(MotionManager.compositeKey(STANCE_INDEX, READY_WIRE));
  });

  it('local player is still skipped for sidestep/turn motion (anti-stutter guard covers all locomotion, not just forward)', async () => {
    const { som, forward } = await makeSOM();
    som.handleMovementEvent({
      guid: 0x50000001,
      movementData: movementBuffer({ sidestepCmd: SIDESTEP_LEFT_WIRE }),
    } as never);
    expect(forward.length).toBe(0);
  });
});
