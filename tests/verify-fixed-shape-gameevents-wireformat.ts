/**
 * GAP.86 — Behavioral byte-level coverage for a batch of fixed-shape,
 * non-String16L inbound GameEvent parsers that had either ZERO test
 * coverage anywhere in the suite, or only a downstream source-grep pin
 * that regex-matches main.ts consumer logic without ever exercising the
 * actual ServerMessageHandler byte parse:
 *
 * 1. GameEventUpdateHealth (0x02BB) — per `GameEventUpdateHealth.cs:8-9`,
 *    wire is `u32 objectid + float32 health`. Had zero test coverage
 *    anywhere (onUpdateHealth had no reference outside its own
 *    definition site).
 *
 * 2. GameEventItemServerSaysContainId (0x0019, GameEventType
 *    .InventoryPutObjInContainer) — per
 *    `GameEventItemServerSaysContainId.cs:11-14`, wire is
 *    `WriteGuid(item) + WriteGuid(container) + u32 placementPosition
 *    + u32 containerType`. Had zero test coverage.
 *
 * 3. GameEventItemServerSaysMoveItem (0x0017, GameEventType
 *    .InventoryPutObjectIn3D) — per
 *    `GameEventItemServerSaysMoveItem.cs:11`, wire is a single
 *    `WriteGuid(item)`. Had zero test coverage.
 *
 * 4. GameEventWieldItem (0x0018, GameEventType.WieldObject) — per
 *    `GameEventWieldItem.cs:9-10`, wire is `u32 objectId + int32
 *    (EquipMask)newLocation`. The only existing reference
 *    (verify-wield-unwield-sound.ts, FAITHFUL.419) is a source-grep pin
 *    on main.ts's onWieldObject *consumer* callback — it never drives a
 *    real byte payload through ServerMessageHandler.
 *
 * 5. GameEventUseDone (0x0195) — per `GameEventUseDone.cs:9`, wire is a
 *    single `u32 (WeenieError)errorType`. The only existing references
 *    (verify-use-done-surfaces-error.ts FAITHFUL.386,
 *    verify-error-chime-coverage.ts) are source-grep pins on main.ts's
 *    onUseDone consumer, never the actual wire parse.
 *
 * 6. GameEventCombatCommenceAttack (0x02CA) — per
 *    `GameEventCombatCommenceAttack.cs:6-8`, a 4-byte header-only event
 *    with no payload fields at all (base size 4 = the GameEvent header
 *    itself). Had zero test coverage anywhere.
 *
 * 7. GameEventPingResponse (0x01EA) — per `GameEventPingResponse.cs:6`,
 *    also 4-byte header-only. The only existing reference
 *    (verify-server-load-indicator.ts) is a source-grep pin asserting
 *    the handler is *declared*, never that handleMessage() actually
 *    fires it on a real header-only event.
 *
 * All 7 parsers were confirmed to already match ACE C# write order
 * exactly — this cycle closes test-coverage gaps only, no code fix
 * required.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { BinaryWriter, GameEventType, GameMessageOpcode } from '@ac/network';

let seq = 200;
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

describe('UpdateHealth wire-format (GAP.86)', () => {
  let handler: ServerMessageHandler;
  const calls: any[] = [];

  beforeEach(() => {
    calls.length = 0;
    handler = new ServerMessageHandler();
    handler.setHandlers({ onUpdateHealth: (d) => calls.push(d) });
  });

  it('parses guid u32 + healthFraction float32', () => {
    const w = new BinaryWriter(8);
    w.writeUInt32(0x50001234);
    w.writeFloat32(0.75);
    handler.handleMessage(event(GameEventType.UpdateHealth, w.toBuffer()));
    expect(calls).toHaveLength(1);
    expect(calls[0].guid).toBe(0x50001234);
    expect(calls[0].healthFraction).toBeCloseTo(0.75, 6);
  });

  it('parses a zero (dead) health fraction', () => {
    const w = new BinaryWriter(8);
    w.writeUInt32(0x50005678);
    w.writeFloat32(0);
    handler.handleMessage(event(GameEventType.UpdateHealth, w.toBuffer()));
    expect(calls[0]).toEqual({ guid: 0x50005678, healthFraction: 0 });
  });
});

describe('InventoryPutObjInContainer wire-format (GAP.86)', () => {
  let handler: ServerMessageHandler;
  const calls: any[] = [];

  beforeEach(() => {
    calls.length = 0;
    handler = new ServerMessageHandler();
    handler.setHandlers({ onInventoryPut: (d) => calls.push(d) });
  });

  it('parses itemGuid + containerGuid + placementPosition(slot) + containerType(itemType), in that order', () => {
    const w = new BinaryWriter(16);
    w.writeUInt32(0x80001111); // item
    w.writeUInt32(0x80002222); // container
    w.writeUInt32(3);          // placementPosition -> slot
    w.writeUInt32(2);          // containerType -> itemType
    handler.handleMessage(event(GameEventType.InventoryPutObjInContainer, w.toBuffer()));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      itemGuid: 0x80001111,
      containerGuid: 0x80002222,
      slot: 3,
      itemType: 2,
    });
  });
});

describe('InventoryPutObjectIn3D wire-format (GAP.86)', () => {
  it('parses a single itemGuid u32', () => {
    const handler = new ServerMessageHandler();
    let captured: any = null;
    handler.setHandlers({ onInventoryPutIn3D: (d) => { captured = d; } });

    const w = new BinaryWriter(4);
    w.writeUInt32(0x80003333);
    handler.handleMessage(event(GameEventType.InventoryPutObjectIn3D, w.toBuffer()));

    expect(captured).toEqual({ itemGuid: 0x80003333 });
  });
});

describe('WieldObject wire-format (GAP.86)', () => {
  let handler: ServerMessageHandler;
  const calls: any[] = [];

  beforeEach(() => {
    calls.length = 0;
    handler = new ServerMessageHandler();
    handler.setHandlers({ onWieldObject: (d) => calls.push(d) });
  });

  it('parses itemGuid u32 + location (EquipMask) as int32', () => {
    const w = new BinaryWriter(8);
    w.writeUInt32(0x80004444);
    w.writeInt32(0x00040000); // EquipMask.MeleeWeapon-ish bit pattern, value not load-bearing
    handler.handleMessage(event(GameEventType.WieldObject, w.toBuffer()));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ itemGuid: 0x80004444, location: 0x00040000 });
  });
});

describe('UseDone wire-format (GAP.86)', () => {
  let handler: ServerMessageHandler;
  const calls: any[] = [];

  beforeEach(() => {
    calls.length = 0;
    handler = new ServerMessageHandler();
    handler.setHandlers({ onUseDone: (d) => calls.push(d) });
  });

  it('parses a single u32 (WeenieError) errorType', () => {
    const w = new BinaryWriter(4);
    w.writeUInt32(0); // WeenieError.None
    handler.handleMessage(event(GameEventType.UseDone, w.toBuffer()));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ errorType: 0 });
  });

  it('parses a non-zero errorType (a real failure code)', () => {
    const w = new BinaryWriter(4);
    w.writeUInt32(29); // WeenieError.YouAreTooEncumbered-ish, value not load-bearing
    handler.handleMessage(event(GameEventType.UseDone, w.toBuffer()));
    expect(calls[0]).toEqual({ errorType: 29 });
  });
});

describe('CombatCommenceAttack wire-format (GAP.86)', () => {
  it('is a 4-byte header-only event with no payload fields; the arrival alone is the signal', () => {
    const handler = new ServerMessageHandler();
    let fired = 0;
    handler.setHandlers({ onCombatCommenceAttack: () => { fired++; } });

    handler.handleMessage(event(GameEventType.CombatCommenceAttack, new Uint8Array(0)));

    expect(fired).toBe(1);
  });
});

describe('PingResponse wire-format (GAP.86)', () => {
  it('is a 4-byte header-only event; handleMessage actually fires onPingResponse on a real event, not just a declared-handler pin', () => {
    const handler = new ServerMessageHandler();
    let fired = 0;
    handler.setHandlers({ onPingResponse: () => { fired++; } });

    handler.handleMessage(event(GameEventType.PingResponse, new Uint8Array(0)));

    expect(fired).toBe(1);
  });

  it('does not fire when no handler is registered (no throw on empty handlers)', () => {
    const handler = new ServerMessageHandler();
    handler.setHandlers({});
    expect(() => handler.handleMessage(event(GameEventType.PingResponse, new Uint8Array(0)))).not.toThrow();
  });
});
