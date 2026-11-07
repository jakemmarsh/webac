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
 * and never logs in again on its own. The player's own login from the launcher (the Disconnected
 * screen's Quit Game leads there) is the only way back in that tab. A refused
 * login with no live tab behind it (a genuine phantom) keeps its retry: no tab
 * answers, so nothing stands down.
 *
 * The claim goes out once the server let the login in ('handshakeComplete',
 * its ConnectRequest / the AC1999 grant, or a character list) or answered it
 * with ACE's CharacterError.Logon (ACE has then booted the other session
 * already), never when the socket opens: a connection the bridge refused
 * before it reached the server (its per-IP cap) must not displace the tab
 * that is playing.
 *
 * BUG.second-tab-login-refusal — nor a login the server refused with a
 * NetError ('serverReached', then an 'error' carrying `serverNetError`):
 * GDLE's "Player already logged on" (STR_LOGIN_ACCOUNT_ONLINE) leaves the
 * other session in, so the tab holding it must not be logged out unasked
 * (Reefcull 2026-11-04). The refused tab asks instead (session/LoginHolder.ts).
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

/** The fields of a connection event the claim reads (@ac/network ConnectionEvent). */
interface ClaimSourceEvent {
  type: string;
  characterError?: number;
  serverNetError?: unknown;
}

/** ACE's CharacterError.Logon (0x1, @ac/shared): the "account in use" answer that already booted the other session. */
const CHARACTER_ERROR_LOGON = 0x1;

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

/** The server part of an accountSessionKey (everything before the account). */
export function serverOfSessionKey(key: string): string {
  const i = key.lastIndexOf('|');
  return i < 0 ? key : key.slice(0, i);
}

/**
 * BUG.second-tab-in-world-refusal — "is any tab of this browser in the world
 * on this server?", asked after the server refused an enter with "one of your
 * characters is still in the world" (CharacterError 0x0D).
 */
export interface WorldPresenceQuery {
  kind: 'webac-world-query';
  /** serverOfSessionKey of the asking tab's key. */
  server: string;
  tab: string;
  id: string;
  /**
   * BUG.second-tab-login-refusal — set: "who holds exactly this key, in the
   * world or not?" (a login refused as account-in-use). Only a tab holding
   * this key with an open session answers. Older builds ignore the field and
   * answer as to a world query; the asker keeps only same-key answers.
   */
  key?: string;
}

/** A tab in the world on the queried server answers with its key and character. */
export interface WorldPresenceReply {
  kind: 'webac-world-presence';
  /** The query answered. */
  id: string;
  /** The asking tab. */
  to: string;
  tab: string;
  key: string;
  character: string | null;
  /** BUG.second-tab-login-refusal — the answering tab has a character in the world (absent from older builds: in the world). */
  inWorld?: boolean;
}

/**
 * The player chose "log out the other tab and enter here": sent to one tab,
 * under the key both tabs hold (the same server AND account), and acted on
 * only by that tab while it holds that key in the world.
 */
export interface LogoutRequest {
  kind: 'webac-logout-request';
  key: string;
  to: string;
  from: string;
  /**
   * Why: 'enter' (the default: the asking tab's enter was refused; acted on
   * only from the world) or 'login' (BUG.second-tab-login-refusal: its login
   * was refused; acted on at any stage while this tab's session is open).
   */
  reason?: LogoutReason;
}

/**
 * OBS.login-refusal-identity — every tab that hears an account query (a
 * WorldPresenceQuery with `key`) and does not answer it with a presence
 * reply acks it, so the asking tab can say how many tabs were listening and
 * why none held the account: 'none' (it holds no key), 'other_key' (another
 * world or account), 'same_key_closed' (this key, but its session with the
 * server is closed). Older builds send no ack: the count is a lower bound.
 */
export interface QueryAck {
  kind: 'webac-query-ack';
  id: string;
  to: string;
  tab: string;
  state: QueryAckState;
}
export type QueryAckState = 'none' | 'other_key' | 'same_key_closed';

/** What an account query heard (queryAccountHoldersDetailed). */
export interface AccountHolderQuery {
  /** The tabs holding exactly the key with an open session. */
  holders: WorldHolder[];
  /** Every tab that answered: holders + acks (older builds never ack). */
  tabs: number;
  /** Tabs that hold the key but whose session is closed. */
  holdersClosed: number;
  /** False: the page has no BroadcastChannel (nothing was asked). */
  channel: boolean;
}

/** Why another tab asked this one to log out. */
export type LogoutReason = 'enter' | 'login';

/** A tab of this browser in the world on the same server (WorldPresenceReply, read). */
export interface WorldHolder {
  tab: string;
  character: string | null;
  /** It holds the same server + account as the asking tab. */
  sameAccount: boolean;
  /** BUG.second-tab-login-refusal — it has a character in the world (false: at character select or in chargen). */
  inWorld?: boolean;
}

/** How long a world query waits for answers (BroadcastChannel delivery is a task away; a busy tab answers in a frame or two). */
export const WORLD_QUERY_WAIT_MS = 400;

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
  /**
   * BUG.second-tab-in-world-refusal — another tab of this browser, entering
   * the world on the same server and account, asked this tab to log out
   * (its player chose to). The guard has already let the key go.
   */
  onLogoutRequested?: (key: string, reason: LogoutReason) => void;
  /**
   * This tab's character in the world under the key it holds, or null when
   * it is not in the world (main.ts reads SessionLifecycle.inWorld). Without
   * it the tab never counts as in the world.
   */
  worldCharacter?: () => { name: string | null } | null;
  /**
   * BUG.second-tab-login-refusal — this tab's session with the server is
   * open (main.ts reads the connection). A tab left on a Disconnected screen
   * still holds its key but no longer holds the account on the server: it
   * neither answers an account query nor acts on a login's logout request.
   * Without it the session counts as open.
   */
  sessionLive?: () => boolean;
  tabId?: string;
  now?: () => number;
  /** Timers (tests). */
  setTimeout?: (fn: () => void, ms: number) => unknown;
}

export class AccountTabGuard {
  readonly tabId: string;
  private held: { key: string; at: number } | null = null;
  private readonly now: () => number;
  private readonly pending = new Map<string, { server: string; key: string; holders: WorldHolder[]; acks: Map<string, QueryAckState> }>();
  private querySeq = 0;

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

  /** This tab holds a key and its session with the server is open. */
  private get sessionLive(): boolean {
    return this.held !== null && (this.opts.sessionLive?.() ?? true);
  }

  /** This tab holds `heldKey` with a character in the world. */
  get inWorld(): boolean {
    return this.held !== null && this.opts.worldCharacter?.() != null;
  }

  /**
   * BUG.second-tab-in-world-refusal — the tabs of this browser in the world
   * on the server `key` names (any account), answered within `waitMs`. No
   * channel (an old browser): none.
   */
  queryWorldHolders(key: string, waitMs: number = WORLD_QUERY_WAIT_MS): Promise<WorldHolder[]> {
    return this.query(key, false, waitMs).then((r) => r.holders);
  }

  /**
   * BUG.second-tab-login-refusal — the tabs of this browser holding exactly
   * `key` (this server AND account) with an open session, in the world or
   * not, answered within `waitMs`. No channel (an old browser): none.
   */
  async queryAccountHolders(key: string, waitMs: number = WORLD_QUERY_WAIT_MS): Promise<WorldHolder[]> {
    return (await this.queryAccountHoldersDetailed(key, waitMs)).holders;
  }

  /**
   * OBS.login-refusal-identity — queryAccountHolders, with how many tabs
   * answered at all and how many hold the key with a closed session (telemetry).
   */
  async queryAccountHoldersDetailed(key: string, waitMs: number = WORLD_QUERY_WAIT_MS): Promise<AccountHolderQuery> {
    const r = await this.query(key, true, waitMs);
    const holders = r.holders.filter((h) => h.sameAccount);
    let holdersClosed = 0;
    for (const state of r.acks.values()) if (state === 'same_key_closed') holdersClosed++;
    return { holders, tabs: r.holders.length + r.acks.size, holdersClosed, channel: r.channel };
  }

  private query(key: string, anyStage: boolean, waitMs: number): Promise<{ holders: WorldHolder[]; acks: Map<string, QueryAckState>; channel: boolean }> {
    const channel = this.opts.channel;
    if (!channel) return Promise.resolve({ holders: [], acks: new Map(), channel: false });
    const id = `${this.tabId}:${++this.querySeq}`;
    const server = serverOfSessionKey(key);
    const entry = { server, key, holders: [] as WorldHolder[], acks: new Map<string, QueryAckState>() };
    this.pending.set(id, entry);
    const query: WorldPresenceQuery = { kind: 'webac-world-query', server, tab: this.tabId, id, ...(anyStage ? { key } : {}) };
    try { channel.postMessage(query); } catch { this.pending.delete(id); return Promise.resolve({ holders: [], acks: new Map(), channel: false }); }
    const later = this.opts.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    return new Promise((resolve) => {
      later(() => {
        this.pending.delete(id);
        resolve({ holders: entry.holders, acks: entry.acks, channel: true });
      }, waitMs);
    });
  }

  /**
   * Ask the tab `holder` (a sameAccount answer to queryWorldHolders) to log
   * out. Only ever for a holder of this tab's own key: false (nothing sent)
   * for any other account, or when this tab holds no key.
   */
  requestLogout(holder: WorldHolder): boolean {
    if (!holder.sameAccount || !this.held || holder.tab === this.tabId) return false;
    const req: LogoutRequest = { kind: 'webac-logout-request', key: this.held.key, to: holder.tab, from: this.tabId };
    try { this.opts.channel?.postMessage(req); } catch { return false; }
    return true;
  }

  /**
   * BUG.second-tab-login-refusal — ask the tab `holder` (a queryAccountHolders
   * answer) to log out so this tab's refused login can get in, under `key`,
   * the key that login asked for (a refused login holds none: it never
   * claims). Only for a holder of that same key: false (nothing sent) for
   * any other account or world.
   */
  requestLogoutForLogin(holder: WorldHolder, key: string): boolean {
    if (!holder.sameAccount || holder.tab === this.tabId) return false;
    const req: LogoutRequest = { kind: 'webac-logout-request', key, to: holder.tab, from: this.tabId, reason: 'login' };
    try { this.opts.channel?.postMessage(req); } catch { return false; }
    return true;
  }

  /**
   * Claim when a socket's login got in (or ACE refused it with
   * CharacterError.Logon, having booted the other session), under the key the
   * page named when the server first answered; never for a login the server
   * refused with a NetError (BUG.second-tab-login-refusal).
   */
  watch(connection: ClaimSource, key: () => string | null): void {
    let pending: string | null = null;
    connection.on((event) => {
      const e = event as ClaimSourceEvent;
      switch (e.type) {
        case 'serverReached': pending = key(); return;
        case 'handshakeComplete':
        case 'characterList':
          break;
        case 'error':
          if (e.serverNetError) { pending = null; return; }
          if (e.characterError !== CHARACTER_ERROR_LOGON) return;
          break;
        case 'disconnected': pending = null; return;
        default: return;
      }
      const k = pending;
      pending = null;
      if (k) this.claim(k);
    });
  }

  private receive(data: unknown): void {
    const kind = (data as { kind?: unknown } | null)?.kind;
    if (kind === 'webac-world-query') { this.answerWorldQuery(data as WorldPresenceQuery); return; }
    if (kind === 'webac-world-presence') { this.collectWorldPresence(data as WorldPresenceReply); return; }
    if (kind === 'webac-logout-request') { this.receiveLogoutRequest(data as LogoutRequest); return; }
    if (kind === 'webac-query-ack') { this.collectAck(data as QueryAck); return; }
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

  private answerWorldQuery(q: WorldPresenceQuery): void {
    if (typeof q.server !== 'string' || typeof q.tab !== 'string' || typeof q.id !== 'string') return;
    if (q.tab === this.tabId) return;
    if (typeof q.key === 'string') {
      // An account query: a tab that will not answer it with a presence says why (OBS.login-refusal-identity).
      const state: QueryAckState | null = !this.held ? 'none' : q.key !== this.held.key ? 'other_key' : !this.sessionLive ? 'same_key_closed' : null;
      if (state) {
        const ack: QueryAck = { kind: 'webac-query-ack', id: q.id, to: q.tab, tab: this.tabId, state };
        try { this.opts.channel?.postMessage(ack); } catch { /* a closed channel: nothing to answer */ }
        return;
      }
    }
    if (!this.held) return;
    const world = this.opts.worldCharacter?.() ?? null;
    // An account query got here only for the exact key with an open session (above); a world query
    // is answered from the world on the same server.
    if (typeof q.key !== 'string' && (!world || serverOfSessionKey(this.held.key) !== q.server)) return;
    const reply: WorldPresenceReply = {
      kind: 'webac-world-presence', id: q.id, to: q.tab, tab: this.tabId, key: this.held.key,
      character: world?.name ?? null, inWorld: world !== null,
    };
    try { this.opts.channel?.postMessage(reply); } catch { /* a closed channel: nothing to answer */ }
  }

  private collectWorldPresence(r: WorldPresenceReply): void {
    if (r.to !== this.tabId || typeof r.key !== 'string' || typeof r.tab !== 'string') return;
    const entry = this.pending.get(r.id);
    if (!entry || serverOfSessionKey(r.key) !== entry.server) return;
    if (entry.holders.some((h) => h.tab === r.tab)) return;
    entry.holders.push({
      tab: r.tab, character: typeof r.character === 'string' ? r.character : null, sameAccount: r.key === entry.key,
      inWorld: r.inWorld !== false,
    });
  }

  private collectAck(a: QueryAck): void {
    if (a.to !== this.tabId || typeof a.tab !== 'string' || a.tab === this.tabId) return;
    const entry = this.pending.get(a.id);
    if (!entry || entry.holders.some((h) => h.tab === a.tab)) return;
    const state: QueryAckState = a.state === 'other_key' || a.state === 'same_key_closed' ? a.state : 'none';
    entry.acks.set(a.tab, state);
  }

  private receiveLogoutRequest(r: LogoutRequest): void {
    if (r.to !== this.tabId || r.from === this.tabId) return;
    // Only the exact key this tab holds (same server AND account); for an enter only from the
    // world, for a login at any stage while the session is open.
    const reason: LogoutReason = r.reason === 'login' ? 'login' : 'enter';
    if (!this.held || r.key !== this.held.key) return;
    if (reason === 'enter' ? !this.inWorld : !this.sessionLive) return;
    const key = this.held.key;
    this.held = null;
    console.log(`[AC] another tab of this account asked to ${reason === 'login' ? 'log in' : 'enter the world'}: this tab logs out`);
    this.opts.onLogoutRequested?.(key, reason);
  }
}
