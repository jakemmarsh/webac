/**
 * BUG.multi-tab-login-pingpong — production 2026-10-16 (Coldeve, one player):
 * the game open in several tabs on one account. ACE boots the old session
 * AND refuses the new login (account_login_boots_in_use,
 * AuthenticationHandler.cs:182-194); each refused tab retried a fresh login
 * every 10 s (meant for our own phantom session after a drop), so the tabs
 * took turns booting each other, every waiting tab held a bridge session,
 * the bridge's per-IP cap (8) filled, and the player saw only "Couldn't
 * create local socket".
 *
 * Drives the real modules:
 *  - two "tabs" = two real ClientConnections, each watched by a real
 *    AccountTabGuard, on a shared fake BroadcastChannel: the later login
 *    makes the earlier tab stand down (no further login, its socket closed);
 *  - the genuine phantom case (no other tab) still retries;
 *  - a refused login's 10 s wait and a login timeout no longer hold a socket;
 *  - the bridge's ip_cap close (4429) is reported as `bridgeRefusal`, with no
 *    'disconnected', on both the ACE/GDL and the AC1999 connection, and maps
 *    to the plain message.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import {
  ClientConnection, Connection1999, type ConnectionEvent,
  PacketHeaderFlags, type PacketHeaderData,
  PACKET_HEADER_SIZE, FRAGMENT_HEADER_SIZE,
  writePacketHeader, fragmentMessage, writeFragment,
  GameMessageGroup, BRIDGE_CLOSE_IP_CAP, bridgeRefusalFromClose, bridgeRefusalOf,
  probeBridgeHealth, hostClientConnection, type HealthSocketLike, type NetCommand, type NetReply,
} from '@ac/network';
import { NetWorkerClient, type NetWorkerEndpoint } from '../packages/renderer/src/network/NetWorkerClient';
import { connectionFailureRecovery } from '../packages/renderer/src/session/AccountBoot';
import { loginFailureText } from '../packages/renderer/src/launcher/worldDirectory';
import {
  AccountTabGuard, accountSessionKey, type SessionChannelLike,
} from '../packages/renderer/src/session/AccountTabGuard';
import { bridgeRefusalNotice, connectionFailureNotice, BRIDGE_IP_CAP_TEXT, BRIDGE_IP_CAP_TOKEN } from '../packages/renderer/src/ui/ConnectionNotices';

const CHARACTER_ERROR = 0xF659;
const CHARACTER_LIST = 0xF658;
const ERR_LOGON = 0x1;

/** A WebSocket the test opens, feeds and closes by hand; counts as one bridge session while open. */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  closed = false;
  binaryType = '';
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number; reason?: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeWebSocket.instances.push(this); }
  send(): void { /* the server side is scripted */ }
  close(): void { this.closed = true; this.readyState = 3; }
  open(): void { this.readyState = 1; this.onopen?.(); }
  serverSends(bytes: Uint8Array): void { this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }); }
  /** The bridge closes the socket (code, reason). */
  bridgeCloses(code: number, reason = ''): void { this.closed = true; this.readyState = 3; this.onclose?.({ code, reason }); }
  static get openCount(): number { return FakeWebSocket.instances.filter(w => !w.closed).length; }
}

/** BroadcastChannel semantics: every other channel on the hub gets the message (not the sender). */
class FakeChannelHub {
  private channels: FakeChannel[] = [];
  open(): FakeChannel { const c = new FakeChannel(this); this.channels.push(c); return c; }
  deliver(from: FakeChannel, data: unknown): void {
    for (const c of this.channels) if (c !== from) c.listeners.forEach(l => l({ data: structuredClone(data) }));
  }
}
class FakeChannel implements SessionChannelLike {
  listeners: ((ev: { data: unknown }) => void)[] = [];
  constructor(private hub: FakeChannelHub) {}
  postMessage(m: unknown): void { this.hub.deliver(this, m); }
  addEventListener(_t: 'message', l: (ev: { data: unknown }) => void): void { this.listeners.push(l); }
}

beforeAll(() => {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
});
afterEach(() => {
  FakeWebSocket.instances = [];
  vi.useRealTimers();
});

function serverPacket(seq: number, flags: number, payload: Uint8Array): Uint8Array {
  const buf = new Uint8Array(PACKET_HEADER_SIZE + payload.length);
  const header: PacketHeaderData = { sequence: seq, flags, checksum: 0, id: 0x42, time: 0, size: payload.length, iteration: 1 };
  writePacketHeader(header, buf, 0);
  buf.set(payload, PACKET_HEADER_SIZE);
  return buf;
}
function opcodePacket(seq: number, opcode: number, fragSeq: number, arg?: number): Uint8Array {
  const msg = new Uint8Array(8);
  const v = new DataView(msg.buffer);
  v.setUint32(0, opcode, true);
  if (arg !== undefined) v.setUint32(4, arg, true);
  const [frag] = fragmentMessage(msg, seq, GameMessageGroup.WeenieQueue, fragSeq);
  const payload = new Uint8Array(FRAGMENT_HEADER_SIZE + frag.data.length);
  writeFragment(frag, payload, 0);
  return serverPacket(seq, PacketHeaderFlags.BlobFragments, payload);
}

const URL_COLDEVE = 'wss://bridge.example/connect?server=coldeve';

interface Tab {
  conn: ClientConnection;
  guard: AccountTabGuard;
  events: ConnectionEvent[];
  stoodDown: number;
}

/** A page: its connection, its guard, and main.ts's stand-down (close the session, no retry). */
function makeTab(hub: FakeChannelHub, id: string, account = 'Player1', at?: () => number): Tab {
  const conn = new ClientConnection(URL_COLDEVE);
  conn.autoReconnect = false;
  const events: ConnectionEvent[] = [];
  conn.on(e => events.push(e));
  const tab: Tab = {
    conn, events, stoodDown: 0,
    guard: new AccountTabGuard({
      channel: hub.open(),
      tabId: id,
      now: at,
      onStandDown: () => { tab.stoodDown++; conn.disconnect(); },
    }),
  };
  tab.guard.watch(conn, () => accountSessionKey(URL_COLDEVE, account));
  return tab;
}
function connectTab(tab: Tab): FakeWebSocket {
  tab.conn.connect('Player1', 'pw');
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  ws.open();
  return ws;
}

describe('AccountTabGuard — the latest login wins across tabs', () => {
  it('a tab waiting to retry a refused login stands down when another tab logs in, and never logs in again', () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const hub = new FakeChannelHub();
    const a = makeTab(hub, 'tab-a');
    const b = makeTab(hub, 'tab-b');

    // Tab A logs in and is refused ("two accounts": tab B, or a session the
    // player left, holds it): the phantom-session retry is scheduled.
    const wsA = connectTab(a);
    wsA.serverSends(opcodePacket(2, CHARACTER_ERROR, 0, ERR_LOGON));
    expect(a.events.find(e => e.type === 'error')).toMatchObject({ characterError: ERR_LOGON, loginRetryScheduled: true });
    expect(a.guard.heldKey).not.toBeNull();
    // The refused socket is closed for the wait: it no longer holds a bridge session.
    expect(wsA.closed).toBe(true);

    vi.advanceTimersByTime(3_000);
    // Tab B logs in and gets its character list.
    const wsB = connectTab(b);
    wsB.serverSends(opcodePacket(2, CHARACTER_LIST, 0));
    expect(b.events.some(e => e.type === 'characterList')).toBe(true);

    // Tab A stood down: its pending fresh login is cancelled.
    expect(a.stoodDown).toBe(1);
    expect(a.guard.heldKey).toBeNull();
    const socketsBefore = FakeWebSocket.instances.length;
    // Past A's 10 s retry (this fake server never completes B's handshake, so stay inside B's login budget).
    vi.advanceTimersByTime(15_000);
    expect(FakeWebSocket.instances.length).toBe(socketsBefore); // A never logged in again
    expect(b.stoodDown).toBe(0);
    expect(wsB.closed).toBe(false);
    expect(FakeWebSocket.openCount).toBe(1); // one tab, one bridge session
  });

  it('a tab in the world stands down when the same account logs in from another tab: its session closes', () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let t = 1_000;
    const hub = new FakeChannelHub();
    const a = makeTab(hub, 'tab-a', 'Player1', () => t);
    const b = makeTab(hub, 'tab-b', 'player1 ', () => t); // the same account, as typed in the other tab

    const wsA = connectTab(a);
    wsA.serverSends(opcodePacket(2, CHARACTER_LIST, 0));
    expect(FakeWebSocket.openCount).toBe(1);

    t += 60_000;
    // Tab B's login reaches the server: ACE boots A and refuses B; B retries for its phantom.
    const wsB = connectTab(b);
    wsB.serverSends(opcodePacket(2, CHARACTER_ERROR, 0, ERR_LOGON));
    expect(a.stoodDown).toBe(1);
    expect(wsA.closed).toBe(true); // A's bridge session is released at once

    // B's retry (A is gone) gets in; A is never brought back by B's later claims.
    vi.advanceTimersByTime(10_000);
    const wsB2 = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    expect(wsB2).not.toBe(wsB);
    wsB2.open();
    wsB2.serverSends(opcodePacket(2, CHARACTER_LIST, 0));
    expect(a.stoodDown).toBe(1);
    expect(b.stoodDown).toBe(0);
    expect(FakeWebSocket.openCount).toBe(1);
  });

  it('the genuine phantom case: with no other tab holding the account, a refused login still retries', () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const hub = new FakeChannelHub();
    const a = makeTab(hub, 'tab-a');
    makeTab(hub, 'tab-other', 'SomeoneElse'); // another account in another tab is not a conflict

    const ws = connectTab(a);
    ws.serverSends(opcodePacket(2, CHARACTER_ERROR, 0, ERR_LOGON));
    expect(a.events.some(e => e.type === 'loginRetry')).toBe(true);
    const n = FakeWebSocket.instances.length;
    vi.advanceTimersByTime(10_000);
    expect(FakeWebSocket.instances.length).toBe(n + 1); // the fresh login went out
    expect(a.stoodDown).toBe(0);
  });

  it('crossing claims: the later one wins; a released tab ignores claims', () => {
    const hub = new FakeChannelHub();
    let downA = 0;
    let downB = 0;
    const ga = new AccountTabGuard({ channel: hub.open(), tabId: 'a', now: () => 100, onStandDown: () => { downA++; } });
    const gb = new AccountTabGuard({ channel: hub.open(), tabId: 'b', now: () => 100, onStandDown: () => { downB++; } });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const key = accountSessionKey(URL_COLDEVE, 'x');
    ga.claim(key);
    gb.claim(key); // same instant: the tab id breaks the tie ('b' > 'a')
    expect(downA).toBe(1);
    expect(downB).toBe(0);
    expect(gb.heldKey).toBe(key);
    // A tab that left for the launcher does not react.
    gb.release();
    ga.claim(key);
    expect(downB).toBe(0);
  });

  it('keys by server and account: the page trace and case do not split them; another server does', () => {
    expect(accountSessionKey('wss://b.example/connect?server=coldeve&trace=abc', 'Player1'))
      .toBe(accountSessionKey('wss://b.example/connect?trace=zzz&server=coldeve', 'player1'));
    expect(accountSessionKey('wss://b.example/connect?server=coldeve', 'p'))
      .not.toBe(accountSessionKey('wss://b.example/connect?server=leafcull', 'p'));
  });
});

describe('the bridge per-IP cap close (BUG.multi-tab-login-pingpong)', () => {
  it('ClientConnection reports ip_cap as a bridge refusal, with no disconnected event and no retry', () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const conn = new ClientConnection(URL_COLDEVE);
    const events: ConnectionEvent[] = [];
    conn.on(e => events.push(e));
    conn.connect('Player1', 'pw');
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.bridgeCloses(BRIDGE_CLOSE_IP_CAP, 'ip_cap');
    expect(events.find(e => e.type === 'error')).toMatchObject({ bridgeRefusal: 'ip_cap' });
    expect(events.some(e => e.type === 'disconnected')).toBe(false);
    expect(events.some(e => e.type === 'serverReached')).toBe(false); // never claims the account
    vi.advanceTimersByTime(120_000);
    expect(FakeWebSocket.instances.length).toBe(1);
  });

  it('Connection1999 reports it the same way', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const conn = new Connection1999('wss://bridge.example/connect?server=ac1999');
    const events: ConnectionEvent[] = [];
    conn.on(e => events.push(e));
    conn.connect('Player1', 'pw');
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.bridgeCloses(BRIDGE_CLOSE_IP_CAP, 'ip_cap');
    expect(events.find(e => e.type === 'error')).toMatchObject({ bridgeRefusal: 'ip_cap' });
    expect(events.some(e => e.type === 'disconnected')).toBe(false);
    conn.disconnect();
  });

  it('an ordinary close is not a refusal, and the refusal reads as a plain message', () => {
    expect(bridgeRefusalFromClose(1006)).toBeNull();
    expect(bridgeRefusalFromClose(undefined)).toBeNull();
    expect(bridgeRefusalFromClose(BRIDGE_CLOSE_IP_CAP)).toBe('ip_cap');
    expect(bridgeRefusalNotice('ip_cap')).toMatchObject({ surface: 'dialog', token: BRIDGE_IP_CAP_TOKEN, text: BRIDGE_IP_CAP_TEXT });
    expect(BRIDGE_IP_CAP_TEXT).toMatch(/Too many game windows/);
  });
});

describe('sockets that outlived their session', () => {
  it('a login the server never answers closes its socket with the timeout error', () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const conn = new ClientConnection(URL_COLDEVE);
    const events: ConnectionEvent[] = [];
    conn.on(e => events.push(e));
    conn.connect('Player1', 'pw');
    const ws = FakeWebSocket.instances[0];
    ws.open();
    vi.advanceTimersByTime(5 * 60_000);
    expect(events.find(e => e.type === 'error')).toMatchObject({ netErrorId: 'ID_ConnectionError_ClientTimedOutServer' });
    expect(ws.closed).toBe(true);
    expect(events.some(e => e.type === 'disconnected')).toBe(false);
  });
});

describe('every path a refused connect can take shows the cap message (lead live check 2026-10-16)', () => {
  it('patch screen: the health probe the bridge refuses rejects with the refusal instead of never settling', async () => {
    // Live: boot waited on this probe forever ("Connect progress" empty) while the bridge's cap was full.
    class ProbeSocket implements HealthSocketLike {
      static last: ProbeSocket;
      onopen: ((ev: unknown) => void) | null = null;
      onmessage: ((ev: { data: unknown }) => void) | null = null;
      onerror: ((ev: unknown) => void) | null = null;
      onclose: ((ev: unknown) => void) | null = null;
      constructor(public url: string) { ProbeSocket.last = this; }
      send(): void {}
      close(): void {}
    }
    const refused = probeBridgeHealth('ws://bridge:9398', 60_000, ProbeSocket);
    ProbeSocket.last.onopen!({});
    ProbeSocket.last.onclose!({ code: BRIDGE_CLOSE_IP_CAP, reason: 'ip_cap' });
    const err = await refused.then(() => null, (e: unknown) => e);
    expect(bridgeRefusalOf(err)).toBe('ip_cap');

    // Any close before the answer settles it too (no 60 s wait, no hang).
    const closed = probeBridgeHealth('ws://bridge:9398', 60_000, ProbeSocket);
    ProbeSocket.last.onopen!({});
    ProbeSocket.last.onclose!({ code: 1006 });
    const err2 = await closed.then(() => null, (e: unknown) => e);
    expect(bridgeRefusalOf(err2)).toBeNull();
    expect((err2 as Error).message).toBe('Bridge not reachable');
  });

  it('launcher ENTER (the connecting screen, prod): the worker-hosted connection hands the page the refusal, and it reads as the cap message back at the launcher', () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // The page's NetWorkerClient piped to the real worker host, as postMessage copies.
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
    try {
      const page = new NetWorkerClient(endpoint, URL_COLDEVE);
      const events: ConnectionEvent[] = [];
      page.on(e => events.push(e));
      page.connect('Player1', 'pw');
      const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
      ws.open();
      ws.bridgeCloses(BRIDGE_CLOSE_IP_CAP, 'ip_cap');

      const error = events.find(e => e.type === 'error');
      expect(error).toMatchObject({ bridgeRefusal: 'ip_cap' });
      expect(events.some(e => e.type === 'disconnected')).toBe(false);
      // main.ts's 'error' branch: the notice, then raiseNetError's text and recovery.
      const notice = connectionFailureNotice(error!)!;
      expect(notice).toMatchObject({ surface: 'dialog', token: BRIDGE_IP_CAP_TOKEN, text: BRIDGE_IP_CAP_TEXT });
      const world = { name: 'Coldeve', registration: null, registrationUrl: null, kind: 'listed' as const, perIpLimits: { accounts: 2, sessions: 2 } };
      expect(loginFailureText(notice, world, false)).toBe(BRIDGE_IP_CAP_TEXT);
      expect(loginFailureText(notice, null, false)).toBe(BRIDGE_IP_CAP_TEXT);
      expect(connectionFailureRecovery({ inWorld: false, launcherLogin: true })).toBe('launcher'); // the dialog, then the launcher
      expect(connectionFailureRecovery({ inWorld: false, launcherLogin: false })).toBe('relaunch'); // URL login (dev): the dialog, OK retries
      // The other failures keep their retail notices.
      expect(connectionFailureNotice({ netErrorId: 'ID_NetError_CantSocket' })?.token).toBe('ID_NetError_CantSocket');
      expect(connectionFailureNotice({})).toBeNull();
    } finally {
      stop();
    }
  });
});
