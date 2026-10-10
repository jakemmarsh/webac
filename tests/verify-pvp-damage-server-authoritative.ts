/**
 * GAP.65 — [PK/PvP] PK combat damage rules.
 *
 * PREMISE CORRECTION: "No client-side PvP-vs-PvE damage differentiation
 * anywhere" is CORRECT, faithful behavior — NOT a missing feature. In
 * AC/ACE every PvP damage modifier is computed SERVER-SIDE:
 *   - ACE DamageEvent.cs:239-243 applies PkDamageMod (attacker's PK damage
 *     rating) only inside `if (pkBattle)`, and :356 applies
 *     PkDamageResistanceMod (defender's PK damage-resist rating). The final
 *     mitigated integer is all the server sends.
 *   - The AttackerNotification / DefenderNotification wire format
 *     (GameEventAttackerNotification.cs / GameEventDefenderNotification.cs)
 *     carries ONLY: name, damageType(uint), percent(double), damage(uint),
 *     [damageLocation(uint) — defender only], critical(uint),
 *     attackConditions(ulong). There is NO PvP/PK field, and AttackConditions
 *     (None/CriticalProtectionAugmentation/Recklessness/SneakAttack/Overpower)
 *     has no PvP flag either.
 *
 * Therefore the client must NOT compute or differentiate PvP vs PvE damage —
 * it renders the server-sent number verbatim. This test proves that
 * faithfulness property against the SHIPPED parser + formatters: the client
 * is blind to PvP context, so byte-identical payloads render identical damage
 * whether the opponent is a player or a monster, and the exact server integer
 * appears unmodified (no client-side halving/scaling).
 */
import { describe, it, expect } from 'vitest';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { BinaryWriter, GameMessageOpcode } from '@ac/network';
import { formatAttackerChat, formatDefenderChat, DamageType } from '@ac/shared';

const ATTACKER_NOTIFICATION = 0x01B1;
const DEFENDER_NOTIFICATION = 0x01B2;

function attackerPayload(defenderName: string, damageType: number, percent: number, damage: number, critical: boolean, attackConditions: number): Uint8Array {
  const w = new BinaryWriter(80);
  w.writeString16(defenderName);
  w.writeUInt32(damageType);
  w.writeFloat64(percent);   // ACE: double
  w.writeUInt32(damage);
  w.writeUInt32(critical ? 1 : 0);
  w.writeUInt32(attackConditions);
  w.writeUInt32(0);          // upper 32 bits of the ulong
  return w.toBuffer();
}

function defenderPayload(attackerName: string, damageType: number, percent: number, damage: number, damageLocation: number, critical: boolean, attackConditions: number): Uint8Array {
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

function driveAttacker(payload: Uint8Array): any {
  const handler = new ServerMessageHandler();
  let captured: any = null;
  handler.setHandlers({ onAttackerNotification: (d) => { captured = d; } });
  handler.handleMessage({ type: 'event', opcode: GameMessageOpcode.GameEvent, objectGuid: 0, sequence: 1, eventType: ATTACKER_NOTIFICATION, payload });
  return captured;
}
function driveDefender(payload: Uint8Array): any {
  const handler = new ServerMessageHandler();
  let captured: any = null;
  handler.setHandlers({ onDefenderNotification: (d) => { captured = d; } });
  handler.handleMessage({ type: 'event', opcode: GameMessageOpcode.GameEvent, objectGuid: 0, sequence: 1, eventType: DEFENDER_NOTIFICATION, payload });
  return captured;
}

describe('GAP.65 — the client renders server-sent damage verbatim (PvP math is server-side)', () => {
  it('a PvP-reduced damage value surfaces exactly as the server sent it (no client re-scaling)', () => {
    // Suppose PvE would be 200 but the server already applied PkDamageMod /
    // PkDamageResistanceMod and sends 63. The client must surface 63, not
    // apply any further halving.
    const captured = driveAttacker(attackerPayload('Redsworn', DamageType.Slash, 0.31, 63, false, 0));
    expect(captured.damage).toBe(63);
    expect(captured.damage).toBeLessThan(1_000_000); // not slipped-bytes garbage
  });

  it('the client is BLIND to PvP context: identical payloads render identical damage vs player or monster', () => {
    // Same wire fields, only the opponent name differs (a player vs a
    // monster). The client has no PvP branch, so the damage is identical.
    const vsPlayer  = driveAttacker(attackerPayload('Redsworn',      DamageType.Pierce, 0.5, 127, false, 0));
    const vsMonster = driveAttacker(attackerPayload('Olthoi Ripper', DamageType.Pierce, 0.5, 127, false, 0));
    expect(vsPlayer.damage).toBe(127);
    expect(vsMonster.damage).toBe(127);
    expect(vsPlayer.damage).toBe(vsMonster.damage);
  });

  it('defender side likewise surfaces the exact server damage (a PvP hit taken)', () => {
    const captured = driveDefender(defenderPayload('Redsworn', DamageType.Bludgeon, 0.12, 41, 4 /* lower arm */, false, 0));
    expect(captured.damage).toBe(41);
    expect(captured.bodyPart).toBe(4);
  });
});

describe('GAP.65 — the combat-dialog formatters have no PvP input (pure fn of server fields)', () => {
  it('formatAttackerChat prints the exact server damage integer verbatim', () => {
    // Whatever the server computed (here a PvP-reduced 63) appears literally.
    expect(formatAttackerChat('Redsworn', DamageType.Slash, 0.31, 63, false)).toContain('63 points of slashing damage');
  });

  it('same numeric args → identical string whether the target is a player or a monster', () => {
    // The signature carries only (name, damageType, severity, damage, crit) —
    // no PvP parameter exists, so the client CANNOT differentiate. Proven by
    // identical damage/type/severity yielding the same "N points" clause.
    const a = formatAttackerChat('Redsworn',      DamageType.Fire, 0.6, 88, false);
    const b = formatAttackerChat('Olthoi Ripper', DamageType.Fire, 0.6, 88, false);
    expect(a.replace('Redsworn', 'X')).toBe(b.replace('Olthoi Ripper', 'X'));
    expect(a).toContain('88 points of fire damage');
  });

  it('formatDefenderChat prints the exact server damage integer verbatim', () => {
    expect(formatDefenderChat('Redsworn', DamageType.Cold, 0.09, 7, 7 /* lower leg */, false))
      .toContain('7 points of cold damage');
  });

  it('a large server-sent crit passes through unmodified (no client cap/scaling)', () => {
    expect(formatAttackerChat('Redsworn', DamageType.Pierce, 0.95, 1320, true))
      .toBe('Critical hit!  You gore Redsworn for 1320 points of piercing damage!'); // two spaces: retail .rdata 0x7cf5d0
  });
});
