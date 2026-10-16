/**
 * BUG.multi-tab-login-pingpong — one game session per account and server
 * across this browser's tabs.
 *
 * Production, 2026-10-16 (Coldeve, one player): the game open in several tabs
 * on one account. ACE lets one session per account (account_login_boots_in_use:
 * a new login boots the old session AND is refused itself, AuthenticationHandler.cs
 * :182-194), and our client answers that refusal with a timed fresh login
 * (ClientConnection.scheduleLoginRetryAfterReject, meant for our own phantom
 * session left on the server after a drop) and a dropped world with an
 * automatic resume (SessionLifecycle). With the conflicting session being
 * another LIVE tab, every tab's retry or resume booted another tab, round and
 * round, and every tab held a bridge session while it waited: the bridge's
 * per-IP cap (8) filled and the player was locked out.
 *
 * The rule here: the latest login wins. A tab whose login reaches the server
 * claims `server + account` on a BroadcastChannel; any other tab holding the
 * same key stands down: it stops its retries and resumes, closes its socket
 * (freeing the bridge slot and logging its session off at once) and says why,
 * and never logs in again on its own. The player's own click (the Disconnected
 * screen's button, the launcher) is the only way back in that tab. A refused
 * login with no live tab behind it (a genuine phantom) keeps its retry: no tab
 * answers, so nothing stands down.
 *
 * The claim goes out on the first frame from the server ('serverReached'), not
 * when the socket opens: a connection the bridge refused before it reached the
 * server (its per-IP cap) must not displace the tab that is playing.
 */

/** The BroadcastChannel every webAC tab of this origin shares. */
export const SESSION_CHANNEL_NAME = 'webac-session';

/** A claim on the wire. */
export interface AccountTabClaim {
  kind: 'webac-account-claim';
  /** accountSessionKey(server, account). */
  key: string;
  /** The claiming tab. */
  tab: string;
  /** When it claimed (ms since the epoch), for ordering two crossing claims. */
  at: number;
}

/** The slice of BroadcastChannel the guard uses (a fake in tests). */
export interface SessionChannelLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (ev: { data: unknown }) => void): void;
  close?(): void;
}

/** The slice of the session connection the guard watches. */
export interface ClaimSource {
  on(listener: (event: { type: string }) => void): void;
}

/**
 * The key a session is held under: the bridge URL that names the server
 * (multi mode puts the server id in its query; a pinned bridge is one server)
 * and the account, case-folded (servers match account names without case).
 * The page's trace parameter is not part of it.
 */
export function accountSessionKey(connectUrl: string, account: string): string {
  let server = connectUrl;
  try {
    const u = new URL(connectUrl);
    u.searchParams.delete('trace');
    u.searchParams.sort();
    server = `${u.host}${u.pathname}?${u.searchParams.toString()}`;
  } catch { /* not a URL: use it as given */ }
  return `${server}|${account.trim().toLowerCase()}`;
}

function isClaim(v: unknown): v is AccountTabClaim {
  const c = v as Partial<AccountTabClaim> | null;
  return !!c && c.kind === 'webac-account-claim' && typeof c.key === 'string' && typeof c.tab === 'string' && typeof c.at === 'number';
}

/** This page's BroadcastChannel, or null where the browser has none (the guard then does nothing). */
export function openSessionChannel(): SessionChannelLike | null {
  try {
    return typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(SESSION_CHANNEL_NAME) : null;
  } catch {
    return null;
  }
}

function randomTabId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch { /* fall through */ }
  // No randomUUID (an old browser): the page's own clock reading is unique enough between tabs.
  const perf = typeof performance !== 'undefined' ? performance.timeOrigin + performance.now() : 0;
  return `${Date.now().toString(36)}-${Math.round(perf * 1000).toString(36)}`;
}

export interface AccountTabGuardOptions {
  channel: SessionChannelLike | null;
  /** Another tab logged in to the key this tab held: stop retrying, close the session, say why. */
  onStandDown: (key: string) => void;
  tabId?: string;
  now?: () => number;
}

export class AccountTabGuard {
  readonly tabId: string;
  private held: { key: string; at: number } | null = null;
  private readonly now: () => number;

  constructor(private readonly opts: AccountTabGuardOptions) {
    this.tabId = opts.tabId ?? randomTabId();
    this.now = opts.now ?? Date.now;
    opts.channel?.addEventListener('message', (ev) => this.receive(ev.data));
  }

  /** The key this tab holds (null: none, or it stood down). */
  get heldKey(): string | null {
    return this.held?.key ?? null;
  }

  /** This tab's login reached the server under `key`: hold it and tell the other tabs. */
  claim(key: string): void {
    // Strictly increasing per tab, so a re-claim always orders after this tab's last one.
    const at = Math.max(this.now(), (this.held?.at ?? 0) + 1);
    this.held = { key, at };
    const claim: AccountTabClaim = { kind: 'webac-account-claim', key, tab: this.tabId, at };
    try { this.opts.channel?.postMessage(claim); } catch { /* a closed channel: nothing to tell */ }
  }

  /** This tab left the session on purpose (logout, the launcher): later claims are none of its business. */
  release(): void {
    this.held = null;
  }

  /** Claim on each socket's first frame from the server, under the key the page names now. */
  watch(connection: ClaimSource, key: () => string | null): void {
    connection.on((event) => {
      if (event.type !== 'serverReached') return;
      const k = key();
      if (k) this.claim(k);
    });
  }

  private receive(data: unknown): void {
    if (!isClaim(data) || !this.held) return;
    if (data.tab === this.tabId || data.key !== this.held.key) return;
    // Two claims crossed: the later one wins (the tab id breaks a tie), and
    // the earlier tab stands down when the later claim reaches it.
    const theirsIsLater = data.at > this.held.at || (data.at === this.held.at && data.tab > this.tabId);
    if (!theirsIsLater) return;
    const key = this.held.key;
    this.held = null;
    console.log('[AC] another tab logged in to this account: this tab stands down');
    this.opts.onStandDown(key);
  }
}
