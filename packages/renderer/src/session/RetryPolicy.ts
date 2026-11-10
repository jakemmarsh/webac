/**
 * Every reconnect and login-retry schedule of the page, in one place. docs/reconnect.md maps the
 * paths they belong to (trigger, schedule, exit, telemetry); a new retry fits one of those paths or
 * replaces one, never a parallel mechanism.
 *
 * Each constant's first line says: what triggers it, what it waits for, when it gives up, and what
 * the player sees then. The history behind each value follows it. The network package keeps the
 * schedules that live inside a connection (it cannot import the renderer); they are re-exported at
 * the end with the same kind of note.
 *
 * All of these are departures from retail, named browser-UX exceptions in CLAUDE.md: retail had no
 * reconnect and no login retry.
 */
import { ClientConnection, WS_OPEN_TIMEOUT_MS } from '@ac/network';

// ── Resume after an unexpected drop (world, entering, chargen, character select) ──
// SessionLifecycle.nextResumeDelay decides each attempt; ResumeRunner runs it.

/**
 * Drop in the world / chargen / character select → waits these before attempts 1-3 (start of each
 * attempt from the drop or the last failure) → after the third fails, the Disconnected screen.
 *
 * The first stays 2 s for every kind of drop. When the socket closes (or the page closes a silent
 * one), the bridge sends the server its Disconnect, and ACE keeps the session 2 s after it
 * (Session.Terminate: SessionTerminationDetails.TerminationEndTicks). A login inside that window is
 * refused with CharacterError.Logon and re-arms the window (the refusal terminates the old session
 * again: AuthenticationHandler.cs), so an earlier attempt makes an ACE resume slower, not faster.
 * GDLE and the AC1999 server free the account at the Disconnect, but the character stays in their
 * world 5 s (CPlayerWeenie::BeginLogout, Player.cpp), which the 0x0D retries below cover.
 * docs/bridge-handover.md has the timings.
 */
export const RESUME_DELAYS_MS: readonly number[] = Object.freeze([2000, 5000, 10000]);

/**
 * A resume attempt that found no network (offline, or its socket never opened) → is given back, not
 * counted, for this long from when the resume first met the network out → past it every attempt
 * counts, so a network that never returns ends on the Disconnected screen (~3 min in all).
 *
 * Counted from when the resume first met the network out, not from the drop: a machine that slept
 * through it wakes with the wall clock minutes on and the network still coming up. The prod resumes
 * that failed an attempt (2026-11-03 Android, 2026-11-04 Coldeve) came right after a wake (the
 * page's clock stood still 167 s and 207 s); Wi-Fi rejoins and router restarts take seconds to a
 * minute or two (BUG.resume-hung-socket).
 */
export const RESUME_UNREACHABLE_GRACE_MS = 120_000;

/**
 * A given-back attempt (RESUME_UNREACHABLE_GRACE_MS) → the next one starts at least this long after
 * the last one's start, by how many were given back so far (the last value repeats) → the grace's end.
 *
 * A socket that fails at once with the network out (DNS, ERR_INTERNET_DISCONNECTED,
 * ERR_NETWORK_CHANGED: under half a second on prod 2026-11-08) would otherwise open every 2 s, some
 * 50 sockets in the grace; with these an outage costs about ten opens, and a network that comes back
 * is tried within 15 s. A timed-out open already took 15 s, so it keeps its delay
 * (BUG.resume-outage-fast-fail).
 */
export const RESUME_UNREACHABLE_GAPS_MS: readonly number[] = Object.freeze([2000, 5000, 10000, 15000]);

/**
 * An attempt due while the browser is offline → waits for the window's 'online' event, then this
 * long for DNS and routes to come up behind the interface → bounded by what is left of
 * RESUME_UNREACHABLE_GRACE_MS (then the attempt goes anyway). The connecting screen stays up.
 */
export const RESUME_ONLINE_SETTLE_MS = 1000;

/**
 * A drop within this long of a resume's success → continues that resume's attempt budget instead of
 * a fresh one → a spent budget shows the Disconnected screen (resume_ended loop_chain_spent).
 *
 * Without it a server that takes the login and drops moments later reconnected forever (locally
 * 2026-11-05, a GDL server with the wrong era profile: 13 reconnects in 30 s; BUG.resume-loop-unbounded).
 * Refused sessions drop within ~8 s of the login (30 ms; ACE's boot 2 s after a refusal; the
 * servers' 5-8 s logout clocks). 20 s, not the first cut's 60 s (2026-11-08,
 * BUG.resume-chain-window-blip): its only prod firing was a home-network blip 53 s after a resume.
 */
export const RESUME_HEALTHY_MS = 20_000;

/**
 * Any resume → at most RESUME_PAGE_CAP attempts in any RESUME_PAGE_CAP_WINDOW_MS on the page,
 * whatever the uptime between them → reached, the Disconnected screen (resume_ended loop_page_cap).
 *
 * The backstop for a server that drops each session just past RESUME_HEALTHY_MS (BUG.resume-loop-
 * unbounded). Three full budgets (two until 2026-11-08: prod trace 7fcff3ce1adfaaac, a flaky home
 * connection, used all 6 in ~8 min). Given-back attempts (no network) do not count.
 */
export const RESUME_PAGE_CAP = RESUME_DELAYS_MS.length * 3;
export const RESUME_PAGE_CAP_WINDOW_MS = 10 * 60_000;

/**
 * On a server that ends a session silently when the account logs in elsewhere
 * (EraProfile.reloginKillsSilently: the AC1999 server, Network.cpp AcceptClientLogin →
 * CClient::Kill) → a resumed session that goes silent again within this window gets no new resume
 * → the Disconnected screen (resume_ended silent_again).
 *
 * Proven live 2026-11-08 (local AC1999 server, two browsers): each quiet resume took the account
 * back from the other client, a takeover every ~40 s forever; prod trace 36bd770743abbfc9 is the
 * same against a client outside webAC (BUG.ac1999-relogin-resume-pingpong). 10 min covers the other
 * person logging back in; a false stop costs one Disconnected screen, what retail always showed.
 */
export const RESUME_SILENT_AGAIN_WINDOW_MS = 10 * 60_000;

// ── "Character still in the world" (CharacterError 0x0D) on an enter-world request ──
// SessionLifecycle.characterInWorldRefusal / inWorldRetryDelay decide; main.ts sends the retry.

/**
 * An enter refused with 0x0D → asks again after this wait → after IN_WORLD_RETRY_BUDGET refusals,
 * retail's "character still in the world" dialog at character select.
 */
export const IN_WORLD_RETRY_DELAY_MS = 3000;
/**
 * The 0x0D retry budget: 25 × 3 s = 75 s. The AC1999 server holds a character at most ~22 s after
 * its session ends (BeginLogout: 5 s, +2 s from portal space, +15 s for a PK, then the save;
 * Player.cpp:172-188); measured 2026-10-13, every genuine stale refusal cleared on the first retry.
 */
export const IN_WORLD_RETRY_BUDGET = 25;

/**
 * A 0x0D refusal of a character created on this page within JUST_CREATED_WINDOW_MS → these shorter
 * waits for the first retries → then IN_WORLD_RETRY_DELAY_MS and the same budget and dialog.
 *
 * Retail enters a new character at once (gmCharGenMainUI::RecvNotice_CharGenVerificationResponse
 * @ 004e9030 → CPlayerSystem::LogOnCharacter @ 0055f890 on the next frame). GDLE (and the AC1999
 * server) refuses with 0x0D while the new character's first save is queued
 * (CClientEvents::LoginCharacter, GetNumPendingSaves > 0), a few ms after the create reply; a client
 * ~15 ms from the server lost that race every time (6/6, 2026-10-16), retail included.
 */
export const JUST_CREATED_RETRY_DELAYS_MS: readonly number[] = Object.freeze([500, 1000, 2000, 2000]);
/** A refusal counts as the new-character save race only this soon after the create reply. */
export const JUST_CREATED_WINDOW_MS = 10_000;

/**
 * A 0x0D refusal during a resume, or after the player chose to log out the other tab holding the
 * character → asks every second for the first ten → then IN_WORLD_RETRY_DELAY_MS, same budget.
 *
 * The previous session's character logs out on a known clock: ACE removes it 2 s + its 5.67 s
 * LogOut motion after the Disconnect (Player.LogOut_Final), GDLE and the AC1999 server 5 s after
 * (BeginLogout). A 3 s cadence entered up to 3 s late (prod 2026-10-17: 11 s and 15 s from drop to
 * world on Coldeve); a refusal costs the server one message.
 */
export const RESUME_IN_WORLD_RETRY_DELAYS_MS: readonly number[] = Object.freeze(Array(10).fill(1000) as number[]);

// ── Login refusals ──

/**
 * "Client logon failed" (ID_ConnectionError_ClientLogOnFailed) for a world + account + password
 * that already got in on this page (or a first-time login on a GDL / GDLE world) → logs in again
 * after 3 s, then 6 s, behind the connecting screen → then the error and hint unchanged
 * (ProvenLoginRetry.ts; BUG.gdle-transient-login-failed, UX.gdle-first-login-retry).
 */
export const PROVEN_LOGIN_RETRY_DELAYS_MS: readonly number[] = Object.freeze([3000, 6000]);

/**
 * A lowercased password refused with "Client logon failed" where the typed one had capitals → logs
 * in once more, as typed, after this wait (the refused socket is done; the bridge needs a moment)
 * → refused again, the error shows (LoginCredentialCase.ts, BUG.login-credential-case).
 */
export const CASE_VERBATIM_RETRY_DELAY_MS = 500;

/**
 * A login refused as "account in use" (or unanswered) while another tab of this browser holds the
 * account, and the player chose to log that tab out → fresh logins after each repeat of the refusal,
 * these waits (23 s in all) → spent, the refusal's dialog (LoginHolder.ts, BUG.second-tab-login-refusal).
 * That tab's Disconnect goes out at once; GDLE frees the account when it drops that client.
 */
export const LOGIN_HOLDER_RETRY_DELAYS_MS: readonly number[] = Object.freeze([1000, 2000, 2000, 3000, 3000, 4000, 4000, 4000]);

// ── Deploy handover (DrainHandover.ts, docs/bridge-handover.md) ──

/**
 * A handover attempt that left the session in place → tries again after these waits → spent, the
 * drain's hard cut drops the session and the resume above brings it back.
 */
export const HANDOVER_RETRY_MS: readonly number[] = Object.freeze([5_000, 15_000, 30_000, 60_000, 120_000]);

// ── Launcher world list (LauncherScreen.ts, BUG.world-list-unreachable) ──

/**
 * The world list failed to load → loads again after 2 s and 5 s while the box keeps "Loading
 * worlds…" → the last failure shows plain wording, a Retry link and the CUSTOM pointer (and
 * telemetry). Prod 2026-10-19: a player saw "(Failed to fetch)" from a request that never reached
 * the bridge.
 */
export const WORLD_LIST_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000];
/** While that error shows → the list is loaded again this often in the background → never gives up; a success replaces the error with the list. */
export const WORLD_LIST_BACKGROUND_RETRY_MS = 30_000;

// ── Claude (the connect page and the relay link) ──

/**
 * The connect page's pairing-status call failed to reach the bridge → asks again after this wait →
 * after CONNECT_STATUS_MAX_FAILURES in a row, "can't reach the game server" (ConnectScreen.ts).
 */
export const CONNECT_RETRY_MS = 3000;
export const CONNECT_STATUS_MAX_FAILURES = 5;

/**
 * The game's bridge is draining and the second WebSocket that carries Claude's relay (the relay
 * link) is down or never opened → opens it again after these waits (the last repeats) → stops only
 * when the game session ends; its own reconnect lands on a live bridge (agent/relayLink.ts).
 */
export const RELINK_DELAYS_MS: readonly number[] = [2_000, 5_000, 10_000, 30_000];

// ── Inside the connection (@ac/network; re-exported here so this file lists every schedule) ──

/**
 * A session socket still CONNECTING after this → given up and reported as a socket that failed to
 * open (CantSocket, `openTimedOut`) → a first login shows retail's dialog; a resume counts it as
 * found no network (WsOpenTimeout.ts, BUG.resume-hung-socket).
 */
export { WS_OPEN_TIMEOUT_MS };

/**
 * ACE's "account in use" (CharacterError.Logon) on a login → the connection itself logs in again
 * after this wait (ACE frees the account 2 s after the refusal) → after MAX_LOGIN_REJECT_RETRIES
 * (≈2 min), retail's account-in-use refusal. The one reconnect the connection makes on its own; Please Wait
 * shows the stale-session status line meanwhile (ClientConnection.scheduleLoginRetryAfterReject).
 */
export const LOGIN_REJECT_RETRY_MS = ClientConnection.LOGIN_REJECT_RETRY_MS;
export const MAX_LOGIN_REJECT_RETRIES = ClientConnection.MAX_LOGIN_REJECT_RETRIES;
