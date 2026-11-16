/**
 * BUG.pacer-burst-telemetry (2026-11-16) — playwebac.com reported `move_limiter limiter=pacer` with txPaced=129
 * (Seedsow, Classic Dereth, build 3a633e578d83, trace 4b166f6470f68817), but the event carried only the movement
 * snapshot (recent 0): movement was not the burst and nothing said what was. The pacer now keeps what it held (message
 * labels with counts, the largest synchronous burst, the drain time) in NetDiagnostics.txPacedStats, the move_limiter
 * event carries it plus whether an agent was attached, and the bridge keeps the new fields.
 *
 * Drives the shipped modules: SendPacer, a ClientConnection past the handshake over a fake socket, the
 * MoveLimiterReporter, and the bridge's sanitizer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ClientConnection, PacketHeaderFlags, type PacketHeaderData, PACKET_HEADER_SIZE, writePacketHeader, messageLabel,
} from '@ac/network';
import { SendPacer } from '../packages/network/src/SendPacer.ts';
import { MoveLimiterReporter, type MoveLimiterEvent } from '../packages/renderer/src/telemetry/MoveLimiterReporter.ts';
import { sanitizeClientMoveLimiter } from '../services/ws-tcp-bridge/src/clientWorld.ts';

/** A GameAction (0xF7B1, sequence, action type) or a bare opcode message. */
function gameAction(action: number, seq = 1): Uint8Array {
  const b = new Uint8Array(16);
  const v = new DataView(b.buffer);
  v.setUint32(0, 0xf7b1, true); v.setUint32(4, seq, true); v.setUint32(8, action, true);
  return b;
}
function opcodeMessage(op: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setUint32(0, op, true);
  return b;
}

/** The mixed burst: 200 PutItemInContainer (0x0019), 60 Use (0x0036), 30 MoveToState (0xF61C), 10 Talk (0x0015). */
const BURST: Uint8Array[] = [
  ...Array.from({ length: 200 }, (_, i) => gameAction(0x0019, i)),
  ...Array.from({ length: 60 }, (_, i) => gameAction(0x0036, i)),
  ...Array.from({ length: 30 }, () => opcodeMessage(0xf61c)),
  ...Array.from({ length: 10 }, (_, i) => gameAction(0x0015, i)),
];

describe('SendPacer.pacedStats: what the pacer held', () => {
  function pacer() {
    let t = 0;
    const timers: Array<{ at: number; fn: () => void }> = [];
    const after: Array<() => void> = [];
    const p = new SendPacer({
      now: () => t,
      setTimer: (fn, ms) => { const h = { at: t + ms, fn }; timers.push(h); return h; },
      clearTimer: (h) => { const i = timers.indexOf(h as never); if (i >= 0) timers.splice(i, 1); },
      afterSync: (fn) => { after.push(fn); },
    });
    const endSync = () => { for (const f of after.splice(0)) f(); };
    const advance = (ms: number) => {
      endSync();
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        t = next.at;
        next.fn();
      }
      t = end;
    };
    return { p, advance, endSync };
  }

  it('a mixed burst: the held sends by label (most first), the burst size, the drain time', () => {
    const { p, advance } = pacer();
    const sent: string[] = [];
    for (const m of BURST) p.submit(() => sent.push(messageLabel(m)), messageLabel(m));
    // The first BURST went at once (the head of the run: PutItemInContainers); the rest wait.
    expect(sent).toHaveLength(SendPacer.BURST);
    const held = BURST.length - SendPacer.BURST;
    expect(p.deferred).toBe(held);
    const mid = p.pacedStats();
    expect(mid.top).toEqual([
      { op: 'f7b1:0036', n: 60 },
      { op: 'f7b1:0019', n: 50 },
      { op: 'f61c', n: 30 },
      { op: 'f7b1:0015', n: 10 },
    ]);
    expect(mid.top.reduce((a, e) => a + e.n, 0)).toBe(held);
    expect(mid.burstMax).toBe(BURST.length);
    expect(mid.pending).toBe(held);
    expect(mid.drainMaxMs).toBe(0); // emptying: nothing elapsed yet
    advance(500);
    expect(p.pacedStats().drainMaxMs).toBe(500); // still emptying: its time so far
    advance(5000);
    const done = p.pacedStats();
    expect(sent).toHaveLength(BURST.length);
    expect(done.pending).toBe(0);
    // 150 held at 100/s: about 1.5 s to empty.
    expect(done.drainMaxMs).toBeGreaterThanOrEqual(1400);
    expect(done.drainMaxMs).toBeLessThanOrEqual(1600);
  });

  it('the burst size is one synchronous run: separate runs under the bucket are not summed', () => {
    const { p, advance, endSync } = pacer();
    for (let i = 0; i < 100; i++) p.submit(() => {}, 'f7b1:0019');
    endSync();
    for (let i = 0; i < 80; i++) p.submit(() => {}, 'f7b1:0036');
    // Only 50 tokens left: 30 of the second run waited, in a run of 80.
    expect(p.pacedStats()).toMatchObject({ top: [{ op: 'f7b1:0036', n: 30 }], burstMax: 80 });
    advance(10_000);
  });

  it('at most TOP_LABELS labels reported and MAX_LABELS counted (the rest are "other"); reset and clear() empty it', () => {
    const { p, advance } = pacer();
    for (let i = 0; i < SendPacer.BURST; i++) p.submit(() => {}, 'f7b1:0019');
    for (let i = 0; i < 100; i++) p.submit(() => {}, `f7b1:${(0x100 + i).toString(16)}`);
    const s = p.pacedStats(true);
    expect(s.top).toHaveLength(SendPacer.TOP_LABELS);
    expect(s.top[0]).toEqual({ op: 'other', n: 100 - SendPacer.MAX_LABELS });
    expect(p.pacedStats()).toMatchObject({ top: [], burstMax: 0 });
    p.submit(() => {}, 'f7b1:0036');
    p.clear();
    expect(p.pacedStats()).toEqual({ top: [], burstMax: 0, drainMaxMs: 0, pending: 0 });
    advance(5000);
  });

  it('normal play holds nothing and reports nothing', () => {
    const { p, advance } = pacer();
    for (let s = 0; s < 60; s++) { for (let i = 0; i < 20; i++) p.submit(() => {}, 'f61c'); advance(1000); }
    expect(p.deferred).toBe(0);
    expect(p.pacedStats()).toEqual({ top: [], burstMax: 0, drainMaxMs: 0, pending: 0 });
  });
});

// ── Through a real connection ──

class FakeWebSocket {
  static readonly OPEN = 1;
  static last: FakeWebSocket | null = null;
  readyState = 0;
  binaryType = 'arraybuffer';
  bufferedAmount = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: Uint8Array[] = [];
  constructor(public url: string) { FakeWebSocket.last = this; }
  send(data: ArrayBuffer | Uint8Array): void { this.sent.push(new Uint8Array(data instanceof Uint8Array ? data : new Uint8Array(data)).slice()); }
  close(): void { this.readyState = 3; }
  open(): void { this.readyState = FakeWebSocket.OPEN; this.onopen?.({}); }
  receive(bytes: Uint8Array): void { this.onmessage?.({ data: bytes.slice().buffer }); }
}
function connectRequest(): Uint8Array {
  const payload = new Uint8Array(32);
  const v = new DataView(payload.buffer);
  v.setFloat64(0, 12345.0, true);
  payload.fill(0x11, 8, 16);
  v.setUint32(16, 0x0007, true);
  payload.set([1, 2, 3, 4], 20);
  payload.set([5, 6, 7, 8], 24);
  const buf = new Uint8Array(PACKET_HEADER_SIZE + payload.length);
  const header: PacketHeaderData = { sequence: 0, flags: PacketHeaderFlags.ConnectRequest, checksum: 0, id: 0xb, time: 0, size: payload.length, iteration: 1 };
  writePacketHeader(header, buf, 0);
  buf.set(payload, PACKET_HEADER_SIZE);
  return buf;
}

let savedWs: unknown;
beforeEach(() => {
  savedWs = (globalThis as { WebSocket?: unknown }).WebSocket;
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  (globalThis as { WebSocket?: unknown }).WebSocket = savedWs;
  vi.restoreAllMocks();
});

describe('move_limiter pacer event: names the burst, end to end', () => {
  it('a ClientConnection burst → NetDiagnostics.txPacedStats → the reporter\'s event → the bridge keeps it', async () => {
    const conn = new ClientConnection('ws://sim');
    conn.connect('acct', 'pw');
    const ws = FakeWebSocket.last!;
    ws.open();
    ws.receive(connectRequest());
    await Promise.resolve();
    expect(conn.getDiagnostics().txPacedStats).toBeUndefined(); // nothing held: no field
    for (const m of BURST) conn.sendMessage(m);
    const d = conn.getDiagnostics();
    expect(d.txPaced).toBe(BURST.length - SendPacer.BURST);
    expect(d.txPacedStats!.top[0]).toEqual({ op: 'f7b1:0036', n: 60 });
    expect(d.txPacedStats!.burstMax).toBe(BURST.length);

    const posted: MoveLimiterEvent[] = [];
    const reporter = new MoveLimiterReporter({
      endpoint: 'https://bridge.example/__client', build: '3a633e578d83', trace: '4b166f6470f68817',
      era: () => 'classic-dereth-1-0', server: () => null,
      context: () => ({ sources: ['key_down', 'key_up', 'stop_moving'], fps: 60, routine: null, txPaced: conn.getDiagnostics().txPaced ?? null, paced: conn.getDiagnostics().txPacedStats ?? null, agent: false }),
      now: () => Date.now(),
      send: (_url, body) => { posted.push(JSON.parse(body) as MoveLimiterEvent); },
    });
    vi.advanceTimersByTime(1000);
    reporter.engage('pacer', { recent: 0, fields: ['forward', 'movementEvent'], origins: [] });
    expect(posted).toHaveLength(1);
    const ev = posted[0];
    expect(ev).toMatchObject({
      outcome: 'move_limiter', limiter: 'pacer', recent: 0, txPaced: 150, agent: false,
      pacedTop: [{ op: 'f7b1:0036', n: 60 }, { op: 'f7b1:0019', n: 50 }, { op: 'f61c', n: 30 }, { op: 'f7b1:0015', n: 10 }],
      pacedBurst: 300,
    });
    expect(ev.pacedPending).toBeGreaterThan(0);
    expect(ev.pacedDrainMs).toBeGreaterThanOrEqual(1000);
    expect(JSON.stringify(ev).length).toBeLessThan(4 * 1024); // the bridge's /client-preworld body cap

    const clean = sanitizeClientMoveLimiter({ ...ev, eid: '0123456789ab' })!;
    expect(clean).toMatchObject({
      limiter: 'pacer', txPaced: 150, pacedTop: ev.pacedTop, pacedBurst: 300, pacedDrainMs: ev.pacedDrainMs,
      pacedPending: ev.pacedPending, agent: false,
    });
    conn.disconnect();
  });

  it('a movement-limiter event (nothing held) says null for the pacer fields; the bridge drops malformed entries', () => {
    const posted: MoveLimiterEvent[] = [];
    const reporter = new MoveLimiterReporter({
      endpoint: 'https://bridge.example/__client', build: 'x', trace: 'abcdef0123456789', era: () => 'ac1999', server: () => null,
      context: () => ({ sources: [], fps: 60, routine: null, txPaced: 0, agent: true }),
      send: (_url, body) => { posted.push(JSON.parse(body) as MoveLimiterEvent); },
    });
    reporter.engage('budget', { recent: 40, fields: ['forward'], origins: ['event'] });
    expect(posted[0]).toMatchObject({ pacedTop: null, pacedBurst: null, pacedDrainMs: null, pacedPending: null, agent: true });
    const clean = sanitizeClientMoveLimiter({
      outcome: 'move_limiter', limiter: 'pacer', agent: 'yes', pacedBurst: -1, pacedDrainMs: 1.5,
      pacedTop: [{ op: 'f7b1:0019', n: 5 }, { op: 'Claude Arcanist', n: 3 }, { op: 'f61c', n: -2 }, 'f7b1:0036', { op: 'other', n: 1 },
        ...Array.from({ length: 20 }, () => ({ op: 'f61c', n: 1 }))],
    })!;
    expect(clean.pacedTop).toHaveLength(5);
    expect(clean.pacedTop!.slice(0, 2)).toEqual([{ op: 'f7b1:0019', n: 5 }, { op: 'other', n: 1 }]);
    expect(clean).toMatchObject({ agent: null, pacedBurst: null, pacedDrainMs: null });
  });
});
