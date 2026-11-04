/**
 * UX.chargen-resume live check (2026-10-29): the drop the probe made never
 * armed the chargen resume, and the probe passed anyway.
 *
 * The page console showed CantSocket, then disconnected(everOpened=false):
 * the close of a socket the CONNECTION opened on its own (the stale-session
 * login retry after CharacterError.Logon) while the relay was down, not the
 * close of a live session. The probe had opened chargen over the connecting
 * screen, mid-login (its char-select wait accepted that screen), so no session
 * was live to drop. These tests drive the real ClientConnection through that
 * exact sequence and through a live session's drop, and feed its events to the
 * page's decision (session/SessionLiveness.ts):
 *  - a live session's socket closing: a drop (everOpened=true), resumed;
 *  - the stale-session retry's socket failing before any character list: not a
 *    drop (the page stays on its connecting / refusal path, as before);
 *  - a live session whose end comes from a socket that never opened (a socket
 *    the connection opened on its own after the list): still a drop, and the
 *    CantSocket before it raises no refusal dialog;
 *  - a page-started connect resets liveness (leaving for the launcher, then an
 *    unreachable bridge, stays CantSocket, not the Disconnected screen).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ClientConnection, type ConnectionEvent,
  PacketHeaderFlags, type PacketHeaderData, PACKET_HEADER_SIZE, FRAGMENT_HEADER_SIZE,
  writePacketHeader, fragmentMessage, writeFragment, GameMessageGroup,
} from '@ac/network';
import { SessionLiveness, sessionDropped, liveSessionSocketFailed } from '../packages/renderer/src/session/SessionLiveness.js';

const CHARACTER_ERROR = 0xF659;
const CHARACTER_LIST = 0xF658;
const ERR_LOGON = 0x1;

class FakeSocket {
  static readonly CONNECTING = 0; static readonly OPEN = 1; static readonly CLOSING = 2; static readonly CLOSED = 3;
  static instances: FakeSocket[] = [];
  readyState = 0;
  binaryType = '';
  onopen: (() => void) | null = null;
  onmessage: ((e: unknown) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeSocket.instances.push(this); }
  send(): void {}
  close(): void { this.readyState = 3; }
  open(): void { this.readyState = 1; this.onopen?.(); }
  /** The far end went away (a killed relay, a dead network): error, then close 1006, as browsers report it. */
  die(): void { this.readyState = 3; this.onerror?.(); this.onclose?.({ code: 1006 }); }
}

beforeAll(() => { (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket; });
afterEach(() => { FakeSocket.instances = []; vi.useRealTimers(); vi.restoreAllMocks(); });

function packet(seq: number, opcode: number, fragSeq: number, arg?: number): Uint8Array {
  const msg = new Uint8Array(8);
  const v = new DataView(msg.buffer);
  v.setUint32(0, opcode, true);
  if (arg !== undefined) v.setUint32(4, arg, true);
  const [frag] = fragmentMessage(msg, seq, GameMessageGroup.WeenieQueue, fragSeq);
  const payload = new Uint8Array(FRAGMENT_HEADER_SIZE + frag.data.length);
  writeFragment(frag, payload, 0);
  const buf = new Uint8Array(PACKET_HEADER_SIZE + payload.length);
  const header: PacketHeaderData = { sequence: seq, flags: PacketHeaderFlags.BlobFragments, checksum: 0, id: 0x42, time: 0, size: payload.length, iteration: 1 };
  writePacketHeader(header, buf, 0);
  buf.set(payload, PACKET_HEADER_SIZE);
  return buf;
}

/** The real connection plus the page's liveness, fed the way main.ts feeds it. */
function rig() {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const conn = new ClientConnection('ws://relay');
  conn.autoReconnect = false; // as main.ts sets it
  const live = new SessionLiveness();
  const events: ConnectionEvent[] = [];
  const decisions: { dropped: boolean; dialogSuppressed?: boolean }[] = [];
  conn.on((e) => {
    events.push(e);
    if (e.type === 'characterList') live.noteCharacterList();
    if (e.type === 'error' && e.netErrorId) decisions.push({ dropped: false, dialogSuppressed: liveSessionSocketFailed(e, live.isLive, false) });
    if (e.type === 'disconnected') { decisions.push({ dropped: sessionDropped(e, live.isLive) }); live.noteEnded(); }
  });
  const pageConnect = (): void => { live.noteConnectAttempt(); conn.connect('acct', 'pw'); };
  const feed = (p: Uint8Array): void => (conn as unknown as { handlePacket(p: Uint8Array): void }).handlePacket(p);
  return { conn, live, events, decisions, pageConnect, feed };
}

describe('the live check\'s sequence: the stale-session retry\'s socket fails with the relay down', () => {
  it('CantSocket then disconnected(everOpened=false): no session was live, so no drop (as before)', () => {
    vi.useFakeTimers();
    const r = rig();
    r.pageConnect();
    FakeSocket.instances[0].open();
    r.feed(packet(2, CHARACTER_ERROR, 0, ERR_LOGON)); // "account in use": detach, retry in 3 s
    expect(r.events.some((e) => e.type === 'loginRetry')).toBe(true);
    vi.advanceTimersByTime(ClientConnection.LOGIN_REJECT_RETRY_MS);
    expect(FakeSocket.instances).toHaveLength(2); // the connection opened this one itself
    FakeSocket.instances[1].die(); // the relay is down
    const tail = r.events.slice(-2).map((e) => ({ type: e.type, netErrorId: e.netErrorId, everOpened: e.everOpened }));
    expect(tail).toEqual([
      { type: 'error', netErrorId: 'ID_NetError_CantSocket', everOpened: undefined },
      { type: 'disconnected', netErrorId: undefined, everOpened: false },
    ]);
    expect(r.decisions).toEqual([{ dropped: false, dialogSuppressed: false }, { dropped: false }]);
  });
});

describe('a live session', () => {
  it('its socket closing under it is a drop (everOpened=true), once', () => {
    const r = rig();
    r.pageConnect();
    FakeSocket.instances[0].open();
    r.feed(packet(2, CHARACTER_LIST, 0));
    expect(r.live.isLive).toBe(true);
    FakeSocket.instances[0].die();
    const disc = r.events.filter((e) => e.type === 'disconnected');
    expect(disc).toHaveLength(1);
    expect(disc[0]).toMatchObject({ everOpened: true, deliberate: false, endCause: 'socket_closed', closeCode: 1006 });
    expect(r.decisions.at(-1)).toEqual({ dropped: true });
  });

  it('ended by a socket the connection opened on its own that never opened: still a drop, and no refusal dialog', () => {
    vi.useFakeTimers();
    const r = rig();
    r.pageConnect();
    FakeSocket.instances[0].open();
    r.feed(packet(2, CHARACTER_LIST, 0));
    // The connection's own reconnect (dormant in the app, on here) replaces the dead socket.
    r.conn.autoReconnect = true;
    FakeSocket.instances[0].die();
    // That first end is the live drop; the page resumes it. Then a reconnect socket fails unopened.
    expect(r.decisions.at(-1)).toEqual({ dropped: true });
    // Simulate a session the page still holds as live when the replacement socket fails (no 'disconnected' in between).
    r.live.noteCharacterList();
    // The reconnect opens its socket after 2 s; the browser fails it before its own open timeout
    // (15 s, BUG.resume-hung-socket: past it the connection gives up on the socket itself).
    vi.advanceTimersByTime(5_000);
    expect(FakeSocket.instances).toHaveLength(2);
    const failed = FakeSocket.instances[1];
    expect(failed).toBeTruthy();
    failed.die();
    const tail = r.events.filter((e) => e.type === 'error' || e.type === 'disconnected').slice(-2);
    expect(tail.map((e) => [e.type, e.everOpened ?? null, e.netErrorId ?? null])).toEqual([
      ['error', null, 'ID_NetError_CantSocket'], ['disconnected', false, null],
    ]);
    expect(r.decisions.slice(-2)).toEqual([{ dropped: false, dialogSuppressed: true }, { dropped: true }]);
  });

  it('our own close is never a drop, live or not', () => {
    const r = rig();
    r.pageConnect();
    FakeSocket.instances[0].open();
    r.feed(packet(2, CHARACTER_LIST, 0));
    r.conn.disconnect();
    FakeSocket.instances[0].onclose?.({ code: 1000 });
    expect(r.decisions.every((d) => !d.dropped)).toBe(true);
  });

  it('a page-started connect resets liveness: an unreachable bridge after leaving the world stays CantSocket', () => {
    const r = rig();
    r.pageConnect();
    FakeSocket.instances[0].open();
    r.feed(packet(2, CHARACTER_LIST, 0));
    r.conn.disconnect(); // leaving for the launcher
    r.pageConnect(); // the launcher's ENTER
    FakeSocket.instances[1].die();
    expect(r.decisions.slice(-2)).toEqual([{ dropped: false, dialogSuppressed: false }, { dropped: false }]);
  });
});

describe('SessionLiveness / sessionDropped', () => {
  it('the rule', () => {
    const l = new SessionLiveness();
    expect(l.isLive).toBe(false);
    l.noteCharacterList();
    expect(l.isLive).toBe(true);
    l.noteEnded();
    expect(l.isLive).toBe(false);
    l.noteCharacterList();
    l.noteConnectAttempt();
    expect(l.isLive).toBe(false);
    expect(sessionDropped({ everOpened: true, deliberate: false }, false)).toBe(true);
    expect(sessionDropped({ everOpened: false, deliberate: false }, true)).toBe(true);
    expect(sessionDropped({ everOpened: false, deliberate: false }, false)).toBe(false);
    expect(sessionDropped({ everOpened: true, deliberate: true }, true)).toBe(false);
    expect(liveSessionSocketFailed({ netErrorId: 'ID_NetError_CantSocket' }, true, true)).toBe(false); // the page's own resume counts it
  });
});
