/**
 * ASSESS: stale-session login retry — found live during the 2026-06-10
 * assessment verification. Closing a page mid-world leaves the account
 * logged in until ACE finishes the abandoned player's logoff, so the next
 * page load gets CharacterError.Logon ("Cannot have two accounts logged on
 * at the same time", reference/ACE/Source/ACE.Server/Network/Enum/
 * CharacterError.cs 0x1) and pre-fix died at an empty char select.
 *
 * Drives the real ClientConnection with hand-built server packets:
 *   - CharacterError.Logon schedules a timed fresh login ('loginRetry' event,
 *     new socket after 10s)
 *   - other CharacterError codes do NOT trigger the retry
 *   - a CharacterList arrival clears the retry budget
 *   - doConnect never leaks the previous socket (zombie sockets were
 *     double-logging-in and re-triggering the "two accounts" rejection)
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import {
  ClientConnection, ConnectionEvent,
  PacketHeaderFlags, PacketHeaderData,
  PACKET_HEADER_SIZE, FRAGMENT_HEADER_SIZE,
  writePacketHeader, fragmentMessage, writeFragment,
  GameMessageGroup,
} from '@ac/network';

const CHARACTER_ERROR = 0xF659;
const CHARACTER_LIST = 0xF658;
const ERR_LOGON = 0x1; // CharacterError.Logon — two accounts
const ERR_SERVER_FULL = 0x15; // CharacterError.LogonServerFull

class RecordingWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: RecordingWebSocket[] = [];
  readyState = 1;
  closed = false;
  binaryType = '';
  onopen: (() => void) | null = null;
  onmessage: ((e: unknown) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    RecordingWebSocket.instances.push(this);
  }
  send(): void { /* recorded elsewhere if needed */ }
  close(): void { this.closed = true; }
}

beforeAll(() => {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = RecordingWebSocket;
});

afterEach(() => {
  RecordingWebSocket.instances = [];
  vi.useRealTimers();
});

function buildServerPacket(seq: number, flags: number, payload: Uint8Array): Uint8Array {
  const buf = new Uint8Array(PACKET_HEADER_SIZE + payload.length);
  const header: PacketHeaderData = {
    sequence: seq, flags, checksum: 0, id: 0x42, time: 0,
    size: payload.length, iteration: 1,
  };
  writePacketHeader(header, buf, 0);
  buf.set(payload, PACKET_HEADER_SIZE);
  return buf;
}

// fragSeq is the independent fragment-sequence stream (BUG.fragment-sequence-
// not-reordered) — a fresh ClientConnection expects it to start at 0 and
// advance by 1 per message, regardless of the packet sequence carrying it.
function buildOpcodePacket(seq: number, opcode: number, fragSeq: number, arg?: number): Uint8Array {
  const msg = new Uint8Array(8);
  const v = new DataView(msg.buffer);
  v.setUint32(0, opcode, true);
  if (arg !== undefined) v.setUint32(4, arg, true);
  const [frag] = fragmentMessage(msg, seq, GameMessageGroup.WeenieQueue, fragSeq);
  const payload = new Uint8Array(FRAGMENT_HEADER_SIZE + frag.data.length);
  writeFragment(frag, payload, 0);
  return buildServerPacket(seq, PacketHeaderFlags.BlobFragments, payload);
}

function makeConn(): { conn: ClientConnection; events: ConnectionEvent[] } {
  const conn = new ClientConnection('ws://test-not-connected');
  const events: ConnectionEvent[] = [];
  conn.on(e => events.push(e));
  (conn as unknown as { lastAccount: string }).lastAccount = 'acct';
  (conn as unknown as { lastPassword: string }).lastPassword = 'pw';
  return { conn, events };
}

describe('ClientConnection — stale-session login retry', () => {
  it('CharacterError.Logon schedules a loginRetry and opens a fresh socket after 10s', () => {
    vi.useFakeTimers();
    const { conn, events } = makeConn();
    (conn as unknown as { handlePacket(p: Uint8Array): void }).handlePacket(
      buildOpcodePacket(2, CHARACTER_ERROR, 0, ERR_LOGON),
    );

    const retry = events.find(e => e.type === 'loginRetry');
    expect(retry).toBeTruthy();
    expect(retry!.reconnectAttempt).toBe(1);
    expect(retry!.reconnectDelaySec).toBe(10);

    expect(RecordingWebSocket.instances.length).toBe(0);
    vi.advanceTimersByTime(10_000);
    // doConnect ran — a fresh socket to the bridge was opened.
    expect(RecordingWebSocket.instances.length).toBe(1);
    expect(RecordingWebSocket.instances[0].url).toBe('ws://test-not-connected');
  });

  it('schedules the retry even when autoReconnect is disabled (initial-login path)', () => {
    vi.useFakeTimers();
    const { conn, events } = makeConn();
    // The app disables autoReconnect at startup to avoid cascading sessions;
    // the stale-session login retry must still fire.
    conn.autoReconnect = false;
    (conn as unknown as { handlePacket(p: Uint8Array): void }).handlePacket(
      buildOpcodePacket(2, CHARACTER_ERROR, 0, ERR_LOGON),
    );
    expect(events.find(e => e.type === 'loginRetry')).toBeTruthy();
    vi.advanceTimersByTime(10_000);
    expect(RecordingWebSocket.instances.length).toBe(1);
  });

  it('other CharacterError codes do not schedule a retry', () => {
    vi.useFakeTimers();
    const { conn, events } = makeConn();
    (conn as unknown as { handlePacket(p: Uint8Array): void }).handlePacket(
      buildOpcodePacket(2, CHARACTER_ERROR, 0, ERR_SERVER_FULL),
    );
    expect(events.find(e => e.type === 'loginRetry')).toBeUndefined();
    vi.advanceTimersByTime(60_000);
    expect(RecordingWebSocket.instances.length).toBe(0);
  });

  it('a CharacterList arrival clears the retry budget and pending timer', () => {
    vi.useFakeTimers();
    const { conn } = makeConn();
    const anyConn = conn as unknown as {
      handlePacket(p: Uint8Array): void;
      loginRejectRetryAttempts: number;
      loginRejectRetryTimer: unknown;
    };
    anyConn.handlePacket(buildOpcodePacket(2, CHARACTER_ERROR, 0, ERR_LOGON));
    expect(anyConn.loginRejectRetryAttempts).toBe(1);
    expect(anyConn.loginRejectRetryTimer).not.toBeNull();

    anyConn.handlePacket(buildOpcodePacket(3, CHARACTER_LIST, 1));
    expect(anyConn.loginRejectRetryAttempts).toBe(0);
    expect(anyConn.loginRejectRetryTimer).toBeNull();
    vi.advanceTimersByTime(60_000);
    expect(RecordingWebSocket.instances.length).toBe(0);
  });

  it('booted after logging in (the account logged in elsewhere): no retry, the error goes to the Disconnected screen', () => {
    vi.useFakeTimers();
    const { conn, events } = makeConn();
    const anyConn = conn as unknown as { handlePacket(p: Uint8Array): void };
    // Logged in: the character list arrived, then (in the world) ACE boots this session for a newer login.
    anyConn.handlePacket(buildOpcodePacket(2, CHARACTER_LIST, 0));
    anyConn.handlePacket(buildOpcodePacket(3, CHARACTER_ERROR, 1, ERR_LOGON));
    expect(events.find(e => e.type === 'loginRetry')).toBeUndefined();
    expect(events.find(e => e.type === 'error')).toMatchObject({ characterError: ERR_LOGON, loginRetryScheduled: false });
    vi.advanceTimersByTime(60_000);
    // No fresh login: two pages would otherwise take turns booting each other.
    expect(RecordingWebSocket.instances.length).toBe(0);
  });

  it('a new socket starts before login again: a refused login on it still retries', () => {
    vi.useFakeTimers();
    const { conn, events } = makeConn();
    const anyConn = conn as unknown as { handlePacket(p: Uint8Array): void; doConnect(a: string, p: string): void; sessionPastLogin: boolean };
    anyConn.handlePacket(buildOpcodePacket(2, CHARACTER_LIST, 0));
    expect(anyConn.sessionPastLogin).toBe(true);
    anyConn.doConnect('acct', 'pw');
    expect(anyConn.sessionPastLogin).toBe(false);
    expect(events.filter(e => e.type === 'loginRetry')).toHaveLength(0);
  });

  it('retry budget is capped', () => {
    vi.useFakeTimers();
    const { conn, events } = makeConn();
    const anyConn = conn as unknown as {
      handlePacket(p: Uint8Array): void;
      loginRejectRetryAttempts: number;
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Each rejection schedules one retry; sequence numbers must advance
      // past the dedup gate, so reset the connection state between feeds.
      for (let i = 0; i < 14; i++) {
        anyConn.handlePacket(buildOpcodePacket(i + 2, CHARACTER_ERROR, i, ERR_LOGON));
        vi.advanceTimersByTime(10_000);
      }
      expect(anyConn.loginRejectRetryAttempts).toBeLessThanOrEqual(12);
      const retries = events.filter(e => e.type === 'loginRetry');
      expect(retries.length).toBeLessThanOrEqual(12);
    } finally {
      warn.mockRestore();
    }
  });

  it('doConnect detaches and closes a previous socket instead of leaking it', () => {
    vi.useFakeTimers();
    const { conn } = makeConn();
    const anyConn = conn as unknown as {
      doConnect(a: string, p: string): void;
      ws: RecordingWebSocket | null;
    };
    anyConn.doConnect('acct', 'pw');
    const first = RecordingWebSocket.instances[0];
    expect(first).toBeTruthy();
    expect(first.onclose).not.toBeNull();

    anyConn.doConnect('acct', 'pw');
    expect(first.closed).toBe(true);
    // Handlers were detached so the orphan can't fire reconnect/login logic.
    expect(first.onopen).toBeNull();
    expect(first.onclose).toBeNull();
    expect(RecordingWebSocket.instances.length).toBe(2);
    expect(anyConn.ws).toBe(RecordingWebSocket.instances[1]);
  });
});
