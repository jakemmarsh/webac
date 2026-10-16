/**
 * A brand-new character enters the world on GDLE servers (2026-10-16).
 *
 * GDLE (Seedsow, Snowreap) answers 0xF657 with CharacterError 0x0D while the
 * new character's first save is still queued (ClientEvents.cpp
 * CClientEvents::LoginCharacter: GetNumPendingSaves > 0), a few ms after the
 * create reply. Retail enters at once (gmCharGenMainUI::Update @ 004e8460 →
 * CPlayerSystem::LogOnCharacter @ 0055f890), so a client ~15 ms from the
 * server lost the race every time. We already retried 0x0D, but by resending
 * 0xF7C8, which GDLE ignores once it has answered one (Client.cpp
 * `case 0xF7C8: if (!m_vars.bInWorld)`; bInWorld is cleared only by
 * ExitWorld, which sends 0xF653): the retry waited forever.
 *
 * The fix, pinned here against the real ClientConnection + SessionLifecycle:
 *  - after ServerReady, a repeat 0xF7C8 is answered locally as ready, so the
 *    retry goes straight to 0xF657 (as Connection1999 already did);
 *  - CharacterLogOff (0xF653) and a new connection clear that;
 *  - a character created in this session moments ago retries after
 *    500 ms / 1 s / 2 s / 2 s, then the usual 3 s cadence and budget;
 *  - a normal login's 0x0D keeps today's 3 s retries and dialog.
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
  SessionLifecycle, IN_WORLD_RETRY_DELAY_MS, IN_WORLD_RETRY_BUDGET,
  JUST_CREATED_RETRY_DELAYS_MS, JUST_CREATED_WINDOW_MS,
} from '../packages/renderer/src/session/SessionLifecycle.js';

const GUID = 0x50000abc;

function u32msg(...words: number[]): Uint8Array {
  const b = new Uint8Array(words.length * 4);
  const v = new DataView(b.buffer);
  words.forEach((w, i) => v.setUint32(i * 4, w >>> 0, true));
  return b;
}

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

/** CharacterCreateResponse OK: u32 1, guid, String16L name (padded to 4). */
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

/** A real ClientConnection past the handshake, with the wire captured as opcodes. */
function harness() {
  const conn = new ClientConnection('ws://test-not-connected');
  const internals = conn as unknown as {
    connectionData: { state: SessionState; cryptoClient: unknown };
    sendFragmentPacket(frags: Array<{ data: Uint8Array }>): void;
    handlePacket(p: Uint8Array): void;
  };
  internals.connectionData.state = SessionState.AuthConnected;
  internals.connectionData.cryptoClient = {};
  const wire: number[] = [];
  const net: { onWire?: (opcode: number) => void } = {};
  internals.sendFragmentPacket = (frags) => {
    const d = frags[0].data;
    const opcode = new DataView(d.buffer, d.byteOffset).getUint32(0, true);
    wire.push(opcode);
    // The server answers after the send returns (a network hop), never inside it.
    if (net.onWire) queueMicrotask(() => net.onWire?.(opcode));
  };
  const events: ConnectionEvent[] = [];
  conn.on((e) => events.push(e));
  let seq = 2;
  const serverSends = (msg: Uint8Array) => internals.handlePacket(packetFor(msg, seq++));
  const count = (type: string) => events.filter((e) => e.type === type).length;
  return { conn, wire, events, serverSends, count, net };
}

/**
 * A GDLE server model (Client.cpp / ClientEvents.cpp) driving main.ts's
 * wiring: CharacterCreateResponse → noteEnterWorldRequested +
 * noteCharacterCreated + 0xF7C8; enterWorldReady → 0xF657; CharacterError
 * 0x0D → characterInWorldRefusal / inWorldRetryDelay → resend 0xF7C8.
 */
function gdleSession(opts: { pendingSaveRefusals: number; created: boolean }) {
  const h = harness();
  const life = new SessionLifecycle();
  let bInWorld = false;
  let refusalsLeft = opts.pendingSaveRefusals;
  const delays: number[] = [];
  const verdicts: string[] = [];
  let entered = false;
  const serverHandle = (opcode: number) => {
    if (opcode === 0xF7C8 && !bInWorld) { bInWorld = true; h.serverSends(u32msg(0xF7DF)); }
    if (opcode === 0xF657 && bInWorld) {
      if (refusalsLeft > 0) { refusalsLeft--; h.serverSends(u32msg(0xF659, CharacterError.EnterGameCharacterInWorld)); }
      else h.serverSends(u32msg(0xF746, GUID)); // PlayerCreate
    }
  };
  h.net.onWire = serverHandle;
  h.conn.on((e) => {
    if (e.type === 'characterCreateResponse') {
      life.noteEnterWorldRequested(GUID);
      life.noteCharacterCreated(GUID);
      h.conn.sendMessage(buildCharacterEnterWorldRequest(), GameMessageGroup.UIQueue);
    } else if (e.type === 'enterWorldReady') {
      h.conn.sendMessage(buildCharacterEnterWorld(GUID, 'acct'), GameMessageGroup.UIQueue);
    } else if (e.type === 'playerCreate') {
      entered = true;
      life.noteWorldEntered();
    } else if (e.type === 'error' && e.characterError === CharacterError.EnterGameCharacterInWorld) {
      const v = life.characterInWorldRefusal();
      verdicts.push(v);
      if (v === 'retry') {
        const d = life.inWorldRetryDelay();
        delays.push(d);
        setTimeout(() => {
          if (life.mayRetryEnterWorld()) { h.conn.sendMessage(buildCharacterEnterWorldRequest(), GameMessageGroup.UIQueue); }
        }, d);
      } else if (v === 'dialog') {
        life.noteEnterRefused();
      }
    }
  });
  const start = async () => {
    if (opts.created) {
      h.conn.sendMessage(u32msg(0xF656), GameMessageGroup.UIQueue); // CharacterCreate outstanding
      h.wire.length = 0;
      h.serverSends(createOk(GUID, 'Newbie'));
    } else {
      life.noteEnterWorldRequested(GUID);
      h.conn.sendMessage(buildCharacterEnterWorldRequest(), GameMessageGroup.UIQueue);
    }
    await vi.advanceTimersByTimeAsync(0);
  };
  const advance = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); };
  return { ...h, life, start, advance, delays, verdicts, isEntered: () => entered };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ClientConnection: a repeat enter-world request after ServerReady (GDLE ignores it)', () => {
  it('the first 0xF7C8 goes to the wire; ServerReady emits enterWorldReady', () => {
    const h = harness();
    h.conn.sendMessage(buildCharacterEnterWorldRequest(), GameMessageGroup.UIQueue);
    expect(h.wire).toEqual([0xF7C8]);
    h.serverSends(u32msg(0xF7DF));
    expect(h.count('enterWorldReady')).toBe(1);
  });

  it('after ServerReady, a repeat 0xF7C8 stays off the wire and is answered as ready', async () => {
    const h = harness();
    h.conn.sendMessage(buildCharacterEnterWorldRequest(), GameMessageGroup.UIQueue);
    h.serverSends(u32msg(0xF7DF));
    h.serverSends(u32msg(0xF659, CharacterError.EnterGameCharacterInWorld));
    h.conn.sendMessage(buildCharacterEnterWorldRequest(), GameMessageGroup.UIQueue);
    expect(h.wire).toEqual([0xF7C8]);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.count('enterWorldReady')).toBe(2);
  });

  it('CharacterLogOff (0xF653, GDLE ExitWorld / ACE logoff) makes the next enter ask the server again', () => {
    const h = harness();
    h.conn.sendMessage(buildCharacterEnterWorldRequest(), GameMessageGroup.UIQueue);
    h.serverSends(u32msg(0xF7DF));
    h.serverSends(u32msg(0xF653));
    h.conn.sendMessage(buildCharacterEnterWorldRequest(), GameMessageGroup.UIQueue);
    expect(h.wire).toEqual([0xF7C8, 0xF7C8]);
  });

  it('a new connection forgets the grant', () => {
    const h = harness();
    h.serverSends(u32msg(0xF7DF));
    (h.conn as unknown as { enterWorldGranted: boolean }).enterWorldGranted = true;
    // doConnect resets per-connection state; WebSocket is absent under node, so stub it for the reset only.
    const WS = (globalThis as { WebSocket?: unknown }).WebSocket;
    (globalThis as { WebSocket?: unknown }).WebSocket = class { binaryType = ''; close() {} } as unknown;
    try { h.conn.connect('acct', 'pw'); } finally { (globalThis as { WebSocket?: unknown }).WebSocket = WS; }
    expect((h.conn as unknown as { enterWorldGranted: boolean }).enterWorldGranted).toBe(false);
  });
});

describe('SessionLifecycle: quick retries only for the character just created', () => {
  it('created moments ago: 500 ms, 1 s, 2 s, 2 s, then the usual 3 s', () => {
    const s = new SessionLifecycle();
    s.noteEnterWorldRequested(GUID);
    s.noteCharacterCreated(GUID, 1000);
    const got: number[] = [];
    for (let i = 0; i < 6; i++) {
      expect(s.characterInWorldRefusal()).toBe('retry');
      got.push(s.inWorldRetryDelay(1000 + 100 * i));
    }
    expect(got).toEqual([...JUST_CREATED_RETRY_DELAYS_MS, IN_WORLD_RETRY_DELAY_MS, IN_WORLD_RETRY_DELAY_MS]);
  });

  it('a refusal later than the window gets the usual wait', () => {
    const s = new SessionLifecycle();
    s.noteEnterWorldRequested(GUID);
    s.noteCharacterCreated(GUID, 0);
    s.characterInWorldRefusal();
    expect(s.inWorldRetryDelay(JUST_CREATED_WINDOW_MS + 1)).toBe(IN_WORLD_RETRY_DELAY_MS);
  });

  it('a normal login (no character created) keeps the 3 s wait', () => {
    const s = new SessionLifecycle();
    s.noteEnterWorldRequested(GUID);
    s.characterInWorldRefusal();
    expect(s.inWorldRetryDelay()).toBe(IN_WORLD_RETRY_DELAY_MS);
  });

  it('once that character has been in the world, or another one is chosen, the quick waits are gone', () => {
    const s = new SessionLifecycle();
    s.noteEnterWorldRequested(GUID);
    s.noteCharacterCreated(GUID);
    s.noteWorldEntered();
    s.noteLoggedOut();
    s.noteEnterWorldRequested(GUID);
    s.characterInWorldRefusal();
    expect(s.inWorldRetryDelay()).toBe(IN_WORLD_RETRY_DELAY_MS);

    const t = new SessionLifecycle();
    t.noteEnterWorldRequested(GUID);
    t.noteCharacterCreated(GUID);
    t.noteEnterRefused();
    t.noteEnterWorldRequested(GUID + 1);
    t.characterInWorldRefusal();
    expect(t.inWorldRetryDelay()).toBe(IN_WORLD_RETRY_DELAY_MS);
  });
});

describe('end to end against a GDLE server model: chargen OK, then 0x0D while the first save is queued', () => {
  it('the retry resends 0xF657 (not an ignored 0xF7C8) and the new character enters', async () => {
    const g = gdleSession({ pendingSaveRefusals: 2, created: true });
    await g.start();
    expect(g.wire).toEqual([0xF7C8, 0xF657]);
    expect(g.verdicts).toEqual(['retry']);
    expect(g.isEntered()).toBe(false);
    await g.advance(JUST_CREATED_RETRY_DELAYS_MS[0]);
    await g.advance(JUST_CREATED_RETRY_DELAYS_MS[1] + 10);
    expect(g.isEntered()).toBe(true);
    // One 0xF7C8 ever: each retry went straight to 0xF657.
    expect(g.wire).toEqual([0xF7C8, 0xF657, 0xF657, 0xF657]);
    expect(g.delays).toEqual([500, 1000]);
    // Nothing more goes out once in the world.
    await g.advance(60_000);
    expect(g.wire.length).toBe(4);
  });

  it('a refusal that never clears stops at the budget with the retail dialog', async () => {
    const g = gdleSession({ pendingSaveRefusals: Infinity, created: true });
    await g.start();
    await g.advance(IN_WORLD_RETRY_BUDGET * IN_WORLD_RETRY_DELAY_MS + 10_000);
    expect(g.verdicts.filter((v) => v === 'retry').length).toBe(IN_WORLD_RETRY_BUDGET);
    expect(g.verdicts[g.verdicts.length - 1]).toBe('dialog');
    expect(g.wire.filter((o) => o === 0xF657).length).toBe(IN_WORLD_RETRY_BUDGET + 1);
    const sent = g.wire.length;
    await g.advance(60_000);
    expect(g.wire.length).toBe(sent);
  });

  it('a normal login refused with 0x0D keeps today\'s 3 s cadence (now reaching GDLE via 0xF657)', async () => {
    const g = gdleSession({ pendingSaveRefusals: 1, created: false });
    await g.start();
    expect(g.wire).toEqual([0xF7C8, 0xF657]);
    await g.advance(IN_WORLD_RETRY_DELAY_MS - 1);
    expect(g.wire).toEqual([0xF7C8, 0xF657]);
    await g.advance(10);
    expect(g.isEntered()).toBe(true);
    expect(g.delays).toEqual([IN_WORLD_RETRY_DELAY_MS]);
  });
});
