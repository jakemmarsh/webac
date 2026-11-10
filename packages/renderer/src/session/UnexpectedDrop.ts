/**
 * BUG.link-dead-no-resume — what the page does when its own 40 s link check
 * (CPlayerSystem::UseTime's DISCONNECT_TIME, main.ts link tick) finds the
 * session dead while the connection itself has not closed.
 *
 * The connection's 'disconnected' event already resumes an in-world drop
 * (RetryPolicy.RESUME_DELAYS_MS, the named CLAUDE.md exception). The
 * link check went straight to retail's Disconnected screen and ended the
 * resume, so a drop it caught first never came back (2026-10-16 production:
 * a Snowreap world_left with endCause link_dead, then a page that sat on the
 * Disconnected screen for 21 min). It now ends the world the same way and
 * tries the resume first; the Disconnected screen only when there is nothing
 * to resume (not in the world, a deliberate logout) or the budget is spent.
 *
 * The dead socket is closed by scheduleResume's own disconnect(): that close
 * is deliberate ('local'), so the 'disconnected' event it raises neither
 * reports the drop again nor schedules a second resume, and it never marks a
 * logout (only SessionLifecycle.noteLoggedOut does), so the resume stands.
 */
import type { SessionLifecycle } from './SessionLifecycle.js';

/**
 * BUG.ac1999-relogin-resume-pingpong — the session ended because the server
 * went silent (the connection's own 'server_silent', or the page's 40 s link
 * check, 'link_dead'), on a server that ends a session silently when its
 * account logs in elsewhere (EraProfile.reloginKillsSilently): the drop may be
 * the account taken over, so a session a resume brought back is not resumed
 * again soon after (SessionLifecycle.nextResumeDelay `silentRelogin`).
 * Everything else keeps the usual resume: a socket close (a bridge drain's hard
 * cut, 1006, a network outage), our own stalled thread ('client_suspended'),
 * a server's own Disconnect or NetError, and every era whose server refuses in
 * words.
 */
export function silentReloginDrop(endCause: string | null | undefined, era: { reloginKillsSilently?: boolean }): boolean {
  return era.reloginKillsSilently === true && (endCause === 'server_silent' || endCause === 'link_dead');
}

export interface UnexpectedDropHost {
  lifecycle: SessionLifecycle;
  /** world_left with the drop's cause and diagnostics (WorldReporter.left: once per world session). */
  reportLeft(): void;
  /** Tear the world down: world state, the link tick, the connection indicator. */
  teardownWorld(): void;
  /**
   * The next resume attempt (main.ts scheduleResume: closes what is left of
   * the connection, shows the connecting screen, reconnects after the delay);
   * false when the lifecycle has nothing to resume or the budget is spent.
   */
  scheduleResume(): boolean;
  /** Retail's Disconnected screen (main.ts raiseServerDied). */
  raiseServerDied(): void;
  /**
   * UX.charselect-resume — not in the world and no resume under way: arm the
   * pre-world resume this drop gets (armDropResume), true when one was armed.
   */
  armPreworldResume?(): boolean;
}

/** End a session found dead by the page: resume it from the world when possible, else the Disconnected screen. */
export function handleUnexpectedDrop(host: UnexpectedDropHost): 'resuming' | 'server_died' {
  const { lifecycle } = host;
  if (lifecycle.inWorld || lifecycle.resumingAfterDrop || host.armPreworldResume?.() === true) {
    host.reportLeft();
    lifecycle.noteDisconnected();
    host.teardownWorld();
    if (host.scheduleResume()) return 'resuming';
  }
  host.raiseServerDied();
  return 'server_died';
}

/**
 * UX.charselect-resume — which automatic resume a session's end gets:
 *  - 'world': in the world, or a resume already under way (its next attempt);
 *  - 'chargen': a drop in chargen, its draft kept (UX.chargen-resume);
 *  - 'enter': a drop while character select's Entering World waited for the
 *    server: the resume enters the character the player chose (the world resume);
 *  - 'charselect': a drop at character select: the resume lands back there,
 *    the list and the selection kept, nothing entered;
 *  - null: nothing to resume (our own close, or a screen with no proven
 *    session: the connecting screen before the list, a drop while logging out
 *    of the world, the launcher, the Disconnected screen). The caller shows
 *    the Disconnected screen for an unexpected end, as before.
 *
 * Retail had no reconnect: every drop showed the Disconnected screen. The
 * in-world, chargen and char-select resumes are named browser-UX exceptions
 * (CLAUDE.md). A deliberate exit (Exit, a logout, leaving for the launcher)
 * and every server refusal close the session from our side first
 * (main.ts endRefusedSession / leaveForLauncher), so their end is not
 * `unexpected` (SessionLiveness.sessionDropped) and nothing is armed.
 */
export type DropResumeKind = 'world' | 'chargen' | 'enter' | 'charselect';

export interface DropResumeState {
  /** The session ended under the player (SessionLiveness.sessionDropped). */
  unexpected: boolean;
  /** In the world at the drop (SessionLifecycle.inWorld, read before noteDisconnected). */
  wasInWorld: boolean;
  /** An enter-world request was waiting at the drop (SessionLifecycle.enterWorldPending, read before noteDisconnected). */
  enterPending: boolean;
  /** The pre-world screen at the drop (PreworldReporter.preworldScreenFor). */
  screen: string;
  /** Chargen is the screen: keep its draft and arm the chargen resume (main.ts keepChargenDraft); false otherwise. */
  keepChargenDraft(): boolean;
  /** The character selected at character select (GameUI.charSelectSelectionId). */
  selection?(): string | undefined;
}

export function armDropResume(lifecycle: SessionLifecycle, s: DropResumeState): DropResumeKind | null {
  if (!s.unexpected) return null;
  if (s.wasInWorld || lifecycle.resumingAfterDrop) return 'world';
  if (s.keepChargenDraft()) return 'chargen';
  // The player chose a character and the server had not answered: the world resume enters it
  // (noteEnterWorldRequested left it the last-entered character, and no logout intent).
  if (s.enterPending && lifecycle.lastEnteredCharacterGuid !== null) return 'enter';
  if (s.screen === 'char-select') {
    lifecycle.beginCharSelectResume(s.selection?.());
    return 'charselect';
  }
  return null;
}

/**
 * Refusals that end an automatic resume at once instead of spending its next
 * attempt: a server that does not take this client's version will not take
 * it 5 or 10 s later (the Disconnected screen says to reload). Every other
 * failed attempt (no socket, a timeout, "Client logon failed", the account
 * still logged on) can clear and is retried on RESUME_DELAYS_MS.
 */
export const RESUME_FINAL_REFUSAL_TOKENS: ReadonlySet<string> = new Set(['ID_ConnectionError_NetVersionMismatch']);

/** A resume attempt failed with `token` (the ConnectionNotice token): stop resuming. */
export function resumeAttemptRefusalIsFinal(token: string | null | undefined): boolean {
  return !!token && RESUME_FINAL_REFUSAL_TOKENS.has(token);
}
