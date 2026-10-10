/**
 * FAITHFUL.334 — Align GameEventTell parser with ACE source.
 *
 * ACE `GameEventTell.cs:14-19` wire format:
 *   string16 messageText
 *   string16 senderName
 *   uint32   senderID
 *   uint32   targetID
 *   uint32   chatMessageType
 *   uint32   0u  (undocumented trailer present in retail pcaps)
 *
 * Pre-FAITHFUL.334 parser at `ServerMessageHandler.ts:1405-1411` read only
 * 4 fields (message, senderName, senderGuid, chatType) — completely
 * skipping the `targetID` slot AND mis-reading the slot we labeled
 * `chatType`, which actually carried the targetID's guid value (not the
 * ChatMessageType enum). The onTell consumer didn't use chatType so no
 * visible bug fired, but the chatType field carried arbitrary uint32
 * values that any future consumer would have misinterpreted.
 *
 * FAITHFUL.334:
 *  - Read all 6 fields including the targetID slot + the 0u trailer.
 *  - Add `targetGuid` to TellData; rename old "chatType" slot to its real
 *    semantic (the actual ChatMessageType enum value).
 *  - main.ts honors chatType when picking the chat color (same pattern as
 *    FAITHFUL.330's onServerMessage fix). Falls back to ChatMessageType.Tell
 *    on 0 (the ACE default for vanilla player tells).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { GameEventType, GameMessageOpcode } from '@ac/network';
import { ChatMessageType, chatColorFor, resolveChatType } from '@ac/shared';

function string16L(s: string): Uint8Array {
  const bytes = Array.from(s, c => c.charCodeAt(0));
  const total = 2 + bytes.length;
  const pad = (4 - (total % 4)) % 4;
  const out = new Uint8Array(total + pad);
  out[0] = bytes.length & 0xff;
  out[1] = (bytes.length >> 8) & 0xff;
  for (let i = 0; i < bytes.length; i++) out[2 + i] = bytes[i];
  return out;
}

function u32(v: number): Uint8Array {
  return new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

describe('GameEventTell wire format parses all 6 fields (FAITHFUL.334)', () => {
  let handler: ServerMessageHandler;
  const calls: any[] = [];

  beforeEach(() => {
    calls.length = 0;
    handler = new ServerMessageHandler();
    handler.setHandlers({ onTell: d => calls.push(d) });
  });

  it('exposes senderGuid, targetGuid, AND chatType (not skipping targetID)', () => {
    const SENDER = 0x50000042;
    const TARGET = 0x50000777;
    const CHAT_TYPE = 16; // ChatMessageType.Tell
    const payload = concat(
      string16L('Hi there!'),
      string16L('Bob'),
      u32(SENDER),
      u32(TARGET),
      u32(CHAT_TYPE),
      u32(0), // ACE 0u trailer
    );
    handler.handleMessage({
      type: 'event',
      opcode: GameMessageOpcode.GameEvent,
      sequence: 1,
      eventType: GameEventType.Tell,
      objectGuid: 0,
      payload,
    } as any);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      message: 'Hi there!',
      senderName: 'Bob',
      senderGuid: SENDER,
      targetGuid: TARGET,
      chatType: CHAT_TYPE,
    });
  });

  it('chatType reads the actual enum value (not the targetID guid as pre-fix did)', () => {
    // Pre-fix the chatType field carried the guid 0x50000777 (≈ 1342178167)
    // because the parser skipped over targetID. Now chatType must hold
    // ChatMessageType.AllegianceTell == 30, NOT a guid value.
    const payload = concat(
      string16L('Allegiance announcement'),
      string16L('Monarch'),
      u32(0x50000001),
      u32(0x50000042),
      u32(30),                 // ChatMessageType.AllegianceTell
      u32(0),
    );
    handler.handleMessage({
      type: 'event',
      opcode: GameMessageOpcode.GameEvent,
      sequence: 2,
      eventType: GameEventType.Tell,
      objectGuid: 0,
      payload,
    } as any);
    expect(calls[0].chatType).toBe(30);
    expect(calls[0].targetGuid).toBe(0x50000042);
  });

  it('handles empty-name (server-self) tells without misaligning', () => {
    // ACE GameEventChannelBroadcast uses "" as senderName for self-broadcasts
    // (the original client recognizes this as "You Say..."). Tells could
    // theoretically follow the same convention — exercise to be safe.
    const payload = concat(
      string16L('System message'),
      string16L(''),
      u32(0),
      u32(0x50000042),
      u32(1), // ChatMessageType.Broadcast
      u32(0),
    );
    handler.handleMessage({
      type: 'event',
      opcode: GameMessageOpcode.GameEvent,
      sequence: 3,
      eventType: GameEventType.Tell,
      objectGuid: 0,
      payload,
    } as any);
    expect(calls[0].senderName).toBe('');
    expect(calls[0].chatType).toBe(1);
  });
});

describe('onTell honors wire chatType via resolveChatType (FAITHFUL.334, GAP.78)', () => {
  // GAP.78 — a prior version of this block regex-matched main.ts source text
  // (disallowed by the project's no-source-grep rule). main.ts's onTell now
  // calls the same shipped `resolveChatType` helper as onServerMessage
  // (packages/renderer/src/main.ts), so exercise that real function directly
  // with the chatType values a parsed GameEventTell dispatches.
  it('picks the wire chatType when present (falls back to Tell only on 0)', () => {
    expect(resolveChatType(ChatMessageType.Allegiance, ChatMessageType.Tell)).toBe(ChatMessageType.Allegiance);
    expect(resolveChatType(0, ChatMessageType.Tell)).toBe(ChatMessageType.Tell);
  });

  it('resolved chatType maps to the correct color, not a hardcoded Tell pink', () => {
    const allegianceTell = resolveChatType(ChatMessageType.Allegiance, ChatMessageType.Tell);
    expect(chatColorFor(allegianceTell)).toBe(chatColorFor(ChatMessageType.Allegiance));
    expect(chatColorFor(allegianceTell)).not.toBe(chatColorFor(ChatMessageType.Tell));
  });
});
