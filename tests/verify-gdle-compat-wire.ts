/**
 * GDLE compatibility: wire fixes found by the first live session against a
 * local vanilla GDLE 1.34 server (docs/gdle-compat.md, tools/gdle/). Each
 * case drives the shipped code and decodes its bytes the way GDLE's source
 * does AND the way ACE does, so a fix for one server can't break the other.
 *
 *   1. LoginRequest header Id must be 0 (GDLE Network.cpp routes only
 *      wRecID == 0 to ProcessConnectionless; the old default 1 was dropped).
 *   2. DDD_InterrogationResponse must be retail's: tag (DataSubset, DataSet)
 *      and the raw iteration record [N, -N, 1] (GDLE memcmp()s 12 bytes per
 *      list against its 0xFFFF0001 file; the old [N, -(N+1)] failed login).
 *   3. AutonomousPosition must carry the instance / teleport / force-position
 *      stamps from our own CreateObject (GDLE "Bad instance." drops it).
 *   4. The fragment gate starts at GDLE's first fragment sequence (2), so
 *      the character list isn't held for the 2 s stall timeout.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import {
  ClientConnection,
  ConnectionData,
  OrderedFragmentBuffer,
  buildDDDInterrogationResponse,
  parseAutonomousPositionPayload,
  PhysicsTimestamp,
  GameMessageGroup,
  type ConnectionEvent,
} from '@ac/network';
import { MovementSync } from '../packages/renderer/src/network/MovementSync.js';
import type { MovementState, PlayerPosition } from '../packages/renderer/src/network/MovementSync.js';
import { openDat, DAT_PATHS } from './_harness/dat.js';

const g = globalThis as { WebSocket?: unknown };
if (typeof g.WebSocket === 'undefined') g.WebSocket = class { static readonly OPEN = 1; };

// ── 1. LoginRequest header Id ───────────────────────────────────────────────

describe('LoginRequest header Id (GDLE connectionless routing)', () => {
  function loginDatagram(): Uint8Array {
    const conn = new ClientConnection('ws://unit-test-not-connected');
    const sent: Uint8Array[] = [];
    (conn as unknown as { ws: unknown }).ws = {
      readyState: 1, close: () => {},
      send: (b: ArrayBuffer) => sent.push(new Uint8Array(b)),
    };
    (conn as unknown as { sendLoginRequest(a: string, p: string): void }).sendLoginRequest('gdleprobe1', 'probepw1');
    expect(sent.length).toBe(1);
    return sent[0];
  }

  it('a fresh connection stamps header Id 0 on its LoginRequest', () => {
    const d = loginDatagram();
    const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
    expect(v.getUint32(4, true)).toBe(0x00010000); // LoginRequest flag
    // GDLE: `if (wRecID == 0) ProcessConnectionless(...)`. Any other id goes
    // to ValidateClient, finds no session, and the login is silently dropped.
    expect(v.getUint16(12, true)).toBe(0);
    // Header Size matches the payload (GDLE also checks this before routing).
    expect(v.getUint16(16, true)).toBe(d.length - 20);
  });

  it('the server-assigned id from ConnectRequest replaces it', () => {
    const server = new ConnectionData(0x1234);
    const client = new ConnectionData();
    expect(client.clientId).toBe(0);
    client.initializeCryptoFromConnect(ConnectionData.parseConnectRequest(server.buildConnectRequest(0)));
    expect(client.clientId).toBe(0x1234);
  });
});

// ── 2. DDD_InterrogationResponse ───────────────────────────────────────────

interface TaggedList { type: number; id: number; iterations: number; ints: number[] }

/** ACE ReadCAllIterationList → PTaggedIterationList → ReadCMostlyConsecutiveIntSet, from offset `o`. */
function readIterationLists(v: DataView, o: number): { lists: TaggedList[]; end: number } {
  const n = v.getUint32(o, true); o += 4;
  const lists: TaggedList[] = [];
  for (let i = 0; i < n; i++) {
    const type = v.getInt32(o, true); o += 4;
    const id = v.getInt32(o, true); o += 4;
    const iterations = v.getInt32(o, true); o += 4;
    const ints: number[] = [];
    let count = 0;
    while (count !== iterations) {
      const x = v.getInt32(o, true); o += 4;
      count += x < 0 ? Math.abs(x) - 1 : 1;
      ints.push(x);
    }
    lists.push({ type, id, iterations, ints });
  }
  return { lists, end: o };
}

/** ACE DDDHandler: m_ClientLanguage, then m_ItersWithKeys; it reads nothing after that. */
function parseAce(msg: Uint8Array): { language: number; lists: TaggedList[]; consumed: number } {
  const v = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
  const language = v.getUint32(4, true); // after the opcode
  const { lists, end } = readIterationLists(v, 8);
  return { language, lists, consumed: end };
}

/** Retail DDD_InterrogationResponseMessage::Serialize @ 004f9700: the whole message. */
function parseRetail(msg: Uint8Array): { withKeys: TaggedList[]; withoutKeys: TaggedList[]; flags: number; consumed: number } {
  const v = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
  const a = readIterationLists(v, 8);
  const b = readIterationLists(v, a.end);
  const flags = v.getUint32(b.end, true);
  return { withKeys: a.lists, withoutKeys: b.lists, flags, consumed: b.end + 4 };
}

/** ACE DDDManager.GetMissingIterationsFromClient's first check: |int| == total ⇒ nothing missing. */
function aceSaysUpToDate(list: TaggedList, serverTotal: number): boolean {
  return list.ints.some((x) => Math.abs(x) === serverTotal);
}

/** GDLE Client.cpp case 0xF7E6: per list read ds, dss, then a FIXED 12 bytes it memcmp()s. */
function parseGdle(msg: Uint8Array): Array<{ ds: number; dss: number; iter: Uint8Array }> {
  const v = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
  let o = 8; // opcode + clientLanguage
  const fileCount = v.getInt32(o, true); o += 4;
  const out: Array<{ ds: number; dss: number; iter: Uint8Array }> = [];
  for (let i = 0; i < fileCount; i++) {
    const ds = v.getInt32(o, true); o += 4;
    const dss = v.getInt32(o, true); o += 4;
    out.push({ ds, dss, iter: msg.subarray(o, o + 12) });
    o += 12;
  }
  return out;
}

function iterationRecord(n: number): Uint8Array {
  const b = new Uint8Array(12);
  const v = new DataView(b.buffer);
  v.setInt32(0, n, true); v.setInt32(4, -n, true); v.setInt32(8, 1, true);
  return b;
}

describe('DDD_InterrogationResponse (retail iteration lists)', () => {
  const PORTAL = 2072, CELL = 982, LOCAL = 994; // EoL TotalIterations
  const msg = buildDDDInterrogationResponse(PORTAL, CELL, LOCAL);

  it('ACE parses it: ids 1/2/3, totals, and no missing iterations', () => {
    const { language, lists, consumed } = parseAce(msg);
    expect(language).toBe(1);
    // ACE stops after m_ItersWithKeys; retail's empty m_ItersWithoutKeys and m_dwFlags follow.
    expect(consumed).toBe(msg.length - 8);
    expect(lists.map((l) => [l.id, l.iterations])).toEqual([[1, PORTAL], [2, CELL], [3, LOCAL]]);
    expect(aceSaysUpToDate(lists[0], PORTAL)).toBe(true);
    expect(aceSaysUpToDate(lists[1], CELL)).toBe(true);
    expect(aceSaysUpToDate(lists[2], LOCAL)).toBe(true);
  });

  it('GDLE parses it: portal tag (0,1), cell tag (1,2), and each 12-byte body equals the iteration record', () => {
    const files = parseGdle(msg);
    expect(files.map((f) => [f.ds, f.dss])).toEqual([[0, 1], [1, 2], [1, 3]]);
    expect([...files[0].iter]).toEqual([...iterationRecord(PORTAL)]);
    expect([...files[1].iter]).toEqual([...iterationRecord(CELL)]);
    expect([...files[2].iter]).toEqual([...iterationRecord(LOCAL)]);
  });

  it('retail shape: ItersWithKeys, then an empty ItersWithoutKeys and m_dwFlags 0, nothing after', () => {
    // CLCache::OnServerInterrogation @ 004fa3e0 fills only m_ItersWithKeys.
    const r = parseRetail(msg);
    expect(r.withKeys.map((l) => [l.type, l.id, l.iterations])).toEqual([[0, 1, PORTAL], [1, 2, CELL], [1, 3, LOCAL]]);
    expect(r.withoutKeys).toEqual([]);
    expect(r.flags).toBe(0);
    expect(r.consumed).toBe(msg.length);
  });

  it('an unloaded DAT (0 iterations) is the empty set [0] and both parsers stay aligned', () => {
    const m = buildDDDInterrogationResponse(PORTAL, 0, LOCAL);
    const { lists, consumed } = parseAce(m);
    expect(consumed).toBe(m.length - 8);
    expect(parseRetail(m).consumed).toBe(m.length);
    expect(lists.map((l) => l.iterations)).toEqual([PORTAL, 0, LOCAL]);
    expect(lists[1].ints).toEqual([]);
  });
});

const HAVE_DATS = existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.cell) && existsSync(DAT_PATHS.local);

describe.skipIf(!HAVE_DATS)('DDD_InterrogationResponse vs the real EoL DATs (what GDLE compares against)', () => {
  let dats: Array<{ subset: number; set: number; total: number; iterFile: Uint8Array }> = [];
  beforeAll(() => {
    dats = [DAT_PATHS.portal, DAT_PATHS.cell, DAT_PATHS.local].map((p) => {
      const db = openDat(p);
      const data = db.getFileData(0xffff0001);
      if (!data) throw new Error(`no iteration file in ${p}`);
      return { subset: db.dataSubset, set: db.dataSet, total: db.totalIterations, iterFile: new Uint8Array(data) };
    });
  });

  it('each list carries its DAT header (DataSubset, DataSet) tag and the DAT\'s raw 0xFFFF0001 bytes', () => {
    const msg = buildDDDInterrogationResponse(dats[0].total, dats[1].total, dats[2].total);
    const files = parseGdle(msg);
    for (let i = 0; i < 3; i++) {
      expect([files[i].ds, files[i].dss]).toEqual([dats[i].subset, dats[i].set]);
      // TurbineData::CompareIteration: memcmp(data, iterFile, iterFile length).
      expect(dats[i].iterFile.length).toBe(12);
      expect([...files[i].iter]).toEqual([...dats[i].iterFile]);
    }
  });
});

// ── 3. AutonomousPosition physics stamps ───────────────────────────────────

describe('MovementSync.adoptPhysicsTimestamps (GDLE "Bad instance." check)', () => {
  const IDLE: MovementState = {
    forward: false, backward: false, turnLeft: false, turnRight: false,
    strafeLeft: false, strafeRight: false, running: true,
  };
  const POS: PlayerPosition = {
    worldX: 0x87 * 192 + 12.3, worldZ: 0x03 * 192 - 28.482, groundY: 0, playerYaw: 0,
    landblock: 0x870301ad, localX: 0, localY: 0, localZ: 0, inDungeon: true, onGround: true,
  };

  function autonomous(sync: MovementSync, sent: Uint8Array[]) {
    sent.length = 0;
    sync.sendPositionNow(IDLE, POS);
    return parseAutonomousPositionPayload(sent[1].subarray(12));
  }

  it('our own CreateObject PhysicsDesc stamps go out on the next AutonomousPosition', () => {
    const sent: Uint8Array[] = [];
    let seq = 0;
    const sync = new MovementSync({ sendMessage: (b: Uint8Array) => sent.push(b) } as never, () => ++seq);
    const before = autonomous(sync, sent);
    expect(before.instanceSequence).toBe(0); // what GDLE rejected

    const ts = new Array(9).fill(0);
    ts[PhysicsTimestamp.Instance] = 3;
    ts[PhysicsTimestamp.Teleport] = 7;
    ts[PhysicsTimestamp.ServerControlledMove] = 5;
    ts[PhysicsTimestamp.ForcePosition] = 2;
    ts[PhysicsTimestamp.Position] = 99; // not echoed: the client owns its position sequence
    sync.adoptPhysicsTimestamps(ts);
    const after = autonomous(sync, sent);
    expect(after.instanceSequence).toBe(3);
    expect(after.teleportSequence).toBe(7);
    expect(after.serverControlSequence).toBe(5);
    expect(after.forcePositionSequence).toBe(2);
  });

  it('a create without timestamps leaves the sequences alone', () => {
    const sent: Uint8Array[] = [];
    const sync = new MovementSync({ sendMessage: (b: Uint8Array) => sent.push(b) } as never, () => 1);
    sync.instanceSequence = 4;
    sync.adoptPhysicsTimestamps(undefined);
    sync.adoptPhysicsTimestamps([1, 2, 3]);
    expect(autonomous(sync, sent).instanceSequence).toBe(4);
  });
});

// ── 4. Fragment gate baseline ───────────────────────────────────────────────

describe('OrderedFragmentBuffer.adoptFirstSequence', () => {
  it('GDLE: a session whose first fragment is 2 delivers it at once', () => {
    const buf = new OrderedFragmentBuffer<string>();
    expect(buf.adoptFirstSequence(2)).toBe(true);
    expect(buf.submit(2, 'charlist').ready).toEqual(['charlist']);
    expect(buf.submit(3, 'servername').ready).toEqual(['servername']);
  });

  it('ACE: a first fragment of 0 (or 1, the swapped-first-pair shape) keeps the 0 start', () => {
    const a = new OrderedFragmentBuffer<string>();
    expect(a.adoptFirstSequence(0)).toBe(false);
    expect(a.submit(0, 'm0').ready).toEqual(['m0']);
    const b = new OrderedFragmentBuffer<string>();
    expect(b.adoptFirstSequence(1)).toBe(false);
    expect(b.submit(1, 'm1').verdict).toBe('buffered');
    expect(b.submit(0, 'm0').ready).toEqual(['m0', 'm1']);
  });

  it('applies once per session; reset() re-arms it', () => {
    const buf = new OrderedFragmentBuffer<string>();
    expect(buf.adoptFirstSequence(0)).toBe(false);
    expect(buf.adoptFirstSequence(5)).toBe(false); // a later packet can't move the gate
    buf.reset();
    expect(buf.adoptFirstSequence(5)).toBe(true);
    expect(buf.lastSequence).toBe(4);
  });
});

describe('ClientConnection: first fragment-bearing packet sets the gate', () => {
  const OPCODE = 0xdead;
  function packet(pktSeq: number, frags: Array<[number, number]>): Uint8Array {
    const body = frags.map(([fragSeq, tag]) => {
      const f = new Uint8Array(16 + 8);
      const v = new DataView(f.buffer);
      v.setUint32(0, fragSeq, true); v.setUint32(4, 0, true);
      v.setUint16(8, 1, true); v.setUint16(10, f.length, true);
      v.setUint16(12, 0, true); v.setUint16(14, GameMessageGroup.UIQueue, true);
      v.setUint32(16, OPCODE, true); v.setUint32(20, tag, true);
      return f;
    });
    const size = body.reduce((s, f) => s + f.length, 0);
    const p = new Uint8Array(20 + size);
    const v = new DataView(p.buffer);
    v.setUint32(0, pktSeq, true); v.setUint32(4, 0x4, true); v.setUint16(16, size, true);
    let o = 20;
    for (const f of body) { p.set(f, o); o += f.length; }
    return p;
  }
  function connection(): { conn: ClientConnection; tags: number[] } {
    const conn = new ClientConnection('ws://unit-test-not-connected');
    (conn as unknown as { ws: unknown }).ws = { readyState: 1, send: () => {}, close: () => {} };
    const tags: number[] = [];
    conn.on((e: ConnectionEvent) => {
      if (e.type !== 'message') return;
      const m = e.data as { type: string; opcode: number; payload: Uint8Array };
      if (m.type === 'direct' && m.opcode === OPCODE) tags.push(new DataView(m.payload.buffer, m.payload.byteOffset).getUint32(0, true));
    });
    return { conn, tags };
  }
  const handle = (c: ClientConnection, p: Uint8Array) => (c as unknown as { handlePacket(p: Uint8Array): void }).handlePacket(p);

  it("GDLE's first bundle (fragments 2, 3, 4 in one packet) dispatches immediately, then 5", () => {
    const { conn, tags } = connection();
    handle(conn, packet(2, [[2, 100], [3, 200], [4, 300]]));
    expect(tags).toEqual([100, 200, 300]);
    handle(conn, packet(3, [[5, 400]]));
    expect(tags).toEqual([100, 200, 300, 400]);
  });

  it('a session starting at 0 is unchanged', () => {
    const { conn, tags } = connection();
    handle(conn, packet(2, [[0, 1], [1, 2]]));
    handle(conn, packet(3, [[3, 4]]));
    expect(tags).toEqual([1, 2]); // 3 still waits for 2
    handle(conn, packet(4, [[2, 3]]));
    expect(tags).toEqual([1, 2, 3, 4]);
  });
});
