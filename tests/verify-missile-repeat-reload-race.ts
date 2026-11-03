/**
 * BUG.missile-repeat-attack-stall — with Repeat Attacks on, a bow attack on the AC1999 server fired
 * once and stopped (Jake, 2026-11-01).
 *
 * The AC1999 server repeats a missile attack itself: after the shot it plays Reload, and when the
 * Reload ends it sends AttackDone {0} (AttackManager.cpp OnMotionDone, run first by
 * WeenieObject.cpp OnMotionDone) and only then the Ready that ends the Reload (DoForcedStopCompletely),
 * each in its own datagram (PacketController.cpp: one fragment per UDP packet). AttackDone {0}
 * starts the client's automatic rebuild; if a frame ran before the Ready arrived, UseTime saw the
 * player still in Reload (not the ready position) and, with Repeat Attacks on, sent CancelAttack
 * (EoL UseTime @ 0056c1f0; 1999 PanelUI_Global_Loop @ 0x004f4e10 → 0x004f9530), which ended the
 * server's repeat after one shot. ACE sends Ready before AttackDone (Player_Missile.cs), so end of
 * retail and Dark Majesty never met the gap.
 *
 * The real AttackRequestController, wired as main.ts wires it (forwardHeldByServer = the
 * interpreted forward command is the server's Reload / Aim and the player is not walking).
 */
import { describe, expect, it } from 'vitest';
import { AttackRequestController, SERVER_READY_WAIT } from '../packages/renderer/src/controllers/AttackRequest.js';

const TARGET = 0x80001234;
type Forward = 'ready' | 'reload' | 'walk';

function rig() {
  let now = 100;
  let forward: Forward = 'ready';
  const sent: string[] = [];
  const bar: number[] = [];
  const attack = new AttackRequestController({
    now: () => now, getTarget: () => TARGET, isAttackable: () => true,
    inReadyPosition: () => forward === 'ready',
    forwardHeldByServer: () => forward === 'reload',
    combatMode: () => 'missile', currentStyle: () => 0, sliderPower: () => 0.5, autoRepeat: () => true,
    sendAttack: (_m, _t, _h, power) => sent.push(`attack ${power}`),
    setPowerBarLevel: (l) => bar.push(l), showError: () => {},
    sendCancelAttack: () => sent.push('cancel'),
    autoTarget: () => false, lastAttacker: () => 0, objectPresent: () => true, selectObject: () => {}, selectNextCompassItem: () => {},
  });
  return {
    attack, sent, bar,
    tick: (dt: number) => { now += dt; attack.useTime(); },
    setForward: (f: Forward) => { forward = f; },
  };
}

/** Press and release at the slider's power: the first shot, the server then repeats it. */
function firstShot(r: ReturnType<typeof rig>): void {
  r.attack.setRequestedAttackHeight('medium');
  r.tick(0.5);
  r.attack.endAttackRequest();
  expect(r.sent).toEqual(['attack 0.5']);
  expect(r.attack.repeatAttacking).toBe(true);
  r.attack.handleCommenceAttack();
}

describe('missile repeat across the AC1999 server\'s AttackDone-then-Ready datagrams', () => {
  it('AttackDone {0} while the server\'s Reload still holds: no CancelAttack, the bar waits at 0, and the repeat survives the Ready', () => {
    const r = rig();
    firstShot(r);
    r.setForward('reload'); // the shot's Reload, applied by the server
    r.attack.handleAttackDone(0); // datagram 1
    r.tick(1 / 60); // a frame between the two datagrams
    r.tick(1 / 60);
    expect(r.sent).not.toContain('cancel');
    expect(r.attack.repeatAttacking).toBe(true);
    expect(r.attack.buildInProgress).toBe(true);
    expect(r.bar.at(-1)).toBe(0);
    r.setForward('ready'); // datagram 2: the Ready
    for (let i = 0; i < 90; i++) r.tick(1 / 60);
    // The automatic build fills and stops without sending: the server fires the next shot itself.
    expect(r.sent).toEqual(['attack 0.5']);
    expect(r.attack.repeatAttacking).toBe(true);
    expect(r.attack.buildInProgress).toBe(false);
    // The server's next shot: CommenceAttack, then the next reload's AttackDone, both handled.
    r.attack.handleCommenceAttack();
    r.setForward('reload');
    r.attack.handleAttackDone(0);
    r.tick(1 / 60);
    expect(r.sent).not.toContain('cancel');
  });

  it('walking during the automatic build still cancels the repeat (retail UseTime)', () => {
    const r = rig();
    firstShot(r);
    r.attack.handleAttackDone(0); // ACE order: Ready came first
    r.setForward('walk');
    r.tick(1 / 60);
    expect(r.sent).toEqual(['attack 0.5', 'cancel']);
    expect(r.attack.repeatAttacking).toBe(false);
  });

  it('a held key build (no automatic build) out of position is cancelled as before, server substate or not', () => {
    const r = rig();
    r.attack.setRequestedAttackHeight('medium');
    r.setForward('reload');
    r.tick(1 / 60);
    expect(r.sent).toEqual(['cancel']);
  });

  // webac#16 — "after firing an arrow the animation gets stuck and the combat stops until I move
  // away". The AC1999 server can end a repeat with AttackDone {0} and no Ready behind it:
  // AttackManager::OnAttackCancelled(0) sends 0x1A7 {0} and only DoForcedMotion(style), which keeps
  // the forward command (AttackManager.cpp:45-58), after CheckTimeout's Cancel(0) or a failed Aim's
  // Cancel() (AttackEventData.cpp; Cancel's default error is 0, AttackEventData.h:47). The hold
  // above then waited for a Ready that never came: the bar sat at 0 and nothing went out.
  it('an AttackDone {0} with no Ready behind it: the hold gives up after SERVER_READY_WAIT and the retail cancel runs', () => {
    const r = rig();
    firstShot(r);
    r.setForward('reload'); // the server's Aim / Reload still holds the forward command
    r.attack.handleAttackDone(0);
    const frames = Math.floor((SERVER_READY_WAIT - 0.05) * 60);
    for (let i = 0; i < frames; i++) r.tick(1 / 60);
    expect(r.sent).not.toContain('cancel'); // still inside the datagram window
    expect(r.attack.repeatAttacking).toBe(true);
    for (let i = 0; i < 10; i++) r.tick(1 / 60);
    expect(r.sent).toEqual(['attack 0.5', 'cancel']);
    expect(r.attack.repeatAttacking).toBe(false);
    expect(r.attack.buildInProgress).toBe(false);
    // A fresh press builds and swings again once the body is back in the ready position.
    r.setForward('ready');
    r.attack.setRequestedAttackHeight('medium');
    r.tick(0.5);
    r.attack.endAttackRequest();
    expect(r.sent).toEqual(['attack 0.5', 'cancel', 'attack 0.5']);
  });

  it('each automatic build gets its own window: a long fight never trips it while the Ready keeps coming', () => {
    const r = rig();
    firstShot(r);
    for (let shot = 0; shot < 5; shot++) {
      r.setForward('reload');
      r.attack.handleAttackDone(0);
      r.tick(1 / 60);
      r.setForward('ready'); // the Ready, a frame later
      for (let i = 0; i < 120; i++) r.tick(1 / 60); // 2 s: past SERVER_READY_WAIT from the first shot
      r.attack.handleCommenceAttack();
    }
    expect(r.sent).toEqual(['attack 0.5']);
    expect(r.attack.repeatAttacking).toBe(true);
  });
});
