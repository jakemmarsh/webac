/**
 * Attuned + Bonded status in the item appraisal body (FAITHFUL.302).
 *
 * Two `[AssessmentProperty]` PropertyInt fields (ACE PropertyInt.cs):
 *   33  = Bonded   (BondedStatus.cs: -2 Destroy, -1 Slippery, 0 Normal, 1 Bonded, 2 Sticky)
 *   114 = Attuned  (AttunedStatus.cs: 0 Normal, 1 Attuned, 2 Sticky)
 *
 * The EoL client does NOT give them their own "Attuned:" / "Bonded:" rows
 * (the removed showExaminePanel's invention). ItemExamineUI::
 * Appraisal_ShowSpecialProperties @ 004b0140 (decomp l.~174000) appends
 * them to the one "Properties: …" line, via
 *   AppraisalSystem::AttunedStatusToString @ 005b4850 (1..2 → "Attuned")
 *   AppraisalSystem::BondedStatusToString  @ 005b4880 (-2 "Destroyed on Death",
 *     -1 "Dropped on Death", 1 "Bonded"; no string for Sticky 2).
 * This file drives the shipped builder (ui/examine/ItemAppraisalText.ts)
 * and pins that text. The @ac/shared attunedStatusLabel/bondedStatusLabel
 * anchors below stay (other panels use them).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PropertyInt, attunedStatusLabel, bondedStatusLabel } from '@ac/shared';
import type { IdentifyResponseData } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { buildItemAppraisalText } from '../packages/renderer/src/ui/examine/ItemAppraisalText.js';

const REPO = resolve(__dirname, '..');

/** Non-blank body lines (docked page: value/burden live in header elements, not the body). */
function body(ints: Array<[number, number]>): string[] {
  const data: IdentifyResponseData = { guid: 0x80001111, flags: 0, propertiesInt: new Map(ints) };
  return buildItemAppraisalText(data, { hasValueBurdenElements: true }).lines
    .filter((l) => l.text !== '').map((l) => l.text);
}

describe('Appraisal — Attuned + Bonded in "Properties:" (FAITHFUL.302, retail text)', () => {
  it.each([1, 2])('Attuned (PropertyInt 114) = %i writes "Properties: Attuned" (AttunedStatusToString has no Sticky wording)', (v) => {
    expect(body([[PropertyInt.Attuned, v]])).toEqual(['Properties: Attuned']);
  });

  it.each([[-2, 'Destroyed on Death'], [-1, 'Dropped on Death'], [1, 'Bonded']] as const)(
    'Bonded (PropertyInt 33) = %i writes "Properties: %s"', (v, text) => {
      expect(body([[PropertyInt.Bonded, v]])).toEqual([`Properties: ${text}`]);
    });

  it('Bonded = 2 (Sticky) writes nothing — BondedStatusToString @ 005b4880 has no case for it', () => {
    expect(body([[PropertyInt.Bonded, 2]])).toEqual([]);
  });

  it('both present join in retail order (Attuned, then Bonded) on one line', () => {
    expect(body([[PropertyInt.Bonded, 1], [PropertyInt.Attuned, 1]])).toEqual(['Properties: Attuned, Bonded']);
  });

  it('absent or 0 (Normal) writes nothing', () => {
    expect(body([])).toEqual([]);
    expect(body([[PropertyInt.Attuned, 0], [PropertyInt.Bonded, 0]])).toEqual([]);
  });

  it('an out-of-enum value writes nothing', () => {
    expect(body([[PropertyInt.Attuned, 99], [PropertyInt.Bonded, 99]])).toEqual([]);
  });
});

describe('attunedStatusLabel canonical strings (FAITHFUL.302 anchor)', () => {
  it('Normal (0) → "" (empty — no row)', () => expect(attunedStatusLabel(0)).toBe(''));
  it('Attuned (1) → "Attuned"', () => expect(attunedStatusLabel(1)).toBe('Attuned'));
  it('Sticky (2) → "Attuned (Sticky)"', () => expect(attunedStatusLabel(2)).toBe('Attuned (Sticky)'));
});

describe('bondedStatusLabel canonical strings (FAITHFUL.302 anchor)', () => {
  it('Destroy (-2) → "Destroyed on Death"', () => expect(bondedStatusLabel(-2)).toBe('Destroyed on Death'));
  it('Slippery (-1) → "Drops on Death"', () => expect(bondedStatusLabel(-1)).toBe('Drops on Death'));
  it('Normal (0) → "" (empty — no row)', () => expect(bondedStatusLabel(0)).toBe(''));
  it('Bonded (1) → "Bonded"', () => expect(bondedStatusLabel(1)).toBe('Bonded'));
  it('Sticky (2) → "Bonded (Sticky)"', () => expect(bondedStatusLabel(2)).toBe('Bonded (Sticky)'));
});

const ACE_PROPINT = resolve(
  REPO,
  'reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyInt.cs',
);

describe.skipIf(!aceReferenceExists(ACE_PROPINT))('ACE source pin — Attuned + Bonded are [AssessmentProperty]', () => {
  let src: string;
  // Loaded in beforeAll: skipIf does not skip the describe body (CLAUDE.md).
  beforeAll(() => { src = readFileSync(ACE_PROPINT, 'utf8'); });

  it('Bonded = 33, [AssessmentProperty]', () => {
    expect(src).toMatch(/Bonded\s+=\s*33\b/);
    const idx = src.indexOf('Bonded                                   = 33');
    expect(idx).toBeGreaterThan(0);
    expect(src.slice(Math.max(0, idx - 100), idx)).toMatch(/\[AssessmentProperty\]/);
  });

  it('Attuned = 114, [AssessmentProperty]', () => {
    expect(src).toMatch(/Attuned\s+=\s*114\b/);
    const idx = src.indexOf('Attuned                                  = 114');
    expect(idx).toBeGreaterThan(0);
    expect(src.slice(Math.max(0, idx - 100), idx)).toMatch(/\[AssessmentProperty\]/);
  });
});
