/**
 * BUG.squelch-list-stale-char-switch — squelches must not survive a
 * character switch on the same account.
 *
 * ACE anchoring: SquelchManager.cs:283-288 (UpdateSquelchDB) rebuilds
 * `Squelches` fresh from `Player.Character.GetSquelches(...)` per active
 * character, and Player_Networking.cs:116-119 (SendSquelchDB) only ships
 * GameEventSetSquelchDB when SquelchManager.HasSquelches is true for that
 * character — a newly-entered character with zero persisted squelches of
 * its own gets no restore event at all.
 *
 * Pre-fix, main.ts's closure-scoped `squelchedNames` Map was populated only
 * additively (onSetSquelchDB, /squelch add) and never cleared on logoff/
 * character-logoff/disconnect, so switching to a different, previously-
 * unsquelched character on the same account (no page reload) inherited the
 * prior character's squelch entries and silently dropped their chat.
 *
 * Drives the real SquelchState class main.ts's teardownWorldState() now
 * calls `.clear()` on at every logoff/character-logoff/disconnect boundary
 * (packages/renderer/src/main.ts:5005). Callers still pass pre-lowercased
 * keys (same Map<lowercase, originalCase> shape as before — FAITHFUL.498).
 */
import { describe, it, expect } from 'vitest';
import { SquelchState } from '../packages/renderer/src/session/SquelchState.js';

describe('SquelchState', () => {
  it('set/has/values behave like the Map it replaces (FAITHFUL.498 lowercase-key/original-case-value)', () => {
    const s = new SquelchState();
    s.set('bob', 'Bob');
    expect(s.has('bob')).toBe(true);
    expect([...s.values()]).toEqual(['Bob']);
  });

  it('delete drops a single entry', () => {
    const s = new SquelchState();
    s.set('bob', 'Bob');
    s.set('alice', 'Alice');
    s.delete('bob');
    expect(s.has('bob')).toBe(false);
    expect([...s.values()]).toEqual(['Alice']);
  });

  it('clear() empties the state — teardownWorldState boundary', () => {
    const s = new SquelchState();
    s.set('bob', 'Bob');
    s.set('alice', 'Alice');
    s.clear();
    expect([...s.values()]).toEqual([]);
    expect(s.has('bob')).toBe(false);
    expect(s.has('alice')).toBe(false);
  });

  it('character switch simulation: a re-entered character with no persisted squelches of its own starts clean', () => {
    // Character A squelches Bob.
    const s = new SquelchState();
    s.set('bob', 'Bob');
    expect(s.has('bob')).toBe(true);

    // Logoff -> character select -> enter Character B (no page reload).
    // teardownWorldState() runs; ACE sends no SetSquelchDB for B since
    // SquelchManager.HasSquelches is false for B.
    s.clear();

    // B never squelched Bob; the stale entry must not suppress his chat.
    expect(s.has('bob')).toBe(false);
    expect([...s.values()]).toEqual([]);
  });

  it("character switch simulation: the new character's own persisted squelches repopulate after clear", () => {
    const s = new SquelchState();
    s.set('bob', 'Bob'); // Character A's squelch.
    s.clear(); // teardownWorldState on switch.
    s.set('carol', 'Carol'); // onSetSquelchDB restore for Character B.
    expect(s.has('bob')).toBe(false);
    expect(s.has('carol')).toBe(true);
    expect([...s.values()]).toEqual(['Carol']);
  });
});
