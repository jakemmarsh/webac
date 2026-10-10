/**
 * GAP.86 — behavioral wire-format coverage for the enchantment-lifecycle
 * GameEvents that previously had zero test coverage (only case-presence
 * checks in verify-event-dispatcher-coverage.ts / verify-stub-event-handlers.ts):
 *   MagicUpdateEnchantment (0x02C2), MagicRemoveEnchantment (0x02C3),
 *   MagicPurgeEnchantments (0x02C6), MagicRemoveMultipleEnchantments (0x02C5),
 *   MagicPurgeBadEnchantments (0x0312).
 *
 * Wire formats anchored against:
 *   reference/ACE/Source/ACE.Server/Network/Structure/Enchantment.cs (EnchantmentExtensions.Write)
 *   reference/ACE/Source/ACE.Server/Network/Structure/LayeredSpell.cs (LayeredSpellExtensions.Write(List<LayeredSpell>))
 *   reference/ACE/Source/ACE.Server/Network/GameEvent/Events/GameEventMagicUpdateEnchantment.cs
 *   reference/ACE/Source/ACE.Server/Network/GameEvent/Events/GameEventMagicRemoveEnchantment.cs
 *   reference/ACE/Source/ACE.Server/Network/GameEvent/Events/GameEventMagicPurgeEnchantments.cs
 *   reference/ACE/Source/ACE.Server/Network/GameEvent/Events/GameEventMagicRemoveMultipleEnchantments.cs
 *   reference/ACE/Source/ACE.Server/Network/GameEvent/Events/GameEventMagicPurgeBadEnchantments.cs
 *
 * Enchantment.Write order: SpellID u16, Layer u16, SpellCategory u16,
 * HasSpellSetID u16, PowerLevel u32, StartTime f64, Duration f64,
 * CasterGuid u32, DegradeModifier f32, DegradeLimit f32,
 * LastTimeDegraded f64, StatModType u32, StatModKey u32, StatModValue f32,
 * [if HasSpellSetID != 0] SpellSetID u32.
 */
import { describe, it, expect } from 'vitest';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { BinaryWriter, GameMessageOpcode, GameEventType, EnchantmentTypeFlags } from '@ac/network';

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

function writeEnchantment(w: BinaryWriter, e: {
  spellId: number; layer: number; spellCategory: number; hasSpellSetId: number;
  powerLevel: number; startTime: number; duration: number; casterGuid: number;
  degradeModifier: number; degradeLimit: number; lastTimeDegraded: number;
  statModType: number; statModKey: number; statModValue: number; spellSetId?: number;
}): void {
  w.writeUInt16(e.spellId);
  w.writeUInt16(e.layer);
  w.writeUInt16(e.spellCategory);
  w.writeUInt16(e.hasSpellSetId);
  w.writeUInt32(e.powerLevel);
  w.writeFloat64(e.startTime);
  w.writeFloat64(e.duration);
  w.writeUInt32(e.casterGuid);
  w.writeFloat32(e.degradeModifier);
  w.writeFloat32(e.degradeLimit);
  w.writeFloat64(e.lastTimeDegraded);
  w.writeUInt32(e.statModType);
  w.writeUInt32(e.statModKey);
  w.writeFloat32(e.statModValue);
  if (e.hasSpellSetId !== 0) w.writeUInt32(e.spellSetId ?? 0);
}

describe('MagicUpdateEnchantment handler (0x02C2)', () => {
  it('parses a full Enchantment record with SpellSetID present', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onMagicUpdateEnchantment: (d) => { cap = d; } });

    const w = new BinaryWriter(80);
    writeEnchantment(w, {
      spellId: 1839, layer: 1, spellCategory: 25, hasSpellSetId: 1,
      powerLevel: 300, startTime: 12345.5, duration: 600.0, casterGuid: 0x50001234,
      degradeModifier: 0.02, degradeLimit: 0.5, lastTimeDegraded: 0,
      statModType: EnchantmentTypeFlags.Attribute | EnchantmentTypeFlags.Beneficial,
      statModKey: 4, statModValue: 30, spellSetId: 7,
    });
    h.handleMessage(event(GameEventType.MagicUpdateEnchantment, w.toBuffer()));

    expect(cap.enchantment).not.toBeNull();
    expect(cap.enchantment.spellId).toBe(1839);
    expect(cap.enchantment.layer).toBe(1);
    expect(cap.enchantment.spellCategory).toBe(25);
    expect(cap.enchantment.powerLevel).toBe(300);
    expect(cap.enchantment.startTime).toBeCloseTo(12345.5);
    expect(cap.enchantment.duration).toBeCloseTo(600.0);
    expect(cap.enchantment.casterGuid).toBe(0x50001234);
    expect(cap.enchantment.degradeModifier).toBeCloseTo(0.02, 5);
    expect(cap.enchantment.statModKey).toBe(4);
    expect(cap.enchantment.statModValue).toBeCloseTo(30);
    expect(cap.enchantment.spellSetId).toBe(7);
    expect(cap.enchantment.isBeneficial).toBe(true);
    expect(cap.enchantment.isVitae).toBe(false);
    expect(cap.enchantment.isCooldown).toBe(false);
  });

  it('omits the trailing SpellSetID field when hasSpellSetId is 0', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onMagicUpdateEnchantment: (d) => { cap = d; } });

    const w = new BinaryWriter(80);
    writeEnchantment(w, {
      spellId: 2647, layer: 0, spellCategory: 34, hasSpellSetId: 0,
      powerLevel: 50, startTime: 0, duration: -1, casterGuid: 0,
      degradeModifier: 0, degradeLimit: 0, lastTimeDegraded: 0,
      statModType: EnchantmentTypeFlags.Vitae, statModKey: 0, statModValue: 5,
    });
    // No trailing bytes -- the parser must not try to read a SpellSetID.
    h.handleMessage(event(GameEventType.MagicUpdateEnchantment, w.toBuffer()));

    expect(cap.enchantment.spellSetId).toBe(0);
    expect(cap.enchantment.isVitae).toBe(true);
    expect(cap.enchantment.duration).toBeCloseTo(-1);
  });
});

describe('MagicRemoveEnchantment handler (0x02C3)', () => {
  it('parses spellID u16 + layer u16 per GameEventMagicRemoveEnchantment.cs', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onMagicRemoveEnchantment: (d) => { cap = d; } });

    const w = new BinaryWriter(4);
    w.writeUInt16(1839);
    w.writeUInt16(2);
    h.handleMessage(event(GameEventType.MagicRemoveEnchantment, w.toBuffer()));

    expect(cap.spellId).toBe(1839);
    expect(cap.layerId).toBe(2);
  });
});

describe('MagicPurgeEnchantments handler (0x02C6)', () => {
  it('fires with no payload per GameEventMagicPurgeEnchantments.cs (header-only, size 4)', () => {
    const h = new ServerMessageHandler();
    let fired = false;
    h.setHandlers({ onMagicPurgeEnchantments: () => { fired = true; } });

    h.handleMessage(event(GameEventType.MagicPurgeEnchantments, new Uint8Array(0)));

    expect(fired).toBe(true);
  });
});

describe('MagicPurgeBadEnchantments handler (0x0312)', () => {
  it('fires with no payload per GameEventMagicPurgeBadEnchantments.cs (header-only, size 8)', () => {
    const h = new ServerMessageHandler();
    let fired = false;
    h.setHandlers({ onMagicPurgeBadEnchantments: () => { fired = true; } });

    h.handleMessage(event(GameEventType.MagicPurgeBadEnchantments, new Uint8Array(0)));

    expect(fired).toBe(true);
  });

  it('dispatches distinctly from MagicPurgeEnchantments (does not also fire it)', () => {
    const h = new ServerMessageHandler();
    let purgeAll = false;
    let purgeBad = false;
    h.setHandlers({
      onMagicPurgeEnchantments: () => { purgeAll = true; },
      onMagicPurgeBadEnchantments: () => { purgeBad = true; },
    });

    h.handleMessage(event(GameEventType.MagicPurgeBadEnchantments, new Uint8Array(0)));

    expect(purgeBad).toBe(true);
    expect(purgeAll).toBe(false);
  });
});

describe('MagicRemoveMultipleEnchantments handler (0x02C5)', () => {
  it('parses count u32 + N x LayeredSpell (spellId u16 + layer u16)', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onMagicRemoveMultipleEnchantments: (d) => { cap = d; } });

    const w = new BinaryWriter(32);
    w.writeUInt32(3);
    w.writeUInt16(1839); w.writeUInt16(1);
    w.writeUInt16(2647); w.writeUInt16(1);
    w.writeUInt16(3865); w.writeUInt16(2);
    h.handleMessage(event(GameEventType.MagicRemoveMultipleEnchantments, w.toBuffer()));

    expect(cap.enchantments).toHaveLength(3);
    expect(cap.enchantments[0]).toEqual({ spellId: 1839, layerId: 1 });
    expect(cap.enchantments[1]).toEqual({ spellId: 2647, layerId: 1 });
    expect(cap.enchantments[2]).toEqual({ spellId: 3865, layerId: 2 });
  });

  it('handles a zero-count list', () => {
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onMagicRemoveMultipleEnchantments: (d) => { cap = d; } });

    const w = new BinaryWriter(4);
    w.writeUInt32(0);
    h.handleMessage(event(GameEventType.MagicRemoveMultipleEnchantments, w.toBuffer()));

    expect(cap.enchantments).toEqual([]);
  });
});
