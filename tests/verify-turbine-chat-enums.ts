/**
 * ChatNetworkBlobDispatchType + TURBINE_CHAT_EXTRA_DATA_SIZE audit (FAITHFUL.154).
 *
 * The TurbineChat (GameMessage 0xF7DE) is the wire format for /general,
 * /trade, /allegiance, /lfg, and /roleplay chat. Three header fields in
 * the outbound builder were bare literals: the BlobType (3), the dispatch
 * type (2), and the trailing extra-data-block size (0x0C). All three are
 * documented as enum/constant values in ACE source.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ChatNetworkBlobType,
  ChatNetworkBlobDispatchType,
  TURBINE_CHAT_EXTRA_DATA_SIZE,
} from '@ac/shared';
import { buildTurbineChatPayload, parseTurbineChatPayload, BinaryReader } from '@ac/network';

const REPO = resolve(__dirname, '..');
const ACE_BLOB    = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/ChatNetworkBlobType.cs');
const ACE_DISP    = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/ChatNetworkBlobDispatchType.cs');
const ACE_MSG     = resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/GameMessages/Messages/GameMessageTurbineChat.cs');
const ACE_HANDLER = resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/Handlers/TurbineChatHandler.cs');

describe.skipIf(!aceReferenceExists(ACE_BLOB))('ACE ChatNetworkBlobType coverage', () => {
  let src: string;
  // Loaded in beforeAll: skipIf does not skip the describe body (CLAUDE.md).
  beforeAll(() => {
    src = readFileSync(ACE_BLOB, 'utf8');
  });
  it('TS port matches ACE 1:1', () => {
    expect(src).toMatch(/NETBLOB_UNKNOWN\s*=\s*0/);
    expect(src).toMatch(/NETBLOB_EVENT_BINARY\s*=\s*1/);
    expect(src).toMatch(/NETBLOB_EVENT_XMLRPC\s*=\s*2/);
    expect(src).toMatch(/NETBLOB_REQUEST_BINARY\s*=\s*3/);
    expect(src).toMatch(/NETBLOB_REQUEST_XMLRPC\s*=\s*4/);
    expect(src).toMatch(/NETBLOB_RESPONSE_BINARY\s*=\s*5/);
    expect(src).toMatch(/NETBLOB_RESPONSE_XMLRPC\s*=\s*6/);
    expect(ChatNetworkBlobType.NETBLOB_UNKNOWN).toBe(0);
    expect(ChatNetworkBlobType.NETBLOB_EVENT_BINARY).toBe(1);
    expect(ChatNetworkBlobType.NETBLOB_EVENT_XMLRPC).toBe(2);
    expect(ChatNetworkBlobType.NETBLOB_REQUEST_BINARY).toBe(3);
    expect(ChatNetworkBlobType.NETBLOB_REQUEST_XMLRPC).toBe(4);
    expect(ChatNetworkBlobType.NETBLOB_RESPONSE_BINARY).toBe(5);
    expect(ChatNetworkBlobType.NETBLOB_RESPONSE_XMLRPC).toBe(6);
  });
});

describe.skipIf(!aceReferenceExists(ACE_DISP))('ACE ChatNetworkBlobDispatchType coverage', () => {
  let src: string;
  // Loaded in beforeAll: skipIf does not skip the describe body (CLAUDE.md).
  beforeAll(() => {
    src = readFileSync(ACE_DISP, 'utf8');
  });
  it('TS port matches ACE 1:1', () => {
    expect(src).toMatch(/ASYNCMETHOD_UNKNOWN\s*=\s*0/);
    expect(src).toMatch(/ASYNCMETHOD_SENDTOROOMBYNAME\s*=\s*1/);
    expect(src).toMatch(/ASYNCMETHOD_SENDTOROOMBYID\s*=\s*2/);
    expect(src).toMatch(/ASYNCMETHOD_CREATEROOM\s*=\s*3/);
    expect(src).toMatch(/ASYNCMETHOD_INVITECLIENTTOROOMBYID\s*=\s*4/);
    expect(src).toMatch(/ASYNCMETHOD_EJECTCLIENTFROMROOMBYID\s*=\s*5/);
    expect(ChatNetworkBlobDispatchType.ASYNCMETHOD_UNKNOWN).toBe(0);
    expect(ChatNetworkBlobDispatchType.ASYNCMETHOD_SENDTOROOMBYNAME).toBe(1);
    expect(ChatNetworkBlobDispatchType.ASYNCMETHOD_SENDTOROOMBYID).toBe(2);
    expect(ChatNetworkBlobDispatchType.ASYNCMETHOD_CREATEROOM).toBe(3);
    expect(ChatNetworkBlobDispatchType.ASYNCMETHOD_INVITECLIENTTOROOMBYID).toBe(4);
    expect(ChatNetworkBlobDispatchType.ASYNCMETHOD_EJECTCLIENTFROMROOMBYID).toBe(5);
  });
});

describe.skipIf(!aceReferenceExists(ACE_MSG))('ACE GameMessageTurbineChat extra-data-size literal', () => {
  let src: string;
  // Loaded in beforeAll: skipIf does not skip the describe body (CLAUDE.md).
  beforeAll(() => {
    src = readFileSync(ACE_MSG, 'utf8');
  });
  it('uses 0x0Cu before the speakerID/hResult/chatType triple', () => {
    expect(src).toMatch(/Writer\.Write\(0x0Cu\);\s*\n\s*Writer\.Write\(senderID\);/);
    expect(TURBINE_CHAT_EXTRA_DATA_SIZE).toBe(0x0C);
  });
});

describe.skipIf(!aceReferenceExists(ACE_HANDLER))('ACE TurbineChatHandler extra-data-size read', () => {
  let src: string;
  // Loaded in beforeAll: skipIf does not skip the describe body (CLAUDE.md).
  beforeAll(() => {
    src = readFileSync(ACE_HANDLER, 'utf8');
  });
  it('reads back the same literal with "Always 0x0C" comment', () => {
    expect(src).toMatch(/ReadUInt32\(\);\s*\/\/\s*Always 0x0C/);
  });
});

describe('TurbineChat builder integration (FAITHFUL.154 / GAP.87)', () => {
  // GAP.87 (2026-07-26b) extracted the /general /trade /allegiance send-side
  // TurbineChat construction out of main.ts's inline BinaryWriter block into
  // buildTurbineChatPayload/parseTurbineChatPayload (packages/network/src/
  // MessageSerializer.ts), so the three symbolic constants now live there
  // instead of in main.ts. These assertions were converted from a main.ts
  // source-grep pin to genuine behavioral coverage of the shared builder.
  it('buildTurbineChatPayload writes the enum values symbolically, not bare literals', () => {
    const payload = buildTurbineChatPayload(2, 'hi', 5, 0x50000001);
    const parsed = parseTurbineChatPayload(payload);
    expect(parsed.blobType).toBe(ChatNetworkBlobType.NETBLOB_REQUEST_BINARY);
    expect(parsed.dispatchType).toBe(ChatNetworkBlobDispatchType.ASYNCMETHOD_SENDTOROOMBYID);
  });

  it('round-trips channelId, message, contextId, and senderGuid exactly', () => {
    const payload = buildTurbineChatPayload(3, 'WTS sword', 0x2A & 0x71, 0x50001234);
    const parsed = parseTurbineChatPayload(payload);
    expect(parsed.channelId).toBe(3);
    expect(parsed.message).toBe('WTS sword');
    expect(parsed.contextId).toBe(0x2A & 0x71);
    expect(parsed.senderGuid).toBe(0x50001234);
    expect(parsed.chatType).toBe(3); // chatType mirrors channelId per TurbineChatHandler.cs:60
  });

  it('the trailing extra-data-size field is TURBINE_CHAT_EXTRA_DATA_SIZE (0x0C), not a bare literal', () => {
    // Read the raw byte offset directly (mirrors TurbineChatHandler.cs:57's
    // "Always 0x0C" read) rather than trusting parseTurbineChatPayload's own
    // interpretation, so a bug in both build+parse together couldn't hide this.
    const payload = buildTurbineChatPayload(2, 'x', 1, 1);
    const reader = new BinaryReader(payload);
    reader.readUInt32(); reader.readUInt32(); reader.readUInt32(); // outerSize, blobType, dispatchType
    reader.readUInt32(); reader.readUInt32(); reader.readUInt32(); reader.readUInt32(); reader.readUInt32(); // 1,0,0,0,0
    reader.readUInt32(); reader.readUInt32(); reader.readUInt32(); reader.readUInt32(); reader.readUInt32(); // innerSize, contextId, 2, 2, channelId
    reader.readUInt8(); reader.readBytes(2); // packed len(1) + 'x' UTF-16LE (2 bytes)
    expect(reader.readUInt32()).toBe(TURBINE_CHAT_EXTRA_DATA_SIZE);
  });

  it('the "bytes to follow" fields follow GameMessageTurbineChat.cs\'s WritePosition formula (endPos - fieldStart + 4), not the textbook "bytes strictly after" count', () => {
    // Regression for a real off-by bug found 2026-07-26b: the prior inline
    // main.ts computation undercounted outerSize by 4 and innerSize by 8
    // relative to the formula GameMessageTurbineChat.cs:112-113 actually uses
    // for this same wire format (server→client direction, but the same
    // framing convention applies both ways since it's one physical protocol).
    const message = 'abc'; // msgLen=3, packedLenSize=1
    const payload = buildTurbineChatPayload(2, message, 1, 1);
    const parsed = parseTurbineChatPayload(payload);
    const packedLenSize = 1;
    const msgLen = message.length;
    expect(parsed.innerBytesToFollow).toBe(40 + packedLenSize + msgLen * 2);
    expect(parsed.outerBytesToFollow).toBe(parsed.innerBytesToFollow + 32);
    // Cross-check against the actual wire length: per the WritePosition
    // formula, outerBytesToFollow = finalEndPos + 4, so the real payload
    // (which ends at finalEndPos) is always exactly 4 bytes SHORTER than
    // the value written into the outer length field.
    expect(payload.length - parsed.outerBytesToFollow).toBe(-4);
  });

  it('supports packed 2-byte message lengths (>= 128 chars)', () => {
    const longMessage = 'x'.repeat(200);
    const payload = buildTurbineChatPayload(2, longMessage, 1, 1);
    const parsed = parseTurbineChatPayload(payload);
    expect(parsed.message).toBe(longMessage);
    expect(parsed.message.length).toBe(200);
  });

  it('main.ts routes the retail command system\'s SendTurbineChat (@general @trade @a …, talk focus) through the shared builder, not an inline BinaryWriter', () => {
    const src = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');
    const block = src.match(/sendTurbineChat: \(roomId[\s\S]{0,600}?return true;/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/buildTurbineChatPayload\(/);
    expect(block![0]).not.toMatch(/new BinaryWriter/);
  });
});

describe('buildTurbineChatPayload chat type (SendTurbineChat @ 0057db10 blob)', () => {
  const lastU32 = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(b.byteLength - 4, true);
  it('writes the caller\'s ChatType as the blob\'s last field (ACE TurbineChatHandler reads it there)', () => {
    // Talk focus General sends ChatType 1 (retail quirk @ 0x581686) into room 2.
    expect(lastU32(buildTurbineChatPayload(2, 'wts', 1, 0x50000001, 1))).toBe(1);
    expect(lastU32(buildTurbineChatPayload(0x7f00a1, 'hi', 1, 0x50000001, 1))).toBe(1);
  });
  it('defaults to the room id (the fixed rooms equal their chat type)', () => {
    expect(lastU32(buildTurbineChatPayload(3, 'wts', 1, 0x50000001))).toBe(3);
  });
});
