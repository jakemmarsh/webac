/**
 * The tab's side of a planned bridge handover, in both connections the page
 * runs (ClientConnection for end of retail and every classic server,
 * Connection1999 for AC1999): handover() moves the live session to a new
 * WebSocket on the bridge's new deployment without touching the session
 * (packages/network/src/SocketHandover.ts; docs/bridge-handover.md).
 *
 * Drives the real connections over fake sockets that play both bridges.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ClientConnection, type ConnectionEvent, type HandoverResult } from '../packages/network/src/index.js';
import { Connection1999 } from '../packages/network/src/era1999/Connection1999.js';
import { EOR_LOGIN_PROFILE } from '../packages/network/src/LoginProfile.js';

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static sockets: FakeSocket[] = [];
  readyState = 0;
  binaryType = '';
  texts: string[] = [];
  binaries = 0;
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer | string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { FakeSocket.sockets.push(this); }
  send(d: Uint8Array | ArrayBuffer | string): void { if (typeof d === 'string') this.texts.push(d); else this.binaries++; }
  close(): void { this.closed = true; this.readyState = 3; }
  open(): void { this.readyState = 1; this.onopen?.(); }
  text(t: string): void { this.onmessage?.({ data: t }); }
  /** The bridge closed it. */
  drop(code = 1000): void { this.readyState = 3; this.onclose?.({ code }); }
}

const g = globalThis as { WebSocket?: unknown };
let saved: unknown;
beforeAll(() => { saved = g.WebSocket; g.WebSocket = FakeSocket; });
afterAll(() => { g.WebSocket = saved; });
afterEach(() => { FakeSocket.sockets = []; vi.restoreAllMocks(); });

type Conn = ClientConnection | Connection1999;
function connected(kind: 'eor' | 'ac1999'): { conn: Conn; events: ConnectionEvent[]; old: FakeSocket } {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const conn: Conn = kind === 'eor'
    ? new ClientConnection('ws://bridge/?server=w')
    : new Connection1999('ws://bridge/?server=w', { loginProfile: { ...EOR_LOGIN_PROFILE, protocol: 'ac1999' } });
  conn.autoReconnect = false;
  const events: ConnectionEvent[] = [];
  conn.on((e) => events.push(e));
  conn.connect('enkarta', 'pw');
  const old = FakeSocket.sockets[0];
  old.open();
  return { conn, events, old };
}

const results = (events: ConnectionEvent[]) => events.filter((e) => e.type === 'handover').map((e) => e.data as HandoverResult);
const drops = (events: ConnectionEvent[]) => events.filter((e) => e.type === 'disconnected');

for (const kind of ['eor', 'ac1999'] as const) {
  describe(`planned handover (${kind === 'eor' ? 'ClientConnection' : 'Connection1999'})`, () => {
    it('moves the session to the new socket: the old one closing is no drop, the new one carries everything after', () => {
      const { conn, events, old } = connected(kind);
      conn.handover();
      expect(old.texts).toContain('handoverTicket');
      old.text(JSON.stringify({ handoverTicket: { ticket: 'h1.T' } }));
      const next = FakeSocket.sockets[1];
      // The session's own URL, marked as a handover (and still 1999 for a 1999 session).
      expect(next.url).toContain('server=w');
      expect(next.url).toContain('handover=1');
      expect(next.url.includes('proto=ac1999')).toBe(kind === 'ac1999');
      next.open();
      expect(next.texts).toEqual([JSON.stringify({ adopt: 'h1.T' })]);
      next.text(JSON.stringify({ adopt: { ok: true } }));
      expect(old.texts).toContain('handoverRelease');
      // The old bridge closes the old socket: ours, not a drop.
      old.drop();
      expect(drops(events)).toEqual([]);
      next.text(JSON.stringify({ adopted: { ok: true, ms: 3 } }));
      expect(results(events)).toEqual([expect.objectContaining({ ok: true })]);
      // Everything goes on the new socket now; the connection never started over (no new 'connected').
      conn.sendBridgeText('routines');
      expect(next.texts.at(-1)).toBe('routines');
      expect(events.filter((e) => e.type === 'connected')).toHaveLength(1);
      // The new socket closing later is the session's end, reported once.
      next.drop();
      expect(drops(events)).toHaveLength(1);
    });

    it('a refusal before the old bridge lets go leaves the session where it was', () => {
      const { conn, events, old } = connected(kind);
      conn.handover();
      old.text(JSON.stringify({ handoverTicket: { ticket: 'h1.T' } }));
      const next = FakeSocket.sockets[1];
      next.open();
      next.text(JSON.stringify({ adopt: { ok: false, reason: 'other_host' } }));
      expect(results(events)).toEqual([expect.objectContaining({ ok: false, stage: 'adopt', reason: 'other_host', released: false })]);
      expect(next.closed).toBe(true);
      expect(old.texts).not.toContain('handoverRelease');
      conn.sendBridgeText('routines');
      expect(old.texts.at(-1)).toBe('routines');
      expect(drops(events)).toEqual([]);
      // The old socket is still the session's: its close is a drop.
      old.drop(1006);
      expect(drops(events)).toHaveLength(1);
    });

    it('no ticket (a bridge without the shared secret): nothing moves', () => {
      const { conn, events, old } = connected(kind);
      conn.handover();
      old.text(JSON.stringify({ handoverTicket: { ticket: null, reason: 'no_secret' } }));
      expect(FakeSocket.sockets).toHaveLength(1);
      expect(results(events)).toEqual([expect.objectContaining({ ok: false, stage: 'ticket', reason: 'no_secret', released: false })]);
    });

    it('a failure after the old bridge let go ends the session (the page resumes it)', () => {
      const { conn, events, old } = connected(kind);
      conn.handover();
      old.text(JSON.stringify({ handoverTicket: { ticket: 'h1.T' } }));
      const next = FakeSocket.sockets[1];
      next.open();
      next.text(JSON.stringify({ adopt: { ok: true } }));
      old.drop();
      next.text(JSON.stringify({ adopted: { ok: false, reason: 'port_busy' } }));
      expect(results(events)).toEqual([expect.objectContaining({ ok: false, stage: 'bind', released: true })]);
      const d = drops(events);
      expect(d).toHaveLength(1);
      expect(d[0]).toMatchObject({ deliberate: false, endCause: 'socket_closed' });
    });

    it('a disconnect while a handover is under way stops it silently', () => {
      const { conn, events, old } = connected(kind);
      conn.handover();
      old.text(JSON.stringify({ handoverTicket: { ticket: 'h1.T' } }));
      const next = FakeSocket.sockets[1];
      conn.disconnect();
      expect(next.closed).toBe(true);
      next.open();
      expect(next.texts).toEqual([]);
      expect(results(events)).toEqual([]);
    });
  });
}
