/**
 * GAP.86 — behavioral wire-format coverage for 6 GameEvent parsers that
 * previously had ZERO wire-level test coverage (only case-presence checks,
 * template-format tests, or source-grep pins on unrelated main.ts consumer
 * logic — never a real handleMessage() drive of the actual byte parse):
 *
 * 1. GameEventCharacterTitle (0x0029) — per
 *    `GameEventCharacterTitle.cs:11-19`, wire is `u32 (always 1) +
 *    u32 activeTitleId + u32 count + count × u32 titleId`.
 * 2. GameEventUpdateTitle (0x002B) — per `GameEventUpdateTitle.cs:11-13`,
 *    wire is `u32 titleId + u32 (bool)setAsDisplayTitle`.
 * 3. GameEventWeenieErrorWithString (0x028B) — per
 *    `GameEventWeenieErrorWithString.cs:11-12`, wire is
 *    `u32 errorType + WriteString16L(message)`. Only
 *    verify-weenie-error-with-string-format.ts (template lookup) and
 *    verify-weenie-error-with-string-sound.ts (main.ts source-grep pin)
 *    existed; neither drives the actual parser.
 * 4. GameEventCommunicationTransientString (0x02EB) — per
 *    `GameEventCommunicationTransientString.cs:8`, wire is a bare
 *    `WriteString16L(message)`. Only verify-transient-string-sound.ts
 *    existed, a source-grep pin on main.ts's onCommunicationTransientString
 *    consumer (sound/chat wiring), never the wire parse.
 * 5. GameEventAttackDone (0x01A7) — per `GameEventAttackDone.cs:11`, wire
 *    is a single `u32 (WeenieError)errorType`. The client defensively
 *    reads `r.remaining >= 4 ? r.readUInt32() : 0` for a truncated
 *    payload; both the normal and truncated paths had zero coverage.
 * 6. GameEventFellowshipDisband (0x02BF) — per
 *    `GameEventFellowshipDisband.cs:6-9`, a 4-byte header-only event with
 *    no payload fields (base size 4). Had zero test coverage anywhere.
 *
 * All 6 parsers were cross-checked field-for-field against the ACE C#
 * writers above and confirmed byte-correct — this cycle closes
 * test-coverage gaps only, no parser code fix required.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { BinaryWriter, GameEventType, GameMessageOpcode } from '@ac/network';

let seq = 300;
function event(eventType: GameEventType, payload: Uint8Array) {
  return {
    type: 'event' as const,
    opcode: GameMessageOpcode.GameEvent as GameMessageOpcode.GameEvent,
    sequence: seq++,
    eventType,
    objectGuid: 0,
    payload,
  };
}

describe('CharacterTitle wire-format (GAP.86)', () => {
  let handler: ServerMessageHandler;
  const calls: any[] = [];

  beforeEach(() => {
    calls.length = 0;
    handler = new ServerMessageHandler();
    handler.setHandlers({ onCharacterTitle: (d) => calls.push(d) });
  });

  it('parses flag(skip) + activeTitleId + count + N × titleId', () => {
    const w = new BinaryWriter(32);
    w.writeUInt32(1); // unknown flag, always 1
    w.writeUInt32(400); // activeTitleId
    w.writeUInt32(3); // count
    w.writeUInt32(1);
    w.writeUInt32(400);
    w.writeUInt32(823);
    handler.handleMessage(event(GameEventType.CharacterTitle, w.toBuffer()));
    expect(calls).toHaveLength(1);
    expect(calls[0].activeTitleId).toBe(400);
    expect(calls[0].titleIds).toEqual([1, 400, 823]);
  });

  it('parses a zero-count title list', () => {
    const w = new BinaryWriter(12);
    w.writeUInt32(1);
    w.writeUInt32(0);
    w.writeUInt32(0);
    handler.handleMessage(event(GameEventType.CharacterTitle, w.toBuffer()));
    expect(calls[0].activeTitleId).toBe(0);
    expect(calls[0].titleIds).toEqual([]);
  });
});

describe('UpdateTitle wire-format (GAP.86)', () => {
  let handler: ServerMessageHandler;
  const calls: any[] = [];

  beforeEach(() => {
    calls.length = 0;
    handler = new ServerMessageHandler();
    handler.setHandlers({ onUpdateTitle: (d) => calls.push(d) });
  });

  it('parses titleId u32 + setAsDisplayTitle u32-bool (true)', () => {
    const w = new BinaryWriter(8);
    w.writeUInt32(823);
    w.writeUInt32(1);
    handler.handleMessage(event(GameEventType.UpdateTitle, w.toBuffer()));
    expect(calls[0].titleId).toBe(823);
    expect(calls[0].setAsDisplay).toBe(true);
  });

  it('parses setAsDisplayTitle = false as a non-1 u32', () => {
    const w = new BinaryWriter(8);
    w.writeUInt32(400);
    w.writeUInt32(0);
    handler.handleMessage(event(GameEventType.UpdateTitle, w.toBuffer()));
    expect(calls[0].titleId).toBe(400);
    expect(calls[0].setAsDisplay).toBe(false);
  });
});

describe('WeenieErrorWithString wire-format (GAP.86)', () => {
  let handler: ServerMessageHandler;
  const calls: any[] = [];

  beforeEach(() => {
    calls.length = 0;
    handler = new ServerMessageHandler();
    handler.setHandlers({ onWeenieErrorWithString: (d) => calls.push(d) });
  });

  it('parses errorType u32 + String16L message', () => {
    const w = new BinaryWriter(32);
    w.writeUInt32(1); // WeenieErrorWithString enum value
    w.writeString16('You are too encumbered to tailor that!');
    handler.handleMessage(event(GameEventType.WeenieErrorWithString, w.toBuffer()));
    expect(calls[0].errorType).toBe(1);
    expect(calls[0].message).toBe('You are too encumbered to tailor that!');
  });

  it('parses a short message needing string16L padding', () => {
    const w = new BinaryWriter(16);
    w.writeUInt32(2);
    w.writeString16('Hi'); // 2(len) + 2(bytes) = 4, no padding needed — exercises the boundary
    handler.handleMessage(event(GameEventType.WeenieErrorWithString, w.toBuffer()));
    expect(calls[0].errorType).toBe(2);
    expect(calls[0].message).toBe('Hi');
  });
});

describe('CommunicationTransientString wire-format (GAP.86)', () => {
  let handler: ServerMessageHandler;
  const calls: any[] = [];

  beforeEach(() => {
    calls.length = 0;
    handler = new ServerMessageHandler();
    handler.setHandlers({ onCommunicationTransientString: (d) => calls.push(d) });
  });

  it('parses a bare String16L message with no other fields', () => {
    const w = new BinaryWriter(32);
    w.writeString16("You can't use the Aetheria on itself.");
    handler.handleMessage(event(GameEventType.CommunicationTransientString, w.toBuffer()));
    expect(calls).toHaveLength(1);
    expect(calls[0].message).toBe("You can't use the Aetheria on itself.");
  });
});

describe('AttackDone wire-format (GAP.86)', () => {
  let handler: ServerMessageHandler;
  const calls: any[] = [];

  beforeEach(() => {
    calls.length = 0;
    handler = new ServerMessageHandler();
    handler.setHandlers({ onAttackDone: (d) => calls.push(d) });
  });

  it('parses errorType u32 (WeenieError.None = 0, attack succeeded)', () => {
    const w = new BinaryWriter(4);
    w.writeUInt32(0);
    handler.handleMessage(event(GameEventType.AttackDone, w.toBuffer()));
    expect(calls[0].errorType).toBe(0);
  });

  it('parses a non-zero WeenieError value', () => {
    const w = new BinaryWriter(4);
    w.writeUInt32(4); // WeenieError.ActionCancelled (illustrative non-zero value)
    handler.handleMessage(event(GameEventType.AttackDone, w.toBuffer()));
    expect(calls[0].errorType).toBe(4);
  });

  it('defaults to errorType 0 on a truncated (empty) payload', () => {
    handler.handleMessage(event(GameEventType.AttackDone, new Uint8Array(0)));
    expect(calls[0].errorType).toBe(0);
  });
});

describe('FellowshipDisband wire-format (GAP.86)', () => {
  it('fires the handler on the 0-byte payload (4-byte header-only event)', () => {
    const handler = new ServerMessageHandler();
    let fired = false;
    handler.setHandlers({ onFellowshipDisband: () => { fired = true; } });
    handler.handleMessage(event(GameEventType.FellowshipDisband, new Uint8Array(0)));
    expect(fired).toBe(true);
  });
});
