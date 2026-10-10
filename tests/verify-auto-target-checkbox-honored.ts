/**
 * FAITHFUL.370 / BUG.combat-attack-charge-build.c — the "Auto Target" option.
 *
 * Retail ClientCombatSystem::RecvNotice_SelectionChanged @ 0056bd80: any
 * selection change cancels a live repeat attack (Event_CancelAttack); a
 * selection lost in melee / missile mode, unless Escape dropped it
 * (targetWillinglyLost), runs AutoTarget @ 0056bc80 when the option is on.
 * AutoTarget selects the last attacker if it attacked within
 * AUTO_TARGET_LAST_ATTACKER_MAX_INTERVAL (15 s), else
 * CPlayerSystem::SelectNext(1, 1, SELECTION_TYPE_COMPASS_ITEM, 0) @ 0055f9a0,
 * and never swings. This replaced a text pin on main.ts's invented 30 m
 * nearest-creature scan that attacked the pick immediately.
 */
import { describe, it, expect } from 'vitest';
import {
  AttackRequestController,
  AUTO_TARGET_LAST_ATTACKER_MAX_INTERVAL,
  type AttackRequestDeps,
} from '../packages/renderer/src/controllers/AttackRequest.js';
import {
  selectNextCompassItem,
  isCompassItem,
  type SelectNextCandidate,
  type SelectNextContext,
} from '../packages/renderer/src/controllers/SelectNext.js';
import { RADAR_OUTDOOR_RADIUS, RADAR_INDOOR_RADIUS } from '../packages/renderer/src/world/ObjectRangeChecks.js';

function harness() {
  const state = {
    t: 1000,
    target: 0x80000001,
    mode: 'melee' as 'melee' | 'missile' | null,
    autoTarget: true,
    repeat: false,
    lastAttacker: 0,
    present: new Set<number>(),
    sent: 0,
    cancels: 0,
    selected: [] as number[],
    selectNexts: 0,
  };
  const deps: AttackRequestDeps = {
    now: () => state.t,
    getTarget: () => state.target,
    isAttackable: () => true,
    inReadyPosition: () => state.mode !== null,
    combatMode: () => state.mode,
    currentStyle: () => 0,
    sliderPower: () => 0.5,
    autoRepeat: () => state.repeat,
    sendAttack: () => { state.sent++; },
    setPowerBarLevel: () => {},
    showError: () => {},
    sendCancelAttack: () => { state.cancels++; },
    autoTarget: () => state.autoTarget,
    lastAttacker: () => state.lastAttacker,
    objectPresent: (g) => state.present.has(g),
    selectObject: (g) => state.selected.push(g),
    selectNextCompassItem: () => { state.selectNexts++; },
  };
  return { c: new AttackRequestController(deps), state };
}

describe('AutoTarget @ 0056bc80 via RecvNotice_SelectionChanged @ 0056bd80', () => {
  it('a lost selection in melee mode picks the nearest compass item and never attacks', () => {
    const { c, state } = harness();
    c.onSelectionChanged(0);
    expect(state.selectNexts).toBe(1);
    expect(state.selected).toEqual([]);
    expect(state.sent).toBe(0);
  });

  it('prefers the last attacker when it attacked within 15 s and still exists', () => {
    const { c, state } = harness();
    state.lastAttacker = 0x80000abc;
    state.present.add(0x80000abc);
    c.noteAttacked();
    state.t += AUTO_TARGET_LAST_ATTACKER_MAX_INTERVAL - 0.5;
    c.onSelectionChanged(0);
    expect(state.selected).toEqual([0x80000abc]);
    expect(state.selectNexts).toBe(0);
    expect(state.sent).toBe(0);
  });

  it('falls back to SelectNext once the attack is 15 s old, or the attacker is gone', () => {
    const { c, state } = harness();
    state.lastAttacker = 0x80000abc;
    state.present.add(0x80000abc);
    c.noteAttacked();
    state.t += AUTO_TARGET_LAST_ATTACKER_MAX_INTERVAL;
    c.onSelectionChanged(0);
    expect(state.selected).toEqual([]);
    expect(state.selectNexts).toBe(1);

    c.noteAttacked();
    state.present.clear();
    c.onSelectionChanged(0);
    expect(state.selected).toEqual([]);
    expect(state.selectNexts).toBe(2);
  });

  it('does nothing with the option off, outside melee / missile mode, or for a new selection', () => {
    const { c, state } = harness();
    state.autoTarget = false;
    c.onSelectionChanged(0);
    state.autoTarget = true;
    state.mode = null;
    c.onSelectionChanged(0);
    state.mode = 'melee';
    c.onSelectionChanged(0x80000002);
    expect(state.selectNexts).toBe(0);
    expect(state.selected).toEqual([]);
  });

  it('missile mode auto-targets too', () => {
    const { c, state } = harness();
    state.mode = 'missile';
    c.onSelectionChanged(0);
    expect(state.selectNexts).toBe(1);
  });

  it('an Escape deselect (targetWillinglyLost) skips one Auto Target, then clears', () => {
    const { c, state } = harness();
    c.setSelectionWillinglyLost();
    c.onSelectionChanged(0);
    expect(state.selectNexts).toBe(0);
    expect(c.targetWillinglyLost).toBe(false);
    c.onSelectionChanged(0);
    expect(state.selectNexts).toBe(1);
  });

  it('a selection change cancels a live repeat attack (Event_CancelAttack) instead of continuing it', () => {
    const { c, state } = harness();
    state.repeat = true;
    c.setRequestedAttackHeight('medium');
    state.t += 1;
    c.endAttackRequest();
    expect(state.sent).toBeGreaterThan(0);
    expect(c.repeatAttacking).toBe(true);
    const sent = state.sent;
    c.onSelectionChanged(0x80000002);
    expect(state.cancels).toBe(1);
    expect(c.repeatAttacking).toBe(false);
    expect(state.sent).toBe(sent);
  });

  it('no cancel without Repeat Attacks, or with no attack under way', () => {
    const { c, state } = harness();
    c.onSelectionChanged(0x80000002);
    state.repeat = true;
    c.onSelectionChanged(0x80000003);
    expect(state.cancels).toBe(0);
  });

  it('CommenceAttack opens the attackInProgress window AttackDone closes', () => {
    const { c } = harness();
    c.handleCommenceAttack();
    expect(c.attackInProgress).toBe(true);
    c.handleAttackDone(0x36);
    expect(c.attackInProgress).toBe(false);
  });
});

function cand(over: Partial<SelectNextCandidate>): SelectNextCandidate {
  return { guid: 0x80000010, dx: 5, dy: 0, dz: 0, bitfield: 0x10, physicsState: 0, showableOnRadar: true, present: true, ...over };
}

const ctx = (over: Partial<SelectNextContext> = {}): SelectNextContext => ({
  playerGuid: 0x50000001,
  outside: true,
  meleeOrMissile: true,
  isAttackable: () => true,
  isFellow: () => false,
  ...over,
});

describe('CPlayerSystem::SelectNext @ 0055f9a0 — SELECTION_TYPE_COMPASS_ITEM, forward, from the player', () => {
  it('picks the nearest by 2-D distance + 1.2 × |dz|', () => {
    const a = cand({ guid: 0x80000001, dx: 10, dz: 0 });   // 10
    const b = cand({ guid: 0x80000002, dx: 6, dz: 4 });    // 6 + 4.8 = 10.8
    const d = cand({ guid: 0x80000003, dx: 8, dz: 1 });    // 9.2
    expect(selectNextCompassItem([a, b, d], ctx())).toBe(0x80000003);
  });

  it('breaks an exact distance tie by the lower guid (Farther @ 0055d830)', () => {
    const a = cand({ guid: 0x80000009, dx: 7 });
    const b = cand({ guid: 0x80000004, dx: 0, dy: 7 });
    expect(selectNextCompassItem([a, b], ctx())).toBe(0x80000004);
  });

  it('bounds the 2-D distance by the radar radius: 75 m outdoors, 25 m indoors', () => {
    const far = cand({ dx: 50 });
    expect(selectNextCompassItem([far], ctx())).toBe(far.guid);
    expect(selectNextCompassItem([far], ctx({ outside: false }))).toBe(0);
    expect(selectNextCompassItem([cand({ dx: RADAR_OUTDOOR_RADIUS + 0.1 })], ctx())).toBe(0);
    expect(selectNextCompassItem([cand({ dx: RADAR_INDOOR_RADIUS })], ctx({ outside: false }))).not.toBe(0);
    // An object 30 m away (the old invented cap) is still picked outdoors.
    expect(selectNextCompassItem([cand({ dx: 30 })], ctx())).not.toBe(0);
  });

  it('in melee / missile mode takes only attackable non-fellow non-vendors', () => {
    expect(selectNextCompassItem([cand({})], ctx({ isAttackable: () => false }))).toBe(0);
    expect(selectNextCompassItem([cand({})], ctx({ isFellow: () => true }))).toBe(0);
    expect(selectNextCompassItem([cand({ bitfield: 0x10 | 0x200 })], ctx())).toBe(0);
    expect(selectNextCompassItem([cand({ physicsState: 0x200000 })], ctx())).toBe(0);
  });

  it('skips the player, UI-hidden, cloaked, absent and radar-hidden objects', () => {
    expect(selectNextCompassItem([cand({ guid: 0x50000001 })], ctx())).toBe(0);
    expect(selectNextCompassItem([cand({ bitfield: 0x10 | 0x80 })], ctx())).toBe(0);
    expect(selectNextCompassItem([cand({ physicsState: 0x100000 })], ctx())).toBe(0);
    expect(selectNextCompassItem([cand({ present: false })], ctx())).toBe(0);
    expect(selectNextCompassItem([cand({ showableOnRadar: false })], ctx())).toBe(0);
  });

  it('portals, lifestones and bindstones are compass items without a radar behavior', () => {
    const portal = cand({ bitfield: 0x40000, showableOnRadar: false });
    expect(isCompassItem(portal, ctx({ meleeOrMissile: false }))).toBe(true);
    // ...but in combat mode they still have to be attackable.
    expect(isCompassItem(portal, ctx({ isAttackable: () => false }))).toBe(false);
  });
});
