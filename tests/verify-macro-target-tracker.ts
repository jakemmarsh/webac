/**
 * VirindiTank's monster blacklist and ghosts (agent/macro/targetTracker.ts) and
 * its combat-mode gate (agent/macro/modeGate.ts), as pure pieces. The macro's
 * use of them runs against the real spell table in verify-vtank-macro.ts.
 */
import { describe, expect, it } from 'vitest';
import { HIT_ENVIRONMENT, INVALID_TARGET, TargetTracker, type TrackerSettings } from '../packages/renderer/src/agent/macro/targetTracker.ts';
import { BUGGED_COMBAT_STATE, MODE_CONFIRM_MAX_MS, MODE_CONFIRM_MS, ModeGate, modeOfStance } from '../packages/renderer/src/agent/macro/modeGate.ts';
import { vtDefaults, vtOption } from '../packages/shared/src/routines/vtankOptions.ts';

const SETTINGS: TrackerSettings = {
  BlacklistMonsterAttemptCount: 4, BlacklistMonsterTimeoutSeconds: 120, DeleteGhostMonsters: true,
  GhostMonsterSpellAttemptCount: 200, DeleteGhostMonstersByHPTracker: true, GhostDeleteHPTrackerSeconds: 30,
};

function tracker() {
  let t = 1_000_000;
  const tr = new TargetTracker(() => t);
  return { tr, at: (ms: number) => { t = ms; }, add: (ms: number) => { t += ms; } };
}

describe('the blacklist (VTank BlacklistMonsterAttemptCount / -TimeoutSeconds)', () => {
  it('the attempt after the allowance blacklists it for the timeout; then the count starts over', () => {
    const { tr, add } = tracker();
    for (let i = 0; i < 4; i++) expect(tr.miss(1, 'Drudge Skulker', SETTINGS)).toBeNull();
    expect(tr.excluded(1)).toBe(false);
    expect(tr.miss(1, 'Drudge Skulker', SETTINGS)).toBe('Drudge Skulker blacklisted for 120 s: 5 attempts in a row didn\'t reach it');
    expect(tr.excluded(1)).toBe(true);
    add(119_000);
    expect(tr.excluded(1)).toBe(true);
    add(1_000);
    expect(tr.excluded(1)).toBe(false);
    // Starts over: four more misses are allowed again.
    for (let i = 0; i < 4; i++) expect(tr.miss(1, 'Drudge Skulker', SETTINGS)).toBeNull();
  });

  it('a blow or a debuff that lands clears the count', () => {
    const { tr } = tracker();
    for (let i = 0; i < 4; i++) tr.miss(1, 'Rat', SETTINGS);
    tr.reached(1);
    for (let i = 0; i < 4; i++) expect(tr.miss(1, 'Rat', SETTINGS)).toBeNull();
  });

  it('"invalid target" blacklists at once; a later trip never shortens a blacklist', () => {
    const { tr, add } = tracker();
    expect(tr.invalid(2, 'Gate Guard', SETTINGS)).toMatch(/invalid target/);
    expect(tr.excluded(2)).toBe(true);
    add(60_000);
    tr.invalid(2, 'Gate Guard', { ...SETTINGS, BlacklistMonsterTimeoutSeconds: 10 });
    add(59_000);
    expect(tr.excluded(2)).toBe(true);
  });

  it('a monster out of view for five minutes is forgotten', () => {
    const { tr, add } = tracker();
    for (let i = 0; i < 4; i++) tr.miss(3, 'Rat', SETTINGS);
    tr.observe([], SETTINGS);
    add(301_000);
    tr.observe([], SETTINGS);
    expect(tr.miss(3, 'Rat', SETTINGS)).toBeNull(); // a fresh count
  });

  it('the server\'s words: invalid targets (GDLE / AC1999 and ACE) and an environment hit (ACE and AC1999 alike)', () => {
    expect(INVALID_TARGET.test('Drudge Skulker is an invalid target.')).toBe(true);
    expect(INVALID_TARGET.test('Flame Bolt I cannot be cast on Gate Guard.')).toBe(true);
    expect(INVALID_TARGET.test('You cast Flame Bolt I on Drudge Skulker')).toBe(false);
    expect(HIT_ENVIRONMENT.test('Your missile attack hit the environment.')).toBe(true);
    expect(HIT_ENVIRONMENT.test('You hit Drudge Skulker for 12 points of slashing damage!')).toBe(false);
  });
});

describe('ghosts (DeleteGhostMonsters, DeleteGhostMonstersByHPTracker)', () => {
  it('casts never answered: the one after GhostMonsterSpellAttemptCount sets it aside; any answer starts the count over', () => {
    const { tr } = tracker();
    const s = { ...SETTINGS, GhostMonsterSpellAttemptCount: 3, BlacklistMonsterAttemptCount: 1000 };
    for (let i = 0; i < 3; i++) expect(tr.silent(4, 'Mosswart', 0.8, s)).toBeNull();
    tr.answered(4);
    for (let i = 0; i < 3; i++) expect(tr.silent(4, 'Mosswart', 0.8, s)).toBeNull();
    expect(tr.silent(4, 'Mosswart', 0.8, s)).toMatch(/ghost monster Mosswart set aside/);
    expect(tr.excluded(4)).toBe(true);
    // Its health reading differently proves it's there: no longer set aside.
    tr.observe([{ guid: 4, name: 'Mosswart', health: 0.8 }], s);
    expect(tr.excluded(4)).toBe(true);
    tr.observe([{ guid: 4, name: 'Mosswart', health: 0.5 }], s);
    expect(tr.excluded(4)).toBe(false);
  });

  it('with DeleteGhostMonsters off, silence never sets one aside', () => {
    const { tr } = tracker();
    const s = { ...SETTINGS, GhostMonsterSpellAttemptCount: 1, DeleteGhostMonsters: false };
    tr.silent(5, 'Rat', undefined, s);
    expect(tr.silent(5, 'Rat', undefined, s)).toBeNull();
    expect(tr.excluded(5)).toBe(false);
  });

  it('HP tracker: fought for GhostDeleteHPTrackerSeconds with no change to its health, and listed with a max health', () => {
    const { tr, add } = tracker();
    const listed = (n: string) => n === 'Drudge Skulker';
    tr.engage(6, 'Drudge Skulker', 1);
    tr.observe([{ guid: 6, name: 'Drudge Skulker', health: 1 }], SETTINGS);
    add(20_000);
    tr.observe([{ guid: 6, name: 'Drudge Skulker', health: 0.9 }], SETTINGS); // it changed: 30 s from here
    add(29_000);
    expect(tr.checkHp(listed, SETTINGS)).toBeNull();
    add(1_000);
    expect(tr.checkHp(listed, SETTINGS)).toBe('ghost monster Drudge Skulker set aside: its health hasn\'t changed in 30 s of fighting it');
    expect(tr.excluded(6)).toBe(true);
    // Out of view: forgotten (back later, it's a target again).
    tr.observe([], SETTINGS);
    expect(tr.excluded(6)).toBe(false);
  });

  it('HP tracker: a monster with no known max health, the option off, or re-engaging the same monster', () => {
    const { tr, add } = tracker();
    tr.engage(7, 'Unknown Thing', 1);
    add(60_000);
    expect(tr.checkHp(() => false, SETTINGS)).toBeNull();
    expect(tr.checkHp(() => true, { ...SETTINGS, DeleteGhostMonstersByHPTracker: false })).toBeNull();
    // Engaging the monster it already follows keeps the clock running.
    tr.engage(7, 'Unknown Thing', 1);
    expect(tr.checkHp(() => true, SETTINGS)).toMatch(/set aside/);
  });

  it('clear() forgets everything (death)', () => {
    const { tr } = tracker();
    tr.invalid(8, 'Rat', SETTINGS);
    tr.clear();
    expect(tr.excluded(8)).toBe(false);
  });
});

describe('the combat-mode gate (VTank CombatModeGate; DropToPeaceModeRetryCount)', () => {
  it('reads the server\'s stance as a mode: peace, magic, missile stances, melee stances', () => {
    expect(modeOfStance(0x8000003d)).toBe('peace');
    expect(modeOfStance(0x80000049)).toBe('magic');
    for (const s of [0x8000003f, 0x80000041, 0x80000047, 0x8000013b, 0x800000e8]) expect(modeOfStance(s)).toBe('missile');
    for (const s of [0x8000003c, 0x8000003e, 0x80000040, 0x80000044, 0x80000046]) expect(modeOfStance(s)).toBe('melee');
    expect(modeOfStance(0x80000048)).toBeNull(); // Graze: not a combat mode
  });

  it('a change waits for the server\'s stance; without one, VTank\'s 0.6 s window; never past the cap', () => {
    let t = 0;
    const g = new ModeGate(() => t);
    g.request('magic', 'peace', 34);
    expect(g.unconfirmed('magic', 'peace')).toBe('magic');
    t = 400;
    expect(g.unconfirmed('magic', 'peace')).toBe('magic');
    expect(g.unconfirmed('magic', 'magic')).toBeNull();
    // A host that can't say: the window.
    g.request('melee', 'magic', 34);
    t = 400 + MODE_CONFIRM_MS - 1;
    expect(g.unconfirmed('melee', undefined)).toBe('melee');
    t = 400 + MODE_CONFIRM_MS;
    expect(g.unconfirmed('melee', undefined)).toBeNull();
    // The server never says: the cap.
    g.request('missile', 'melee', 34);
    t += MODE_CONFIRM_MAX_MS;
    expect(g.unconfirmed('missile', 'melee')).toBeNull();
    // The client gave it up (the server refused: ACE sends NonCombat): nothing to wait for.
    g.request('magic', 'peace', 34);
    expect(g.unconfirmed('peace', 'peace')).toBeNull();
  });

  it('drops to peace that don\'t take: the DropToPeaceModeRetryCount-th asks for the bugged-state fix; reaching peace resets', () => {
    const g = new ModeGate(() => 0);
    expect(g.request('peace', 'melee', 3)).toBe(false);
    expect(g.request('peace', 'melee', 3)).toBe(false);
    g.unconfirmed('peace', undefined); // made it to peace
    expect(g.request('peace', 'melee', 3)).toBe(false);
    expect(g.request('peace', 'melee', 3)).toBe(false);
    expect(g.request('peace', 'melee', 3)).toBe(true);
    expect(g.request('peace', 'melee', 3)).toBe(false); // starts over
    expect(BUGGED_COMBAT_STATE).toBe('Warning: Macro detected bugged combat state. Attempting to wield an item to clear it.');
  });
});

describe('the options the engine now honours', () => {
  it('blacklist, ghost, range fudge, peace retry and random helper options are engine options with VTank\'s defaults', () => {
    const d = vtDefaults();
    for (const n of ['DeleteGhostMonsters', 'GhostMonsterSpellAttemptCount', 'BlacklistMonsterAttemptCount', 'BlacklistMonsterTimeoutSeconds', 'DeleteGhostMonstersByHPTracker', 'GhostDeleteHPTrackerSeconds', 'SpellRangeFudge', 'DropToPeaceModeRetryCount', 'RandomHelperBuffs', 'RandomHelperIntervalSeconds']) {
      expect(vtOption(n)?.engine, n).toBe(true);
    }
    expect([d.BlacklistMonsterAttemptCount, d.BlacklistMonsterTimeoutSeconds, d.GhostMonsterSpellAttemptCount, d.GhostDeleteHPTrackerSeconds, d.SpellRangeFudge, d.DropToPeaceModeRetryCount]).toEqual([4, 120, 200, 30, 1, 34]);
    // DoJiggle exploited a retail client quirk (selection cycling after a cast); WhoYouGonnaCall VTank never reads.
    expect(vtOption('DoJiggle')?.engine).toBeUndefined();
    expect(vtOption('WhoYouGonnaCall')?.engine).toBeUndefined();
  });
});
