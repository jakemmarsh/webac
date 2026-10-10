/**
 * BUG.corpse-cache-stale-char-switch — the /corpse cache must not survive a
 * character switch on the same account.
 *
 * ACE anchoring: Creature_Death.cs:556-562 sends
 * GameMessagePrivateUpdatePosition(player, PositionType.LastOutsideDeath,
 * corpse.Location) only to the dying player's own session, only on that
 * player's own outdoor death — there is no other ACE.Server call site for
 * this position type, so the server never re-sends or clears it for a
 * later login/enter-world.
 *
 * Pre-fix, main.ts's module-scoped `lastOutsideDeathPos` variable was set
 * only additively (onPrivateUpdatePosition's POSTYPE_LAST_OUTSIDE_DEATH
 * case) and never cleared on logoff/character-logoff/disconnect, so
 * switching to a different character on the same account (no page reload)
 * inherited the previous character's cached death location and /corpse
 * reported stale coordinates instead of "You don't have a recent outdoor
 * death."
 *
 * Drives the real LastOutsideDeathState class main.ts's teardownWorldState()
 * now calls `.clear()` on at every logoff/character-logoff/disconnect
 * boundary (packages/renderer/src/main.ts).
 */
import { describe, it, expect } from 'vitest';
import { LastOutsideDeathState } from '../packages/renderer/src/session/LastOutsideDeathState.js';

describe('LastOutsideDeathState', () => {
  it('get() is null before any death is cached', () => {
    const s = new LastOutsideDeathState();
    expect(s.get()).toBeNull();
  });

  it('set() then get() returns the cached position', () => {
    const s = new LastOutsideDeathState();
    s.set({ worldX: 100, worldZ: 200 });
    expect(s.get()).toEqual({ worldX: 100, worldZ: 200 });
  });

  it('clear() empties the cache — teardownWorldState boundary', () => {
    const s = new LastOutsideDeathState();
    s.set({ worldX: 100, worldZ: 200 });
    s.clear();
    expect(s.get()).toBeNull();
  });

  it('character switch simulation: a re-entered character with no death of its own starts clean', () => {
    // Character A dies outdoors; the position is cached.
    const s = new LastOutsideDeathState();
    s.set({ worldX: 100, worldZ: 200 });
    expect(s.get()).not.toBeNull();

    // Logoff -> character select -> enter Character B (no page reload).
    // teardownWorldState() runs; ACE never sends a LastOutsideDeath update
    // for B since B hasn't died outdoors.
    s.clear();

    // B never died outdoors; /corpse must not report A's stale location.
    expect(s.get()).toBeNull();
  });

  it("character switch simulation: the new character's own death overwrites after clear", () => {
    const s = new LastOutsideDeathState();
    s.set({ worldX: 100, worldZ: 200 }); // Character A's death.
    s.clear(); // teardownWorldState on switch.
    s.set({ worldX: 300, worldZ: 400 }); // Character B's own outdoor death.
    expect(s.get()).toEqual({ worldX: 300, worldZ: 400 });
  });
});
