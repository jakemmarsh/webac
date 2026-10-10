/**
 * GAP.86 — ViewContents (0x0196) extraction + behavioral wire-format test.
 *
 * Per GameEventViewContents.cs:13-26, the event's own Data payload is
 * `container.Guid.Full (u32) + count (u32) + count * (itemGuid u32 +
 * containerType u32)`. This had zero behavioral test coverage: the only
 * parsing lived inline in main.ts's onViewContents consumer (re-derived via
 * a raw DataView over rawPayload), which can't be imported in tests
 * (module-scope WebSocket/game-loop side effects).
 *
 * Extracted a pure parseViewContents() into
 * packages/network/src/MessageSerializer.ts, matching the
 * parseFellowshipFullUpdate/parseApproachVendor convention, and wired
 * ServerMessageHandler to use it instead of msg.objectGuid.
 *
 * Confirmed bug (mislabeling, not a live defect): ServerMessageHandler
 * previously passed `containerGuid: msg.objectGuid` to onViewContents.
 * GameEventMessage's base ctor (GameEventMessage.cs:19-21) always writes
 * `session.Player.Guid` as the GameEvent header guid, for every event type
 * -- msg.objectGuid is therefore always the *player's own* guid, never the
 * container. main.ts's consumer silently ignored this field and re-derived
 * the real container guid from rawPayload itself, so this was dead-field
 * mislabeling rather than a reachable bug. Fixed by parsing the real
 * container guid out of the payload and passing that through instead.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { BinaryWriter, GameEventType, GameMessageOpcode, parseViewContents } from '@ac/network';

let seq = 300;
function event(eventType: GameEventType, objectGuid: number, payload: Uint8Array) {
  return {
    type: 'event' as const,
    opcode: GameMessageOpcode.GameEvent as GameMessageOpcode.GameEvent,
    sequence: seq++,
    eventType,
    objectGuid,
    payload,
  };
}

describe('parseViewContents (GAP.86)', () => {
  it('parses containerGuid + count + N * (guid, containerType)', () => {
    const w = new BinaryWriter(24);
    w.writeUInt32(0x80001111); // container guid
    w.writeUInt32(2);          // item count
    w.writeUInt32(0x80002222); // item 1 guid
    w.writeUInt32(0);          // item 1 containerType (NonContainer)
    w.writeUInt32(0x80003333); // item 2 guid
    w.writeUInt32(1);          // item 2 containerType (Container)

    const result = parseViewContents(w.toBuffer());

    expect(result).toEqual({
      containerGuid: 0x80001111,
      items: [
        { guid: 0x80002222, containerType: 0 },
        { guid: 0x80003333, containerType: 1 },
      ],
    });
  });

  it('parses a zero-count (empty) container', () => {
    const w = new BinaryWriter(8);
    w.writeUInt32(0x80004444);
    w.writeUInt32(0);

    expect(parseViewContents(w.toBuffer())).toEqual({
      containerGuid: 0x80004444,
      items: [],
    });
  });

  it('returns null on a truncated/malformed payload instead of throwing', () => {
    const w = new BinaryWriter(4);
    w.writeUInt32(0x80005555); // container guid only, missing count
    expect(parseViewContents(w.toBuffer())).toBeNull();
  });
});

describe('ServerMessageHandler ViewContents dispatch (GAP.86)', () => {
  let handler: ServerMessageHandler;
  const calls: any[] = [];

  beforeEach(() => {
    calls.length = 0;
    handler = new ServerMessageHandler();
    handler.setHandlers({ onViewContents: (d) => calls.push(d) });
  });

  it('passes the payload-derived containerGuid and items through, not the header objectGuid', () => {
    const w = new BinaryWriter(16);
    w.writeUInt32(0x80006666); // real container guid (payload)
    w.writeUInt32(1);
    w.writeUInt32(0x80007777); // item guid
    w.writeUInt32(2);          // containerType (Foci)

    // Header objectGuid is always the player's own guid per GameEventMessage's
    // base ctor -- deliberately different from the payload's container guid
    // to prove the handler doesn't fall back to the header field.
    const playerGuid = 0x50009999;
    handler.handleMessage(event(GameEventType.ViewContents, playerGuid, w.toBuffer()));

    expect(calls).toHaveLength(1);
    expect(calls[0].containerGuid).toBe(0x80006666);
    expect(calls[0].containerGuid).not.toBe(playerGuid);
    expect(calls[0].items).toEqual([{ guid: 0x80007777, containerType: 2 }]);
  });

  it('does not fire onViewContents when the payload is malformed', () => {
    const w = new BinaryWriter(2);
    w.writeUInt16(0); // too short for even the containerGuid field
    handler.handleMessage(event(GameEventType.ViewContents, 0x5000aaaa, w.toBuffer()));
    expect(calls).toHaveLength(0);
  });
});
