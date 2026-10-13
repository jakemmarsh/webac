/**
 * AGENT.routine-store-auth — the bridge's /routines: a session gets a token
 * only after its game server's CharacterList names the account (proof of
 * login), and the token opens that one account's routines. Real modules: the
 * CharacterList reader, the token table, and the whole bridge end to end
 * against a fake UDP game server.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as dgram from 'dgram';
import { existsSync, mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { gunzipSync } from 'zlib';
import { WebSocket } from 'ws';
import { automationAllowed, resolveBridgeConfig, type BridgeConfig } from '../services/ws-tcp-bridge/src/bridgeUtil';
import { createBridgeServer, type BridgeServer } from '../services/ws-tcp-bridge/src/server';
import { RoutineTokens, TOKEN_GRACE_MS, readCharacterListAccount, readCharacterListAccount1999 } from '../services/ws-tcp-bridge/src/routines';
import { EXAMPLE_HUNT_PROFILE, emptyRoutineDoc } from '../packages/shared/src/routines/index';

function str16(s: string): Buffer {
  const b = Buffer.from(s, 'latin1');
  const out = Buffer.alloc(2 + b.length + ((4 - ((2 + b.length) % 4)) % 4));
  out.writeUInt16LE(b.length, 0);
  b.copy(out, 2);
  return out;
}
const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0, 0); return b; };

/** A server datagram carrying ACE's GameMessageCharacterList (with an ACK header ahead of the fragment, as ACE sends it). */
function characterListPacket(account: string, names: string[], opcode = 0xf658): Buffer {
  const body = Buffer.concat([
    u32(opcode), u32(0), u32(names.length),
    ...names.flatMap((n, i) => [u32(0x50000001 + i), str16(n), u32(0)]),
    u32(0), u32(11), str16(account), u32(1), u32(1),
  ]);
  const frag = Buffer.concat([u32(7), u32(0x80000001), Buffer.from([1, 0]), Buffer.alloc(2), Buffer.alloc(4), body]);
  frag.writeUInt16LE(frag.length, 10);
  const head = Buffer.alloc(20);
  head.writeUInt32LE(3, 0);
  head.writeUInt32LE(0x4 | 0x4000, 4);
  return Buffer.concat([head, u32(2), frag]);
}

describe('reading the account from the server\'s CharacterList', () => {
  it('reads it past the characters (odd name lengths pad to 4) and the ACK header', () => {
    expect(readCharacterListAccount(characterListPacket('agentclaude', ['Claude', 'Sho', 'Abcde']))).toBe('agentclaude');
    expect(readCharacterListAccount(characterListPacket('Testacjs', []))).toBe('Testacjs');
  });

  it('ignores every other message and garbage', () => {
    expect(readCharacterListAccount(characterListPacket('x', [], 0xf659))).toBeNull();
    expect(readCharacterListAccount(Buffer.alloc(10))).toBeNull();
    const cut = characterListPacket('agentclaude', ['Claude']);
    expect(readCharacterListAccount(cut.subarray(0, cut.length - 20))).toBeNull();
  });
});

describe('reading the account from an AC1999 server\'s CharacterList', () => {
  it('finds it in the real 1999 session capture, every time the server sends the list', () => {
    const s2c = gunzipSync(readFileSync(resolve(__dirname, 'fixtures', 'ac1999-session-001.jsonl.gz')))
      .toString().trim().split('\n').map((l) => JSON.parse(l))
      .filter((j) => j.d === 's2c').map((j) => Buffer.from(j.b, 'base64'));
    const found = s2c.map(readCharacterListAccount1999).filter((a) => a !== null);
    expect(found.length).toBeGreaterThan(0);
    expect(new Set(found)).toEqual(new Set(['acjsdbja']));
    expect(s2c.map(readCharacterListAccount).filter((a) => a !== null)).toEqual([]); // the EoL reader never misreads 1999
  });
});

describe('routine tokens', () => {
  it('one per session; valid while it lives and for the grace period after', () => {
    let t = 0;
    const tokens = new RoutineTokens(() => t);
    const a = tokens.issue(1, 'local-eor', 'agentclaude');
    expect(tokens.issue(1, 'local-eor', 'agentclaude')).toBe(a);
    expect(tokens.lookup(a)).toEqual({ server: 'local-eor', account: 'agentclaude' });
    t = 10 * TOKEN_GRACE_MS;
    expect(tokens.lookup(a)).not.toBeNull(); // still logged in
    tokens.sessionEnded(1);
    t += TOKEN_GRACE_MS - 1;
    expect(tokens.lookup(a)).not.toBeNull();
    t += 2;
    expect(tokens.lookup(a)).toBeNull();
    expect(tokens.lookup('f'.repeat(48))).toBeNull();
  });
});

// ─── End to end ───

const silent = () => {};
function config(env: Record<string, string>, port: number): BridgeConfig {
  const c = resolveBridgeConfig(['0', '127.0.0.1', String(port), String(port + 1)], { BRIDGE_SERVERS_URL: 'none', BRIDGE_SERVERS_CACHE: 'none', ...env });
  c.wsPort = 0;
  return c;
}
function open(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => { const ws = new WebSocket(url); ws.once('open', () => resolve(ws)); ws.once('error', reject); });
}
function textReply(ws: WebSocket, text: string): Promise<any> {
  return new Promise((resolve) => {
    const on = (d: Buffer, binary: boolean) => { if (!binary) { ws.off('message', on); resolve(JSON.parse(d.toString())); } };
    ws.on('message', on);
    ws.send(text);
  });
}
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) { if (Date.now() - start > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); }
}

describe('/routines through the bridge', () => {
  let bridge: BridgeServer | null = null;
  let udp: dgram.Socket | null = null;
  afterEach(async () => { await bridge?.shutdown(); bridge = null; udp?.close(); udp = null; });

  it('a logged-in session reads and writes only its own account\'s routines', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-routines-'));
    udp = dgram.createSocket('udp4');
    const got: dgram.RemoteInfo[] = [];
    udp.on('message', (_m, r) => got.push(r));
    await new Promise<void>((r) => udp!.bind(0, '127.0.0.1', () => r()));
    const srvPort = udp.address().port;
    let clock = Date.now();
    bridge = createBridgeServer(config({ BRIDGE_ROUTINES_DIR: dir }, srvPort), { log: silent, now: () => clock });
    const port = await bridge.listen();
    const base = `http://127.0.0.1:${port}/routines`;
    const ws = await open(`ws://127.0.0.1:${port}/`);

    // No token before the server has logged the session in, and none without one.
    expect(await textReply(ws, 'routines')).toEqual({ routines: null, reason: 'not logged in yet', automation: false, preview: false });
    expect((await fetch(base)).status).toBe(401);

    // The client's packets open the UDP leg; the server answers with the CharacterList.
    const pkt = Buffer.alloc(24); pkt.writeUInt32LE(0x10000, 4);
    ws.send(pkt);
    await until(() => got.length > 0);
    udp.send(characterListPacket('agentclaude', ['Claude']), got[0].port, got[0].address);
    let r: any = null;
    for (let i = 0; i < 50 && !r?.routines; i++) { r = await textReply(ws, 'routines'); if (!r.routines) await new Promise((x) => setTimeout(x, 20)); }
    expect(r.routines).toMatchObject({ server: 'local-eor', account: 'agentclaude' });
    const auth = { authorization: `Bearer ${r.routines.token}` };

    const empty = await fetch(base, { headers: auth });
    expect(empty.status).toBe(200);
    expect(empty.headers.get('access-control-allow-origin')).toBe('*');
    expect(await empty.json()).toMatchObject({ server: 'local-eor', account: 'agentclaude', profiles: [] });

    const doc = { ...emptyRoutineDoc('local-eor', 'agentclaude'), profiles: [EXAMPLE_HUNT_PROFILE] };
    const put = await fetch(base, { method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(doc) });
    expect(put.status).toBe(200);
    const file = join(dir, 'local-eor', 'agentclaude.json');
    expect(JSON.parse(readFileSync(file, 'utf8')).profiles[0].name).toBe(EXAMPLE_HUNT_PROFILE.name);
    expect((await (await fetch(base, { headers: auth })).json()).profiles).toHaveLength(1);

    // Invalid documents and other accounts' documents are refused, and nothing is written for them.
    const bad = await fetch(base, { method: 'PUT', headers: auth, body: JSON.stringify({ ...doc, profiles: [{ ...EXAMPLE_HUNT_PROFILE, initialState: 'Nowhere' }] }) });
    expect(bad.status).toBe(422);
    expect((await bad.json()).issues[0].message).toMatch(/no state named "Nowhere"/);
    const other = await fetch(base, { method: 'PUT', headers: auth, body: JSON.stringify({ ...doc, account: 'testacjs' }) });
    expect(other.status).toBe(422);
    expect(existsSync(join(dir, 'local-eor', 'testacjs.json'))).toBe(false);
    expect((await fetch(base, { headers: { authorization: `Bearer ${'0'.repeat(48)}` } })).status).toBe(401);
    expect((await fetch(base, { method: 'OPTIONS' })).status).toBe(204);

    // After the session ends the token lasts the grace period, then stops working.
    ws.close();
    await until(() => bridge!.snapshot().sessions === 0);
    expect((await fetch(base, { headers: auth })).status).toBe(200);
    clock += TOKEN_GRACE_MS + 1;
    expect((await fetch(base, { headers: auth })).status).toBe(401);
  });

  it('the automation UI allowlist: by the account the server reported, per server or any server', async () => {
    expect(automationAllowed(['local-eor:agentclaude'], 'local-eor', 'AgentClaude')).toBe(true);
    expect(automationAllowed(['local-eor:agentclaude'], 'coldeve', 'agentclaude')).toBe(false);
    expect(automationAllowed(['*:agentclaude', 'jake'], 'coldeve', 'agentclaude')).toBe(true);
    expect(automationAllowed(['jake'], 'coldeve', 'Jake')).toBe(true);
    expect(automationAllowed([], 'local-eor', 'agentclaude')).toBe(false);
    // `*` opens the automation UI to every account; `server:*` to every account on that server.
    expect(automationAllowed(['*'], 'coldeve', 'anyone')).toBe(true);
    expect(automationAllowed(['coldeve:*'], 'Coldeve', 'anyone')).toBe(true);
    expect(automationAllowed(['coldeve:*'], 'local-eor', 'anyone')).toBe(false);
    expect(automationAllowed(['*:*'], 'local-eor', 'anyone')).toBe(true);
    expect(config({ BRIDGE_AUTOMATION_ACCOUNTS: ' local-eor:agentclaude , jake ' }, 9000).automationAccounts).toEqual(['local-eor:agentclaude', 'jake']);
    // Preview UI (the Virindi Views bar): its own list, else the connector's; neither is nobody.
    expect(config({ BRIDGE_PREVIEW_ACCOUNTS: 'jake' }, 9000).previewAccounts).toEqual(['jake']);
    expect(config({ BRIDGE_MCP_ACCOUNTS: 'coldeve:jake' }, 9000).previewAccounts).toEqual(['coldeve:jake']);
    expect(config({ BRIDGE_PREVIEW_ACCOUNTS: '', BRIDGE_MCP_ACCOUNTS: 'jake' }, 9000).previewAccounts).toEqual([]);
    expect(config({}, 9000).previewAccounts).toEqual([]);

    // On the wire: a production bridge (no routines kept) still says whether this account has the UI.
    udp = dgram.createSocket('udp4');
    const got: dgram.RemoteInfo[] = [];
    udp.on('message', (_m, r) => got.push(r));
    await new Promise<void>((r) => udp!.bind(0, '127.0.0.1', () => r()));
    bridge = createBridgeServer(config({ BRIDGE_ROUTINES_DIR: 'none', BRIDGE_AUTOMATION_ACCOUNTS: 'local-eor:agentclaude', BRIDGE_PREVIEW_ACCOUNTS: 'agentclaude' }, udp.address().port), { log: silent });
    const port = await bridge.listen();
    const login = async (account: string) => {
      const ws = await open(`ws://127.0.0.1:${port}/`);
      const before = got.length;
      const pkt = Buffer.alloc(24); pkt.writeUInt32LE(0x10000, 4);
      ws.send(pkt);
      await until(() => got.length > before);
      udp!.send(characterListPacket(account, ['Someone']), got[got.length - 1].port, got[got.length - 1].address);
      let r: any = null;
      // The bridge reads the account as the CharacterList passes; poll briefly for it.
      for (let i = 0; i < 25 && !r?.automation; i++) { r = await textReply(ws, 'routines'); if (!r.automation) await new Promise((x) => setTimeout(x, 20)); }
      ws.close();
      return r;
    };
    // It names the account (as the server reported it) so the page keeps routines in its own storage.
    expect(await login('agentclaude')).toEqual({ routines: null, reason: 'routines are not kept on this bridge', automation: true, preview: true, server: 'local-eor', account: 'agentclaude' });
    const other = await login('somebodyelse');
    expect(other).toMatchObject({ routines: null, automation: false, preview: false });
  });

  it('a production bridge keeps no routines unless BRIDGE_ROUTINES_DIR names a volume', async () => {
    expect(config({ NODE_ENV: 'production' }, 9000).routinesDir).toBeNull();
    expect(config({ NODE_ENV: 'production', BRIDGE_ROUTINES_DIR: '/data/routines' }, 9000).routinesDir).toBe('/data/routines');
    expect(config({ BRIDGE_ROUTINES_DIR: 'none' }, 9000).routinesDir).toBeNull();
    bridge = createBridgeServer(config({ NODE_ENV: 'production', BRIDGE_ALLOWED_ORIGINS: '*' }, 9000), { log: silent });
    const port = await bridge.listen();
    expect((await fetch(`http://127.0.0.1:${port}/routines`)).status).toBe(404);
    const ws = await open(`ws://127.0.0.1:${port}/`);
    expect(await textReply(ws, 'routines')).toEqual({ routines: null, reason: 'routines are not kept on this bridge', automation: false, preview: false });
    ws.close();
  });
});
