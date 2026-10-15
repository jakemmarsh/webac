/**
 * Production, build 633db4ab (AC1999 "ac1999", trace 7c5f0bd27979717e,
 * 2026-10-14): a player eleven minutes into the world ended on a page_left
 * from screen "connecting" (8 s on it), and no world_left ever arrived.
 * Every way out of the world reports world_left first (teardownWorldState),
 * so the event was sent and lost: a drop is when the network is gone, and
 * the old transport's sendBeacon was never retried. The 8 s on "connecting"
 * was the automatic resume's connecting screen (SessionLifecycle), which
 * read the same as a first connect.
 *
 * Drives the real modules: TelemetryOutbox (keeps an event the transport
 * refused, sends it again on the tick / online / hide / leave, with lateMs),
 * WorldReporter and PreworldReporter through it with their real install()
 * listeners, preworldScreenFor's 'resuming' and connecting-screen rules, the
 * browser transport (fetch while visible, beacon when hidden), and the
 * bridge sanitizers that must keep 'resuming' and lateMs. The reporters and
 * the screen rules are shared by every era (end of retail, Dark Majesty,
 * AC1999); the cases run each era's id through them.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { TelemetryOutbox, defaultTelemetrySend, OUTBOX_MAX, RETRY_MS } from '../packages/renderer/src/telemetry/TelemetryOutbox';
import { WorldReporter } from '../packages/renderer/src/telemetry/WorldReporter';
import { PreworldReporter, preworldScreenFor, type PreworldEvent, type PreworldScreenState } from '../packages/renderer/src/telemetry/PreworldReporter';
import { ErrorReporter } from '../packages/renderer/src/telemetry/ErrorReporter';
import { sanitizeClientPreworld } from '../services/ws-tcp-bridge/src/clientPreworld';
import { sanitizeClientWorld } from '../services/ws-tcp-bridge/src/clientWorld';

const ERAS = ['eor', 'dark-majesty', 'ac1999-retail'] as const;

/** A network that can be cut: sends reject while it is down, as fetch does offline. */
function network() {
  const delivered: Array<{ url: string; body: Record<string, unknown> }> = [];
  const net = { up: true, attempts: 0 };
  const send = (url: string, body: string): Promise<void> => {
    net.attempts++;
    if (!net.up) return Promise.reject(new TypeError('Failed to fetch'));
    delivered.push({ url, body: JSON.parse(body) as Record<string, unknown> });
    return Promise.resolve();
  };
  return { net, delivered, send };
}

function fakeWindow() {
  const winL = new Map<string, () => void>();
  const docL = new Map<string, () => void>();
  const ticks: Array<() => void> = [];
  const win = { addEventListener: (t: string, l: () => void) => { winL.set(t, l); }, setInterval: (f: () => void) => { ticks.push(f); return 1; } };
  const doc = { visibilityState: 'visible', addEventListener: (t: string, l: () => void) => { docL.set(t, l); } };
  return { win, doc, winL, docL, tick: () => ticks.forEach(f => f()) };
}

const flush = () => new Promise<void>(r => setTimeout(r, 0));

describe('TelemetryOutbox', () => {
  it('keeps what the network refused and sends it again, late-stamped, on the spaced tick or when forced', async () => {
    const { net, delivered, send } = network();
    const clock = { t: 0 };
    const box = new TelemetryOutbox(send, () => clock.t, true);
    net.up = false;
    box.post('http://b/client-preworld', JSON.stringify({ outcome: 'world_left', sessionMs: 685000 }));
    await flush();
    expect(box.pending).toBe(1);
    // Still down at the next allowed retry: it stays, its first failure still dates it.
    clock.t = RETRY_MS;
    box.retry();
    await flush();
    expect(box.pending).toBe(1);
    net.up = true;
    // Inside the spacing nothing goes; forced (online / hidden / leaving) it does.
    clock.t = RETRY_MS + 1000;
    box.retry();
    await flush();
    expect(delivered).toHaveLength(0);
    clock.t = 10_000;
    box.retry(true);
    await flush();
    expect(box.pending).toBe(0);
    expect(delivered).toEqual([{ url: 'http://b/client-preworld', body: { outcome: 'world_left', sessionMs: 685000, lateMs: 10_000, eid: expect.stringMatching(/^[0-9a-f]{12}$/) } }]);
  });

  it('an event that went at once has no lateMs; a transport that returns nothing or throws is never retried', async () => {
    const { delivered, send } = network();
    const box = new TelemetryOutbox(send, () => 0, true);
    box.post('u', JSON.stringify({ outcome: 'enter_ok' }));
    await flush();
    expect(delivered[0].body).toEqual({ outcome: 'enter_ok', eid: expect.stringMatching(/^[0-9a-f]{12}$/) });
    let calls = 0;
    const fireAndForget = new TelemetryOutbox(() => { calls++; }, () => 0);
    fireAndForget.post('u', '{}');
    const throwing = new TelemetryOutbox(() => { calls++; throw new Error('broken'); }, () => 0);
    expect(() => throwing.post('u', '{}')).not.toThrow();
    await flush();
    fireAndForget.retry(true); throwing.retry(true);
    expect([fireAndForget.pending, throwing.pending, calls]).toEqual([0, 0, 2]);
  });

  it(`holds at most OUTBOX_MAX (${OUTBOX_MAX}); the oldest goes first`, async () => {
    const { net, delivered, send } = network();
    const box = new TelemetryOutbox(send, () => 0);
    net.up = false;
    for (let i = 0; i < OUTBOX_MAX + 3; i++) box.post('u', JSON.stringify({ i }));
    await flush();
    expect(box.pending).toBe(OUTBOX_MAX);
    net.up = true;
    box.retry(true);
    await flush();
    expect(delivered.map(d => d.body.i)).toEqual(Array.from({ length: OUTBOX_MAX }, (_, k) => k + 3));
  });
});

describe('the production drop: world_left survives the network going away', () => {
  for (const era of ERAS) {
    it(`${era}: a drop while offline keeps world_left; it arrives when the page leaves, with how late it is`, async () => {
      const { net, delivered, send } = network();
      const clock = { t: 0 };
      const w = fakeWindow();
      const r = new WorldReporter({ endpoint: 'http://b/client-preworld', build: '633db4ab', trace: '7c5f0bd27979717e', era: () => era, server: () => 'srv', now: () => clock.t, send });
      r.install(w.win as never, w.doc as never);
      r.enteredWorld();
      clock.t = 60_000;
      w.tick(); // first_minute still_in, delivered
      await flush();
      expect(delivered.map(d => [d.body.outcome, d.body.exit])).toEqual([['first_minute', 'still_in']]);
      // 11 minutes in, the network goes and the socket closes: main.ts's 'disconnected' → left('disconnected').
      clock.t = 685_000;
      net.up = false;
      r.left('disconnected');
      await flush();
      expect(r.pendingSends).toBe(1);
      // The resume's connecting screen, ticking while offline: still held.
      for (let s = 1; s <= 8; s++) { clock.t += 1000; w.tick(); }
      await flush();
      expect(r.pendingSends).toBe(1);
      // The network is back and the player reloads (F5): the pagehide sends the held world_left.
      net.up = true;
      clock.t += 500;
      w.winL.get('pagehide')!();
      await flush();
      expect(r.pendingSends).toBe(0);
      const left = delivered[1].body;
      expect(left).toMatchObject({ outcome: 'world_left', exit: 'disconnected', sessionMs: 685_000, era, lateMs: 8_500 });
      // The bridge keeps it whole, lateMs included.
      expect(sanitizeClientWorld(left)).toMatchObject({ outcome: 'world_left', exit: 'disconnected', sessionMs: 685_000, lateMs: 8_500 });
    });
  }

  it('the browser coming back online sends it at once', async () => {
    const { net, delivered, send } = network();
    const w = fakeWindow();
    const r = new WorldReporter({ endpoint: 'http://b/c', build: 'b', trace: 'feedc0de12345678', era: () => 'eor', server: () => null, now: () => 0, send });
    r.install(w.win as never, w.doc as never);
    r.enteredWorld();
    net.up = false;
    r.left('disconnected');
    await flush();
    net.up = true;
    w.winL.get('online')!();
    await flush();
    expect(delivered.map(d => d.body.exit)).toEqual(['disconnected']);
  });

  it('PreworldReporter and ErrorReporter keep refused events too', async () => {
    const { net, delivered, send } = network();
    const w = fakeWindow();
    const p = new PreworldReporter({ endpoint: 'http://b/c', build: 'b', era: () => 'ac1999-retail', server: () => 'ac1999', screen: () => 'connecting', send });
    p.install(w.win as never, w.doc as never);
    net.up = false;
    p.dropped();
    await flush();
    net.up = true;
    w.docL.get('visibilitychange')!(); // visible: nothing to report, but nothing forced either
    w.doc.visibilityState = 'hidden';
    w.docL.get('visibilitychange')!();
    await flush();
    expect(delivered.map(d => d.body.outcome)).toContain('dropped');

    const errNet = network();
    const ew = fakeWindow();
    const er = new ErrorReporter({ endpoint: 'http://b/client-errors', build: 'b', screen: () => 'world', send: errNet.send });
    er.install(ew.win as never);
    errNet.net.up = false;
    er.report('error', 'boom');
    await flush();
    errNet.net.up = true;
    ew.winL.get('pagehide')!();
    await flush();
    expect(errNet.delivered.map(d => d.body.message)).toEqual(['boom']);
  });
});

describe('the resume reads as resuming, not a first connect', () => {
  const base: PreworldScreenState = {
    gameStarted: false, disconnected: false, launcherActive: false, eraSwitchPending: false,
    uiScreen: 'character-select', portalSpace: false, charListReceived: false,
  };

  it('the resume\'s connecting screen is "resuming"; a first connect stays "connecting"', () => {
    expect(preworldScreenFor({ ...base, connectingScreen: true, resuming: true })).toBe('resuming');
    expect(preworldScreenFor({ ...base, connectingScreen: true })).toBe('connecting');
    // Its portal space (re-entering) and the Disconnected screen it gives up to keep their names.
    expect(preworldScreenFor({ ...base, resuming: true, portalSpace: true })).toBe('portal-space');
    expect(preworldScreenFor({ ...base, resuming: true, disconnected: true })).toBe('disconnected');
    expect(preworldScreenFor({ ...base, resuming: true, gameStarted: true })).toBe('world');
  });

  it('the connecting screen never reads as char select from the last session\'s list (drop → resume, relaunch)', () => {
    // scheduleResume / relaunchConnectCycle show the connecting screen before connect() clears the old list.
    expect(preworldScreenFor({ ...base, charListReceived: true, connectingScreen: true, resuming: true })).toBe('resuming');
    expect(preworldScreenFor({ ...base, charListReceived: true, connectingScreen: true })).toBe('connecting');
    // A real character select (the list rendered, the connecting screen gone) is unchanged.
    expect(preworldScreenFor({ ...base, charListReceived: true })).toBe('char-select');
    expect(preworldScreenFor({ ...base, charListReceived: true, uiScreen: 'character-create' })).toBe('chargen');
  });

  for (const era of ERAS) {
    it(`${era}: leaving during the resume sends page_left on "resuming", and the bridge keeps it`, () => {
      const sent: PreworldEvent[] = [];
      const clock = { t: 0 };
      const state = { ...base, gameStarted: true } as PreworldScreenState;
      const w = fakeWindow();
      const p = new PreworldReporter({
        endpoint: 'http://b/c', build: 'b', era: () => era, server: () => 'srv', now: () => clock.t,
        screen: () => preworldScreenFor(state), send: (_u, raw) => { sent.push(JSON.parse(raw) as PreworldEvent); },
      });
      p.install(w.win as never, w.doc as never);
      w.tick();
      // The drop: world torn down, the resume's connecting screen.
      Object.assign(state, { gameStarted: false, connectingScreen: true, resuming: true, charListReceived: true });
      clock.t = 1000; w.tick();
      clock.t = 9000;
      w.winL.get('pagehide')!();
      expect(sent.map(e => [e.outcome, e.screen, e.screenMs])).toEqual([['page_left', 'resuming', 8000]]);
      expect(sanitizeClientPreworld(sent[0])).toMatchObject({ outcome: 'page_left', screen: 'resuming', screenMs: 8000 });
    });
  }

  it('the bridge drops a lateMs that is not a bounded whole number', () => {
    const ev = { outcome: 'page_left', screen: 'resuming', pageMs: 1, screenMs: 1 };
    expect(sanitizeClientPreworld({ ...ev, lateMs: -5 })).not.toHaveProperty('lateMs');
    expect(sanitizeClientPreworld({ ...ev, lateMs: 'x' })).not.toHaveProperty('lateMs');
    expect(sanitizeClientPreworld({ ...ev, lateMs: 1500 })).toMatchObject({ lateMs: 1500 });
    expect(sanitizeClientWorld({ outcome: 'world_left', exit: 'logout', lateMs: 1.5 })).not.toHaveProperty('lateMs');
  });
});

describe('the browser transport', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  function stubBrowser(visibility: 'visible' | 'hidden', beaconOk = true) {
    const fetchCalls: Array<[string, RequestInit]> = [];
    const beacons: string[] = [];
    vi.stubGlobal('document', { visibilityState: visibility });
    vi.stubGlobal('navigator', { sendBeacon: (url: string) => { beacons.push(url); return beaconOk; } });
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => { fetchCalls.push([url, init]); return Promise.resolve(new Response(null)); });
    return { fetchCalls, beacons };
  }

  it('a visible page sends by fetch (keepalive, no-cors) so a failure can be seen', () => {
    const b = stubBrowser('visible');
    const r = defaultTelemetrySend('http://b/c', '{}');
    expect(r).toBeInstanceOf(Promise);
    expect(b.beacons).toEqual([]);
    expect(b.fetchCalls[0][1]).toMatchObject({ method: 'POST', keepalive: true, mode: 'no-cors' });
  });

  it('a hidden or leaving page sends by beacon; a refused beacon falls back to fetch', () => {
    const b = stubBrowser('hidden');
    expect(defaultTelemetrySend('http://b/c', '{}')).toBeUndefined();
    expect([b.beacons.length, b.fetchCalls.length]).toEqual([1, 0]);
    vi.unstubAllGlobals();
    const refused = stubBrowser('hidden', false);
    expect(defaultTelemetrySend('http://b/c', '{}')).toBeInstanceOf(Promise);
    expect(refused.fetchCalls).toHaveLength(1);
  });
});
