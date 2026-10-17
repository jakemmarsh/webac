/**
 * OBS.dm-stall-diagnostics — Dark Majesty (GDLE) sessions went silent a few
 * minutes in (2026-10-16 Snowreap: world_left endCause link_dead after ~4 min;
 * 2026-10-15 Seedsow: 8 reloads), and nothing said which way traffic stopped.
 * Both connections now answer getDiagnostics() (NetDiagnostics.ts), the worker
 * ships it with each snapshot, and the telemetry of a session that ended
 * link_dead / server_silent / socket_closed carries it, bounded on the page
 * and again on the bridge.
 *
 * Also BUG.gdle-echo-reply-marks-lost-received: GDLE answers our keepalive's
 * EchoRequest with a cleartext EchoResponse stamped with its CURRENT sequence
 * (Seedsow PacketController.cpp ProcessBlob → SendConnectlessBlob(...,
 * BT_ECHORESPONSE, m_out.sequence)). When the server's packet N had been
 * lost, that reply entered the reorder buffer as "N received", so N was never
 * NAKed and its messages were gone for good.
 *
 * Everything drives the shipped modules: ClientConnection / Connection1999 over
 * fake sockets (the 1999 one on the real server's recorded traffic), the
 * worker pipe, the page reporters and the bridge sanitizers.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ClientConnection, hostClientConnection, PacketHeaderFlags, type PacketHeaderData, PACKET_HEADER_SIZE,
  writePacketHeader, readPacketHeader, fragmentMessage, writeFragment, FRAGMENT_HEADER_SIZE,
  GameMessageGroup, boundNetDiagnostics, type ConnectionEvent, type NetCommand, type NetReply, type NetDiagnostics,
  NET_DIAG_TX_RING, TxRing, messageLabel, joinLabels,
} from '@ac/network';
import { Connection1999 } from '../packages/network/src/era1999/Connection1999.js';
import { NetWorkerClient, type NetWorkerEndpoint } from '../packages/renderer/src/network/NetWorkerClient.js';
import { WorldReporter, type WorldEvent, type WorldLeftEvent, type FirstMinuteEvent } from '../packages/renderer/src/telemetry/WorldReporter.js';
import { PreworldReporter, type PreworldEvent } from '../packages/renderer/src/telemetry/PreworldReporter.js';
import { sanitizeClientWorld } from '../services/ws-tcp-bridge/src/clientWorld.js';
import { sanitizeClientPreworld, CLIENT_PREWORLD_MAX_BODY } from '../services/ws-tcp-bridge/src/clientPreworld.js';
import { sanitizeNetDiag } from '../services/ws-tcp-bridge/src/netDiag.js';

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static last: FakeWebSocket | null = null;
  readyState = FakeWebSocket.CONNECTING;
  binaryType = 'arraybuffer';
  bufferedAmount = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: Uint8Array[] = [];
  constructor(public url: string) { FakeWebSocket.last = this; }
  send(data: ArrayBuffer | Uint8Array): void { this.sent.push(new Uint8Array(data instanceof Uint8Array ? data : new Uint8Array(data)).slice()); }
  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    setTimeout(() => this.onclose?.({}), 0);
  }
  open(): void { this.readyState = FakeWebSocket.OPEN; this.onopen?.({}); }
  receive(bytes: Uint8Array): void { this.onmessage?.({ data: bytes.slice().buffer }); }
}

const SERVER_ID = 0xB;
function packet(seq: number, flags: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const buf = new Uint8Array(PACKET_HEADER_SIZE + payload.length);
  const header: PacketHeaderData = { sequence: seq, flags, checksum: 0, id: SERVER_ID, time: 0, size: payload.length, iteration: 1 };
  writePacketHeader(header, buf, 0);
  buf.set(payload, PACKET_HEADER_SIZE);
  return buf;
}
function u32List(seqs: number[]): Uint8Array {
  const b = new Uint8Array(4 + seqs.length * 4);
  const v = new DataView(b.buffer);
  v.setUint32(0, seqs.length, true);
  seqs.forEach((s, i) => v.setUint32(4 + i * 4, s, true));
  return b;
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
let fragSeq = 2; // GDLE's first fragment sequence
function serverMessage(seq: number, tag: number): Uint8Array {
  const m = new Uint8Array(8);
  new DataView(m.buffer).setUint32(0, 0xdead, true);
  new DataView(m.buffer).setUint32(4, tag, true);
  const [f] = fragmentMessage(m, 0x80000000, GameMessageGroup.UIQueue, fragSeq++);
  const payload = new Uint8Array(FRAGMENT_HEADER_SIZE + f.data.length);
  writeFragment(f, payload, 0);
  return packet(seq, PacketHeaderFlags.BlobFragments | PacketHeaderFlags.EncryptedChecksum, payload);
}
function tags(events: ConnectionEvent[]): number[] {
  return events.filter(e => e.type === 'message').map(e => {
    const p = (e.data as { payload: Uint8Array }).payload; // the bytes after the 0xdead opcode
    return new DataView(p.buffer, p.byteOffset).getUint32(0, true);
  });
}
function naksSent(ws: FakeWebSocket): number[][] {
  return ws.sent.filter(p => readPacketHeader(p, 0).flags === PacketHeaderFlags.RequestRetransmit).map((p) => {
    const v = new DataView(p.buffer, p.byteOffset + PACKET_HEADER_SIZE);
    return Array.from({ length: v.getUint32(0, true) }, (_, i) => v.getUint32(4 + i * 4, true));
  });
}

let saved: unknown;
beforeEach(() => {
  saved = (globalThis as { WebSocket?: unknown }).WebSocket;
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  fragSeq = 2;
});
afterEach(() => {
  vi.useRealTimers();
  (globalThis as { WebSocket?: unknown }).WebSocket = saved;
  vi.restoreAllMocks();
});

/** A GDLE-shaped session on a ClientConnection, past the handshake. */
function session() {
  const conn = new ClientConnection('ws://sim');
  conn.autoReconnect = false;
  const events: ConnectionEvent[] = [];
  conn.on((e) => events.push(e));
  conn.connect('acct', 'pw');
  const ws = FakeWebSocket.last!;
  ws.open();
  ws.receive(connectRequest());
  return { conn, events, ws };
}

describe('BUG.gdle-echo-reply-marks-lost-received — a cleartext reply stamped with the server sequence is not that packet', () => {
  it('Seedsow: packet 3 lost, the EchoResponse stamped 3 arrives → 3 is NAKed, and the real 3 is delivered when it comes', () => {
    const s = session();
    s.ws.receive(serverMessage(2, 1));
    const lost3 = serverMessage(3, 2); // dropped on the way
    // ProcessBlob BT_ECHORESPONSE: SendConnectlessBlob(peer, {echo, echo}, BT_ECHORESPONSE, m_out.sequence)
    s.ws.receive(packet(3, PacketHeaderFlags.EchoResponse, new Uint8Array(8)));
    expect(tags(s.events)).toEqual([1]); // message 2 is held back
    expect(s.conn.getDiagnostics()).toMatchObject({ rxAck: 2, rxHigh: 3, rxMissing: 1, rxFlags: '0x04000000' });
    vi.advanceTimersByTime(700); // the NAK cadence (0.6 s after the first PAK)
    expect(naksSent(s.ws).some(list => list.includes(3))).toBe(true);
    s.ws.receive(lost3); // the server's resend
    expect(tags(s.events)).toEqual([1, 2]);
    const d = s.conn.getDiagnostics();
    expect(d).toMatchObject({ rxAck: 3, rxMissing: 0, rxHeld: 0 });
    expect(d.naks).toBeGreaterThanOrEqual(1);
  });

  it('an echo reply for a packet already received changes nothing; ACE\'s cleartext RejectRetransmit (a fresh sequence) is still delivered in order', () => {
    const s = session();
    s.ws.receive(serverMessage(2, 1));
    s.ws.receive(packet(2, PacketHeaderFlags.EchoResponse, new Uint8Array(8)));
    expect(s.conn.getDiagnostics()).toMatchObject({ rxAck: 2, rxMissing: 0 });
    // ACE PacketRejectRetransmit: flags exactly RejectRetransmit, FlushPackets gives it NextValue (3).
    s.ws.receive(packet(3, PacketHeaderFlags.RejectRetransmit, u32List([])));
    s.ws.receive(serverMessage(4, 2));
    vi.advanceTimersByTime(2000);
    expect(s.conn.getDiagnostics()).toMatchObject({ rxAck: 4, rxMissing: 0 });
    expect(naksSent(s.ws)).toEqual([]);
    expect(tags(s.events)).toEqual([1, 2]);
  });
});

describe('OBS.dm-stall-diagnostics — ClientConnection.getDiagnostics', () => {
  it('reports what came in and went out: sequences, the last flags / opcode / event, acks and packet counts', () => {
    const s = session();
    s.ws.receive(serverMessage(2, 1));
    // A GameEvent (0xF7B0, guid, sequence, event type 0x02BD).
    const ev = new Uint8Array(16);
    const evv = new DataView(ev.buffer);
    evv.setUint32(0, 0xF7B0, true); evv.setUint32(4, 0x50000001, true); evv.setUint32(8, 1, true); evv.setUint32(12, 0x02BD, true);
    const [f] = fragmentMessage(ev, 0x80000000, GameMessageGroup.UIQueue, fragSeq++);
    const payload = new Uint8Array(FRAGMENT_HEADER_SIZE + f.data.length);
    writeFragment(f, payload, 0);
    s.ws.receive(packet(3, PacketHeaderFlags.BlobFragments | PacketHeaderFlags.EncryptedChecksum, payload));
    s.conn.sendMessage(new Uint8Array([0xB1, 0xF7, 0, 0, 0, 0, 0, 0]));
    s.conn.sendMessage(new Uint8Array([0xB1, 0xF7, 0, 0, 1, 0, 0, 0]));
    let d = s.conn.getDiagnostics();
    expect(d).toMatchObject({
      rxAck: 3, rxHigh: 3, rxHeld: 0, rxMissing: 0, fragHeld: 0,
      rxFlags: '0x00000006', rxOpcode: '0x0000f7b0', rxEvent: '0x000002bd',
      txSeq: 3, txUnacked: 2, txAckedBySrv: 0, naks: 0, srvNaks: 0, resent: 0, unsatisfied: 0,
      rxAgoMs: 0, rxMsgAgoMs: 0, rxSeqAgoMs: 0, txSeqAgoMs: 0, wsBuffered: 0, rxPkts: 3,
    });
    expect(d.txPkts).toBeGreaterThanOrEqual(4); // login, ConnectResponse, first PAK, two messages
    expect(d.rxBytes).toBeGreaterThan(0);
    // GDLE's ack (connectionless, stamped m_out.sequence): {activesequence}.
    s.ws.receive(packet(3, PacketHeaderFlags.AckSequence, u32List([3]).subarray(4)));
    d = s.conn.getDiagnostics();
    expect(d).toMatchObject({ txAckedBySrv: 3, txUnacked: 1, rxFlags: '0x00004000', rxAck: 3 });
  });

  it('a server that asks for one cached and one long-gone sequence: resent, unsatisfied and the server NAK are counted', () => {
    const s = session();
    s.ws.receive(serverMessage(2, 1));
    s.conn.sendMessage(new Uint8Array([0xB1, 0xF7, 0, 0, 0, 0, 0, 0])); // our seq 2
    vi.advanceTimersByTime(1000);
    // GDLE ThinkInbound: SendConnectlessBlob(peer, {count, seqs}, BT_REQUESTLOST, ...) — cleartext.
    s.ws.receive(packet(0, PacketHeaderFlags.RequestRetransmit, u32List([2, 1999])));
    const d = s.conn.getDiagnostics();
    expect(d).toMatchObject({ srvNaks: 2, resent: 1, unsatisfied: 1, srvNakAgoMs: 0 });
    expect(s.ws.sent.some(p => readPacketHeader(p, 0).flags === PacketHeaderFlags.RejectRetransmit)).toBe(true);
  });

  it('a server gone silent: rxAgoMs grows while our sequenced keepalives keep going (txSeqAgoMs < 3.1 s)', () => {
    const s = session();
    s.ws.receive(serverMessage(2, 1));
    vi.advanceTimersByTime(45_000);
    const d = s.conn.getDiagnostics();
    expect(d.rxAgoMs).toBeGreaterThanOrEqual(45_000);
    expect(d.rxMsgAgoMs).toBeGreaterThanOrEqual(45_000);
    expect(d.txSeqAgoMs!).toBeLessThan(3_100);
    expect(d.txSeq).toBeGreaterThanOrEqual(15); // ~3 s keepalives
    expect(d.tickAgoMs!).toBeLessThanOrEqual(100);
    expect(d.tickGapMaxMs).toBeLessThan(200);
  });

  it('a stalled clock (a frozen worker) shows as tickGapMaxMs; a fresh connect() starts the counters over', () => {
    const s = session();
    s.ws.receive(serverMessage(2, 1));
    vi.setSystemTime(Date.now() + 25_000); // the thread did not run for 25 s
    vi.advanceTimersByTime(100);
    expect(s.conn.getDiagnostics().tickGapMaxMs).toBeGreaterThanOrEqual(25_000);
    s.conn.disconnect();
    s.conn.autoReconnect = false;
    s.conn.connect('acct', 'pw');
    const d = s.conn.getDiagnostics();
    expect(d).toMatchObject({ tickGapMaxMs: 0, rxPkts: 0, rxAgoMs: null, rxOpcode: null, naks: 0, resent: 0 });
  });
});

// ── Through the worker (NetWorkerClient ↔ hostClientConnection) ──

function pipe() {
  const hostListeners: Array<(ev: { data: NetCommand }) => void> = [];
  const pageListeners: Array<(ev: MessageEvent<NetReply>) => void> = [];
  const state = { blocked: false };
  const stop = hostClientConnection({
    postMessage: (r) => { if (state.blocked) return; const copy = structuredClone(r); for (const l of pageListeners) l({ data: copy } as MessageEvent<NetReply>); },
    addEventListener: (_t, l) => { hostListeners.push(l); },
  });
  const endpoint: NetWorkerEndpoint = {
    postMessage: (cmd) => { const copy = structuredClone(cmd); for (const l of hostListeners) l({ data: copy }); },
    addEventListener: (_t, l) => { pageListeners.push(l); },
  };
  return { endpoint, state, stop };
}

describe('OBS.dm-stall-diagnostics — the page reads the worker\'s diagnostics', () => {
  it('each snapshot carries them; snapAgeMs says how long the page has gone without one', () => {
    const p = pipe();
    try {
      const client = new NetWorkerClient(p.endpoint, 'ws://sim');
      client.autoReconnect = false;
      expect(client.getDiagnostics()).toMatchObject({ rxPkts: 0, txPkts: 0, rxAgoMs: null });
      client.connect('acct', 'pw');
      const ws = FakeWebSocket.last!;
      ws.open();
      ws.receive(connectRequest());
      ws.receive(serverMessage(2, 1));
      vi.advanceTimersByTime(300);
      let d = client.getDiagnostics();
      expect(d).toMatchObject({ rxAck: 2, rxOpcode: '0x0000dead' });
      expect(d.snapAgeMs!).toBeLessThanOrEqual(250);
      p.state.blocked = true; // the worker's snapshots stop reaching the page
      vi.advanceTimersByTime(5_000);
      d = client.getDiagnostics();
      expect(d.snapAgeMs!).toBeGreaterThanOrEqual(4_750);
    } finally {
      p.stop();
    }
  });
});

// ── AC1999 (Connection1999) on the real server's recorded traffic ──

describe('OBS.dm-stall-diagnostics — Connection1999.getDiagnostics', () => {
  class FakeSocket1999 {
    static OPEN = 1;
    static sockets: FakeSocket1999[] = [];
    readyState = 0;
    binaryType = '';
    bufferedAmount = 0;
    sent: Uint8Array[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((ev: { data: ArrayBuffer | string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    constructor(readonly url: string) { FakeSocket1999.sockets.push(this); }
    send(b: Uint8Array): void { this.sent.push(b); }
    close(): void { this.readyState = 3; this.onclose?.(); }
    open(): void { this.readyState = 1; this.onopen?.(); }
    deliver(b: Uint8Array): void { this.onmessage?.({ data: b.slice().buffer }); }
  }

  it('after the login: server packets, the in-order sequence, the last opcode and our sends', () => {
    (globalThis as { WebSocket?: unknown }).WebSocket = FakeSocket1999;
    const s2c: Uint8Array[] = gunzipSync(readFileSync(resolve(__dirname, 'fixtures', 'ac1999-session-001.jsonl.gz')))
      .toString().trim().split('\n').map((l) => JSON.parse(l))
      .filter((j) => j.d === 's2c').map((j) => new Uint8Array(Buffer.from(j.b, 'base64')));
    const conn = new Connection1999('ws://bridge');
    conn.datIterations = { portal: 102, cell: 67, language: 0 };
    const events: ConnectionEvent[] = [];
    conn.on((e) => events.push(e));
    expect(conn.getDiagnostics()).toMatchObject({ rxPkts: 0, txPkts: 0, rxAgoMs: null, tickAgoMs: null });
    conn.connect('acjsdbja', 'acjsdbja');
    const sock = FakeSocket1999.sockets[FakeSocket1999.sockets.length - 1];
    sock.open();
    let delivered = 0;
    for (const b of s2c) {
      sock.deliver(b);
      delivered++;
      if (events.some((e) => e.type === 'characterList')) break;
    }
    const d = conn.getDiagnostics();
    expect(d.rxPkts).toBe(delivered);
    expect(d.rxAck).toBeGreaterThan(0);
    expect(d.rxHigh).toBeGreaterThanOrEqual(d.rxAck);
    expect(d.rxOpcode).toMatch(/^0x[0-9a-f]{8}$/);
    expect(d.rxFlags).toMatch(/^0x[0-9a-f]{8}$/);
    expect(d.txPkts).toBe(sock.sent.length);
    expect(d.rxAgoMs).toBe(0);
    expect(d.rxMsgAgoMs).toBe(0);
    // OBS.dm-stall-tx-ring — our sequenced data packets ring with what they carried.
    const before = d.txSeq;
    conn.sendMessage(new Uint8Array([0xC8, 0xF7, 0, 0, 1, 0, 0, 0x50]));
    const after = conn.getDiagnostics();
    expect(after.txSeq).toBeGreaterThan(before);
    const last = after.txRecent![after.txRecent!.length - 1];
    expect(last).toMatchObject({ seq: after.txSeq, agoMs: 0 });
    expect(last.what).toMatch(/^[0-9a-f]{4,8}$/);
    expect(last.flags).toMatch(/^0x[0-9a-f]{8}$/);
    conn.disconnect();
  });
});

// ── The page's telemetry ──

function fullDiag(over: Partial<NetDiagnostics> = {}): NetDiagnostics {
  return {
    rxAgoMs: 41_234, rxMsgAgoMs: 44_000, rxSeqAgoMs: 41_234, rxFlags: '0x00004000', rxOpcode: '0x0000f74c', rxEvent: null,
    rxAck: 1234, rxHigh: 1236, rxHeld: 1, rxMissing: 1, fragHeld: 2, nakAgoMs: 300, naks: 5,
    txSeq: 456, txUnacked: 3, txAckedBySrv: 453, srvNakAgoMs: null, srvNaks: 0, resent: 0, unsatisfied: 0, srvRejects: 0,
    txAgoMs: 80, txSeqAgoMs: 1_500, wsBuffered: 0, tickAgoMs: 40, tickGapMaxMs: 1_010, rxPkts: 900, txPkts: 700, rxBytes: 66_000,
    snapAgeMs: 120, ...over,
  };
}

function worldRig() {
  const events: WorldEvent[] = [];
  const raw: string[] = [];
  const clock = { t: 1000 };
  const r = new WorldReporter({
    endpoint: 'http://x/client-preworld', build: 'abc1234', trace: 'feedc0de12345678', era: () => 'dm', server: () => 'snowreap',
    now: () => clock.t, send: (_u, b) => { raw.push(b); events.push(JSON.parse(b) as WorldEvent); },
  });
  r.setSources({ screen: () => 'world', canvas: () => ({ width: 16_000, height: 16_000 }), dpr: () => 8, hidden: () => false });
  return { r, events, raw, clock };
}

describe('OBS.dm-stall-diagnostics — WorldReporter / PreworldReporter carry the diagnostics', () => {
  it('world_left of a link_dead session carries net; a server disconnect or a logout does not', () => {
    const w = worldRig();
    w.r.enteredWorld();
    w.clock.t += 240_000;
    w.r.tick(); // the first minute went out
    w.r.left('disconnected', { endCause: 'link_dead', net: fullDiag() });
    const left = w.events.find(e => e.outcome === 'world_left') as WorldLeftEvent;
    expect(left.endCause).toBe('link_dead');
    expect(left.net).toMatchObject({ rxAgoMs: 41_234, rxAck: 1234, rxHigh: 1236, rxFlags: '0x00004000', rxOpcode: '0x0000f74c', snapAgeMs: 120 });

    w.r.enteredWorld();
    w.clock.t += 240_000;
    w.r.tick();
    w.r.left('disconnected', { endCause: 'server_disconnect', net: fullDiag() });
    const second = w.events.filter(e => e.outcome === 'world_left')[1] as WorldLeftEvent;
    expect(second.endCause).toBe('server_disconnect');
    expect('net' in second).toBe(false);

    // A drop after our own thread was stopped (sleep / frozen tab) carries it too.
    w.r.enteredWorld();
    w.clock.t += 240_000;
    w.r.tick();
    w.r.left('disconnected', { endCause: 'client_suspended', net: fullDiag() });
    const third = w.events.filter(e => e.outcome === 'world_left')[2] as WorldLeftEvent;
    expect(third.endCause).toBe('client_suspended');
    expect(third.net).toMatchObject({ rxAck: 1234 });
    expect(sanitizeClientWorld(third)).toMatchObject({ endCause: 'client_suspended', net: { rxAck: 1234 } });
  });

  it('a drop inside the first minute puts net on first_minute; the page bounds every field and drops unknown ones', () => {
    const w = worldRig();
    w.r.enteredWorld();
    w.clock.t += 20_000;
    w.r.left('disconnected', {
      endCause: 'server_silent',
      net: { ...fullDiag({ rxAgoMs: -5, txSeq: 2 ** 40, rxFlags: 'GARBAGE' as string }), account: 'secret', rxAck: 12.6 },
    });
    const fm = w.events.find(e => e.outcome === 'first_minute') as FirstMinuteEvent;
    expect(fm.endCause).toBe('server_silent');
    expect(fm.net).toMatchObject({ rxAgoMs: 0, txSeq: 0xffffffff, rxFlags: null, rxAck: 13 });
    expect(fm.net && 'account' in fm.net).toBe(false);
  });

  it('a worst-case first_minute with net fits the bridge route\'s body limit and survives its sanitizer', () => {
    const w = worldRig();
    w.r.enteredWorld();
    w.clock.t += 59_999;
    const big = fullDiag({
      rxAgoMs: 604_800_000, rxMsgAgoMs: 604_800_000, rxSeqAgoMs: 604_800_000, nakAgoMs: 604_800_000, srvNakAgoMs: 604_800_000,
      txAgoMs: 604_800_000, txSeqAgoMs: 604_800_000, tickAgoMs: 604_800_000, snapAgeMs: 604_800_000,
      rxFlags: '0xffffffff', rxOpcode: '0xffffffff', rxEvent: '0xffffffff',
      rxAck: 0xffffffff, rxHigh: 0xffffffff, rxHeld: 0xffffffff, rxMissing: 0xffffffff, fragHeld: 0xffffffff, naks: 0xffffffff,
      txSeq: 0xffffffff, txUnacked: 0xffffffff, txAckedBySrv: 0xffffffff, srvNaks: 0xffffffff, resent: 0xffffffff,
      unsatisfied: 0xffffffff, srvRejects: 0xffffffff, wsBuffered: 0xffffffff, tickGapMaxMs: 0xffffffff,
      rxPkts: 0xffffffff, txPkts: 0xffffffff, rxBytes: 0xffffffff,
    });
    w.r.left('disconnected', { endCause: 'socket_closed', closeCode: 1006, net: big });
    const body = w.raw[w.raw.length - 1];
    // The outbox adds eid / lateMs on a resend: leave room for both.
    expect(body.length + 80).toBeLessThanOrEqual(CLIENT_PREWORLD_MAX_BODY);
    const ev = sanitizeClientWorld(JSON.parse(body));
    expect(ev && ev.outcome === 'first_minute' && ev.net).toEqual(boundNetDiagnostics(big));
  });

  it('PreworldReporter.dropped carries net for a silent / closed session only', () => {
    const sent: PreworldEvent[] = [];
    const r = new PreworldReporter({
      endpoint: 'http://x/client-preworld', build: 'abc1234', era: () => 'dm', server: () => 'seedsow',
      screen: () => 'char-select', chargenStep: () => null, now: () => 5000, trace: 'feedc0de12345678',
      send: (_u, raw) => { sent.push(JSON.parse(raw) as PreworldEvent); },
    });
    r.dropped(1006, 'socket_closed', fullDiag());
    r.dropped(null, 'server_disconnect', fullDiag());
    expect(sent[0]).toMatchObject({ outcome: 'dropped', code: 1006, token: 'socket_closed', net: { rxAck: 1234, naks: 5 } });
    expect('net' in sent[1]).toBe(false);
    const ev = sanitizeClientPreworld(sent[0]);
    expect(ev?.net).toMatchObject({ rxAck: 1234, rxHigh: 1236, rxFlags: '0x00004000', txSeqAgoMs: 1_500 });
  });
});

// ── The bridge ──

describe('OBS.dm-stall-diagnostics — the bridge validates net field by field', () => {
  it('keeps known bounded fields, nulls out-of-bounds or non-hex values, drops unknown fields and non-objects', () => {
    const net = sanitizeNetDiag({
      rxAgoMs: 41_000, rxAck: 7, rxFlags: '0x04000000', rxOpcode: '0xF74C', rxEvent: '<script>',
      txSeq: -1, wsBuffered: 1.5, tickAgoMs: 8 * 24 * 3600_000, name: 'Bob', payload: [1, 2, 3],
    });
    expect(net).toEqual({ rxAgoMs: 41_000, rxAck: 7, rxFlags: '0x04000000', rxOpcode: null, rxEvent: null, txSeq: null, wsBuffered: null, tickAgoMs: null });
    expect(sanitizeNetDiag('x')).toBeNull();
    expect(sanitizeNetDiag([1])).toBeNull();
    expect(sanitizeNetDiag({ name: 'Bob' })).toBeNull();
  });

  it('client_world keeps net on both outcomes; client_preworld only on dropped; events without it are unchanged', () => {
    const base = { era: 'dm', server: 'snowreap', trace: 'feedc0de12345678', build: 'abc1234' };
    const left = sanitizeClientWorld({ ...base, outcome: 'world_left', exit: 'disconnected', sessionMs: 240_000, endCause: 'link_dead', net: { rxAck: 5, rxAgoMs: 40_100 } });
    expect(left?.net).toEqual({ rxAck: 5, rxAgoMs: 40_100 });
    const old = sanitizeClientWorld({ ...base, outcome: 'world_left', exit: 'disconnected', sessionMs: 240_000 });
    expect(old && 'net' in old).toBe(false);
    const pre = sanitizeClientPreworld({ ...base, outcome: 'char_list', count: 2, net: { rxAck: 5 } });
    expect(pre && 'net' in pre).toBe(false);
    const dropped = sanitizeClientPreworld({ ...base, outcome: 'dropped', token: 'server_silent', net: { rxAck: 5 } });
    expect(dropped?.net).toEqual({ rxAck: 5 });
    const suspended = sanitizeClientPreworld({ ...base, outcome: 'dropped', token: 'client_suspended', net: { rxAck: 5 } });
    expect(suspended).toMatchObject({ token: 'client_suspended', net: { rxAck: 5 } });
  });
});

// ── OBS.dm-stall-tx-ring ──

/** A GameAction (0xF7B1, sequence, action type) with `extra` bytes of body. */
function gameAction(action: number, extra = 0): Uint8Array {
  const m = new Uint8Array(12 + extra);
  const v = new DataView(m.buffer);
  v.setUint32(0, 0xF7B1, true); v.setUint32(4, 1, true); v.setUint32(8, action, true);
  return m;
}

describe('OBS.dm-stall-tx-ring — which of our packets the server stopped acknowledging', () => {
  it('labels: a GameAction names its action type, other messages their opcode, joined and bounded', () => {
    expect(messageLabel(gameAction(0x00a1))).toBe('f7b1:00a1');
    expect(messageLabel(new Uint8Array([0xC8, 0xF7, 0, 0]))).toBe('f7c8');
    expect(messageLabel(new Uint8Array([1]))).toBe('short');
    expect(joinLabels(['f7b1:0008', 'cont'])).toBe('f7b1:0008+cont');
    expect(joinLabels(Array(10).fill('f7b1:0008')).length).toBeLessThanOrEqual(48);
  });

  it('ClientConnection: every sequenced packet joins the ring (fragments by opcode, continuations, the ~3 s keepalive), capped at 8', () => {
    const s = session();
    s.ws.receive(serverMessage(2, 1));
    s.conn.sendMessage(gameAction(0x0008));         // seq 2
    s.conn.sendMessage(gameAction(0x00a1, 600));    // seq 3 + 4: a message split over two packets
    vi.advanceTimersByTime(3_100);                  // the flow keepalive: seq 5
    let d = s.conn.getDiagnostics();
    expect(d.txRecent!.map(r => [r.seq, r.what])).toEqual([[2, 'f7b1:0008'], [3, 'f7b1:00a1'], [4, 'cont'], [5, 'ts+echo']]);
    expect(d.txRecent![0]).toMatchObject({ flags: '0x00000006', agoMs: 3_100 });
    expect(d.txRecent![3]).toMatchObject({ flags: hexFlags(PacketHeaderFlags.TimeSync | PacketHeaderFlags.EchoRequest | PacketHeaderFlags.EncryptedChecksum) });
    expect(d.txRecent![3].agoMs).toBeLessThan(200); // the 100 ms service tick that sent it
    expect(d.srvAckAgoMs).toBeNull();
    for (let i = 0; i < 10; i++) s.conn.sendMessage(gameAction(0x0008));
    d = s.conn.getDiagnostics();
    expect(d.txRecent).toHaveLength(NET_DIAG_TX_RING);
    expect(d.txRecent![NET_DIAG_TX_RING - 1].seq).toBe(d.txSeq);
  });

  it('the server ACKing an old value is told apart from a server that stopped (srvAckAgoMs vs srvAckAdvAgoMs)', () => {
    const s = session();
    s.ws.receive(serverMessage(2, 1));
    s.conn.sendMessage(gameAction(0x0008)); // our 2
    s.ws.receive(packet(2, PacketHeaderFlags.AckSequence, u32List([2]).subarray(4)));
    vi.advanceTimersByTime(9_000);
    // GDLE keeps acking activesequence 2 every 3 s (FlushPeerCache) while it takes none of ours.
    s.ws.receive(packet(2, PacketHeaderFlags.AckSequence, u32List([2]).subarray(4)));
    let d = s.conn.getDiagnostics();
    expect(d).toMatchObject({ txAckedBySrv: 2, srvAckAgoMs: 0, srvAckAdvAgoMs: 9_000 });
    // A sequenced, piggybacked ack (ClassicDereth UpdatePeerTime: ACK | TIMEUPDATE | CRC) that moves forward.
    const body = new Uint8Array(12);
    new DataView(body.buffer).setUint32(0, 5, true);
    s.ws.receive(packet(3, PacketHeaderFlags.AckSequence | PacketHeaderFlags.TimeSync | PacketHeaderFlags.EncryptedChecksum, body));
    d = s.conn.getDiagnostics();
    expect(d).toMatchObject({ txAckedBySrv: 5, srvAckAgoMs: 0, srvAckAdvAgoMs: 0 });
  });

  it('a fresh connect() starts the ring over', () => {
    const s = session();
    s.ws.receive(serverMessage(2, 1));
    s.conn.sendMessage(gameAction(0x0008));
    s.conn.disconnect();
    s.conn.connect('acct', 'pw');
    expect(s.conn.getDiagnostics()).toMatchObject({ txRecent: [], srvAckAgoMs: null, srvAckAdvAgoMs: null });
  });

  it('page and bridge keep the ring bounded: at most 8 records, each field checked, junk records dropped', () => {
    const ring = new TxRing();
    for (let i = 1; i <= 12; i++) ring.sent(i, 6, 'f7b1:0008', 1000 + i);
    ring.serverAck(4, 1005);
    const snap = ring.snapshot(2000);
    expect(snap.txRecent).toHaveLength(8);
    const net = { ...fullDiag(), ...snap };
    const recs = [...snap.txRecent!, { seq: 1, flags: '0x6', what: '<script>', agoMs: 1 }, { seq: -1, flags: '0x6', what: 'ok', agoMs: 1 }, 'x'];
    const page = boundNetDiagnostics({ ...net, txRecent: recs });
    expect(page!.txRecent).toEqual(snap.txRecent!.slice(-5)); // only the last 8 inputs are read: 5 good, 3 junk dropped
    expect(page).toMatchObject({ srvAckAgoMs: 995, srvAckAdvAgoMs: 995 });
    const bridge = sanitizeNetDiag({ ...net, txRecent: recs });
    expect(bridge!.txRecent).toEqual(page!.txRecent);
    expect(sanitizeNetDiag({ txRecent: 'no' })).toBeNull();
  });

  it('a worst-case world_left with a full ring fits the bridge route\'s body limit', () => {
    const w = worldRig();
    w.r.enteredWorld();
    w.clock.t += 59_999;
    const big = fullDiag({
      rxAgoMs: 604_800_000, rxMsgAgoMs: 604_800_000, rxSeqAgoMs: 604_800_000, nakAgoMs: 604_800_000, srvNakAgoMs: 604_800_000,
      txAgoMs: 604_800_000, txSeqAgoMs: 604_800_000, tickAgoMs: 604_800_000, snapAgeMs: 604_800_000,
      srvAckAgoMs: 604_800_000, srvAckAdvAgoMs: 604_800_000,
      rxFlags: '0xffffffff', rxOpcode: '0xffffffff', rxEvent: '0xffffffff',
      rxAck: 0xffffffff, rxHigh: 0xffffffff, rxHeld: 0xffffffff, rxMissing: 0xffffffff, fragHeld: 0xffffffff, naks: 0xffffffff,
      txSeq: 0xffffffff, txUnacked: 0xffffffff, txAckedBySrv: 0xffffffff, srvNaks: 0xffffffff, resent: 0xffffffff,
      unsatisfied: 0xffffffff, srvRejects: 0xffffffff, wsBuffered: 0xffffffff, tickGapMaxMs: 0xffffffff,
      rxPkts: 0xffffffff, txPkts: 0xffffffff, rxBytes: 0xffffffff,
      txRecent: Array.from({ length: NET_DIAG_TX_RING }, () => ({ seq: 0xffffffff, flags: '0xffffffff', what: 'f'.repeat(48), agoMs: 604_800_000 })),
    });
    w.r.left('disconnected', { endCause: 'socket_closed', closeCode: 1006, net: big });
    const body = w.raw[w.raw.length - 1];
    expect(body.length + 80).toBeLessThanOrEqual(CLIENT_PREWORLD_MAX_BODY);
    const ev = sanitizeClientWorld(JSON.parse(body));
    expect(ev && ev.outcome === 'first_minute' && ev.net).toEqual(boundNetDiagnostics(big));
  });
});

function hexFlags(f: number): string { return `0x${(f >>> 0).toString(16).padStart(8, '0')}`; }
