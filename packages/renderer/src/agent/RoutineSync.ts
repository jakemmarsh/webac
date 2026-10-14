/**
 * AGENT.routine-store-auth — the page loads and saves its account's
 * automation routines through the bridge it plays on. The bridge grants a
 * token only after the game server has logged this session in as the
 * account (services/ws-tcp-bridge/src/routines.ts), so the page never names
 * the account itself: the token decides whose routines these are.
 */
import type { RoutinesGrant } from '@ac/network';
import { emptyRoutineDoc, upgradeStoredLootRules, validateRoutineDoc, type RoutineDoc } from '@ac/shared';

/** Browser storage for a bridge that keeps no routines: one document per server + account, in this browser only. */
export interface RoutineLocalStore { getItem(key: string): string | null; setItem(key: string, value: string): void }
export const localRoutinesKey = (server: string, account: string): string => `acjs.routines.v1.${server.toLowerCase()}.${account.toLowerCase()}`;

/** ws(s)://host:port/path?q → http(s)://host:port/routines. */
export function routinesHttpUrl(bridgeWsUrl: string): string {
  const u = new URL(bridgeWsUrl);
  u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
  u.pathname = '/routines';
  u.search = '';
  u.hash = '';
  return u.toString();
}

export interface RoutineSyncConnection {
  readonly bridgeUrl: string;
  requestRoutinesGrant(): void;
}

export type RoutineSyncResult =
  | { ok: true; doc: unknown; account: string; server: string }
  | { ok: false; message: string; issues?: Array<{ path: string; message: string }> };

/** check(): the stored document is still the one stamped `since`, or the newer one, or why it couldn't tell. */
export type RoutineCheckResult = { ok: true; unchanged: true } | RoutineSyncResult;

const GRANT_WAIT_MS = 5000;

export class RoutineSync {
  private grant: RoutinesGrant | null = null;
  private waiters: Array<(g: { grant: RoutinesGrant | null; reason: string | null }) => void> = [];
  /** Told of every document this page stores (the VirindiTank window, Claude through the connector). */
  private storedListeners: Array<(doc: RoutineDoc) => void> = [];

  constructor(
    private readonly connection: () => RoutineSyncConnection | null,
    private readonly fetchFn: typeof fetch = (...a) => fetch(...a),
    private readonly storage: () => RoutineLocalStore | null = () => { try { return globalThis.localStorage ?? null; } catch { return null; } },
  ) {}

  /** The bridge keeps none: load / save in this browser (validated as the bridge would). */
  private localCall(grant: RoutinesGrant, method: 'GET' | 'PUT', body?: unknown, since?: string): RoutineCheckResult {
    const store = this.storage();
    if (!store) return { ok: false, message: 'this browser blocks storage, so routines can\'t be kept' };
    const key = localRoutinesKey(grant.server, grant.account);
    const who = { account: grant.account, server: grant.server };
    try {
      if (method === 'GET') {
        const raw = store.getItem(key);
        const doc = raw ? JSON.parse(raw) as RoutineDoc : emptyRoutineDoc(grant.server, grant.account);
        if (since !== undefined && raw && doc.updatedAt === since) return { ok: true, unchanged: true };
        return { ok: true, doc, ...who };
      }
      const issues = validateRoutineDoc(body);
      if (issues.length) return { ok: false, message: 'not saved: the routine has problems', issues };
      const d = body as RoutineDoc;
      if (d.account.toLowerCase() !== grant.account.toLowerCase() || d.server.toLowerCase() !== grant.server.toLowerCase()) {
        return { ok: false, message: `not saved: the document is for ${d.server}/${d.account}` };
      }
      const stored: RoutineDoc = { ...d, updatedAt: new Date().toISOString() };
      store.setItem(key, JSON.stringify(stored));
      return { ok: true, doc: stored, ...who };
    } catch (e) {
      return { ok: false, message: `browser storage failed: ${(e as Error).message}` };
    }
  }

  /** Feed the connection's 'routinesGrant' events here. */
  onGrant(grant: RoutinesGrant | null, reason?: string): void {
    this.grant = grant;
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f({ grant, reason: reason ?? null });
  }

  /** A new session (relog, other account): the old token is not ours any more. */
  reset(): void { this.grant = null; }

  private requestGrant(): Promise<{ grant: RoutinesGrant | null; reason: string | null }> {
    const conn = this.connection();
    if (!conn) return Promise.resolve({ grant: null, reason: 'not connected' });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== done);
        resolve({ grant: null, reason: 'the bridge did not answer (an older bridge without /routines?)' });
      }, GRANT_WAIT_MS);
      const done = (g: { grant: RoutinesGrant | null; reason: string | null }) => { clearTimeout(timer); resolve(g); };
      this.waiters.push(done);
      conn.requestRoutinesGrant();
    });
  }

  private async call(method: 'GET' | 'PUT', body?: unknown, since?: string): Promise<RoutineCheckResult> {
    const conn = this.connection();
    if (!conn) return { ok: false, message: 'not connected' };
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.grant) {
        const g = await this.requestGrant();
        if (!g.grant) return { ok: false, message: `no routines token: ${g.reason ?? 'refused'}` };
      }
      const grant = this.grant!;
      if (grant.local) return this.localCall(grant, method, body, since);
      let res: Response;
      // ?since=<updatedAt>: a bridge that has the same document answers {unchanged: true} instead of sending it again
      // (a query, not If-None-Match: an older bridge's CORS allows no such header, and it just ignores the query).
      const url = routinesHttpUrl(conn.bridgeUrl) + (since !== undefined ? `?since=${encodeURIComponent(since)}` : '');
      try {
        res = await this.fetchFn(url, {
          method,
          headers: { authorization: `Bearer ${grant.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
      } catch (e) {
        return { ok: false, message: `bridge unreachable: ${(e as Error).message}` };
      }
      if (res.status === 401 && attempt === 0) { this.grant = null; continue; } // expired: ask again once
      const json = await res.json().catch(() => null) as { error?: string; unchanged?: boolean; updatedAt?: string; issues?: Array<{ path: string; message: string }> } | null;
      if (res.ok && since !== undefined && json?.unchanged === true) return { ok: true, unchanged: true };
      if (res.ok) return { ok: true, doc: json, account: grant.account, server: grant.server };
      if (res.status === 422 && json?.issues) return { ok: false, message: 'not saved: the routine has problems', issues: json.issues };
      return { ok: false, message: json?.error ?? `bridge answered ${res.status}` };
    }
    return { ok: false, message: 'the bridge refused the token' };
  }

  /** The account's routine document (an empty one when none is stored). */
  async load(): Promise<RoutineSyncResult> {
    const r = await this.call('GET') as RoutineSyncResult;
    if (r.ok) upgradeStoredLootRules(r.doc); // rules stored by an older importer (vtank.ts)
    return r;
  }

  /**
   * The stored document only if it changed since the one stamped `since` (its updatedAt): another tab or
   * device, or `ac_routines set` writing the bridge's files directly. A bridge with the same document answers
   * {unchanged} with no body to speak of; an older bridge sends the whole document (the caller compares).
   */
  async check(since: string): Promise<RoutineCheckResult> {
    const r = await this.call('GET', undefined, since);
    if (r.ok && !('unchanged' in r)) upgradeStoredLootRules(r.doc);
    return r;
  }

  /** Validate and store the account's routine document on the bridge. Listeners hear of what was stored. */
  async save(doc: unknown): Promise<RoutineSyncResult> {
    const r = await this.call('PUT', doc) as RoutineSyncResult;
    if (r.ok && r.doc && typeof r.doc === 'object') for (const f of [...this.storedListeners]) { try { f(r.doc as RoutineDoc); } catch { /* a listener's fault stays its own */ } }
    return r;
  }

  /** Hear of every document this page stores (whoever saved it: the window, or Claude through the connector). */
  onStored(f: (doc: RoutineDoc) => void): () => void {
    this.storedListeners.push(f);
    return () => { this.storedListeners = this.storedListeners.filter((x) => x !== f); };
  }
}
