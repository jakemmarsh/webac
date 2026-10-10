/**
 * SessionLifecycle — session-loop state for the login → enter-world →
 * logout → character-select → re-enter round trip. (ASSESS: extracted from
 * main.ts so the auto-enter/resume policy is importable + unit-testable;
 * main.ts feeds it lifecycle events and asks it which slot to auto-enter.)
 *
 * ACE server behavior this models:
 *   • After a logoff completes, the server returns the session to
 *     AuthConnected and re-sends CharacterLogOff + a fresh CharacterList
 *     (reference/ACE/Source/ACE.Server/Network/Session.cs:249-279,
 *     SendFinalLogOffMessages). Auto-entering on THAT list would defeat
 *     the logout — the player asked for character select.
 *   • On reconnect the same CharacterList flow replays; resuming the
 *     last-entered character (not characterList[0]) restores the session
 *     the player actually lost.
 *   • Characters pending deletion (CharacterList deleteTime != 0 — ACE
 *     GameMessageCharacterList.cs:28 writes elapsed-seconds-since-delete
 *     for slots inside the char_delete_time restore window) are never
 *     auto-entered; retail greys them out at character select.
 *   • Resume after an unexpected drop in the world (a bridge restart, a
 *     network blip): reconnect and re-enter the same character on its own,
 *     a few attempts with backoff, before retail's Disconnected screen.
 *     Retail had no auto-reconnect; Jake (2026-10-06) wants deploys and
 *     blips not to strand players — a named exception (CLAUDE.md).
 */

/** Delays before each automatic resume attempt; after the last, the Disconnected screen. */
export const RESUME_DELAYS_MS: readonly number[] = Object.freeze([2000, 5000, 10000]);

export interface AutoEnterSlotLike {
  /** Character guid as a decimal string (CharacterSlot.id). */
  id: string;
  /** Non-zero when the character is pending deletion. */
  deleteTime?: number;
}

export class SessionLifecycle {
  private lastEnteredGuid: number | null = null;
  private manualLogout = false;
  private inWorldFlag = false;
  private resumeAttempts = 0;
  private resuming = false;

  /** An automatic resume after an unexpected drop is under way (not yet back in the world). */
  get resumingAfterDrop(): boolean {
    return this.resuming;
  }

  /**
   * The connection dropped in the world (or a resume attempt failed): the
   * delay before the next automatic attempt, or null when there is nothing
   * to resume (no character, a deliberate logout) or the budget is spent —
   * then show the Disconnected screen.
   */
  nextResumeDelay(): number | null {
    if (this.lastEnteredGuid === null || this.manualLogout || this.resumeAttempts >= RESUME_DELAYS_MS.length) {
      this.endResume();
      return null;
    }
    this.resuming = true;
    return RESUME_DELAYS_MS[this.resumeAttempts++];
  }

  /** Stop resuming (back in the world, logged out, or given up). */
  endResume(): void {
    this.resuming = false;
    this.resumeAttempts = 0;
  }

  /** True between PlayerCreate and logout/disconnect. */
  get inWorld(): boolean {
    return this.inWorldFlag;
  }

  /** Guid of the character we last asked to enter the world with. */
  get lastEnteredCharacterGuid(): number | null {
    return this.lastEnteredGuid;
  }

  /** Player picked a character (or auto-enter fired) — remember it for
   *  reconnect resume and clear any prior logout intent. */
  noteEnterWorldRequested(guid: number): void {
    this.lastEnteredGuid = guid;
    this.manualLogout = false;
  }

  /** PlayerCreate arrived — we are in the world. */
  noteWorldEntered(): void {
    this.inWorldFlag = true;
    this.endResume();
  }

  /** The player deliberately logged off (or the server logged us off) —
   *  the next CharacterList should stay at character select. */
  noteLoggedOut(): void {
    this.inWorldFlag = false;
    this.manualLogout = true;
    this.endResume();
  }

  /** Connection dropped — not a deliberate logout, so a subsequent
   *  reconnect should resume the last-entered character. */
  noteDisconnected(): void {
    this.inWorldFlag = false;
  }

  /**
   * Pick the slot to auto-enter when a CharacterList arrives, or null to
   * stay at character select. Resumes the last-entered character when it
   * is present (reconnect), falls back to the first non-pending-deletion
   * slot on a fresh session, and returns null after a deliberate logout.
   */
  pickAutoEnterSlot<T extends AutoEnterSlotLike>(
    slots: readonly T[],
    autoEnterEnabled: boolean,
  ): T | null {
    const enterable = slots.filter(s => (s.deleteTime ?? 0) === 0);
    // Resuming after a drop: only the character that was in the world.
    if (this.resuming) return enterable.find(s => parseInt(s.id, 10) === this.lastEnteredGuid) ?? null;
    if (!autoEnterEnabled) return null;
    if (this.manualLogout) return null;
    if (enterable.length === 0) return null;
    if (this.lastEnteredGuid !== null) {
      const match = enterable.find(s => parseInt(s.id, 10) === this.lastEnteredGuid);
      if (match) return match;
    }
    return enterable[0];
  }
}

/**
 * Map a character guid to its ACE slot index. CharacterDelete's
 * `characterSlot` field indexes session.Characters
 * (reference/ACE/Source/ACE.Server/Network/Handlers/CharacterHandler.cs:297),
 * which is the exact list — same order — that GameMessageCharacterList
 * serialized (Session.cs:272 passes `Characters` straight through), i.e.
 * the order our parseCharacterList preserved. Returns -1 if absent.
 */
export function characterSlotIndex(
  characters: ReadonlyArray<{ id: number }>,
  guid: number,
): number {
  return characters.findIndex(c => c.id === guid);
}

/**
 * True if `targetGuid` is present in `latestCharacters` and not pending
 * deletion. Re-validates a scheduled auto-enter immediately before it
 * fires, guarding the case where a CharacterDelete on the auto-entered
 * slot made ACE send a second, later CharacterList
 * (CharacterHandler.cs:273-328) that retargets a different slot — without
 * this check a stale auto-enter timer could fire for a slot the latest
 * list no longer considers enterable.
 */
export function isAutoEnterTargetStillValid(
  latestCharacters: ReadonlyArray<{ id: number; deleteTime?: number }>,
  targetGuid: number,
): boolean {
  return latestCharacters.some(c => c.id === targetGuid && (c.deleteTime ?? 0) === 0);
}
