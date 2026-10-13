/**
 * A socket the page already left must not end the session that replaced it.
 *
 * Coldeve, 2026-10-12 (bridge logs, deployment 28f31303): Jake's tab was on a
 * VPN; the tunnel died, the bridge's ping timed out (session 11, 180 s), and
 * the page's 40 s silent-link check raised the Disconnected screen, which
 * closes the socket with disconnect(). On a dead network path that close
 * takes up to a minute to report. Meanwhile he reconnected from his home IP
 * (session 12) and was entering the world when the old socket's onclose
 * finally fired: ClientConnection reported it as a non-deliberate drop of
 * the live session (deliberateClose had been reset by the new connect), the
 * page tore the new world down and resumed: the bridge shows session 12
 * closed by the browser after 4.6 s and session 13 opened 2.1 s later (the
 * first RESUME_DELAYS_MS step).
 *
 * Drives the real ClientConnection over a fake socket whose close() reports
 * nothing until the test fires it, as a dead path does.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { ClientConnection, type ConnectionEvent } from '../packages/network/src/index.js';

class SlowCloseSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static sockets: SlowCloseSocket[] = [];
  readyState = 1;
  binaryType = '';
  sent: Uint8Array[] = [];
  closeCalled = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer | string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { SlowCloseSocket.sockets.push(this); }
  send(b: Uint8Array | string): void { if (typeof b !== 'string') this.sent.push(new Uint8Array(b)); }
  /** A dead path: the close handshake never completes, so no close event yet. */
  close(): void { this.closeCalled = true; this.readyState = 2; }
  /** The browser finally gives up on the socket. */
  reportClosed(): void { this.readyState = 3; this.onclose?.(); }
}

const g = globalThis as { WebSocket?: unknown };
let savedWs: unknown;
beforeAll(() => { savedWs = g.WebSocket; g.WebSocket = SlowCloseSocket; });
afterAll(() => { g.WebSocket = savedWs; });
afterEach(() => { SlowCloseSocket.sockets = []; vi.restoreAllMocks(); });

function connected(): { conn: ClientConnection; events: ConnectionEvent[] } {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const conn = new ClientConnection('ws://bridge');
  conn.autoReconnect = false;
  const events: ConnectionEvent[] = [];
  conn.on((e) => events.push(e));
  conn.connect('enkarta', 'pw');
  SlowCloseSocket.sockets[0].onopen?.();
  return { conn, events };
}

describe('a late close from a socket the page already left', () => {
  it('does not report the next session as dropped', () => {
    const { conn, events } = connected();
    const old = SlowCloseSocket.sockets[0];
    conn.disconnect(); // the Disconnected screen's LogOffServer
    expect(old.closeCalled).toBe(true);
    conn.connect('enkarta', 'pw'); // the player reconnects
    const live = SlowCloseSocket.sockets[1];
    live.onopen?.();
    events.length = 0;

    old.reportClosed(); // the dead path's close lands now
    expect(events.filter((e) => e.type === 'disconnected')).toEqual([]);
    expect(live.closeCalled).toBe(false);
    expect(conn.isConnected).toBe(true);
  });

  it('the live socket closing is still a drop', () => {
    const { conn, events } = connected();
    const old = SlowCloseSocket.sockets[0];
    conn.disconnect();
    conn.connect('enkarta', 'pw');
    const live = SlowCloseSocket.sockets[1];
    live.onopen?.();
    old.reportClosed();
    events.length = 0;

    live.reportClosed();
    const d = events.filter((e) => e.type === 'disconnected');
    expect(d).toHaveLength(1);
    expect(d[0].everOpened).toBe(true);
    expect(d[0].deliberate).toBe(false);
  });

  it('a close after disconnect() with nothing newer still reports a deliberate end', () => {
    const { conn, events } = connected();
    const old = SlowCloseSocket.sockets[0];
    conn.disconnect();
    events.length = 0;
    old.reportClosed();
    const d = events.filter((e) => e.type === 'disconnected');
    expect(d).toHaveLength(1);
    expect(d[0].deliberate).toBe(true);
  });
});
