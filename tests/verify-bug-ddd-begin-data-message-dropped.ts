/**
 * BUG.ddd-begin-data-message-dropped
 *
 * DDD_BeginDDD (0xF7E7) and DDD_DataMessage (0xF7E2) were silently dropped:
 * ServerMessageHandler no-op'd both with a comment claiming "handled by
 * ClientConnection directly", but ClientConnection's processMessage()
 * switch had no case for either opcode — every message fell through to the
 * generic 'message' emit and back to the same no-op. On a server with
 * DDD.EnableDATPatching=true and a DAT iteration mismatch (a real,
 * non-default, documented ACE config — ACE.Common/DDDConfiguration.cs), the
 * exchange was discarded with no warning and no visibility.
 *
 * Wire formats:
 *   DDD_BeginDDD per ACE GameMessageDDDBeginDDD.cs: u32 totalFileSize +
 *     u32 totalMissingIterations, then that many entries of
 *     i32 datFileType + i32 datFileID + i32 iteration +
 *     i32 idsToDownloadCount + ids×u32 + i32 idsToPurgeCount + ids×u32.
 *     (Portal=(0,1), Cell=(1,2), Language=(1,3),
 *     HighRes=(DDDManager.HiFi_String_As_Int, 1).)
 *   DDD_DataMessage per ACE GameMessageDDDDataMessage.cs: u32 datFileType +
 *     u32 datFileID + u32 fileType + u32 fileId + u32 iteration +
 *     bool isCompressed (1 byte) + i32 version + i32 length
 *     (=contents.length+4, self-inclusive) + (length-4) content bytes.
 *
 * This client doesn't implement live DAT patching (no writable local DAT
 * store to patch into in a browser), so the fix is: parse both messages for
 * real (dispatch coverage — no more silent drop), emit dedicated
 * ClientConnection events, and surface a console warning — the same floor
 * already established for DDD_ErrorMessage (FAITHFUL.602).
 *
 * These tests drive real server packet bytes through the real
 * ClientConnection (handshake included), not a source-text pin.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import {
  GameMessageOpcode, ClientConnection, ConnectionEvent,
  PacketHeaderFlags, PacketHeaderData,
  PACKET_HEADER_SIZE, FRAGMENT_HEADER_SIZE,
  writePacketHeader, fragmentMessage, writeFragment,
  GameMessageGroup, SessionState,
  parseDDDBeginDDD, parseDDDDataMessage,
} from '@ac/network';

const DDD_HIFI_STRING_AS_INT = 0x69466948;

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return b;
}
function i32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, n, true);
  return b;
}
function u8(n: number): Uint8Array {
  return new Uint8Array([n]);
}
function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

interface RawEntry {
  datFileType: number;
  datFileID: number;
  iteration: number;
  idsToDownload: number[];
  idsToPurge: number[];
}

/** Mirrors ACE GameMessageDDDBeginDDD.cs exactly (including the opcode prefix). */
function buildDDDBeginDDDPayload(totalFileSize: number, entries: RawEntry[]): Uint8Array {
  const parts: Uint8Array[] = [
    u32(GameMessageOpcode.DDD_BeginDDD),
    u32(totalFileSize),
    u32(entries.length),
  ];
  for (const e of entries) {
    parts.push(i32(e.datFileType), i32(e.datFileID), i32(e.iteration));
    parts.push(i32(e.idsToDownload.length), ...e.idsToDownload.map(u32));
    parts.push(i32(e.idsToPurge.length), ...e.idsToPurge.map(u32));
  }
  return concatBytes(parts);
}

/** Mirrors ACE GameMessageDDDDataMessage.cs exactly (including the opcode prefix). */
function buildDDDDataMessagePayload(opts: {
  datFileType: number; datFileID: number; fileType: number; fileId: number;
  iteration: number; isCompressed: boolean; contents: Uint8Array;
}): Uint8Array {
  return concatBytes([
    u32(GameMessageOpcode.DDD_DataMessage),
    u32(opts.datFileType),
    u32(opts.datFileID),
    u32(opts.fileType),
    u32(opts.fileId),
    u32(opts.iteration),
    u8(opts.isCompressed ? 1 : 0),
    i32(3), // version
    i32(opts.contents.length + 4), // length (self-inclusive of this field)
    opts.contents,
  ]);
}

describe('BUG.ddd-begin-data-message-dropped — parseDDDBeginDDD', () => {
  it('parses totalFileSize/totalMissingIterations and classifies each dat type', () => {
    const payload = buildDDDBeginDDDPayload(999, [
      { datFileType: 0, datFileID: 1, iteration: 500, idsToDownload: [0x06001234, 0x01005678], idsToPurge: [] },
      { datFileType: 1, datFileID: 2, iteration: 250, idsToDownload: [], idsToPurge: [0xAABB0001, 0xAABB0002, 0xAABB0003] },
      { datFileType: 1, datFileID: 3, iteration: 10, idsToDownload: [0x31000001], idsToPurge: [] },
      { datFileType: DDD_HIFI_STRING_AS_INT, datFileID: 1, iteration: 4, idsToDownload: [0x06009999], idsToPurge: [] },
    ]).slice(4); // strip opcode prefix — parseDDDBeginDDD receives the payload, not the raw message

    const r = parseDDDBeginDDD(payload);
    expect(r.totalFileSize).toBe(999);
    expect(r.totalMissingIterations).toBe(4);
    expect(r.entries).toHaveLength(4);

    expect(r.entries[0]).toEqual({
      datType: 'portal', iteration: 500,
      idsToDownload: [0x06001234, 0x01005678], idsToPurge: [],
    });
    expect(r.entries[1]).toEqual({
      datType: 'cell', iteration: 250,
      idsToDownload: [], idsToPurge: [0xAABB0001, 0xAABB0002, 0xAABB0003],
    });
    expect(r.entries[2]).toEqual({
      datType: 'language', iteration: 10,
      idsToDownload: [0x31000001], idsToPurge: [],
    });
    expect(r.entries[3]).toEqual({
      datType: 'highres', iteration: 4,
      idsToDownload: [0x06009999], idsToPurge: [],
    });
  });

  it('handles zero missing iterations (empty entries array, no over-read)', () => {
    const payload = buildDDDBeginDDDPayload(0, []).slice(4);
    const r = parseDDDBeginDDD(payload);
    expect(r.totalFileSize).toBe(0);
    expect(r.totalMissingIterations).toBe(0);
    expect(r.entries).toEqual([]);
  });
});

describe('BUG.ddd-begin-data-message-dropped — parseDDDDataMessage', () => {
  it('parses a portal file patch with real content bytes', () => {
    const contents = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF, 0x01, 0x02]);
    const payload = buildDDDDataMessagePayload({
      datFileType: 0, datFileID: 1, fileType: 0x06, fileId: 0x06001234,
      iteration: 497, isCompressed: false, contents,
    }).slice(4);

    const r = parseDDDDataMessage(payload);
    expect(r.datType).toBe('portal');
    expect(r.fileType).toBe(0x06);
    expect(r.fileId).toBe(0x06001234);
    expect(r.iteration).toBe(497);
    expect(r.isCompressed).toBe(false);
    expect(r.version).toBe(3);
    expect(r.contents).toEqual(contents);
  });

  it('parses isCompressed=true as a single byte, not a 4-byte field', () => {
    const contents = new Uint8Array([0x11, 0x22, 0x33]);
    const payload = buildDDDDataMessagePayload({
      datFileType: 1, datFileID: 2, fileType: 0xFFFF, fileId: 0x0012FFFF,
      iteration: 982, isCompressed: true, contents,
    }).slice(4);

    const r = parseDDDDataMessage(payload);
    expect(r.datType).toBe('cell');
    expect(r.isCompressed).toBe(true);
    expect(r.contents).toEqual(contents);
  });

  it('handles a zero-length content patch', () => {
    const payload = buildDDDDataMessagePayload({
      datFileType: DDD_HIFI_STRING_AS_INT, datFileID: 1, fileType: 0x06, fileId: 0x06005555,
      iteration: 1, isCompressed: false, contents: new Uint8Array(0),
    }).slice(4);

    const r = parseDDDDataMessage(payload);
    expect(r.datType).toBe('highres');
    expect(r.contents.length).toBe(0);
  });
});

describe('BUG.ddd-begin-data-message-dropped — ClientConnection dispatches real events instead of silent drop', () => {
  beforeAll(() => {
    if (typeof (globalThis as any).WebSocket === 'undefined') {
      (globalThis as any).WebSocket = class FakeWebSocket {
        static readonly CONNECTING = 0;
        static readonly OPEN = 1;
        static readonly CLOSING = 2;
        static readonly CLOSED = 3;
      };
    }
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

  // fragSeq defaults to 0 — every caller here sends exactly one message on a
  // fresh post-handshake ClientConnection, so it's always the first fragment
  // the ordering gate (BUG.fragment-sequence-not-reordered) will see.
  function buildMessagePacket(seq: number, msg: Uint8Array, fragSeq: number = 0): Uint8Array {
    const [frag] = fragmentMessage(msg, seq, GameMessageGroup.DatabaseQueue, fragSeq);
    const payload = new Uint8Array(FRAGMENT_HEADER_SIZE + frag.data.length);
    writeFragment(frag, payload, 0);
    return buildServerPacket(seq, PacketHeaderFlags.BlobFragments, payload);
  }

  function buildConnectRequest(): Uint8Array {
    const payload = new Uint8Array(32);
    const v = new DataView(payload.buffer);
    v.setFloat64(0, 12345.0, true);
    for (let i = 8; i < 16; i++) payload[i] = 0x11;
    v.setUint32(16, 0x0421, true);
    payload.set([1, 2, 3, 4], 20);
    payload.set([5, 6, 7, 8], 24);
    return buildServerPacket(0, PacketHeaderFlags.ConnectRequest, payload);
  }

  interface Harness { conn: ClientConnection; events: ConnectionEvent[]; }

  function makeHarness(): Harness {
    const conn = new ClientConnection('ws://test-not-connected');
    const events: ConnectionEvent[] = [];
    conn.on(e => events.push(e));
    (conn as any).ws = {
      readyState: 1,
      send: () => {},
      close: () => {},
    };
    return { conn, events };
  }

  function feed(h: Harness, pkt: Uint8Array): void {
    (h.conn as any).handlePacket(pkt);
  }

  function handshake(h: Harness): void {
    feed(h, buildConnectRequest());
    expect(h.conn.state).toBe(SessionState.AuthConnected);
  }

  it('DDD_BeginDDD dispatches a dddBeginDDD event with the parsed data (not silently dropped)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = makeHarness();
    handshake(h);

    const payload = buildDDDBeginDDDPayload(4096, [
      { datFileType: 0, datFileID: 1, iteration: 500, idsToDownload: [0x06001234], idsToPurge: [] },
    ]);
    feed(h, buildMessagePacket(2, payload));

    const beginEvents = h.events.filter(e => e.type === 'dddBeginDDD');
    expect(beginEvents.length).toBe(1);
    expect(beginEvents[0].data).toEqual({
      totalFileSize: 4096,
      totalMissingIterations: 1,
      entries: [{ datType: 'portal', iteration: 500, idsToDownload: [0x06001234], idsToPurge: [] }],
    });
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0][0]).toContain('DDD_BeginDDD');

    warnSpy.mockRestore();
    h.conn.disconnect();
  });

  it('DDD_DataMessage dispatches a dddDataMessage event with the parsed content bytes (not silently dropped)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = makeHarness();
    handshake(h);

    const contents = new Uint8Array([1, 2, 3, 4, 5]);
    const payload = buildDDDDataMessagePayload({
      datFileType: 0, datFileID: 1, fileType: 0x06, fileId: 0x06001234,
      iteration: 500, isCompressed: false, contents,
    });
    feed(h, buildMessagePacket(2, payload));

    const dataEvents = h.events.filter(e => e.type === 'dddDataMessage');
    expect(dataEvents.length).toBe(1);
    const data = dataEvents[0].data as ReturnType<typeof parseDDDDataMessage>;
    expect(data.datType).toBe('portal');
    expect(data.fileId).toBe(0x06001234);
    expect(data.contents).toEqual(contents);
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0][0]).toContain('DDD_DataMessage');

    warnSpy.mockRestore();
    h.conn.disconnect();
  });

  it('both messages also still reach generic \'message\' listeners (dedicated event is additive, not a replacement)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = makeHarness();
    handshake(h);

    feed(h, buildMessagePacket(2, buildDDDBeginDDDPayload(0, [])));
    const genericEvents = h.events.filter(e => e.type === 'message');
    expect(genericEvents.length).toBeGreaterThanOrEqual(1);

    warnSpy.mockRestore();
    h.conn.disconnect();
  });
});
