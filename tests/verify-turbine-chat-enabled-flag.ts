/**
 * BUG.turbine-chat-enabled-flag-unused — CharacterList's use_turbine_chat
 * flag is parsed but never consulted before sending channel chat.
 *
 * ACE writes use_turbine_chat (PropertyManager.GetBool, default true) into
 * CharacterList at login (GameMessageCharacterList.cs:33-35). When a server
 * operator has set it false, TurbineChatHandler.TurbineChatReceived
 * (TurbineChatHandler.cs:21-23) returns immediately with no error response —
 * every /general, /trade, /lfg, /roleplay, /society, /allegiance message
 * sent while it's false is silently dropped server-side.
 *
 * shouldSendTurbineChat is the client-side gate: false only when the flag
 * is known and explicitly false; true when true OR not yet known (fail
 * open, matching ACE's own default-true property), so the client never
 * emits a packet the server will swallow with no feedback, and main.ts
 * shows a local system message instead.
 */
import { describe, it, expect } from 'vitest';
import { parseCharacterList, shouldSendTurbineChat } from '@ac/network';

describe('shouldSendTurbineChat (BUG.turbine-chat-enabled-flag-unused)', () => {
  it('allows sending when the server enables turbine chat', () => {
    expect(shouldSendTurbineChat(true)).toBe(true);
  });

  it('blocks sending when the server disables turbine chat', () => {
    expect(shouldSendTurbineChat(false)).toBe(false);
  });

  it('fails open (allows sending) when the flag is not yet known', () => {
    expect(shouldSendTurbineChat(undefined)).toBe(true);
  });
});

describe('parseCharacterList surfaces useTurbineChat for the gate to consume', () => {
  function buildCharacterListPayload(useTurbineChat: boolean): Uint8Array {
    const buf = new ArrayBuffer(64);
    const view = new DataView(buf);
    let off = 0;
    view.setUint32(off, 0, true); off += 4; // unknown
    view.setUint32(off, 0, true); off += 4; // character count = 0
    view.setUint32(off, 0, true); off += 4; // unknown
    view.setUint32(off, 10, true); off += 4; // slotCount
    // accountName: UInt16 string16 (length-prefixed uint16, no chars)
    view.setUint16(off, 0, true); off += 2;
    off += 2; // align to 4
    view.setUint32(off, useTurbineChat ? 1 : 0, true); off += 4; // useTurbineChat
    view.setUint32(off, 1, true); off += 4; // hasThroneOfDestiny
    return new Uint8Array(buf, 0, off);
  }

  it('parses useTurbineChat=true', () => {
    const data = parseCharacterList(buildCharacterListPayload(true));
    expect(data.useTurbineChat).toBe(true);
    expect(shouldSendTurbineChat(data.useTurbineChat)).toBe(true);
  });

  it('parses useTurbineChat=false and the gate blocks on it', () => {
    const data = parseCharacterList(buildCharacterListPayload(false));
    expect(data.useTurbineChat).toBe(false);
    expect(shouldSendTurbineChat(data.useTurbineChat)).toBe(false);
  });
});
