/**
 * VISUAL.149/.79 — ServerName (0xF7E1) wire-format parse.
 *
 * The ServerName message was silently dropped: ServerMessageHandler claimed it
 * was "handled by ClientConnection directly" but ClientConnection had no case,
 * so it fell through to the generic 'message' event and never reached the UI.
 * The char-select world plate showed a hardcoded "Dereth (Local)" instead of
 * the real world name.
 *
 * Wire format per ACE GameMessageServerName.cs:
 *   currentConnections : i32 (LE)
 *   maxConnections     : i32 (LE)
 *   serverName         : string16L (u16 length + windows-1252 bytes + 4-byte
 *                        align, including the 2 length bytes)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { parseServerName } from '../packages/network/src/MessageSerializer';
import {
  GameMessageOpcode, ClientConnection, type ConnectionEvent,
  PacketHeaderFlags, type PacketHeaderData, PACKET_HEADER_SIZE, FRAGMENT_HEADER_SIZE,
  writePacketHeader, fragmentMessage, writeFragment, GameMessageGroup, SessionState,
} from '@ac/network';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

/** Build a ServerName payload the way ACE's WriteString16L does. */
function buildServerNamePayload(current: number, max: number, name: string): Uint8Array {
  const nameBytes = new TextEncoder().encode(name); // ASCII subset == windows-1252
  const strFieldLen = 2 + nameBytes.length;
  const pad = (4 - (strFieldLen % 4)) % 4;
  const buf = new Uint8Array(8 + strFieldLen + pad);
  const dv = new DataView(buf.buffer);
  dv.setInt32(0, current, true);
  dv.setInt32(4, max, true);
  dv.setUint16(8, nameBytes.length, true);
  buf.set(nameBytes, 10);
  // remaining `pad` bytes already zero
  return buf;
}

describe('VISUAL.149 — ServerName (0xF7E1) parse', () => {
  it('parses currentConnections, maxConnections, and the world name', () => {
    const payload = buildServerNamePayload(5, -1, 'ACEmulator');
    const r = parseServerName(payload);
    expect(r.currentConnections).toBe(5);
    expect(r.maxConnections).toBe(-1);
    expect(r.serverName).toBe('ACEmulator');
  });

  it('consumes the 4-byte string alignment padding correctly', () => {
    // "Dereth" → 2+6 = 8 bytes (already aligned, no pad)
    const aligned = parseServerName(buildServerNamePayload(1, 1000, 'Dereth'));
    expect(aligned.serverName).toBe('Dereth');
    // "Thistledown" → 2+11 = 13 → pad 3 bytes to 16; parser must not read past
    const padded = parseServerName(buildServerNamePayload(42, 1000, 'Thistledown'));
    expect(padded.serverName).toBe('Thistledown');
    expect(padded.currentConnections).toBe(42);
  });

  it('tolerates a name-less payload (only connection counts)', () => {
    const buf = new Uint8Array(8);
    new DataView(buf.buffer).setInt32(0, 3, true);
    const r = parseServerName(buf);
    expect(r.currentConnections).toBe(3);
    expect(r.serverName).toBe('');
  });
});

// DEBT.test-harness-hygiene: converted from ClientConnection.ts / GameUI.ts
// source pins. The connection is driven through its real packet path
// (handshake + a BlobFragments packet, the verify-bug-ddd-begin-data-message-
// dropped.ts recipe); GameUI renders the real char-select world plate.
describe('VISUAL.149 — ClientConnection emits a serverName event (not dropped)', () => {
  beforeAll(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = globalThis as any;
    if (typeof g.WebSocket === 'undefined') g.WebSocket = class { static readonly OPEN = 1; };
  });

  function serverPacket(seq: number, flags: number, payload: Uint8Array): Uint8Array {
    const buf = new Uint8Array(PACKET_HEADER_SIZE + payload.length);
    const header: PacketHeaderData = { sequence: seq, flags, checksum: 0, id: 0x42, time: 0, size: payload.length, iteration: 1 };
    writePacketHeader(header, buf, 0);
    buf.set(payload, PACKET_HEADER_SIZE);
    return buf;
  }

  it('a ServerName (0xF7E1) message surfaces as a serverName event carrying the parsed data', () => {
    const conn = new ClientConnection('ws://test-not-connected');
    const events: ConnectionEvent[] = [];
    conn.on(e => events.push(e));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any).ws = { readyState: 1, send: () => {}, close: () => {} };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const feed = (pkt: Uint8Array): void => (conn as any).handlePacket(pkt);

    const connect = new Uint8Array(32);
    const v = new DataView(connect.buffer);
    v.setFloat64(0, 12345.0, true);
    for (let i = 8; i < 16; i++) connect[i] = 0x11;
    v.setUint32(16, 0x0421, true);
    connect.set([1, 2, 3, 4], 20);
    connect.set([5, 6, 7, 8], 24);
    feed(serverPacket(0, PacketHeaderFlags.ConnectRequest, connect));
    expect(conn.state).toBe(SessionState.AuthConnected);

    const body = buildServerNamePayload(5, 1000, 'Thistledown');
    const msg = new Uint8Array(4 + body.length);
    new DataView(msg.buffer).setUint32(0, GameMessageOpcode.ServerName, true);
    msg.set(body, 4);
    const [frag] = fragmentMessage(msg, 2, GameMessageGroup.DatabaseQueue, 0);
    const payload = new Uint8Array(FRAGMENT_HEADER_SIZE + frag.data.length);
    writeFragment(frag, payload, 0);
    feed(serverPacket(2, PacketHeaderFlags.BlobFragments, payload));

    const got = events.filter(e => e.type === 'serverName');
    expect(got.length).toBe(1);
    expect(got[0].data).toEqual({ currentConnections: 5, maxConnections: 1000, serverName: 'Thistledown' });
    conn.disconnect();
  });
});

describe('VISUAL.79 — GameUI renders the world name, not the invented "Dereth (Local)"', () => {
  let H: GameUIFixture;
  beforeAll(async () => { H = await mountGameUI(); });
  afterAll(() => H.teardown());

  // The World box 0x1000039b (#charsel-world-panel) — its text child is the name.
  const worldPanel = (): HTMLElement | null => H.win.document.getElementById('charsel-world-panel');

  it('before ServerName arrives the world plate is empty — no "Dereth (Local)" / "Connecting..." fallback', () => {
    H.ui.getTexURL = () => null;
    H.ui.layoutRenderer = null;
    H.ui.showCharacterSelect([{ id: 1, name: 'Perf Tester' }]);
    expect(worldPanel()).not.toBeNull();
    expect(worldPanel()!.textContent).toBe('');
    expect(H.win.document.body.textContent).not.toContain('Dereth (Local)');
  });

  it('setWorldName stores the name and the char-select plate shows it', () => {
    H.ui.setWorldName('ACEmulator');
    expect(H.ui.worldName).toBe('ACEmulator');
    H.ui.renderCharacterSelect();
    expect(worldPanel()!.textContent).toBe('ACEmulator');
  });
});
