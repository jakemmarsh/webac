/**
 * COMBAT.6 — AttackerNotification / DefenderNotification deserializer.
 *
 * Anchors the wire format against ACE C# server-side serialization in
 *   reference/ACE/Source/ACE.Server/Network/GameEvent/Events/GameEventAttackerNotification.cs
 *   reference/ACE/Source/ACE.Server/Network/GameEvent/Events/GameEventDefenderNotification.cs
 *
 * Specifically guards against the original COMBAT.2 bug: client was reading the
 * `percent` field as a 4-byte float32 when ACE serializes it as an 8-byte
 * double, causing 4-byte slippage and ~1.07e9 garbage damage values.
 */
import { describe, it, expect } from 'vitest';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { BinaryWriter, GameMessageOpcode } from '@ac/network';

function buildAttackerNotificationPayload(
  defenderName: string,
  damageType: number,
  percent: number,
  damage: number,
  critical: boolean,
  attackConditions: number,
): Uint8Array {
  const w = new BinaryWriter(80);
  w.writeString16(defenderName);
  w.writeUInt32(damageType);
  w.writeFloat64(percent); // ACE: double
  w.writeUInt32(damage);
  w.writeUInt32(critical ? 1 : 0);
  // ACE: ulong attackConditions (8 bytes). We always send the low 32 bits + 4 zero bytes
  // since the AttackConditions flags fit in 4 bits.
  w.writeUInt32(attackConditions);
  w.writeUInt32(0);
  return w.toBuffer();
}

function buildDefenderNotificationPayload(
  attackerName: string,
  damageType: number,
  percent: number,
  damage: number,
  damageLocation: number,
  critical: boolean,
  attackConditions: number,
): Uint8Array {
  const w = new BinaryWriter(80);
  w.writeString16(attackerName);
  w.writeUInt32(damageType);
  w.writeFloat64(percent);
  w.writeUInt32(damage);
  w.writeUInt32(damageLocation);
  w.writeUInt32(critical ? 1 : 0);
  w.writeUInt32(attackConditions);
  w.writeUInt32(0);
  return w.toBuffer();
}

describe('handleAttackerNotification', () => {
  it('parses a swing-landed packet exactly as ACE serializes it', () => {
    const handler = new ServerMessageHandler();
    let captured: any = null;
    handler.setHandlers({ onAttackerNotification: (data) => { captured = data; } });

    const payload = buildAttackerNotificationPayload(
      'White Rat',
      0x0004, // bludgeon
      0.42,    // percent — typical 42% of max HP
      127,     // damage
      false,
      0,
    );

    handler.handleMessage({
      type: 'event',
      opcode: GameMessageOpcode.GameEvent,
      objectGuid: 0,
      sequence: 1,
      eventType: 0x01B1, // AttackerNotification
      payload,
    });

    expect(captured).not.toBeNull();
    expect(captured.defenderName).toBe('White Rat');
    expect(captured.damageType).toBe(0x0004);
    expect(captured.severity).toBeCloseTo(0.42, 5);
    expect(captured.damage).toBe(127);
    expect(captured.critical).toBe(false);
    expect(captured.attackConditions).toBe(0);
    // AttackerNotification has NO body part — we expose 0
    expect(captured.bodyPart).toBe(0);
  });

  it('reads critical-hit flag and reasonable damage (regression for the 1.07e9 bug)', () => {
    const handler = new ServerMessageHandler();
    let captured: any = null;
    handler.setHandlers({ onAttackerNotification: (data) => { captured = data; } });

    const payload = buildAttackerNotificationPayload(
      'White Rat',
      0x0004,
      0.95,
      287, // single-digit / few-hundred damage values are the realistic AC range
      true,
      0x4, // SneakAttack flag
    );

    handler.handleMessage({
      type: 'event',
      opcode: GameMessageOpcode.GameEvent,
      objectGuid: 0,
      sequence: 1,
      eventType: 0x01B1,
      payload,
    });

    expect(captured.damage).toBe(287);
    expect(captured.damage).toBeLessThan(1_000_000); // can't be the slipped-bytes garbage
    expect(captured.critical).toBe(true);
    expect(captured.attackConditions).toBe(0x4);
  });
});

describe('handleDefenderNotification', () => {
  it('parses a swing-taken packet with body part and reasonable damage', () => {
    const handler = new ServerMessageHandler();
    let captured: any = null;
    handler.setHandlers({ onDefenderNotification: (data) => { captured = data; } });

    const payload = buildDefenderNotificationPayload(
      'White Rat',
      0x0002, // pierce
      0.18,
      5,        // ~5 HP damage from a level-4 rat
      4,        // damage location: chest
      false,
      0,
    );

    handler.handleMessage({
      type: 'event',
      opcode: GameMessageOpcode.GameEvent,
      objectGuid: 0,
      sequence: 1,
      eventType: 0x01B2, // DefenderNotification
      payload,
    });

    expect(captured).not.toBeNull();
    expect(captured.attackerName).toBe('White Rat');
    expect(captured.damageType).toBe(0x0002);
    expect(captured.severity).toBeCloseTo(0.18, 5);
    expect(captured.damage).toBe(5);
    expect(captured.damage).toBeLessThan(1_000_000); // not the 1.07e9 garbage
    expect(captured.bodyPart).toBe(4);
    expect(captured.critical).toBe(false);
    expect(captured.attackConditions).toBe(0);
  });
});
