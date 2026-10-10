/**
 * FAITHFUL.2 — Inbound trade & salvage GameEvent deserialization.
 *
 * Anchors the wire formats against ACE C# server-side serialization:
 *   reference/ACE/Source/ACE.Server/Network/GameEvent/Events/GameEventRegisterTrade.cs
 *   reference/ACE/Source/ACE.Server/Network/GameEvent/Events/GameEventAddToTrade.cs
 *   reference/ACE/Source/ACE.Server/Network/GameEvent/Events/GameEventAcceptTrade.cs
 *   reference/ACE/Source/ACE.Server/Network/GameEvent/Events/GameEventDeclineTrade.cs
 *   reference/ACE/Source/ACE.Server/Network/GameEvent/Events/GameEventResetTrade.cs
 *   reference/ACE/Source/ACE.Server/Network/GameEvent/Events/GameEventCloseTrade.cs
 *   reference/ACE/Source/ACE.Server/Network/GameEvent/Events/GameEventClearTradeAcceptance.cs
 *   reference/ACE/Source/ACE.Server/Network/GameEvent/Events/GameEventTradeFailure.cs
 *   reference/ACE/Source/ACE.Server/Network/GameEvent/Events/GameEventSalvageOperationsResult.cs
 *   reference/ACE/Source/ACE.Server/Network/Structure/SalvageResult.cs
 *
 * Each ACE.WriteGuid serializes the 4-byte ObjectGuid.Full uint32 — NOT 8 bytes
 * (the constructor's `size` parameter is just an initial buffer hint).
 */
import { describe, it, expect } from 'vitest';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { BinaryWriter, GameMessageOpcode, GameEventType } from '@ac/network';

function event(eventType: number, payload: Uint8Array) {
  return {
    type: 'event' as const,
    opcode: GameMessageOpcode.GameEvent as GameMessageOpcode.GameEvent,
    objectGuid: 0,
    sequence: 1,
    eventType,
    payload,
  };
}

describe('Inbound trade GameEvents (ACE-anchored)', () => {
  it('RegisterTrade: initiatorGuid u32 + partnerGuid u32', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onRegisterTrade: (d) => { cap = d; } });

    const w = new BinaryWriter(16);
    w.writeUInt32(0x80001111); // initiator
    w.writeUInt32(0x80002222); // partner
    // The trailing 8-byte 0L is ignored by the client (no-op).
    h.handleMessage(event(GameEventType.RegisterTrade, w.toBuffer()));

    expect(cap.initiatorGuid).toBe(0x80001111);
    expect(cap.partnerGuid).toBe(0x80002222);
  });

  it('AddToTrade: objectGuid u32 + tradeSide u32 + slot u32', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onAddToTrade: (d) => { cap = d; } });

    const w = new BinaryWriter(12);
    w.writeUInt32(0x80009999);
    w.writeUInt32(1); // TradeSide.Self
    w.writeUInt32(3); // slot
    h.handleMessage(event(GameEventType.AddToTrade, w.toBuffer()));

    expect(cap.objectGuid).toBe(0x80009999);
    expect(cap.tradeSide).toBe(1);
    expect(cap.slot).toBe(3);
  });

  it('AcceptTrade event: whoAcceptedGuid u32', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onAcceptTradeEvt: (d) => { cap = d; } });

    const w = new BinaryWriter(4);
    w.writeUInt32(0x80001234);
    h.handleMessage(event(GameEventType.AcceptTrade, w.toBuffer()));

    expect(cap.whoAcceptedGuid).toBe(0x80001234);
  });

  it('DeclineTrade event: whoDeclinedGuid u32', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onDeclineTradeEvt: (d) => { cap = d; } });

    const w = new BinaryWriter(4);
    w.writeUInt32(0x80005678);
    h.handleMessage(event(GameEventType.DeclineTrade, w.toBuffer()));

    expect(cap.whoDeclinedGuid).toBe(0x80005678);
  });

  it('ResetTrade event: whoResetGuid u32', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onResetTradeEvt: (d) => { cap = d; } });

    const w = new BinaryWriter(4);
    w.writeUInt32(0x80000abc);
    h.handleMessage(event(GameEventType.ResetTrade, w.toBuffer()));

    expect(cap.whoResetGuid).toBe(0x80000abc);
  });

  it('CloseTrade event: endTradeReason u32 (Normal=1, EnteredCombat=2, Canceled=0x51)', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onCloseTradeEvt: (d) => { cap = d; } });

    for (const reason of [1, 2, 0x51]) {
      const w = new BinaryWriter(4);
      w.writeUInt32(reason);
      h.handleMessage(event(GameEventType.CloseTrade, w.toBuffer()));
      expect(cap.endReason).toBe(reason);
    }
  });

  it('ClearTradeAcceptance event: no payload', () => {
    const h = new ServerMessageHandler();
    let cap = false;
    h.setHandlers({ onClearTradeAcceptance: () => { cap = true; } });

    h.handleMessage(event(GameEventType.ClearTradeAcceptance, new Uint8Array(0)));
    expect(cap).toBe(true);
  });

  it('TradeFailure event: objectGuid u32 + WeenieError u32', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onTradeFailure: (d) => { cap = d; } });

    const w = new BinaryWriter(8);
    w.writeUInt32(0x80007777);
    w.writeUInt32(0x04C3); // YouCannotSalvageItemsInTrading (just a real WeenieError)
    h.handleMessage(event(GameEventType.TradeFailure, w.toBuffer()));

    expect(cap.objectGuid).toBe(0x80007777);
    expect(cap.reason).toBe(0x04C3);
  });
});

describe('SalvageOperationsResult (ACE-anchored)', () => {
  it('parses skill + result list + bonus', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onSalvageResult: (d) => { cap = d; } });

    // Skill 50 = Salvaging, two material results, bonus 75
    const w = new BinaryWriter(64);
    w.writeUInt32(50);   // skill
    w.writeUInt32(0);    // unused not-salvageable count
    w.writeUInt32(2);    // result count
    // Result 1: MaterialType=64 Steel, workmanship=7.5, units=42
    w.writeUInt32(64);
    w.writeFloat64(7.5);
    w.writeUInt32(42);
    // Result 2: MaterialType=68 Marble, workmanship=3.0, units=7
    w.writeUInt32(68);
    w.writeFloat64(3.0);
    w.writeUInt32(7);
    w.writeUInt32(75);   // AugmentationBonusSalvage * 25

    h.handleMessage(event(GameEventType.SalvageOperationsResult, w.toBuffer()));

    expect(cap.skill).toBe(50);
    expect(cap.bonusSalvage).toBe(75);
    expect(cap.results.length).toBe(2);
    expect(cap.results[0]).toEqual({ materialType: 64, workmanship: 7.5, units: 42 });
    expect(cap.results[1]).toEqual({ materialType: 68, workmanship: 3.0, units: 7 });
  });

  it('handles zero-result salvage (player tried but nothing salvageable)', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onSalvageResult: (d) => { cap = d; } });

    const w = new BinaryWriter(16);
    w.writeUInt32(50);  // skill
    w.writeUInt32(0);
    w.writeUInt32(0);   // zero results
    w.writeUInt32(0);   // bonus

    h.handleMessage(event(GameEventType.SalvageOperationsResult, w.toBuffer()));

    expect(cap.results.length).toBe(0);
    expect(cap.bonusSalvage).toBe(0);
  });
});
