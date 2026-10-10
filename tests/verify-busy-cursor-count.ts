/**
 * GAP.client-busy-cursor-count — ClientUISystem's m_cBusy and the Wait cursor.
 *
 * Retail (decomp): IncrementBusyCount @ 00564870 / DecrementBusyCount
 * @ 00564890 call UpdateCursorState @ 00564630 at the 0 ↔ 1 edges, and
 * UpdateCursorState maps `bVar8 + 0xe` (UICURSOR 14 "Wait" / 15
 * "Wait_OverObject") whenever m_cBusy != 0, ahead of every target-mode and
 * combat-mode branch. Callers: every Use / UseWithTarget / cast / Buy / Sell
 * send (released by Handle_Item__UseDone @ 00564900), HandleCommenceAttack /
 * HandleAttackDone, SetTeleportInProgress, gmExaminationUI's awaited
 * appraisal; OnEndCharacterSession zeroes it.
 *
 * Every test drives the shipped modules: BusyCount / TeleportBusy /
 * ExamineAwait, resolveWorldCursorName, AttackRequestController, and GameUI's
 * teleport animation (happy-dom).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GameActionType } from '@ac/network';
import { CombatMode } from '@ac/shared';
import { BusyCount, ExamineAwait, TeleportBusy, BUSY_COUNT_ACTIONS } from '../packages/renderer/src/ui/BusyCount.js';
import { resolveWorldCursorName } from '../packages/renderer/src/ui/CursorManager.js';
import { AttackRequestController, type AttackRequestDeps } from '../packages/renderer/src/controllers/AttackRequest.js';

function counter() {
  let edges = 0;
  const busy = new BusyCount(() => { edges++; });
  return { busy, edges: () => edges };
}

describe('BusyCount (m_cBusy)', () => {
  it('calls UpdateCursorState only at the 0 → 1 and 1 → 0 edges', () => {
    const { busy, edges } = counter();
    busy.increment();
    expect(busy.busy).toBe(true);
    expect(edges()).toBe(1);
    busy.increment();
    busy.decrement();
    expect(busy.value).toBe(1);
    expect(edges()).toBe(1); // 2 → 1 is not an edge
    busy.decrement();
    expect(busy.busy).toBe(false);
    expect(edges()).toBe(2);
  });

  it('an unpaired UseDone stops at 0 instead of wrapping into a permanent hourglass', () => {
    const { busy, edges } = counter();
    busy.decrement();
    expect(busy.value).toBe(0);
    expect(busy.busy).toBe(false);
    expect(edges()).toBe(0);
    busy.increment();
    expect(busy.busy).toBe(true);
  });

  it('increments for exactly the sends whose retail call sites IncrementBusyCount', () => {
    expect([...BUSY_COUNT_ACTIONS].sort()).toEqual([
      GameActionType.Use, GameActionType.UseWithTarget,
      GameActionType.CastUntargetedSpell, GameActionType.CastTargetedSpell,
      GameActionType.Buy, GameActionType.Sell,
    ].sort());
    const { busy } = counter();
    for (const a of [GameActionType.PutItemInContainer, GameActionType.IdentifyObject, GameActionType.TargetedMeleeAttack, GameActionType.ChangeCombatMode]) {
      busy.noteActionSent(a);
    }
    expect(busy.value).toBe(0);
    busy.noteActionSent(GameActionType.Use);
    busy.noteActionSent(GameActionType.CastTargetedSpell);
    busy.noteActionSent(GameActionType.Sell);
    expect(busy.value).toBe(3);
    // three UseDones release it
    busy.decrement(); busy.decrement(); busy.decrement();
    expect(busy.busy).toBe(false);
  });

  it('OnEndCharacterSession zeroes the count and refreshes the cursor', () => {
    const { busy, edges } = counter();
    busy.increment(); busy.increment();
    busy.reset();
    expect(busy.value).toBe(0);
    expect(edges()).toBe(2);
  });
});

describe('UpdateCursorState: m_cBusy != 0 → Wait / Wait_OverObject before every other branch', () => {
  it('peace, combat and magic modes all show Wait while busy', () => {
    for (const mode of [CombatMode.NonCombat, CombatMode.Melee, CombatMode.Missile, CombatMode.Magic]) {
      expect(resolveWorldCursorName(mode, false, 'none', true)).toBe('Wait');
      expect(resolveWorldCursorName(mode, true, 'none', true)).toBe('Wait_OverObject');
    }
  });

  it('an armed Examine / Use / TargetedUse target mode still yields to the busy count', () => {
    expect(resolveWorldCursorName(CombatMode.NonCombat, true, 'examine', true)).toBe('Wait_OverObject');
    expect(resolveWorldCursorName(CombatMode.NonCombat, false, 'use', true)).toBe('Wait');
    expect(resolveWorldCursorName(CombatMode.NonCombat, true, 'targeted-use', true)).toBe('Wait_OverObject');
  });

  it('not busy: the existing mode cursors are unchanged', () => {
    expect(resolveWorldCursorName(CombatMode.Melee, true, 'none', false)).toBe('Combat_OverObject');
    expect(resolveWorldCursorName(CombatMode.Magic, false)).toBe('Spellcast');
    expect(resolveWorldCursorName(CombatMode.NonCombat, true, 'examine')).toBe('Examine_OverObject');
  });
});

describe('TeleportBusy (CPlayerSystem::SetTeleportInProgress, edge-triggered)', () => {
  it('holds one count for the teleport, however often the state is re-asserted', () => {
    const { busy } = counter();
    const tp = new TeleportBusy(busy);
    tp.set(true);
    tp.set(true);
    expect(busy.value).toBe(1);
    tp.set(false);
    tp.set(false);
    expect(busy.value).toBe(0);
  });
});

describe('ExamineAwait (gmExaminationUI awaiting_appraisal_ID)', () => {
  it('increments once per awaited appraisal and releases on the awaited object only', () => {
    const { busy } = counter();
    const ex = new ExamineAwait(busy);
    ex.examineObject(0x50000001);
    expect(busy.value).toBe(1);
    ex.examineObject(0x50000002); // a second examine while one is awaited: no second count
    expect(busy.value).toBe(1);
    expect(ex.awaitingId).toBe(0x50000002);
    ex.appraisalReceived(0x50000001); // the superseded one's answer releases nothing
    expect(busy.value).toBe(1);
    ex.appraisalReceived(0x50000002);
    expect(busy.value).toBe(0);
    expect(ex.awaitingId).toBe(0);
    ex.appraisalReceived(0x50000002); // a UseTime re-appraise answer: nothing awaited
    expect(busy.value).toBe(0);
  });
});

describe('AttackRequestController: HandleCommenceAttackEvent / HandleAttackDoneEvent', () => {
  function attack() {
    const { busy } = counter();
    const deps: AttackRequestDeps = {
      now: () => 100,
      getTarget: () => 0x80000001,
      isAttackable: () => true,
      inReadyPosition: () => true,
      combatMode: () => 'melee',
      currentStyle: () => 0x8000003c,
      sliderPower: () => 0.5,
      autoRepeat: () => false,
      sendAttack: () => {},
      setPowerBarLevel: () => {},
      showError: () => {},
      sendCancelAttack: () => {},
      autoTarget: () => false,
      lastAttacker: () => 0,
      objectPresent: () => false,
      selectObject: () => {},
      selectNextCompassItem: () => {},
      incrementBusyCount: () => busy.increment(),
      decrementBusyCount: () => busy.decrement(),
    };
    return { c: new AttackRequestController(deps), busy };
  }

  it('CommenceAttack shows the hourglass until AttackDone', () => {
    const { c, busy } = attack();
    c.handleCommenceAttack();
    expect(busy.busy).toBe(true);
    c.handleAttackDone(0);
    expect(busy.busy).toBe(false);
  });

  it('CommenceAttack counts even with an attack request held (the early-out still increments)', () => {
    const { c, busy } = attack();
    c.startAttackRequest();
    expect(c.attackRequestInProgress).toBe(true);
    c.handleCommenceAttack();
    expect(busy.value).toBe(1);
  });

  it('an AttackDone with no attack in progress releases nothing', () => {
    const { c, busy } = attack();
    busy.increment(); // some other pending Use
    c.handleAttackDone(0x36);
    expect(busy.value).toBe(1);
  });

  it('a reset that drops an in-progress attack releases its count', () => {
    const { c, busy } = attack();
    c.handleCommenceAttack();
    c.reset();
    expect(busy.busy).toBe(false);
    c.handleAttackDone(0x36); // the late AttackDone pairs with nothing
    expect(busy.value).toBe(0);
  });
});

describe('GameUI teleport animation reports SetTeleportInProgress (happy-dom)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let H: any;
  const calls: boolean[] = [];
  beforeAll(async () => {
    const { mountGameUI } = await import('./_harness/gameui.js');
    H = await mountGameUI({ callbacks: { onTeleportInProgressChanged: (v: boolean) => { calls.push(v); } } });
    H.ui.setUIHost({ gameFov: 90, setViewDistanceRatio: () => {} });
    H.ui.playUISound = () => {};
  });
  afterAll(() => H?.teardown());

  it('true when the tunnel begins, false at the TAS_OFF step', () => {
    const ui = H.ui;
    calls.length = 0;
    ui.showPortalSpace();
    expect(calls).toEqual([true]);
    const t0 = performance.now() / 1000;
    ui.teleportTick(t0);
    ui.endPortalSpace();
    for (const dt of [1.9, 6.0, 7.1, 7.6]) ui.teleportTick(t0 + dt);
    expect(calls).toEqual([true]); // still in progress through the world fade-in
    ui.teleportTick(t0 + 8.2);
    expect(calls).toEqual([true, false]);
  });

  it('a torn-down tunnel (disconnect) also ends it', () => {
    const ui = H.ui;
    calls.length = 0;
    ui.showPortalSpace();
    ui.hidePortalSpace();
    expect(calls).toEqual([true, false]);
  });

  it('wired to TeleportBusy, a whole teleport is one Wait span', () => {
    const { busy } = counter();
    const tp = new TeleportBusy(busy);
    for (const v of calls) tp.set(v);
    expect(busy.value).toBe(0);
  });
});
