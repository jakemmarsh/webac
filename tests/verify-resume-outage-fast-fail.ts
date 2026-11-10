/**
 * BUG.resume-outage-fast-fail (prod 2026-11-08, end of retail, build 16e87d1e2,
 * trace 24a98ca9293956ce): a player at character select on a flaky home
 * connection lost the network for ~65 s (17:19:35 → 17:20:40). The char-select
 * resume spent its whole budget in ~38 s: attempt 1 (2 s) failed at once,
 * attempt 2 (5 s) hung to the 15 s open timeout (given back), attempt 3 and
 * attempt 4 failed at once, and the Disconnected screen came up at pageMs
 * ~175 s. Only open timeouts and navigator.onLine === false counted as "no
 * network", but with Wi-Fi associated and no internet Chrome fails a
 * WebSocket open in under a second (DNS, ERR_INTERNET_DISCONNECTED,
 * ERR_NETWORK_CHANGED) while onLine stays true. Only one of the four
 * connect_failed events reached the bridge: the page was hidden, so they went
 * by beacon, and a beacon the outage failed was gone.
 *
 * Now every socket that never opened (ConnectionEvent.openFailed /
 * openTimedOut) is "no network" (attemptFoundNoNetwork) and given back within
 * RESUME_UNREACHABLE_GRACE_MS, with given-back attempts backing off
 * (RESUME_UNREACHABLE_GAPS_MS) so a fast failure doesn't open every 2 s; a
 * connect_failed says why ('open_failed'); a spent budget reports
 * resume_ended budget_spent with the attempts given back (the outbox is
 * unchanged: a copy of each beacon would double a hidden page's events against
 * the bridge's per-IP limits).
 *
 * Drives the real ClientConnection / Connection1999 over fake sockets on fake
 * timers, with the real SessionLifecycle + ResumeRunner wired as main.ts's
 * scheduleResume / resume-attempt failure path wires them.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientConnection, type ConnectionEvent } from '../packages/network/src/index.js';
import { Connection1999 } from '../packages/network/src/era1999/Connection1999.js';
import { EOR_LOGIN_PROFILE } from '../packages/network/src/LoginProfile.js';
import { WS_OPEN_TIMEOUT_MS } from '../packages/network/src/WsOpenTimeout.js';
import {
  SessionLifecycle,
} from '../packages/renderer/src/session/SessionLifecycle.js';
import { ResumeRunner, attemptFoundNoNetwork, type OnlineSource } from '../packages/renderer/src/session/ResumeRunner.js';
import { PreworldReporter, type PreworldEvent } from '../packages/renderer/src/telemetry/PreworldReporter.js';
import { sanitizeClientPreworld, MAX_OPEN_MS } from '../services/ws-tcp-bridge/src/clientPreworld.js';
import { RESUME_DELAYS_MS, RESUME_UNREACHABLE_GAPS_MS, RESUME_UNREACHABLE_GRACE_MS } from '../packages/renderer/src/session/RetryPolicy.js';

/** How the network treats a new socket: fails it fast, lets it hang, or opens it. */
type NetMode = 'fast' | 'hang' | 'up';
let netMode: NetMode = 'up';
/** How long a fast failure takes (prod: ~0.4 s). */
const FAST_FAIL_MS = 400;

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static sockets: FakeSocket[] = [];
  readyState = 0;
  binaryType = '';
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer | string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly openedAt = Date.now();
  constructor(readonly url: string) {
    FakeSocket.sockets.push(this);
    if (netMode === 'fast') setTimeout(() => { if (!this.closed) this.fail(); }, FAST_FAIL_MS);
    if (netMode === 'up') setTimeout(() => { if (!this.closed) this.open(); }, 50);
  }
  send(): void { /* nothing answers */ }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({ code: 1006 });
  }
  open(): void { this.readyState = 1; this.onopen?.(); }
  /** The browser gave up on it: error, then close. */
  fail(): void { this.closed = true; this.onerror?.(); this.readyState = 3; this.onclose?.({ code: 1006 }); }
}

const g = globalThis as { WebSocket?: unknown };
let saved: unknown;
beforeAll(() => { saved = g.WebSocket; g.WebSocket = FakeSocket; });
afterAll(() => { g.WebSocket = saved; });
beforeEach(() => {
  vi.useFakeTimers();
  netMode = 'up';
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { FakeSocket.sockets = []; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

class FakeOnline implements OnlineSource {
  offline = false;
  isOffline(): boolean { return this.offline; }
  onOnline(): () => void { return () => {}; }
}

type Kind = 'eor' | 'ac1999';

/** The page's resume, as main.ts wires it (scheduleResume + the resume-attempt failure branch). */
function page(kind: Kind, opts: { hidden?: () => boolean } = {}) {
  const conn = kind === 'eor'
    ? new ClientConnection('ws://bridge/?server=w')
    : new Connection1999('ws://bridge/?server=w', { loginProfile: { ...EOR_LOGIN_PROFILE, protocol: 'ac1999' } });
  const life = new SessionLifecycle();
  const online = new FakeOnline();
  const sent: PreworldEvent[] = [];
  const reporter = new PreworldReporter({
    endpoint: 'https://bridge.example/client-preworld', build: 'abc1234', era: () => kind, server: () => 'w',
    screen: () => 'resuming', now: () => Date.now(), trace: 'feedc0de12345678', hidden: opts.hidden,
    send: (_u, raw) => { sent.push(JSON.parse(raw) as PreworldEvent); },
  });
  const state = { disconnectedScreen: false, connected: 0, events: [] as ConnectionEvent[] };
  const runner = new ResumeRunner({
    lifecycle: life, online, now: () => Date.now(),
    connect: () => conn.connect('acct', 'pw'),
  });
  const scheduleResume = (opts: { unreachable?: boolean } = {}): boolean => {
    const wasResuming = life.resumingAfterDrop;
    const givenBack = life.resumeAttemptsGivenBack;
    const delay = life.nextResumeDelay({ unreachable: opts.unreachable, now: Date.now() });
    if (delay === null) {
      runner.cancel();
      if (wasResuming && !life.resumeBound) reporter.resumeEnded('budget_spent', givenBack);
      return false;
    }
    conn.disconnect();
    runner.schedule(delay);
    return true;
  };
  conn.on((e) => {
    state.events.push(e);
    if (e.type === 'connected') state.connected++;
    if (e.type === 'error' && (e.netErrorId || e.serverNetError) && life.resumingAfterDrop) {
      reporter.connectionError(e, e.netErrorId ?? null);
      if (!scheduleResume({ unreachable: attemptFoundNoNetwork(e, online.isOffline()) })) state.disconnectedScreen = true;
    }
  });
  /** The session dropped at character select (main.ts armDropResume → scheduleResume). */
  const dropAtCharSelect = () => {
    life.beginCharSelectResume('1');
    life.noteDisconnected();
    expect(scheduleResume()).toBe(true);
  };
  return { conn, life, online, runner, state, sent, dropAtCharSelect, scheduleResume };
}

const opensSince = (t: number) => FakeSocket.sockets.filter((s) => s.openedAt >= t).length;

for (const kind of ['eor', 'ac1999'] as const) {
  const name = kind === 'eor' ? 'ClientConnection' : 'Connection1999';
  describe(`a resume through a network outage whose opens fail at once (${name})`, () => {
    it('the prod case: a ~65 s outage with onLine true is still resuming at 60 s and is back on the first open after it', () => {
      const p = page(kind);
      netMode = 'fast';
      const t0 = Date.now();
      p.dropAtCharSelect();
      vi.advanceTimersByTime(60_000);
      expect(p.state.disconnectedScreen).toBe(false);
      expect(p.life.resumingAfterDrop).toBe(true);
      expect(p.life.resumingCharSelect).toBe(true);
      vi.advanceTimersByTime(5_000);
      // The network is back at 65 s: the next attempt opens (at most the longest gap later).
      netMode = 'up';
      const back = Date.now();
      vi.advanceTimersByTime(RESUME_UNREACHABLE_GAPS_MS[RESUME_UNREACHABLE_GAPS_MS.length - 1] + 1000);
      expect(p.state.connected).toBe(1);
      expect(p.state.disconnectedScreen).toBe(false);
      const connectedSocket = FakeSocket.sockets.find((s) => s.readyState === 1)!;
      expect(connectedSocket.openedAt - back).toBeLessThanOrEqual(RESUME_UNREACHABLE_GAPS_MS[RESUME_UNREACHABLE_GAPS_MS.length - 1]);
      // Bounded: about one open per gap, nowhere near one every 2 s (~32 in 65 s).
      const outageOpens = FakeSocket.sockets.filter((s) => s.openedAt - t0 < 65_000).length;
      expect(outageOpens).toBeLessThanOrEqual(8);
      expect(outageOpens).toBeGreaterThanOrEqual(5);
      // Every failure said why, and the bridge keeps it.
      const fails = p.sent.filter((e) => e.outcome === 'connect_failed');
      expect(fails).toHaveLength(outageOpens);
      expect(fails.every((e) => e.why === 'open_failed')).toBe(true);
      expect(sanitizeClientPreworld(fails[0])).toMatchObject({ outcome: 'connect_failed', why: 'open_failed' });
    });

    it('the 2 min grace bounds it: an outage that never ends reaches the Disconnected screen, with a bounded number of opens', () => {
      const p = page(kind);
      netMode = 'fast';
      const t0 = Date.now();
      p.dropAtCharSelect();
      vi.advanceTimersByTime(RESUME_UNREACHABLE_GRACE_MS - 10_000);
      expect(p.state.disconnectedScreen).toBe(false);
      vi.advanceTimersByTime(120_000);
      expect(p.state.disconnectedScreen).toBe(true);
      expect(p.life.resumingAfterDrop).toBe(false);
      const ms = Math.max(...FakeSocket.sockets.map((s) => s.openedAt)) - t0;
      expect(ms).toBeGreaterThan(RESUME_UNREACHABLE_GRACE_MS);
      expect(ms).toBeLessThan(RESUME_UNREACHABLE_GRACE_MS + 40_000);
      // About ten in the grace and the two counted ones after it.
      expect(FakeSocket.sockets.length).toBeLessThanOrEqual(15);
      // No more opens once the Disconnected screen is up.
      const n = FakeSocket.sockets.length;
      vi.advanceTimersByTime(600_000);
      expect(FakeSocket.sockets.length).toBe(n);
      // resume_ended budget_spent, with the attempts given back to the outage.
      const ended = p.sent.filter((e) => e.outcome === 'resume_ended');
      expect(ended).toEqual([expect.objectContaining({ token: 'budget_spent' })]);
      expect(ended[0].count).toBe(n - RESUME_DELAYS_MS.length);
      expect(sanitizeClientPreworld(ended[0])).toMatchObject({ outcome: 'resume_ended', token: 'budget_spent', count: n - RESUME_DELAYS_MS.length });
    });

    it('opens that hang to the open timeout keep their old delays (the open already took 15 s)', () => {
      const p = page(kind);
      netMode = 'hang';
      p.dropAtCharSelect();
      vi.advanceTimersByTime(RESUME_DELAYS_MS[0]);
      const starts: number[] = [];
      for (let i = 0; i < 5; i++) {
        starts.push(FakeSocket.sockets[FakeSocket.sockets.length - 1].openedAt);
        vi.advanceTimersByTime(WS_OPEN_TIMEOUT_MS + RESUME_DELAYS_MS[0]);
      }
      const gaps = starts.slice(1).map((t, i) => t - starts[i]);
      expect(gaps).toEqual(Array(4).fill(WS_OPEN_TIMEOUT_MS + RESUME_DELAYS_MS[0]));
      expect(p.sent.filter((e) => e.outcome === 'connect_failed').every((e) => e.why === 'open_timeout')).toBe(true);
      // OBS.upgrade-aborted — each says how long the open took (the whole timeout).
      expect(p.sent.filter((e) => e.outcome === 'connect_failed').every((e) => e.openMs === WS_OPEN_TIMEOUT_MS)).toBe(true);
      expect(p.state.disconnectedScreen).toBe(false);
    });

    it('OBS.upgrade-aborted: a connect_failed carries openMs and whether the page was hidden, and the bridge keeps both', () => {
      let hidden = true;
      const p = page(kind, { hidden: () => hidden });
      netMode = 'fast';
      p.dropAtCharSelect();
      vi.advanceTimersByTime(RESUME_DELAYS_MS[0] + FAST_FAIL_MS);
      hidden = false;
      vi.advanceTimersByTime(30_000);
      const fails = p.sent.filter((e) => e.outcome === 'connect_failed');
      expect(fails.length).toBeGreaterThanOrEqual(2);
      expect(fails[0]).toMatchObject({ why: 'open_failed', openMs: FAST_FAIL_MS, hidden: true });
      expect(fails[1]).toMatchObject({ why: 'open_failed', openMs: FAST_FAIL_MS, hidden: false });
      expect(sanitizeClientPreworld(fails[0])).toMatchObject({ outcome: 'connect_failed', why: 'open_failed', openMs: FAST_FAIL_MS, hidden: true });
      // The error event itself carries openMs.
      expect(p.state.events.find((e) => e.openFailed)?.openMs).toBe(FAST_FAIL_MS);
    });
  });
}

describe('what still counts', () => {
  it('a server refusal (a NetError on an open socket) or a login that timed out on an open socket is not "no network"', () => {
    expect(attemptFoundNoNetwork({ serverNetError: { stringId: 1, tableId: 2 } }, false)).toBe(false);
    // Even with a stale onLine false, the server answered.
    expect(attemptFoundNoNetwork({ serverNetError: { stringId: 1, tableId: 2 } }, true)).toBe(false);
    expect(attemptFoundNoNetwork({}, false)).toBe(false);
    expect(attemptFoundNoNetwork({ openFailed: true }, false)).toBe(true);
    expect(attemptFoundNoNetwork({ openTimedOut: true }, false)).toBe(true);
    expect(attemptFoundNoNetwork({}, true)).toBe(true);
  });

  for (const kind of ['eor', 'ac1999'] as const) {
    it(`a socket that opened and then closed reports no open failure (${kind})`, () => {
      const p = page(kind);
      p.conn.connect('acct', 'pw');
      vi.advanceTimersByTime(100);
      FakeSocket.sockets[0].close();
      expect(p.state.events.some((e) => e.openFailed || e.openTimedOut)).toBe(false);
      expect(p.state.events.filter((e) => e.type === 'disconnected')).toEqual([expect.objectContaining({ everOpened: true })]);
    });

    it(`a socket the browser fails before it opens says so: CantSocket + openFailed (${kind})`, () => {
      const p = page(kind);
      netMode = 'fast';
      p.conn.connect('acct', 'pw');
      vi.advanceTimersByTime(FAST_FAIL_MS);
      expect(p.state.events.filter((e) => e.type === 'error')).toEqual([expect.objectContaining({ netErrorId: 'ID_NetError_CantSocket', openFailed: true })]);
    });
  }

  it('reachable failures still count three and end (2 / 5 / 10 s), and a given-back retry never shortens a counted delay', () => {
    const life = new SessionLifecycle();
    life.beginCharSelectResume('1');
    let now = 1_000_000;
    expect(life.nextResumeDelay({ now })).toBe(RESUME_DELAYS_MS[0]);
    now += RESUME_DELAYS_MS[0] + 300;
    expect(life.nextResumeDelay({ now })).toBe(RESUME_DELAYS_MS[1]);
    now += RESUME_DELAYS_MS[1] + 300;
    // A given-back retry: at least the counted delay it replaces and the first gap.
    const d = life.nextResumeDelay({ now, unreachable: true })!;
    expect(d).toBeGreaterThanOrEqual(Math.max(RESUME_DELAYS_MS[1], RESUME_UNREACHABLE_GAPS_MS[0] - 300));
    now += d + 300;
    expect(life.nextResumeDelay({ now })).toBe(RESUME_DELAYS_MS[2]);
    now += RESUME_DELAYS_MS[2] + 300;
    expect(life.nextResumeDelay({ now })).toBeNull();
  });

  it('given-back gaps grow 2 / 5 / 10 / 15 s and stay at 15 s; a new resume starts the ladder again', () => {
    const life = new SessionLifecycle();
    life.beginCharSelectResume('1');
    let now = 0;
    let d = life.nextResumeDelay({ now })!;
    const gaps: number[] = [];
    for (let i = 0; i < 7; i++) {
      now += d; // the attempt starts…
      now += 400; // …and fails at once
      d = life.nextResumeDelay({ now, unreachable: true })!;
      gaps.push(d + 400);
    }
    // Start to start; the first is the 2 s counted delay it replaces (never shorter) after the 0.4 s failure.
    expect(gaps).toEqual([RESUME_DELAYS_MS[0] + 400, 5000, 10000, 15000, 15000, 15000, 15000]);
    expect(life.resumeAttemptsGivenBack).toBe(7);
    life.endResume();
    expect(life.resumeAttemptsGivenBack).toBe(0);
    life.beginCharSelectResume('1');
    now += 1_000_000;
    d = life.nextResumeDelay({ now })!;
    now += d + 400;
    expect(life.nextResumeDelay({ now, unreachable: true })).toBe(RESUME_DELAYS_MS[0]);
    now += RESUME_DELAYS_MS[0] + 400;
    expect(life.nextResumeDelay({ now, unreachable: true })! + 400).toBe(RESUME_UNREACHABLE_GAPS_MS[1]);
  });

  it('a first-time login (nothing to resume) never gets an automatic retry: retail\'s CantSocket dialog at once', () => {
    const life = new SessionLifecycle();
    expect(life.resumingAfterDrop).toBe(false);
    expect(life.nextResumeDelay({ unreachable: true })).toBeNull();
    expect(life.resumeBound).toBeNull();
  });
});

describe('OBS.upgrade-aborted: the bridge bounds connect_failed openMs / hidden', () => {
  const base = { outcome: 'connect_failed', why: 'open_failed' };
  it('keeps valid values, rounds and clamps openMs, drops malformed ones', () => {
    expect(sanitizeClientPreworld({ ...base, openMs: 412, hidden: true })).toMatchObject({ openMs: 412, hidden: true });
    expect(sanitizeClientPreworld({ ...base, openMs: 12.6, hidden: false })).toMatchObject({ openMs: 13, hidden: false });
    expect(sanitizeClientPreworld({ ...base, openMs: 1e12 })!.openMs).toBe(MAX_OPEN_MS);
    const bad = sanitizeClientPreworld({ ...base, openMs: -1, hidden: 'yes' })!;
    expect('openMs' in bad).toBe(false);
    expect('hidden' in bad).toBe(false);
    expect('openMs' in sanitizeClientPreworld({ ...base, openMs: Number.NaN })!).toBe(false);
    expect('openMs' in sanitizeClientPreworld({ ...base, openMs: '400' })!).toBe(false);
  });
  it('only on connect_failed', () => {
    const ev = sanitizeClientPreworld({ outcome: 'dropped', openMs: 400, hidden: true })!;
    expect('openMs' in ev).toBe(false);
    expect('hidden' in ev).toBe(false);
  });
});
