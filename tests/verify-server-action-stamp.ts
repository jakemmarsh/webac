/**
 * SWEEP1006 action stamps — CMotionInterp::move_to_interpreted_state
 * @ 005289c0 plays a command-list action only when its 15-bit
 * server_action_stamp is newer than the object's last, and on our own
 * character only when it is not autonomous (bit 15). ACE repeats an action
 * in every motion message until it completes (MotionItem.PackedSequence);
 * ours replayed it each time.
 */
import { describe, it, expect } from 'vitest';
import { ServerObjectManager, isServerActionNewer, isServerActionNewer1999 } from '../packages/renderer/src/world/ServerObjectManager.js';

/** An 0xF74C body: header, InterpretedMotionState with no fields and the given actions. */
function actionsEvent(guid: number, actions: Array<{ cmd: number; seq: number }>): { guid: number; movementData: Uint8Array } {
  const buf = new Uint8Array(6 + 4 + 4 + actions.length * 8);
  const v = new DataView(buf.buffer);
  let o = 6;
  v.setUint8(o, 0); o += 1;          // movement_type Invalid (InterpretedMotionState)
  v.setUint8(o, 0); o += 1;          // options
  v.setUint16(o, 0x3d, true); o += 2; // NonCombat
  v.setUint32(o, (actions.length & 0x1f) << 7, true); o += 4; // no fields, the action count
  for (const a of actions) {
    v.setUint16(o, a.cmd, true); o += 2;
    v.setUint16(o, a.seq, true); o += 2;
    v.setFloat32(o, 1, true); o += 4;
  }
  return { guid, movementData: buf };
}

function harness(local = false, era1999 = false) {
  const som = new ServerObjectManager({} as never, {} as never, { add: () => {}, remove: () => {} } as never);
  if (era1999) som.actionStampIsNewer = isServerActionNewer1999;
  const queued: number[] = [];
  const mm = {
    queueAction: (k: number) => queued.push(k & 0xffff), setForwardMotion: () => true, playDeath: () => {},
    setStanceFromId: () => {}, changeStyle: () => true, isPlayingAction: false, currentStyleId: 0x8000003d,
  };
  som.registerAnimatedEntity(0x50000001, { motionManager: mm } as never, local);
  return { som, queued };
}

describe('isServerActionNewer (15-bit, wrap-aware)', () => {
  it('larger is newer within half the range; a wrap counts too', () => {
    expect(isServerActionNewer(5, 4)).toBe(true);
    expect(isServerActionNewer(4, 4)).toBe(false);
    expect(isServerActionNewer(3, 4)).toBe(false);
    expect(isServerActionNewer(2, 0x7ffe)).toBe(true);
  });
});

describe('command-list actions play once per stamp', () => {
  it('the same action repeated in later motion messages plays once; a new stamp plays', () => {
    const { som, queued } = harness();
    som.handleMovementEvent(actionsEvent(0x50000001, [{ cmd: 0x87, seq: 7 }]) as never);
    som.handleMovementEvent(actionsEvent(0x50000001, [{ cmd: 0x87, seq: 7 }]) as never);
    expect(queued).toEqual([0x87]);
    som.handleMovementEvent(actionsEvent(0x50000001, [{ cmd: 0x87, seq: 7 }, { cmd: 0x88, seq: 8 }]) as never);
    expect(queued).toEqual([0x87, 0x88]);
  });
  it('our own character skips an autonomous action (bit 15)', () => {
    const { som, queued } = harness(true);
    som.handleMovementEvent(actionsEvent(0x50000001, [{ cmd: 0x87, seq: 0x8000 | 9 }]) as never);
    expect(queued).toEqual([]);
    som.handleMovementEvent(actionsEvent(0x50000001, [{ cmd: 0x88, seq: 10 }]) as never);
    expect(queued).toEqual([0x88]);
  });
});

/**
 * webac#16 (AC1999, "a Banderling Captain swings and lands a hit but its attack animation does
 * not play") — the 1999 client's move_to_interpreted_state @ 0x00473400 plays an action when
 * `server_action_stamp < stamp` on the 15-bit stamp (unpack @ 0x00475ac0: `stamp & 0x7fff`), with
 * no wrap window. The AC1999 server stamps every swing, MoveTo and TurnTo from one per-weenie
 * counter (m_wAnimSequence, Animate.cpp; ++ in MeleeAttackEventData.cpp OnReadyToAttack,
 * AttackEventData.cpp MoveToAttack / TurnToAttack), and a new object's last stamp is 0.
 */
describe('webac#16 — the 1999 action-stamp test is a plain less-than', () => {
  it('isServerActionNewer1999: larger is newer, no wrap window', () => {
    expect(isServerActionNewer1999(5, 4)).toBe(true);
    expect(isServerActionNewer1999(4, 4)).toBe(false);
    expect(isServerActionNewer1999(3, 4)).toBe(false);
    expect(isServerActionNewer1999(0x5000, 0)).toBe(true);
    expect(isServerActionNewer1999(2, 0x7ffe)).toBe(false); // a wrap is older to 1999
    expect(isServerActionNewer1999(0x8000 | 9, 8)).toBe(true); // bit 15 is the autonomous flag, not the stamp
  });

  it('a creature first seen with its counter past 0x4000: 1999 plays its swings; end of retail (the window) does not', () => {
    const old = harness(false, true);
    old.som.handleMovementEvent(actionsEvent(0x50000001, [{ cmd: 0x62, seq: 0x5001 }]) as never);
    old.som.handleMovementEvent(actionsEvent(0x50000001, [{ cmd: 0x62, seq: 0x5001 }, { cmd: 0x63, seq: 0x5003 }]) as never);
    expect(old.queued).toEqual([0x62, 0x63]);
    // End of retail and Dark Majesty keep retail's wrap-aware window (move_to_interpreted_state @ 005289c0).
    const eor = harness();
    eor.som.handleMovementEvent(actionsEvent(0x50000001, [{ cmd: 0x62, seq: 0x5001 }]) as never);
    expect(eor.queued).toEqual([]);
    eor.som.handleMovementEvent(actionsEvent(0x50000001, [{ cmd: 0x63, seq: 0x0003 }]) as never);
    expect(eor.queued).toEqual([0x63]);
  });
});
