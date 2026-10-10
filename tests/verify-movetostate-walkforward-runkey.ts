/**
 * BUG.movetostate-raw-runforward — MoveToState's RAW forward command is
 * WalkForward whether walking or running; running is the Run hold key.
 *
 * Retail: RawMotionState::ApplyMotion @ 0051eb60 stores every forward-class
 * command EXCEPT 0x44000007 (RunForward) in forward_command, so the retail
 * client can never put RunForward in the raw state it packs.
 * ACE: MovementData(Creature, MoveToState) (MovementData.cs:106-118) turns
 * raw WalkForward + HoldKey.Run into RunForward at ForwardSpeed =
 * GetRunRate(); a raw RunForward falls into the plain `else` copy at the
 * default speed 1.0, and MotionInterp.adjust_motion's `case RunForward:
 * return` skips apply_run_to_command. So the old raw RunForward showed
 * peers our run at speed 1.0 and bypassed run-rate scaling.
 *
 * Drives the REAL MovementSync with a stub connection and decodes the
 * bytes it sends.
 */
import { describe, it, expect } from 'vitest';
import { parseMoveToStatePayload, GameActionType } from '@ac/network';
import { HoldKey, RawMotionFlags } from '@ac/shared';
import { MovementSync } from '../packages/renderer/src/network/MovementSync.js';
import type { MovementState } from '../packages/renderer/src/network/MovementSync.js';
import { MotionCommand } from '../packages/renderer/src/animation/MotionCommands.js';

const POS = {
  worldX: 100, worldZ: 200, groundY: 10, playerYaw: 0, landblock: 0xa9b4ffff,
  localX: 100, localY: 8, localZ: 20, inDungeon: false, onGround: true,
};
const IDLE: MovementState = {
  forward: false, backward: false, turnLeft: false, turnRight: false,
  strafeLeft: false, strafeRight: false, running: true,
};

function harness() {
  const sent: Uint8Array[] = [];
  const conn = { sendMessage: (bytes: Uint8Array) => { sent.push(bytes); } };
  let seq = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sync = new MovementSync(conn as any, () => ++seq);
  const moveToStates = () => sent.filter(m =>
    new DataView(m.buffer, m.byteOffset).getUint32(8, true) === GameActionType.MoveToState);
  return { sync, sent, moveToStates };
}

/** ACE-order raw decode of the RawMotionState head (MoveToState.cs → RawMotionState.cs:49-96). */
function rawHead(msg: Uint8Array) {
  const dv = new DataView(msg.buffer, msg.byteOffset + 12);
  let o = 0;
  const flags = dv.getUint32(o, true) & 0x7FF; o += 4;
  let currentHoldKey = HoldKey.Invalid;
  let forwardCommand = 0;
  let forwardHoldKey = HoldKey.Invalid;
  if (flags & RawMotionFlags.CurrentHoldKey) { currentHoldKey = dv.getUint32(o, true); o += 4; }
  if (flags & RawMotionFlags.CurrentStyle) o += 4;
  if (flags & RawMotionFlags.ForwardCommand) { forwardCommand = dv.getUint32(o, true); o += 4; }
  if (flags & RawMotionFlags.ForwardHoldKey) { forwardHoldKey = dv.getUint32(o, true); o += 4; }
  return { flags, currentHoldKey, forwardCommand, forwardHoldKey };
}

/** ACE MovementData.cs:98-118 — the forward half of the raw → interpreted conversion peers receive. */
function aceBroadcastForward(forwardCommand: number, holdKey: number, runRate: number) {
  const speed = holdKey === HoldKey.Run ? runRate : 1.0;
  if (forwardCommand === MotionCommand.WalkForward || forwardCommand === MotionCommand.WalkBackwards) {
    let cmd: number = MotionCommand.WalkForward;
    if (forwardCommand === MotionCommand.WalkForward && holdKey === HoldKey.Run) cmd = MotionCommand.RunForward;
    let s = speed;
    if (forwardCommand === MotionCommand.WalkBackwards) s *= -0.65;
    return { cmd, speed: s };
  }
  return { cmd: forwardCommand, speed: 1.0 };
}

describe('BUG.movetostate-raw-runforward: MovementSync forward command', () => {
  it('running forward sends WalkForward with the Run hold key (never raw RunForward)', () => {
    const { sync, moveToStates } = harness();
    sync.update({ ...IDLE, forward: true, running: true }, POS, 0);
    const msgs = moveToStates();
    expect(msgs.length).toBe(1);
    const head = rawHead(msgs[0]);
    expect(head.forwardCommand).toBe(MotionCommand.WalkForward);
    expect(head.forwardCommand).not.toBe(MotionCommand.RunForward);
    expect(head.currentHoldKey).toBe(HoldKey.Run);
    // RawMotionState::Pack @ 0051ed10 packs ForwardHoldKey only when it is
    // not HoldKey_Invalid, and retail's keyboard path leaves it Invalid: the
    // retail A/B run is 05000000 02000000 05000045 (docs/movement-ab.md).
    expect(head.flags & RawMotionFlags.ForwardHoldKey).toBe(0);
    expect(Array.from(msgs[0].subarray(12, 24))).toEqual([5, 0, 0, 0, 2, 0, 0, 0, 5, 0, 0, 0x45]);
    const parsed = parseMoveToStatePayload(msgs[0].subarray(12));
    expect(parsed.motion.forwardCommand).toBe(MotionCommand.WalkForward);
    expect(parsed.motion.running).toBe(true);
  });

  it('walking forward sends WalkForward with the None hold key', () => {
    const { sync, moveToStates } = harness();
    sync.update({ ...IDLE, forward: true, running: false }, POS, 0);
    const head = rawHead(moveToStates()[0]);
    expect(head.forwardCommand).toBe(MotionCommand.WalkForward);
    // Retail packing (RawMotionState::Pack @ 0051ed10): HoldKey_None is the
    // default, so CurrentHoldKey is omitted, and no per-axis hold key goes out
    // (the retail A/B walk is 04000000 05000045).
    expect(head.flags & RawMotionFlags.CurrentHoldKey).toBe(0);
    expect(head.flags & RawMotionFlags.ForwardHoldKey).toBe(0);
    expect(Array.from(moveToStates()[0].subarray(12, 20))).toEqual([4, 0, 0, 0, 5, 0, 0, 0x45]);
  });

  it('Shift (the hold-run key) while moving forward sends nothing; the next movement event carries the hold key', () => {
    // CommandInterpreter::SetHoldRun @ 006b3370 → CMotionInterp::set_hold_run
    // @ 00528b70 changes only the local motion state. The retail A/B
    // shift-toggle run (W held 4.4 s, Shift tapped twice) sent 2 MoveToStates.
    const { sync, moveToStates } = harness();
    sync.update({ ...IDLE, forward: true, running: true, runToggle: true }, POS, 0);
    sync.update({ ...IDLE, forward: true, running: false, runToggle: true }, POS, 16);
    sync.update({ ...IDLE, forward: true, running: true, runToggle: true }, POS, 32);
    sync.update({ ...IDLE, forward: true, running: false, runToggle: true }, POS, 48);
    expect(moveToStates().length).toBe(1);
    sync.update({ ...IDLE, forward: false, running: false, runToggle: true }, POS, 64);
    const last = rawHead(moveToStates()[1]);
    expect(moveToStates().length).toBe(2);
    expect(last.flags & RawMotionFlags.CurrentHoldKey).toBe(0); // walking at the stop: None, omitted
  });

  it('the run toggle while moving forward re-sends: same command, hold key flips', () => {
    // CommandInterpreter::UpdateToggleRun @ 006b3c80 → SendMovementEvent.
    const { sync, moveToStates } = harness();
    sync.update({ ...IDLE, forward: true, running: true, runToggle: true }, POS, 0);
    sync.update({ ...IDLE, forward: true, running: false, runToggle: false }, POS, 16);
    const [a, b] = moveToStates().map(rawHead);
    expect(moveToStates().length).toBe(2);
    expect(a.forwardCommand).toBe(MotionCommand.WalkForward);
    expect(b.forwardCommand).toBe(MotionCommand.WalkForward);
    expect(a.currentHoldKey).toBe(HoldKey.Run);
    expect(b.flags & RawMotionFlags.CurrentHoldKey).toBe(0); // HoldKey_None omitted, as retail packs it
    expect(b.forwardHoldKey).toBe(HoldKey.Invalid);
  });

  it('backward stays WalkBackwards', () => {
    const { sync, moveToStates } = harness();
    sync.update({ ...IDLE, backward: true, running: true }, POS, 0);
    expect(rawHead(moveToStates()[0]).forwardCommand).toBe(MotionCommand.WalkBackwards);
  });

  it("through ACE's broadcast conversion, peers now see RunForward at our run rate", () => {
    const { sync, moveToStates } = harness();
    sync.update({ ...IDLE, forward: true, running: true }, POS, 0);
    const head = rawHead(moveToStates()[0]);
    const runRate = 2.5;
    expect(aceBroadcastForward(head.forwardCommand, head.currentHoldKey, runRate))
      .toEqual({ cmd: MotionCommand.RunForward, speed: runRate });
    // The pre-fix raw RunForward took the plain copy at speed 1.0.
    expect(aceBroadcastForward(MotionCommand.RunForward, HoldKey.Run, runRate))
      .toEqual({ cmd: MotionCommand.RunForward, speed: 1.0 });
  });
});
