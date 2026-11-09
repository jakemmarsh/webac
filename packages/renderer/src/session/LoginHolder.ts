/**
 * BUG.second-tab-login-refusal — a login refused because another tab of this
 * browser holds the account on the server.
 *
 * Production, 2026-11-04 (Reefcull, GDLE, end of retail, one player on Edge):
 * a tab in the world on an account; a second tab logged in to the same world
 * and account. GDLE refused it with the NetError STR_LOGIN_ACCOUNT_ONLINE
 * (ID_ConnectionError_PlayerAlreadyLoggedOn, "Player already logged on") and
 * the player got that text with ACCOUNT_IN_USE_HINT over the launcher; they
 * logged out in the first tab by hand and got in 36 s later.
 *
 * Who refuses a second login, and how (the code each emulator sends):
 *  - GDLE / ClassicDereth (CNetwork::AcceptClientLogin, Network.cpp:540-552):
 *    the NetError STR_LOGIN_ACCOUNT_ONLINE 0x0C559B1E (table 8); the session
 *    already in stays in. This module's case.
 *  - The AC1999 server (Network.cpp:650-680): drops the old session and lets
 *    the new login in (STR_LOGIN_ACCOUNT_ONLINE only on its admin / port
 *    check); handled here too if it is ever sent.
 *  - GDL (Seedsow, Network.cpp:643-652): KickClient on the old one, then lets
 *    the new login in.
 *  - ACE (AuthenticationHandler.cs:182-194, account_login_boots_in_use on by
 *    default): CharacterError.Logon to the new login AND a boot of the old
 *    session; the new login's quiet retry (ClientConnection.
 *    LOGIN_REJECT_RETRY_MS) gets in ~3 s later. With the setting off, the
 *    refusal alone, and the old tab stands down on the new tab's claim
 *    (AccountTabGuard, BUG.multi-tab-login-pingpong). Nothing to ask there.
 *
 * Retail showed the NetError's text and stopped (ClientNet::EndState @
 * 00543380 → PopupError). The browser-UX departure (CLAUDE.md, named
 * exceptions): after the refusal the tab asks this browser's other tabs who
 * holds exactly this world + account (AccountTabGuard.queryAccountHolders),
 *  - a tab: a Yes / No "This account is already logged in in another tab …
 *    Log out that tab and log in here?" over the connecting screen. Yes asks
 *    only that tab to log out (AccountTabGuard.requestLogoutForLogin, under
 *    the exact key), then logs in again on LOGIN_HOLDER_RETRY_DELAYS_MS while
 *    the refusal repeats (the server frees the account once that session's
 *    Disconnect lands), and shows retail's text and hint once they are
 *    spent. No shows retail's text and a line naming that tab;
 *  - no tab (another device or browser, a session the server still holds):
 *    retail's text and hint, unchanged.
 * The silent form (lead's live check 2026-11-04, local GDLE 353cbab5, and the
 * ClassicDereth reference: AcceptClientLogin returns without a reply when
 * the account has a client): the login just goes unanswered and ends in
 * ID_ConnectionError_ClientTimedOutServer. So a login unanswered at its 2nd
 * resend ('loginUnanswered', ClientConnection.LOGIN_UNANSWERED_AFTER_RETRIES;
 * Connection1999 at its first, 6 s) asks the tabs too, on any emulator: a
 * tab holding this key with an open session means the server is up and the
 * account is held, so the same offer applies over the running resends. Yes
 * logs that tab out and logs in afresh (a full 40 s resend budget, which the
 * server answers once that session is gone); No ends the login with the
 * NetError form's No text. No tab: the resends and their 40 s timeout go
 * on unchanged. UX.gdl-silent-login-hint: on a GDL / GDLE world (the ones
 * that ignore such a login, worldDirectory silentAccountOnlineWorld) that
 * timeout's next-step line then names the likely cause, the account logged
 * in from another browser or device (silentUnansweredNoTab); elsewhere a
 * server that is down still reads as down (the timeout dialog).
 * Never during a resume of our own dropped session (SessionLifecycle: that
 * refusal is our own session still logging out), and never without the
 * player's Yes.
 *
 * BUG.held-account-logon-failed — the "Client logon failed" form. Production
 * 2026-11-07 (Seedsow, GDL, Dark Majesty, one player, build 663601f47): a tab
 * in the world from 03:35 to 04:03; from 03:50 the same player's other pages
 * tried about 7 logins to the same account and every one was refused with
 * STR_LOGIN_FAILED 0x04DF9C54 (table 8, ID_ConnectionError_ClientLogOnFailed),
 * so they read the wrong-password text (after our case / first-time quiet
 * retries, ~9 s each) while their own tab held the account. Live Seedsow
 * answers a second login for an account in the world that way (the GDL
 * reference source kicks the old client instead; the live build differs).
 * ClientLogOnFailed is also a plain wrong password, so the tabs decide: on
 * that refusal, before the case retry and the quiet retries, the tab asks who
 * holds exactly this world + account (once a connect cycle, for
 * WORLD_QUERY_WAIT_MS, 400 ms: a wrong password waits that much longer, and
 * the retries it skips when a tab answers would only be refused again, ~9 s
 * of them, before the same wrong-password text);
 *  - a tab with an open session: the same Yes / No offer. Yes logs that tab
 *    out and logs in on LOGIN_HOLDER_RETRY_DELAYS_MS; spent, the refusal goes
 *    the usual way (case retry, quiet retries, retail's text and hint). No:
 *    retail's text and the line naming that tab (not the wrong-password hint);
 *  - no tab: unchanged (main.ts goes on with the case retry, the quiet
 *    retries, retail's text and hint), 400 ms later.
 * Every emulator that sends it (GDL / GDLE / the AC1999 server; ACE never
 * does), every era. Telemetry: login_held 'offer_logon_failed' for the offer,
 * and heldByTab on the login_refused / login_retry that follow.
 */

import type { AccountHolderQuery, WorldHolder } from './AccountTabGuard.js';

/** The login refusals that mean "this account is logged in already" (NetError tokens). */
export const ACCOUNT_IN_USE_LOGIN_TOKENS: ReadonlySet<string> = new Set([
  'ID_ConnectionError_PlayerAlreadyLoggedOn',
]);

/**
 * BUG.held-account-logon-failed — the NetError token that is a wrong password,
 * or (live Seedsow) an account held by another session: asked about only when
 * a tab of this browser could explain it.
 */
export const LOGON_FAILED_LOGIN_TOKEN = 'ID_ConnectionError_ClientLogOnFailed';

/**
 * The fresh logins after the other tab was asked to leave, while the refusal
 * repeats (ms after each refusal; 23 s in all). That tab's Disconnect goes out
 * at once; GDLE frees the account when it drops that client (in the world,
 * after its logout).
 */
export const LOGIN_HOLDER_RETRY_DELAYS_MS: readonly number[] = Object.freeze([1000, 2000, 2000, 3000, 3000, 4000, 4000, 4000]);

function where(holder: WorldHolder): string {
  if (holder.inWorld === false) return 'at character select';
  return holder.character ? `in the world as ${holder.character}` : 'in the world';
}

/** The Yes / No offer when another tab of this browser holds this account. */
export function loginHolderOfferText(holder: WorldHolder): string {
  return `This account is already logged in in another tab of this browser, ${where(holder)}.\n\nLog out that tab and log in here?`;
}

/** The refusal after the player kept the other tab (No): retail's text, then the line naming that tab. */
export function loginHolderKeptText(retailText: string, holder: WorldHolder): string {
  return `${retailText}\n\nThis account is logged in in another tab of this browser, ${where(holder)}: log out there, then log in again.`;
}

/** The line under Please Wait after the other tab was asked to log out. */
export const LOGIN_HOLDER_LEAVING_STATUS = 'Logging out the other tab…';

/** What the tab that was asked to log out shows (its Quit Game goes to the server select, BUG.old-tab-quit-steals-account). */
export const LOGGED_OUT_FOR_LOGIN_TEXT = 'You chose to log in to this account in another tab, so this tab logged out.';

/**
 * What a tab that stood down shows (AccountTabGuard: another tab of this
 * browser logged in to the account it held; on ACE the server booted it
 * too): retail's ID_CHAR_ERROR_LOGON text, then which window took it, in
 * place of ACCOUNT_IN_USE_HINT's "close any other window".
 */
export function stoodDownForOtherTabText(retailText: string): string {
  return `${retailText}\n\nThis account logged in in another tab of this browser.`;
}

/**
 * OBS.login-refusal-identity — what the login_refused / login_retry of an
 * account-in-use or "Client logon failed" refusal carry about the tabs:
 * whether this connect cycle asked them ('ran'), did not ('skipped': a
 * resume of our own session, no account), or could not ('no_channel': no
 * BroadcastChannel), how many held the account (holders), how many answered
 * at all (tabs, a lower bound: older builds never ack) and how many hold it
 * with a closed session (holdersClosed).
 */
export interface LoginHolderTelemetry {
  heldByTab?: boolean;
  holderQuery?: 'ran' | 'skipped' | 'no_channel';
  holders?: number;
  tabs?: number;
  holdersClosed?: number;
}

/** What LoginHolderWait reports (telemetry): what the tabs answered, and how it ended. */
export type LoginHolderReport = 'none' | 'offer-logout' | 'kept' | 'logged-out' | 'spent' | 'silent-none' | 'silent-offer' | 'offer-logon-failed';

export interface LoginHolderWaitDeps {
  /** SessionLifecycle.resumingAfterDrop (or a chargen resume): the refusal is our own session. */
  resuming(): boolean;
  /**
   * AccountTabGuard.queryAccountHoldersDetailed (or queryAccountHolders) for
   * the refused login's key. A bare list counts as a query that ran.
   */
  queryHolders(): Promise<WorldHolder[] | AccountHolderQuery>;
  /** AccountTabGuard.requestLogoutForLogin under the refused login's key. */
  requestLogout(holder: WorldHolder): boolean;
  /** Yes / No over the connecting screen; returns a close for the dialog. */
  confirm(text: string, onAnswer: (yes: boolean) => void): () => void;
  /** Log in again with the same world and credentials. */
  login(): void;
  /** A timer; returns its cancel. */
  schedule(fn: () => void, ms: number): () => void;
  /** The line under Please Wait. */
  setStatus(text: string | null): void;
  /** Show the refusal: null = retail's text and hint as today; a string = that text. */
  refuse(text: string | null): void;
  /** The page still waits on this login (not gone to the launcher or into the game). */
  stillWaiting(): boolean;
  /**
   * BUG.held-account-logon-failed — a "Client logon failed" no tab of this
   * browser explains: go on with it the usual way (the case retry, the quiet
   * retries, retail's text and hint). Absent: refuse(null).
   */
  passOn?(): void;
  report?(kind: LoginHolderReport): void;
}

/**
 * One login's account-in-use refusal: the other tabs asked once, the offer,
 * the bounded logins after Yes. main.ts calls onRefused for each refused
 * login (false: not this module's refusal, handle it as before), end() when
 * the login got in, cancel() when the connect cycle ended another way.
 */
export class LoginHolderWait {
  private retry = -1;
  private cancelTimer: (() => void) | null = null;
  private closeOffer: (() => void) | null = null;
  private serial = 0;
  private asking = false;
  /** This wait's refusal: 'in-use' (PlayerAlreadyLoggedOn, the silent form) or 'logon-failed'. */
  private kind: 'in-use' | 'logon-failed' = 'in-use';
  /** The tabs were asked about a "Client logon failed" this connect cycle (once a cycle). */
  private logonFailedAsked = false;
  private held = false;
  /**
   * UX.gdl-silent-login-hint — this login went unanswered and no tab of this
   * browser holds its account (login_held 'silent_none').
   */
  private silentNone = false;
  /** What this connect cycle's holder query heard (telemetry), null when none ran. */
  private lastQuery: Omit<AccountHolderQuery, 'holders'> & { holders: number } | null = null;

  constructor(private readonly deps: LoginHolderWaitDeps) {}

  /** The other tab was asked to leave and the logins after it run (tests / probes). */
  get retrying(): boolean { return this.retry >= 0; }

  /** The Yes / No is up (tests / probes). */
  get offerOpen(): boolean { return this.closeOffer !== null; }

  /**
   * A tab of this browser answered that it holds this login's account, this
   * connect cycle (telemetry: heldByTab on login_refused / login_retry).
   */
  get heldByTab(): boolean { return this.held; }

  /**
   * UX.gdl-silent-login-hint — this login went unanswered at its 2nd resend
   * and this browser's tabs were asked: none holds the account (the
   * 'silent-none' report). On a server that ignores a login for an account
   * online from another endpoint (launcher/worldDirectory.ts
   * silentAccountOnlineWorld), the timeout that follows most likely means
   * the account is in use in another browser or device (loginFailureText).
   * Cleared by the next unanswered login, cancel() and end().
   */
  get silentUnansweredNoTab(): boolean { return this.silentNone; }

  /**
   * OBS.login-refusal-identity — the tab fields for a login_refused /
   * login_retry refused with `token`: heldByTab always; for an account-in-use
   * or "Client logon failed" token, also what this cycle's holder query heard.
   */
  telemetryFor(token: string | null | undefined): LoginHolderTelemetry {
    const out: LoginHolderTelemetry = { heldByTab: this.held };
    if (token !== LOGON_FAILED_LOGIN_TOKEN && !(token && ACCOUNT_IN_USE_LOGIN_TOKENS.has(token))) return out;
    const q = this.lastQuery;
    if (!q) return { ...out, holderQuery: 'skipped' };
    if (!q.channel) return { ...out, holderQuery: 'no_channel' };
    return { ...out, holderQuery: 'ran', holders: q.holders, tabs: q.tabs, holdersClosed: q.holdersClosed };
  }

  /**
   * A login refused with `token` (a NetError token) whose retail text is
   * `retailText`: true when this module handles it.
   */
  onRefused(token: string | null | undefined, retailText: string): boolean {
    const inUse = !!token && ACCOUNT_IN_USE_LOGIN_TOKENS.has(token);
    const logonFailed = token === LOGON_FAILED_LOGIN_TOKEN;
    if ((!inUse && !logonFailed) || this.deps.resuming()) {
      this.cancel();
      return false;
    }
    // A "Client logon failed" while the logins after an in-use Yes run is not that wait's: the usual way.
    if (this.retrying && this.kind === 'in-use' && logonFailed) {
      this.cancel();
      return false;
    }
    if (this.retrying) {
      const delay = LOGIN_HOLDER_RETRY_DELAYS_MS[this.retry];
      if (delay === undefined) {
        // Spent: the server still holds the account (the other tab's logout, or a session elsewhere).
        this.deps.report?.('spent');
        if (this.kind === 'logon-failed') {
          // The usual way from here (the case retry, the quiet retries, retail's text): this cycle
          // stays asked, and heldByTab stays for its telemetry.
          this.stopRetrying();
          return false;
        }
        // Refused before the cancel, so its telemetry still carries heldByTab.
        this.stopRetrying();
        this.deps.refuse(null);
        this.cancel();
        return true;
      }
      this.retry++;
      this.loginIn(delay);
      return true;
    }
    // Asked already this cycle (the case retry's or a quiet retry's refusal): the usual way.
    if (logonFailed && this.logonFailedAsked) return false;
    this.cancel();
    this.kind = inUse ? 'in-use' : 'logon-failed';
    if (logonFailed) this.logonFailedAsked = true;
    this.ask(retailText);
    return true;
  }

  /**
   * The login under way has gone unanswered a while ('loginUnanswered').
   * `retailText` is the NetError form's text (PlayerAlreadyLoggedOn), for No.
   * Asks once per login; does nothing while resuming, already asking, or
   * logging in again after Yes.
   */
  onUnanswered(retailText: string): void {
    if (this.deps.resuming() || this.retrying || this.asking || this.closeOffer) return;
    this.silentNone = false;
    this.ask(retailText, true);
  }

  /** The login got in: nothing more to wait on. */
  end(): void {
    this.cancel();
  }

  /** The connect cycle ended another way (the launcher, a relaunch, a stand-down). */
  cancel(): void {
    this.stopRetrying();
    this.asking = false;
    this.kind = 'in-use';
    this.logonFailedAsked = false;
    this.held = false;
    this.silentNone = false;
    this.lastQuery = null;
    this.closeOffer?.();
    this.closeOffer = null;
  }

  private stopRetrying(): void {
    this.serial++;
    this.retry = -1;
    this.cancelTimer?.();
    this.cancelTimer = null;
  }

  private ask(retailText: string, silent = false): void {
    const serial = this.serial;
    this.asking = true;
    void this.deps.queryHolders().then((answer) => {
      if (serial !== this.serial) return;
      this.asking = false;
      const holders = Array.isArray(answer) ? answer : answer.holders;
      this.lastQuery = Array.isArray(answer)
        ? { holders: answer.filter((h) => h.sameAccount).length, tabs: answer.length, holdersClosed: 0, channel: true }
        : { holders: answer.holders.length, tabs: answer.tabs, holdersClosed: answer.holdersClosed, channel: answer.channel };
      if (!this.deps.stillWaiting()) return;
      const holder = holders.find((h) => h.sameAccount);
      const logonFailed = this.kind === 'logon-failed';
      if (!holder && logonFailed) {
        // Most often a wrong password: exactly as before (no login_held for it).
        if (this.deps.passOn) this.deps.passOn();
        else this.deps.refuse(null);
        return;
      }
      if (!holder) {
        this.deps.report?.(silent ? 'silent-none' : 'none');
        if (silent) this.silentNone = true;
        // Silent: no tab holds it, so the resends and their timeout go on as before.
        if (!silent) this.deps.refuse(null);
        return;
      }
      this.held = true;
      this.deps.report?.(silent ? 'silent-offer' : logonFailed ? 'offer-logon-failed' : 'offer-logout');
      console.warn(`[AC] "${logonFailed ? 'Client logon failed' : 'Player already logged on'}" — another tab of this browser holds this account (${holder.inWorld === false ? 'character select' : holder.character ?? 'in the world'})`);
      this.closeOffer = this.deps.confirm(loginHolderOfferText(holder), (yes) => {
        this.closeOffer = null;
        if (serial !== this.serial || !this.deps.stillWaiting()) return;
        if (yes && this.deps.requestLogout(holder)) {
          this.deps.report?.('logged-out');
          this.deps.setStatus(LOGIN_HOLDER_LEAVING_STATUS);
          this.retry = 1;
          this.loginIn(LOGIN_HOLDER_RETRY_DELAYS_MS[0]);
          return;
        }
        this.deps.report?.('kept');
        this.deps.refuse(loginHolderKeptText(retailText, holder));
      });
    });
  }

  private loginIn(ms: number): void {
    this.cancelTimer?.();
    const serial = this.serial;
    this.cancelTimer = this.deps.schedule(() => {
      this.cancelTimer = null;
      if (serial !== this.serial || !this.deps.stillWaiting()) return;
      this.deps.login();
    }, ms);
  }
}
