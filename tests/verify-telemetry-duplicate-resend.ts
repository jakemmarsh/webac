/**
 * BUG.telemetry-duplicate-resend — production, build 327ed434 (AC1999,
 * trace 481b381ba168c5dc, 2026-10-15T03:52:10Z): one logout logged two
 * client_world world_left lines 1 ms apart, identical but for `lateMs=0` on
 * the second. The logout's keepalive fetch reached the bridge, then its
 * promise rejected as the epilogue's relaunch reloaded the page, and the
 * TelemetryOutbox resent it from the pagehide.
 *
 * Drives the real modules: TelemetryOutbox (an `eid` stamped once at post,
 * kept on every resend), WorldReporter / PreworldReporter / ErrorReporter
 * with their real install() listeners, and a real bridge
 * (createBridgeServer, POST /client-preworld and /client-errors over HTTP)
 * whose RecentEventIds logs each id once. The reporters and the bridge are
 * shared by every era (end of retail, Dark Majesty, AC1999); the logout case
 * runs each era's id through them.
 */
import { describe, it, expect } from 'vitest';
import { TelemetryOutbox, newEventId } from '../packages/renderer/src/telemetry/TelemetryOutbox';
import { WorldReporter } from '../packages/renderer/src/telemetry/WorldReporter';
import { PreworldReporter } from '../packages/renderer/src/telemetry/PreworldReporter';
import { ErrorReporter } from '../packages/renderer/src/telemetry/ErrorReporter';
import { resolveBridgeConfig } from '../services/ws-tcp-bridge/src/bridgeUtil';
import { createBridgeServer } from '../services/ws-tcp-bridge/src/server';
import { sanitizeClientPreworld } from '../services/ws-tcp-bridge/src/clientPreworld';
import { sanitizeClientWorld } from '../services/ws-tcp-bridge/src/clientWorld';
import { sanitizeClientError } from '../services/ws-tcp-bridge/src/clientErrors';
import { RecentEventIds, RECENT_IDS_MAX, RECENT_IDS_TTL_MS } from '../services/ws-tcp-bridge/src/eventIds';

const ERAS = ['eor', 'dark-majesty', 'ac1999-retail'] as const;
const EID = /^[0-9a-f]{12}$/;
type Line = [string, string, Record<string, unknown>];

function fakeWindow() {
  const winL = new Map<string, Array<() => void>>();
  const docL = new Map<string, Array<() => void>>();
  const ticks: Array<() => void> = [];
  const add = (m: Map<string, Array<() => void>>) => (t: string, l: () => void) => { m.set(t, [...(m.get(t) ?? []), l]); };
  const win = { addEventListener: add(winL), setInterval: (f: () => void) => { ticks.push(f); return 1; } };
  const doc = { visibilityState: 'visible', addEventListener: add(docL) };
  return {
    win, doc,
    fire: (t: string) => (winL.get(t) ?? []).forEach(f => f()),
    hide: () => { doc.visibilityState = 'hidden'; (docL.get('visibilitychange') ?? []).forEach(f => f()); },
    tick: () => ticks.forEach(f => f()),
  };
}

const flush = () => new Promise<void>(r => setTimeout(r, 0));

/** A real bridge on a free port, its log lines collected. */
async function bridge() {
  const c = resolveBridgeConfig([], { BRIDGE_SERVERS_URL: 'none', BRIDGE_SERVERS_CACHE: 'none' });
  c.wsPort = 0;
  const logs: Line[] = [];
  const b = createBridgeServer(c, { log: (level, event, fields) => { logs.push([level, event, fields ?? {}]); } });
  const port = await b.listen();
  return { logs, base: `http://127.0.0.1:${port}`, shutdown: () => b.shutdown() };
}

/**
 * The page's fetch at a logout: every request reaches the bridge, and while
 * `unloading` its promise rejects anyway (the page reloading under it).
 */
function unloadingTransport() {
  const state = { unloading: false, sends: 0, inflight: [] as Array<Promise<unknown>> };
  const send = (url: string, body: string): Promise<void> => {
    state.sends++;
    const p = fetch(url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body }).then(async () => {
      if (state.unloading) throw new TypeError('Failed to fetch');
    });
    state.inflight.push(p.catch(() => undefined));
    return p;
  };
  return { state, send, settle: async () => { await Promise.all(state.inflight); await flush(); } };
}

describe('the production duplicate: a delivered send that rejects at unload is logged once', () => {
  for (const era of ERAS) {
    it(`${era}: logout → epilogue reload: world_left is resent from the pagehide, the bridge logs it once`, async () => {
      const br = await bridge();
      try {
        const t = unloadingTransport();
        const clock = { t: 0 };
        const w = fakeWindow();
        const endpoint = `${br.base}/client-preworld`;
        const world = new WorldReporter({ endpoint, build: '327ed4346029', trace: '481b381ba168c5dc', era: () => era, server: () => 'srv', now: () => clock.t, send: t.send });
        const pre = new PreworldReporter({ endpoint, build: '327ed4346029', trace: '481b381ba168c5dc', era: () => era, server: () => 'srv', screen: () => 'world', now: () => clock.t, send: t.send });
        pre.install(w.win as never, w.doc as never);
        world.install(w.win as never, w.doc as never);
        world.enteredWorld();
        clock.t = 60_000;
        w.tick(); // first_minute still_in
        await t.settle();
        // 28 minutes in, the player logs out; the epilogue relaunch reloads the page as the fetch is in flight.
        clock.t = 1_679_962;
        t.state.unloading = true;
        world.left('logout');
        pre.leavingForReload('epilogue'); // from the world: nothing reported
        await t.settle();
        expect(world.pendingSends).toBe(1); // the outbox saw a failure and holds it
        w.hide();
        w.fire('pagehide');
        await t.settle();
        expect(t.state.sends).toBe(3); // first_minute, world_left, and world_left's resend
        const lefts = br.logs.filter(l => l[1] === 'client_world' && l[2].outcome === 'world_left');
        expect(lefts).toHaveLength(1);
        expect(lefts[0][2]).toMatchObject({ era, exit: 'logout', sessionMs: 1_679_962, trace: '481b381ba168c5dc', eid: expect.stringMatching(EID) });
        expect(lefts[0][2]).not.toHaveProperty('lateMs'); // the first arrival is the one logged
        expect(br.logs.filter(l => l[1] === 'client_world')).toHaveLength(2);
        expect(br.logs.filter(l => l[1] === 'client_preworld')).toHaveLength(0);
      } finally { await br.shutdown(); }
    });
  }

  it('an error report sent as the page unloads is logged once too (POST /client-errors)', async () => {
    const br = await bridge();
    try {
      const t = unloadingTransport();
      const w = fakeWindow();
      const er = new ErrorReporter({ endpoint: `${br.base}/client-errors`, build: 'b', screen: () => 'world', send: t.send });
      er.install(w.win as never);
      t.state.unloading = true;
      er.report('error', 'boom at unload');
      await t.settle();
      w.fire('pagehide');
      await t.settle();
      expect(t.state.sends).toBe(2);
      const lines = br.logs.filter(l => l[1] === 'client_error');
      expect(lines).toHaveLength(1);
      expect(lines[0][2]).toMatchObject({ message: 'boom at unload', eid: expect.stringMatching(EID) });
    } finally { await br.shutdown(); }
  });

  it('a page_reload posted before a reload whose fetch rejects is logged once', async () => {
    const br = await bridge();
    try {
      const t = unloadingTransport();
      const w = fakeWindow();
      const pre = new PreworldReporter({ endpoint: `${br.base}/client-preworld`, build: 'b', era: () => 'ac1999-retail', server: () => 'ac1999', screen: () => 'char-select', send: t.send });
      pre.install(w.win as never, w.doc as never);
      t.state.unloading = true;
      pre.leavingForReload('epilogue');
      await t.settle();
      w.fire('pagehide'); // page_left is not reported after a deliberate reload; the held page_reload goes again
      await t.settle();
      expect(t.state.sends).toBe(2);
      const lines = br.logs.filter(l => l[1] === 'client_preworld');
      expect(lines.map(l => [l[2].outcome, l[2].token])).toEqual([['page_reload', 'epilogue']]);
    } finally { await br.shutdown(); }
  });

  it('distinct events are all logged; an event without an id (an older page) is logged every time', async () => {
    const br = await bridge();
    try {
      const post = (body: unknown) => fetch(`${br.base}/client-preworld`, { method: 'POST', body: JSON.stringify(body) });
      const sent: Array<Promise<unknown>> = [];
      const box = new TelemetryOutbox((u, b) => { const p = fetch(u, { method: 'POST', body: b }); sent.push(p); return p; }, () => 0);
      box.post(`${br.base}/client-preworld`, JSON.stringify({ outcome: 'page_hidden', screen: 'char-select' }));
      box.post(`${br.base}/client-preworld`, JSON.stringify({ outcome: 'page_hidden', screen: 'char-select' }));
      await Promise.all(sent);
      expect((await post({ outcome: 'page_left', screen: 'boot' })).status).toBe(204);
      expect((await post({ outcome: 'page_left', screen: 'boot' })).status).toBe(204);
      const lines = br.logs.filter(l => l[1] === 'client_preworld');
      expect(lines.map(l => l[2].outcome)).toEqual(['page_hidden', 'page_hidden', 'page_left', 'page_left']);
      expect(lines[0][2].eid).not.toBe(lines[1][2].eid);
      // A repeated id answers 204 (the page has nothing to retry) and logs nothing.
      const eid = lines[0][2].eid;
      expect((await post({ outcome: 'page_hidden', screen: 'char-select', eid })).status).toBe(204);
      expect(br.logs.filter(l => l[1] === 'client_preworld')).toHaveLength(4);
    } finally { await br.shutdown(); }
  });
});

describe('TelemetryOutbox event ids', () => {
  it('stamps each event once at post and keeps the id (and adds lateMs) on every resend', async () => {
    const got: Array<Record<string, unknown>> = [];
    let up = false;
    const clock = { t: 0 };
    const box = new TelemetryOutbox((_u, b) => {
      got.push(JSON.parse(b) as Record<string, unknown>);
      return up ? Promise.resolve() : Promise.reject(new TypeError('Failed to fetch'));
    }, () => clock.t, true);
    box.post('u', JSON.stringify({ outcome: 'world_left', exit: 'disconnected' }));
    box.post('u', JSON.stringify({ outcome: 'world_left', exit: 'disconnected' }));
    await flush();
    clock.t = 1000; box.retry(true); await flush();
    up = true;
    clock.t = 2000; box.retry(true); await flush();
    expect(got).toHaveLength(6);
    const [a, b] = [got[0].eid, got[1].eid];
    expect(a).toMatch(EID);
    expect(b).toMatch(EID);
    expect(a).not.toBe(b);
    expect(got.map(g => g.eid)).toEqual([a, b, a, b, a, b]);
    expect(got.map(g => g.lateMs)).toEqual([undefined, undefined, 1000, 1000, 2000, 2000]);
  });

  it('a body that is not a JSON object goes as it is; an id the page set itself is kept', async () => {
    const got: string[] = [];
    const box = new TelemetryOutbox((_u, b) => { got.push(b); }, () => 0);
    box.post('u', 'plain text');
    box.post('u', '[1,2]');
    box.post('u', JSON.stringify({ outcome: 'x', eid: 'abcdef012345' }));
    expect(got).toEqual(['plain text', '[1,2]', '{"outcome":"x","eid":"abcdef012345"}']);
  });

  it('ids are distinct, and still form from the clock without Web Crypto (never Math.random)', () => {
    const ids = new Set(Array.from({ length: 2000 }, () => newEventId()));
    expect(ids.size).toBe(2000);
    const realCrypto = globalThis.crypto;
    const realRandom = Math.random;
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    Math.random = () => { throw new Error('Math.random used'); };
    try {
      const fallback = Array.from({ length: 50 }, () => newEventId());
      for (const id of fallback) expect(id).toMatch(/^[a-z0-9]{8,32}$/);
      expect(new Set(fallback).size).toBe(50);
      // The bridge accepts the fallback shape.
      expect(sanitizeClientPreworld({ outcome: 'page_left', eid: fallback[0] })).toMatchObject({ eid: fallback[0] });
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: realCrypto, configurable: true });
      Math.random = realRandom;
    }
  });
});

describe('the bridge side: sanitizers and RecentEventIds', () => {
  it('every sanitizer keeps a well-formed eid and drops a malformed one', () => {
    expect(sanitizeClientPreworld({ outcome: 'page_left', eid: 'abcdef012345' })).toMatchObject({ eid: 'abcdef012345' });
    expect(sanitizeClientWorld({ outcome: 'world_left', exit: 'logout', eid: 'abcdef012345' })).toMatchObject({ eid: 'abcdef012345' });
    expect(sanitizeClientError({ kind: 'error', message: 'm', eid: 'abcdef012345' })).toMatchObject({ eid: 'abcdef012345' });
    for (const bad of ['short', 'NOT-HEX!!', 'x'.repeat(33), 12345678, null]) {
      expect(sanitizeClientPreworld({ outcome: 'page_left', eid: bad })).not.toHaveProperty('eid');
      expect(sanitizeClientWorld({ outcome: 'world_left', eid: bad })).not.toHaveProperty('eid');
      expect(sanitizeClientError({ kind: 'error', message: 'm', eid: bad })).not.toHaveProperty('eid');
    }
  });

  it('drops a repeat id, accepts an unseen one, never treats a missing id as a repeat', () => {
    const ids = new RecentEventIds(() => 0);
    expect(ids.repeat('aaaaaaaaaaaa')).toBe(false);
    expect(ids.repeat('aaaaaaaaaaaa')).toBe(true);
    expect(ids.repeat('bbbbbbbbbbbb')).toBe(false);
    expect(ids.repeat(undefined)).toBe(false);
    expect(ids.repeat(undefined)).toBe(false);
    expect(ids.size).toBe(2);
  });

  it(`stays bounded: at most ${RECENT_IDS_MAX} ids (the oldest forgotten first), each forgotten after ${RECENT_IDS_TTL_MS / 60_000} min`, () => {
    const clock = { t: 0 };
    const ids = new RecentEventIds(() => clock.t);
    for (let i = 0; i < RECENT_IDS_MAX + 500; i++) ids.repeat(`id${String(i).padStart(10, '0')}`);
    expect(ids.size).toBe(RECENT_IDS_MAX);
    expect(ids.repeat(`id${String(0).padStart(10, '0')}`)).toBe(false); // forgotten (and now remembered again)
    expect(ids.repeat(`id${String(RECENT_IDS_MAX + 499).padStart(10, '0')}`)).toBe(true);
    clock.t = RECENT_IDS_TTL_MS - 1;
    expect(ids.repeat(`id${String(RECENT_IDS_MAX + 499).padStart(10, '0')}`)).toBe(true);
    clock.t = RECENT_IDS_TTL_MS + 1;
    expect(ids.repeat('cccccccccccc')).toBe(false);
    expect(ids.size).toBe(1); // everything older than the window expired
  });
});
