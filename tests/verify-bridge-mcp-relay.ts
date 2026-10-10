/**
 * AGENT.hosted-mcp-connector, step 1 — the bridge's /mcp relays an MCP
 * client's tool calls to the account's own open tab (relay.ts, mcpHttp.ts):
 * a bearer token names the account; the account comes from the game server's
 * CharacterList (proof of login); the tab answers only once it has switched
 * the relay on. End to end: the real bridge, a fake UDP game server, a fake
 * tab on the WebSocket, and the real MCP handler and tool table.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as dgram from 'dgram';
import { WebSocket } from 'ws';
import { resolveBridgeConfig, type BridgeConfig } from '../services/ws-tcp-bridge/src/bridgeUtil';
import { createBridgeServer, type BridgeServer } from '../services/ws-tcp-bridge/src/server';
import { AgentRelay, DISCONNECTED, accountKey, parseRelayFrame } from '../services/ws-tcp-bridge/src/relay';
import { parseMcpTokens } from '../services/ws-tcp-bridge/src/mcpHttp';
import { LOCAL_ONLY_TOOLS } from '../tools/ac-agent/tools';

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

describe('the relay pieces', () => {
  it('tokens name an account; short or malformed ones are dropped', () => {
    const t = parseMcpTokens('devtoken0123456789=local-eor:AgentClaude, short=local-eor:x, nocolon0123456789=abc');
    expect([...t]).toEqual([['devtoken0123456789', 'local-eor:agentclaude']]);
  });

  it('frames: a result or the tab\'s state; anything else is not the relay\'s', () => {
    expect(parseRelayFrame('{"agentResult":{"id":3,"ok":true,"result":{"a":1}}}')).toEqual({ kind: 'result', id: 3, ok: true, result: { a: 1 } });
    expect(parseRelayFrame('{"agentResult":{"id":3,"ok":false}}')).toMatchObject({ kind: 'result', ok: false, error: 'the tab refused the call' });
    expect(parseRelayFrame('{"agentState":{"relay":"on","character":"Claude"}}')).toEqual({ kind: 'state', relay: true, character: 'Claude', screen: null, revokedBefore: 0 });
    expect(parseRelayFrame('{"agentState":{"relay":"on","revokedBefore":1760000000000}}')).toMatchObject({ revokedBefore: 1760000000000 });
    expect(parseRelayFrame('{"agentState":{"relay":"on","revokedBefore":"soon"}}')).toMatchObject({ revokedBefore: 0 });
    expect(parseRelayFrame('routines')).toBeNull();
    expect(parseRelayFrame('{"routines":null}')).toBeNull();
  });

  it('a later login of the account replaces the tab; a closed tab\'s calls fail with the reconnect advice; a quiet one times out', async () => {
    const relay = new AgentRelay();
    const sent: string[] = [];
    const a = { send: (t: string) => sent.push(`a ${t}`) };
    const b = { send: (t: string) => sent.push(`b ${t}`) };
    const key = accountKey('local-eor', 'AgentClaude');
    relay.register(a, key);
    await expect(relay.call(key, 'observe')).rejects.toThrow('this tab has Claude switched off');
    relay.onText(a, '{"agentState":{"relay":"on"}}');
    const p = relay.call(key, 'observe', [{ radius: 30 }], 1000);
    expect(sent.at(-1)).toMatch(/^a \{"agent":\{"id":\d+,"method":"observe","args":\[\{"radius":30\}\],"deadlineMs":1000\}\}$/);
    relay.register(b, key);
    await expect(p).rejects.toThrow(DISCONNECTED);
    await expect(relay.call(key, 'observe')).rejects.toThrow('switched off');
    relay.onText(b, '{"agentState":{"relay":"on"}}');
    await expect(relay.call(key, 'self', [], 10)).rejects.toThrow(/no answer from the game/);
    relay.remove(b);
    await expect(relay.call(key, 'self')).rejects.toThrow('your game is not open');
  }, 10_000);
});

const silent = () => {};
function config(env: Record<string, string>, port: number): BridgeConfig {
  const c = resolveBridgeConfig(['0', '127.0.0.1', String(port), String(port + 1)], { BRIDGE_SERVERS_URL: 'none', BRIDGE_SERVERS_CACHE: 'none', ...env });
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

describe('/mcp through the bridge to the tab', () => {
  let bridge: BridgeServer | null = null;
  let udp: dgram.Socket | null = null;
  afterEach(async () => { await bridge?.shutdown(); bridge = null; udp?.close(); udp = null; });

  it('Claude Code with the token plays the logged-in tab: tools/list has the game tools, ac_observe comes back from the tab', async () => {
    udp = dgram.createSocket('udp4');
    const got: dgram.RemoteInfo[] = [];
    udp.on('message', (_m, r) => got.push(r));
    await new Promise<void>((r) => udp!.bind(0, '127.0.0.1', () => r()));
    const token = 'devtoken0123456789abcdef';
    bridge = createBridgeServer(config({ BRIDGE_MCP_DEV_TOKENS: `${token}=local-eor:agentclaude` }, udp.address().port), { log: silent });
    const port = await bridge.listen();
    const mcp = (body: unknown, auth = token) => fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(body) });

    expect((await mcp({ jsonrpc: '2.0', id: 1, method: 'ping' }, '')).status).toBe(401);
    expect((await mcp({ jsonrpc: '2.0', id: 1, method: 'ping' }, 'wrong-token-0000000000')).status).toBe(401);
    const init = await (await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })).json();
    expect(init.result.instructions).toMatch(/the player's own character/);
    const list = await (await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
    const names: string[] = list.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('ac_observe');
    expect(names).toContain('ac_walk_to');
    expect(names.filter((n) => LOCAL_ONLY_TOOLS.has(n))).toEqual([]);

    // Not logged in yet: the tool says so.
    const before = await (await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ac_observe', arguments: {} } })).json();
    expect(before.result).toMatchObject({ isError: true });
    expect(before.result.content[0].text).toMatch(/your game is not open/);

    // The tab logs in: its packets open the UDP leg, the server answers with the CharacterList.
    const tab = await open(`ws://127.0.0.1:${port}/`);
    const pkt = Buffer.alloc(24); pkt.writeUInt32LE(0x10000, 4);
    tab.send(pkt);
    await until(() => got.length > 0);
    udp.send(characterListPacket('AgentClaude', ['Claude']), got[0].port, got[0].address);
    await new Promise((r) => setTimeout(r, 100));
    // The tab answers relay calls with an observation, once it switches the relay on.
    const calls: Array<{ method: string; args: unknown[] }> = [];
    tab.on('message', (d: Buffer, binary: boolean) => {
      if (binary) return;
      const f = JSON.parse(d.toString());
      if (!f.agent) return;
      calls.push({ method: f.agent.method, args: f.agent.args });
      tab.send(JSON.stringify({ agentResult: { id: f.agent.id, ok: true, result: { me: null, nearby: [], chat: [], seq: 7 } } }));
    });
    const off = await (await mcp({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'ac_observe', arguments: {} } })).json();
    expect(off.result.content[0].text).toMatch(/Claude switched off/);
    tab.send(JSON.stringify({ agentState: { relay: 'on', character: 'Claude' } }));
    await new Promise((r) => setTimeout(r, 50));
    const obs = await (await mcp({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'ac_observe', arguments: { radius: 30 } } })).json();
    expect(obs.result.isError).toBeUndefined();
    expect(calls).toEqual([{ method: 'observe', args: [{ radius: 30 }] }]);
    // A local-only tool isn't served.
    const start = await (await mcp({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'ac_start', arguments: {} } })).json();
    expect(start.error.message).toMatch(/unknown tool/);
    // The tab goes away mid-call: the call fails with the reconnect advice.
    tab.removeAllListeners('message');
    const pending = mcp({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'ac_observe', arguments: {} } });
    await new Promise((r) => setTimeout(r, 50));
    tab.close();
    const lost = await (await pending).json();
    expect(lost.result.content[0].text).toMatch(/the game disconnected/);
  }, 15_000);

  it('no tokens configured: there is no /mcp', async () => {
    bridge = createBridgeServer(config({}, 9), { log: silent });
    const port = await bridge.listen();
    // Not served: the bridge's ordinary handler answers (no 401 challenge, no JSON-RPC).
    expect([404, 405]).toContain((await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', body: '{}' })).status);
  });
});
