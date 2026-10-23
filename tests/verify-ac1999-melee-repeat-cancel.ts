/**
 * BUG.ac1999-melee-never-swings — an agent's melee attack on the AC1999 server swung once, then
 * stood still for 20 s ("ATTACK NEVER SWUNG", Brown Rabbit, 2026-10-23 15:38Z and 19:30Z).
 *
 * The AC1999 server's log for both runs:
 *   MELEE_ATTACK power 0.6 → first swing, AttackDone {0} (the server starts its repeat) →
 *   MELEE_ATTACK power 0.5 70 ms later → [COMBAT-GATE] REJECT(BAD_PARAM: too soon, delta=0.07),
 *   AttackDone {WERROR_BAD_PARAM} → nothing from the client until CANCEL_ATTACK 14 s later, the
 *   server's repeat stuck at its second swing ([COMBAT-FLOW] CANCELLED swingsStarted=1 hookFired=0).
 *
 * Two client faults, both fixed here:
 *   1. The agent swung at 0.6 with the combat bar's slider at 0.5. Retail's AttackDone handler
 *      (EoL HandleAttackDoneEvent @ 0056c500, 1999 @ 0x004f8bb0) re-sends at the slider's power when
 *      the two differ by more than 0.01, which ACE queues and the AC1999 server refuses as too soon
 *      (Monster.cpp TryMeleeAttack: power > seconds since the last swing). A player can't make that
 *      mismatch (a classic-UI release always ends at the slider's power), so the agent now moves the
 *      slider to its power first (hostAttack setSliderPower).
 *   2. Our handler ended the repeat on that refusal without CancelAttack. Both retail clients call
 *      AbortAutomaticAttack there (EoL @ 0056ae90, 1999 @ 0x004f94b0 → 0x004f9530), which sends
 *      CM_Combat::Event_CancelAttack. The AC1999 server's refusal leaves its own repeat running, so
 *      without the cancel the server kept a repeat this client had dropped. Every era: on ACE the
 *      refusal code only ever ends a sequence (Player_Melee.OnAttackDone ActionCancelled), so the
 *      cancel there is retail's and harmless.
 *
 * The messages run through the real Adapter1999 (1999) or straight in (end of retail), the real
 * ServerMessageHandler and the real AttackRequestController, wired as main.ts wires them.
 */
import { describe, expect, it } from 'vitest';
import { GameActionType } from '@ac/network';
import { Adapter1999 } from '../packages/network/src/era1999/Adapter1999.js';
import { codecs1999 } from '../packages/network/src/era1999/codecs/index.js';
import { Writer1999 } from '../packages/network/src/era1999/Wire1999.js';
import { BinaryWriter, deserializeMessage, serializeGameAction } from '../packages/network/src/MessageSerializer.js';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { AttackRequestController } from '../packages/renderer/src/controllers/AttackRequest.js';
import { createHostAttack } from '../packages/renderer/src/agent/hostAttack.js';

const PLAYER = 0x5000002c;
const RABBIT = 0x60001fb5;
/** GameEnums.h: WERROR_NONE = 0, WERROR_NOMEM, WERROR_BAD_PARAM. */
const WERROR_BAD_PARAM = 2;
/** ACE WeenieError.ActionCancelled: Player_Melee.OnAttackDone's end-of-sequence code. */
const ACTION_CANCELLED = 0x36;

type Era = 'ac1999' | 'eor';

function rig(era: Era, opts: { agentAlignsSlider: boolean; slider?: number }) {
  let now = 1000;
  let slider = opts.slider ?? 0.5;
  /** What reached the wire: [game action type, power] (power for attacks only). */
  const sent: Array<{ type: number; power?: number }> = [];
  const adapter = era === 'ac1999' ? new Adapter1999(codecs1999(), { account: 'agenta99', log: () => {} }) : null;
  if (adapter) {
    const w = new BinaryWriter(32); w.writeUInt32(0xf657); w.writeUInt32(PLAYER); w.writeString16('agenta99');
    adapter.outbound(w.toBuffer());
  }
  let actionSeq = 0;
  const send = (type: GameActionType, payload: Uint8Array) => {
    const eol = serializeGameAction(++actionSeq, type, payload);
    const msgs = adapter ? (adapter.outbound(eol) ?? []).map((o) => o.message) : [eol];
    for (const m of msgs) {
      const dv = new DataView(m.buffer, m.byteOffset, m.byteLength);
      expect(dv.getUint32(0, true)).toBe(0xf7b1);
      const t = dv.getUint32(8, true);
      sent.push(t === GameActionType.TargetedMeleeAttack ? { type: t, power: dv.getFloat32(20, true) } : { type: t });
    }
  };
  const attack = new AttackRequestController({
    now: () => now, getTarget: () => RABBIT, isAttackable: () => true, inReadyPosition: () => true,
    combatMode: () => 'melee', currentStyle: () => 0, sliderPower: () => slider, autoRepeat: () => true,
    sendAttack: (_mode, target, height, power) => {
      const p = new BinaryWriter(12); p.writeUInt32(target); p.writeUInt32(height === 'high' ? 1 : height === 'medium' ? 2 : 3); p.writeFloat32(power);
      send(GameActionType.TargetedMeleeAttack, p.toBuffer());
    },
    setPowerBarLevel: () => {}, showError: () => {},
    sendCancelAttack: () => send(GameActionType.CancelAttack, new Uint8Array(0)),
    autoTarget: () => false, lastAttacker: () => 0, objectPresent: () => true, selectObject: () => {}, selectNextCompassItem: () => {},
  });
  const h = new ServerMessageHandler();
  h.setHandlers({
    onAttackDone: (d) => attack.handleAttackDone(d.errorType),
    onCombatCommenceAttack: () => attack.handleCommenceAttack(),
  });
  // main.ts's agent host: already in melee, the attack key's press + release at the agent's power.
  const host = createHostAttack({
    inAttackStance: () => true,
    autoEnterPlan: () => ({ sendAttack: true, mode: 2 }),
    changeCombatMode: () => {},
    swing: (_g, power, height) => { attack.setRequestedAttackHeight(height); attack.startAttackRequest(); attack.endAttackRequest(height, power); },
    ...(opts.agentAlignsSlider ? { setSliderPower: (p: number) => { slider = p; } } : {}),
    requestPending: () => attack.attackServerResponsePending || attack.attackInProgress || attack.repeatAttackInProgress(),
    now: () => now * 1000,
    schedule: () => {},
  });

  let evSeq = 0;
  /** The server's event 0xF7B0 {player, sequence, type, body}: 1999 bytes through the adapter, or ACE's as they are. */
  const event = (type: number, body?: number) => {
    if (adapter) {
      const w = new Writer1999().u32(0xf7b0).u32(PLAYER).u32(++evSeq).u32(type);
      if (body !== undefined) w.u32(body);
      for (const out of adapter.inbound(w.toBytes(), 4)) h.handleMessage(deserializeMessage(out));
    } else {
      const w = new BinaryWriter(20); w.writeUInt32(0xf7b0); w.writeUInt32(PLAYER); w.writeUInt32(++evSeq); w.writeUInt32(type);
      if (body !== undefined) w.writeUInt32(body);
      h.handleMessage(deserializeMessage(w.toBuffer()));
    }
  };
  return {
    sent, attack,
    get slider() { return slider; },
    /** The agent's ac_attack (AgentApi default power 0.6). */
    agentAttack: (power = 0.6) => host.attack(RABBIT, power, 'medium'),
    /** Let the bar build to the requested power (UseTime each frame). */
    build: (s: number) => { for (let i = 0; i < Math.ceil(s / 0.05); i++) { now += 0.05; attack.useTime(); } },
    /** NotifyAttackDone (1999 Player.cpp:1436 / ACE GameEventAttackDone). */
    attackDone: (err = 0) => event(0x1a7, err),
    /** NotifyCommenceAttack (1999 Player.cpp:1444 / ACE GameEventCombatCommenceAttack). */
    commence: () => event(0x1b8),
    melee: () => sent.filter((s) => s.type === GameActionType.TargetedMeleeAttack),
    cancels: () => sent.filter((s) => s.type === GameActionType.CancelAttack).length,
  };
}

describe('BUG.ac1999-melee-never-swings: the 2026-10-23 sequence, AC1999 server bytes through the real adapter', () => {
  it('the old agent path (slider left at 0.5): AttackDone {0} re-sends at the slider, and the server\'s refusal now cancels its repeat', () => {
    const r = rig('ac1999', { agentAlignsSlider: false });
    r.agentAttack();
    r.build(0.7);
    expect(r.melee().map((m) => m.power)).toEqual([expect.closeTo(0.6, 5)]);
    r.attackDone(0); // swing one done; the server starts its repeat (AttackManager::OnAttackDone)
    // Retail's re-send at the slider's power (1999 @ 0x004f8bb0): the 19:30:55.778 MELEE_ATTACK at 0.5.
    expect(r.melee().map((m) => m.power)).toEqual([expect.closeTo(0.6, 5), expect.closeTo(0.5, 5)]);
    expect(r.cancels()).toBe(0);
    r.attackDone(WERROR_BAD_PARAM); // [COMBAT-GATE] REJECT(BAD_PARAM: too soon)
    // AbortAutomaticAttack (1999 @ 0x004f94b0 → 0x004f9530): CANCEL_ATTACK 0x1B7 goes out at once,
    // ending the repeat the server still runs (before: nothing until the agent gave up 14 s later).
    expect(r.cancels()).toBe(1);
    expect(r.attack.repeatAttacking).toBe(false);
  });

  it('the agent sets the slider to its power: no re-send, no refusal, the server\'s repeat swings on', () => {
    const r = rig('ac1999', { agentAlignsSlider: true });
    r.agentAttack();
    expect(r.slider).toBeCloseTo(0.6);
    r.build(0.7);
    expect(r.melee()).toHaveLength(1);
    for (let i = 0; i < 3; i++) {
      r.attackDone(0); // a swing done; the repeat charges
      r.build(0.3);
      r.commence(); // the charge done: the next swing
    }
    r.attackDone(0);
    expect(r.melee()).toHaveLength(1); // the server swung four times on one request
    expect(r.cancels()).toBe(0);
    expect(r.attack.repeatAttacking).toBe(true);
  });

  it('a player\'s release (slider 0.5, bar past it) ends at the slider\'s power: no re-send on AttackDone {0}', () => {
    const r = rig('ac1999', { agentAlignsSlider: false });
    r.attack.setRequestedAttackHeight('medium');
    r.build(0.8);
    r.attack.endAttackRequest();
    const n = r.melee().length;
    expect(r.attack.requestedAttackPower).toBeCloseTo(0.5);
    r.attackDone(0);
    expect(r.melee()).toHaveLength(n);
    expect(r.cancels()).toBe(0);
  });

  it('a refusal with no repeat running sends no cancel (AbortAutomaticAttack is gated on repeatAttacking)', () => {
    const r = rig('ac1999', { agentAlignsSlider: true });
    r.attackDone(WERROR_BAD_PARAM);
    expect(r.cancels()).toBe(0);
  });
});

describe('BUG.ac1999-melee-never-swings: end of retail / Dark Majesty (ACE) pinned', () => {
  it('ACE repeat with the slider aligned: one request, repeats from the server, no extra send', () => {
    const r = rig('eor', { agentAlignsSlider: true });
    r.agentAttack();
    r.build(0.7);
    r.attackDone(0); r.build(0.3); r.commence(); r.attackDone(0);
    expect(r.melee()).toHaveLength(1);
    expect(r.cancels()).toBe(0);
  });

  it('ACE\'s end of sequence (AttackDone ActionCancelled) while repeating: retail\'s CancelAttack, the repeat ends', () => {
    const r = rig('eor', { agentAlignsSlider: true });
    r.agentAttack();
    r.build(0.7);
    r.attackDone(0);
    r.attackDone(ACTION_CANCELLED); // the target died: Player_Melee.OnAttackDone
    expect(r.cancels()).toBe(1);
    expect(r.attack.repeatAttacking).toBe(false);
    r.attackDone(ACTION_CANCELLED); // the cancel's own reply: nothing more goes out
    expect(r.cancels()).toBe(1);
    expect(r.melee()).toHaveLength(1);
  });
});
