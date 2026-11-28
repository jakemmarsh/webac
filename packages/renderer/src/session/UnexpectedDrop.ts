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
import type { LinkSample } from '@ac/network';
import type { SessionLifecycle } from './SessionLifecycle.js';
import { deadSessionCause, type LinkDeadCause } from './LinkCheck.js';
import { HIDDEN_CLOSE_HOLD_MS, VISIBLE_GOING_AWAY_HOLD_MS, WS_CLOSE_GOING_AWAY } from './RetryPolicy.js';
import { sessionDropped, type SessionEndEvent } from './SessionLiveness.js';

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

/**
 * BUG.sleep-darkwake-resume-loop — the session ended because our own thread
 * stopped ('client_suspended': the machine slept): its resume waits while the
 * tab is hidden (SessionLifecycle.holdWhileHidden, ResumeRunner), so a
 * sleeping laptop's dark wakes don't log the character in unattended. Every
 * other cause resumes as before, hidden or not: a socket close (a network
 * blip, a drain's hard cut), a silent server, the 40 s link check's
 * 'link_dead', a server's Disconnect or NetError. A background or occluded
 * window running automation must come back from those on its own.
 */
export function sleepDrop(endCause: string | null | undefined): boolean {
  return endCause === 'client_suspended';
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
  // BUG.beforeunload-silent-disconnect (sweep) — the 'disconnected' handler runs inside the
  // connection's listener loop, which only console-logs a throw (NetWorkerClient.receive): a
  // draft capture that threw ended the handler before the resume or the Disconnected screen,
  // and the player sat on a dead session with nothing said. A capture that fails keeps no
  // draft; the drop goes on to the next kind (or the Disconnected screen).
  if (attempt(s.keepChargenDraft, false)) return 'chargen';
  // The player chose a character and the server had not answered: the world resume enters it
  // (noteEnterWorldRequested left it the last-entered character, and no logout intent).
  if (s.enterPending && lifecycle.lastEnteredCharacterGuid !== null) return 'enter';
  if (s.screen === 'char-select') {
    lifecycle.beginCharSelectResume(s.selection ? attempt(s.selection, undefined) : undefined);
    return 'charselect';
  }
  return null;
}

function attempt<T>(f: () => T, fallback: T): T {
  try { return f(); } catch (err) {
    console.error('[AC] drop handling: a step threw — going on without it', err);
    return fallback;
  }
}

/**
 * BUG.beforeunload-silent-disconnect — the page closes its session when it is
 * really going away, on `pagehide` (main.ts installUnloadSessionClose). That
 * close is ours (deliberate), so on its own it never resumes. A page the
 * browser keeps in its back/forward cache comes back (`pageshow` with
 * `persisted`) with that session gone, and for the player that is a drop like
 * any other: this turns the close's 'disconnected' event into one, so it goes
 * down path 1 of docs/reconnect.md (armDropResume → scheduleResume /
 * the chargen resume), not a new reconnect.
 *
 * The close's event can arrive at any point: at once (Connection1999 ends
 * in disconnect()), from the socket's close task, or from the network worker,
 * whose reply a frozen page receives only after it is restored. So:
 *  - before `pageshow` (the page may be gone for good) the event is held, and
 *    nothing runs: a real unload reports and schedules nothing;
 *  - `pageshow` runs a held event as a drop;
 *  - an event arriving after `pageshow` is a drop;
 *  - the page's next connect forgets an older close (nothing came of it).
 */
export class PageHideClose {
  private state: 'none' | 'hidden' | 'restored' | 'hiddenDrop' = 'none';
  private held: (() => void) | null = null;
  private holdTimer: unknown = null;
  private heldSince = 0;
  private heldReason = '';

  constructor(
    private readonly env: HiddenCloseEnv = DEFAULT_HIDDEN_CLOSE_ENV,
    private readonly holdMs: number = HIDDEN_CLOSE_HOLD_MS,
    private readonly goingAwayHoldMs: number = VISIBLE_GOING_AWAY_HOLD_MS,
  ) {}

  /** pagehide is closing a live session. Call BEFORE the disconnect: a close can report at once. */
  closing(): void { this.cancelHoldTimer(); this.state = 'hidden'; this.held = null; }

  /**
   * BUG.hidden-tab-close-read-as-drop — pagehide, whether or not a session is
   * live (installUnloadSessionClose `leaving`). A socket close held under the
   * hidden page, or a visible page's 1001 (`ended` with `socketDrop`), was the page going away: it stays
   * held as a pagehide close's end is, so nothing runs unless the page comes
   * back from the back/forward cache (`shown`), where it runs as the drop.
   */
  leaving(): void {
    if (this.state !== 'hiddenDrop') return;
    this.cancelHoldTimer();
    this.state = 'hidden';
    console.log(`[AC] session socket closed${this.heldReason} ${Math.round(this.env.now() - this.heldSince)} ms before pagehide: the page was going, not a drop`);
  }

  /** pageshow: true when the page came back from the back/forward cache. */
  shown(persisted: boolean): void {
    if (!persisted || this.state !== 'hidden') return;
    const run = this.held;
    this.held = null;
    if (run) { this.state = 'none'; run(); } else this.state = 'restored';
  }

  /**
   * The connection's 'disconnected' event: `handle(pageHideDrop)` now, later
   * (held across a pagehide, or under a hidden page), or with `pageHideDrop`
   * true when the close was ours on pagehide and the page has come back.
   *
   * `socketDrop` (BUG.hidden-tab-close-read-as-drop): the session's socket
   * closed under us (endCause 'socket_closed', not our close). While the page
   * is hidden that can be the browser closing the socket of a page it is
   * about to unload (production 2026-11-24, Edge: the bridge saw 1001 "going
   * away", the page 1006, and pagehide came 1.6-2.0 s later), so the end is
   * held for HIDDEN_CLOSE_HOLD_MS. A pagehide inside it wins (`leaving`):
   * nothing resumes and no drop is reported. The page turning visible
   * (`visible`), a send that needs the session (`release`) or the window
   * running out hand it on as the drop it is, so a real network drop on a
   * hidden tab still resumes.
   *
   * BUG.visible-close-1001-read-as-drop — on a VISIBLE page only a close
   * with `closeCode` 1001 ("going away") is held, for
   * VISIBLE_GOING_AWAY_HOLD_MS: Firefox closing a visible tab closes its
   * socket with 1001 about 300 ms before pagehide (production 2026-11-28).
   * Every other code on a visible page (1006: the network) is the drop at
   * once. Our bridge's shutdown also closes with 1001; no pagehide follows,
   * so the window runs out and it resumes as before, that much later.
   */
  ended(handle: (pageHideDrop: boolean) => void, opts: { socketDrop?: boolean; closeCode?: number } = {}): void {
    if (this.state === 'hidden') { this.held = () => handle(true); return; }
    if (this.state === 'none' && opts.socketDrop === true) {
      const hidden = safeHidden(this.env);
      const holdMs = hidden ? this.holdMs : opts.closeCode === WS_CLOSE_GOING_AWAY ? this.goingAwayHoldMs : 0;
      if (holdMs > 0) {
        this.state = 'hiddenDrop';
        this.held = () => handle(false);
        this.heldSince = this.env.now();
        this.heldReason = hidden ? ' under the hidden page' : ` with ${WS_CLOSE_GOING_AWAY} on the visible page`;
        this.holdTimer = this.env.setTimeout(() => { this.holdTimer = null; this.release(); }, holdMs);
        return;
      }
    }
    // A later end while one is held (a stale socket's): ordinary, and the held one keeps its place.
    if (this.state === 'hiddenDrop') { handle(false); return; }
    const drop = this.state === 'restored';
    this.state = 'none';
    handle(drop);
  }

  /**
   * The page is visible again: a socket close held under the hidden page is a drop, now. (A visible
   * page's 1001 hold sees this only if the page went hidden and came back: a drop then too.)
   */
  visible(): void { this.release(); }

  /**
   * Run a held socket close (hidden page, or a visible page's 1001) now; true when one ran. A
   * send that finds the session dead (main.ts endDeadSession) calls it first,
   * so the drop is handled once, with the socket's own cause.
   */
  release(): boolean {
    if (this.state !== 'hiddenDrop') return false;
    this.cancelHoldTimer();
    const run = this.held;
    this.held = null;
    this.state = 'none';
    run?.();
    return run !== null;
  }

  /** A socket close is held (under the hidden page, or a visible page's 1001), not yet handled as a drop. */
  get holdingHiddenDrop(): boolean { return this.state === 'hiddenDrop'; }

  /** The page starts a connect: an earlier pagehide close no longer applies. */
  connectAttempt(): void { this.cancelHoldTimer(); this.state = 'none'; this.held = null; }

  private cancelHoldTimer(): void {
    if (this.holdTimer === null) return;
    this.env.clearTimeout(this.holdTimer);
    this.holdTimer = null;
  }
}

/**
 * The connection's 'disconnected' event -> PageHideClose.ended's options (main.ts): `socketDrop` for a
 * session socket that closed under us (endCause 'socket_closed', not our close), with the socket's
 * close code (ClientConnection.handleSocketEnded and Connection1999.ended both put it on the event)
 * so a visible page holds a 1001 (BUG.visible-close-1001-read-as-drop).
 */
export function pageHideCloseOpts(event: SessionEndEvent & { endCause?: string; closeCode?: number }): { socketDrop: boolean; closeCode?: number } {
  const socketDrop = event.endCause === 'socket_closed' && sessionDropped(event);
  return typeof event.closeCode === 'number' ? { socketDrop, closeCode: event.closeCode } : { socketDrop };
}

/** PageHideClose's view of the page: its visibility, a clock and a timer (tests pass fakes). */
export interface HiddenCloseEnv {
  hidden(): boolean;
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

const DEFAULT_HIDDEN_CLOSE_ENV: HiddenCloseEnv = {
  hidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

function safeHidden(env: HiddenCloseEnv): boolean {
  try { return env.hidden(); } catch { return false; }
}

/**
 * BUG.beforeunload-silent-disconnect (inverse sweep) — a request that needs
 * the live session (chargen FINISH's CharacterCreate, the enter-world request,
 * character delete / restore) went out on a connection that was no longer
 * connected and vanished: the player waited out its timeout (FINISH: 20 s,
 * then the catch-all refusal). The send now finds the session dead first and
 * ends it the way the 40 s link check does (handleUnexpectedDrop: the chargen /
 * enter / char-select resume, else the Disconnected screen). True when the
 * session is live and the send may go.
 *
 * BUG.preworld-link-dead-finish — dead also means an open socket whose server
 * has been silent past DISCONNECT_TIME (LinkCheck.deadSessionCause): ACE had
 * dropped a chargen session whose hidden tab stopped acking, the socket stayed
 * open, and FINISH went into it.
 */
export function sessionLiveForSend(
  connection: { readonly isConnected: boolean; getLinkStatus(): LinkSample },
  endDeadSession: (cause: LinkDeadCause) => void,
): boolean {
  const cause = deadSessionCause(connection);
  if (cause === null) return true;
  endDeadSession(cause);
  return false;
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
