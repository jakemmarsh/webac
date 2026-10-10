/**
 * RELEASE.gdle-30s-idle-drop — the session connection hosted in a Web
 * Worker: the real NetWorkerClient (page side) piped to the real
 * hostClientConnection (worker side) through structuredClone, as postMessage
 * copies, over a fake WebSocket. The worker keeps ACKing and sending the ~3 s
 * flow keepalive while the page is "blocked" (its replies held back), and the
 * page then gets every event in order.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  hostClientConnection, PacketHeaderFlags, type PacketHeaderData, PACKET_HEADER_SIZE,
  writePacketHeader, readPacketHeader, fragmentMessage, writeFragment, FRAGMENT_HEADER_SIZE,
  GameMessageGroup, type ConnectionEvent, type NetCommand, type NetReply,
} from '@ac/network';
import { NetWorkerClient, createNetConnection, type NetWorkerEndpoint } from '../packages/renderer/src/network/NetWorkerClient.js';

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
function serverMessage(seq: number, tag: number): Uint8Array {
  const m = new Uint8Array(8);
  new DataView(m.buffer).setUint32(0, 0xdead, true);
  new DataView(m.buffer).setUint32(4, tag, true);
  const [f] = fragmentMessage(m, 0x80000000, GameMessageGroup.UIQueue, fragSeq++);
  const payload = new Uint8Array(FRAGMENT_HEADER_SIZE + f.data.length);
  writeFragment(f, payload, 0);
  return packet(seq, PacketHeaderFlags.BlobFragments | PacketHeaderFlags.EncryptedChecksum, payload);
}

/** Worker ↔ page through structuredClone; `blocked` holds the page's inbox. */
function pipe() {
  const hostListeners: Array<(ev: { data: NetCommand }) => void> = [];
  const pageListeners: Array<(ev: MessageEvent<NetReply>) => void> = [];
  const inbox: NetReply[] = [];
  const state = { blocked: false };
  const deliver = (r: NetReply) => { for (const l of pageListeners) l({ data: r } as MessageEvent<NetReply>); };
  const stop = hostClientConnection({
    postMessage: (r) => { const copy = structuredClone(r); if (state.blocked) inbox.push(copy); else deliver(copy); },
    addEventListener: (_t, l) => { hostListeners.push(l); },
  });
  const endpoint: NetWorkerEndpoint = {
    postMessage: (cmd) => { const copy = structuredClone(cmd); for (const l of hostListeners) l({ data: copy }); },
    addEventListener: (_t, l) => { pageListeners.push(l); },
  };
  const unblock = () => { state.blocked = false; for (const r of inbox.splice(0)) deliver(r); };
  return { endpoint, state, unblock, stop };
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

function session() {
  const p = pipe();
  stopHost = p.stop;
  const client = new NetWorkerClient(p.endpoint, 'ws://sim');
  client.autoReconnect = false;
  const events: ConnectionEvent[] = [];
  const connectedSeen: boolean[] = [];
  client.on((e) => { events.push(e); if (e.type === 'connected') connectedSeen.push(client.isConnected); });
  client.connect('acct', 'pw');
  const ws = FakeWebSocket.last!;
  ws.open();
  ws.receive(connectRequest());
  return { ...p, client, events, connectedSeen, ws };
}

describe('RELEASE.gdle-30s-idle-drop — NetWorkerClient ↔ hostClientConnection', () => {
  it('connects through the worker; listeners see the event with the connection state already mirrored', () => {
    const s = session();
    expect(s.ws.url).toBe('ws://sim');
    expect(s.connectedSeen).toEqual([true]);
    expect(s.events.map(e => e.type)).toContain('handshakeComplete');
    expect(s.client.isConnected).toBe(true);
    expect(s.client.getLinkStatus().connected).toBe(true);
  });

  it('sendMessage reaches the socket as a sequenced fragment packet (a copy: the caller keeps its bytes)', () => {
    const s = session();
    const msg = new Uint8Array(12);
    new DataView(msg.buffer).setUint32(0, 0xF7B1, true);
    const before = s.ws.sent.length;
    s.client.sendMessage(msg, GameMessageGroup.UIQueue);
    const out = s.ws.sent.slice(before).filter(p => (readPacketHeader(p, 0).flags & PacketHeaderFlags.BlobFragments) !== 0);
    expect(out).toHaveLength(1);
    expect(readPacketHeader(out[0], 0).sequence).toBe(2);
    expect(msg.byteLength).toBe(12); // not detached
  });

  it('a blocked page: the worker keeps ACKing and keepaliving for 60 s, then the page gets every event in order', () => {
    const s = session();
    s.state.blocked = true;
    const before = s.ws.sent.length;
    s.ws.receive(serverMessage(2, 1));
    s.ws.receive(serverMessage(3, 2));
    vi.advanceTimersByTime(60_000);
    const out = s.ws.sent.slice(before).map(p => readPacketHeader(p, 0));
    const keepalives = out.filter(h => h.flags === (PacketHeaderFlags.TimeSync | PacketHeaderFlags.EchoRequest | PacketHeaderFlags.EncryptedChecksum));
    expect(keepalives.length).toBe(20);
    // GDLE's 30 s rule: no gap between sequenced packets reaches 30 s.
    expect(keepalives.map(h => h.sequence)).toEqual(Array.from({ length: 20 }, (_, i) => 2 + i));
    expect(out.some(h => h.flags === PacketHeaderFlags.AckSequence)).toBe(true);
    expect(s.events.filter(e => e.type === 'message')).toHaveLength(0); // still held
    s.unblock();
    const tags = s.events.filter(e => e.type === 'message')
      .map(e => new DataView((e.data as { payload: Uint8Array }).payload.buffer, (e.data as { payload: Uint8Array }).payload.byteOffset).getUint32(0, true));
    expect(tags).toEqual([1, 2]);
  });

  it('disconnect() reads as disconnected at once; settings and the URL reach the worker', () => {
    const s = session();
    s.client.datIterations = { portal: 2072, cell: 982, language: 994 };
    s.client.setUrl('ws://other');
    expect(s.client.bridgeUrl).toBe('ws://other');
    s.client.disconnect();
    expect(s.client.isConnected).toBe(false);
    expect(s.client.getLinkStatus()).toEqual({ connected: false, secondsSinceLastPacket: 0 });
    s.client.connect('acct', 'pw');
    expect(FakeWebSocket.last!.url).toBe('ws://other');
  });

  it('createNetConnection keeps the connection on the page with ?networker=0 or without Worker', () => {
    const inThread = vi.fn(() => ({}) as never);
    expect(createNetConnection('ws://x', { search: '?networker=0', inThread }).inWorker).toBe(false);
    const savedWorker = (globalThis as { Worker?: unknown }).Worker;
    delete (globalThis as { Worker?: unknown }).Worker;
    try {
      expect(createNetConnection('ws://x', { search: '', inThread }).inWorker).toBe(false);
    } finally {
      if (savedWorker) (globalThis as { Worker?: unknown }).Worker = savedWorker;
    }
    expect(inThread).toHaveBeenCalledTimes(2);
  });
});
