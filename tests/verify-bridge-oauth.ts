/**
 * AGENT.hosted-mcp-connector, step 3 — pairing a Claude client with a game
 * account (services/ws-tcp-bridge/src/oauth.ts, oauthHttp.ts): PKCE, redirect
 * allowlist, registration, the one-time pairing code typed into the game,
 * approval, tokens (rotating refresh), revoke, the account allowlist, a
 * character-scoped grant — and the whole flow through the real bridge, as
 * Claude does it, ending in a tool call that plays the paired tab.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import * as dgram from 'dgram';
import { WebSocket } from 'ws';
import { OAuthServer, Sealer, pairCode, pkceOk, redirectAllowed } from '../services/ws-tcp-bridge/src/oauth';
import { resolveBridgeConfig, type BridgeConfig } from '../services/ws-tcp-bridge/src/bridgeUtil';
import { createBridgeServer, type BridgeServer } from '../services/ws-tcp-bridge/src/server';

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function pkce() { const verifier = b64url(randomBytes(32)); return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) }; }
const CB = 'http://127.0.0.1:33418/callback';

describe('OAuth pieces', () => {
  it('redirects: Claude\'s callbacks and loopback only', () => {
    expect(redirectAllowed('https://claude.ai/api/mcp/auth_callback')).toBe(true);
    expect(redirectAllowed('https://claude.com/api/mcp/auth_callback')).toBe(true);
    expect(redirectAllowed('http://127.0.0.1:5555/cb')).toBe(true);
    expect(redirectAllowed('http://localhost:1/x')).toBe(true);
    expect(redirectAllowed('https://evil.example/cb')).toBe(false);
    expect(redirectAllowed('https://claude.ai/other')).toBe(false);
    expect(redirectAllowed('http://user:pw@127.0.0.1/cb')).toBe(false);
  });

  it('PKCE S256; pairing codes avoid look-alike characters', () => {
    const { verifier, challenge } = pkce();
    expect(pkceOk(verifier, challenge)).toBe(true);
    expect(pkceOk(verifier + 'x', challenge)).toBe(false);
    expect(pkceOk('short', challenge)).toBe(false);
    for (let i = 0; i < 50; i++) expect(pairCode()).toMatch(/^[A-HJ-KM-NP-Z2-9]{6}$/);
  });

  // Test-only secrets, built so the public export's secret scan doesn't take them for pasted credentials.
  const SECRET = 'test-secret-'.padEnd(40, 'a');
  function flow(allow: string[] = [], secret: string | null = SECRET) {
    let t = 1_000_000;
    const clock = { now: () => t };
    const o = new OAuthServer({ issuer: 'https://bridge.test', allow, now: clock.now, secret });
    const reg = o.register({ redirect_uris: [CB], client_name: 'Claude Code' });
    const clientId = (reg.body as { client_id: string }).client_id;
    return { o, clientId, clock, advance: (ms: number) => { t += ms; } };
  }
  /** Authorize → pair → approve → token, as the whole grant does. */
  async function grant(o: OAuthServer, clientId: string, key = 'local-eor:jake', character: string | null = 'Jake') {
    const { verifier, challenge } = pkce();
    const a = await o.authorize(authQ(clientId, challenge));
    if (!a.ok) throw new Error(a.error);
    o.pair(a.pending.code, key, character);
    const code = new URL(o.decide(a.pending.reqId, true, true).redirect!).searchParams.get('code')!;
    return (await o.tokenRequest({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: CB })).body as { access_token: string; refresh_token: string };
  }
  const authQ = (clientId: string, challenge: string, extra: Record<string, string> = {}) => new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: CB, code_challenge: challenge, code_challenge_method: 'S256', state: 's1', resource: 'https://bridge.test/mcp', ...extra });

  it('the whole grant: authorize → pair in the game → approve → token → refresh rotates → revoke', async () => {
    const { o, clientId } = flow();
    const { verifier, challenge } = pkce();
    expect((await o.authorize(authQ(clientId, challenge, { redirect_uri: 'https://evil.example/cb' }))).ok).toBe(false);
    expect((await o.authorize(authQ(clientId, challenge, { code_challenge_method: 'plain' }))).ok).toBe(false);
    const a = await o.authorize(authQ(clientId, challenge));
    if (!a.ok) throw new Error(a.error);
    expect(o.status(a.pending.reqId)).toEqual({ state: 'waiting', client: 'Claude Code', code: a.pending.code });
    expect(o.pair('WRONG1', 'local-eor:jake', 'Jake').ok).toBe(false);
    expect(o.pair(`${a.pending.code.slice(0, 3)}-${a.pending.code.slice(3)}`.toLowerCase(), 'local-eor:jake', 'Jake').ok).toBe(true);
    expect(o.pair(a.pending.code, 'local-eor:other', null).ok).toBe(false); // single use
    expect(o.status(a.pending.reqId)).toEqual({ state: 'paired', account: 'local-eor:jake', character: 'Jake', client: 'Claude Code' });
    const d = o.decide(a.pending.reqId, true, true);
    const redirect = new URL(d.redirect!);
    expect(redirect.searchParams.get('state')).toBe('s1');
    const code = redirect.searchParams.get('code')!;
    expect((await o.tokenRequest({ grant_type: 'authorization_code', code, code_verifier: 'x'.repeat(43), client_id: clientId, redirect_uri: CB })).status).toBe(400);
    // A code is single use, even after a bad verifier.
    const a2 = await o.authorize(authQ(clientId, challenge));
    if (!a2.ok) throw new Error(a2.error);
    o.pair(a2.pending.code, 'local-eor:jake', 'Jake');
    const code2 = new URL(o.decide(a2.pending.reqId, true, true).redirect!).searchParams.get('code')!;
    const tok = await o.tokenRequest({ grant_type: 'authorization_code', code: code2, code_verifier: verifier, client_id: clientId, redirect_uri: CB });
    expect(tok.status).toBe(200);
    const t1 = tok.body as { access_token: string; refresh_token: string };
    expect(o.resolve(t1.access_token)).toEqual({ key: 'local-eor:jake', scope: ['Jake'], createdAt: 1_000_000 });
    const r2 = await o.tokenRequest({ grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: clientId });
    expect(r2.status).toBe(200);
    expect((await o.tokenRequest({ grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: clientId })).status).toBe(400); // rotated
    const t2 = r2.body as { access_token: string };
    o.revoke(t2.access_token);
    expect(o.resolve(t2.access_token)).toBeNull();
    expect(o.resolve(t1.access_token)).toBeNull();
  });

  it('deny redirects with access_denied; codes expire; the account allowlist refuses others', async () => {
    const { o, clientId, advance } = flow(['local-eor:jake']);
    const { challenge } = pkce();
    const a = await o.authorize(authQ(clientId, challenge));
    if (!a.ok) throw new Error(a.error);
    expect(o.pair(a.pending.code, 'local-eor:someoneelse', null)).toMatchObject({ ok: false, message: /not open to this account/ });
    expect(o.pair(a.pending.code, 'local-eor:Jake'.toLowerCase(), null).ok).toBe(true);
    expect(new URL(o.decide(a.pending.reqId, false, false).redirect!).searchParams.get('error')).toBe('access_denied');
    const b = await o.authorize(authQ(clientId, challenge));
    if (!b.ok) throw new Error(b.error);
    advance(11 * 60_000);
    expect(o.pair(b.pending.code, 'local-eor:jake', null).ok).toBe(false);
    expect(o.status(b.pending.reqId).state).toBe('expired');
  });

  it('nothing is stored: a restarted (or the other, draining) bridge with the same secret takes the client id and the tokens; another secret, none', async () => {
    const { o, clientId, clock } = flow();
    const t = await grant(o, clientId);
    const next = new OAuthServer({ issuer: 'https://bridge.test', allow: [], now: clock.now, secret: SECRET });
    expect(next.persistent).toBe(true);
    expect(next.resolve(t.access_token)).toMatchObject({ key: 'local-eor:jake', scope: ['Jake'] });
    expect(await next.tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: clientId })).toMatchObject({ status: 200 });
    const { challenge } = pkce();
    expect((await next.authorize(authQ(clientId, challenge))).ok).toBe(true);
    const other = new OAuthServer({ issuer: 'https://bridge.test', allow: [], now: clock.now, secret: 'another-secret-'.padEnd(40, 'b') });
    expect(other.resolve(t.access_token)).toBeNull();
    expect((await other.authorize(authQ(clientId, challenge))).ok).toBe(false);
    // Without a secret (or a short one) tokens are this process's only.
    expect(new OAuthServer({ issuer: 'x', allow: [], secret: 'short' }).persistent).toBe(false);
  });

  it('a token can\'t be forged or altered; expiry; a reused refresh token ends the grant; leaving the allowlist ends it too', async () => {
    const { o, clientId, advance, clock } = flow();
    const t = await grant(o, clientId);
    const forged = new Sealer('forger-secret-'.padEnd(40, 'c')).seal('a1', { g: 'x', k: 'local-eor:jake', s: 'any', t: 0, e: Number.MAX_SAFE_INTEGER });
    expect(o.resolve(forged)).toBeNull();
    const [p, iv, body] = t.access_token.split('.');
    const flipped = `${p}.${iv}.${body.slice(0, -2)}${body.slice(-2) === 'AA' ? 'AB' : 'AA'}`;
    expect(o.resolve(flipped)).toBeNull();
    expect(o.resolve(t.refresh_token)).toBeNull(); // a refresh token is not an access token
    advance(3_600_001);
    expect(o.resolve(t.access_token)).toBeNull();
    const r1 = await o.tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: clientId });
    expect(r1.status).toBe(200);
    const fresh = r1.body as { access_token: string };
    expect(o.resolve(fresh.access_token)).not.toBeNull();
    expect((await o.tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: clientId })).status).toBe(400);
    expect(o.resolve(fresh.access_token)).toBeNull(); // the reuse revoked the grant
    const pinned = new OAuthServer({ issuer: 'https://bridge.test', allow: ['local-eor:jake'], now: clock.now, secret: SECRET });
    const t2 = await grant(pinned, clientId);
    expect(pinned.resolve(t2.access_token)).not.toBeNull();
    const narrowed = new OAuthServer({ issuer: 'https://bridge.test', allow: ['local-eor:someoneelse'], now: clock.now, secret: SECRET });
    expect(narrowed.resolve(t2.access_token)).toBeNull();
  });

  it('unpair ends every grant made before it; a pairing after it works', async () => {
    const { o, clientId, advance } = flow();
    const t = await grant(o, clientId);
    advance(1000);
    o.revokeAccount('local-eor:jake');
    expect(o.resolve(t.access_token)).toBeNull();
    expect((await o.tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: clientId })).status).toBe(400);
    advance(1000);
    const again = await grant(o, clientId);
    expect(o.resolve(again.access_token)).not.toBeNull();
  });
});

// ─── through the bridge ───

function str16(s: string): Buffer { const b = Buffer.from(s, 'latin1'); const out = Buffer.alloc(2 + b.length + ((4 - ((2 + b.length) % 4)) % 4)); out.writeUInt16LE(b.length, 0); b.copy(out, 2); return out; }
const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0, 0); return b; };
function characterListPacket(account: string, names: string[]): Buffer {
  const body = Buffer.concat([u32(0xf658), u32(0), u32(names.length), ...names.flatMap((n, i) => [u32(0x50000001 + i), str16(n), u32(0)]), u32(0), u32(11), str16(account), u32(1), u32(1)]);
  const frag = Buffer.concat([u32(7), u32(0x80000001), Buffer.from([1, 0]), Buffer.alloc(2), Buffer.alloc(4), body]);
  frag.writeUInt16LE(frag.length, 10);
  const head = Buffer.alloc(20); head.writeUInt32LE(3, 0); head.writeUInt32LE(0x4 | 0x4000, 4);
  return Buffer.concat([head, u32(2), frag]);
}
function config(env: Record<string, string>, port: number): BridgeConfig {
  const c = resolveBridgeConfig(['0', '127.0.0.1', String(port), String(port + 1)], { BRIDGE_SERVERS_URL: 'none', BRIDGE_SERVERS_CACHE: 'none', ...env });
  c.wsPort = 0;
  return c;
}
const open = (url: string): Promise<WebSocket> => new Promise((res, rej) => { const ws = new WebSocket(url); ws.once('open', () => res(ws)); ws.once('error', rej); });
async function until(cond: () => boolean, ms = 3000): Promise<void> { const s = Date.now(); while (!cond()) { if (Date.now() - s > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); } }

describe('pairing through the bridge, as Claude does it', () => {
  let bridge: BridgeServer | null = null;
  let udp: dgram.Socket | null = null;
  afterEach(async () => { await bridge?.shutdown(); bridge = null; udp?.close(); udp = null; });

  it('401 points at the metadata; register, authorize page, the code typed in the game, approve, token, then a tool call plays the tab', async () => {
    udp = dgram.createSocket('udp4');
    const got: dgram.RemoteInfo[] = [];
    udp.on('message', (_m, r) => got.push(r));
    await new Promise<void>((r) => udp!.bind(0, '127.0.0.1', () => r()));
    bridge = createBridgeServer(config({ BRIDGE_MCP: 'on', BRIDGE_PUBLIC_URL: 'https://bridge.test', BRIDGE_MCP_SECRET: 'bridge-test-secret-'.padEnd(40, 'd') }, udp.address().port), { log: () => {} });
    const port = await bridge.listen();
    const base = `http://127.0.0.1:${port}`;

    const unauth = await fetch(`${base}/mcp`, { method: 'POST', body: '{}' });
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get('www-authenticate')).toBe('Bearer resource_metadata="https://bridge.test/.well-known/oauth-protected-resource"');
    expect(await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json()).toMatchObject({ resource: 'https://bridge.test/mcp', authorization_servers: ['https://bridge.test'] });
    expect(await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()).toMatchObject({ code_challenge_methods_supported: ['S256'], token_endpoint: 'https://bridge.test/oauth/token' });
    const reg = await (await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [CB], client_name: 'Claude Code' }) })).json();
    const { verifier, challenge } = pkce();
    const page = await (await fetch(`${base}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: CB, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', resource: 'https://bridge.test/mcp' })}`)).text();
    const shown = /\/automation pair <b>([A-Z0-9]{3}-[A-Z0-9]{3})<\/b>/.exec(page)![1];
    const reqId = /const req="([^"]+)"/.exec(page)![1];

    // The game tab: logged in, then the player types the code.
    const tab = await open(`ws://127.0.0.1:${port}/`);
    const pkt = Buffer.alloc(24); pkt.writeUInt32LE(0x10000, 4);
    tab.send(pkt);
    await until(() => got.length > 0);
    udp.send(characterListPacket('Jake', ['Jake']), got[0].port, got[0].address);
    await new Promise((r) => setTimeout(r, 100));
    tab.send(JSON.stringify({ agentState: { relay: 'on', character: 'Jake' } }));
    const paired = await new Promise<any>((res) => { tab.once('message', (d: Buffer) => res(JSON.parse(d.toString()))); tab.send(JSON.stringify({ pair: shown })); });
    expect(paired.paired.ok).toBe(true);
    expect(await (await fetch(`${base}/oauth/authorize/status?req=${reqId}`)).json()).toMatchObject({ state: 'paired', account: 'local-eor:jake', character: 'Jake' });
    const dec = await (await fetch(`${base}/oauth/authorize/decision`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ req: reqId, approve: true, only: true }) })).json();
    const code = new URL(dec.redirect).searchParams.get('code')!;
    const tok = await (await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: CB }).toString() })).json();
    expect(tok.token_type).toBe('Bearer');

    tab.on('message', (d: Buffer, binary: boolean) => { if (binary) return; const f = JSON.parse(d.toString()); if (f.agent) tab.send(JSON.stringify({ agentResult: { id: f.agent.id, ok: true, result: 'sent: hi' } })); });
    const call = (accessToken: string) => fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ac_character', arguments: {} } }) });
    const r = await (await call(tok.access_token)).json();
    expect(r.result.content[0].text).toBe('sent: hi');
    // A grant for Jake only refuses when another character is in the world.
    tab.send(JSON.stringify({ agentState: { relay: 'on', character: 'Mule' } }));
    await new Promise((x) => setTimeout(x, 50));
    const other = await (await call(tok.access_token)).json();
    expect(other.result.content[0].text).toMatch(/plays only Jake; Mule is in the world/);
    // A tab that unpaired earlier (it remembers, across bridge restarts) refuses grants made before then.
    tab.send(JSON.stringify({ agentState: { relay: 'on', character: 'Jake', revokedBefore: Date.now() + 60_000 } }));
    await new Promise((x) => setTimeout(x, 50));
    expect((await (await call(tok.access_token)).json()).result.content[0].text).toMatch(/disconnected in the game \(\/automation unpair\)/);
    tab.send(JSON.stringify({ agentState: { relay: 'on', character: 'Jake' } }));
    await new Promise((x) => setTimeout(x, 50));
    expect((await (await call(tok.access_token)).json()).result.content[0].text).toBe('sent: hi');
    // Unpaired from the game: every grant for the account ends.
    const unpaired = await new Promise<any>((res) => { const on = (d: Buffer, binary: boolean) => { if (binary) return; const f = JSON.parse(d.toString()); if (f.unpaired) { tab.off('message', on); res(f); } }; tab.on('message', on); tab.send('{"unpair":true}'); });
    expect(unpaired.unpaired).toEqual({ ok: true, message: 'every Claude connection for this account is revoked', at: expect.any(Number) });
    expect((await call(tok.access_token)).status).toBe(401);
    expect((await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: reg.client_id }).toString() })).status).toBe(400);
    // Revoke is harmless after that.
    await fetch(`${base}/oauth/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: tok.refresh_token }).toString() });
    tab.close();
  }, 15_000);

  it('a bridge without the connector answers a pairing code with why, and an unlogged tab is told to log in', async () => {
    const logged: Array<[string, string, unknown]> = [];
    bridge = createBridgeServer(config({ BRIDGE_MCP: 'on', BRIDGE_PUBLIC_URL: 'https://bridge.test', BRIDGE_MCP_ACCOUNTS: 'enkarta', BRIDGE_ROUTINES_DIR: 'none' }, 9), { log: (level: string, event: string, data?: unknown) => logged.push([level, event, data]) } as never);
    // No BRIDGE_MCP_SECRET: pairings end with the process, and the bridge says so.
    expect(logged.find((l) => l[1] === 'mcp_oauth_on')).toEqual(['warn', 'mcp_oauth_on', { tokens: 'this-process', allowlist: 1 }]);
    const port = await bridge.listen();
    const tab = await open(`ws://127.0.0.1:${port}/`);
    const ask = (text: string) => new Promise<any>((res) => { tab.once('message', (d: Buffer) => res(JSON.parse(d.toString()))); tab.send(text); });
    expect(await ask('{"pair":"ABC234"}')).toEqual({ paired: { ok: false, message: 'log in first' } });
    tab.close();
    await bridge.shutdown();
    bridge = createBridgeServer(config({}, 9), { log: () => {} });
    const port2 = await bridge.listen();
    const tab2 = await open(`ws://127.0.0.1:${port2}/`);
    const reply = await new Promise<any>((res) => { tab2.once('message', (d: Buffer) => res(JSON.parse(d.toString()))); tab2.send('{"unpair":true}'); });
    expect(reply).toEqual({ unpaired: { ok: false, message: 'this server has no Claude connector' } });
    tab2.close();
  });

  it('with BRIDGE_CONNECT_PAGE, authorize sends the browser to the game\'s connect screen', async () => {
    bridge = createBridgeServer(config({ BRIDGE_MCP: 'on', BRIDGE_PUBLIC_URL: 'https://bridge.test', BRIDGE_CONNECT_PAGE: 'https://playwebac.com/' }, 9), { log: () => {} });
    const port = await bridge.listen();
    const base = `http://127.0.0.1:${port}`;
    const reg = await (await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [CB], client_name: 'Claude' }) })).json();
    const { challenge } = pkce();
    const r = await fetch(`${base}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: CB, code_challenge: challenge, code_challenge_method: 'S256', state: 's' })}`, { redirect: 'manual' });
    expect(r.status).toBe(302);
    const to = new URL(r.headers.get('location')!);
    expect(to.origin + to.pathname).toBe('https://playwebac.com/');
    const req = to.searchParams.get('connect')!;
    const st = await (await fetch(`${base}/oauth/authorize/status?req=${req}`)).json();
    expect(st).toMatchObject({ state: 'waiting', client: 'Claude', code: expect.stringMatching(/^[A-HJ-KM-NP-Z2-9]{6}$/) });
    // A bad request still gets the error text, not a redirect.
    expect((await fetch(`${base}/oauth/authorize?response_type=code&client_id=nope`, { redirect: 'manual' })).status).toBe(400);
  });
});
