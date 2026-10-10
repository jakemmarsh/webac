/**
 * FAITHFUL.169 — TurbineChat (0xF7DE) parser was reading 9 of 17 fields,
 * and 5 of those 9 were labeled wrong.
 *
 * ACE GameMessageTurbineChat.cs (NETBLOB_EVENT_BINARY = 1, lines 79-114):
 *   u32 firstSize       — placeholder, patched at end
 *   u32 chatNetworkBlobType
 *   u32 chatNetworkBlobDispatchType
 *   u32 1u              — targetType
 *   u32 0x000B00B5      — targetID
 *   u32 1u              — transportType
 *   u32 0x000B00B5      — transportID
 *   u32 0u              — cookie
 *   u32 secondSize      — placeholder
 *   u32 channel
 *   UnicodeStr senderName  — 1-byte length (or 2-byte ext) + UTF-16 LE bytes
 *   UnicodeStr message     — same encoding
 *   u32 0x0Cu
 *   u32 senderID
 *   u32 0u              — hResult
 *   u32 chatType
 *
 * Pre-FAITHFUL.169 the parser:
 *   - Read blobDispatchType as "always 0" (it's actually 1)
 *   - Read targetType (1u) as channelId
 *   - Read transportID (0x000B00B5) as senderGuid
 *   - Tried to read secondSize+channel as a UTF-8 String16L → garbage or crash
 *   - The try/catch swallowed the error silently — TurbineChat messages were
 *     either dropped entirely (parse error) or arrived with wrong channel +
 *     wrong senderGuid + garbled name/message.
 *
 * Plus: ACE uses UTF-16 LE (`Encoding.Unicode.GetBytes`), not UTF-8 — so even
 * if our parser had found the right offsets, it would have decoded the bytes
 * incorrectly.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ServerMessageHandler, type TurbineChatData } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { GameMessageOpcode } from '@ac/network';
import { ChatNetworkBlobType } from '@ac/shared';

const REPO = resolve(__dirname, '..');
const ACE_FILE = resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/GameMessages/Messages/GameMessageTurbineChat.cs');

describe.skipIf(!aceReferenceExists(ACE_FILE))('ACE TurbineChat wire format pinning', () => {
  let src: string;
  // Loaded in beforeAll: skipIf does not skip the describe body (CLAUDE.md).
  beforeAll(() => {
    src = readFileSync(ACE_FILE, 'utf8');
  });

  it('uses Encoding.Unicode (UTF-16 LE) for senderName and message bodies', () => {
    expect(src).toMatch(/Encoding\.Unicode\.GetBytes\(senderName\)/);
    expect(src).toMatch(/Encoding\.Unicode\.GetBytes\(message\)/);
  });

  it('NETBLOB_EVENT_BINARY branch writes 16 fields after firstSize+type (7 header + channel + 2 strings + 4 trailer)', () => {
    const branch = src.match(/if \(chatNetworkBlobType == ChatNetworkBlobType\.NETBLOB_EVENT_BINARY\)[\s\S]+?(?=else if|^\s*\}\s*$)/m);
    expect(branch).not.toBeNull();
    const body = branch![0];
    // Count Writer.Write calls between blobDispatchType and the chatType trailer.
    const writes = (body.match(/Writer\.Write\(/g) ?? []).length;
    // 16 = blobDispatchType + 1u + targetID + 1u + transportID + cookie + secondSize +
    //      channel + senderName-len-prefix-byte (one of two paths) + senderName-bytes +
    //      message-len-prefix-byte + message-bytes + 0x0Cu + senderID + hResult + chatType
    expect(writes).toBeGreaterThanOrEqual(15);
  });

  it('NETBLOB_RESPONSE_BINARY branch is shorter — NO message/senderName, just IDs + hResult', () => {
    const branch = src.match(/else if \(chatNetworkBlobType == ChatNetworkBlobType\.NETBLOB_RESPONSE_BINARY\)[\s\S]+?(?=else|\}\s*\}\s*$)/);
    expect(branch).not.toBeNull();
    expect(branch![0]).not.toMatch(/senderName/);
    expect(branch![0]).not.toMatch(/Encoding\.Unicode/);
  });

  it('writes "0x0Cu" sentinel before senderID in EVENT_BINARY branch', () => {
    expect(src).toMatch(/Writer\.Write\(0x0Cu\);\s*\n\s*Writer\.Write\(senderID\);/);
  });
});

// DEBT.test-harness-hygiene: the ServerMessageHandler.ts source pins (field
// order, readUnicodeStr's utf-16le decode, the RESPONSE_BINARY branch) are
// now behavioural — hand-built ACE-faithful buffers go through the real
// dispatcher and the onTurbineChat payload is asserted.

/** ACE UnicodeStr: 1-byte length (high bit set → 2-byte extended form, per
 *  the handler's reader) + UTF-16LE code units. Lengths here stay < 0x80. */
function unicodeStr(s: string): number[] {
  const out = [s.length];
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); out.push(c & 0xff, c >> 8); }
  return out;
}

function eventBinary(opts: { channel: number; senderName: string; message: string; senderId: number; chatType: number; dispatch?: number }): Uint8Array {
  const bytes: number[] = [];
  const u32 = (v: number) => { bytes.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff); };
  u32(0); u32(1); u32(opts.dispatch ?? 1); u32(1); u32(0x000B00B5); u32(1); u32(0x000B00B5); u32(0); u32(0);
  u32(opts.channel);
  bytes.push(...unicodeStr(opts.senderName), ...unicodeStr(opts.message));
  u32(0x0C); u32(opts.senderId); u32(0); u32(opts.chatType);
  return new Uint8Array(bytes);
}

function dispatchTurbineChat(payload: Uint8Array): TurbineChatData[] {
  const got: TurbineChatData[] = [];
  const h = new ServerMessageHandler();
  h.setHandlers({ onTurbineChat: (d) => { got.push(d); } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  h.handleMessage({ type: 'direct', opcode: GameMessageOpcode.TurbineChat, payload } as any);
  return got;
}

describe('Integration (FAITHFUL.169, behavioural)', () => {
  it('NETBLOB_EVENT_BINARY: all 17 fields read in ACE order — channel after the 8 header u32s, name, message, senderID, chatType', () => {
    const got = dispatchTurbineChat(eventBinary({ channel: 7, senderName: 'TestPlayer', message: 'Hi everyone!', senderId: 0x50000001, chatType: 8 }));
    expect(got).toEqual([{
      type: 1, channelId: 7, senderName: 'TestPlayer', message: 'Hi everyone!', senderGuid: 0x50000001,
      isSystemMessage: false, blobDispatchType: 1, chatType: 8,
    }]);
  });

  it('UnicodeStr fields decode as UTF-16LE (non-ASCII survives; a UTF-8 decode would garble it)', () => {
    const got = dispatchTurbineChat(eventBinary({ channel: 2, senderName: 'Zoë Ωmega', message: 'naïve ☃ café', senderId: 0x50000002, chatType: 4, dispatch: 1 }));
    expect(got).toHaveLength(1);
    expect(got[0].senderName).toBe('Zoë Ωmega');
    expect(got[0].message).toBe('naïve ☃ café');
    expect(got[0].senderGuid).toBe(0x50000002);
  });

  it('NETBLOB_RESPONSE_BINARY (the per-send ACK) carries no message text and fires nothing (FAITHFUL.532)', () => {
    const bytes: number[] = [];
    const u32 = (v: number) => { bytes.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff); };
    u32(0); u32(ChatNetworkBlobType.NETBLOB_RESPONSE_BINARY);
    for (let i = 0; i < 10; i++) u32(i); // dispatch/target/transport/cookie/size/responseID/methodID/hResult…
    expect(dispatchTurbineChat(new Uint8Array(bytes))).toEqual([]);
  });
});

