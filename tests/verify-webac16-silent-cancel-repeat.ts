/**
 * webac#16, live 2026-11-03 (local AC1999 server, crossbow, Repeat Attacks on, a Brown Rabbit at 0.7 m):
 * the server's log shows `[MOTION-FLUSH] reason=leave-ground (mid-attack)` then `[COMBAT-FLOW] CANCELLED
 * error=0 … motionDone(0x40000028 match success=0)`. AttackManager::OnAttackCancelled(0) reports that cancel
 * as AttackDone {0}, the code of a finished swing (AttackManager.cpp:45-58; AttackEventData.cpp OnMotionDone
 * → Cancel(), default error 0). The client rebuilt the bar, parked it at the swing's power and waited for a
 * CommenceAttack that never came; the agent's "attack pending" test (repeatAttackInProgress: the bar is up)
 * then refused every new attack for 2+ minutes.
 *
 * Now: on a server that starts its repeats with CommenceAttack (the AC1999 server always: AttackEventData.cpp
 * Update sends 0x1B8 when the charge, power × 1 s, expires — the client's own build clock), a parked build
 * with no CommenceAttack after COMMENCE_WAIT ends the repeat (CancelAttack, the bar hidden). ACE never sends
 * CommenceAttack (Player_Melee / Player_Missile send only AttackDone), so end of retail is never armed.
 */
import { describe, expect, it } from 'vitest';
import { AttackRequestController, COMMENCE_WAIT } from '../packages/renderer/src/controllers/AttackRequest.js';

const TARGET = 0x60002797;

function rig(serverCommencesRepeats?: boolean) {
  let now = 100;
  const sent: string[] = [];
  const attack = new AttackRequestController({
    now: () => now, getTarget: () => TARGET, isAttackable: () => true, inReadyPosition: () => true,
    combatMode: () => 'missile', currentStyle: () => 0, sliderPower: () => 0.6, autoRepeat: () => true,
    sendAttack: (_m, _t, _h, power) => sent.push(`attack ${power}`),
    setPowerBarLevel: () => {}, showError: () => {},
    sendCancelAttack: () => sent.push('cancel'),
    autoTarget: () => false, lastAttacker: () => 0, objectPresent: () => true, selectObject: () => {}, selectNextCompassItem: () => {},
    ...(serverCommencesRepeats === undefined ? {} : { serverCommencesRepeats: () => serverCommencesRepeats }),
  });
  const run = (seconds: number) => { for (let t = 0; t < seconds; t += 1 / 60) { now += 1 / 60; attack.useTime(); } };
  // Released short of the slider: UseTime swings once the bar reaches it (one request at 0.6).
  const press = () => { attack.setRequestedAttackHeight('medium'); run(0.4); attack.endAttackRequest(); run(0.3); };
  return { attack, sent, run, press };
}

describe('webac#16 — a repeat the server ended with AttackDone {0} and no next CommenceAttack', () => {
  it('AC1999: healthy repeats keep going; a silent cancel ends the repeat after COMMENCE_WAIT, and a new attack goes out', () => {
    const r = rig(true);
    r.press();
    expect(r.sent).toEqual(['attack 0.6']);
    for (let shot = 0; shot < 3; shot++) {
      r.attack.handleAttackDone(0); // the reload's 0x1A7: the automatic build starts
      r.run(0.8); // the bar parks at 0.6
      expect(r.attack.buildInProgress).toBe(false);
      r.run(0.3);
      r.attack.handleCommenceAttack(); // the server's charge expires: 0x1B8, then the Aim
      r.run(1.5);
    }
    expect(r.sent).toEqual(['attack 0.6']);
    // The leave-ground flush mid-Aim: OnAttackCancelled(0).
    r.attack.handleAttackDone(0);
    r.run(0.8 + COMMENCE_WAIT - 0.2);
    expect(r.sent).toEqual(['attack 0.6']); // still inside the wait
    expect(r.attack.attackChainPending()).toBe(true);
    r.run(0.5);
    expect(r.sent).toEqual(['attack 0.6', 'cancel']);
    expect(r.attack.repeatAttacking).toBe(false);
    expect(r.attack.powerBarMode).toBe(0); // the bar hides
    expect(r.attack.attackChainPending()).toBe(false);
    expect(r.attack.repeatAttackInProgress()).toBe(false);
    r.press();
    expect(r.sent).toEqual(['attack 0.6', 'cancel', 'attack 0.6']);
  });

  it('the CommenceAttack arriving before the bar parks (the server a latency ahead) is a healthy repeat', () => {
    const r = rig(true);
    r.press();
    for (let shot = 0; shot < 3; shot++) {
      r.attack.handleAttackDone(0);
      r.run(0.5); // the bar at 0.5 of 0.6
      r.attack.handleCommenceAttack();
      r.run(COMMENCE_WAIT + 1);
    }
    expect(r.sent).toEqual(['attack 0.6']);
    expect(r.attack.repeatAttacking).toBe(true);
  });

  it('end of retail (ACE: no CommenceAttack, ever): a parked bar waits as retail does, however long the swing', () => {
    const r = rig();
    r.press();
    for (let shot = 0; shot < 3; shot++) {
      r.attack.handleAttackDone(0);
      r.run(COMMENCE_WAIT * 3); // a slow swing: the next AttackDone comes late
    }
    expect(r.sent).toEqual(['attack 0.6']);
    expect(r.attack.repeatAttacking).toBe(true);
  });

  it('a GDLE-family server is learned from its first repeat CommenceAttack', () => {
    const r = rig();
    r.press();
    r.attack.handleAttackDone(0);
    r.run(0.8);
    r.attack.handleCommenceAttack();
    expect(r.attack.serverCommencesRepeats).toBe(true);
    r.run(1);
    r.attack.handleAttackDone(0);
    r.run(0.8 + COMMENCE_WAIT + 0.2);
    expect(r.sent).toEqual(['attack 0.6', 'cancel']);
  });

  it('attackChainPending: a chain ended by a refusal is not pending, even with the bar still drawn', () => {
    const r = rig(true);
    r.press();
    expect(r.attack.attackChainPending()).toBe(true);
    r.attack.handleAttackDone(0x36); // WERROR_INTERRUPTED (the AC1999 server's 0x36, GameEnums.h WErrorType)
    expect(r.attack.repeatAttacking).toBe(false);
    expect(r.attack.attackChainPending()).toBe(false);
  });
});
