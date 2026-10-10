/**
 * FAITHFUL.269 — Auto-reconnect surfaces as a structured 'reconnecting'
 * event, not a red 'ACE error: ...' failure.
 *
 * Pre-fix `attemptReconnect()` emitted `type: 'error', error: 'Reconnecting
 * in 4s (attempt 1/5)...'`. Auto-reconnect is recovery, not a failure.
 *
 * CORE.17.k.b re-anchored the sink: retail has no auto-reconnect and never
 * prints connection progress into chat, so the renderer routes the event
 * to the developer console (ClientNotices `reconnecting`, sink 'console');
 * the terminal "gave up" case is an 'error' carrying the retail NetError
 * token ID_ConnectionError_ClientTimedOutServer (ConnectionNotices.ts).
 *
 * Behavioural: drives the real ClientConnection with a recording WebSocket.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { ClientConnection, type ConnectionEvent } from '../packages/network/src/index.js';
import { CLIENT_NOTICES, raiseClientNotice } from '../packages/renderer/src/ui/ClientNotices.js';

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
  send(): void { /* not needed */ }
  close(): void { this.closed = true; }
}

let savedWebSocket: unknown;
beforeAll(() => {
  savedWebSocket = (globalThis as unknown as { WebSocket: unknown }).WebSocket;
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = RecordingWebSocket;
});
afterAll(() => {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = savedWebSocket;
});
afterEach(() => {
  RecordingWebSocket.instances = [];
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function makeConn(): { conn: ClientConnection; events: ConnectionEvent[] } {
  const conn = new ClientConnection('ws://test-not-connected');
  const events: ConnectionEvent[] = [];
  conn.on((e) => events.push(e));
  return { conn, events };
}

describe('FAITHFUL.269 — reconnecting event', () => {
  it("a dropped socket with autoReconnect on emits type:'reconnecting' with attempt/max/delay, never an 'error'", () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { conn, events } = makeConn();
    conn.autoReconnect = true;
    conn.connect('acct', 'pw');
    const ws = RecordingWebSocket.instances[0];
    ws.onopen?.();
    ws.onclose?.();
    const r = events.find((e) => e.type === 'reconnecting');
    expect(r).toBeTruthy();
    expect(r!.reconnectAttempt).toBe(1);
    expect(r!.reconnectMax).toBe(5);
    expect(r!.reconnectDelaySec).toBe(2); // reconnectDelay 2000 ms × 2^0
    expect(events.find((e) => e.type === 'error')).toBeUndefined();
    // The delay elapses → a fresh socket is opened.
    vi.advanceTimersByTime(2000);
    expect(RecordingWebSocket.instances.length).toBe(2);
    conn.disconnect();
  });

  it('the reconnect delay backs off exponentially per attempt', () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { conn, events } = makeConn();
    conn.autoReconnect = true;
    conn.connect('acct', 'pw');
    const delays: number[] = [];
    for (let i = 0; i < 3; i++) {
      const ws = RecordingWebSocket.instances[i];
      ws.onclose?.(); // never opened — reconnectAttempts keeps counting
      const r = events.filter((e) => e.type === 'reconnecting').at(-1)!;
      delays.push(r.reconnectDelaySec!);
      vi.advanceTimersByTime(r.reconnectDelaySec! * 1000);
    }
    expect(delays).toEqual([2, 4, 8]);
    conn.disconnect();
  });

  it("giving up is a real 'error' carrying the retail NetError token (ClientNet::LogonUseTime's ClientTimedOutServer)", () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { conn, events } = makeConn();
    conn.autoReconnect = true;
    conn.connect('acct', 'pw');
    for (let i = 0; i < 6; i++) {
      RecordingWebSocket.instances[i]?.onclose?.();
      vi.advanceTimersByTime(2000 * 2 ** i);
    }
    const gaveUp = events.find((e) => e.type === 'error');
    expect(gaveUp?.error).toBe('Max reconnection attempts reached');
    expect(gaveUp?.netErrorId).toBe('ID_ConnectionError_ClientTimedOutServer');
    expect(events.filter((e) => e.type === 'reconnecting').length).toBe(5);
    conn.disconnect();
  });

  it('the renderer sink for reconnect progress is the developer console, not a chat line (CORE.17.k.b)', () => {
    expect(CLIENT_NOTICES.reconnecting.sink).toBe('console');
    const logged: string[] = [];
    const chat: string[] = [];
    const sink = raiseClientNotice(
      { displayErrorText: () => {}, addSystemMessage: (t: string) => chat.push(t) },
      CLIENT_NOTICES.reconnecting,
      { text: 'Reconnecting to the ACE server in 2s (attempt 1/5)…', log: (l) => logged.push(l) },
    );
    expect(sink).toBe('console');
    expect(logged).toEqual(['[AC] Reconnecting to the ACE server in 2s (attempt 1/5)…']);
    expect(chat).toEqual([]);
  });
});
