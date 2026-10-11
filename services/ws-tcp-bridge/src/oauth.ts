/**
 * AGENT.hosted-mcp-connector, step 3 — pairing a Claude client with a game
 * account, as standard MCP authorization (docs/hosted-agent-connector.md §2):
 * the bridge is both the protected resource (/mcp) and the authorization
 * server. Nothing here sees a game password: the person approving proves they
 * hold a logged-in session by typing a one-time pairing code into the game,
 * whose tab sends it up its own WebSocket ({"pair":"ABC123"}).
 *
 * - RFC 9728 / 8414 metadata, RFC 7591 registration (and an https client_id
 *   as a Client ID Metadata Document), authorize with PKCE S256 and the
 *   RFC 8707 resource, token (authorization_code, rotating refresh_token),
 *   RFC 7009 revoke.
 * - Redirect URIs: claude.ai / claude.com's callback, or loopback (Claude Code).
 * - **Nothing is stored.** Registered client ids, access tokens and refresh
 *   tokens are sealed (AES-256-GCM) with BRIDGE_MCP_SECRET, so they survive
 *   restarts and the 6-hour deploy drain, when two bridges serve at once
 *   (Railway can't overlap deploys of a service with a volume). Without the
 *   secret a random one is drawn per process: pairings end with it.
 * - **Revocation.** /oauth/revoke and the game's /automation unpair revoke in
 *   memory. The tab also remembers when it unpaired and reports it in its
 *   relay state (`revokedBefore`), and /mcp refuses grants created before
 *   then (mcpHttp.ts). Claude only plays through the tab, so an unpair holds
 *   across restarts for every tab that unpaired.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** A pairing: who may play which account (sealed into its tokens; never stored). */
export interface Grant {
  grantId: string;
  clientId: string;
  clientName: string;
  /** The relay's account keys (server:account): one per tab paired with this code (multiboxing). */
  keys: string[];
  characterScope: 'any' | string[];
  createdAt: number;
}
interface Client { clientId: string; clientName: string; redirectUris: string[] }
interface PendingAuth {
  reqId: string; code: string; clientId: string; clientName: string; redirectUri: string; challenge: string; state: string;
  expiresAt: number;
  /** Each tab that typed the code: its account key and the character it had in the world. */
  paired: Array<{ key: string; character: string | null }>;
}
interface IssuedCode { code: string; reqId: string; clientId: string; redirectUri: string; challenge: string; keys: string[]; scope: 'any' | string[]; expiresAt: number }
/** Sealed tokens carry `k` as one key (tokens issued before multiboxing) or a list. */
const keysOf = (k: string | string[]): string[] => (Array.isArray(k) ? k : [k]);
/** At most this many accounts on one connection. */
export const MAX_LINKED_ACCOUNTS = 8;

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const b64url = (b: Buffer): string => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const token = (bytes = 32): string => b64url(randomBytes(bytes));
/** Pairing codes: 6 characters with no look-alikes (no 0/O, 1/I/L). */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const pairCode = (): string => Array.from(randomBytes(6), (b) => ALPHABET[b % ALPHABET.length]).join('');
const ACCESS_MS = 3_600_000;
const REFRESH_MS = 30 * 24 * 3_600_000;
const PAIR_MS = 10 * 60_000;
const CODE_MS = 60_000;

/** Redirect URIs a client may use (exact for Claude's, loopback any port for Claude Code). */
export function redirectAllowed(uri: string): boolean {
  if (uri === 'https://claude.ai/api/mcp/auth_callback' || uri === 'https://claude.com/api/mcp/auth_callback') return true;
  try {
    const u = new URL(uri);
    return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && !u.username && !u.password;
  } catch { return false; }
}

/** PKCE S256: base64url(sha256(verifier)) === challenge. */
export function pkceOk(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  return b64url(createHash('sha256').update(verifier).digest()) === challenge;
}

/** AES-256-GCM sealing of small JSON payloads under one secret (`v1.<iv>.<ciphertext+tag>`, base64url). */
export class Sealer {
  private readonly key: Buffer;
  constructor(secret: string | Buffer) { this.key = createHash('sha256').update(secret).digest(); }
  seal(prefix: string, payload: unknown): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(prefix));
    const body = Buffer.concat([c.update(JSON.stringify(payload), 'utf8'), c.final(), c.getAuthTag()]);
    return `${prefix}.${b64url(iv)}.${b64url(body)}`;
  }
  open<T>(prefix: string, tok: string): T | null {
    const parts = tok.split('.');
    if (parts.length !== 3 || parts[0] !== prefix) return null;
    try {
      const iv = Buffer.from(parts[1], 'base64url');
      const body = Buffer.from(parts[2], 'base64url');
      if (iv.length !== 12 || body.length < 17) return null;
      const d = createDecipheriv('aes-256-gcm', this.key, iv);
      d.setAAD(Buffer.from(prefix));
      d.setAuthTag(body.subarray(body.length - 16));
      return JSON.parse(Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()]).toString('utf8')) as T;
    } catch { return null; }
  }
}

export interface OAuthOptions {
  /** The bridge's public origin (https://bridge.example), for metadata and the resource check. */
  issuer: string;
  /** Accounts allowed to pair ("server:account", "*:account", "account"); empty: any. */
  allow: string[];
  now?: () => number;
  /** BRIDGE_MCP_SECRET: seals client ids and tokens (≥ 32 characters). Absent: a random secret for this process. */
  secret?: string | null;
  /** Fetches a Client ID Metadata Document (an https client_id). */
  fetchJson?: (url: string) => Promise<unknown>;
}

export class OAuthServer {
  private pending = new Map<string, PendingAuth>();
  private codes = new Map<string, IssuedCode>();
  private readonly sealer: Sealer;
  /** Revoked grants and per-account unpair times (this process; the tab keeps its own, see the header). */
  private revoked = new Set<string>();
  private revokedBefore = new Map<string, number>();
  /** Refresh tokens already exchanged (single use within this process; a reuse revokes the grant). */
  private usedRefresh = new Map<string, number>();
  private readonly now: () => number;
  /** The secret was configured (pairings survive restarts). */
  readonly persistent: boolean;

  constructor(private readonly opts: OAuthOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.persistent = !!opts.secret && opts.secret.length >= 32;
    this.sealer = new Sealer(this.persistent ? opts.secret! : randomBytes(32));
  }

  get resource(): string { return `${this.opts.issuer}/mcp`; }

  private allowed(key: string): boolean {
    if (!this.opts.allow.length) return true;
    const [server, account] = [key.slice(0, key.lastIndexOf(':')), key.slice(key.lastIndexOf(':') + 1)];
    return this.opts.allow.some((a) => { const i = a.lastIndexOf(':'); const s = i < 0 ? '*' : a.slice(0, i); const acc = (i < 0 ? a : a.slice(i + 1)).toLowerCase(); return acc === account && (s === '*' || s === server); });
  }

  protectedResourceMetadata(): unknown { return { resource: this.resource, authorization_servers: [this.opts.issuer], bearer_methods_supported: ['header'] }; }
  authServerMetadata(): unknown {
    const i = this.opts.issuer;
    return {
      issuer: i, authorization_endpoint: `${i}/oauth/authorize`, token_endpoint: `${i}/oauth/token`, registration_endpoint: `${i}/oauth/register`, revocation_endpoint: `${i}/oauth/revoke`,
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'], client_id_metadata_document_supported: true,
    };
  }

  register(body: { redirect_uris?: unknown; client_name?: unknown }): { status: number; body: unknown } {
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === 'string') : [];
    if (!uris.length || !uris.every(redirectAllowed)) return { status: 400, body: { error: 'invalid_redirect_uri' } };
    const clientName = typeof body.client_name === 'string' ? body.client_name.slice(0, 80) : 'Claude';
    // Stateless registration: the client id carries its own name and redirect URIs.
    const c: Client = { clientId: this.sealer.seal('c1', { n: clientName, u: uris }), clientName, redirectUris: uris };
    return { status: 201, body: { client_id: c.clientId, client_name: c.clientName, redirect_uris: uris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] } };
  }

  private async clientFor(id: string): Promise<Client | null> {
    const sealed = this.sealer.open<{ n: string; u: string[] }>('c1', id);
    if (sealed) return { clientId: id, clientName: sealed.n, redirectUris: sealed.u.filter(redirectAllowed) };
    if (!/^https:\/\//.test(id) || !this.opts.fetchJson) return null;
    try {
      const doc = await this.opts.fetchJson(id) as { client_id?: string; client_name?: string; redirect_uris?: string[] };
      if (doc?.client_id !== id || !Array.isArray(doc.redirect_uris)) return null;
      return { clientId: id, clientName: String(doc.client_name ?? new URL(id).hostname).slice(0, 80), redirectUris: doc.redirect_uris.filter(redirectAllowed) };
    } catch { return null; }
  }

  /** GET /oauth/authorize: a pending pairing, or why not. */
  async authorize(q: URLSearchParams): Promise<{ ok: true; pending: PendingAuth } | { ok: false; error: string }> {
    if (q.get('response_type') !== 'code') return { ok: false, error: 'response_type must be code' };
    if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) return { ok: false, error: 'PKCE S256 is required' };
    const resource = q.get('resource');
    if (resource && resource !== this.resource) return { ok: false, error: 'unknown resource' };
    const client = await this.clientFor(q.get('client_id') ?? '');
    if (!client) return { ok: false, error: 'unknown client' };
    const redirectUri = q.get('redirect_uri') ?? '';
    if (!redirectAllowed(redirectUri) || !client.redirectUris.includes(redirectUri)) return { ok: false, error: 'redirect_uri is not registered for this client' };
    for (const [id, p] of this.pending) if (p.expiresAt < this.now()) this.pending.delete(id);
    const pending: PendingAuth = { reqId: token(16), code: pairCode(), clientId: client.clientId, clientName: client.clientName, redirectUri, challenge: q.get('code_challenge')!, state: q.get('state') ?? '', expiresAt: this.now() + PAIR_MS, paired: [] };
    this.pending.set(pending.reqId, pending);
    return { ok: true, pending };
  }

  /**
   * The tab typed a pairing code: add its account (and character in the world) to the waiting request.
   * The same code typed in several tabs, each logged in on its own account, gives one connection that
   * plays all of them (multiboxing); every tool then takes `account=` to pick the tab.
   */
  pair(code: string, key: string, character: string | null): { ok: boolean; message: string } {
    const c = code.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    const p = [...this.pending.values()].find((x) => x.code === c && x.expiresAt >= this.now());
    if (!p) return { ok: false, message: 'that pairing code is not waiting (codes last 10 minutes)' };
    if (!this.allowed(key)) return { ok: false, message: 'Claude is not open to this account yet' };
    const had = p.paired.find((x) => x.key === key);
    if (had) { had.character = character; return { ok: true, message: `is already paired with this code (${p.clientName}): approve it on the page that showed the code` }; }
    if (p.paired.length >= MAX_LINKED_ACCOUNTS) return { ok: false, message: `one connection plays at most ${MAX_LINKED_ACCOUNTS} accounts` };
    p.paired.push({ key, character });
    const n = p.paired.length;
    return { ok: true, message: `is paired (${p.clientName})${n > 1 ? `, ${n} accounts on this code` : ''}: approve it on the page that showed the code` };
  }

  status(reqId: string): { state: 'waiting' | 'paired' | 'expired'; account?: string; character?: string | null; accounts?: Array<{ account: string; character: string | null }>; client?: string; code?: string } {
    const p = this.pending.get(reqId);
    if (!p || p.expiresAt < this.now()) return { state: 'expired' };
    // The connect page (playwebac.com/?connect=<req>) shows the code; the request id is the secret that reads it.
    if (!p.paired.length) return { state: 'waiting', client: p.clientName, code: p.code };
    // Still showing the code: another tab can type it to add its account before the player approves.
    const accounts = p.paired.map((x) => ({ account: x.key, character: x.character }));
    return { state: 'paired', account: accounts[0].account, character: accounts[0].character, accounts, client: p.clientName, code: p.code };
  }

  /** Approve or deny: approve gives the redirect with a code. */
  decide(reqId: string, approve: boolean, onlyCharacter: boolean): { ok: boolean; redirect?: string; error?: string } {
    const p = this.pending.get(reqId);
    if (!p || p.expiresAt < this.now() || !p.paired.length) return { ok: false, error: 'this pairing has expired; start again from Claude' };
    this.pending.delete(reqId);
    const u = new URL(p.redirectUri);
    if (p.state) u.searchParams.set('state', p.state);
    if (!approve) { u.searchParams.set('error', 'access_denied'); return { ok: true, redirect: u.toString() }; }
    const code = token(24);
    // "Only these characters": the ones each paired tab had in the world.
    const chars = p.paired.map((x) => x.character).filter((x): x is string => !!x);
    this.codes.set(code, { code, reqId, clientId: p.clientId, redirectUri: p.redirectUri, challenge: p.challenge, keys: p.paired.map((x) => x.key), scope: onlyCharacter && chars.length ? chars : 'any', expiresAt: this.now() + CODE_MS });
    u.searchParams.set('code', code);
    return { ok: true, redirect: u.toString() };
  }

  private issue(g: Grant): { access_token: string; token_type: 'Bearer'; expires_in: number; refresh_token: string } {
    const t = this.now();
    const access = this.sealer.seal('a1', { g: g.grantId, k: g.keys, s: g.characterScope, t: g.createdAt, e: t + ACCESS_MS });
    const refresh = this.sealer.seal('r1', { g: g.grantId, c: g.clientId, n: g.clientName, k: g.keys, s: g.characterScope, t: g.createdAt, i: t });
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_MS / 1000, refresh_token: refresh };
  }

  /** The grant's accounts still live: not revoked, not unpaired in the game since, still allowed. Empty: the grant is over. */
  private liveKeys(g: { g: string; k: string | string[]; t: number }): string[] {
    if (this.revoked.has(g.g)) return [];
    return keysOf(g.k).filter((k) => g.t >= (this.revokedBefore.get(k) ?? -Infinity) && this.allowed(k));
  }

  /** POST /oauth/token (form or JSON). */
  async tokenRequest(f: Record<string, string>): Promise<{ status: number; body: unknown }> {
    const bad = (error: string, status = 400) => ({ status, body: { error } });
    if (f.grant_type === 'authorization_code') {
      const c = this.codes.get(f.code ?? '');
      if (!c) return bad('invalid_grant');
      this.codes.delete(c.code);
      if (c.expiresAt < this.now() || c.clientId !== f.client_id || c.redirectUri !== f.redirect_uri || !pkceOk(f.code_verifier ?? '', c.challenge)) return bad('invalid_grant');
      const client = await this.clientFor(c.clientId);
      const g: Grant = { grantId: token(12), clientId: c.clientId, clientName: client?.clientName ?? 'Claude', keys: c.keys, characterScope: c.scope, createdAt: this.now() };
      return { status: 200, body: this.issue(g) };
    }
    if (f.grant_type === 'refresh_token') {
      const r = this.sealer.open<{ g: string; c: string; n: string; k: string | string[]; s: 'any' | string[]; t: number; i: number }>('r1', f.refresh_token ?? '');
      const keys = r ? this.liveKeys(r) : [];
      if (!r || r.c !== f.client_id || this.now() - r.i > REFRESH_MS || !keys.length) return bad('invalid_grant');
      // Rotating and single use: a refresh token presented twice means it leaked, so the grant ends.
      const h = sha(f.refresh_token);
      if (this.usedRefresh.has(h)) { this.revoked.add(r.g); return bad('invalid_grant'); }
      this.usedRefresh.set(h, r.i + REFRESH_MS);
      if (this.usedRefresh.size > 10_000) for (const [k, exp] of this.usedRefresh) if (exp < this.now()) this.usedRefresh.delete(k);
      // An account unpaired since stays out of the new tokens.
      return { status: 200, body: this.issue({ grantId: r.g, clientId: r.c, clientName: r.n, keys, characterScope: r.s, createdAt: r.t }) };
    }
    return bad('unsupported_grant_type');
  }

  /** POST /oauth/revoke: either token; the grant goes with it. */
  revoke(tok: string): void {
    const g = this.sealer.open<{ g: string }>('a1', tok) ?? this.sealer.open<{ g: string }>('r1', tok);
    if (g) this.revoked.add(g.g);
  }

  /** The player unpaired in the game: every grant for the account made before now ends. */
  revokeAccount(key: string): void {
    this.revokedBefore.set(key, this.now());
  }

  /** An access token's live account keys, character scope and grant time, or null. */
  resolve(tok: string): { keys: string[]; scope: 'any' | string[]; createdAt: number } | null {
    const a = this.sealer.open<{ g: string; k: string | string[]; s: 'any' | string[]; t: number; e: number }>('a1', tok);
    const keys = a && a.e >= this.now() ? this.liveKeys(a) : [];
    if (!a || !keys.length) return null;
    return { keys, scope: a.s, createdAt: a.t };
  }
}
