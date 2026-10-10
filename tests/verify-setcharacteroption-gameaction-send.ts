/**
 * GAP.87 — SetSingleCharacterOption send-side payload audited against ACE
 * C# read order and converted to behavioral coverage.
 *
 * Previously constructed with an inline `new BinaryWriter(8)` at TWO
 * separate call sites in main.ts (the /consent on|off chat command and the
 * gameUI.callbacks.setCharacterOption helper used by the Options panel),
 * with no test exercising the actual byte layout. A 2-field payload where
 * both fields are uint32 is a real, plausible transposition risk (option
 * and value swapped would silently corrupt every character-option toggle).
 *
 * Fix: extracted into buildSetCharacterOptionPayload() in
 * packages/network/src/MessageSerializer.ts (mirrors the
 * buildUseWithTargetPayload convention). Both main.ts call sites now call
 * the shared, exported, testable function instead of re-deriving the byte
 * layout inline.
 *
 * Wire format anchor: GameActionSetSingleCharacterOption.cs:11-12 —
 *   var option = (CharacterOption)message.Payload.ReadUInt32();
 *   var optionValue = message.Payload.ReadUInt32() != 0;
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildSetCharacterOptionPayload, parseSetCharacterOptionPayload, BinaryReader } from '@ac/network';

const REPO = resolve(__dirname, '..');
const SET_OPTION_CS = readFileSync(
  resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionSetSingleCharacterOption.cs'),
  'utf8',
);

describe('ACE source anchors the wire format we send (GAP.87)', () => {
  it('GameActionSetSingleCharacterOption.cs reads option then optionValue as two uint32s', () => {
    expect(SET_OPTION_CS).toMatch(
      /var option = \(CharacterOption\)message\.Payload\.ReadUInt32\(\);\s*\n\s*var optionValue = message\.Payload\.ReadUInt32\(\) != 0;/,
    );
  });
});

describe('buildSetCharacterOptionPayload produces byte-exact wire bytes (GAP.87 — behavioral)', () => {
  it('is exactly 8 bytes', () => {
    expect(buildSetCharacterOptionPayload(1, true).length).toBe(8);
  });

  it('round-trips through parseSetCharacterOptionPayload with distinct sentinel values', () => {
    const payload = buildSetCharacterOptionPayload(0x10, true);
    expect(parseSetCharacterOptionPayload(payload)).toEqual({ option: 0x10, value: true });
  });

  it('encodes false as a literal 0 uint32, not just any falsy value', () => {
    const payload = buildSetCharacterOptionPayload(0x10, false);
    expect(parseSetCharacterOptionPayload(payload)).toEqual({ option: 0x10, value: false });
  });

  it('matches GameActionSetSingleCharacterOption.cs field order exactly via a raw BinaryReader (an option/value transposition would fail this)', () => {
    // AcceptCorpseLootingPermissions = 0x10 (CharacterOption.cs) used as the
    // sentinel "option" value — distinct from the boolean "value" field so a
    // swap is unambiguously detectable.
    const payload = buildSetCharacterOptionPayload(0x10, true);
    const reader = new BinaryReader(payload);
    expect(reader.readUInt32()).toBe(0x10); // option (CharacterOption enum)
    expect(reader.readUInt32()).toBe(1); // optionValue (bool as 0/1)
    expect(reader.remaining).toBe(0);
  });
});
