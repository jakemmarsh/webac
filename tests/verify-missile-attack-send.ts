/**
 * RECON.missile-suppressed-send-stuck — a missile attack always goes on the
 * wire. Retail ExecuteAttack @ 0056bb70 sends
 * CM_Combat::Event_TargetedMissileAttack for any attackable target and sets
 * attackServerResponsePending; it has no client ammo, target-type or range
 * gate. The server rejects those cases and answers each with AttackDone
 * (ACE Player_Missile.cs), which clears the pending flag. The old client
 * gates returned without sending, so no AttackDone came and the attack
 * stayed pending until a combat-mode change.
 *
 * Drives the real AttackRequestController with sendAttack wired to the
 * shipped serializeTargetedMissileAttack, and decodes the bytes it puts on
 * the wire.
 */
import { describe, it, expect } from 'vitest';
import { AttackRequestController, type AttackRequestDeps } from '../packages/renderer/src/controllers/AttackRequest.js';
import { serializeTargetedMissileAttack } from '../packages/renderer/src/controllers/CombatController.js';
import { GameActionType, GameMessageOpcode, parseTargetedMissileAttackPayload } from '../packages/network/src/index.js';
import { AttackHeight } from '../packages/shared/src/index.js';

function decode(msg: Uint8Array) {
  const view = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
  return {
    opcode: view.getUint32(0, true),
    sequence: view.getUint32(4, true),
    action: view.getUint32(8, true),
    payload: parseTargetedMissileAttackPayload(msg.subarray(12)),
  };
}

describe('serializeTargetedMissileAttack', () => {
  it('builds the 0x000A game action with target, height and accuracy', () => {
    const d = decode(serializeTargetedMissileAttack(7, 0x80001234, 'high', 0.75));
    expect(d.opcode).toBe(GameMessageOpcode.GameAction);
    expect(d.sequence).toBe(7);
    expect(d.action).toBe(GameActionType.TargetedMissileAttack);
    expect(d.action).toBe(0x000a);
    expect(d.payload.targetGuid).toBe(0x80001234);
    expect(d.payload.attackHeight).toBe(AttackHeight.High);
    expect(d.payload.accuracyLevel).toBeCloseTo(0.75, 6);
  });

  it('maps every attack height name to the wire enum', () => {
    expect(decode(serializeTargetedMissileAttack(1, 1, 'medium', 0)).payload.attackHeight).toBe(AttackHeight.Medium);
    expect(decode(serializeTargetedMissileAttack(1, 1, 'low', 0)).payload.attackHeight).toBe(AttackHeight.Low);
  });
});

describe('missile attack through the controller (RECON.missile-suppressed-send-stuck)', () => {
  function harness() {
    const state = { t: 100, seq: 0, wire: [] as Uint8Array[] };
    const deps: AttackRequestDeps = {
      now: () => state.t,
      getTarget: () => 0x80000042,
      isAttackable: () => true,
      inReadyPosition: () => true,
      combatMode: () => 'missile',
      currentStyle: () => 0,
      sliderPower: () => 1,
      autoRepeat: () => false,
      // What main.ts's sendMissileAttack does: serialize and send, nothing else.
      sendAttack: (_mode, target, height, power) => {
        state.wire.push(serializeTargetedMissileAttack(++state.seq, target, height, power));
      },
      setPowerBarLevel: () => {},
      showError: () => {},
      sendCancelAttack: () => {},
      autoTarget: () => false,
      lastAttacker: () => 0,
      objectPresent: () => true,
      selectObject: () => {},
      selectNextCompassItem: () => {},
    };
    return { c: new AttackRequestController(deps), state };
  }

  function fire(h: ReturnType<typeof harness>) {
    h.c.startAttackRequest();
    h.state.t += 1.0; // full accuracy bar
    h.c.useTime();
    h.c.endAttackRequest('medium');
  }

  it('every attack that leaves the client pending put a packet on the wire', () => {
    const h = harness();
    fire(h);
    expect(h.state.wire).toHaveLength(1);
    expect(h.c.attackServerResponsePending).toBe(true);
    const d = decode(h.state.wire[0]);
    expect(d.action).toBe(GameActionType.TargetedMissileAttack);
    expect(d.payload.targetGuid).toBe(0x80000042);
    expect(d.payload.attackHeight).toBe(AttackHeight.Medium);
  });

  it("the server's AttackDone for a rejected shot (no ammo / out of range) frees the next attack", () => {
    const h = harness();
    fire(h);
    // ACE answers a no-ammo or out-of-range shot with OnAttackDone (error None).
    h.c.handleAttackDone(0);
    expect(h.c.attackServerResponsePending).toBe(false);
    fire(h);
    expect(h.state.wire).toHaveLength(2);
    expect(decode(h.state.wire[1]).sequence).toBe(2);
    expect(h.c.attackServerResponsePending).toBe(true);
  });

  it('a press while still pending is queued, not dropped, and fires on AttackDone', () => {
    const h = harness();
    fire(h);
    fire(h); // pending: retail EndAttackRequest sets attackWhenResponseReceived
    expect(h.state.wire).toHaveLength(1);
    h.c.handleAttackDone(0);
    h.state.t += 1.0;
    h.c.useTime();
    expect(h.state.wire.length).toBeGreaterThanOrEqual(2);
  });
});
