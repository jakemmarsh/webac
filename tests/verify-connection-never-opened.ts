/**
 * ERA.switch-login follow-up — a bridge socket that never opens is
 * ID_NetError_CantSocket on every era's connection, and never a dropped
 * session, even right after a real session on the same connection object
 * (leaving char select for the launcher, then ENTER on another world).
 *
 * Lead live check 2026-10-13 on an AC1999 page, Custom… wss://nothing.invalid:
 *  A) fresh page: Connection1999's onerror carried no netErrorId, so the page
 *     raised nothing and "Please Wait" stayed up forever (no connect_failed);
 *  B) from a logged-in char select: Connection1999.everOpened was never reset
 *     per connect, so the failed socket's close read as a drop of an opened
 *     session (Disconnected screen, `outcome=dropped`).
 * End of retail and Dark Majesty use ClientConnection (pinned unchanged here);
 * AC1999 uses Connection1999.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { ClientConnection, type ConnectionEvent } from '../packages/network/src/index.js';
import { Connection1999 } from '../packages/network/src/era1999/Connection1999.js';

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static sockets: FakeSocket[] = [];
  readyState = 0;
  binaryType = '';
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer | string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { FakeSocket.sockets.push(this); }
  send(): void { /* nothing answers */ }
  open(): void { this.readyState = 1; this.onopen?.(); }
  /** What a browser does for a socket it cannot open (ERR_NAME_NOT_RESOLVED, CSP): error, then close. */
  fail(): void { this.readyState = 3; this.onerror?.(); this.onclose?.(); }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    // A real close event arrives later; tests deliver it with lateClose().
  }
  lateClose(): void { this.onclose?.(); }
}

const g = globalThis as { WebSocket?: unknown };
let savedWs: unknown;
beforeAll(() => { savedWs = g.WebSocket; g.WebSocket = FakeSocket; });
afterAll(() => { g.WebSocket = savedWs; });
afterEach(() => { FakeSocket.sockets = []; });

type Conn = {
  connect(a: string, p: string): void; disconnect(): void; setUrl(u: string): void;
  on(l: (e: ConnectionEvent) => void): void; autoReconnect?: boolean;
};
const lanes: Array<[string, () => Conn]> = [
  ['end of retail / Dark Majesty (ClientConnection)', () => new ClientConnection('ws://bridge/?server=world')],
  ['AC1999 (Connection1999)', () => new Connection1999('ws://bridge/?server=ac1999')],
];

/** What main.ts's handler does with these events (the 'error' and 'disconnected' cases). */
function pageReaction(events: ConnectionEvent[]): { cantSocket: boolean; serverDied: boolean } {
  return {
    cantSocket: events.some(e => e.type === 'error' && e.netErrorId === 'ID_NetError_CantSocket'),
    serverDied: events.some(e => e.type === 'disconnected' && e.everOpened === true && e.deliberate !== true),
  };
}

for (const [lane, make] of lanes) {
  describe(`${lane}: a socket that never opens`, () => {
    it('on a fresh page is CantSocket, not a silent wait or a drop', () => {
      const conn = make();
      conn.autoReconnect = false;
      const events: ConnectionEvent[] = [];
      conn.on(e => events.push(e));
      conn.setUrl('wss://nothing.invalid/');
      conn.connect('bael', 'pw');
      FakeSocket.sockets.at(-1)!.fail();
      expect(pageReaction(events)).toEqual({ cantSocket: true, serverDied: false });
    });

    it('after leaving a live char select for the launcher is CantSocket, not the Disconnected screen', () => {
      const conn = make();
      conn.autoReconnect = false;
      const events: ConnectionEvent[] = [];
      conn.on(e => events.push(e));
      conn.connect('bael', 'pw');
      const first = FakeSocket.sockets.at(-1)!;
      first.open();
      // World box → launcher: the page's leaveForLauncher disconnects, then connects to the new world.
      conn.disconnect();
      const afterLeave = events.length;
      conn.setUrl('wss://nothing.invalid/');
      conn.connect('bael', 'pw');
      const second = FakeSocket.sockets.at(-1)!;
      expect(second).not.toBe(first);
      first.lateClose(); // the old socket's close may land after the new connect
      second.fail();
      expect(pageReaction(events.slice(afterLeave))).toEqual({ cantSocket: true, serverDied: false });
    });

    it('a socket that opened and then dropped is still a drop (no CantSocket)', () => {
      const conn = make();
      conn.autoReconnect = false;
      const events: ConnectionEvent[] = [];
      conn.on(e => events.push(e));
      conn.connect('bael', 'pw');
      const s = FakeSocket.sockets.at(-1)!;
      s.open();
      s.readyState = 3;
      s.onerror?.();
      s.onclose?.();
      expect(pageReaction(events)).toEqual({ cantSocket: false, serverDied: true });
    });
  });
}
