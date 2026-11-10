/**
 * BUG.dreamweave-per-ip-enter (was BUG.duplicate-enter-world, 2026-11-07): one enter sends exactly one
 * CharacterEnterWorld (0xF657) on ACE, and a 0x0D refusal is answered by
 * one 0xF657 per retry, never two and never none.
 *
 * Prod: DreamWeave (ACE) refused new characters' first enter with
 * CharacterError 0x0D (EnterGameCharacterInWorld) 64-430 ms after the request.
 * The suspicion was a second 0xF657 from this client (stock ACE sends 0x0D
 * only when that guid is online, CharacterHandler.cs:230). It is not: every
 * DreamWeave 0x0D since 2026-11-02 came while ANOTHER webAC session was in
 * DreamWeave's world, and no two webAC characters were ever in it at once.
 * DreamWeave (modified ACE) lets one character in per source address, and
 * every webAC player reaches it from the bridge's one address. The fix is the
 * bridge's per-session egress (BRIDGE_EGRESS_SERVERS), not the client.
 *
 * Pinned here against the real ClientConnection with ACE's own byte shapes,
 * so a future duplicate (or a lost send) fails:
 *  - chargen OK → 0xF7C8 → ServerReady 0xF7DF → one 0xF657 → PlayerCreate;
 *  - ACE resending the ServerReady packet (a retransmit keeps its sequence,
 *    NetworkSession.cs Retransmit) does not make a second 0xF657;
 *  - an ACE whose rule refuses while another session holds a character
 *    (the DreamWeave shape): each 0x0D retry is one 0xF657 (the repeat
 *    0xF7C8 is answered locally once granted), the enter gets in once the
 *    holder leaves, and nothing goes out from the world;
 *  - stock ACE drops a second 0xF657 at receipt once the first moved the
 *    session to WorldConnected (InboundMessageManager.cs:94), so a duplicate
 *    could never have caused a 0x0D there anyway (modelled, asserted silent).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CharacterError } from '@ac/shared';
import {
  ClientConnection, type ConnectionEvent, SessionState,
  PacketHeaderFlags, type PacketHeaderData,
  PACKET_HEADER_SIZE, FRAGMENT_HEADER_SIZE,
  writePacketHeader, fragmentMessage, writeFragment,
  GameMessageGroup, buildCharacterEnterWorldRequest, buildCharacterEnterWorld,
} from '../packages/network/src/index.js';
import {
  SessionLifecycle,
} from '../packages/renderer/src/session/SessionLifecycle.js';
import { IN_WORLD_RETRY_BUDGET, IN_WORLD_RETRY_DELAY_MS, JUST_CREATED_RETRY_DELAYS_MS } from '../packages/renderer/src/session/RetryPolicy.js';

const GUID = 0x50000def;
const F7C8 = 0xF7C8;
const F657 = 0xF657;

function u32msg(...words: number[]): Uint8Array {
  const b = new Uint8Array(words.length * 4);
  const v = new DataView(b.buffer);
  words.forEach((w, i) => v.setUint32(i * 4, w >>> 0, true));
  return b;
}

/** One server packet carrying `msg` as a single fragment, at packet + fragment sequence `seq`. */
function packetFor(msg: Uint8Array, seq: number): Uint8Array {
  const [frag] = fragmentMessage(msg, seq, GameMessageGroup.UIQueue, seq);
  const payload = new Uint8Array(FRAGMENT_HEADER_SIZE + frag.data.length);
  writeFragment(frag, payload, 0);
  const buf = new Uint8Array(PACKET_HEADER_SIZE + payload.length);
  const header: PacketHeaderData = { sequence: seq, flags: PacketHeaderFlags.BlobFragments, checksum: 0, id: 0x42, time: 0, size: payload.length, iteration: 1 };
  writePacketHeader(header, buf, 0);
  buf.set(payload, PACKET_HEADER_SIZE);
  return buf;
}

/** CharacterCreateResponse OK (0xF643): u32 1, guid, String16L name padded to 4. */
function createOk(guid: number, name: string): Uint8Array {
  const nameLen = 2 + name.length;
  const padded = nameLen + ((4 - (nameLen % 4)) % 4);
  const b = new Uint8Array(12 + padded);
  const v = new DataView(b.buffer);
  v.setUint32(0, 0xF643, true);
  v.setUint32(4, 1, true);
  v.setUint32(8, guid, true);
  v.setUint16(12, name.length, true);
  for (let i = 0; i < name.length; i++) b[14 + i] = name.charCodeAt(i);
  return b;
}

/**
 * A real ClientConnection past the handshake wired the way main.ts wires it
 * (characterCreateResponse → enter request; enterWorldReady → 0xF657; 0x0D →
 * SessionLifecycle verdict and a delayed 0xF7C8 retry), talking to an ACE
 * model: 0xF7C8 → 0xF7DF while AuthConnected; 0xF657 while AuthConnected →
 * WorldConnected + PlayerCreate, or 0x0D while `held()` says another session
 * holds a character (the DreamWeave per-address rule). A 0xF657 that arrives
 * once WorldConnected is dropped, as ACE's receive-time state check does.
 */
function aceSession(opts: { held?: () => boolean } = {}) {
  const conn = new ClientConnection('ws://test-not-connected');
  const internals = conn as unknown as {
    connectionData: { state: SessionState; cryptoClient: unknown };
    sendFragmentPacket(frags: Array<{ data: Uint8Array }>): void;
    handlePacket(p: Uint8Array): void;
  };
  internals.connectionData.state = SessionState.AuthConnected;
  internals.connectionData.cryptoClient = {};
  const wire: number[] = [];
  const life = new SessionLifecycle();
  const verdicts: string[] = [];
  let worldConnected = false;
  let entered = 0;
  let droppedAtServer = 0;
  let seq = 2;
  const sentPackets: Uint8Array[] = [];
  const serverSends = (msg: Uint8Array) => {
    const p = packetFor(msg, seq++);
    sentPackets.push(p);
    internals.handlePacket(p);
  };
  const serverHandle = (opcode: number) => {
    if (opcode === F7C8 && !worldConnected) serverSends(u32msg(0xF7DF));
    if (opcode === F657) {
      if (worldConnected) { droppedAtServer++; return; }
      if (opts.held?.()) { serverSends(u32msg(0xF659, CharacterError.EnterGameCharacterInWorld)); return; }
      worldConnected = true;
      serverSends(u32msg(0xF746, GUID)); // PlayerCreate
    }
  };
  internals.sendFragmentPacket = (frags) => {
    const d = frags[0].data;
    const opcode = new DataView(d.buffer, d.byteOffset).getUint32(0, true);
    wire.push(opcode);
    queueMicrotask(() => serverHandle(opcode));
  };
  const sendEnterRequest = () => {
    life.noteEnterRequestSent();
    conn.sendMessage(buildCharacterEnterWorldRequest(), GameMessageGroup.UIQueue);
  };
  conn.on((e: ConnectionEvent) => {
    if (e.type === 'characterCreateResponse') {
      life.noteEnterWorldRequested(GUID);
      life.noteCharacterCreated(GUID);
      sendEnterRequest();
    } else if (e.type === 'enterWorldReady') {
      conn.sendMessage(buildCharacterEnterWorld(GUID, 'acct'), GameMessageGroup.UIQueue);
    } else if (e.type === 'playerCreate') {
      entered++;
      life.noteWorldEntered();
    } else if (e.type === 'error' && e.characterError === CharacterError.EnterGameCharacterInWorld) {
      const v = life.characterInWorldRefusal();
      verdicts.push(v);
      if (v === 'retry') {
        setTimeout(() => { if (life.mayRetryEnterWorld()) sendEnterRequest(); }, life.inWorldRetryDelay());
      } else if (v === 'dialog') {
        life.noteEnterRefused();
      }
    }
  });
  const createCharacter = async () => {
    conn.sendMessage(u32msg(0xF656), GameMessageGroup.UIQueue); // CharacterCreate outstanding
    wire.length = 0;
    serverSends(createOk(GUID, 'Newbie'));
    await vi.advanceTimersByTimeAsync(0);
  };
  const enterFromCharSelect = async () => {
    life.noteEnterWorldRequested(GUID);
    sendEnterRequest();
    await vi.advanceTimersByTimeAsync(0);
  };
  /** ACE resends a packet the client NAK'd (or that it thinks was lost) with its ORIGINAL sequence. */
  const serverRetransmits = (index: number) => internals.handlePacket(sentPackets[index]);
  return {
    conn, wire, life, verdicts, createCharacter, enterFromCharSelect, serverRetransmits, sentPackets,
    entered: () => entered, droppedAtServer: () => droppedAtServer,
    advance: (ms: number) => vi.advanceTimersByTimeAsync(ms),
  };
}

const f657s = (wire: number[]) => wire.filter((o) => o === F657).length;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ACE: one enter, one 0xF657', () => {
  it('chargen OK → 0xF7C8 → ServerReady → exactly one 0xF657 → in the world', async () => {
    const s = aceSession();
    await s.createCharacter();
    expect(s.wire).toEqual([F7C8, F657]);
    expect(s.entered()).toBe(1);
    expect(s.droppedAtServer()).toBe(0);
    await s.advance(60_000);
    expect(s.wire).toEqual([F7C8, F657]);
  });

  it('character select → exactly one 0xF657', async () => {
    const s = aceSession();
    await s.enterFromCharSelect();
    expect(s.wire).toEqual([F7C8, F657]);
    expect(s.entered()).toBe(1);
  });

  it('a retransmitted ServerReady packet (same sequence) does not send a second 0xF657', async () => {
    const s = aceSession({ held: () => true }); // keep the session out of the world so only the wire is seen
    await s.enterFromCharSelect();
    expect(f657s(s.wire)).toBe(1);
    // sentPackets[0] = ServerReady; ACE's Retransmit keeps the packet's sequence.
    s.serverRetransmits(0);
    s.serverRetransmits(0);
    await s.advance(0);
    expect(f657s(s.wire)).toBe(1);
  });
});

describe('ACE whose rule refuses a second character per address (the DreamWeave shape)', () => {
  it('each 0x0D retry sends one 0xF657, and the enter gets in once the holder leaves', async () => {
    let held = true;
    const s = aceSession({ held: () => held });
    await s.createCharacter();
    expect(s.wire).toEqual([F7C8, F657]);
    expect(s.verdicts).toEqual(['retry']);
    // Two quick retries while still held: one 0xF657 each, no new 0xF7C8 (granted already).
    await s.advance(JUST_CREATED_RETRY_DELAYS_MS[0] + 10);
    await s.advance(JUST_CREATED_RETRY_DELAYS_MS[1] + 10);
    expect(s.wire).toEqual([F7C8, F657, F657, F657]);
    held = false; // the other webAC player left the world
    await s.advance(JUST_CREATED_RETRY_DELAYS_MS[2] + 10);
    expect(s.entered()).toBe(1);
    expect(s.wire).toEqual([F7C8, F657, F657, F657, F657]);
    expect(s.droppedAtServer()).toBe(0);
    await s.advance(120_000);
    expect(s.wire.length).toBe(5);
  });

  it('a holder that never leaves ends at the budget: one 0xF657 per refusal, then nothing', async () => {
    const s = aceSession({ held: () => true });
    await s.createCharacter();
    await s.advance(IN_WORLD_RETRY_BUDGET * IN_WORLD_RETRY_DELAY_MS + 10_000);
    expect(s.verdicts.filter((v) => v === 'retry').length).toBe(IN_WORLD_RETRY_BUDGET);
    expect(s.verdicts[s.verdicts.length - 1]).toBe('dialog');
    expect(f657s(s.wire)).toBe(IN_WORLD_RETRY_BUDGET + 1);
    expect(s.wire.filter((o) => o === F7C8).length).toBe(1);
    const sent = s.wire.length;
    await s.advance(60_000);
    expect(s.wire.length).toBe(sent);
  });
});
