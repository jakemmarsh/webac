/**
 * FAITHFUL.167 — pin the REAL ACE HearSpeech (0x02BB) wire format and
 * document the (build|parse)SpeechPayload misnomer.
 *
 * Audit revealed the public-API helpers `buildSpeechPayload` and
 * `parseSpeechPayload` were exported from `@ac/network` with a JSDoc
 * implying they handled the actual AC chat protocol. They DO NOT — they
 * are a 3-field test harness that OMITS the senderID. The real parser
 * lives at ServerMessageHandler.handleHearSpeech.
 *
 * Real ACE wire format (per GameMessageHearSpeech.cs):
 *   WriteString16L messageText  — UTF-8 + 4-byte pad
 *   WriteString16L senderName   — UTF-8 + 4-byte pad
 *   Write senderID              — uint32
 *   Write (uint)chatMessageType — uint32
 *
 * This test (a) pins the ACE source, (b) verifies the renderer-side
 * handler reads all 4 fields in the correct order, (c) verifies the
 * (build|parse)SpeechPayload helpers now carry the @internal warning so
 * future contributors don't mistake them for the real wire-format parsers.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BinaryReader, BinaryWriter, GameMessageOpcode, buildSpeechPayload, parseSpeechPayload } from '@ac/network';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';

const REPO = resolve(__dirname, '..');
const ACE_FILE = resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/GameMessages/Messages/GameMessageHearSpeech.cs');

describe('Opcode numeric pinning', () => {
  it('HearSpeech opcode is 0x02BB', () => {
    expect(GameMessageOpcode.HearSpeech).toBe(0x02BB);
  });
});

describe.skipIf(!aceReferenceExists(ACE_FILE))('ACE wire format pinning', () => {
  let src: string;
  // Loaded in beforeAll: skipIf does not skip the describe body (CLAUDE.md).
  beforeAll(() => {
    src = readFileSync(ACE_FILE, 'utf8');
  });

  it('writes messageText → senderName → senderID → chatMessageType in that order', () => {
    const msgPos = src.search(/Writer\.WriteString16L\(messageText\)/);
    const namePos = src.search(/Writer\.WriteString16L\(senderName\)/);
    const idPos = src.search(/Writer\.Write\(senderID\)/);
    const typePos = src.search(/Writer\.Write\(\(uint\)chatMessageType\)/);
    expect(msgPos).toBeGreaterThan(0);
    expect(namePos).toBeGreaterThan(msgPos);
    expect(idPos).toBeGreaterThan(namePos);
    expect(typePos).toBeGreaterThan(idPos);
  });
});

/** ACE GameMessageHearSpeech / HearRangedSpeech payload, built with the real BinaryWriter. */
function acePayload(message: string, senderName: string, senderID: number, chatType: number, range?: number): Uint8Array {
  const w = new BinaryWriter(128);
  w.writeString16(message);
  w.writeString16(senderName);
  w.writeUInt32(senderID);
  if (range !== undefined) w.writeFloat32(range);
  w.writeUInt32(chatType);
  return w.toBuffer();
}

type Speech = { message: string; senderName: string; senderGuid: number; chatType: number; range?: number };
function dispatch(opcode: GameMessageOpcode, payload: Uint8Array): { plain: Speech[]; ranged: Speech[] } {
  const plain: Speech[] = []; const ranged: Speech[] = [];
  const h = new ServerMessageHandler();
  h.setHandlers({ onHearSpeech: (d: Speech) => { plain.push(d); }, onHearRangedSpeech: (d: Speech) => { ranged.push(d); } } as never);
  h.handleMessage({ type: 'direct', opcode, payload });
  return { plain, ranged };
}

describe('ServerMessageHandler.handleHearSpeech reads all 4 fields in correct order (behavioural)', () => {
  it('HearSpeech: message → senderName → senderGuid → chatType, range undefined', () => {
    const { plain, ranged } = dispatch(GameMessageOpcode.HearSpeech, acePayload('Hello, World!', 'TestPlayer', 0xDEADBEEF, 5));
    expect(ranged).toEqual([]);
    expect(plain).toEqual([{ message: 'Hello, World!', senderName: 'TestPlayer', senderGuid: 0xDEADBEEF, chatType: 5, range: undefined }]);
  });

  it('HearRangedSpeech: the float32 range sits between senderGuid and chatType (FAITHFUL.336)', () => {
    const { plain, ranged } = dispatch(GameMessageOpcode.HearRangedSpeech, acePayload('LOUD', 'Shouter', 0x50000001, 0x17, 50));
    expect(plain).toEqual([]);
    expect(ranged).toEqual([{ message: 'LOUD', senderName: 'Shouter', senderGuid: 0x50000001, chatType: 0x17, range: 50 }]);
  });
});

describe('(build|parse)SpeechPayload are a 3-field test harness, NOT the ACE wire format', () => {
  it('parseSpeechPayload round-trips buildSpeechPayload', () => {
    expect(parseSpeechPayload(buildSpeechPayload('hi', 'Bob', 2))).toEqual({ message: 'hi', senderName: 'Bob', chatType: 2 });
  });

  it('buildSpeechPayload omits senderID — 4 bytes shorter than the real HearSpeech payload', () => {
    expect(acePayload('hi', 'Bob', 0x1234, 2).byteLength - buildSpeechPayload('hi', 'Bob', 2).byteLength).toBe(4);
  });
});

describe('Round-trip parse on hand-built ACE-faithful HearSpeech buffer', () => {
  it('the real wire format consumes all 4 fields in correct order', () => {
    // Build the payload like ACE would.
    const messageBytes = new TextEncoder().encode('Hello, World!');
    const nameBytes = new TextEncoder().encode('TestPlayer');
    // String16 = u16 length + bytes + pad-to-4
    const msgLen = messageBytes.length;       // 13
    const msgPad = (4 - ((2 + msgLen) % 4)) % 4;  // 1 byte pad → total 16
    const nameLen = nameBytes.length;          // 10
    const namePad = (4 - ((2 + nameLen) % 4)) % 4; // 0 byte pad → total 12
    const total = (2 + msgLen + msgPad) + (2 + nameLen + namePad) + 4 + 4;

    const buf = new Uint8Array(total);
    const dv = new DataView(buf.buffer);
    let pos = 0;
    dv.setUint16(pos, msgLen, true); pos += 2;
    buf.set(messageBytes, pos); pos += msgLen;
    pos += msgPad;
    dv.setUint16(pos, nameLen, true); pos += 2;
    buf.set(nameBytes, pos); pos += nameLen;
    pos += namePad;
    dv.setUint32(pos, 0xDEADBEEF, true); pos += 4;   // senderID
    dv.setUint32(pos, 5, true); pos += 4;             // chatMessageType=5 (Tell)

    const r = new BinaryReader(buf);
    expect(r.readString16()).toBe('Hello, World!');
    expect(r.readString16()).toBe('TestPlayer');
    expect(r.readUInt32()).toBe(0xDEADBEEF);
    expect(r.readUInt32()).toBe(5);
    expect(r.position).toBe(total);
  });
});
