/**
 * AGENT.routine-store-auth, the client side: the page asks the bridge for
 * its account's /routines token over the game socket (through the network
 * worker, as in play), then loads and saves routines with it. Real
 * NetWorkerClient ↔ hostClientConnection ↔ ClientConnection over a fake
 * socket, and the real RoutineSync over a fake fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hostClientConnection, parseRoutinesGrant, type ConnectionEvent, type NetCommand, type NetReply, type RoutinesGrant } from '@ac/network';
import { NetWorkerClient, type NetWorkerEndpoint } from '../packages/renderer/src/network/NetWorkerClient.js';
import { RoutineSync, localRoutinesKey, routinesHttpUrl } from '../packages/renderer/src/agent/RoutineSync.js';
import { EXAMPLE_HUNT_PROFILE, emptyRoutineDoc } from '../packages/shared/src/routines/index.js';

class FakeWebSocket {
  static readonly OPEN = 1;
  static last: FakeWebSocket | null = null;
  readyState = 0;
  binaryType = 'arraybuffer';
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer | string }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  texts: string[] = [];
  constructor(public url: string) { FakeWebSocket.last = this; }
  send(data: ArrayBuffer | Uint8Array | string): void { if (typeof data === 'string') this.texts.push(data); }
  close(): void { this.readyState = 3; }
  open(): void { this.readyState = FakeWebSocket.OPEN; this.onopen?.({}); }
}

function workerSession() {
  const hostListeners: Array<(ev: { data: NetCommand }) => void> = [];
  const pageListeners: Array<(ev: MessageEvent<NetReply>) => void> = [];
  const stop = hostClientConnection({
    postMessage: (r) => { const c = structuredClone(r); for (const l of pageListeners) l({ data: c } as MessageEvent<NetReply>); },
    addEventListener: (_t, l) => { hostListeners.push(l); },
  });
  const endpoint: NetWorkerEndpoint = {
    postMessage: (cmd) => { const c = structuredClone(cmd); for (const l of hostListeners) l({ data: c }); },
    addEventListener: (_t, l) => { pageListeners.push(l); },
  };
  const client = new NetWorkerClient(endpoint, 'ws://127.0.0.1:9090/?server=x');
  client.autoReconnect = false;
  const events: ConnectionEvent[] = [];
  client.on((e) => events.push(e));
  client.connect('acct', 'pw');
  const ws = FakeWebSocket.last!;
  ws.open();
  return { client, events, ws, stop };
}

let saved: unknown;
beforeEach(() => {
  saved = (globalThis as { WebSocket?: unknown }).WebSocket;
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  (globalThis as { WebSocket?: unknown }).WebSocket = saved;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('the routines grant over the game socket', () => {
  it('reads the bridge\'s answer, and nothing else, as a grant', () => {
    expect(parseRoutinesGrant('{"routines":{"token":"ab","server":"local-eor","account":"agentclaude"}}'))
      .toEqual({ grant: { token: 'ab', server: 'local-eor', account: 'agentclaude' }, reason: null, automation: false, preview: false });
    expect(parseRoutinesGrant('{"routines":null,"reason":"not logged in yet"}')).toEqual({ grant: null, reason: 'not logged in yet', automation: false, preview: false });
    // AGENT.automation-allowlist — the bridge's allowlist answer rides along, with or without a grant.
    expect(parseRoutinesGrant('{"routines":null,"reason":"routines are not kept on this bridge","automation":true}')?.automation).toBe(true);
    // Preview UI (BRIDGE_PREVIEW_ACCOUNTS): off unless the bridge says so.
    expect(parseRoutinesGrant('{"routines":null,"reason":"x","automation":true}')?.preview).toBe(false);
    expect(parseRoutinesGrant('{"routines":null,"reason":"x","preview":true}')?.preview).toBe(true);
    expect(parseRoutinesGrant('{"bridge":"ok"}')).toBeNull();
    expect(parseRoutinesGrant('not json')).toBeNull();
  });

  it('the page asks through the network worker and gets a routinesGrant event back', async () => {
    const s = workerSession();
    s.client.requestRoutinesGrant();
    expect(s.ws.texts).toEqual(['routines']);
    s.ws.onmessage!({ data: '{"routines":{"token":"cd","server":"local-eor","account":"agentclaude"}}' });
    await Promise.resolve();
    const ev = s.events.find((e) => e.type === 'routinesGrant');
    expect(ev?.data).toEqual({ token: 'cd', server: 'local-eor', account: 'agentclaude' });
    expect(s.events.find((e) => e.type === 'automationAccess')?.data).toBe(false);
    s.ws.onmessage!({ data: '{"routines":null,"reason":"routines are not kept on this bridge","automation":true}' });
    await Promise.resolve();
    expect(s.events.filter((e) => e.type === 'automationAccess').map((e) => e.data)).toEqual([false, true]);
    expect(s.events.filter((e) => e.type === 'previewAccess').map((e) => e.data)).toEqual([false, false]);
    // A text frame is never fed to the packet parser (it used to be read as an empty packet).
    expect(s.events.some((e) => e.type === 'error')).toBe(false);
    s.stop();
  });
});

describe('RoutineSync keeps routines in this browser when the bridge keeps none', () => {
  function local() {
    const items = new Map<string, string>();
    const store = { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => { items.set(k, v); } };
    const grant = parseRoutinesGrant('{"routines":null,"reason":"routines are not kept on this bridge","automation":true,"server":"coldeve","account":"Jake"}')!.grant!;
    const fetched: string[] = [];
    const sync: RoutineSync = new RoutineSync(
      () => ({ bridgeUrl: 'wss://bridge.example/', requestRoutinesGrant: () => queueMicrotask(() => sync.onGrant(grant)) }),
      (async (url: string) => { fetched.push(url); return new Response('{}'); }) as unknown as typeof fetch,
      () => store,
    );
    return { sync, items, fetched, grant };
  }

  it('reads the bridge\'s account as a local grant (no token)', () => {
    expect(local().grant).toEqual({ token: '', server: 'coldeve', account: 'Jake', local: true });
  });

  it('loads an empty document, saves a valid one under the server and account, and never calls the bridge', async () => {
    const { sync, items, fetched } = local();
    const first = await sync.load();
    expect(first).toMatchObject({ ok: true, server: 'coldeve', account: 'Jake', doc: { server: 'coldeve', account: 'Jake', profiles: [] } });
    const doc = { ...emptyRoutineDoc('coldeve', 'Jake'), profiles: [EXAMPLE_HUNT_PROFILE] };
    expect((await sync.save(doc)).ok).toBe(true);
    expect(JSON.parse(items.get(localRoutinesKey('coldeve', 'Jake'))!).profiles[0].name).toBe(EXAMPLE_HUNT_PROFILE.name);
    expect(((await sync.load()) as { doc: { profiles: unknown[] } }).doc.profiles).toHaveLength(1);
    expect(fetched).toEqual([]);
  });

  it('turns loot rules an older importer stored switched off (Read, User1–5) into today\'s actions on load', async () => {
    const { sync, items } = local();
    const old = (id: number, label: string) => ({ label, disabled: true, note: `VTClassic action ${id === 4 ? 'Read' : `User${id - 4}`} has no equivalent`, action: 'keep', match: { name: label }, vtc: { action: id } });
    const offByPlayer = { label: 'Off by hand', disabled: true, action: 'keep', match: { name: 'x' } };
    const profile = { ...EXAMPLE_HUNT_PROFILE, loot: [old(4, 'Scrolls'), offByPlayer], lootSets: { Other: [old(6, 'Plugin item')] } };
    items.set(localRoutinesKey('coldeve', 'Jake'), JSON.stringify({ ...emptyRoutineDoc('coldeve', 'Jake'), profiles: [profile] }));
    const r = await sync.load() as { doc: { profiles: Array<{ loot: unknown[]; lootSets: Record<string, unknown[]> }> } };
    const [p] = r.doc.profiles;
    expect(p.loot[0]).toEqual({ label: 'Scrolls', action: 'read', match: { name: 'Scrolls' } });
    expect(p.loot[1]).toEqual(offByPlayer);
    expect(p.lootSets.Other[0]).toEqual({ label: 'Plugin item', note: 'VTClassic action User2: looted and kept', action: 'keep', match: { name: 'Plugin item' }, vtc: { action: 6 } });
  });

  it('refuses an invalid document or another account\'s, as the bridge would', async () => {
    const { sync, items } = local();
    const bad = await sync.save({ ...emptyRoutineDoc('coldeve', 'Jake'), profiles: [{ ...EXAMPLE_HUNT_PROFILE, initialState: 'Nowhere' }] });
    expect(bad).toMatchObject({ ok: false, message: 'not saved: the routine has problems' });
    expect(await sync.save(emptyRoutineDoc('coldeve', 'someoneelse'))).toMatchObject({ ok: false });
    expect(items.size).toBe(0);
  });
});

describe('RoutineSync', () => {
  const grant: RoutinesGrant = { token: 'a'.repeat(48), server: 'local-eor', account: 'agentclaude' };
  function setup(responses: Array<{ status: number; body: unknown }>) {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    let asked = 0;
    const sync: RoutineSync = new RoutineSync(
      () => ({ bridgeUrl: 'wss://bridge.example/?server=x', requestRoutinesGrant: () => { asked++; queueMicrotask(() => sync.onGrant(grant)); } }),
      (async (url: string, init: RequestInit) => {
        requests.push({ url, init });
        const r = responses.shift()!;
        return new Response(JSON.stringify(r.body), { status: r.status });
      }) as unknown as typeof fetch,
    );
    return { sync, requests, asked: () => asked };
  }

  it('maps the bridge\'s socket URL to its /routines endpoint', () => {
    expect(routinesHttpUrl('ws://localhost:9127/')).toBe('http://localhost:9127/routines');
    expect(routinesHttpUrl('wss://bridge.playwebac.com/connect?server=abc')).toBe('https://bridge.playwebac.com/routines');
  });

  it('loads with the session\'s token, asking for it once', async () => {
    const s = setup([{ status: 200, body: { profiles: [] } }, { status: 200, body: { profiles: [1] } }]);
    expect(await s.sync.load()).toEqual({ ok: true, doc: { profiles: [] }, account: 'agentclaude', server: 'local-eor' });
    await s.sync.load();
    expect(s.asked()).toBe(1);
    expect(s.requests[0].url).toBe('https://bridge.example/routines');
    expect((s.requests[0].init.headers as Record<string, string>).authorization).toBe(`Bearer ${grant.token}`);
  });

  it('an expired token is replaced once; a refused save reports the routine\'s problems', async () => {
    const s = setup([{ status: 401, body: { error: 'x' } }, { status: 422, body: { issues: [{ path: 'profiles[0].initialState', message: 'no state named "Nowhere"' }] } }]);
    const r = await s.sync.save({ profiles: [] });
    expect(s.asked()).toBe(2);
    expect(s.requests.map((q) => q.init.method)).toEqual(['PUT', 'PUT']);
    expect(r).toEqual({ ok: false, message: 'not saved: the routine has problems', issues: [{ path: 'profiles[0].initialState', message: 'no state named "Nowhere"' }] });
  });

  it('says why when the bridge grants nothing, and gives up when an old bridge never answers', async () => {
    const refused = new RoutineSync(() => ({ bridgeUrl: 'ws://x/', requestRoutinesGrant: () => queueMicrotask(() => refused.onGrant(null, 'not logged in yet')) }));
    expect(await refused.load()).toEqual({ ok: false, message: 'no routines token: not logged in yet' });
    vi.useFakeTimers();
    const silent = new RoutineSync(() => ({ bridgeUrl: 'ws://x/', requestRoutinesGrant: () => {} }));
    const p = silent.load();
    await vi.advanceTimersByTimeAsync(5000);
    expect(await p).toEqual({ ok: false, message: expect.stringMatching(/did not answer/) });
    expect(await new RoutineSync(() => null).load()).toEqual({ ok: false, message: 'not connected' });
  });
});
