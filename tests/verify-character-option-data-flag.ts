/**
 * CharacterOptionDataFlag enum audit + call-site integration.
 *
 * Wire format: this enum is the first uint32 of the SetCharacterOptions
 * (0xF6BA) GameAction payload. Each set bit gates the optional sub-block
 * that follows the fixed-prefix portion. Drift in the flag values would
 * cause the server to read sub-blocks at the wrong offset (or skip blocks
 * the client actually emitted) — the client/server packet would
 * desynchronize and the action would be silently dropped or worse.
 *
 * FAITHFUL.144 ported the enum and replaced 3 bare-literal flag-bit
 * builds in main.ts setCharacterOptions with symbolic enum members.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { CharacterOptionDataFlag } from '../packages/shared/src/enums/CharacterOptionDataFlag.js';
import { buildSetCharacterOptionsPayload, parseSetCharacterOptionsPayload } from '@ac/network';

const REPO = resolve(__dirname, '..');
const ACE_PATH = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/CharacterOptionDataFlag.cs');

describe.skipIf(!aceReferenceExists(ACE_PATH))('ACE CharacterOptionDataFlag coverage (FAITHFUL.144)', () => {
  let src: string;
  // Loaded in beforeAll: skipIf does not skip the describe body (CLAUDE.md).
  beforeAll(() => {
    src = readFileSync(ACE_PATH, 'utf8');
  });

  it('TS port matches ACE 1:1', () => {
    expect(src).toMatch(/Shortcut\s*=\s*0x00000001/);
    expect(src).toMatch(/SquelchList\s*=\s*0x00000002/);
    expect(src).toMatch(/MultiSpellList\s*=\s*0x00000004/);
    expect(src).toMatch(/DesiredComps\s*=\s*0x00000008/);
    expect(src).toMatch(/ExtendedMultiSpellLists\s*=\s*0x00000010/);
    expect(src).toMatch(/SpellbookFilters\s*=\s*0x00000020/);
    expect(src).toMatch(/CharacterOptions2\s*=\s*0x00000040/);
    expect(src).toMatch(/TimestampFormat\s*=\s*0x00000080/);
    expect(src).toMatch(/GenericQualitiesData\s*=\s*0x00000100/);
    expect(src).toMatch(/GameplayOptions\s*=\s*0x00000200/);
    expect(src).toMatch(/SpellLists8\s*=\s*0x00000400/);

    expect(CharacterOptionDataFlag.Shortcut).toBe(0x00000001);
    expect(CharacterOptionDataFlag.SquelchList).toBe(0x00000002);
    expect(CharacterOptionDataFlag.MultiSpellList).toBe(0x00000004);
    expect(CharacterOptionDataFlag.DesiredComps).toBe(0x00000008);
    expect(CharacterOptionDataFlag.ExtendedMultiSpellLists).toBe(0x00000010);
    expect(CharacterOptionDataFlag.SpellbookFilters).toBe(0x00000020);
    expect(CharacterOptionDataFlag.CharacterOptions2).toBe(0x00000040);
    expect(CharacterOptionDataFlag.TimestampFormat).toBe(0x00000080);
    expect(CharacterOptionDataFlag.GenericQualitiesData).toBe(0x00000100);
    expect(CharacterOptionDataFlag.GameplayOptions).toBe(0x00000200);
    expect(CharacterOptionDataFlag.SpellLists8).toBe(0x00000400);
  });

  it('declared as [Flags]', () => {
    expect(src).toMatch(/\[Flags\]/);
  });
});

describe('MessageSerializer integration (FAITHFUL.144 / GAP.87)', () => {
  // GAP.87 (2026-07-26b) extracted main.ts's inline setCharacterOptions
  // flag-building + BinaryWriter block into buildSetCharacterOptionsPayload
  // (packages/network/src/MessageSerializer.ts), so the symbolic flag
  // OR-assignments now live there instead of in main.ts. These assertions
  // were converted from a main.ts source-grep pin to genuine behavioral
  // coverage of the shared builder + a check that main.ts routes through it.
  const src = readFileSync(resolve(REPO, 'packages/network/src/MessageSerializer.ts'), 'utf8');

  it('buildSetCharacterOptionsPayload uses CharacterOptionDataFlag.SpellbookFilters', () => {
    expect(src).toMatch(/flags\s*\|=\s*CharacterOptionDataFlag\.SpellbookFilters/);
  });

  it('buildSetCharacterOptionsPayload uses CharacterOptionDataFlag.CharacterOptions2', () => {
    expect(src).toMatch(/flags\s*\|=\s*CharacterOptionDataFlag\.CharacterOptions2/);
  });

  it('buildSetCharacterOptionsPayload uses CharacterOptionDataFlag.DesiredComps', () => {
    expect(src).toMatch(/flags\s*\|=\s*CharacterOptionDataFlag\.DesiredComps/);
  });

  it('no longer uses the bare-hex flag literals in the builder', () => {
    const match = src.match(/export function buildSetCharacterOptionsPayload[\s\S]*?\n}/);
    expect(match).not.toBeNull();
    const body = match![0];
    expect(body).not.toMatch(/flags\s*\|=\s*0x00000020/);
    expect(body).not.toMatch(/flags\s*\|=\s*0x00000040/);
    expect(body).not.toMatch(/flags\s*\|=\s*0x00000008/);
  });

  it('round-trips options1, spellbookFilters, options2, and desiredComponents through flag-gated fields, matching GameActionSetCharacterOptions.cs read order', () => {
    const payload = buildSetCharacterOptionsPayload({
      options1: 0x1234,
      options2: 0x5678,
      spellbookFilters: 0x2AAA,
      desiredComponents: [{ wcid: 1001, count: 5 }, { wcid: 1002, count: -3 }],
    });
    const parsed = parseSetCharacterOptionsPayload(payload);
    expect(parsed.options1).toBe(0x1234);
    expect(parsed.numTab1Spells).toBe(0);
    expect(parsed.desiredComponents).toEqual([{ wcid: 1001, count: 5 }, { wcid: 1002, count: -3 }]);
    expect(parsed.spellbookFilters).toBe(0x2AAA);
    expect(parsed.options2).toBe(0x5678);
    expect(parsed.flags & CharacterOptionDataFlag.DesiredComps).toBeTruthy();
    expect(parsed.flags & CharacterOptionDataFlag.SpellbookFilters).toBeTruthy();
    expect(parsed.flags & CharacterOptionDataFlag.CharacterOptions2).toBeTruthy();
    // Shortcut/MultiSpellList/ExtendedMultiSpellLists/SpellLists8 must never
    // be set — this builder always emits those sub-blocks empty.
    expect(parsed.flags & CharacterOptionDataFlag.Shortcut).toBe(0);
    expect(parsed.flags & CharacterOptionDataFlag.MultiSpellList).toBe(0);
    expect(parsed.flags & CharacterOptionDataFlag.ExtendedMultiSpellLists).toBe(0);
    expect(parsed.flags & CharacterOptionDataFlag.SpellLists8).toBe(0);
  });

  it('omits optional fields entirely when their flag is unset (minimal payload)', () => {
    const payload = buildSetCharacterOptionsPayload({ options1: 7 });
    const parsed = parseSetCharacterOptionsPayload(payload);
    expect(parsed.flags).toBe(0);
    expect(parsed.options1).toBe(7);
    expect(parsed.desiredComponents).toEqual([]);
    expect(parsed.spellbookFilters).toBeUndefined();
    expect(parsed.options2).toBeUndefined();
    // Minimal payload is exactly flags(4) + options1(4) + numTab1Spells(4).
    expect(payload.length).toBe(12);
  });

  it('main.ts routes setCharacterOptions through the shared builder, not an inline BinaryWriter', () => {
    const mainSrc = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');
    const match = mainSrc.match(/setCharacterOptions:[\s\S]*?\n {6}\},/);
    expect(match).not.toBeNull();
    expect(match![0]).toMatch(/buildSetCharacterOptionsPayload\(/);
    expect(match![0]).not.toMatch(/new BinaryWriter/);
  });
});
