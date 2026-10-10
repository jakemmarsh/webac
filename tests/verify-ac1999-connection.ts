/**
 * Connection1999 end to end over a fake bridge socket, replaying the real
 * 1999 server's datagrams (tests/fixtures/ac1999-session-001.jsonl.gz): the
 * login, the grant (and our ack), the DAT sync, the character list as an
 * end-of-retail message — and the auto-resume path (SessionLifecycle calls
 * disconnect() then connect() on the same object): the second login starts a
 * fresh 1999 session, and the closed socket's late frames are ignored.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Connection1999 } from '../packages/network/src/era1999/Connection1999.js';
import { F1999, readHeader1999 } from '../packages/network/src/era1999/Packet1999.js';
import { parseCharacterList, type ConnectionEvent } from '../packages/network/src/index.js';

const s2c: Uint8Array[] = gunzipSync(readFileSync(resolve(__dirname, 'fixtures', 'ac1999-session-001.jsonl.gz')))
  .toString().trim().split('\n').map((l) => JSON.parse(l))
  .filter((j) => j.d === 's2c').map((j) => new Uint8Array(Buffer.from(j.b, 'base64')));

class FakeSocket {
  static OPEN = 1;
  static sockets: FakeSocket[] = [];
  readyState = 0;
  binaryType = '';
  sent: Uint8Array[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer | string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) { FakeSocket.sockets.push(this); }
  send(b: Uint8Array): void { this.sent.push(b); }
  close(): void { this.readyState = 3; this.onclose?.(); }
  open(): void { this.readyState = 1; this.onopen?.(); }
  deliver(b: Uint8Array): void { this.onmessage?.({ data: b.slice().buffer }); }
}

const g = globalThis as { WebSocket?: unknown };
let saved: unknown;
beforeEach(() => { saved = g.WebSocket; g.WebSocket = FakeSocket; FakeSocket.sockets = []; });
afterEach(() => { g.WebSocket = saved; });

/** Replay the server's side up to and including the first character list. */
function loginThrough(sock: FakeSocket, events: ConnectionEvent[]): void {
  for (const b of s2c) {
    sock.deliver(b);
    if (events.some((e) => e.type === 'characterList')) return;
  }
}

describe('Connection1999 over the real server traffic', () => {
  it('logs in: login packet, grant ack, DAT sync, character list as an end-of-retail message', () => {
    const conn = new Connection1999('ws://bridge');
    conn.datIterations = { portal: 102, cell: 67, language: 0 };
    const events: ConnectionEvent[] = [];
    conn.on((e) => events.push(e));
    conn.connect('acjsdbja', 'acjsdbja');
    const sock = FakeSocket.sockets[0];
    expect(sock.url).toBe('ws://bridge?proto=ac1999');
    sock.open();
    expect(readHeader1999(sock.sent[0]).flags).toBe(F1999.Checksum); // the LoginRequest
    loginThrough(sock, events);
    expect(sock.sent.some((p) => readHeader1999(p).flags === (F1999.Connect | F1999.Checksum))).toBe(true); // grant ack
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['connected', 'handshakeComplete', 'characterList']));
    const list = parseCharacterList(events.find((e) => e.type === 'characterList')!.data as Uint8Array);
    expect(list.accountName).toBe('acjsdbja');
    expect(conn.badChecksums).toBe(0);
    conn.disconnect();
  });

  it('resumes after a drop: disconnect() + connect() starts a fresh session; the old socket is ignored', () => {
    const conn = new Connection1999('ws://bridge');
    conn.datIterations = { portal: 102, cell: 67, language: 0 };
    const events: ConnectionEvent[] = [];
    conn.on((e) => events.push(e));
    conn.connect('acjsdbja', 'acjsdbja');
    const first = FakeSocket.sockets[0];
    first.open();
    loginThrough(first, events);
    conn.disconnect();
    expect(events.filter((e) => e.type === 'disconnected')).toHaveLength(1);

    events.length = 0;
    conn.connect('acjsdbja', 'acjsdbja');
    const second = FakeSocket.sockets[1];
    second.open();
    // A late frame on the closed socket changes nothing.
    first.deliver(s2c[s2c.length - 1]);
    // The new session replays from the server's first packet: sequence 1 again, keys from the start.
    loginThrough(second, events);
    expect(events.filter((e) => e.type === 'characterList')).toHaveLength(1);
    expect(conn.badChecksums).toBe(0);
    expect(readHeader1999(second.sent[0]).sequence).toBe(1); // a fresh LoginRequest
  });
});

// BUG.ac1999-enter-world-retry-hangs — the AC1999 server sets bInWorld on the
// first 0xF7C8 (CClient::EnterWorld) and clears it only in ExitWorld (0xF653
// out), so after "One of your characters is still in the world" it ignores
// every further 0xF7C8. The 1999 client keeps the 0xF7C7 flag (char screen
// +0x290) and sends 0xF657 straight away; we answer a repeat request as ready.
describe('Connection1999: a repeat enter-world request after the server said ready', () => {
  const u32 = (v: number): Uint8Array => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b; };
  const dispatch = (conn: Connection1999, bytes: Uint8Array): void => {
    (conn as unknown as { dispatchEoLUnchecked(d: Uint8Array): void }).dispatchEoLUnchecked(bytes);
  };

  it('first request goes out; after ready + a still-in-world refusal the retry is answered as ready without a send; a logoff resets it', async () => {
    const conn = new Connection1999('ws://bridge');
    conn.datIterations = { portal: 102, cell: 67, language: 0 };
    const events: ConnectionEvent[] = [];
    conn.on((e) => events.push(e));
    conn.connect('acjsdbja', 'acjsdbja');
    const sock = FakeSocket.sockets[0];
    sock.open();
    loginThrough(sock, events);
    const ready = (): number => events.filter((e) => e.type === 'enterWorldReady').length;

    let sent = sock.sent.length;
    conn.sendMessage(u32(0xf7c8));
    expect(sock.sent.length).toBe(sent + 1); // the real request

    dispatch(conn, u32(0xf7df)); // the server's ready (0xF7C7, as the adapter hands it on)
    expect(ready()).toBe(1);
    const refusal = new Uint8Array(8); new DataView(refusal.buffer).setUint32(0, 0xf659, true); new DataView(refusal.buffer).setUint32(4, 0x0d, true);
    dispatch(conn, refusal); // CharacterError EnterGameCharacterInWorld
    expect(events.some((e) => e.type === 'error' && e.characterError === 0x0d)).toBe(true);

    sent = sock.sent.length;
    conn.sendMessage(u32(0xf7c8)); // the retry
    expect(sock.sent.length).toBe(sent); // not sent: the server would ignore it
    await new Promise((r) => setTimeout(r, 0));
    expect(ready()).toBe(2); // so the client goes on to 0xF657

    dispatch(conn, u32(0xf653)); // left the world
    sent = sock.sent.length;
    conn.sendMessage(u32(0xf7c8));
    expect(sock.sent.length).toBe(sent + 1); // a real request again
    conn.disconnect();
  });
});
