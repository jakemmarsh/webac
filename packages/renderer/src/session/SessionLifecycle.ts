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

/** Wait before re-asking to enter after a "character still in the world" refusal (CharacterError 0x0D). */
export const IN_WORLD_RETRY_DELAY_MS = 3000;
/**
 * Retries of that refusal before retail's dialog: 25 × 3 s = 75 s. The AC1999
 * server holds a character for at most about 22 s after its session ends
 * (BeginLogout: 5 s, +2 s from portal space, +15 s for a PK, then the save;
 * Player.cpp:172-188), and a re-login from a new port ends the old session at
 * once (Network.cpp:664-682). Measured on the local server 2026-10-13: every
 * genuine stale refusal cleared on the first retry.
 */
export const IN_WORLD_RETRY_BUDGET = 25;

/** What to do with a "character still in the world" refusal (CharacterError 0x0D). */
export type CharacterInWorldVerdict = 'retry' | 'ignore' | 'dialog';

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
  private inWorldRetries = 0;
  private enterInFlight = false;

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
    this.inWorldRetries = 0;
    this.enterInFlight = true;
  }

  /** An enter-world request is out and neither the world nor a refusal has answered it. */
  get enterWorldPending(): boolean {
    return this.enterInFlight;
  }

  /**
   * Whether a new enter-world request may go out: not while one is under way
   * and not from the world. Retail's EnterGame was refused while its Entering
   * World dialog was up (gmCharacterManagementUI). A second request is
   * answered by the AC1999 server with LoginError(13) once the first has
   * entered (ClientEvents.cpp:209, m_pPlayer set), and that refusal used to
   * start the retry loop below from inside the world (BUG.ac1999-in-world-enter-retry).
   */
  mayRequestEnterWorld(): boolean {
    return !this.inWorldFlag && !this.enterInFlight;
  }

  /** PlayerCreate arrived — we are in the world. */
  noteWorldEntered(): void {
    this.inWorldFlag = true;
    this.inWorldRetries = 0;
    this.enterInFlight = false;
    this.endResume();
  }

  /** The server refused the enter for good (its dialog is shown): the player may try again. */
  noteEnterRefused(): void {
    this.enterInFlight = false;
  }

  /**
   * The server refused an enter-world with "character still in the world"
   * (CharacterError 0x0D).
   *
   * - 'ignore' when we are already in the world or have no enter under way:
   *   the refusal answers a duplicate request (the AC1999 server answers a
   *   second 0xF657 with 13 while the first one's player is in the world,
   *   ClientEvents.cpp:209). Retrying it from the world sent 0xF657 every 3 s
   *   and, once the budget ran out, put retail's "still in the world" dialog
   *   over the world (prod 2026-10-13: a player relogged five times in six
   *   minutes; 159 of 175 refusals in three days of the local server's log
   *   were these).
   * - 'retry' (another IN_WORLD_RETRY_DELAY_MS wait) while the budget lasts:
   *   the previous session's character is still logging out.
   * - 'dialog' once the budget is spent: the AC1999 server answers 13 for
   *   characters it will never admit too (not this account's, pending
   *   deletion, failed to load: ClientEvents.cpp:193-221). The enter is over,
   *   and the player's next try starts a fresh budget.
   */
  characterInWorldRefusal(): CharacterInWorldVerdict {
    if (this.inWorldFlag || !this.enterInFlight) return 'ignore';
    if (this.inWorldRetries >= IN_WORLD_RETRY_BUDGET) {
      this.inWorldRetries = 0;
      this.enterInFlight = false;
      return 'dialog';
    }
    this.inWorldRetries++;
    return 'retry';
  }

  /** A scheduled retry may still go out: the enter is still under way and we are not in the world. */
  mayRetryEnterWorld(): boolean {
    return this.enterInFlight && !this.inWorldFlag;
  }

  /** The player deliberately logged off (or the server logged us off) —
   *  the next CharacterList should stay at character select. */
  noteLoggedOut(): void {
    this.inWorldFlag = false;
    this.enterInFlight = false;
    this.manualLogout = true;
    this.endResume();
  }

  /** Connection dropped — not a deliberate logout, so a subsequent
   *  reconnect should resume the last-entered character. */
  noteDisconnected(): void {
    this.inWorldFlag = false;
    this.enterInFlight = false;
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
