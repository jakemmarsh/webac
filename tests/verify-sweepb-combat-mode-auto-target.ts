/**
 * SWEEP1006B.player-input.entering-melee-missile-mode-never and
 * SWEEP1006B.player-input.being-hit-evading-melee-missile.
 *
 * ClientCombatSystem::SetCombatMode @ 0056be30: a requested change waits in
 * pendingCombatMode until PlayerInReadyPosition @ 0056b820 (UseTime
 * @ 0056c1f0 applies it); entering melee / missile swaps the selection for
 * GetAttackTarget @ 0056a8f0 (or nothing when that is not attackable) and
 * runs AutoTarget @ 0056bc80 when the option is on and no attackable target
 * remains. HandleDefenderNotificationEvent @ 0056c920 /
 * HandleEvasionDefenderNotificationEvent @ 0056c620 run AutoTarget in melee
 * / missile mode with the option on and nothing selected.
 *
 * Drives the real AttackRequestController and CombatModeChange helpers.
 */
import { describe, it, expect } from 'vitest';
import { CombatMode } from '@ac/shared';
import {
  AttackRequestController,
  AUTO_TARGET_LAST_ATTACKER_MAX_INTERVAL,
  type AttackRequestDeps,
} from '../packages/renderer/src/controllers/AttackRequest.js';
import {
  getAttackTarget,
  playerInReadyPosition,
  PendingCombatMode,
  READY_FORWARD_COMMAND,
  type AttackTargetLookup,
} from '../packages/renderer/src/controllers/CombatModeChange.js';

const PLAYER = 0x50000001;
const MONSTER = 0x80000010;
const NPC = 0x80000020;
const PACK_ITEM = 0x80000030;
const MONSTER_SWORD = 0x80000040; // a child part held by MONSTER
const ATTACKER = 0x80000050;

interface World {
  selected: number;
  mode: 'melee' | 'missile' | null;
  autoTarget: boolean;
  lastAttacker: number;
  t: number;
}

function harness(init: Partial<World> = {}) {
  const w: World = { selected: 0, mode: 'melee', autoTarget: true, lastAttacker: 0, t: 1000, ...init };
  const attackable = new Set([MONSTER, ATTACKER]);
  const lookup: AttackTargetLookup = {
    playerId: PLAYER,
    exists: (g) => [MONSTER, NPC, PACK_ITEM, MONSTER_SWORD, ATTACKER].includes(g),
    ownedByPlayer: (g) => g === PACK_ITEM,
    parentOf: (g) => (g === MONSTER_SWORD ? MONSTER : 0),
  };
  const log = { selects: [] as number[], selectNexts: 0 };
  const deps: AttackRequestDeps = {
    now: () => w.t,
    getTarget: () => w.selected,
    isAttackable: (g) => attackable.has(g),
    inReadyPosition: () => w.mode !== null,
    combatMode: () => w.mode,
    currentStyle: () => 0,
    sliderPower: () => 0.5,
    autoRepeat: () => false,
    sendAttack: () => {},
    setPowerBarLevel: () => {},
    showError: () => {},
    sendCancelAttack: () => {},
    autoTarget: () => w.autoTarget,
    lastAttacker: () => w.lastAttacker,
    objectPresent: (g) => lookup.exists(g),
    selectObject: (g) => { log.selects.push(g); w.selected = g; },
    selectNextCompassItem: () => { log.selectNexts++; w.selected = MONSTER; },
    selectedId: () => w.selected,
    attackTarget: () => getAttackTarget(w.selected, lookup),
    playerId: () => PLAYER,
  };
  return { c: new AttackRequestController(deps), w, log, lookup };
}

describe('GetAttackTarget @ 0056a8f0', () => {
  const { lookup } = harness();
  it('nothing, the player itself and a player-owned item give 0', () => {
    expect(getAttackTarget(0, lookup)).toBe(0);
    expect(getAttackTarget(PLAYER, lookup)).toBe(0);
    expect(getAttackTarget(PACK_ITEM, lookup)).toBe(0);
    expect(getAttackTarget(0x80009999, lookup)).toBe(0); // unknown object
  });
  it('a held child part redirects to its holder; anything else is itself', () => {
    expect(getAttackTarget(MONSTER_SWORD, lookup)).toBe(MONSTER);
    expect(getAttackTarget(NPC, lookup)).toBe(NPC);
    expect(getAttackTarget(MONSTER, lookup)).toBe(MONSTER);
  });
});

describe('SetCombatMode @ 0056be30 — the selection on entering melee / missile', () => {
  it('an NPC selection is dropped, then Auto Target picks the nearest compass item', () => {
    const { c, w, log } = harness({ selected: NPC });
    c.onCombatModeSet();
    expect(log.selects).toEqual([0]);
    expect(log.selectNexts).toBe(1);
    expect(w.selected).toBe(MONSTER);
  });
  it('a pack-item selection is dropped (GetAttackTarget is 0 for owned items)', () => {
    const { c, log } = harness({ selected: PACK_ITEM, autoTarget: false });
    c.onCombatModeSet();
    expect(log.selects).toEqual([0]);
    expect(log.selectNexts).toBe(0);
  });
  it('an attackable creature already selected is kept and Auto Target does not run', () => {
    const { c, w, log } = harness({ selected: MONSTER });
    c.onCombatModeSet();
    expect(log.selects).toEqual([]);
    expect(log.selectNexts).toBe(0);
    expect(w.selected).toBe(MONSTER);
  });
  it("a monster's held weapon swaps to the monster", () => {
    const { c, log } = harness({ selected: MONSTER_SWORD });
    c.onCombatModeSet();
    expect(log.selects).toEqual([MONSTER]);
    expect(log.selectNexts).toBe(0);
  });
  it('Auto Target prefers the attacker that hit us in the last 15 s', () => {
    const { c, w, log } = harness({ selected: 0, mode: null, lastAttacker: ATTACKER });
    c.noteAttacked(); // peace mode: only stamps the time
    expect(log.selects).toEqual([]);
    w.mode = 'missile';
    w.t += AUTO_TARGET_LAST_ATTACKER_MAX_INTERVAL - 1;
    c.onCombatModeSet();
    expect(log.selects).toEqual([ATTACKER]);
    expect(log.selectNexts).toBe(0);
  });
  it('the player selected is left alone, then Auto Target runs (GetAttackTarget(player) = 0)', () => {
    const { c, log } = harness({ selected: PLAYER });
    c.onCombatModeSet();
    expect(log.selects).toEqual([]);
    expect(log.selectNexts).toBe(1);
  });
  it('with Auto Target off a lost selection stays empty', () => {
    const { c, w, log } = harness({ selected: NPC, autoTarget: false });
    c.onCombatModeSet();
    expect(w.selected).toBe(0);
    expect(log.selectNexts).toBe(0);
  });
  it('peace and magic modes leave the selection alone', () => {
    const { c, log } = harness({ selected: NPC, mode: null });
    c.onCombatModeSet();
    expect(log.selects).toEqual([]);
    expect(log.selectNexts).toBe(0);
  });
});

describe('Defender / EvasionDefender notifications run Auto Target', () => {
  it('melee mode, option on, nothing selected: the attacker is selected', () => {
    const { c, log } = harness({ selected: 0, lastAttacker: ATTACKER });
    c.noteAttacked();
    expect(log.selects).toEqual([ATTACKER]);
  });
  it('missile mode with no known attacker falls back to the nearest compass item', () => {
    const { c, log } = harness({ selected: 0, mode: 'missile' });
    c.noteAttacked();
    expect(log.selectNexts).toBe(1);
  });
  it('nothing happens with a selection, in peace / magic mode, or with the option off', () => {
    for (const init of [{ selected: NPC }, { mode: null }, { autoTarget: false }] as Partial<World>[]) {
      const { c, log } = harness({ selected: 0, lastAttacker: ATTACKER, ...init });
      c.noteAttacked();
      expect(log.selects).toEqual([]);
      expect(log.selectNexts).toBe(0);
    }
  });
  it('an attacker from more than 15 s ago is not preferred', () => {
    const { c, w, log } = harness({ selected: NPC, lastAttacker: ATTACKER });
    c.noteAttacked(); // selected: no auto target
    w.selected = 0;
    w.t += AUTO_TARGET_LAST_ATTACKER_MAX_INTERVAL + 1;
    c.onSelectionChanged(0);
    expect(log.selects).toEqual([]);
    expect(log.selectNexts).toBe(1);
  });
});

describe('PlayerInReadyPosition @ 0056b820 and pendingCombatMode', () => {
  const base = { motionsPending: false, style: 0x8000003f, forwardCommand: READY_FORWARD_COMMAND, hasCombatTable: true };
  it('peace / magic / melee wait only for pending motions', () => {
    for (const mode of [CombatMode.NonCombat, CombatMode.Magic, CombatMode.Melee]) {
      expect(playerInReadyPosition({ ...base, mode })).toBe(true);
      expect(playerInReadyPosition({ ...base, mode, motionsPending: true })).toBe(false);
    }
    expect(playerInReadyPosition({ ...base, mode: CombatMode.Melee, hasCombatTable: false })).toBe(false);
  });
  it('missile also needs a missile style and a Ready forward command', () => {
    expect(playerInReadyPosition({ ...base, mode: CombatMode.Missile })).toBe(true);
    expect(playerInReadyPosition({ ...base, mode: CombatMode.Missile, style: 0x8000013b })).toBe(true); // Atlatl, 2017 DAT id
    expect(playerInReadyPosition({ ...base, mode: CombatMode.Missile, forwardCommand: 0x44000007 })).toBe(false); // RunForward
    expect(playerInReadyPosition({ ...base, mode: CombatMode.Missile, style: 0x8000003e })).toBe(false); // SwordCombat
  });
  it('a change made while not ready is parked, then applied once by UseTime', () => {
    const p = new PendingCombatMode();
    expect(p.request(CombatMode.Melee, true)).toBe(true);
    expect(p.pending).toBe(CombatMode.Undef);
    expect(p.request(CombatMode.Melee, false)).toBe(false);
    expect(p.poll(false)).toBe(CombatMode.Undef);
    expect(p.poll(true)).toBe(CombatMode.Melee);
    expect(p.poll(true)).toBe(CombatMode.Undef);
  });
});
