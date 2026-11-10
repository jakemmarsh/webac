/**
 * The app-level resume (SessionLifecycle + ResumeRunner, docs/reconnect.md) is the ONE reconnect
 * engine. The network layer used to carry its own exponential auto-reconnect (FAITHFUL.269's
 * 'reconnecting' event), which the page switched off on every connect; it is gone. A dropped
 * socket reports 'disconnected' once and the connection opens nothing until the page connects
 * again. The renderer's "Reconnecting…" notice is the resume's, and its sink stays the developer
 * console (CORE.17.k.b: retail never printed connection progress into chat).
 *
 * Behavioural: drives the real ClientConnection / Connection1999 with a recording WebSocket.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { ClientConnection, Connection1999, type ConnectionEvent } from '../packages/network/src/index.js';
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

function track(conn: { on(l: (e: ConnectionEvent) => void): void }): ConnectionEvent[] {
  const events: ConnectionEvent[] = [];
  conn.on((e) => events.push(e));
  return events;
}

describe('the network layer never reconnects on its own', () => {
  for (const [name, make] of [
    ['ClientConnection', () => new ClientConnection('ws://test-not-connected')],
    ['Connection1999', () => new Connection1999('ws://test-not-connected')],
  ] as const) {
    it(`${name}: a socket that drops after opening reports one 'disconnected' and opens no other socket`, () => {
      vi.useFakeTimers();
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const conn = make();
      const events = track(conn);
      conn.connect('acct', 'pw');
      const ws = RecordingWebSocket.instances[0];
      ws.onopen?.();
      ws.onclose?.();
      vi.advanceTimersByTime(120_000);
      expect(RecordingWebSocket.instances.length).toBe(1);
      expect(events.filter((e) => e.type === 'disconnected')).toHaveLength(1);
      expect(events.some((e) => (e.type as string) === 'reconnecting')).toBe(false);
      conn.disconnect();
    });
  }

  it('the page connecting again opens the next socket (the resume\'s attempt)', () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const conn = new ClientConnection('ws://test-not-connected');
    conn.connect('acct', 'pw');
    RecordingWebSocket.instances[0].onopen?.();
    RecordingWebSocket.instances[0].onclose?.();
    conn.connect('acct', 'pw');
    expect(RecordingWebSocket.instances.length).toBe(2);
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
