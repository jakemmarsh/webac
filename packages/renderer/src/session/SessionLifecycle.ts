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
 *   • UX.charselect-resume (2026-11-05): the same reconnect for a drop at
 *     character select (or while its Entering World waits), landing back on
 *     character select with the list and the selection; nothing is entered.
 */

/**
 * Delays before each automatic resume attempt; after the last, the Disconnected screen.
 *
 * The first stays 2 s for every kind of drop. When the socket closes (or the
 * page closes a silent one), the bridge sends the server its Disconnect, and
 * ACE keeps the session 2 s after it (Session.Terminate:
 * SessionTerminationDetails.TerminationEndTicks). A login inside that window
 * is refused with CharacterError.Logon and re-arms the window (the refusal
 * terminates the old session again: AuthenticationHandler.cs), so an earlier
 * attempt makes an ACE resume slower, not faster. GDLE and the AC1999 server
 * free the account at the Disconnect, but the character stays in their world
 * 5 s (CPlayerWeenie::BeginLogout, Player.cpp), which the 0x0D retries below
 * cover either way. docs/bridge-handover.md has the timings.
 */
export const RESUME_DELAYS_MS: readonly number[] = Object.freeze([2000, 5000, 10000]);

/**
 * BUG.resume-hung-socket — how long the network being out keeps a resume's
 * attempts from being spent. Within this time from when the resume first met
 * the network out (not from the drop: a machine that slept through it wakes
 * with the wall clock minutes on and the network still coming up), an attempt
 * that failed while the browser was offline (navigator.onLine false) or whose
 * socket never answered at all (its open timed out: WsOpenTimeout.ts) is not
 * counted against RESUME_DELAYS_MS, and an attempt due while offline waits
 * for the browser's 'online' event first (ResumeRunner). Past it, every
 * attempt counts, as before, so a network that never comes back still ends on
 * the Disconnected screen: at most this plus the three attempts (each bounded
 * by the open timeout), about 3 minutes.
 *
 * 2 minutes: the prod resumes that failed an attempt (2026-11-03 Android,
 * 2026-11-04 Coldeve) came right after the machine woke (the page's clock
 * stood still for 167 s and 207 s while wall time ran), with the network
 * still coming up; Wi-Fi rejoins and router restarts take seconds to a
 * minute or two. A player whose network is out longer gets the Disconnected
 * screen and its relaunch.
 */
export const RESUME_UNREACHABLE_GRACE_MS = 120_000;

/**
 * BUG.resume-outage-fast-fail — the least time from one given-back attempt's
 * start to the next one's, by how many attempts this resume has given back so
 * far (the last value repeats). An attempt given back (RESUME_UNREACHABLE_GRACE_MS)
 * used to go again after the same RESUME_DELAYS_MS delay as the one it
 * replaced; with an open timeout (15 s each) that was slow enough, but a socket
 * that fails at once with the network out (DNS, ERR_INTERNET_DISCONNECTED,
 * ERR_NETWORK_CHANGED: under half a second on prod 2026-11-08) would have
 * opened every 2 s, some 50 sockets in the two minutes. With these, an outage
 * costs about ten opens in the grace, and a network that comes back is tried
 * within 15 s. A timed-out open already took 15 s, so it keeps its old delay.
 */
export const RESUME_UNREACHABLE_GAPS_MS: readonly number[] = Object.freeze([2000, 5000, 10000, 15000]);

/**
 * BUG.resume-loop-unbounded — how long a session must stay up after a resume
 * brought it back before its next drop gets a fresh RESUME_DELAYS_MS budget.
 * A drop sooner than this continues the budget the resume left (its next
 * attempt is the next delay; after the third in all, the Disconnected screen).
 *
 * Without it, every resume that succeeded ended the budget, so a server that
 * takes the login and drops the session moments later reconnected forever:
 * locally 2026-11-05, a GDL server reached with the wrong era profile sent the
 * character list and dropped ~30 ms later, 13 reconnects in 30 s, each one a
 * fresh 2 s resume (on a server with per-address connection caps, the AC1999
 * one, that pattern risks the address being banned). Drops that come from the
 * session itself being refused come within seconds of the login (that 30 ms;
 * ACE's account-in-use boot 2 s after the refusal; the servers' own logout
 * clocks of 5-8 s), all well under 20 s after the resume came back.
 *
 * 20 s, not the first cut's 60 s (2026-11-08, BUG.resume-chain-window-blip):
 * in its first 10 days on prod the guard fired once, and that once was a
 * false positive. An end-of-retail player on a flaky home connection dropped
 * at 16:27:55, the resume spent all three attempts (one failed with
 * ID_NetError_CantSocket) and was back in the world at 16:28:16, and the
 * connection dropped again 53 s later, an ordinary blip: the Disconnected
 * screen (resume_ended loop_chain_spent) and a manual login. 20 s keeps over
 * twice the 8 s worst case of a refused session, and a drop past it is a new
 * blip that resumes from the start. A server that drops each session just
 * past 20 s is stopped by RESUME_PAGE_CAP.
 */
export const RESUME_HEALTHY_MS = 20_000;
/**
 * BUG.resume-loop-unbounded — the backstop: at most this many automatic resume
 * attempts in any RESUME_PAGE_CAP_WINDOW_MS on the page, whatever each
 * session's uptime between them (a server that drops every 21 s would
 * otherwise get a fresh budget each time). Three full budgets (two until
 * 2026-11-08): prod trace 7fcff3ce1adfaaac, an end-of-retail player on a
 * flaky home connection, dropped four times in ~8 min (one resume took all
 * three attempts) and had used exactly 6 attempts by 16:35:39, so a 4th blip
 * before 16:37:57 would have ended on the Disconnected screen. A server that
 * drops each session just past RESUME_HEALTHY_MS still stops after 9
 * attempts, about three minutes. Attempts given
 * back while the network is out (RESUME_UNREACHABLE_GRACE_MS) do not count.
 * Reached, the Disconnected screen shows, as when a budget is spent.
 */
export const RESUME_PAGE_CAP = RESUME_DELAYS_MS.length * 3;
export const RESUME_PAGE_CAP_WINDOW_MS = 10 * 60_000;

/**
 * BUG.ac1999-relogin-resume-pingpong — how long a session an automatic resume
 * brought back stays "resumed" for the silent-drop rule (nextResumeDelay's
 * `silentRelogin`): a drop of it to server silence within this window, on a
 * server that ends an account's session without a word when the account logs
 * in from elsewhere (EraProfile.reloginKillsSilently, the AC1999 server:
 * Network.cpp AcceptClientLogin → CClient::Kill), gets no new resume.
 *
 * Proven live 2026-11-08 (local AC1999 server, account lgate99, two
 * browsers): the second login killed the first silently, the first's quiet
 * resume took the account back and killed the second, and so on, a takeover
 * every ~40 s forever. Retail 1999 had no resume: the killed client showed the
 * Disconnected screen. Prod trace 36bd770743abbfc9 is the same against a
 * client outside webAC: the server cut our resumed session 56-58 s after each
 * resume.
 *
 * 10 min: the other side of a takeover is a person at another client (the
 * real 1999 client, another browser) who sees the Disconnected screen there
 * and logs back in, which takes seconds to a few minutes; their next kill of
 * our resumed session falls well inside it, while a silent drop more than
 * 10 min after a resume (a server restart, a hiccup) is a new drop and
 * resumes as before. It matches RESUME_PAGE_CAP_WINDOW_MS. A false stop costs
 * one Disconnected screen and a manual login, what retail always showed.
 */
export const RESUME_SILENT_AGAIN_WINDOW_MS = 10 * 60_000;

/** Why the resume a drop asked for was refused before its budget's own end (BUG.resume-loop-unbounded, BUG.ac1999-relogin-resume-pingpong), for logs and telemetry. */
export type ResumeBound = 'chain' | 'page_cap' | 'silent_again';

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

/**
 * Waits before the first retries when the refused character was created in
 * this session moments ago. Retail enters a new character at once:
 * gmCharGenMainUI::RecvNotice_CharGenVerificationResponse @ 004e9030 sets
 * m_bAwaitingCharSetForLogin, gmCharGenMainUI::Update @ 004e8460 calls
 * CPlayerSystem::LogOnCharacter @ 0055f890 (0xF7C8) on the next frame, and
 * CPlayerSystem::UseTime @ 00563110 sends 0xF657 the frame after ServerReady.
 * Retail has no retry for 0x0D (gmUIFlow::RecvNotice_CharacterError @ 0047a7c0:
 * the char-select dialog). But GDLE (and the AC1999 server, its ancestor)
 * refuses with 0x0D while the new character's first save is still queued
 * (ClientEvents.cpp CClientEvents::LoginCharacter:
 * `g_pDBIO->GetNumPendingSaves(char_weenie_id) > 0`), a few ms after the
 * create reply. A client close to the server (the AWS bridge to OVH Quebec,
 * ~15 ms) lost that race every time (6/6, 2026-10-16), retail included. The
 * save clears in milliseconds, so a just-created character retries sooner
 * than the 3 s stale-session wait; after these, the usual cadence and budget.
 */
export const JUST_CREATED_RETRY_DELAYS_MS: readonly number[] = Object.freeze([500, 1000, 2000, 2000]);
/**
 * Waits before the first "still in the world" retries of an automatic resume.
 * The previous session's character is logging out on a known clock: ACE
 * removes it 2 s + its 5.67 s LogOut motion after the Disconnect
 * (Player.LogOut_Final; the human motion table's NonCombat LogOut link, 170
 * frames at 30 fps), GDLE and the AC1999 server 5 s after it
 * (BeginLogout). A 3 s cadence entered up to 3 s after the character was
 * free (prod 2026-10-17: 11 s and 15 s from drop to world on Coldeve); a
 * refusal costs the server one message, so a resume asks every second
 * through that window, then at the usual cadence.
 */
export const RESUME_IN_WORLD_RETRY_DELAYS_MS: readonly number[] = Object.freeze(Array(10).fill(1000) as number[]);
/** A refusal counts as the new-character save race only this soon after the create reply. */
export const JUST_CREATED_WINDOW_MS = 10_000;

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
  /**
   * BUG.resume-loop-unbounded — the attempts the last successful resume had
   * used, and when it succeeded (noteResumeRestored): a new resume within
   * RESUME_HEALTHY_MS of it continues that budget.
   */
  private restoredAttempts = 0;
  private restoredAt: number | null = null;
  /**
   * BUG.ac1999-relogin-resume-pingpong — when the live session was brought back
   * by an automatic resume (noteResumeRestored); null once a session the player
   * started, a logout or a give-up (endResume) replaced it.
   */
  private resumedSessionAt: number | null = null;
  /** When each automatic attempt of this page was scheduled, for RESUME_PAGE_CAP. */
  private attemptLog: number[] = [];
  private lastBound: ResumeBound | null = null;
  /** When the resume under way first met the network out (noteNetworkOut), for RESUME_UNREACHABLE_GRACE_MS. */
  private networkOutSince: number | null = null;
  /** BUG.resume-outage-fast-fail — attempts this resume gave back, and when the last granted attempt was due. */
  private givenBack = 0;
  private lastAttemptDueAt: number | null = null;
  /** UX.chargen-resume — the drop came in chargen: the resume reopens chargen, not a character. */
  private chargenResume = false;
  /** UX.charselect-resume — the drop came at character select: the resume lands there, nothing entered. */
  private charSelectResume = false;
  /** The character selected at character select when it dropped (CharacterSlot.id), restored on the list. */
  private charSelectSelection: string | undefined = undefined;
  private inWorldRetries = 0;
  /** BUG.second-tab-in-world-refusal — the holder (another tab) was asked to log out: short waits. */
  private holderLeaving = false;
  /** Bumped by every new enter (noteEnterWorldRequested), not by its retries. */
  private enterSerialN = 0;
  private enterInFlight = false;
  private createdGuid: number | null = null;
  private createdAt = 0;
  /** CPlayerSystem::logOnRequestTime: when the last enter-world request went out (ms), null when none is waiting. */
  private enterRequestAt: number | null = null;

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
  nextResumeDelay(opts: { unreachable?: boolean; silentRelogin?: boolean; now?: number } = {}): number | null {
    const now = opts.now ?? Date.now();
    const resumable = this.chargenResume || this.charSelectResume || (this.lastEnteredGuid !== null && !this.manualLogout);
    this.lastBound = null;
    // BUG.ac1999-relogin-resume-pingpong — the session a resume brought back went silent again, on a
    // server that ends a session silently when the account logs in elsewhere: that is the account
    // taken over again, not a blip. No new resume (it would take the account back): the Disconnected
    // screen, as retail. Only a new resume (an attempt of one under way goes on).
    if (resumable && !this.resuming && opts.silentRelogin && this.resumedSessionAt !== null
      && now - this.resumedSessionAt < RESUME_SILENT_AGAIN_WINDOW_MS) {
      this.endResume();
      this.lastBound = 'silent_again';
      return null;
    }
    // BUG.resume-loop-unbounded — a new resume soon after the last one succeeded continues its budget.
    if (resumable && !this.resuming) {
      if (this.restoredAt !== null && now - this.restoredAt < RESUME_HEALTHY_MS) {
        this.resumeAttempts = this.restoredAttempts;
        if (this.resumeAttempts >= RESUME_DELAYS_MS.length) this.lastBound = 'chain';
      }
      this.restoredAt = null;
      this.restoredAttempts = 0;
    }
    // BUG.resume-hung-socket — an attempt that failed with the network out (offline, or no answer
    // at all) is given back while the grace lasts: the attempts are for a server that isn't ready yet.
    let gap = 0;
    if (resumable && this.resuming && opts.unreachable && this.resumeAttempts > 0) {
      this.noteNetworkOut(now);
      if (this.unreachableGraceLeftMs(now) > 0) {
        this.resumeAttempts--;
        this.attemptLog.pop();
        // BUG.resume-outage-fast-fail — given-back attempts back off (start to start), so a socket
        // that fails at once doesn't open every 2 s; one that took its open timeout keeps its delay.
        const elapsed = this.lastAttemptDueAt === null ? 0 : Math.max(0, now - this.lastAttemptDueAt);
        gap = RESUME_UNREACHABLE_GAPS_MS[Math.min(this.givenBack, RESUME_UNREACHABLE_GAPS_MS.length - 1)] - elapsed;
        this.givenBack++;
      }
    }
    // BUG.resume-loop-unbounded — the page-wide backstop.
    this.attemptLog = this.attemptLog.filter((t) => now - t < RESUME_PAGE_CAP_WINDOW_MS);
    if (resumable && this.resumeAttempts < RESUME_DELAYS_MS.length && this.attemptLog.length >= RESUME_PAGE_CAP) this.lastBound = 'page_cap';
    if (!resumable || this.resumeAttempts >= RESUME_DELAYS_MS.length || this.lastBound === 'page_cap') {
      const bound = this.lastBound;
      this.endResume();
      this.lastBound = bound;
      return null;
    }
    this.resuming = true;
    this.attemptLog.push(now);
    const delay = Math.max(RESUME_DELAYS_MS[this.resumeAttempts++], gap);
    this.lastAttemptDueAt = now + delay;
    return delay;
  }

  /** BUG.resume-outage-fast-fail — attempts the resume under way gave back while the network was out. */
  get resumeAttemptsGivenBack(): number {
    return this.resuming ? this.givenBack : 0;
  }

  /**
   * BUG.resume-loop-unbounded — why the last nextResumeDelay() refused a resume
   * that had something to resume: 'chain' (the drop came within
   * RESUME_HEALTHY_MS of a resume that had already used the whole budget),
   * 'page_cap' (RESUME_PAGE_CAP attempts in RESUME_PAGE_CAP_WINDOW_MS),
   * 'silent_again' (a session a resume brought back went silent within
   * RESUME_SILENT_AGAIN_WINDOW_MS on a server that kills a session silently on
   * a re-login: BUG.ac1999-relogin-resume-pingpong); null
   * otherwise (an attempt was granted, the budget of the resume under way ran
   * out, or nothing to resume).
   */
  get resumeBound(): ResumeBound | null {
    return this.lastBound;
  }

  /**
   * BUG.resume-loop-unbounded — the resume under way succeeded (back in the
   * world, on character select, or in chargen): it ends, and remembers the
   * attempts it used, so a drop within RESUME_HEALTHY_MS continues that budget
   * instead of starting a new one (see there). The page cap's record stays.
   * Just endResume() when no resume is under way.
   */
  noteResumeRestored(now: number = Date.now()): void {
    if (!this.resuming) {
      this.endResume();
      return;
    }
    const used = this.resumeAttempts;
    this.clearResume();
    this.restoredAttempts = used;
    this.restoredAt = now;
    this.resumedSessionAt = now;
  }

  /** BUG.ac1999-relogin-resume-pingpong — when an automatic resume brought the live session back (null: the player's own). */
  get resumedSessionSince(): number | null {
    return this.resumedSessionAt;
  }

  /**
   * BUG.resume-hung-socket — what is left of RESUME_UNREACHABLE_GRACE_MS for the
   * resume under way (0 when none is, or it is spent): how long an attempt due
   * while offline may wait for the network.
   */
  unreachableGraceLeftMs(now: number = Date.now()): number {
    if (!this.resuming) return 0;
    if (this.networkOutSince === null) return RESUME_UNREACHABLE_GRACE_MS;
    return Math.max(0, RESUME_UNREACHABLE_GRACE_MS - (now - this.networkOutSince));
  }

  /** The resume under way met the network out (an offline wait began, or an attempt found no network): the grace starts, once. */
  noteNetworkOut(now: number = Date.now()): void {
    if (this.resuming && this.networkOutSince === null) this.networkOutSince = now;
  }

  /**
   * Stop resuming for good (logged out, given up, the session closed from our
   * side): the budget, the record of a recent success (noteResumeRestored) and
   * the page cap's record all start afresh, so the player's own next login
   * gets a whole budget. A resume that succeeded ends with noteResumeRestored.
   */
  endResume(): void {
    this.clearResume();
    this.restoredAttempts = 0;
    this.restoredAt = null;
    this.resumedSessionAt = null;
    this.attemptLog = [];
  }

  private clearResume(): void {
    this.resuming = false;
    this.resumeAttempts = 0;
    this.networkOutSince = null;
    this.givenBack = 0;
    this.lastAttemptDueAt = null;
    this.chargenResume = false;
    this.charSelectResume = false;
    this.charSelectSelection = undefined;
  }

  /**
   * UX.chargen-resume — the connection dropped in character creation (a named
   * browser-UX exception, like the in-world resume): the same attempts and
   * delays (nextResumeDelay) reconnect, and the character list reopens chargen
   * from the draft (session/ChargenResume.ts) instead of entering a character.
   * Call before nextResumeDelay. A deliberate logout earlier in the page does
   * not stop it: the player is in chargen, not on their way out.
   */
  beginChargenResume(): void {
    if (!this.resuming) this.chargenResume = true;
  }

  /** The resume under way is a chargen resume (beginChargenResume). */
  get resumingChargen(): boolean {
    return this.resuming && this.chargenResume;
  }

  /**
   * UX.charselect-resume — the connection dropped at character select (a named
   * browser-UX exception, like the in-world and chargen resumes): the same
   * attempts and delays (nextResumeDelay) log in again, and the character list
   * lands on character select with `selectedId` selected; no character is
   * entered (pickAutoEnterSlot returns null), whatever the URL login asks. A
   * deliberate logout earlier in the page does not stop it: the player is at
   * character select, not on their way out. Call before nextResumeDelay.
   */
  beginCharSelectResume(selectedId?: string): void {
    if (this.resuming) return;
    this.charSelectResume = true;
    this.charSelectSelection = selectedId;
  }

  /** The resume under way is a character-select resume (beginCharSelectResume). */
  get resumingCharSelect(): boolean {
    return this.resuming && this.charSelectResume;
  }

  /** The selection a character-select resume restores (undefined when none was selected). */
  get charSelectResumeSelection(): string | undefined {
    return this.charSelectResume ? this.charSelectSelection : undefined;
  }

  /**
   * A character list arrived. A chargen or char-select resume under way is
   * done here (the list is where it lands): it ends as a success
   * (noteResumeRestored), and says which it was and the selection to restore.
   * A world resume goes on (it ends at PlayerCreate, noteWorldEntered).
   */
  takeListResume(now: number = Date.now()): { chargen: boolean; charSelect: boolean; selection: string | undefined } {
    const chargen = this.resumingChargen;
    const charSelect = this.resumingCharSelect;
    const selection = this.charSelectResumeSelection;
    if (chargen || charSelect) this.noteResumeRestored(now);
    return { chargen, charSelect, selection };
  }

  /** The resume under way re-enters a character (an in-world drop, or one while entering): not chargen, not char select. */
  get resumingWorld(): boolean {
    return this.resuming && !this.chargenResume && !this.charSelectResume;
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
    if (guid !== this.createdGuid) this.createdGuid = null;
    this.lastEnteredGuid = guid;
    this.manualLogout = false;
    this.inWorldRetries = 0;
    this.holderLeaving = false;
    this.enterSerialN++;
    this.enterInFlight = true;
  }

  /**
   * The server accepted a new character (CharacterCreateResponse OK) and we
   * are entering with it: its refusals within JUST_CREATED_WINDOW_MS get the
   * short JUST_CREATED_RETRY_DELAYS_MS waits (see there).
   */
  noteCharacterCreated(guid: number, now: number = Date.now()): void {
    this.createdGuid = guid;
    this.createdAt = now;
  }

  /**
   * The wait before the retry that characterInWorldRefusal() just granted:
   * short during an automatic resume (RESUME_IN_WORLD_RETRY_DELAYS_MS) and for
   * the character created moments ago, else IN_WORLD_RETRY_DELAY_MS.
   */
  inWorldRetryDelay(now: number = Date.now()): number {
    const n = this.inWorldRetries - 1;
    if ((this.resuming || this.holderLeaving) && n >= 0 && n < RESUME_IN_WORLD_RETRY_DELAYS_MS.length) return RESUME_IN_WORLD_RETRY_DELAYS_MS[n];
    if (this.createdGuid !== null && this.createdGuid === this.lastEnteredGuid
      && now - this.createdAt <= JUST_CREATED_WINDOW_MS && n >= 0 && n < JUST_CREATED_RETRY_DELAYS_MS.length) {
      return JUST_CREATED_RETRY_DELAYS_MS[n];
    }
    return IN_WORLD_RETRY_DELAY_MS;
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

  /**
   * An enter-world request (0xF7C8) just went out: the first, or a retry
   * after a "still in the world" refusal. CPlayerSystem::LogOnCharacter
   * @ 0055f890 stamps logOnRequestTime with Timer::cur_time on every call.
   */
  noteEnterRequestSent(now: number = Date.now()): void {
    this.enterRequestAt = now;
  }

  /** When the enter-world request now waiting went out, or null (tests / probes). */
  get enterRequestSentAt(): number | null {
    return this.enterRequestAt;
  }

  /**
   * CPlayerSystem::UseTime @ 00563110: `logOnRequestTime != 0 &&
   * REQUEST_TIMEOUT (110 s) <= now - logOnRequestTime` clears the stamp and
   * raises ServerDied. True once when that budget is spent with the enter
   * still unanswered (no PlayerCreate, no refusal): the caller raises the
   * connection-lost path. InitializePlayer @ 00563570 clears the stamp when
   * the player arrives (noteWorldEntered here).
   *
   * Retail never cleared it on a CharacterError, so a refused enter would
   * end the session 110 s later at character select; ours stops the clock
   * at a refusal (noteEnterRefused), the session going on as the refusal's
   * dialog says.
   */
  enterRequestTimedOut(timeoutMs: number, now: number = Date.now()): boolean {
    if (this.enterRequestAt === null || !this.enterInFlight || this.inWorldFlag) return false;
    if (now - this.enterRequestAt < timeoutMs) return false;
    this.enterRequestAt = null;
    this.enterInFlight = false;
    return true;
  }

  /**
   * PlayerCreate arrived — we are in the world. A resume under way succeeded
   * (noteResumeRestored: a drop within RESUME_HEALTHY_MS continues its budget).
   */
  noteWorldEntered(now: number = Date.now()): void {
    this.createdGuid = null;
    this.inWorldFlag = true;
    this.inWorldRetries = 0;
    this.holderLeaving = false;
    this.enterInFlight = false;
    this.enterRequestAt = null;
    if (this.resuming) this.noteResumeRestored(now);
    else this.endResume();
  }

  /** The server refused the enter for good (its dialog is shown): the player may try again. */
  noteEnterRefused(): void {
    this.enterInFlight = false;
    this.enterRequestAt = null;
    this.holderLeaving = false;
  }

  /** Which enter is under way: changes with each new enter request, not with its retries. */
  get enterSerial(): number {
    return this.enterSerialN;
  }

  /** The holder (another tab) was asked to log out for the enter under way (noteHolderLeaving). */
  get waitingOnHolder(): boolean {
    return this.holderLeaving;
  }

  /** "Character still in the world" refusals of the enter under way so far (0 before the first). */
  get inWorldRefusalCount(): number {
    return this.inWorldRetries;
  }

  /**
   * BUG.second-tab-in-world-refusal — the player chose to log out the other
   * tab of this browser that holds this account in the world: the enter goes
   * on with a fresh budget, asking every second while that character logs out
   * (RESUME_IN_WORLD_RETRY_DELAYS_MS, the same clock a resume waits on).
   */
  noteHolderLeaving(): void {
    this.inWorldRetries = 0;
    this.holderLeaving = true;
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
      this.enterRequestAt = null;
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
    this.enterRequestAt = null;
    this.manualLogout = true;
    this.endResume();
  }

  /** Connection dropped — not a deliberate logout, so a subsequent
   *  reconnect should resume the last-entered character. */
  noteDisconnected(): void {
    this.inWorldFlag = false;
    this.enterInFlight = false;
    this.enterRequestAt = null;
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
    // A chargen resume reopens chargen, a char-select resume lands on character select: no character is entered.
    if (this.resuming && (this.chargenResume || this.charSelectResume)) return null;
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
