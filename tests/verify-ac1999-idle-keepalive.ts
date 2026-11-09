/**
 * BUG.ac1999-hidden-charselect-keepalive — what keeps an idle AC1999 session
 * alive at character select, and why a hidden tab's timer throttling can't
 * stretch it past the server's 60 s inactivity drop (reference/ac1999
 * PacketController.cpp:387).
 *
 * The AC1999 server sends a bare 0x202 keepalive every 5 s (PacketController.h
 * KeepAliveInterval, ThinkOutbound) and Connection1999 answers each one with a
 * bare 0x202 from the socket's message handler, not from a timer. The service
 * tick (100 ms setInterval) only NAKs gaps and measures the server's silence.
 * And the connection runs in the network Web Worker (createNetConnection), whose
 * timers Chrome's intensive throttling doesn't touch anyway.
 *
 * Production 2026-11-08 (trace 36bd770743abbfc9) had tickGapMaxMs 244-464 over
 * 2-15 min hidden at char select, and the bridge saw the SERVER go quiet first
 * (serverQuietMs 60 s; our last answer 0.6-2.6 s before its last packet): the
 * server ended the session; our keepalive did not lapse.
 *
 * These drive the real Connection1999 over the recorded 1999 server traffic
 * with its interval timers fired at a visible cadence (100 ms), Chrome's hidden
 * cadence (1 s) and intensive throttling (once a minute).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EOR_LOGIN_PROFILE, hostClientConnection, type ConnectionEvent, type NetCommand, type NetReply } from '@ac/network';
import { Connection1999, VERSION_1999 } from '../packages/network/src/era1999/Connection1999.js';
import { buildPacket1999, F1999, readHeader1999 } from '../packages/network/src/era1999/Packet1999.js';
import { NetWorkerClient, type NetWorkerEndpoint } from '../packages/renderer/src/network/NetWorkerClient.js';

const s2c: Uint8Array[] = gunzipSync(readFileSync(resolve(__dirname, 'fixtures', 'ac1999-session-001.jsonl.gz')))
  .toString().trim().split('\n').map((l) => JSON.parse(l))
  .filter((j) => j.d === 's2c').map((j) => new Uint8Array(Buffer.from(j.b, 'base64')));

const SERVER_KEEPALIVE_MS = 5000; // PacketController.h KeepAliveInterval
const SERVER_INACTIVITY_MS = 60_000; // PacketController.cpp:387
const KEEPALIVE_FLAGS = F1999.Connect | F1999.Checksum; // 0x202

let clock = 0;
class FakeSocket {
  static OPEN = 1;
  static last: FakeSocket | null = null;
  readyState = 0;
  binaryType = '';
  /** Every datagram we sent, with the clock when it went. */
  sent: Array<{ at: number; bytes: Uint8Array }> = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer | string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((ev?: { code: number }) => void) | null = null;
  constructor(readonly url: string) { FakeSocket.last = this; }
  send(b: Uint8Array | string): void { if (typeof b !== 'string') this.sent.push({ at: clock, bytes: new Uint8Array(b).slice() }); }
  close(): void { this.readyState = 3; this.onclose?.({ code: 1005 }); }
  open(): void { this.readyState = 1; this.onopen?.(); }
  deliver(b: Uint8Array): void { this.onmessage?.({ data: b.slice().buffer }); }
}

/**
 * The connection's interval timers, held instead of scheduled: `fire()` runs
 * them when the test says, which is how a throttled page delivers them
 * (late and batched into one run).
 */
const intervals = new Map<number, () => void>();
let nextId = 1;
const saved: Record<string, unknown> = {};
beforeEach(() => {
  clock = 1_800_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const g = globalThis as Record<string, unknown>;
  for (const k of ['WebSocket', 'setInterval', 'clearInterval']) saved[k] = g[k];
  g.WebSocket = FakeSocket;
  g.setInterval = ((fn: () => void) => { const id = nextId++; intervals.set(id, fn); return id; }) as unknown;
  g.clearInterval = ((id: number) => { intervals.delete(id); }) as unknown;
  intervals.clear();
});
afterEach(() => {
  const g = globalThis as Record<string, unknown>;
  for (const [k, v] of Object.entries(saved)) g[k] = v;
  vi.restoreAllMocks();
});
const fire = (): void => { for (const fn of [...intervals.values()]) fn(); };

function loggedIn() {
  const conn = new Connection1999('ws://bridge');
  conn.datIterations = { portal: 102, cell: 67, language: 0 };
  const events: ConnectionEvent[] = [];
  conn.on((e) => events.push(e));
  conn.connect('acjsdbja', 'acjsdbja');
  const sock = FakeSocket.last!;
  sock.open();
  for (const b of s2c) {
    sock.deliver(b);
    if (events.some((e) => e.type === 'characterList')) break;
  }
  expect(events.some((e) => e.type === 'characterList')).toBe(true);
  const recipient = readHeader1999(s2c.find((b) => readHeader1999(b).sequence === 0 && b.length === 20)!).recipient;
  const keepalive = (): Uint8Array => buildPacket1999({ sequence: 0, flags: KEEPALIVE_FLAGS, recipient, time: 0 });
  return { conn, sock, events, keepalive };
}

/**
 * Idle at character select for `ms`: the server's 0x202 every 5 s (while
 * `serverAlive`), the page's interval timers run every `tickMs`.
 */
function idle(s: ReturnType<typeof loggedIn>, ms: number, tickMs: number, serverAlive = true): void {
  const end = clock + ms;
  let nextKeepalive = clock + SERVER_KEEPALIVE_MS;
  let nextTick = clock + tickMs;
  while (clock < end && !s.events.some((e) => e.type === 'disconnected')) {
    const next = Math.min(serverAlive ? nextKeepalive : Infinity, nextTick, end);
    clock = next;
    if (serverAlive && clock === nextKeepalive) { s.sock.deliver(s.keepalive()); nextKeepalive += SERVER_KEEPALIVE_MS; }
    if (clock === nextTick) { fire(); nextTick += tickMs; }
  }
}

const answers = (s: ReturnType<typeof loggedIn>, from: number) =>
  s.sock.sent.filter((p) => p.at > from && readHeader1999(p.bytes).flags === KEEPALIVE_FLAGS && p.bytes.length === 20);

describe('AC1999 idle at character select: the server keepalive is answered on arrival, whatever the timers do', () => {
  for (const [label, tickMs] of [['visible (100 ms ticks)', 100], ['hidden (1 s throttling)', 1000], ['intensive throttling (one run a minute)', 60_000]] as const) {
    it(`${label}: 15 minutes idle, every 0x202 answered at once, never a gap near the server's 60 s`, () => {
      const s = loggedIn();
      const start = clock;
      idle(s, 15 * 60_000, tickMs);
      expect(s.events.filter((e) => e.type === 'disconnected')).toEqual([]);
      const sent = answers(s, start);
      expect(sent).toHaveLength(15 * 60_000 / SERVER_KEEPALIVE_MS); // one per keepalive
      // Each answer goes out the moment its keepalive arrives (no timer in between)...
      expect(sent.every((p) => (p.at - start) % SERVER_KEEPALIVE_MS === 0)).toBe(true);
      // ...so the server hears us every 5 s, far inside its 60 s inactivity drop.
      const gaps = sent.slice(1).map((p, i) => p.at - sent[i].at);
      expect(Math.max(...gaps)).toBe(SERVER_KEEPALIVE_MS);
      expect(Math.max(...gaps)).toBeLessThan(SERVER_INACTIVITY_MS);
      s.conn.disconnect();
    });
  }

  it('a server that stops talking is still caught as server_silent under intensive throttling (the first run past 60 s)', () => {
    const s = loggedIn();
    idle(s, 60_000, 60_000);
    const quietFrom = clock;
    idle(s, 3 * 60_000, 60_000, false);
    const d = s.events.filter((e) => e.type === 'disconnected');
    expect(d).toEqual([expect.objectContaining({ deliberate: false, endCause: 'server_silent' })]);
    expect(clock - quietFrom).toBeLessThanOrEqual(2 * 60_000);
    // Nothing went out once the server stopped: this lane answers, it doesn't originate.
    expect(answers(s, quietFrom)).toHaveLength(0);
  });
});

describe('the AC1999 connection runs in the network worker', () => {
  it('a NetWorkerClient with the 1999 login profile has the worker host a Connection1999 (its socket asks for proto=ac1999)', () => {
    const hostListeners: Array<(ev: { data: NetCommand }) => void> = [];
    const pageListeners: Array<(ev: MessageEvent<NetReply>) => void> = [];
    const stop = hostClientConnection({
      postMessage: (r) => { const copy = structuredClone(r); for (const l of pageListeners) l({ data: copy } as MessageEvent<NetReply>); },
      addEventListener: (_t, l) => { hostListeners.push(l); },
    });
    const endpoint: NetWorkerEndpoint = {
      postMessage: (cmd) => { const copy = structuredClone(cmd); for (const l of hostListeners) l({ data: copy }); },
      addEventListener: (_t, l) => { pageListeners.push(l); },
    };
    try {
      const client = new NetWorkerClient(endpoint, 'ws://bridge', { loginProfile: { ...EOR_LOGIN_PROFILE, clientVersion: VERSION_1999, protocol: 'ac1999' } });
      client.connect('acjsdbja', 'acjsdbja');
      expect(FakeSocket.last!.url).toBe('ws://bridge?proto=ac1999');
      client.disconnect();
    } finally {
      stop();
    }
  });
});
