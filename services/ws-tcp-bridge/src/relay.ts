/**
 * AGENT.hosted-mcp-connector — the relay between the bridge's /mcp endpoint
 * and the player's own game tab (docs/hosted-agent-connector.md §4). Calls go
 * down the account's existing game WebSocket as JSON text frames (game data
 * stays binary); the tab runs them on its agent API (window.__acAgent) and
 * answers. The bridge is the only party that knows which tab belongs to which
 * account: it read the account from the server's CharacterList (routines.ts).
 *
 *   bridge → tab  {"agent":{"id":17,"method":"observe","args":[{…}],"deadlineMs":30000}}
 *   tab → bridge  {"agentResult":{"id":17,"ok":true,"result":…}} | {"agentResult":{"id":17,"ok":false,"error":"…"}}
 *   tab → bridge  {"agentState":{"relay":"on"|"off","character":"Name"|null,"screen":"world"}}
 *
 * A tab runs relay calls only after it has opted in (relay "on"). No password
 * passes through here: Claude plays the tab the player logged in themselves.
 */

export interface RelayPeer {
  /** The game WebSocket's text send. */
  send(text: string): void;
}

export interface RelayEntry {
  peer: RelayPeer;
  /** server key + account (routinesServer + the CharacterList's account). */
  key: string;
  relayOn: boolean;
  /** The tab's last unpair (ms): grants made before it are refused (oauth.ts header). */
  revokedBefore: number;
  character: string | null;
  screen: string | null;
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>;
  /** Slices of big answers still arriving, by call id. */
  parts: Map<number, { n: number; slices: Array<string | undefined> }>;
  updatedAt: number;
}

export const accountKey = (server: string, account: string): string => `${server}:${account.toLowerCase()}`;

/** A tab's text frame, if it is one of the relay's. */
/** A big answer arrives in slices of its JSON text (relayTab.ts RESULT_PART_CHARS); at most this many. */
export const MAX_RESULT_PARTS = 64;

export function parseRelayFrame(text: string): { kind: 'result'; id: number; ok: boolean; result?: unknown; error?: string } | { kind: 'state'; relay: boolean; character: string | null; screen: string | null; revokedBefore: number } | { kind: 'part'; id: number; i: number; n: number; data: string } | null {
  if (!text.startsWith('{')) return null;
  let o: unknown;
  try { o = JSON.parse(text); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  const part = (o as { agentResultPart?: { id?: unknown; i?: unknown; n?: unknown; data?: unknown } }).agentResultPart;
  if (part) {
    const { id, i, n, data } = part;
    if (typeof id !== 'number' || typeof data !== 'string' || !Number.isInteger(i) || !Number.isInteger(n) || (n as number) < 1 || (n as number) > MAX_RESULT_PARTS || (i as number) < 0 || (i as number) >= (n as number)) return null;
    return { kind: 'part', id, i: i as number, n: n as number, data };
  }
  const r = (o as { agentResult?: { id?: unknown; ok?: unknown; result?: unknown; error?: unknown } }).agentResult;
  if (r && typeof r.id === 'number') return { kind: 'result', id: r.id, ok: r.ok === true, ...(r.ok === true ? { result: r.result } : { error: typeof r.error === 'string' ? r.error : 'the tab refused the call' }) };
  const st = (o as { agentState?: { relay?: unknown; character?: unknown; screen?: unknown; revokedBefore?: unknown } }).agentState;
  if (st) return { kind: 'state', relay: st.relay === 'on', character: typeof st.character === 'string' ? st.character : null, screen: typeof st.screen === 'string' ? st.screen : null, revokedBefore: typeof st.revokedBefore === 'number' && Number.isFinite(st.revokedBefore) ? st.revokedBefore : 0 };
  return null;
}

/** Calls per account (docs/hosted-agent-connector.md §6): a 20-call burst, 10/s sustained, 50,000 a day. */
export const RATE = { burst: 20, perSec: 10, perDay: 50_000 };

export const DISCONNECTED = 'the game disconnected; it reconnects on its own. Call ac_status, then retry';

export class AgentRelay {
  private byKey = new Map<string, RelayEntry>();
  private byPeer = new Map<RelayPeer, RelayEntry>();
  private nextId = 1;
  private buckets = new Map<string, { tokens: number; at: number; day: number; dayCount: number }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** A logged-in session's tab (the latest login of an account replaces the earlier one, as the server does). */
  register(peer: RelayPeer, key: string): RelayEntry {
    const old = this.byKey.get(key);
    if (old && old.peer !== peer) this.remove(old.peer);
    const existing = this.byPeer.get(peer);
    if (existing) { existing.key = key; this.byKey.set(key, existing); return existing; }
    const e: RelayEntry = { peer, key, relayOn: false, revokedBefore: 0, parts: new Map(), character: null, screen: null, pending: new Map(), updatedAt: this.now() };
    this.byKey.set(key, e);
    this.byPeer.set(peer, e);
    return e;
  }

  /** The session closed: its calls fail with the reconnect advice. */
  remove(peer: RelayPeer): void {
    const e = this.byPeer.get(peer);
    if (!e) return;
    this.byPeer.delete(peer);
    if (this.byKey.get(e.key) === e) this.byKey.delete(e.key);
    for (const [, p] of e.pending) { clearTimeout(p.timer); p.reject(new Error(DISCONNECTED)); }
    e.pending.clear();
  }

  /**
   * A text frame from a session; true when it was the relay's. `ownKey` is the account the session is logged
   * in as (or linked for): a state frame from a session the relay has lost (no entry for it, and none for the
   * account) registers it again, so `/automation claude on` (which sends the state) always relinks the tab.
   */
  onText(peer: RelayPeer, text: string, ownKey: string | null = null): boolean {
    const f = parseRelayFrame(text);
    if (!f) return false;
    if (f.kind === 'state' && ownKey && !this.byPeer.has(peer) && !this.byKey.has(ownKey)) this.register(peer, ownKey);
    const e = this.byPeer.get(peer);
    if (!e) return true;
    e.updatedAt = this.now();
    if (f.kind === 'state') { e.relayOn = f.relay; e.character = f.character; e.screen = f.screen; e.revokedBefore = f.revokedBefore; return true; }
    if (f.kind === 'part') {
      // Only for a call still waiting; the slices join back into the agentResult text.
      if (!e.pending.has(f.id)) return true;
      const got = e.parts.get(f.id) ?? { n: f.n, slices: Array.from({ length: f.n }, (): string | undefined => undefined) };
      if (got.n !== f.n) { e.parts.delete(f.id); return true; }
      got.slices[f.i] = f.data;
      e.parts.set(f.id, got);
      if (got.slices.some((x) => x === undefined)) return true;
      e.parts.delete(f.id);
      const whole = parseRelayFrame(got.slices.join(''));
      if (!whole || whole.kind !== 'result' || whole.id !== f.id) return true;
      return this.onResult(e, whole);
    }
    return this.onResult(e, f);
  }

  private onResult(e: RelayEntry, f: { id: number; ok: boolean; result?: unknown; error?: string }): boolean {
    const p = e.pending.get(f.id);
    if (!p) return true;
    e.pending.delete(f.id);
    clearTimeout(p.timer);
    if (f.ok) p.resolve(f.result); else p.reject(new Error(f.error ?? 'the call failed'));
    return true;
  }

  entry(key: string): RelayEntry | undefined { return this.byKey.get(key); }

  /** Whether this session is the one the relay calls for its account. */
  holds(peer: RelayPeer): boolean { return this.byPeer.has(peer); }

  /** Why this account's next call must wait, or null (and the call is counted). */
  overLimit(key: string): string | null {
    const t = this.now();
    const day = Math.floor(t / 86_400_000);
    const b = this.buckets.get(key) ?? { tokens: RATE.burst, at: t, day, dayCount: 0 };
    b.tokens = Math.min(RATE.burst, b.tokens + ((t - b.at) / 1000) * RATE.perSec);
    b.at = t;
    if (b.day !== day) { b.day = day; b.dayCount = 0; }
    this.buckets.set(key, b);
    if (b.dayCount >= RATE.perDay) return `the daily limit of ${RATE.perDay} calls is used up; it resets at 00:00 UTC`;
    if (b.tokens < 1) return `too many calls: wait ${Math.max(0.1, (1 - b.tokens) / RATE.perSec).toFixed(1)} s`;
    b.tokens -= 1;
    b.dayCount += 1;
    return null;
  }

  /** Call the tab's agent API (`method` on window.__acAgent); rejects with why when it can't. */
  call(key: string, method: string, args: unknown[] = [], deadlineMs = 30_000): Promise<unknown> {
    const e = this.byKey.get(key);
    if (!e) return Promise.reject(new Error('your game is not open: log in on playwebac.com in a browser tab, then try again'));
    if (!e.relayOn) return Promise.reject(new Error('Claude is paired but this tab has Claude switched off'));
    const limited = this.overLimit(key);
    if (limited) return Promise.reject(new Error(limited));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      // The tab enforces the deadline on its side too; this one covers a tab that went quiet.
      const timer = setTimeout(() => { e.pending.delete(id); e.parts.delete(id); reject(new Error(`no answer from the game in ${Math.round((deadlineMs + 5000) / 1000)} s`)); }, deadlineMs + 5000);
      e.pending.set(id, { resolve, reject, timer });
      try { e.peer.send(JSON.stringify({ agent: { id, method, args, deadlineMs } })); } catch (err) { clearTimeout(timer); e.pending.delete(id); reject(err as Error); }
    });
  }
}
