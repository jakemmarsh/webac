/**
 * FAITHFUL.532 — TurbineChat NETBLOB_RESPONSE_BINARY ACK no longer
 *  fires `onTurbineChat`.
 *
 *  Pre-fix the ACK branch in `handleTurbineChat` parsed responseID +
 *  methodID + hResult, then synthesized an event with
 *  `senderName: 'System', message: '', isSystemMessage: true`.
 *  main.ts:5387's onTurbineChat handler renders
 *    `gameUI.addSystemMessage(\`[System] ${data.message}\`, ...)`
 *  for any `isSystemMessage`, so every channel message we sent to the
 *  server produced a phantom `[System] ` (trailing space, no body) line
 *  in the chat log on the round-trip ACK return.
 *
 *  Fix: drop the ACK branch silently — ACE GameMessageTurbineChat.cs:115-136
 *  carries NO user-facing payload in the RESPONSE_BINARY shape, so there
 *  is no chat line to display.
 *
 *  DEBT.test-harness-hygiene: behavioural — the real ServerMessageHandler is
 *  fed hand-built TurbineChat (0xF7DE) payloads in ACE's wire layout.
 */
import { describe, it, expect } from 'vitest';
import { ChatNetworkBlobType } from '@ac/shared';
import { BinaryWriter, GameMessageOpcode } from '@ac/network';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';

function unicodeStr(w: BinaryWriter, s: string): void {
  w.writeUInt8(s.length); // < 0x80 chars → 1-byte length form
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    w.writeUInt8(c & 0xff);
    w.writeUInt8(c >> 8);
  }
}

/** ACE GameMessageTurbineChat.cs NETBLOB_RESPONSE_BINARY (lines 115-136). */
function responseBlob(): Uint8Array {
  const w = new BinaryWriter(64);
  w.writeUInt32(0);                                        // firstSize placeholder
  w.writeUInt32(ChatNetworkBlobType.NETBLOB_RESPONSE_BINARY);
  w.writeUInt32(2);                                        // blobDispatchType
  w.writeUInt32(1); w.writeUInt32(0x000b00b5);             // targetType, targetID
  w.writeUInt32(1); w.writeUInt32(0x000b00b5);             // transportType, transportID
  w.writeUInt32(7);                                        // cookie
  w.writeUInt32(0);                                        // secondSize
  w.writeUInt32(7); w.writeUInt32(1); w.writeUInt32(0);    // responseID, methodID, hResult
  return w.toBuffer();
}

/** ACE GameMessageTurbineChat.cs NETBLOB_EVENT_BINARY (lines 79-114). */
function eventBlob(channel: number, sender: string, message: string, senderId: number, chatType: number): Uint8Array {
  const w = new BinaryWriter(256);
  w.writeUInt32(0);
  w.writeUInt32(ChatNetworkBlobType.NETBLOB_EVENT_BINARY);
  w.writeUInt32(1);                                        // blobDispatchType
  w.writeUInt32(1); w.writeUInt32(0x000b00b5);
  w.writeUInt32(1); w.writeUInt32(0x000b00b5);
  w.writeUInt32(0);
  w.writeUInt32(0);
  w.writeUInt32(channel);
  unicodeStr(w, sender);
  unicodeStr(w, message);
  w.writeUInt32(0x0c);
  w.writeUInt32(senderId);
  w.writeUInt32(0);
  w.writeUInt32(chatType);
  return w.toBuffer();
}

function feed(payload: Uint8Array): unknown[] {
  const h = new ServerMessageHandler();
  const seen: unknown[] = [];
  h.setHandlers({ onTurbineChat: (d: unknown) => { seen.push(d); } });
  h.handleMessage({ type: 'direct', opcode: GameMessageOpcode.TurbineChat, payload });
  return seen;
}

describe('FAITHFUL.532 — TurbineChat ACK no longer renders empty [System] line (behavioural)', () => {
  it('NETBLOB_RESPONSE_BINARY is dropped silently (onTurbineChat never fires)', () => {
    expect(feed(responseBlob())).toEqual([]);
  });

  it('NETBLOB_EVENT_BINARY still fires onTurbineChat as a non-system player line (regression guard)', () => {
    const seen = feed(eventBlob(0x0000000b, 'TestPlayer', 'Hi everyone!', 0x50000abc, 3));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      type: ChatNetworkBlobType.NETBLOB_EVENT_BINARY,
      channelId: 0x0b,
      senderName: 'TestPlayer',
      message: 'Hi everyone!',
      senderGuid: 0x50000abc,
      isSystemMessage: false,
      blobDispatchType: 1,
      chatType: 3,
    });
  });
});
