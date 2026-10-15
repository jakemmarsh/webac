/**
 * BUG.hidden-tab-session-drop — sessions in a long-hidden tab (2026-10-15
 * production: a 7.5 h and a 5.3 h world session and a 17 min chargen session
 * ended with the bridge logging `ws_close` while the tab was hidden).
 *
 * What these pin, driving the real modules with fake timers:
 *  - The page's 40 s DISCONNECT_TIME check reads the worker's link sample
 *    (NetWorkerClient.getLinkStatus). A page that stopped running (a frozen
 *    background tab, a long main-thread task) while the worker kept hearing
 *    the server no longer reads as a silent server when its timer fires
 *    before the worker's queued samples; a server that really went silent is
 *    still caught.
 *  - The worker's own dead-server drop (ClientConnection, 140 s) and the
 *    AC1999 connection's 60 s timeout measure silence by received data and
 *    skip the tick after their own thread was stopped longer than the limit
 *    (the 1999 one did not: a frozen tab's first tick closed a live session).
 *  - Every 'disconnected' says what ended the session (endCause, closeCode),
 *    the world telemetry carries it with the page's hidden time and freezes,
 *    and the bridge logs the browser socket's close code: the fields that
 *    tell a network/edge drop from the client's own close next time.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import * as dgram from 'dgram';
import { WebSocket as NodeWebSocket } from 'ws';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  hostClientConnection, PacketHeaderFlags, type PacketHeaderData, PACKET_HEADER_SIZE,
  writePacketHeader, fragmentMessage, writeFragment, FRAGMENT_HEADER_SIZE,
  GameMessageGroup, type ConnectionEvent, type NetCommand, type NetReply,
} from '@ac/network';
import { Connection1999 } from '../packages/network/src/era1999/Connection1999.js';
import { NetWorkerClient, SNAPSHOT_EXTRAPOLATION_MAX_MS, type NetWorkerEndpoint } from '../packages/renderer/src/network/NetWorkerClient.js';
import { linkSampleIsDead } from '../packages/renderer/src/ui/ConnectionNotices.js';
import { WorldReporter, type WorldEvent } from '../packages/renderer/src/telemetry/WorldReporter.js';
import { sanitizeClientWorld } from '../services/ws-tcp-bridge/src/clientWorld.js';
import { resolveBridgeConfig } from '../services/ws-tcp-bridge/src/bridgeUtil.js';
import { createBridgeServer } from '../services/ws-tcp-bridge/src/server.js';

// ── An end-of-retail session through the worker pipe (as verify-net-worker.ts) ──

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static last: FakeWebSocket | null = null;
  readyState = FakeWebSocket.CONNECTING;
  binaryType = 'arraybuffer';
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closedByUs = false;
  constructor(public url: string) { FakeWebSocket.last = this; }
  send(): void { /* not inspected here */ }
  /** Our own close(): no code, as the browser reports it (1005). */
  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.closedByUs = true;
    this.readyState = FakeWebSocket.CLOSED;
    setTimeout(() => this.onclose?.({ code: 1005 }), 0);
  }
  /** The other side (bridge, edge, network) ended the connection. */
  remoteClose(code: number): void { this.readyState = FakeWebSocket.CLOSED; this.onclose?.({ code }); }
  open(): void { this.readyState = FakeWebSocket.OPEN; this.onopen?.({}); }
  receive(bytes: Uint8Array): void { this.onmessage?.({ data: bytes.slice().buffer }); }
}

function packet(seq: number, flags: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const buf = new Uint8Array(PACKET_HEADER_SIZE + payload.length);
  const header: PacketHeaderData = { sequence: seq, flags, checksum: 0, id: 0xB, time: 0, size: payload.length, iteration: 1 };
  writePacketHeader(header, buf, 0);
  buf.set(payload, PACKET_HEADER_SIZE);
  return buf;
}
function connectRequest(): Uint8Array {
  const payload = new Uint8Array(32);
  const v = new DataView(payload.buffer);
  v.setFloat64(0, 12345.0, true);
  payload.fill(0x11, 8, 16);
  v.setUint32(16, 0x0007, true);
  payload.set([1, 2, 3, 4], 20);
  payload.set([5, 6, 7, 8], 24);
  return packet(0, PacketHeaderFlags.ConnectRequest, payload);
}
let fragSeq = 0;
function serverMessage(seq: number): Uint8Array {
  const m = new Uint8Array(8);
  new DataView(m.buffer).setUint32(0, 0xdead, true);
  const [f] = fragmentMessage(m, 0x80000000, GameMessageGroup.UIQueue, fragSeq++);
  const payload = new Uint8Array(FRAGMENT_HEADER_SIZE + f.data.length);
  writeFragment(f, payload, 0);
  return packet(seq, PacketHeaderFlags.BlobFragments | PacketHeaderFlags.EncryptedChecksum, payload);
}

/** Worker ↔ page; `blocked` = the page is not running (its inbox is held). */
function workerSession() {
  const hostListeners: Array<(ev: { data: NetCommand }) => void> = [];
  const pageListeners: Array<(ev: MessageEvent<NetReply>) => void> = [];
  const inbox: NetReply[] = [];
  const state = { blocked: false };
  const deliver = (r: NetReply) => { for (const l of pageListeners) l({ data: r } as MessageEvent<NetReply>); };
  stopHost = hostClientConnection({
    postMessage: (r) => { const copy = structuredClone(r); if (state.blocked) inbox.push(copy); else deliver(copy); },
    addEventListener: (_t, l) => { hostListeners.push(l); },
  });
  const endpoint: NetWorkerEndpoint = {
    postMessage: (cmd) => { const copy = structuredClone(cmd); for (const l of hostListeners) l({ data: copy }); },
    addEventListener: (_t, l) => { pageListeners.push(l); },
  };
  const client = new NetWorkerClient(endpoint, 'ws://sim');
  client.autoReconnect = false;
  const events: ConnectionEvent[] = [];
  client.on((e) => events.push(e));
  client.connect('acct', 'pw');
  const ws = FakeWebSocket.last!;
  ws.open();
  ws.receive(connectRequest());
  const unblock = () => { state.blocked = false; for (const r of inbox.splice(0)) deliver(r); };
  const disconnects = () => events.filter(e => e.type === 'disconnected');
  return { client, ws, state, unblock, events, disconnects };
}

let saved: unknown;
let stopHost: (() => void) | null = null;
beforeEach(() => {
  saved = (globalThis as { WebSocket?: unknown }).WebSocket;
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  stopHost?.();
  stopHost = null;
  vi.useRealTimers();
  (globalThis as { WebSocket?: unknown }).WebSocket = saved;
  vi.restoreAllMocks();
});

describe('the page link check reads the worker, not the page clock', () => {
  it('a page stopped for 45 s while the server kept talking: its first timer reads a live link', () => {
    const s = workerSession();
    s.state.blocked = true;
    for (let seq = 2; seq <= 16; seq++) {
      vi.advanceTimersByTime(3000);
      s.ws.receive(serverMessage(seq));
    }
    // The page's link tick runs before the worker's queued samples reach it.
    const sample = s.client.getLinkStatus(Date.now());
    expect(sample.connected).toBe(true);
    expect(sample.secondsSinceLastPacket).toBeLessThanOrEqual(SNAPSHOT_EXTRAPOLATION_MAX_MS / 1000 + 0.5);
    expect(linkSampleIsDead(sample)).toBe(false);
    s.unblock();
    expect(linkSampleIsDead(s.client.getLinkStatus(Date.now()))).toBe(false);
    expect(s.disconnects()).toHaveLength(0);
  });

  it('a server that really went silent still reads dead past 40 s (the samples carry the silence)', () => {
    const s = workerSession();
    s.ws.receive(serverMessage(2));
    vi.advanceTimersByTime(41_000);
    expect(linkSampleIsDead(s.client.getLinkStatus(Date.now()))).toBe(true);
    // And for a page that was stopped through the silence, once its inbox runs.
    const t = workerSession();
    t.ws.receive(serverMessage(2));
    t.state.blocked = true;
    vi.advanceTimersByTime(41_000);
    t.unblock();
    expect(linkSampleIsDead(t.client.getLinkStatus(Date.now()))).toBe(true);
  });
});

describe('the worker drop measures silence by received data', () => {
  it('a worker stopped 150 s (frozen tab) whose queued server packets arrive after its first tick keeps the session', () => {
    const s = workerSession();
    s.ws.receive(serverMessage(2));
    vi.advanceTimersByTime(1000);
    vi.setSystemTime(Date.now() + 150_000); // no timer ran: the thread was stopped
    vi.advanceTimersByTime(100); // the first tick after the stop
    s.ws.receive(serverMessage(3)); // the packets the browser held for the frozen worker
    vi.advanceTimersByTime(2000);
    expect(s.disconnects()).toHaveLength(0);
    expect(s.ws.closedByUs).toBe(false);
  });

  it('140 s of real silence: the client closes the socket and says why (server_silent)', () => {
    const s = workerSession();
    s.ws.receive(serverMessage(2));
    vi.advanceTimersByTime(141_000);
    expect(s.ws.closedByUs).toBe(true);
    expect(s.disconnects()).toEqual([expect.objectContaining({ everOpened: true, deliberate: false, endCause: 'server_silent' })]);
    expect(s.disconnects()[0]).not.toHaveProperty('closeCode');
  });

  it('every other end names itself: a remote close with its code, a server Disconnect, our own disconnect()', () => {
    const a = workerSession();
    a.ws.receive(serverMessage(2));
    a.ws.remoteClose(1006);
    expect(a.disconnects()).toEqual([expect.objectContaining({ deliberate: false, endCause: 'socket_closed', closeCode: 1006 })]);

    const b = workerSession();
    b.ws.receive(packet(0, PacketHeaderFlags.Disconnect));
    expect(b.disconnects()).toEqual([expect.objectContaining({ deliberate: false, endCause: 'server_disconnect' })]);
    vi.advanceTimersByTime(10); // the socket's own close that follows reports nothing more
    expect(b.disconnects()).toHaveLength(1);

    const c = workerSession();
    c.client.disconnect();
    vi.advanceTimersByTime(10);
    expect(c.disconnects()).toEqual([expect.objectContaining({ deliberate: true, endCause: 'local' })]);
  });
});

// ── AC1999: the same timeout, over the real server's recorded traffic ──

const s2c: Uint8Array[] = gunzipSync(readFileSync(resolve(__dirname, 'fixtures', 'ac1999-session-001.jsonl.gz')))
  .toString().trim().split('\n').map((l) => JSON.parse(l))
  .filter((j) => j.d === 's2c').map((j) => new Uint8Array(Buffer.from(j.b, 'base64')));

class FakeSocket1999 {
  static OPEN = 1;
  static last: FakeSocket1999 | null = null;
  readyState = 0;
  binaryType = '';
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer | string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((ev?: { code: number }) => void) | null = null;
  closedByUs = false;
  constructor(readonly url: string) { FakeSocket1999.last = this; }
  send(): void { /* not inspected */ }
  close(): void { this.closedByUs = true; this.readyState = 3; this.onclose?.({ code: 1005 }); }
  open(): void { this.readyState = 1; this.onopen?.(); }
  deliver(b: Uint8Array): void { this.onmessage?.({ data: b.slice().buffer }); }
}

function session1999() {
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeSocket1999;
  const conn = new Connection1999('ws://bridge');
  conn.datIterations = { portal: 102, cell: 67, language: 0 };
  const events: ConnectionEvent[] = [];
  conn.on((e) => events.push(e));
  conn.connect('acjsdbja', 'acjsdbja');
  const sock = FakeSocket1999.last!;
  sock.open();
  let i = 0;
  for (; i < s2c.length && !events.some((e) => e.type === 'characterList'); i++) sock.deliver(s2c[i]);
  expect(events.some((e) => e.type === 'characterList')).toBe(true);
  return { conn, sock, events, next: s2c[i] ?? s2c[s2c.length - 1], disconnects: () => events.filter(e => e.type === 'disconnected') };
}

describe('Connection1999 timeout', () => {
  it('a thread stopped 70 s: the first tick after it does not close a session whose packets are queued', () => {
    const s = session1999();
    vi.advanceTimersByTime(500);
    vi.setSystemTime(Date.now() + 70_000);
    vi.advanceTimersByTime(100);
    s.sock.deliver(s.next);
    vi.advanceTimersByTime(1000);
    expect(s.sock.closedByUs).toBe(false);
    expect(s.disconnects()).toHaveLength(0);
    expect(s.events.some(e => e.type === 'serverTimeout')).toBe(false);
  });

  it('60 s of real silence still ends it, once, as server_silent', () => {
    const s = session1999();
    vi.advanceTimersByTime(61_000);
    expect(s.sock.closedByUs).toBe(true);
    expect(s.events.filter(e => e.type === 'serverTimeout')).toHaveLength(1);
    expect(s.disconnects()).toEqual([expect.objectContaining({ deliberate: false, endCause: 'server_silent' })]);
  });

  it('a remote close reports its code; our own disconnect() reads local', () => {
    const a = session1999();
    a.sock.readyState = 3;
    a.sock.onclose?.({ code: 1006 });
    expect(a.disconnects()).toEqual([expect.objectContaining({ deliberate: false, endCause: 'socket_closed', closeCode: 1006 })]);
    const b = session1999();
    b.conn.disconnect();
    expect(b.disconnects()).toEqual([expect.objectContaining({ deliberate: true, endCause: 'local' })]);
  });
});

// ── Telemetry: what the next drop report will say ──

describe('world telemetry carries the drop detail', () => {
  function reporter() {
    const clock = { t: 0 };
    const events: WorldEvent[] = [];
    const r = new WorldReporter({
      endpoint: 'http://x/client-preworld', build: 'abc1234', trace: 'feedc0de12345678', era: () => 'eor', server: () => 'dreamweave',
      now: () => clock.t, send: (_u, b) => { events.push(JSON.parse(b) as WorldEvent); },
    });
    return { r, clock, events };
  }

  it('world_left after a hidden, frozen session: endCause, closeCode, hiddenMs, freezes; the bridge keeps them', () => {
    const { r, clock, events } = reporter();
    r.enteredWorld();
    clock.t = 61_000;
    r.tick(); // the first minute goes out
    clock.t = 100_000;
    r.hidden();
    clock.t = 200_000;
    r.frozen();
    clock.t = 230_000;
    r.pageResumed();
    clock.t = 400_000;
    r.left('disconnected', { endCause: 'socket_closed', closeCode: 1006 });
    const left = events.find(e => e.outcome === 'world_left')!;
    expect(left).toMatchObject({ exit: 'disconnected', endCause: 'socket_closed', closeCode: 1006, hiddenMs: 300_000, freezes: 1, frozenMs: 30_000 });
    expect(sanitizeClientWorld(left)).toMatchObject({ endCause: 'socket_closed', closeCode: 1006, hiddenMs: 300_000, freezes: 1, frozenMs: 30_000 });
  });

  it('a visible page reads hiddenMs null; the page\'s own 40 s verdict is link_dead; junk is dropped', () => {
    const { r, clock, events } = reporter();
    r.enteredWorld();
    clock.t = 61_000;
    r.tick();
    r.hidden();
    r.visible();
    clock.t = 90_000;
    r.left('disconnected', { endCause: 'link_dead' });
    const left = events.find(e => e.outcome === 'world_left')!;
    expect(left).toMatchObject({ endCause: 'link_dead', closeCode: null, hiddenMs: null, freezes: 0 });
    expect(sanitizeClientWorld({ ...left, endCause: 'because reasons', closeCode: 99, hiddenMs: -1 }))
      .toMatchObject({ endCause: null, closeCode: null, hiddenMs: null });
    // An older page that sends none of them: the fields stay absent.
    const { endCause: _e, closeCode: _c, hiddenMs: _h, freezes: _f, frozenMs: _z, ...old } = left as unknown as Record<string, unknown>;
    expect(sanitizeClientWorld(old)).not.toHaveProperty('endCause');
    expect(sanitizeClientWorld(old)).not.toHaveProperty('hiddenMs');
  });

  it('a drop inside the first minute puts endCause / closeCode on first_minute; a logout carries none', () => {
    const a = reporter();
    a.r.enteredWorld();
    a.clock.t = 10_000;
    a.r.left('disconnected', { endCause: 'server_disconnect' });
    expect(a.events[0]).toMatchObject({ outcome: 'first_minute', exit: 'disconnected', endCause: 'server_disconnect', closeCode: null });
    expect(sanitizeClientWorld(a.events[0])).toMatchObject({ endCause: 'server_disconnect' });
    const b = reporter();
    b.r.enteredWorld();
    b.clock.t = 10_000;
    b.r.left('logout');
    expect(b.events[0]).not.toHaveProperty('endCause');
  });
});

describe('the bridge logs the browser socket\'s close code', () => {
  it('session_close peerCloseCode: 1005 for the page\'s own close(), 1006 for a dropped connection', async () => {
    vi.useRealTimers();
    const udp = dgram.createSocket('udp4');
    await new Promise<void>(r => udp.bind(0, '127.0.0.1', () => r()));
    const udpPort = (udp.address() as { port: number }).port;
    const logs: Array<[string, Record<string, unknown>]> = [];
    const config = resolveBridgeConfig(['0', '127.0.0.1', String(udpPort)], { BRIDGE_SERVERS_URL: 'none', BRIDGE_SERVERS_CACHE: 'none' });
    config.wsPort = 0;
    const bridge = createBridgeServer(config, { log: (_level, event, fields) => { logs.push([event, fields ?? {}]); } });
    const port = await bridge.listen();
    const until = async (f: () => boolean) => {
      const end = Date.now() + 3000;
      while (!f()) { if (Date.now() > end) throw new Error('timeout'); await new Promise(r => setTimeout(r, 10)); }
    };
    const closes = () => logs.filter(l => l[0] === 'session_close').map(l => l[1]);
    try {
      const ws = new NodeWebSocket(`ws://127.0.0.1:${port}/`);
      await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
      ws.close();
      await until(() => closes().length === 1);
      expect(closes()[0]).toMatchObject({ reason: 'ws_close', peerCloseCode: 1005 });
      const ws2 = new NodeWebSocket(`ws://127.0.0.1:${port}/`);
      await new Promise<void>((res, rej) => { ws2.once('open', () => res()); ws2.once('error', rej); });
      ws2.terminate();
      await until(() => closes().length === 2);
      expect(closes()[1]).toMatchObject({ reason: 'ws_close', peerCloseCode: 1006 });
    } finally {
      await bridge.shutdown();
      udp.close();
    }
  });
});
