/**
 * RELEASE.gdle-untested-surfaces.a — GDLE sends ChannelBroadcast (the
 * fellowship / patron / vassal / monarch lines) as a top-level 0x0147
 * message (GDLE ChatMsgs.cpp ChannelChat: 0x147, channel, WriteString name,
 * WriteString text; Fellowship::Chat sends it with game_event = FALSE), not
 * inside the 0xF7B0 event ACE uses. Retail routes the opcode to
 * CM_Communication::DispatchUI_ChannelBroadcast either way
 * (UIQueueManager::ProcessNetBlobData @ 0055b000). Before, the direct
 * message fell to logUnhandled and GDLE fellowship chat never showed.
 */
import { describe, it, expect } from 'vitest';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { BinaryWriter } from '../packages/network/src/MessageSerializer.js';

function body(channel: number, sender: string, text: string): Uint8Array {
  const w = new BinaryWriter(64);
  w.writeUInt32(channel);
  w.writeString16(sender);
  w.writeString16(text);
  return w.toBuffer();
}

describe('ChannelBroadcast as a top-level 0x0147 message (GDLE)', () => {
  it('a fellow\'s line reaches onChannelBroadcast with its channel, sender and text', () => {
    const calls: unknown[] = [];
    const handler = new ServerMessageHandler();
    handler.setHandlers({ onChannelBroadcast: (d) => calls.push(d) });
    handler.handleMessage({ type: 'direct', opcode: 0x0147, payload: body(0x800, 'Claude Gdb', 'ping fellows') } as never);
    expect(calls).toEqual([{ channel: 0x800, senderName: 'Claude Gdb', message: 'ping fellows' }]);
  });

  it('the sender\'s own echo (GDLE writes a NULL name: an empty string) is delivered too', () => {
    const calls: Array<{ senderName: string }> = [];
    const handler = new ServerMessageHandler();
    handler.setHandlers({ onChannelBroadcast: (d) => calls.push(d) });
    handler.handleMessage({ type: 'direct', opcode: 0x0147, payload: body(0x800, '', 'hello fellow') } as never);
    expect(calls).toEqual([{ channel: 0x800, senderName: '', message: 'hello fellow' }]);
  });
});
