/**
 * The hosted Claude connector across a bridge deploy (docs/hosted-agent-connector.md §4.5).
 *
 * Prod 2026-10-12 23:13Z: a bridge deploy drained the old container (the game kept playing there) while
 * Claude's /mcp calls reached the new one, whose relay had never seen the tab: "your game is not open" for
 * the whole 6 h drain, and `/automation claude on` couldn't fix it. Now the draining bridge tells the tab,
 * vouches for its account with a sealed ticket, and the tab's relay link (agent/relayLink.ts) carries the
 * relay on the new deployment. Real bridges (two, one secret), a fake UDP game server, the real tab-side
 * RelayLink and TabRelay over real WebSockets, and the real /mcp handler.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as dgram from 'dgram';
import { WebSocket } from 'ws';
import { resolveBridgeConfig, type BridgeConfig } from '../services/ws-tcp-bridge/src/bridgeUtil';
import { createBridgeServer, DRAINING_FRAME, type BridgeServer } from '../services/ws-tcp-bridge/src/server';
import { AgentRelay, accountKey } from '../services/ws-tcp-bridge/src/relay';
import { OAuthServer, RELAY_TICKET_MS } from '../services/ws-tcp-bridge/src/oauth';
import { parseRelayLinkNotice } from '../packages/network/src/ClientConnection';
import { RelayLink, RELINK_DELAYS_MS, relayLinkUrl, type LinkSocket } from '../packages/renderer/src/agent/relayLink';
import { TabRelay } from '../packages/renderer/src/agent/relayTab';

function str16(s: string): Buffer {
  const b = Buffer.from(s, 'latin1');
  const out = Buffer.alloc(2 + b.length + ((4 - ((2 + b.length) % 4)) % 4));
  out.writeUInt16LE(b.length, 0);
  b.copy(out, 2);
  return out;
}
const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0, 0); return b; };
function characterListPacket(account: string, names: string[]): Buffer {
  const body = Buffer.concat([u32(0xf658), u32(0), u32(names.length), ...names.flatMap((n, i) => [u32(0x50000001 + i), str16(n), u32(0)]), u32(0), u32(11), str16(account), u32(1), u32(1)]);
  const frag = Buffer.concat([u32(7), u32(0x80000001), Buffer.from([1, 0]), Buffer.alloc(2), Buffer.alloc(4), body]);
  frag.writeUInt16LE(frag.length, 10);
  const head = Buffer.alloc(20);
  head.writeUInt32LE(3, 0);
  head.writeUInt32LE(0x4 | 0x4000, 4);
  return Buffer.concat([head, u32(2), frag]);
}

const SECRET = 'relay-link-test-secret-'.padEnd(40, 'x');
const TOKEN = 'devtoken0123456789abcdef';
function config(port: number, secret = SECRET): BridgeConfig {
  const c = resolveBridgeConfig(['0', '127.0.0.1', String(port), String(port + 1)], {
    BRIDGE_SERVERS_URL: 'none', BRIDGE_SERVERS_CACHE: 'none', BRIDGE_ROUTINES_DIR: 'none',
    BRIDGE_MCP: 'on', BRIDGE_PUBLIC_URL: 'https://bridge.test', BRIDGE_MCP_SECRET: secret,
    BRIDGE_MCP_DEV_TOKENS: `${TOKEN}=local-eor:agentclaude`,
  });
  c.wsPort = 0;
  return c;
}
function open(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => { const ws = new WebSocket(url); ws.once('open', () => resolve(ws)); ws.once('error', reject); });
}
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) { if (Date.now() - start > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); }
}
const observe = (port: number) => fetch(`http://127.0.0.1:${port}/mcp`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ac_observe', arguments: {} } }),
}).then((r) => r.json()).then((j) => j.result as { isError?: boolean; content: Array<{ text: string }> });

describe('the connector follows the tab across a bridge deploy', () => {
  const closers: Array<() => unknown> = [];
  afterEach(async () => { for (const c of closers.splice(0).reverse()) await c(); });

  async function bridgePair(secretB = SECRET) {
    const udp = dgram.createSocket('udp4');
    const got: dgram.RemoteInfo[] = [];
    udp.on('message', (_m, r) => got.push(r));
    await new Promise<void>((r) => udp.bind(0, '127.0.0.1', () => r()));
    closers.push(() => udp.close());
    const a = createBridgeServer(config(udp.address().port), { log: () => {} });
    const b = createBridgeServer(config(udp.address().port, secretB), { log: () => {} });
    const portA = await a.listen();
    const portB = await b.listen();
    closers.push(() => a.shutdown(), () => b.shutdown());
    return { udp, got, a, b, portA, portB };
  }

  /** A tab logged in on bridge A with Claude switched on: the game socket, its RelayLink, its TabRelay. */
  async function tabOn(env: Awaited<ReturnType<typeof bridgePair>>) {
    const game = await open(`ws://127.0.0.1:${env.portA}/`);
    closers.push(() => game.close());
    const gameText: string[] = [];
    const pkt = Buffer.alloc(24); pkt.writeUInt32LE(0x10000, 4);
    game.send(pkt);
    await until(() => env.got.length > 0);
    env.udp.send(characterListPacket('AgentClaude', ['Claude']), env.got[0].port, env.got[0].address);
    await new Promise((r) => setTimeout(r, 100));
    const tab = new TabRelay((t) => game.send(t), () => ({ observe: () => ({ me: null, nearby: [], chat: [], seq: 1 }) }));
    tab.on = true;
    const linkLog: string[] = [];
    const link = new RelayLink({
      // The load balancer: once A drains, the bridge URL reaches B.
      gameUrl: () => `ws://127.0.0.1:${env.portB}/?server=somewhere`,
      requestTicket: () => game.send('relayTicket'),
      open: (url) => new WebSocket(url) as unknown as LinkSocket,
      onCall: (call, reply) => { void tab.handle(call, reply); },
      onPairing: () => {},
      onLinked: () => link.send(tab.stateFrame('Claude', 'world')),
      log: (t) => linkLog.push(t),
    });
    closers.push(() => link.reset());
    game.on('message', (d: Buffer, binary: boolean) => {
      if (binary) return;
      const text = d.toString();
      gameText.push(text);
      const call = text.startsWith('{"agent"') ? JSON.parse(text).agent : null;
      if (call) { void tab.handle(call); return; }
      const n = parseRelayLinkNotice(text);
      if (n) link.onNotice(n);
    });
    game.send(tab.stateFrame('Claude', 'world'));
    await new Promise((r) => setTimeout(r, 50));
    return { game, gameText, link, linkLog, tab };
  }

  it('before: /mcp on the new deployment says "not open"; after the drain notice it plays the tab still on the old one', async () => {
    const env = await bridgePair();
    const t = await tabOn(env);
    expect((await observe(env.portA)).isError).toBeUndefined(); // the old bridge plays it

    // The deploy: B is up, A drains. Claude's calls now reach B, which has never seen the tab: the bug.
    expect((await observe(env.portB)).content[0].text).toMatch(/your game is not open/);
    const drained = env.a.drain(60_000);
    await until(() => t.gameText.includes(DRAINING_FRAME));
    await until(() => t.link.linked);
    await new Promise((r) => setTimeout(r, 50));

    const obs = await observe(env.portB);
    expect(obs.isError).toBeUndefined();
    expect(obs.content[0].text).not.toMatch(/not open|switched off/);
    // The game itself stays on the draining bridge.
    expect(env.a.snapshot()).toMatchObject({ draining: true, sessions: 1 });

    // The game session ends (its reconnect lands on a live bridge): the link goes, so A drains to empty.
    t.link.reset();
    t.game.close();
    expect(await drained).toBe('empty');
    await until(() => env.b.snapshot().sessions === 0);
  }, 15_000);

  it('a pairing code typed while the game\'s bridge drains goes over the link, where the connect page\'s code waits', async () => {
    const env = await bridgePair();
    const t = await tabOn(env);
    void env.a.drain(60_000);
    await until(() => t.link.linked);
    // The connect page was served by the new deployment (B): only B knows the code.
    const authorize = await fetch(`http://127.0.0.1:${env.portB}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:5555/cb'], client_name: 'Test' }) });
    const client = await authorize.json();
    const q = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: 'http://127.0.0.1:5555/cb', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256' });
    const page = await (await fetch(`http://127.0.0.1:${env.portB}/oauth/authorize?${q}`)).text();
    const code = /\/automation pair <b>([A-Z0-9]{3}-[A-Z0-9]{3})<\/b>/.exec(page)![1];
    const replies: string[] = [];
    const replied = new Promise<void>((res) => {
      const real = (t.link as unknown as { o: { onPairing: (r: unknown) => void } }).o;
      real.onPairing = (r) => { replies.push(JSON.stringify(r)); res(); };
    });
    expect(t.link.send(JSON.stringify({ pair: code }))).toBe(true);
    await replied;
    expect(JSON.parse(replies[0])).toMatchObject({ kind: 'paired', ok: true });
  }, 15_000);

  it('a ticket from a bridge with another secret, or a forged one, is refused; a live bridge hands no link', async () => {
    const env = await bridgePair('a-different-secret-entirely-'.padEnd(40, 'z'));
    const t = await tabOn(env);
    // Not draining: the ticket answer says so and the tab opens nothing.
    t.link.relink();
    await until(() => t.gameText.some((x) => x.startsWith('{"relayTicket"')));
    expect(JSON.parse(t.gameText.find((x) => x.startsWith('{"relayTicket"'))!)).toMatchObject({ relayTicket: { draining: false } });
    await new Promise((r) => setTimeout(r, 100));
    expect(t.link.linked).toBe(false);
    expect(env.b.snapshot().sessions).toBe(0);

    void env.a.drain(60_000);
    await until(() => t.linkLog.some((x) => /refused the relay link/.test(x)));
    expect(t.link.linked).toBe(false);

    const raw = await open(`ws://127.0.0.1:${env.portB}/`);
    closers.push(() => raw.close());
    const answer = await new Promise<string>((res) => { raw.once('message', (d: Buffer) => res(d.toString())); raw.send(JSON.stringify({ relayHello: 'l1.forged.ticket' })); });
    expect(JSON.parse(answer)).toEqual({ relayLinked: { ok: false, message: 'the relay-link ticket was refused' } });
  }, 15_000);

  it('a session that logs in on an already draining bridge is told at once', async () => {
    const env = await bridgePair();
    const game = await open(`ws://127.0.0.1:${env.portA}/`);
    closers.push(() => game.close());
    const texts: string[] = [];
    game.on('message', (d: Buffer, binary: boolean) => { if (!binary) texts.push(d.toString()); });
    const pkt = Buffer.alloc(24); pkt.writeUInt32LE(0x10000, 4);
    game.send(pkt);
    await until(() => env.got.length > 0);
    void env.a.drain(60_000);
    env.udp.send(characterListPacket('AgentClaude', ['Claude']), env.got[0].port, env.got[0].address);
    await until(() => texts.includes(DRAINING_FRAME));
  });
});

describe('the pieces', () => {
  it('tickets: open on any bridge with the secret, never with another, never after RELAY_TICKET_MS, never for an account off the allowlist', () => {
    let t = 1_000_000;
    const a = new OAuthServer({ issuer: 'https://b', allow: [], secret: SECRET, now: () => t });
    const b = new OAuthServer({ issuer: 'https://b', allow: [], secret: SECRET, now: () => t });
    const other = new OAuthServer({ issuer: 'https://b', allow: [], secret: 'z'.repeat(40), now: () => t });
    const ticket = a.relayTicket('local-eor:jake')!;
    expect(b.openRelayTicket(ticket)).toBe('local-eor:jake');
    expect(other.openRelayTicket(ticket)).toBeNull();
    expect(new OAuthServer({ issuer: 'https://b', allow: ['someoneelse'], secret: SECRET, now: () => t }).openRelayTicket(ticket)).toBeNull();
    t += RELAY_TICKET_MS + 1;
    expect(b.openRelayTicket(ticket)).toBeNull();
    // Without a configured secret no other bridge could open it: none is handed out.
    expect(new OAuthServer({ issuer: 'https://b', allow: [] }).relayTicket('local-eor:jake')).toBeNull();
  });

  it('a state frame relinks a logged-in session the relay lost (/automation claude on), but never takes another tab\'s account', () => {
    const relay = new AgentRelay();
    const key = accountKey('local-eor', 'jake');
    const sent: string[] = [];
    const a = { send: (x: string) => sent.push(`a ${x}`) };
    const b = { send: (x: string) => sent.push(`b ${x}`) };
    relay.onText(a, '{"agentState":{"relay":"on"}}'); // no account: nothing to register
    expect(relay.entry(key)).toBeUndefined();
    relay.onText(a, '{"agentState":{"relay":"on"}}', key);
    expect(relay.holds(a)).toBe(true);
    expect(relay.entry(key)?.relayOn).toBe(true);
    relay.onText(b, '{"agentState":{"relay":"on"}}', key); // a's account is held: b stays out
    expect(relay.holds(b)).toBe(false);
    expect(relay.entry(key)?.peer).toBe(a);
  });

  it('notices parse; the link URL drops the server and marks the relay', () => {
    expect(parseRelayLinkNotice(DRAINING_FRAME)).toEqual({ kind: 'draining' });
    expect(parseRelayLinkNotice('{"relayTicket":{"ticket":"l1.a.b","draining":true}}')).toEqual({ kind: 'ticket', ticket: 'l1.a.b', draining: true });
    expect(parseRelayLinkNotice('{"relayTicket":{"ticket":null,"draining":false}}')).toEqual({ kind: 'ticket', ticket: null, draining: false });
    expect(parseRelayLinkNotice('{"paired":{"ok":true}}')).toBeNull();
    expect(relayLinkUrl('wss://bridge.example/?server=seedsow&proto=x')).toBe('wss://bridge.example/?proto=x&relay=1');
  });

  it('a link that drops while the game\'s bridge still drains links again with a fresh ticket; reset stops it', () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const socks: Array<LinkSocket & { sent: string[]; readyState: number }> = [];
    let tickets = 0;
    const link = new RelayLink({
      gameUrl: () => 'wss://bridge.example/?server=x',
      requestTicket: () => { tickets++; },
      open: () => { const s = { readyState: 1, sent: [] as string[], send(t: string) { this.sent.push(t); }, close() { this.readyState = 3; this.onclose?.({}); }, onopen: null, onmessage: null, onclose: null, onerror: null } as LinkSocket & { sent: string[]; readyState: number }; socks.push(s); return s; },
      onCall: () => {}, onPairing: () => {}, onLinked: () => {},
      setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
      clearTimer: () => {},
    });
    link.onNotice({ kind: 'draining' });
    expect(tickets).toBe(1);
    link.onNotice({ kind: 'ticket', ticket: 'l1.t', draining: true });
    socks[0].onopen?.({});
    expect(socks[0].sent).toEqual(['{"relayHello":"l1.t"}']);
    socks[0].onmessage?.({ data: '{"relayLinked":{"ok":true}}' });
    expect(link.linked).toBe(true);
    // The new deployment restarts: the link closes; it relinks after the first delay.
    socks[0].readyState = 3;
    socks[0].onclose?.({});
    expect(timers.map((t) => t.ms)).toEqual([RELINK_DELAYS_MS[0]]);
    timers[0].fn();
    expect(tickets).toBe(2);
    link.onNotice({ kind: 'ticket', ticket: 'l1.t2', draining: true });
    expect(socks.length).toBe(2);
    link.reset();
    expect(socks[1].readyState).toBe(3);
    expect(timers.length).toBe(1); // a dropped link doesn't retry
  });

  it('a tab with Claude off opens no link on a drain; a pairing code typed then links and goes once linked', () => {
    const socks: Array<LinkSocket & { sent: string[] }> = [];
    let tickets = 0;
    const link = new RelayLink({
      gameUrl: () => 'wss://bridge.example/',
      requestTicket: () => { tickets++; },
      open: () => { const s = { readyState: 1, sent: [] as string[], send(t: string) { this.sent.push(t); }, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null } as LinkSocket & { sent: string[] }; socks.push(s); return s; },
      onCall: () => {}, onPairing: () => {}, onLinked: () => { link.send('{"agentState":{"relay":"off"}}'); },
      wanted: () => false,
    });
    expect(link.sendPairing('{"pair":"ABC234"}')).toBe(false); // a live bridge: the game socket takes it
    link.onNotice({ kind: 'draining' });
    expect(tickets).toBe(0);
    expect(link.sendPairing('{"pair":"ABC234"}')).toBe(true);
    expect(tickets).toBe(1);
    link.onNotice({ kind: 'ticket', ticket: 'l1.t', draining: true });
    socks[0].onopen?.({});
    socks[0].onmessage?.({ data: '{"relayLinked":{"ok":true}}' });
    expect(socks[0].sent).toEqual(['{"relayHello":"l1.t"}', '{"agentState":{"relay":"off"}}', '{"pair":"ABC234"}']);
  });

  it('a relay answer goes back the way its call came', async () => {
    const game: string[] = [];
    const linkOut: string[] = [];
    const tab = new TabRelay((t) => game.push(t), () => ({ observe: () => 'seen' }));
    tab.on = true;
    await tab.handle({ id: 4, method: 'observe', args: [], deadlineMs: 1000 }, (t) => linkOut.push(t));
    await tab.handle({ id: 5, method: 'observe', args: [], deadlineMs: 1000 });
    expect(linkOut).toEqual(['{"agentResult":{"id":4,"ok":true,"result":"seen"}}']);
    expect(game).toEqual(['{"agentResult":{"id":5,"ok":true,"result":"seen"}}']);
  });
});
