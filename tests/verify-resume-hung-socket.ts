/**
 * BUG.resume-hung-socket — a session socket that never opens, and an automatic
 * resume during a network outage.
 *
 * A browser WebSocket has no open timeout: on a path that drops packets the
 * connect waits for the OS's TCP give-up (21 s on Windows, a minute or more
 * elsewhere), and a resume attempt then sat behind the connecting screen with
 * no next attempt. Now both eras' connections give up on a socket still
 * CONNECTING after WS_OPEN_TIMEOUT_MS and report it as one that failed to open
 * (CantSocket + openTimedOut, then 'disconnected'), and the resume
 * (SessionLifecycle + ResumeRunner) doesn't spend its three attempts while
 * the browser is offline or nothing answers: it waits for 'online', bounded
 * by RESUME_UNREACHABLE_GRACE_MS.
 *
 * Drives the real ClientConnection / Connection1999 over fake sockets with
 * fake timers, and the real SessionLifecycle + ResumeRunner + PreworldReporter
 * + the bridge's telemetry sanitizer.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientConnection, type ConnectionEvent } from '../packages/network/src/index.js';
import { Connection1999 } from '../packages/network/src/era1999/Connection1999.js';
import { EOR_LOGIN_PROFILE } from '../packages/network/src/LoginProfile.js';
import { HANDOVER_ADOPT_TIMEOUT_MS } from '../packages/network/src/SocketHandover.js';
import { WS_OPEN_TIMEOUT_MS, armOpenTimeout } from '../packages/network/src/WsOpenTimeout.js';
import {
  SessionLifecycle, RESUME_DELAYS_MS, RESUME_UNREACHABLE_GRACE_MS,
} from '../packages/renderer/src/session/SessionLifecycle.js';
import {
  ResumeRunner, RESUME_ONLINE_SETTLE_MS, windowOnlineSource, type OnlineSource,
} from '../packages/renderer/src/session/ResumeRunner.js';
import { PreworldReporter, type PreworldEvent } from '../packages/renderer/src/telemetry/PreworldReporter.js';
import { sanitizeClientPreworld } from '../services/ws-tcp-bridge/src/clientPreworld.js';
import { probeCustomBridge } from '../packages/renderer/src/launcher/worldDirectory.js';

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static sockets: FakeSocket[] = [];
  readyState = 0;
  binaryType = '';
  texts: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer | string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { FakeSocket.sockets.push(this); }
  send(d: Uint8Array | ArrayBuffer | string): void { if (typeof d === 'string') this.texts.push(d); }
  /** As a browser: closing a socket fires its close event (here at once). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({ code: 1006 });
  }
  open(): void { this.readyState = 1; this.onopen?.(); }
  text(t: string): void { this.onmessage?.({ data: t }); }
  /** The browser gave up on it (refused / unreachable): error, then close. */
  fail(): void { this.onerror?.(); this.readyState = 3; this.onclose?.({ code: 1006 }); }
}

const g = globalThis as { WebSocket?: unknown };
let saved: unknown;
beforeAll(() => { saved = g.WebSocket; g.WebSocket = FakeSocket; });
afterAll(() => { g.WebSocket = saved; });
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { FakeSocket.sockets = []; vi.useRealTimers(); vi.restoreAllMocks(); });

type Conn = ClientConnection | Connection1999;
function make(kind: 'eor' | 'ac1999'): { conn: Conn; events: ConnectionEvent[] } {
  const conn: Conn = kind === 'eor'
    ? new ClientConnection('ws://bridge/?server=w')
    : new Connection1999('ws://bridge/?server=w', { loginProfile: { ...EOR_LOGIN_PROFILE, protocol: 'ac1999' } });
  conn.autoReconnect = false;
  const events: ConnectionEvent[] = [];
  conn.on((e) => events.push(e));
  return { conn, events };
}
const errors = (ev: ConnectionEvent[]) => ev.filter((e) => e.type === 'error');
const drops = (ev: ConnectionEvent[]) => ev.filter((e) => e.type === 'disconnected');

describe('WsOpenTimeout', () => {
  it('fires only for a socket still CONNECTING, once, and not after disarm', () => {
    const s = { readyState: 0 };
    const hits: number[] = [];
    armOpenTimeout(s, () => hits.push(1), 100);
    vi.advanceTimersByTime(99);
    expect(hits).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(hits).toEqual([1]);
    vi.advanceTimersByTime(1000);
    expect(hits).toEqual([1]);
    const open = { readyState: 1 };
    armOpenTimeout(open, () => hits.push(2), 100);
    vi.advanceTimersByTime(200);
    expect(hits).toEqual([1]);
    const disarm = armOpenTimeout({ readyState: 0 }, () => hits.push(3), 100);
    disarm();
    vi.advanceTimersByTime(200);
    expect(hits).toEqual([1]);
  });

  it('is 15 s: past a healthy open on a slow link (four round trips + SYN retransmits), well short of the OS give-up', () => {
    expect(WS_OPEN_TIMEOUT_MS).toBe(15_000);
  });
});

for (const kind of ['eor', 'ac1999'] as const) {
  const name = kind === 'eor' ? 'ClientConnection' : 'Connection1999';
  describe(`open timeout (${name})`, () => {
    it('a socket still CONNECTING at the timeout is reported as one that failed to open: CantSocket, then a drop that never opened', () => {
      const { conn, events } = make(kind);
      conn.connect('acct', 'pw');
      const sock = FakeSocket.sockets[0];
      vi.advanceTimersByTime(WS_OPEN_TIMEOUT_MS - 1);
      expect(errors(events)).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(sock.closed).toBe(true);
      expect(errors(events)).toEqual([expect.objectContaining({ netErrorId: 'ID_NetError_CantSocket', openTimedOut: true })]);
      expect(drops(events)).toEqual([expect.objectContaining({ everOpened: false, deliberate: false })]);
      // The browser's own late error / close on it reports nothing more.
      sock.onerror?.();
      sock.onclose?.({ code: 1006 });
      expect(errors(events)).toHaveLength(1);
      expect(drops(events)).toHaveLength(1);
    });

    it('a page that leaves the socket from the error (the resume\'s disconnect()) gets the same single error and a deliberate end', () => {
      const { conn, events } = make(kind);
      conn.on((e) => { if (e.type === 'error') conn.disconnect(); });
      conn.connect('acct', 'pw');
      vi.advanceTimersByTime(WS_OPEN_TIMEOUT_MS);
      expect(errors(events)).toHaveLength(1);
      expect(drops(events).every((d) => d.deliberate === true)).toBe(true);
      expect(drops(events).length).toBeLessThanOrEqual(1);
    });

    it('a slow but healthy open (just inside the timeout) is never killed', () => {
      const { conn, events } = make(kind);
      conn.connect('acct', 'pw');
      vi.advanceTimersByTime(WS_OPEN_TIMEOUT_MS - 100);
      FakeSocket.sockets[0].open();
      // (Past the open timeout, short of the login's own 40 s budget with no server here.)
      vi.advanceTimersByTime(WS_OPEN_TIMEOUT_MS + 5000);
      expect(events.some((e) => e.type === 'connected')).toBe(true);
      expect(events.some((e) => e.openTimedOut)).toBe(false);
      expect(FakeSocket.sockets[0].closed).toBe(false);
    });

    it('a socket that fails on its own reports once (the timer is gone)', () => {
      const { conn, events } = make(kind);
      conn.connect('acct', 'pw');
      FakeSocket.sockets[0].fail();
      vi.advanceTimersByTime(WS_OPEN_TIMEOUT_MS * 2);
      expect(errors(events)).toEqual([expect.objectContaining({ netErrorId: 'ID_NetError_CantSocket' })]);
      expect(errors(events)[0].openTimedOut).toBeUndefined();
    });

    it('a deliberate disconnect while CONNECTING: no timeout later', () => {
      const { conn, events } = make(kind);
      conn.connect('acct', 'pw');
      vi.advanceTimersByTime(5000);
      conn.disconnect();
      vi.advanceTimersByTime(WS_OPEN_TIMEOUT_MS * 2);
      expect(events.some((e) => e.openTimedOut)).toBe(false);
      expect(drops(events).every((d) => d.deliberate === true)).toBe(true);
    });

    it('a reconnect replaces the socket: only the new socket\'s timer can fire, and only for it', () => {
      const { conn, events } = make(kind);
      conn.connect('acct', 'pw');
      vi.advanceTimersByTime(10_000);
      conn.disconnect();
      conn.connect('acct', 'pw');
      vi.advanceTimersByTime(10_000); // the first socket's 15 s passes: nothing
      expect(events.some((e) => e.openTimedOut)).toBe(false);
      vi.advanceTimersByTime(5000); // the second's
      expect(errors(events)).toEqual([expect.objectContaining({ openTimedOut: true })]);
      expect(FakeSocket.sockets[1].closed).toBe(true);
    });

    it('a planned handover\'s socket has its own bound (SocketHandover), never the session open timeout', () => {
      const { conn, events } = make(kind);
      conn.connect('acct', 'pw');
      const old = FakeSocket.sockets[0];
      old.open();
      vi.advanceTimersByTime(1000);
      conn.handover();
      old.text(JSON.stringify({ handoverTicket: { ticket: 'h1.T' } }));
      const next = FakeSocket.sockets[1];
      expect(next.url).toContain('handover=1');
      // The new socket hangs CONNECTING: the handover's adopt timeout ends it, and the session stays.
      vi.advanceTimersByTime(HANDOVER_ADOPT_TIMEOUT_MS);
      expect(events.filter((e) => e.type === 'handover').map((e) => e.data)).toEqual([expect.objectContaining({ ok: false, released: false })]);
      // Past the new socket's would-be open timeout (short of the login's own 40 s budget, no server here).
      vi.advanceTimersByTime(WS_OPEN_TIMEOUT_MS + 1000);
      expect(events.some((e) => e.openTimedOut)).toBe(false);
      expect(drops(events)).toEqual([]);
      expect(old.closed).toBe(false);
    });
  });
}

// ── The resume ────────────────────────────────────────────────────────

class FakeNet implements OnlineSource {
  offline = false;
  private subs = new Set<() => void>();
  isOffline(): boolean { return this.offline; }
  onOnline(fn: () => void): () => void { this.subs.add(fn); return () => this.subs.delete(fn); }
  get listeners(): number { return this.subs.size; }
  comeBack(): void { this.offline = false; for (const f of [...this.subs]) f(); }
}

function resumeHarness(): { life: SessionLifecycle; net: FakeNet; runner: ResumeRunner; connects: number[]; schedule(o?: { unreachable?: boolean }): boolean } {
  const life = new SessionLifecycle();
  const net = new FakeNet();
  const connects: number[] = [];
  const runner = new ResumeRunner({ lifecycle: life, connect: () => connects.push(Date.now()), online: net, now: () => Date.now() });
  // main.ts scheduleResume, minus the UI.
  const schedule = (o: { unreachable?: boolean } = {}) => {
    const delay = life.nextResumeDelay({ unreachable: o.unreachable, now: Date.now() });
    if (delay === null) { runner.cancel(); return false; }
    runner.schedule(delay);
    return true;
  };
  return { life, net, runner, connects, schedule };
}

/** In the world with a character, then the drop. */
function dropInWorld(h: ReturnType<typeof resumeHarness>): void {
  h.life.noteEnterWorldRequested(0x50000001);
  h.life.noteWorldEntered();
  h.life.noteDisconnected();
  expect(h.schedule()).toBe(true);
}

describe('resume during a network outage (SessionLifecycle + ResumeRunner)', () => {
  it('online: the attempts go at the usual delays and three failures end it (unchanged)', () => {
    const h = resumeHarness();
    dropInWorld(h);
    vi.advanceTimersByTime(RESUME_DELAYS_MS[0]);
    expect(h.connects).toHaveLength(1);
    expect(h.schedule()).toBe(true);
    vi.advanceTimersByTime(RESUME_DELAYS_MS[1]);
    expect(h.schedule()).toBe(true);
    vi.advanceTimersByTime(RESUME_DELAYS_MS[2]);
    expect(h.connects).toHaveLength(3);
    expect(h.schedule()).toBe(false); // the Disconnected screen
    expect(h.life.resumingAfterDrop).toBe(false);
  });

  it('offline when the attempt is due: it waits for "online" (plus the settle) instead of spending the attempt', () => {
    const h = resumeHarness();
    dropInWorld(h);
    h.net.offline = true;
    vi.advanceTimersByTime(RESUME_DELAYS_MS[0] + 60_000);
    expect(h.connects).toEqual([]);
    expect(h.runner.waitingForNetwork).toBe(true);
    expect(h.life.resumingAfterDrop).toBe(true); // the connecting screen stays
    h.net.comeBack();
    vi.advanceTimersByTime(RESUME_ONLINE_SETTLE_MS - 1);
    expect(h.connects).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(h.connects).toHaveLength(1);
    expect(h.runner.waitingForNetwork).toBe(false);
    expect(h.net.listeners).toBe(0);
  });

  it('the wait is bounded: no "online" within the grace, the attempt goes anyway', () => {
    const h = resumeHarness();
    dropInWorld(h);
    h.net.offline = true;
    vi.advanceTimersByTime(RESUME_DELAYS_MS[0]);
    vi.advanceTimersByTime(RESUME_UNREACHABLE_GRACE_MS - 1);
    expect(h.connects).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(h.connects).toHaveLength(1);
    expect(h.net.listeners).toBe(0);
  });

  it('attempts that fail with the network out are not counted during the grace; after it they count and it ends', () => {
    const h = resumeHarness();
    dropInWorld(h);
    vi.advanceTimersByTime(RESUME_DELAYS_MS[0]);
    expect(h.connects).toHaveLength(1);
    // Each attempt's socket times out with no answer (onLine still true: a path that drops packets).
    let n = 0;
    while (Date.now() < 1e15) {
      vi.advanceTimersByTime(WS_OPEN_TIMEOUT_MS);
      if (!h.schedule({ unreachable: true })) break;
      vi.advanceTimersByTime(RESUME_DELAYS_MS[2]);
      n++;
      if (n > 100) throw new Error('never ended');
    }
    // More attempts than the three a reachable outage gets, and bounded by the grace + three.
    expect(h.connects.length).toBeGreaterThan(RESUME_DELAYS_MS.length);
    const maxDuringGrace = Math.ceil(RESUME_UNREACHABLE_GRACE_MS / (WS_OPEN_TIMEOUT_MS + RESUME_DELAYS_MS[0])) + 1;
    expect(h.connects.length).toBeLessThanOrEqual(maxDuringGrace + RESUME_DELAYS_MS.length);
    expect(h.life.resumingAfterDrop).toBe(false);
  });

  it('the grace runs from when the network was first found out, not from the drop (a machine that slept through it)', () => {
    const h = resumeHarness();
    dropInWorld(h);
    // The page slept ~3 minutes with the 2 s timer pending (the wall clock moved, nothing ran).
    vi.setSystemTime(Date.now() + 170_000);
    h.net.offline = true;
    vi.advanceTimersByTime(RESUME_DELAYS_MS[0]);
    // Woken offline: still a full grace to wait in.
    expect(h.life.unreachableGraceLeftMs(Date.now())).toBe(RESUME_UNREACHABLE_GRACE_MS);
    expect(h.runner.waitingForNetwork).toBe(true);
    vi.advanceTimersByTime(8000);
    h.net.comeBack();
    vi.advanceTimersByTime(RESUME_ONLINE_SETTLE_MS);
    expect(h.connects).toHaveLength(1);
  });

  it('a deliberate logout during the wait: nothing connects when the network comes back', () => {
    const h = resumeHarness();
    dropInWorld(h);
    h.net.offline = true;
    vi.advanceTimersByTime(RESUME_DELAYS_MS[0]);
    expect(h.runner.waitingForNetwork).toBe(true);
    h.life.noteLoggedOut();
    h.net.comeBack();
    vi.advanceTimersByTime(RESUME_UNREACHABLE_GRACE_MS * 2);
    expect(h.connects).toEqual([]);
    // And nothing to resume afterwards.
    expect(h.schedule()).toBe(false);
  });

  it('a newer schedule (or a cancel) replaces a pending wait: one connect, never two', () => {
    const h = resumeHarness();
    dropInWorld(h);
    h.net.offline = true;
    vi.advanceTimersByTime(RESUME_DELAYS_MS[0]);
    h.runner.schedule(500);
    h.net.offline = false;
    h.net.comeBack();
    vi.advanceTimersByTime(RESUME_UNREACHABLE_GRACE_MS);
    expect(h.connects).toHaveLength(1);
    h.runner.schedule(500);
    h.runner.cancel();
    vi.advanceTimersByTime(10_000);
    expect(h.connects).toHaveLength(1);
  });

  it('the chargen resume waits and is spared the same way', () => {
    const h = resumeHarness();
    h.life.beginChargenResume();
    expect(h.schedule()).toBe(true);
    expect(h.life.resumingChargen).toBe(true);
    h.net.offline = true;
    vi.advanceTimersByTime(RESUME_DELAYS_MS[0] + 30_000);
    expect(h.connects).toEqual([]);
    h.net.comeBack();
    vi.advanceTimersByTime(RESUME_ONLINE_SETTLE_MS);
    expect(h.connects).toHaveLength(1);
    // That attempt fails offline again: given back.
    for (let i = 0; i < 5; i++) expect(h.schedule({ unreachable: true })).toBe(true);
    expect(h.life.resumingChargen).toBe(true);
  });

  it('the first failure of a resume is never "given back" below zero, and a reachable failure always counts', () => {
    const life = new SessionLifecycle();
    life.noteEnterWorldRequested(1);
    life.noteWorldEntered();
    life.noteDisconnected();
    expect(life.nextResumeDelay({ unreachable: true })).toBe(RESUME_DELAYS_MS[0]);
    expect(life.nextResumeDelay()).toBe(RESUME_DELAYS_MS[1]);
    expect(life.nextResumeDelay({ unreachable: true })).toBe(RESUME_DELAYS_MS[1]);
    expect(life.nextResumeDelay()).toBe(RESUME_DELAYS_MS[2]);
    expect(life.nextResumeDelay()).toBeNull();
  });

  it('windowOnlineSource reads navigator.onLine and the window\'s "online" event', () => {
    const handlers = new Set<() => void>();
    const w = {
      navigator: { onLine: true },
      addEventListener: (_t: 'online', fn: () => void) => { handlers.add(fn); },
      removeEventListener: (_t: 'online', fn: () => void) => { handlers.delete(fn); },
    };
    const src = windowOnlineSource(w);
    expect(src.isOffline()).toBe(false);
    w.navigator.onLine = false;
    expect(src.isOffline()).toBe(true);
    let hits = 0;
    const off = src.onOnline(() => hits++);
    for (const h of [...handlers]) h();
    expect(hits).toBe(1);
    off();
    expect(handlers.size).toBe(0);
    // No navigator (a test page, an old worker): never "offline".
    expect(windowOnlineSource({ addEventListener: () => {}, removeEventListener: () => {} }).isOffline()).toBe(false);
  });
});

describe('telemetry: a connect_failed says when the network was out', () => {
  function reporter(): { r: PreworldReporter; sent: PreworldEvent[] } {
    const sent: PreworldEvent[] = [];
    const r = new PreworldReporter({
      endpoint: 'https://bridge.example/client-preworld', build: 'abc1234', era: () => 'eor', server: () => 'coldeve',
      screen: () => 'resuming', now: () => 1000, trace: 'feedc0de12345678',
      send: (_url, raw) => sent.push(JSON.parse(raw) as PreworldEvent),
    });
    return { r, sent };
  }

  it('open_timeout from a timed-out socket, kept by the bridge; an ordinary failure has no cause', () => {
    const { conn } = make('eor');
    const { r, sent } = reporter();
    conn.on((e) => { if (e.type === 'error' && e.netErrorId) r.connectionError(e, e.netErrorId); });
    conn.connect('acct', 'pw');
    vi.advanceTimersByTime(WS_OPEN_TIMEOUT_MS);
    expect(sent.map((s) => [s.outcome, s.token, s.why])).toEqual([['connect_failed', 'ID_NetError_CantSocket', 'open_timeout']]);
    expect(sanitizeClientPreworld(sent[0])).toMatchObject({ outcome: 'connect_failed', why: 'open_timeout' });
    r.connectionError({ netErrorId: 'ID_NetError_CantSocket' }, 'ID_NetError_CantSocket');
    expect(sent[1].why).toBeUndefined();
    expect(sanitizeClientPreworld(sent[1])).not.toHaveProperty('why');
  });

  it('the bridge drops an unknown cause, and a cause on any other outcome', () => {
    const base = { era: 'eor', server: 'coldeve', trace: 'feedc0de12345678', build: 'abc1234', screen: 'resuming', pageMs: 5, screenMs: 5 };
    expect(sanitizeClientPreworld({ ...base, outcome: 'connect_failed', why: 'weather' })).not.toHaveProperty('why');
    expect(sanitizeClientPreworld({ ...base, outcome: 'char_list', why: 'offline' })).not.toHaveProperty('why');
    expect(sanitizeClientPreworld({ ...base, outcome: 'connect_failed', why: 'offline' })).toMatchObject({ why: 'offline' });
  });
});

describe('the custom bridge /healthz fallback is bounded', () => {
  it('passes an abort signal, and a fetch that is aborted reads as unreachable', async () => {
    vi.useRealTimers();
    const inits: Array<RequestInit | undefined> = [];
    const fetchFn = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      inits.push(init);
      throw new DOMException('The operation was aborted.', 'TimeoutError');
    }) as typeof fetch;
    const out = await probeCustomBridge('wss://play.example.net/bridge', fetchFn, async () => { throw new Error('no ws'); });
    expect(out).toEqual({ reachable: false, era: null });
    expect(inits[0]?.signal).toBeInstanceOf(AbortSignal);
  });
});
