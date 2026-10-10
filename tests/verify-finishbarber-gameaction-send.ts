/**
 * GAP.87 — FinishBarber send-side payload audited against ACE C# read
 * order and converted to behavioral coverage.
 *
 * Previously constructed with an inline `new BinaryWriter(64)` writing 16
 * sequential uint32 fields directly in main.ts's acDebug.finishBarber
 * helper, with no test exercising the actual byte layout —
 * verify-barber-panel.ts's existing coverage only regex-matches that
 * main.ts *contains* the string `acDebug?.finishBarber?`, never executing
 * the wire construction. 16 same-typed fields in a fixed order is exactly
 * the shape of bug a transposition hides in (e.g. swapping
 * eyesTextureDID/noseTextureDID would silently apply the wrong texture
 * with no type error).
 *
 * Fix: extracted into buildFinishBarberPayload() in
 * packages/network/src/MessageSerializer.ts (mirrors the
 * buildModifyCharacterSquelchPayload convention). main.ts's
 * acDebug.finishBarber now calls the shared, exported, testable function
 * instead of re-deriving the 16-field byte layout inline.
 *
 * Wire format anchor: Player_Character.cs:409-425
 * HandleActionFinishBarber — 14 mandatory uint32 fields (palette/texture/
 * setup IDs) followed by 2 uint32 option fields, all ReadUInt32() in strict
 * sequence.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildFinishBarberPayload, parseFinishBarberPayload, BinaryReader } from '@ac/network';
import type { FinishBarberFields } from '@ac/network';

const REPO = resolve(__dirname, '..');
const PLAYER_CHARACTER_CS = readFileSync(
  resolve(REPO, 'reference/ACE/Source/ACE.Server/WorldObjects/Player_Character.cs'),
  'utf8',
);

// The exact ACE read-order field names, in sequence, per
// HandleActionFinishBarber. Used both to assert the source anchor and to
// derive distinct sentinel values per field below.
const ACE_READ_ORDER = [
  'requestedPaletteBaseId',
  'requestedHeadObjectDID',
  'requestedCharacterHairTexture',
  'requestedCharacterDefaultHairTexture',
  'requestedEyesTextureDID',
  'requestedDefaultEyesTextureDID',
  'requestedNoseTextureDID',
  'requestedDefaultNoseTextureDID',
  'requestedMouthTextureDID',
  'requestedDefaultMouthTextureDID',
  'requestedSkinPaletteDID',
  'requestedHairPaletteDID',
  'requestedEyesPaletteDID',
  'requestedSetupTableId',
];

describe('ACE source anchors the wire format we send (GAP.87)', () => {
  it('Player_Character.HandleActionFinishBarber reads all 14 texture/palette fields as ReadUInt32 in the documented order', () => {
    for (const name of ACE_READ_ORDER) {
      expect(PLAYER_CHARACTER_CS).toContain(`var ${name} = message.Payload.ReadUInt32();`);
    }
  });

  it('reads option_bound then option_unk as the trailing two uint32s', () => {
    expect(PLAYER_CHARACTER_CS).toMatch(
      /uint option_bound = message\.Payload\.ReadUInt32\(\);.*\n\s*uint option_unk = message\.Payload\.ReadUInt32\(\);/,
    );
  });
});

// Distinct sentinel per field (0x1000 * index + 1) so any transposition
// between two fields is unambiguously detectable.
const SENTINEL_FIELDS: FinishBarberFields = {
  paletteBaseId: 0x1001,
  headObjectDID: 0x2002,
  hairTexture: 0x3003,
  defaultHairTexture: 0x4004,
  eyesTextureDID: 0x5005,
  defaultEyesTextureDID: 0x6006,
  noseTextureDID: 0x7007,
  defaultNoseTextureDID: 0x8008,
  mouthTextureDID: 0x9009,
  defaultMouthTextureDID: 0xa00a,
  skinPaletteDID: 0xb00b,
  hairPaletteDID: 0xc00c,
  eyesPaletteDID: 0xd00d,
  setupTableId: 0xe00e,
  optionBound: 0xf00f,
  optionUnk: 0x10001,
};

describe('buildFinishBarberPayload produces byte-exact wire bytes (GAP.87 — behavioral)', () => {
  it('is exactly 64 bytes (16 uint32 fields)', () => {
    expect(buildFinishBarberPayload(SENTINEL_FIELDS).length).toBe(64);
  });

  it('round-trips through parseFinishBarberPayload with distinct sentinel values per field', () => {
    const payload = buildFinishBarberPayload(SENTINEL_FIELDS);
    expect(parseFinishBarberPayload(payload)).toEqual(SENTINEL_FIELDS);
  });

  it('defaults optionBound/optionUnk to 0 when omitted', () => {
    const { optionBound, optionUnk, ...required } = SENTINEL_FIELDS;
    const payload = buildFinishBarberPayload(required as FinishBarberFields);
    expect(parseFinishBarberPayload(payload)).toEqual({ ...required, optionBound: 0, optionUnk: 0 });
  });

  it('matches Player_Character.HandleActionFinishBarber field order exactly via a raw BinaryReader (any field transposition would fail this)', () => {
    const payload = buildFinishBarberPayload(SENTINEL_FIELDS);
    const reader = new BinaryReader(payload);
    expect(reader.readUInt32()).toBe(SENTINEL_FIELDS.paletteBaseId);
    expect(reader.readUInt32()).toBe(SENTINEL_FIELDS.headObjectDID);
    expect(reader.readUInt32()).toBe(SENTINEL_FIELDS.hairTexture);
    expect(reader.readUInt32()).toBe(SENTINEL_FIELDS.defaultHairTexture);
    expect(reader.readUInt32()).toBe(SENTINEL_FIELDS.eyesTextureDID);
    expect(reader.readUInt32()).toBe(SENTINEL_FIELDS.defaultEyesTextureDID);
    expect(reader.readUInt32()).toBe(SENTINEL_FIELDS.noseTextureDID);
    expect(reader.readUInt32()).toBe(SENTINEL_FIELDS.defaultNoseTextureDID);
    expect(reader.readUInt32()).toBe(SENTINEL_FIELDS.mouthTextureDID);
    expect(reader.readUInt32()).toBe(SENTINEL_FIELDS.defaultMouthTextureDID);
    expect(reader.readUInt32()).toBe(SENTINEL_FIELDS.skinPaletteDID);
    expect(reader.readUInt32()).toBe(SENTINEL_FIELDS.hairPaletteDID);
    expect(reader.readUInt32()).toBe(SENTINEL_FIELDS.eyesPaletteDID);
    expect(reader.readUInt32()).toBe(SENTINEL_FIELDS.setupTableId);
    expect(reader.readUInt32()).toBe(SENTINEL_FIELDS.optionBound);
    expect(reader.readUInt32()).toBe(SENTINEL_FIELDS.optionUnk);
    expect(reader.remaining).toBe(0);
  });
});
