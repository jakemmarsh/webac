/**
 * FAITHFUL.581 — Real handlers for opcodes FAITHFUL.580 had silenced.
 *
 * The prior fix (FAITHFUL.580) documented 4 unhandled GameMessage opcodes
 * but did not actually implement them. Per GOAL.md "100% parity",
 * documenting gaps is not the same as closing them. This fix:
 *
 *   1. Removes the silent-consume cases for Motion, PublicUpdatePosition,
 *      PublicUpdateVital, CharacterRestoreResponse.
 *   2. Discovers that `Motion` (0xF74C) is an alias for `MovementEvent`
 *      — same opcode, already handled via ServerObjectManager
 *      .handleMovementEvent for NPC animation streaming. No separate
 *      handler needed; the FAITHFUL.580 listing was redundant.
 *   3. Implements REAL parsers for the other three:
 *      - PublicUpdatePosition (0x02DC): u8 seq + u32 guid + u32 type +
 *        Position (u32 landblock + 3 f32 + 4 f32 quat). For Location
 *        type (1) drives `applyPublicLocationUpdate` to mirror the
 *        broadcast onto the ServerObject's worldX/Y/Z + mesh.
 *      - PublicUpdateVital (0x02E8): u8 seq + u32 guid + 5 u32 fields
 *        (attribute + ranks + base + totalInvestment + current). Drives
 *        `applyPublicVital` to update the ServerObject's healthCurrent/
 *        Max / staminaCurrent/Max / manaCurrent/Max so live vital bars
 *        update mid-combat instead of waiting for FellowshipFullUpdate
 *        bulk refreshes.
 *      - CharacterRestoreResponse (0xF643): u32 verifOk + u32 guid +
 *        String16L name + u32 secondsDisabled. Surfaces an admin-restored
 *        deleted character as a chat confirmation.
 *
 * Tests pin (a) the new handler-interface signatures, (b) the case
 * branches in the switch dispatch, (c) the ServerObject vital + position
 * mutator methods, (d) ACE source still defines each GameMessage class.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  GameMessageOpcode, ClientConnection, ConnectionEvent,
  PacketHeaderFlags, PacketHeaderData,
  PACKET_HEADER_SIZE, FRAGMENT_HEADER_SIZE,
  writePacketHeader, fragmentMessage, writeFragment,
  GameMessageGroup, SessionState,
  parseCharacterRestoreResponse, parseCharacterCreateResponse,
} from '@ac/network';

const REPO = resolve(__dirname, '..');
const HANDLER = readFileSync(
  resolve(REPO, 'packages/renderer/src/network/ServerMessageHandler.ts'),
  'utf8',
);
const SOM = readFileSync(
  resolve(REPO, 'packages/renderer/src/world/ServerObjectManager.ts'),
  'utf8',
);
const MAIN = readFileSync(
  resolve(REPO, 'packages/renderer/src/main.ts'),
  'utf8',
);
const CC = readFileSync(
  resolve(REPO, 'packages/network/src/ClientConnection.ts'),
  'utf8',
);

describe('FAITHFUL.581 — Motion is correctly identified as a MovementEvent alias', () => {
  it('Motion and MovementEvent have the same opcode value', () => {
    expect((GameMessageOpcode as unknown as Record<string, number>).Motion).toBe(0xF74C);
    expect((GameMessageOpcode as unknown as Record<string, number>).MovementEvent).toBe(0xF74C);
  });

  it('handler comment cites the alias relationship', () => {
    expect(HANDLER).toMatch(/Motion.*0xF74C.*ALIAS.*MovementEvent/i);
  });

  it('no separate `case GameMessageOpcode.Motion` branch (would be unreachable)', () => {
    // The earlier MovementEvent case matches first. A duplicate Motion
    // case would never fire.
    expect(HANDLER).not.toMatch(/case GameMessageOpcode\.Motion:/);
  });
});

describe('FAITHFUL.581 — PublicUpdatePosition (0x02DC)', () => {
  const ACE_PATH = resolve(
    REPO,
    'reference/ACE/Source/ACE.Server/Network/GameMessages/Messages/GameMessagePublicUpdatePosition.cs',
  );

  it('GameMessageOpcode.PublicUpdatePosition = 0x02DC', () => {
    expect((GameMessageOpcode as unknown as Record<string, number>).PublicUpdatePosition).toBe(0x02DC);
  });

  it('has an explicit case branch with the full parser inline', () => {
    expect(HANDLER).toMatch(/case GameMessageOpcode\.PublicUpdatePosition:[\s\S]+r\.readUInt8\(\)[\s\S]+r\.readFloat32\(\)[\s\S]+this\.handlers\.onPublicUpdatePosition\?\.\(/);
  });

  it('handler interface declares all wire fields', () => {
    expect(HANDLER).toMatch(/onPublicUpdatePosition\?:[\s\S]+sequence: number[\s\S]+guid: number[\s\S]+positionType: number[\s\S]+landblockId: number[\s\S]+x: number; y: number; z: number/);
  });

  it('ServerObjectManager has applyPublicLocationUpdate that writes mesh.position', () => {
    expect(SOM).toMatch(/applyPublicLocationUpdate\([\s\S]+landblock: number,[\s\S]+x: number, y: number, z: number,[\s\S]+qw: number/);
    expect(SOM).toMatch(/obj\.mesh\.position\.set\(wx, clampedY, wz\)/);
  });

  it('main.ts onPublicUpdatePosition routes Location (type=1) through applyPublicLocationUpdate', () => {
    expect(MAIN).toMatch(/POSTYPE_LOCATION\s*=\s*1[\s\S]+applyPublicLocationUpdate\(/);
  });

  it.skipIf(!existsSync(ACE_PATH))('ACE source still defines GameMessagePublicUpdatePosition with this exact wire shape', () => {
    const src = readFileSync(ACE_PATH, 'utf8');
    expect(src).toMatch(/class GameMessagePublicUpdatePosition\s*:\s*GameMessage/);
    expect(src).toMatch(/SequenceType\.UpdatePosition/);
    expect(src).toMatch(/\(uint\)positionType/);
    expect(src).toMatch(/pos\.Serialize\(Writer\)/);
  });
});

describe('FAITHFUL.581 — PublicUpdateVital (0x02E8)', () => {
  const ACE_PATH = resolve(
    REPO,
    'reference/ACE/Source/ACE.Server/Network/GameMessages/Messages/GameMessagePublicUpdateVital.cs',
  );

  it('GameMessageOpcode.PublicUpdateVital = 0x02E8', () => {
    expect((GameMessageOpcode as unknown as Record<string, number>).PublicUpdateVital).toBe(0x02E8);
  });

  it('has an explicit case branch with the 6-field parser', () => {
    expect(HANDLER).toMatch(/case GameMessageOpcode\.PublicUpdateVital:[\s\S]+const sequence = r\.readUInt8\(\)[\s\S]+const guid = r\.readUInt32\(\)[\s\S]+const attribute = r\.readUInt32\(\)[\s\S]+const ranks = r\.readUInt32\(\)[\s\S]+const baseValue = r\.readUInt32\(\)[\s\S]+const totalInvestment = r\.readUInt32\(\)[\s\S]+const currentValue = r\.readUInt32\(\)/);
  });

  it('handler interface declares all wire fields', () => {
    expect(HANDLER).toMatch(/onPublicUpdateVital\?:[\s\S]+attribute: number[\s\S]+ranks: number[\s\S]+baseValue: number[\s\S]+totalInvestment: number[\s\S]+currentValue: number/);
  });

  it('ServerObject interface has vital fields (FAITHFUL.581)', () => {
    expect(SOM).toMatch(/healthCurrent: number;\s*\n\s*healthMax: number;\s*\n\s*staminaCurrent: number;\s*\n\s*staminaMax: number;\s*\n\s*manaCurrent: number;\s*\n\s*manaMax: number;/);
  });

  it('ServerObjectManager has applyPublicVital that dispatches by attribute', () => {
    expect(SOM).toMatch(/applyPublicVital\(guid: number, attribute: number, current: number, max: number\)/);
    expect(SOM).toMatch(/if \(attribute === 1\)[\s\S]+obj\.healthCurrent = current/);
    expect(SOM).toMatch(/else if \(attribute === 3\)[\s\S]+obj\.staminaCurrent = current/);
    expect(SOM).toMatch(/else if \(attribute === 5\)[\s\S]+obj\.manaCurrent = current/);
  });

  it('main.ts onPublicUpdateVital routes through applyPublicVital with computed max', () => {
    expect(MAIN).toMatch(/onPublicUpdateVital:[\s\S]+const max = data\.baseValue \+ \(data\.totalInvestment > 0[\s\S]+applyPublicVital\(\s*data\.guid, data\.attribute, data\.currentValue, max,\s*\)/);
  });

  it.skipIf(!existsSync(ACE_PATH))('ACE source still defines GameMessagePublicUpdateVital with the 6-field constructor', () => {
    const src = readFileSync(ACE_PATH, 'utf8');
    expect(src).toMatch(/class GameMessagePublicUpdateVital\s*:\s*GameMessage/);
    expect(src).toMatch(/PropertyAttribute2nd attribute,\s*uint ranks,\s*uint baseValue,\s*uint totalInvestment,\s*uint currentValue/);
  });
});

// BUG.character-restore-response-shadowed-dead-code — CharacterRestoreResponse
// aliases the same wire opcode (0xF643) as CharacterCreateResponse
// (GameMessageOpcode.ts). A plain switch always matches whichever case
// appears first for an aliased value, so ServerMessageHandler.ts's old
// CharacterRestoreResponse case (after the earlier CharacterCreateResponse
// no-op) was unreachable dead code — every 0xF643 message got treated as a
// character-create response, including real admin-restore notices, which
// made main.ts auto-enter-world with the restored character's GUID.
//
// The fix moved disambiguation into ClientConnection.ts, the actual dispatch
// point, using client-side context it already has: whether a CharacterCreate
// request is outstanding (set in sendMessage, cleared on the aliased
// response). These tests drive real server packet bytes through the real
// ClientConnection (handshake included) and assert the emitted event type +
// parsed fields — not a source-text pin on either handler file.
describe('FAITHFUL.581 / BUG.character-restore-response-shadowed-dead-code — CharacterCreateResponse/CharacterRestoreResponse opcode-alias disambiguation (0xF643)', () => {
  const ACE_PATH = resolve(
    REPO,
    'reference/ACE/Source/ACE.Server/Network/GameMessages/Messages/GameMessageCharacterRestore.cs',
  );

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

  it('GameMessageOpcode.CharacterRestoreResponse = CharacterCreateResponse = 0xF643 (still aliased per ACE)', () => {
    expect((GameMessageOpcode as unknown as Record<string, number>).CharacterRestoreResponse).toBe(0xF643);
    expect((GameMessageOpcode as unknown as Record<string, number>).CharacterCreateResponse).toBe(0xF643);
  });

  function buildServerPacket(seq: number, flags: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
    const buf = new Uint8Array(PACKET_HEADER_SIZE + payload.length);
    const header: PacketHeaderData = {
      sequence: seq, flags, checksum: 0, id: 0x42, time: 0,
      size: payload.length, iteration: 1,
    };
    writePacketHeader(header, buf, 0);
    buf.set(payload, PACKET_HEADER_SIZE);
    return buf;
  }

  // fragSeq defaults to 0 (the first fragment a fresh post-handshake
  // ClientConnection's ordering gate expects — BUG.fragment-sequence-not-
  // reordered); callers sending a second message in the same harness pass 1.
  function buildMessagePacket(seq: number, msg: Uint8Array, fragSeq: number = 0): Uint8Array {
    const [frag] = fragmentMessage(msg, seq, GameMessageGroup.WeenieQueue, fragSeq);
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

  /** ACE WriteString16L: u16 length + bytes, padded to a 4-byte boundary. */
  function encodeString16L(name: string): Uint8Array {
    const nameBytes = new TextEncoder().encode(name);
    const total = 2 + nameBytes.length;
    const pad = (4 - (total % 4)) % 4;
    const buf = new Uint8Array(total + pad);
    new DataView(buf.buffer).setUint16(0, nameBytes.length, true);
    buf.set(nameBytes, 2);
    return buf;
  }

  function concatBytes(parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  }

  function u32(n: number): Uint8Array {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n >>> 0, true);
    return b;
  }

  /** GameMessageCharacterRestore.cs shape: verificationOk + objectGuid + String16L name + secondsDisabled. */
  function buildRestorePayload(verificationOk: boolean, objectGuid: number, name: string, secondsDisabled: number): Uint8Array {
    return concatBytes([
      u32(GameMessageOpcode.CharacterCreateResponse),
      u32(verificationOk ? 1 : 0),
      u32(objectGuid),
      encodeString16L(name),
      u32(secondsDisabled),
    ]);
  }

  /** CharacterCreateResponse success shape: responseCode=1 + characterGuid + String16L characterName. */
  function buildCreateSuccessPayload(characterGuid: number, characterName: string): Uint8Array {
    return concatBytes([
      u32(GameMessageOpcode.CharacterCreateResponse),
      u32(1),
      u32(characterGuid),
      encodeString16L(characterName),
    ]);
  }

  interface Harness { conn: ClientConnection; events: ConnectionEvent[]; sent: Uint8Array[]; }

  function makeHarness(): Harness {
    const conn = new ClientConnection('ws://test-not-connected');
    const events: ConnectionEvent[] = [];
    const sent: Uint8Array[] = [];
    conn.on(e => events.push(e));
    (conn as any).ws = {
      readyState: 1,
      send: (b: ArrayBuffer | Uint8Array) => sent.push(new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b))),
      close: () => {},
    };
    return { conn, events, sent };
  }

  function feed(h: Harness, pkt: Uint8Array): void {
    (h.conn as any).handlePacket(pkt);
  }

  function handshake(h: Harness): void {
    feed(h, buildConnectRequest());
    expect(h.conn.state).toBe(SessionState.AuthConnected);
  }

  it('an unsolicited 0xF643 (no outstanding CharacterCreate request) is dispatched as characterRestoreResponse, not characterCreateResponse', () => {
    const h = makeHarness();
    handshake(h);

    feed(h, buildMessagePacket(2, buildRestorePayload(true, 0x50012345, 'Restored Toon', 45)));

    const restoreEvents = h.events.filter(e => e.type === 'characterRestoreResponse');
    const createEvents = h.events.filter(e => e.type === 'characterCreateResponse');
    expect(createEvents.length).toBe(0);
    expect(restoreEvents.length).toBe(1);
    expect(restoreEvents[0].data).toEqual({
      responseCode: 1, verificationOk: true, objectGuid: 0x50012345, name: 'Restored Toon', secondsDisabled: 45,
    });

    h.conn.disconnect();
  });

  it('a 0xF643 arriving right after we sent CharacterCreate is dispatched as characterCreateResponse', () => {
    const h = makeHarness();
    handshake(h);

    const createMsg = new Uint8Array(4);
    new DataView(createMsg.buffer).setUint32(0, GameMessageOpcode.CharacterCreate, true);
    h.conn.sendMessage(createMsg);

    feed(h, buildMessagePacket(2, buildCreateSuccessPayload(0x50099999, 'Newbie')));

    const restoreEvents = h.events.filter(e => e.type === 'characterRestoreResponse');
    const createEvents = h.events.filter(e => e.type === 'characterCreateResponse');
    expect(restoreEvents.length).toBe(0);
    expect(createEvents.length).toBe(1);
    expect(createEvents[0].data).toEqual({
      responseCode: 1, characterGuid: 0x50099999, characterName: 'Newbie',
    });

    // The awaiting-flag is consumed by that one response — a later unsolicited
    // 0xF643 in the same session (e.g. an admin restore mid-play) must not be
    // misread as a second create response.
    feed(h, buildMessagePacket(3, buildRestorePayload(true, 0x50011111, 'Later Restore', 0), 1));
    expect(h.events.filter(e => e.type === 'characterCreateResponse').length).toBe(1);
    expect(h.events.filter(e => e.type === 'characterRestoreResponse').length).toBe(1);

    h.conn.disconnect();
  });

  it('parseCharacterRestoreResponse round-trips the ACE-documented wire shape directly', () => {
    const payload = buildRestorePayload(true, 0x50000042, 'Restored', 7).slice(4); // strip opcode prefix
    expect(parseCharacterRestoreResponse(payload)).toEqual({
      responseCode: 1, verificationOk: true, objectGuid: 0x50000042, name: 'Restored', secondsDisabled: 7,
    });
  });

  it('a refused restore is the code alone (ACE NameInUse / Corrupt): parsed, never thrown, and not OK', () => {
    // CharacterHandler.cs CharacterRestore → SendCharacterCreateResponse(NameInUse = 3 / Corrupt = 5).
    expect(parseCharacterRestoreResponse(u32(3))).toEqual({
      responseCode: 3, verificationOk: false, objectGuid: 0, name: '', secondsDisabled: 0,
    });
    expect(parseCharacterRestoreResponse(u32(5)).verificationOk).toBe(false);
    // Any non-1 code is a refusal (the old `!== 0` read 3 as OK).
    expect(parseCharacterRestoreResponse(u32(3)).verificationOk).toBe(false);

    // Through the connection: an unsolicited 4-byte 0xF643 reaches the page as a refusal.
    const h = makeHarness();
    handshake(h);
    feed(h, buildMessagePacket(2, concatBytes([u32(GameMessageOpcode.CharacterCreateResponse), u32(3)])));
    const restoreEvents = h.events.filter(e => e.type === 'characterRestoreResponse');
    expect(restoreEvents.length).toBe(1);
    expect(restoreEvents[0].data).toMatchObject({ responseCode: 3, verificationOk: false });
    h.conn.disconnect();
  });

  it('parseCharacterCreateResponse still parses the failure shape (no guid/name)', () => {
    const failPayload = u32(3); // NameInUse
    expect(parseCharacterCreateResponse(failPayload)).toEqual({ responseCode: 3 });
  });

  it('ClientConnection.ts no longer unconditionally treats 0xF643 as a create response', () => {
    expect(CC).toMatch(/awaitingCharacterCreateResponse/);
    expect(CC).toMatch(/type: 'characterRestoreResponse'/);
  });

  it('ServerMessageHandler.ts no longer has the unreachable CharacterRestoreResponse case', () => {
    expect(HANDLER).not.toMatch(/case GameMessageOpcode\.CharacterRestoreResponse:/);
  });

  it.skipIf(!existsSync(ACE_PATH))('ACE source still defines GameMessageCharacterRestore with the 4-field write', () => {
    const src = readFileSync(ACE_PATH, 'utf8');
    expect(src).toMatch(/class GameMessageCharacterRestore\s*:\s*GameMessage/);
    expect(src).toMatch(/Writer\.Write\(1u/);
    expect(src).toMatch(/Writer\.Write\(objectGuid\)/);
    expect(src).toMatch(/Writer\.WriteString16L\(name\)/);
    expect(src).toMatch(/Writer\.Write\(secondsDisabled/);
  });
});

describe('FAITHFUL.581 — no silent-consume leftovers', () => {
  it('no remaining FAITHFUL.580 silent-consume block', () => {
    expect(HANDLER).not.toMatch(/FAITHFUL\.580.*silently-consumed/);
  });

  it('only one default-branch logUnhandled site (the catch-all)', () => {
    const matches = HANDLER.match(/this\.logUnhandled\('direct',\s*msg\.opcode\)/g);
    expect(matches?.length ?? 0).toBe(1);
  });
});
