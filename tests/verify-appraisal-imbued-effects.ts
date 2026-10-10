/**
 * The 5 ImbuedEffect slots in the item appraisal body (FAITHFUL.318).
 *
 * Five `[AssessmentProperty]` PropertyInt fields: 179 ImbuedEffect,
 * 303-306 ImbuedEffect2..5 — each an `ImbuedEffectType` bitfield
 * (reference/ACE/Source/ACE.Entity/Enum/ImbuedEffectType.cs).
 *
 * The EoL client does NOT print one "Imbued Effect N:" row per slot (the
 * removed showExaminePanel's invention). ItemExamineUI::
 * Appraisal_ShowSpecialProperties @ 004b0140 (decomp l.~174000) ORs all
 * five slots into one mask and appends, in its fixed bit order, Critical
 * Strike, Crippling Blow, Armor Rending, Slash/Pierce/Bludgeon/Acid Rending,
 * Nether Rending, Cold/Lightning/Fire Rending, +1 Melee/Missile/Magic
 * Defense and Phantasmal (0x80000000) to the "Properties: …" line, then
 * writes "This item cannot be further imbued.". Bits outside that list
 * (e.g. AlwaysCritical 0x40000000) have no text. Drives the shipped builder
 * (ui/examine/ItemAppraisalText.ts). The @ac/shared imbuedEffectsLabels
 * helper tests stay (other UI uses it).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PropertyInt, imbuedEffectsLabels, ImbuedEffectType } from '@ac/shared';
import type { IdentifyResponseData } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { buildItemAppraisalText } from '../packages/renderer/src/ui/examine/ItemAppraisalText.js';

const REPO = resolve(__dirname, '..');

/** Non-blank body lines (docked page: value/burden live in header elements, not the body). */
function body(ints: Array<[number, number]>): string[] {
  const data: IdentifyResponseData = { guid: 0x80001111, flags: 0, propertiesInt: new Map(ints) };
  return buildItemAppraisalText(data, { hasValueBurdenElements: true }).lines
    .filter((l) => l.text !== '').map((l) => l.text);
}

describe('imbuedEffectsLabels helper (FAITHFUL.318)', () => {
  it('empty mask returns []', () => expect(imbuedEffectsLabels(0)).toEqual([]));
  it('CriticalStrike (0x1) → ["Critical Strike"]', () => {
    expect(imbuedEffectsLabels(ImbuedEffectType.CriticalStrike)).toEqual(['Critical Strike']);
  });
  it('combined CriticalStrike | SlashRending → ["Critical Strike", "Slash Rending"]', () => {
    const mask = ImbuedEffectType.CriticalStrike | ImbuedEffectType.SlashRending;
    expect(imbuedEffectsLabels(mask)).toEqual(['Critical Strike', 'Slash Rending']);
  });
  it('NetherRending (0x4000) → ["Nether Rending"]', () => {
    expect(imbuedEffectsLabels(ImbuedEffectType.NetherRending)).toEqual(['Nether Rending']);
  });
  it('AlwaysCritical (0x40000000) → ["Always Critical"]', () => {
    expect(imbuedEffectsLabels(ImbuedEffectType.AlwaysCritical)).toEqual(['Always Critical']);
  });
  it('IgnoreAllArmor (0x80000000) → ["Ignore All Armor"]', () => {
    expect(imbuedEffectsLabels(ImbuedEffectType.IgnoreAllArmor >>> 0)).toEqual(['Ignore All Armor']);
  });
  it('does not include Undef even if mask & 0 (defensive)', () => {
    // Mask is 0, so no bits — Undef should never show up as a label.
    expect(imbuedEffectsLabels(0)).not.toContain('Undef');
  });
});

describe('Appraisal — ImbuedEffect1..5 in "Properties:" (FAITHFUL.318, retail text)', () => {
  it('a single slot: its names on the Properties line, then the no-further-imbue sentence', () => {
    expect(body([[PropertyInt.ImbuedEffect, ImbuedEffectType.CriticalStrike | ImbuedEffectType.SlashRending]]))
      .toEqual(['Properties: Critical Strike, Slash Rending', 'This item cannot be further imbued.']);
  });

  it('all five slots are OR-ed into one mask and listed once in retail bit order', () => {
    expect(body([
      [PropertyInt.ImbuedEffect2, ImbuedEffectType.NetherRending],
      [PropertyInt.ImbuedEffect, ImbuedEffectType.SlashRending],
      [PropertyInt.ImbuedEffect3, ImbuedEffectType.CriticalStrike],
      [PropertyInt.ImbuedEffect4, ImbuedEffectType.AlwaysCritical],
      [PropertyInt.ImbuedEffect5, ImbuedEffectType.IgnoreAllArmor >>> 0],
    ])).toEqual([
      'Properties: Critical Strike, Slash Rending, Nether Rending, Phantasmal',
      'This item cannot be further imbued.',
    ]);
  });

  it('the imbue names precede later properties (e.g. Bonded) on the same line', () => {
    expect(body([[PropertyInt.ImbuedEffect, ImbuedEffectType.ArmorRending], [PropertyInt.Bonded, 1]]))
      .toEqual(['Properties: Armor Rending, Bonded', 'This item cannot be further imbued.']);
  });

  it('absent or zero masks write nothing', () => {
    expect(body([])).toEqual([]);
    expect(body([[PropertyInt.ImbuedEffect, 0], [PropertyInt.ImbuedEffect3, 0]])).toEqual([]);
  });
});

const ACE_PROPINT = resolve(
  REPO,
  'reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyInt.cs',
);
const ACE_IMBUE = resolve(
  REPO,
  'reference/ACE/Source/ACE.Entity/Enum/ImbuedEffectType.cs',
);

describe.skipIf(!aceReferenceExists(ACE_PROPINT))('ACE source pin — 5 ImbuedEffect PropertyInt IDs', () => {
  let src: string;
  // Loaded in beforeAll: skipIf does not skip the describe body (CLAUDE.md).
  beforeAll(() => {
    src = readFileSync(ACE_PROPINT, 'utf8');
  });

  function pin(name: string, value: number) {
    expect(src).toMatch(new RegExp(`${name}\\s+=\\s*${value}\\b`));
    const idx = src.search(new RegExp(`\\s${name}\\s+=\\s*${value}`));
    if (idx >= 0) {
      const window = src.slice(Math.max(0, idx - 300), idx);
      expect(window).toMatch(/\[AssessmentProperty\]/);
    }
  }

  it('ImbuedEffect = 179 [AssessmentProperty]', () => pin('ImbuedEffect', 179));
  it('ImbuedEffect2 = 303 [AssessmentProperty]', () => pin('ImbuedEffect2', 303));
  it('ImbuedEffect3 = 304 [AssessmentProperty]', () => pin('ImbuedEffect3', 304));
  it('ImbuedEffect4 = 305 [AssessmentProperty]', () => pin('ImbuedEffect4', 305));
  it('ImbuedEffect5 = 306 [AssessmentProperty]', () => pin('ImbuedEffect5', 306));
});

describe.skipIf(!aceReferenceExists(ACE_IMBUE))('ACE source pin — ImbuedEffectType bit values', () => {
  let src: string;
  // Loaded in beforeAll: skipIf does not skip the describe body (CLAUDE.md).
  beforeAll(() => {
    src = readFileSync(ACE_IMBUE, 'utf8');
  });

  it('CriticalStrike = 0x0001, ArmorRending = 0x0004, NetherRending = 0x4000', () => {
    expect(src).toMatch(/CriticalStrike\s*=\s*0x0+1\b/);
    expect(src).toMatch(/ArmorRending\s*=\s*0x0+4\b/);
    expect(src).toMatch(/NetherRending\s*=\s*0x4000\b/);
  });

  it('high-bit flags exist: IgnoreSomeMagicProjectileDamage = 0x20000000, AlwaysCritical = 0x40000000, IgnoreAllArmor = 0x80000000', () => {
    expect(src).toMatch(/IgnoreSomeMagicProjectileDamage\s*=\s*0x20000000/);
    expect(src).toMatch(/AlwaysCritical\s*=\s*0x40000000/);
    expect(src).toMatch(/IgnoreAllArmor\s*=\s*0x80000000/);
  });
});
