/**
 * GAP.87 — TargetedMeleeAttack, TargetedMissileAttack, and
 * ConfirmationResponse send-side payloads audited against ACE C# read order
 * and converted to behavioral coverage.
 *
 * Previously each was constructed with a separate inline `new
 * BinaryWriter(12)` block at its call site in main.ts (sendMeleeAttack,
 * sendMissileAttack, onConfirmationRequest's Yes/No callback), with no test
 * exercising the actual byte layout — the same "one-shot audit, never
 * re-verified, drift risk from copy-paste duplication" gap flagged for
 * Jump/UseWithTarget/ModifyCharacterSquelch/SetSingleCharacterOption
 * /FinishBarber/GetAndWieldItem/StackableMerge/PutItemInContainer/AddToTrade
 * earlier in this series. TargetedMeleeAttack/TargetedMissileAttack are the
 * highest-frequency combat sends in the client — a field transposition here
 * would silently corrupt every attack.
 *
 * Fix: extracted into buildTargetedMeleeAttackPayload /
 * buildTargetedMissileAttackPayload / buildConfirmationResponsePayload in
 * packages/network/src/MessageSerializer.ts (mirrors the existing
 * buildAddToTradePayload convention). main.ts's sendMeleeAttack,
 * sendMissileAttack, and onConfirmationRequest's accept callback now call
 * the shared, exported, testable functions instead of re-deriving the byte
 * layout inline.
 *
 * Wire format anchors:
 *   GameActionTargetedMeleeAttack.cs — targetGuid u32 + attackHeight u32 + powerLevel f32
 *   GameActionTargetedMissileAttack.cs — targetGuid u32 + attackHeight u32 + accuracyLevel f32
 *   GameActionConfirmationResponse.cs — confirmationType i32 + context u32 + response i32 (bool)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildTargetedMeleeAttackPayload, parseTargetedMeleeAttackPayload,
  buildTargetedMissileAttackPayload, parseTargetedMissileAttackPayload,
  buildConfirmationResponsePayload, parseConfirmationResponsePayload,
  BinaryReader,
} from '@ac/network';

const REPO = resolve(__dirname, '..');
const MELEE_CS = readFileSync(
  resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionTargetedMeleeAttack.cs'),
  'utf8',
);
const MISSILE_CS = readFileSync(
  resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionTargetedMissileAttack.cs'),
  'utf8',
);
const CONFIRM_CS = readFileSync(
  resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionConfirmationResponse.cs'),
  'utf8',
);

describe('ACE source anchors the wire format we send (GAP.87)', () => {
  it('GameActionTargetedMeleeAttack.cs reads targetGuid, attackHeight (both u32) then powerLevel (f32)', () => {
    expect(MELEE_CS).toMatch(
      /targetGuid = message\.Payload\.ReadUInt32\(\);\s*\n\s*var attackHeight = message\.Payload\.ReadUInt32\(\);\s*\n\s*var powerLevel = message\.Payload\.ReadSingle\(\);/,
    );
  });

  it('GameActionTargetedMissileAttack.cs reads targetGuid, attackHeight (both u32) then accuracyLevel (f32)', () => {
    expect(MISSILE_CS).toMatch(
      /targetGuid = message\.Payload\.ReadUInt32\(\);\s*\n\s*var attackHeight = message\.Payload\.ReadUInt32\(\);\s*\n\s*var accuracyLevel = message\.Payload\.ReadSingle\(\);/,
    );
  });

  it('GameActionConfirmationResponse.cs reads confirmType (i32), context (u32), response (i32 bool)', () => {
    expect(CONFIRM_CS).toMatch(
      /confirmType = \(ConfirmationType\)message\.Payload\.ReadInt32\(\);\s*\n\s*var context = message\.Payload\.ReadUInt32\(\);\s*\n\s*var response = Convert\.ToBoolean\(message\.Payload\.ReadInt32\(\)\);/,
    );
  });
});

describe('buildTargetedMeleeAttackPayload produces byte-exact wire bytes (GAP.87 — behavioral)', () => {
  it('is exactly 12 bytes', () => {
    expect(buildTargetedMeleeAttackPayload(1, 2, 3).length).toBe(12);
  });

  it('round-trips through parseTargetedMeleeAttackPayload with distinct sentinel values', () => {
    const payload = buildTargetedMeleeAttackPayload(0x1234, 2, 0.75);
    expect(parseTargetedMeleeAttackPayload(payload)).toEqual({ targetGuid: 0x1234, attackHeight: 2, powerLevel: 0.75 });
  });

  it('matches GameActionTargetedMeleeAttack.cs field order exactly via a raw BinaryReader (a targetGuid/attackHeight transposition would fail this)', () => {
    const payload = buildTargetedMeleeAttackPayload(0xAAAA, 1, 0.5);
    const reader = new BinaryReader(payload);
    expect(reader.readUInt32()).toBe(0xAAAA); // targetGuid
    expect(reader.readUInt32()).toBe(1);      // attackHeight
    expect(reader.readFloat32()).toBeCloseTo(0.5, 6); // powerLevel
    expect(reader.remaining).toBe(0);
  });
});

describe('buildTargetedMissileAttackPayload produces byte-exact wire bytes (GAP.87 — behavioral)', () => {
  it('is exactly 12 bytes', () => {
    expect(buildTargetedMissileAttackPayload(1, 2, 3).length).toBe(12);
  });

  it('round-trips through parseTargetedMissileAttackPayload with distinct sentinel values', () => {
    const payload = buildTargetedMissileAttackPayload(0x5678, 0, 1.0);
    expect(parseTargetedMissileAttackPayload(payload)).toEqual({ targetGuid: 0x5678, attackHeight: 0, accuracyLevel: 1.0 });
  });

  it('matches GameActionTargetedMissileAttack.cs field order exactly via a raw BinaryReader (a targetGuid/attackHeight transposition would fail this)', () => {
    const payload = buildTargetedMissileAttackPayload(0xBBBB, 2, 0.25);
    const reader = new BinaryReader(payload);
    expect(reader.readUInt32()).toBe(0xBBBB); // targetGuid
    expect(reader.readUInt32()).toBe(2);      // attackHeight
    expect(reader.readFloat32()).toBeCloseTo(0.25, 6); // accuracyLevel
    expect(reader.remaining).toBe(0);
  });
});

describe('buildConfirmationResponsePayload produces byte-exact wire bytes (GAP.87 — behavioral)', () => {
  it('is exactly 12 bytes', () => {
    expect(buildConfirmationResponsePayload(1, 2, true).length).toBe(12);
  });

  it('round-trips through parseConfirmationResponsePayload with distinct sentinel values (accepted)', () => {
    const payload = buildConfirmationResponsePayload(7, 0xCAFEBABE, false);
    expect(parseConfirmationResponsePayload(payload)).toEqual({ confirmationType: 7, context: 0xCAFEBABE, response: false });
  });

  it('round-trips true/false response correctly (not just truthy/falsy)', () => {
    expect(parseConfirmationResponsePayload(buildConfirmationResponsePayload(1, 1, true)).response).toBe(true);
    expect(parseConfirmationResponsePayload(buildConfirmationResponsePayload(1, 1, false)).response).toBe(false);
  });

  it('matches GameActionConfirmationResponse.cs field order exactly via a raw BinaryReader (a type/context transposition would fail this)', () => {
    const payload = buildConfirmationResponsePayload(3, 0x80001234, true);
    const reader = new BinaryReader(payload);
    expect(reader.readInt32()).toBe(3);          // confirmationType
    expect(reader.readUInt32()).toBe(0x80001234); // context
    expect(reader.readInt32()).toBe(1);           // response (bool as 0/1)
    expect(reader.remaining).toBe(0);
  });
});
