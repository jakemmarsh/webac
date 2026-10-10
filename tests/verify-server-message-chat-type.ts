/**
 * onServerMessage honors chatType (FAITHFUL.330), GAP.78.
 *
 * Real bug — the `onServerMessage` handler in main.ts ignored the
 * `chatType` field parsed from the wire payload (per
 * `packages/renderer/src/network/ServerMessageHandler.ts:1098-1102`) and
 * always used `ChatMessageType.System` for the chat color. This is
 * a load-bearing field on the ACE side:
 *
 *   - `GameMessageSystemChat.cs:10-11` writes `WriteString16L(message)`
 *     then `Write((int)chatMessageType)` — exactly `message, chatType`.
 *   - `SpellProjectile.cs:824` sends spell-damage attacker text via
 *     `new GameMessageSystemChat(attackerMsg, ChatMessageType.Magic)`
 *     — should render in the Magic colour (retail colorLightBlue #3fbfff,
 *     CORE.17.s).
 *   - `SpellProjectile.cs:840` sends defender text via the same path
 *     — also Magic.
 *   - Many advancement / craft / salvaging system messages use their
 *     respective ChatMessageTypes (Advancement, Craft, Salvaging).
 *
 * Pre-fix ALL of these rendered grey (System #aaaaaa) regardless.
 *
 * GAP.78 — the previous version of this file was a readFileSync+regex
 * source-grep pin (disallowed by the project's no-source-grep rule): it
 * matched text in main.ts/ServerMessageHandler.ts but never drove a single
 * byte through the real parser. This version:
 *  1. Builds real GameMessageSystemChat wire bytes (string16 message +
 *     int32 chatType, per ACE `GameMessageSystemChat.cs`) and drives them
 *     through the shipped `ServerMessageHandler.handleMessage`, asserting
 *     the dispatched `{message, chatType}`.
 *  2. Exercises the shipped `chatColorFor` (what `onServerMessage` in
 *     main.ts calls on the wire type) end-to-end on the dispatched chatType,
 *     asserting the resulting color per ChatMessageType — including
 *     chatType=0 (Broadcast), which CORE.17.s keeps on the retail green
 *     default instead of the old remap to System. `resolveChatType` remains
 *     the onTell helper and is covered below.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { GameMessageOpcode } from '@ac/network';
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

function i32(v: number): Uint8Array {
  return new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function serverMessagePayload(message: string, chatType: number): Uint8Array {
  return concat(string16L(message), i32(chatType));
}

describe('GameMessageSystemChat (ServerMessage 0xF7E0) wire format + chatType→color (FAITHFUL.330, GAP.78)', () => {
  let handler: ServerMessageHandler;
  const calls: Array<{ message: string; chatType: number }> = [];

  beforeEach(() => {
    calls.length = 0;
    handler = new ServerMessageHandler();
    handler.setHandlers({ onServerMessage: d => calls.push(d) });
  });

  function drive(message: string, chatType: number): void {
    handler.handleMessage({
      type: 'direct',
      opcode: GameMessageOpcode.ServerMessage,
      payload: serverMessagePayload(message, chatType),
    } as any);
  }

  it('parses message + chatType (ACE field order: string16L message, then int32 chatType)', () => {
    drive('You have been struck for 12 points of damage.', ChatMessageType.Magic);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      message: 'You have been struck for 12 points of damage.',
      chatType: ChatMessageType.Magic,
    });
  });

  it('dispatches Magic (0x07) spell-damage text through chatColorFor to retail colorLightBlue, not System', () => {
    // Mirrors SpellProjectile.cs:824/840 — spell-damage attacker/defender text.
    drive('You resist the spell!', ChatMessageType.Magic);
    expect(calls[0].chatType).toBe(ChatMessageType.Magic);
    expect(chatColorFor(calls[0].chatType)).toBe('#3fbfff');
  });

  it('dispatches Advancement (0x0D) level-up text to retail colorCyan', () => {
    drive('You are now level 10!', ChatMessageType.Advancement);
    expect(chatColorFor(calls[0].chatType)).toBe('#3fdcdc');
  });

  it('colours chatType 0 (Broadcast — the ACE default) green by the wire type, never remapped to System (CORE.17.s)', () => {
    // Retail indexes BuildChatColorLookupTable @ 004f31c0 by the type as
    // sent; type 0 sits on the green default. The old resolveChatType(0 →
    // System) remap turned the login welcome grey (it is green in the Wine
    // frame docs/images/retail-client-wine-inworld-holtburg.png).
    drive('The server will shut down in 5 minutes.', ChatMessageType.Broadcast);
    expect(calls[0].chatType).toBe(0);
    expect(chatColorFor(calls[0].chatType)).toBe('#80ff7f');
    expect(chatColorFor(calls[0].chatType)).not.toBe(chatColorFor(ChatMessageType.System));
  });

  it('does NOT hardcode System for a nonzero chatType (pre-FAITHFUL.330 bug)', () => {
    drive('Salvage operation complete.', ChatMessageType.Salvaging);
    expect(calls[0].chatType).not.toBe(ChatMessageType.System);
    expect(chatColorFor(calls[0].chatType)).toBe(chatColorFor(ChatMessageType.Salvaging));
    expect(chatColorFor(calls[0].chatType)).not.toBe(chatColorFor(ChatMessageType.System));
  });
});

describe('resolveChatType — shared fallback helper (used by onServerMessage AND onTell)', () => {
  it('passes through any nonzero chatType unchanged', () => {
    expect(resolveChatType(ChatMessageType.Magic, ChatMessageType.System)).toBe(ChatMessageType.Magic);
    expect(resolveChatType(ChatMessageType.X1E, ChatMessageType.Tell)).toBe(ChatMessageType.X1E);
  });

  it('substitutes the fallback only when chatType is exactly 0', () => {
    expect(resolveChatType(0, ChatMessageType.System)).toBe(ChatMessageType.System);
    expect(resolveChatType(0, ChatMessageType.Tell)).toBe(ChatMessageType.Tell);
  });
});
