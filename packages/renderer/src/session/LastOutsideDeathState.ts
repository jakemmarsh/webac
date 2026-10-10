/**
 * LastOutsideDeathState — client-side cache of PositionType.LastOutsideDeath
 * (=14), read by the /corpse and /cor commands. (ASSESS: extracted from
 * main.ts's closure-scoped `lastOutsideDeathPos` variable so the per-
 * character-lifetime clear behavior is importable + unit-testable.)
 *
 * ACE server behavior this models:
 *   • LastOutsideDeath is a per-player server property — Creature_Death.cs:
 *     556-562 sends GameMessagePrivateUpdatePosition(player,
 *     PositionType.LastOutsideDeath, corpse.Location) only to the dying
 *     player's own session, only on that player's own outdoor death. No
 *     other ACE.Server call site sends this position type, so the server
 *     never re-sends or clears it for a later login/enter-world.
 *   • BUG.corpse-cache-stale-char-switch — pre-fix, main.ts's module-level
 *     `lastOutsideDeathPos` was set only on that live event and never
 *     cleared on logoff/character-logoff/disconnect, so switching to a
 *     different character on the same account (no page reload) inherited
 *     the previous character's cached death location and /corpse reported
 *     stale coordinates instead of "You don't have a recent outdoor death."
 *     teardownWorldState() must clear() this on every logoff/character-
 *     logoff/disconnect boundary so a re-entered character starts clean.
 */

export interface WorldCoord {
  worldX: number;
  worldZ: number;
  /** The position's objcell id (PlayerDesc InqPosition(0xe)); @corpse prints from it. */
  cellId?: number;
}

export class LastOutsideDeathState {
  private pos: WorldCoord | null = null;

  get(): WorldCoord | null {
    return this.pos;
  }

  set(pos: WorldCoord): void {
    this.pos = pos;
  }

  /** Drop the cached death location — called on logoff/character-logoff/
   *  disconnect so a different character never inherits a prior
   *  character's cached outdoor death position. */
  clear(): void {
    this.pos = null;
  }
}
