/**
 * BUG.combat-attack-charge-build — the retail hold-to-charge attack
 * (ClientCombatSystem StartAttackRequest @ 0056c040 / UseTime @ 0056c1f0 /
 * EndAttackRequest @ 0056c0e0 / ExecuteAttack @ 0056bb70 /
 * HandleAttackDoneEvent @ 0056c500), driven through the real controller
 * with a fake clock.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  AttackRequestController,
  attackHeightForAction,
  NO_TARGET_TEXT,
  DUAL_WIELD_COMBAT_STYLE,
  type AttackRequestDeps,
  type AttackHeightName,
} from '../packages/renderer/src/controllers/AttackRequest.js';

interface Sent { mode: string; target: number; height: AttackHeightName; power: number }

function harness(over: Partial<AttackRequestDeps> = {}) {
  const state = {
    t: 100,
    target: 0x80000001,
    attackable: true,
    ready: true,
    slider: 0.5,
    repeat: false,
    style: 0x8000003c,
    sent: [] as Sent[],
    bar: [] as number[],
    errors: [] as string[],
    autoTarget: true,
    mode: 'melee' as 'melee' | 'missile' | null,
    lastAttacker: 0,
    present: new Set<number>(),
    cancels: 0,
    selected: [] as number[],
    selectNexts: 0,
  };
  const deps: AttackRequestDeps = {
    now: () => state.t,
    getTarget: () => state.target,
    isAttackable: () => state.attackable,
    inReadyPosition: () => state.ready,
    combatMode: () => state.mode,
    currentStyle: () => state.style,
    sliderPower: () => state.slider,
    autoRepeat: () => state.repeat,
    sendAttack: (mode, target, height, power) => state.sent.push({ mode, target, height, power }),
    setPowerBarLevel: (l) => state.bar.push(l),
    showError: (e) => state.errors.push(e),
    sendCancelAttack: () => { state.cancels++; },
    autoTarget: () => state.autoTarget,
    lastAttacker: () => state.lastAttacker,
    objectPresent: (g) => state.present.has(g),
    selectObject: (g) => state.selected.push(g),
    selectNextCompassItem: () => { state.selectNexts++; },
    ...over,
  };
  const c = new AttackRequestController(deps);
  const lastBar = () => state.bar[state.bar.length - 1];
  return { c, state, lastBar };
}

describe('attackHeightForAction (HandleCombatAction ids)', () => {
  it('maps the melee and missile Low/Medium/High Attack commands', () => {
    expect(attackHeightForAction(0x1000005d)).toBe('low');
    expect(attackHeightForAction(0x1000005e)).toBe('medium');
    expect(attackHeightForAction(0x1000005f)).toBe('high');
    expect(attackHeightForAction(0x100000f1)).toBe('low');
    expect(attackHeightForAction(0x100000f2)).toBe('medium');
    expect(attackHeightForAction(0x100000f3)).toBe('high');
    expect(attackHeightForAction(0x1000005c)).toBeNull(); // Increase Power
  });
});

describe('AttackRequestController — hold to charge, release to swing', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => { h = harness(); });

  it('a press builds the meter over ATTACK_POWERUP_TIME (1 s) without sending', () => {
    h.c.setRequestedAttackHeight('high');
    expect(h.lastBar()).toBe(0);
    h.state.t += 0.25; h.c.useTime();
    expect(h.lastBar()).toBeCloseTo(0.25);
    h.state.t += 0.5; h.c.useTime();
    expect(h.lastBar()).toBeCloseTo(0.75);
    h.state.t += 2; h.c.useTime();
    expect(h.lastBar()).toBe(1); // clamped
    expect(h.state.sent).toEqual([]);
  });

  it('dual wield (style 0x80000046) builds in 0.8 s', () => {
    h.state.style = DUAL_WIELD_COMBAT_STYLE;
    h.c.setRequestedAttackHeight('medium');
    h.state.t += 0.4; h.c.useTime();
    expect(h.lastBar()).toBeCloseTo(0.5);
  });

  it('release past the slider swings at the bar power, then queues the slider power', () => {
    h.c.setRequestedAttackHeight('high');
    h.state.t += 0.8; h.c.useTime();
    h.c.endAttackRequest();
    // EndAttackRequest calls ExecuteAttack twice when bar > slider (0056c181, 0056c1a5).
    expect(h.state.sent.map((s) => s.power)).toEqual([expect.closeTo(0.8), 0.5]);
    expect(h.state.sent[0]).toMatchObject({ mode: 'melee', target: 0x80000001, height: 'high' });
    expect(h.c.attackServerResponsePending).toBe(true);
  });

  it('release exactly at the slider swings once', () => {
    h.state.slider = 1;
    h.c.setRequestedAttackHeight('low');
    h.state.t += 1.5; h.c.useTime();
    h.c.endAttackRequest();
    expect(h.state.sent).toEqual([{ mode: 'melee', target: 0x80000001, height: 'low', power: 1 }]);
  });

  it('a quick tap keeps building and swings once the bar reaches the slider', () => {
    h.state.slider = 0.6;
    h.c.setRequestedAttackHeight('medium');
    h.state.t += 0.1; h.c.useTime();
    h.c.endAttackRequest();
    expect(h.state.sent).toEqual([]);
    h.state.t += 0.3; h.c.useTime();
    expect(h.state.sent).toEqual([]);
    expect(h.lastBar()).toBeCloseTo(0.4);
    h.state.t += 0.3; h.c.useTime();
    expect(h.state.sent).toEqual([{ mode: 'melee', target: 0x80000001, height: 'medium', power: 0.6 }]);
    expect(h.lastBar()).toBeCloseTo(0.6); // min(requested, bar)
  });

  it('the meter holds until AttackDone, then clears (no repeat)', () => {
    h.state.slider = 0.2;
    h.c.setRequestedAttackHeight('high');
    h.state.t += 0.5; h.c.useTime();
    h.c.endAttackRequest();
    const before = h.state.bar.length;
    h.state.t += 0.5; h.c.useTime();
    expect(h.state.bar.length).toBe(before); // no build in progress
    h.c.handleAttackDone(0);
    expect(h.lastBar()).toBe(0);
    expect(h.c.attackServerResponsePending).toBe(false);
  });

  it('with Repeat Attacks the meter rebuilds after AttackDone and never sends', () => {
    h.state.repeat = true;
    h.state.slider = 0.5;
    h.c.setRequestedAttackHeight('high');
    h.state.t += 0.5; h.c.useTime();
    h.c.endAttackRequest();
    expect(h.state.sent.length).toBe(1);
    expect(h.c.repeatAttacking).toBe(true);
    h.c.handleAttackDone(0);
    expect(h.lastBar()).toBe(0);
    h.state.t += 0.25; h.c.useTime();
    expect(h.lastBar()).toBeCloseTo(0.25);
    h.state.t += 1; h.c.useTime();
    expect(h.state.sent.length).toBe(1); // the automatic build stops at the slider
    expect(h.c.buildInProgress).toBe(false);
  });

  it('BUG.combat-attack-charge-build.b: a repeat AttackDone sends nothing while the power matches the slider', () => {
    h.state.repeat = true;
    h.state.slider = 0.5;
    h.c.setRequestedAttackHeight('high');
    h.state.t += 1.2; h.c.useTime();
    h.c.endAttackRequest();
    // EndAttackRequest: the full bar (1.0), then the slider's 0.5 for ACE's AttackQueue.
    expect(h.state.sent.map((x) => x.power)).toEqual([1, 0.5]);
    for (let i = 0; i < 3; i++) {
      h.c.handleAttackDone(0);
      h.state.t += 0.5; h.c.useTime();
    }
    expect(h.state.sent.length).toBe(2); // the server swings the repeats
    expect(h.c.repeatAttacking).toBe(true);
  });

  it('BUG.combat-attack-charge-build.b: EndAttackRequest\'s two sends leave in the same instant (any send throttle drops the slider power)', () => {
    const at: number[] = [];
    const g = harness({ sendAttack: () => at.push(g.state.t) });
    g.state.slider = 0.5;
    g.c.setRequestedAttackHeight('medium');
    g.state.t += 1.2; g.c.useTime();
    g.c.endAttackRequest();
    expect(at).toEqual([g.state.t, g.state.t]);
  });

  it('BUG.combat-attack-charge-build.b: a slider moved mid-repeat re-sends once at the new power', () => {
    h.state.repeat = true;
    h.state.slider = 0.5;
    h.c.setRequestedAttackHeight('low');
    h.state.t += 0.5; h.c.useTime();
    h.c.endAttackRequest();
    expect(h.state.sent).toEqual([{ mode: 'melee', target: 0x80000001, height: 'low', power: 0.5 }]);
    h.state.slider = 0.8;
    h.c.handleAttackDone(0);
    expect(h.state.sent.length).toBe(2);
    expect(h.state.sent[1]).toEqual({ mode: 'melee', target: 0x80000001, height: 'low', power: 0.8 });
    // ExecuteAttack(..., false): no response pending, the meter rebuilds.
    expect(h.c.attackServerResponsePending).toBe(false);
    expect(h.c.buildInProgress).toBe(true);
    h.c.handleAttackDone(0);
    expect(h.state.sent.length).toBe(2); // within 0.01 of the slider now
  });

  it('BUG.combat-attack-charge-build.b: a drift of 0.01 or less is not a re-send', () => {
    h.state.repeat = true;
    h.state.slider = 0.5;
    h.c.setRequestedAttackHeight('high');
    h.state.t += 0.5; h.c.useTime();
    h.c.endAttackRequest();
    h.state.slider = 0.509;
    h.c.handleAttackDone(0);
    expect(h.state.sent.length).toBe(1);
  });

  it('BUG.combat-attack-charge-build.b: no drift re-send while a key is held, or without Repeat Attacks', () => {
    h.state.repeat = true;
    h.state.slider = 0.5;
    h.c.setRequestedAttackHeight('high');
    h.state.t += 0.5; h.c.useTime();
    h.c.endAttackRequest();
    h.state.slider = 0.9;
    h.c.setRequestedAttackHeight('high'); // held again: attackRequestInProgress
    h.c.handleAttackDone(0);
    expect(h.state.sent.length).toBe(1);

    const g = harness();
    g.state.slider = 0.5;
    g.c.setRequestedAttackHeight('high');
    g.state.t += 0.5; g.c.useTime();
    g.c.endAttackRequest();
    g.state.slider = 0.9;
    g.c.handleAttackDone(0);
    expect(g.state.sent.length).toBe(1);
  });

  it('a non-zero AttackDone (ACE ActionCancelled 0x36) ends the repeat and clears the meter', () => {
    h.state.repeat = true;
    h.c.setRequestedAttackHeight('high');
    h.state.t += 0.6; h.c.useTime();
    h.c.endAttackRequest();
    h.c.handleAttackDone(0x36);
    expect(h.c.repeatAttacking).toBe(false);
    expect(h.lastBar()).toBe(0);
    h.state.t += 1; h.c.useTime();
    expect(h.lastBar()).toBe(0);
  });

  it('a release while the server is still swinging queues the attack for AttackDone', () => {
    h.state.slider = 0.3;
    h.c.setRequestedAttackHeight('high');
    h.state.t += 0.5; h.c.useTime();
    h.c.endAttackRequest();
    const n = h.state.sent.length;
    h.c.setRequestedAttackHeight('low');
    h.state.t += 0.2; h.c.useTime();
    h.c.endAttackRequest();
    expect(h.state.sent.length).toBe(n);
    expect(h.c.attackWhenResponseReceived).toBe(true);
    h.c.handleAttackDone(0);
    // StartAttackRequest + EndAttackRequest(queued power): the bar restarts
    // from 0 and UseTime swings once it reaches the queued 0.3.
    expect(h.state.sent.length).toBe(n);
    h.state.t += 0.35; h.c.useTime();
    expect(h.state.sent.length).toBe(n + 1);
    expect(h.state.sent[n]).toMatchObject({ height: 'low', power: 0.3 });
  });

  it('BUG.combat-attack-charge-build.c.a: CommenceAttack holds the meter at the swing power and stops the automatic build', () => {
    h.state.repeat = true;
    h.state.slider = 0.5;
    h.c.setRequestedAttackHeight('high');
    h.state.t += 0.6; h.c.useTime();
    h.c.endAttackRequest(); // swings at 0.6, then queues the slider's 0.5
    const sends = h.state.sent.length;
    const power = h.c.requestedAttackPower;
    expect(power).toBeCloseTo(0.5);
    h.c.handleAttackDone(0); // the automatic rebuild starts
    h.state.t += 0.2; h.c.useTime();
    expect(h.lastBar()).toBeCloseTo(0.2);
    h.c.handleCommenceAttack(); // ACE's next queued swing begins
    expect(h.lastBar()).toBeCloseTo(power);
    expect(h.c.latestPowerBarLevel).toBeCloseTo(power);
    expect(h.c.buildInProgress).toBe(false);
    expect(h.c.attackServerResponsePending).toBe(true);
    h.state.t += 0.5; h.c.useTime();
    expect(h.lastBar()).toBeCloseTo(power); // no climb until AttackDone
    h.c.handleAttackDone(0);
    expect(h.lastBar()).toBe(0);
    h.state.t += 0.3; h.c.useTime();
    expect(h.lastBar()).toBeCloseTo(0.3);
    expect(h.state.sent.length).toBe(sends);
  });

  it('BUG.combat-attack-charge-build.c.a: CommenceAttack opens the bar when it was undefined', () => {
    h.c.requestedAttackPower = 0.75;
    h.c.handleCommenceAttack();
    expect(h.state.bar).toEqual([0, 0.75]);
    expect(h.c.repeatAttackInProgress()).toBe(false); // Repeat Attacks off
    h.state.repeat = true;
    expect(h.c.repeatAttackInProgress()).toBe(true); // powerBarMode == PBM_COMBAT
  });

  it('BUG.combat-attack-charge-build.c.a: a held key keeps building through CommenceAttack', () => {
    h.c.setRequestedAttackHeight('high');
    h.state.t += 0.4; h.c.useTime();
    const before = h.state.bar.length;
    h.c.handleCommenceAttack();
    expect(h.state.bar.length).toBe(before);
    expect(h.c.buildInProgress).toBe(true);
    h.state.t += 0.2; h.c.useTime();
    expect(h.lastBar()).toBeCloseTo(0.6);
  });

  it('BUG.combat-attack-charge-build.c.a: a press and release after CommenceAttack queues for AttackDone instead of swinging', () => {
    h.state.repeat = true;
    h.state.slider = 0.3;
    h.c.setRequestedAttackHeight('high');
    h.state.t += 0.5; h.c.useTime();
    h.c.endAttackRequest();
    h.c.handleAttackDone(0);
    h.c.handleCommenceAttack();
    const n = h.state.sent.length;
    h.c.setRequestedAttackHeight('low');
    h.state.t += 0.4; h.c.useTime();
    h.c.endAttackRequest();
    expect(h.state.sent.length).toBe(n);
    expect(h.c.attackWhenResponseReceived).toBe(true);
    // AttackDone replays it: StartAttackRequest + EndAttackRequest(0.4),
    // which swings at once because the repeat is still running.
    h.c.handleAttackDone(0);
    const after = h.state.sent.slice(n);
    expect(after.every((s) => s.height === 'low')).toBe(true);
    expect(after.some((s) => Math.abs(s.power - 0.4) < 1e-9)).toBe(true);
  });

  it('no attackable target: the spew-box text and no build', () => {
    h.state.attackable = false;
    h.c.setRequestedAttackHeight('high');
    expect(h.state.errors).toEqual([NO_TARGET_TEXT]);
    expect(h.c.attackRequestInProgress).toBe(false);
    expect(h.state.bar).toEqual([]);
  });

  it('a held key auto-repeat (same height, in progress) does not restart the build', () => {
    h.c.setRequestedAttackHeight('high');
    h.state.t += 0.4;
    h.c.setRequestedAttackHeight('high');
    h.c.useTime();
    expect(h.lastBar()).toBeCloseTo(0.4);
  });

  it('leaving the ready stance drops the build to 0', () => {
    h.c.setRequestedAttackHeight('high');
    h.state.t += 0.4; h.c.useTime();
    h.state.ready = false; h.c.useTime();
    expect(h.lastBar()).toBe(0);
    expect(h.c.buildInProgress).toBe(false);
  });

  it('reset (combat mode change) clears the request and the meter', () => {
    h.c.setRequestedAttackHeight('high');
    h.state.t += 0.4; h.c.useTime();
    h.c.reset();
    expect(h.lastBar()).toBe(0);
    h.c.endAttackRequest();
    expect(h.state.sent).toEqual([]);
  });
});

describe('StartAttackRequest @ 0056c040 → cmdinterp->MaybeStopCompletely (BUG.cast-while-moving-keeps-moving)', () => {
  it('a started attack request stands the player still', () => {
    let stops = 0;
    const h = harness({ maybeStopCompletely: () => { stops++; } });
    h.c.startAttackRequest();
    expect(h.c.attackRequestInProgress).toBe(true);
    expect(stops).toBe(1);
  });

  it('a refused one (no attackable target) does not stop', () => {
    let stops = 0;
    const h = harness({ maybeStopCompletely: () => { stops++; } });
    h.state.target = 0;
    h.c.startAttackRequest();
    expect(h.state.errors).toEqual([NO_TARGET_TEXT]);
    expect(stops).toBe(0);
  });
});

/**
 * SWEEP1006 jump vs repeat — ClientCombatSystem::CommenceJump @ 0056af90:
 * an accepted jump charge sends CancelAttack and ends the repeat when the
 * Repeat Attacks option is on, and the combat bar gives way to the jump bar.
 */
describe('commenceJump', () => {
  it('Repeat Attacks on: CancelAttack, the repeat ends, the combat build stops', () => {
    const { c, state } = harness();
    state.repeat = true;
    c.startAttackRequest();
    c.repeatAttacking = true;
    expect(c.buildInProgress).toBe(true);
    c.commenceJump();
    expect(state.cancels).toBe(1);
    expect(c.repeatAttacking).toBe(false);
    expect(c.buildInProgress).toBe(false);
  });
  it('Repeat Attacks off: no CancelAttack', () => {
    const { c, state } = harness();
    state.repeat = false;
    c.commenceJump();
    expect(state.cancels).toBe(0);
  });
});

/**
 * webac#2 — "Enabling/Disabling Advanced combat does not do anything". The
 * Advanced Combat Interface option (PlayerModule::AdvancedCombatUI) is
 * latched into m_bAdvancedCombatMode by SetCombatMode @ 0056be30; its builds
 * open the floaty power bar (AttemptStartBuildingAttack @ 0056bb00:
 * powerBarMode = advanced + PBM_COMBAT → SendNotice_BeginPowerbar(2)), need
 * no target to start (StartAttackRequest @ 0056c040), swing at the bar's
 * power alone (EndAttackRequest @ 0056c0e0) and end with FinishPowerbar
 * (HidePowerBar @ 0056a8b0).
 */
describe('AttackRequestController — Advanced Combat Interface (PBM_ADVANCED_COMBAT)', () => {
  function advanced(on = true) {
    const ev: string[] = [];
    const opt = { on };
    const h = harness({
      advancedCombatUI: () => opt.on,
      beginAdvancedPowerBar: (mode) => ev.push(`begin:${mode}`),
      setAdvancedPowerBarLevel: (l) => ev.push(`level:${l.toFixed(2)}`),
      finishAdvancedPowerBar: () => ev.push('finish'),
    });
    return { ...h, ev, opt };
  }

  it('latches the option at construction and at each combat-mode change, not on a mid-mode toggle', () => {
    const h = advanced(false);
    expect(h.c.advancedCombatMode).toBe(false);
    h.opt.on = true;
    expect(h.c.advancedCombatMode).toBe(false);
    h.c.onCombatModeSet();
    expect(h.c.advancedCombatMode).toBe(true);
    h.state.mode = null;
    h.opt.on = false;
    h.c.onCombatModeSet(); // leaving combat latches too
    expect(h.c.advancedCombatMode).toBe(false);
  });

  it('a press opens the floaty bar in the combat mode, builds it, and never touches the combat bar meter', () => {
    const h = advanced();
    h.c.setRequestedAttackHeight('high');
    expect(h.ev[0]).toBe('begin:melee');
    expect(h.c.powerBarMode).toBe(2);
    h.state.t += 0.4; h.c.useTime();
    expect(h.ev[h.ev.length - 1]).toBe('level:0.40');
    expect(h.state.bar).toEqual([]);
  });

  it('missile mode opens the missile (Accuracy) state', () => {
    const h = advanced();
    h.state.mode = 'missile';
    h.c.setRequestedAttackHeight('low');
    expect(h.ev[0]).toBe('begin:missile');
  });

  it('needs no selected target to start building', () => {
    const h = advanced();
    h.state.target = 0;
    h.c.setRequestedAttackHeight('medium');
    expect(h.state.errors).toEqual([]);
    expect(h.c.attackRequestInProgress).toBe(true);
  });

  it('release swings once at the bar power (the slider plays no part), AttackDone finishes the bar', () => {
    const h = advanced();
    h.state.slider = 0.9;
    h.c.setRequestedAttackHeight('high');
    h.state.t += 0.3; h.c.useTime();
    h.c.endAttackRequest();
    expect(h.state.sent).toHaveLength(1);
    expect(h.state.sent[0].power).toBeCloseTo(0.3);
    h.c.handleAttackDone(0);
    expect(h.ev[h.ev.length - 1]).toBe('finish');
    expect(h.c.powerBarMode).toBe(0);
  });

  it('with the option off the classic combat-bar meter is unchanged (no floaty bar)', () => {
    const h = advanced(false);
    h.c.setRequestedAttackHeight('high');
    expect(h.ev).toEqual([]);
    expect(h.c.powerBarMode).toBe(1);
    expect(h.lastBar()).toBe(0);
  });
});
