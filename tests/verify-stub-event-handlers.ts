/**
 * FAITHFUL.63 — Pin tests for the four newly-wired GameEvent handlers that
 * were previously stub fall-throughs in ServerMessageHandler:
 *
 *   - GameEventCloseGroundContainer             (uint32 containerGuid)
 *   - GameEventAllegianceLoginNotification      (uint32 playerGuid + uint32 isLoggedIn)
 *   - GameEventMagicUpdateMultipleEnchantments  (uint32 count + N × Enchantment)
 *   - GameEventMagicRemoveSpell                 (uint16 spellId + uint16 layer)
 *
 * Wire formats anchored against:
 *   reference/ACE/Source/ACE.Server/Network/GameEvent/Events/GameEventCloseGroundContainer.cs
 *   reference/ACE/Source/ACE.Server/Network/GameEvent/Events/GameEventAllegianceLoginNotification.cs
 *   reference/ACE/Source/ACE.Server/Network/GameEvent/Events/GameEventMagicUpdateMultipleEnchantments.cs
 *   reference/ACE/Source/ACE.Server/Network/GameEvent/Events/GameEventMagicRemoveSpell.cs
 *   reference/ACE/Source/ACE.Server/Network/Structure/Enchantment.cs (per-record Write)
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

describe('CloseGroundContainer handler', () => {
  it('parses uint32 containerGuid', () => {
    const h = new ServerMessageHandler();
    let captured: any = null;
    h.setHandlers({ onCloseGroundContainer: (d) => { captured = d; } });

    const w = new BinaryWriter(4);
    w.writeUInt32(0xCAFEBABE);
    h.handleMessage(event(GameEventType.CloseGroundContainer, w.toBuffer()));

    expect(captured).toEqual({ containerGuid: 0xCAFEBABE });
  });
});

describe('AllegianceLoginNotification handler', () => {
  it('parses playerGuid + isLoggedIn=true', () => {
    const h = new ServerMessageHandler();
    let captured: any = null;
    h.setHandlers({ onAllegianceLoginNotification: (d) => { captured = d; } });

    const w = new BinaryWriter(8);
    w.writeUInt32(0x50000123);
    w.writeUInt32(1);
    h.handleMessage(event(GameEventType.AllegianceLoginNotification, w.toBuffer()));

    expect(captured).toEqual({ playerGuid: 0x50000123, isLoggedIn: true });
  });

  it('parses isLoggedIn=false (player went offline)', () => {
    const h = new ServerMessageHandler();
    let captured: any = null;
    h.setHandlers({ onAllegianceLoginNotification: (d) => { captured = d; } });

    const w = new BinaryWriter(8);
    w.writeUInt32(0x50000124);
    w.writeUInt32(0);
    h.handleMessage(event(GameEventType.AllegianceLoginNotification, w.toBuffer()));

    expect(captured).toEqual({ playerGuid: 0x50000124, isLoggedIn: false });
  });

  it('treats non-zero isLoggedIn as true (defensive against truthy values)', () => {
    const h = new ServerMessageHandler();
    let captured: any = null;
    h.setHandlers({ onAllegianceLoginNotification: (d) => { captured = d; } });

    const w = new BinaryWriter(8);
    w.writeUInt32(0xDEADBEEF);
    w.writeUInt32(0xFFFFFFFF); // ACE always writes 0/1 via Convert.ToUInt32, but be tolerant
    h.handleMessage(event(GameEventType.AllegianceLoginNotification, w.toBuffer()));

    expect(captured.isLoggedIn).toBe(true);
  });
});

describe('MagicRemoveSpell handler', () => {
  it('parses uint16 spellId + uint16 layer', () => {
    const h = new ServerMessageHandler();
    let captured: any = null;
    h.setHandlers({ onMagicRemoveSpell: (d) => { captured = d; } });

    const w = new BinaryWriter(4);
    w.writeUInt16(0x07D1); // 2001 — arbitrary spell id
    w.writeUInt16(2);
    h.handleMessage(event(GameEventType.MagicRemoveSpell, w.toBuffer()));

    expect(captured).toEqual({ spellId: 0x07D1, layer: 2 });
  });

  it('handles short payloads gracefully (layer omitted)', () => {
    // ACE Writer always emits 4 bytes (spellId + layer); but a malformed
    // server could ship a 2-byte payload. Handler should default layer=0.
    const h = new ServerMessageHandler();
    let captured: any = null;
    h.setHandlers({ onMagicRemoveSpell: (d) => { captured = d; } });

    const w = new BinaryWriter(2);
    w.writeUInt16(0x07D2);
    h.handleMessage(event(GameEventType.MagicRemoveSpell, w.toBuffer()));

    expect(captured).toEqual({ spellId: 0x07D2, layer: 0 });
  });
});

describe('MagicUpdateMultipleEnchantments handler', () => {
  // Helper that writes one Enchantment record matching ACE Enchantment.Write():
  //   uint16 spellId, uint16 layer, uint16 spellCategory, uint16 hasSpellSetID,
  //   uint32 powerLevel, double startTime, double duration, uint32 casterGuid,
  //   float degradeModifier, float degradeLimit, double lastTimeDegraded,
  //   uint32 statModType, uint32 statModKey, float statModValue,
  //   [if hasSpellSetID != 0] uint32 spellSetID
  function writeEnchantment(w: BinaryWriter, opts: {
    spellId: number; layer: number; spellCategory: number; hasSpellSetId: number;
    powerLevel: number; statModType: number; statModKey: number; statModValue: number;
    spellSetId?: number;
  }): void {
    w.writeUInt16(opts.spellId);
    w.writeUInt16(opts.layer);
    w.writeUInt16(opts.spellCategory);
    w.writeUInt16(opts.hasSpellSetId);
    w.writeUInt32(opts.powerLevel);
    w.writeFloat64(0); // startTime
    w.writeFloat64(60); // duration
    w.writeUInt32(0); // casterGuid
    w.writeFloat32(0); // degradeModifier
    w.writeFloat32(0); // degradeLimit
    w.writeFloat64(0); // lastTimeDegraded
    w.writeUInt32(opts.statModType);
    w.writeUInt32(opts.statModKey);
    w.writeFloat32(opts.statModValue);
    if (opts.hasSpellSetId !== 0) {
      w.writeUInt32(opts.spellSetId ?? 0);
    }
  }

  it('parses count = 0 (empty enchantment list)', () => {
    const h = new ServerMessageHandler();
    let captured: any = null;
    h.setHandlers({ onMagicUpdateMultipleEnchantments: (d) => { captured = d; } });

    const w = new BinaryWriter(4);
    w.writeUInt32(0);
    h.handleMessage(event(GameEventType.MagicUpdateMultipleEnchantments, w.toBuffer()));

    expect(captured).toEqual({ enchantments: [] });
  });

  it('parses a single enchantment record', () => {
    const h = new ServerMessageHandler();
    let captured: any = null;
    h.setHandlers({ onMagicUpdateMultipleEnchantments: (d) => { captured = d; } });

    const w = new BinaryWriter(128);
    w.writeUInt32(1);
    writeEnchantment(w, {
      spellId: 0x0123, layer: 1, spellCategory: 0x42, hasSpellSetId: 0,
      powerLevel: 100, statModType: 0, statModKey: 0, statModValue: 1.5,
    });

    h.handleMessage(event(GameEventType.MagicUpdateMultipleEnchantments, w.toBuffer()));

    expect(captured.enchantments.length).toBe(1);
    expect(captured.enchantments[0].spellId).toBe(0x0123);
    expect(captured.enchantments[0].layer).toBe(1);
    expect(captured.enchantments[0].spellCategory).toBe(0x42);
    expect(captured.enchantments[0].powerLevel).toBe(100);
    expect(captured.enchantments[0].statModValue).toBeCloseTo(1.5, 4);
  });

  it('parses multiple enchantment records', () => {
    const h = new ServerMessageHandler();
    let captured: any = null;
    h.setHandlers({ onMagicUpdateMultipleEnchantments: (d) => { captured = d; } });

    const w = new BinaryWriter(256);
    w.writeUInt32(3);
    writeEnchantment(w, {
      spellId: 0x0001, layer: 1, spellCategory: 1, hasSpellSetId: 0,
      powerLevel: 50, statModType: 0, statModKey: 0, statModValue: 1.0,
    });
    writeEnchantment(w, {
      spellId: 0x0002, layer: 2, spellCategory: 2, hasSpellSetId: 0,
      powerLevel: 100, statModType: 0, statModKey: 0, statModValue: 2.0,
    });
    writeEnchantment(w, {
      spellId: 0x0003, layer: 3, spellCategory: 3, hasSpellSetId: 1,
      powerLevel: 150, statModType: 0, statModKey: 0, statModValue: 3.0,
      spellSetId: 0xABCD1234,
    });

    h.handleMessage(event(GameEventType.MagicUpdateMultipleEnchantments, w.toBuffer()));

    expect(captured.enchantments.length).toBe(3);
    expect(captured.enchantments[0].spellId).toBe(0x0001);
    expect(captured.enchantments[1].spellId).toBe(0x0002);
    expect(captured.enchantments[2].spellId).toBe(0x0003);
    expect(captured.enchantments[2].spellSetId).toBe(0xABCD1234); // the one with hasSpellSetId
    expect(captured.enchantments[0].spellSetId).toBe(0); // not sent for hasSpellSetId=0
  });
});
