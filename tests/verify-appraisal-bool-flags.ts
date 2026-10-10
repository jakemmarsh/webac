/**
 * PropertyBool flags in the item appraisal body (FAITHFUL.308).
 *
 * Five `[AssessmentProperty]` PropertyBool fields (ACE PropertyBool.cs):
 *     3 = Locked, 63 = UnlimitedUse, 91 = Retained, 99 = Ivoryable, 100 = Dyable.
 *
 * The EoL client never prints "<Label>: Yes" rows (the removed
 * showExaminePanel's invention). What it writes, per the decompiled
 * ItemExamineUI (ui/examine/ItemAppraisalText.ts cites each):
 *  - Locked   → Appraisal_ShowLockAppraiseInfo @ 004b2790: "Locked" (+ the
 *               lock-difficulty sentence) or, when false, "Unlocked".
 *  - UnlimitedUse → Appraisal_ShowRemainingUses @ 004b3a20:
 *               "Number of uses remaining:  Unlimited" (two spaces, verbatim).
 *  - Retained / Ivoryable / Dyable → Appraisal_ShowSpecialProperties
 *               @ 004b0140: terms of the "Properties: …" line ("Dyeable").
 * Open (2) is not read by ItemExamineUI at all.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PropertyBool, PropertyInt } from '@ac/shared';
import type { IdentifyResponseData } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { buildItemAppraisalText } from '../packages/renderer/src/ui/examine/ItemAppraisalText.js';

const REPO = resolve(__dirname, '..');

/** Non-blank body lines (docked page: value/burden live in header elements, not the body). */
function body(bools: Array<[number, boolean]>, ints: Array<[number, number]> = []): string[] {
  const data: IdentifyResponseData = {
    guid: 0x80001111, flags: 0, propertiesBool: new Map(bools), propertiesInt: new Map(ints),
  };
  return buildItemAppraisalText(data, { hasValueBurdenElements: true }).lines
    .filter((l) => l.text !== '').map((l) => l.text);
}

describe('Appraisal — PropertyBool flags (FAITHFUL.308, retail text)', () => {
  it('Locked (3) = true writes "Locked" and the lock sentence', () => {
    expect(body([[PropertyBool.Locked, true]])).toEqual(['Locked', "You can't tell how hard the lock is to pick."]);
    expect(body([[PropertyBool.Locked, true]], [[PropertyInt.ResistLockpick, 150], [PropertyInt.AppraisalLockpickSuccessPercent, 40]]))
      .toEqual(['Locked', 'The lock looks difficult to pick (Resistance 150).']);
  });

  it('Locked (3) = false writes "Unlocked" (retail shows the unlocked state too)', () => {
    expect(body([[PropertyBool.Locked, false]])).toEqual(['Unlocked']);
  });

  it('UnlimitedUse (63) writes "Number of uses remaining:  Unlimited"', () => {
    expect(body([[PropertyBool.UnlimitedUse, true]])).toEqual(['Number of uses remaining:  Unlimited']);
  });

  it('Retained (91), Ivoryable (99), Dyable (100) are terms of the "Properties:" line, in retail order', () => {
    expect(body([[PropertyBool.Retained, true]])).toEqual(['Properties: Retained']);
    expect(body([[PropertyBool.Ivoryable, true]])).toEqual(['Properties: Ivoryable']);
    expect(body([[PropertyBool.Dyable, true]])).toEqual(['Properties: Dyeable']);
    expect(body([[PropertyBool.Dyable, true], [PropertyBool.Ivoryable, true], [PropertyBool.Retained, true]]))
      .toEqual(['Properties: Retained, Ivoryable, Dyeable']);
  });

  it('false (or absent) UnlimitedUse/Retained/Ivoryable/Dyable write nothing', () => {
    const flags = [PropertyBool.UnlimitedUse, PropertyBool.Retained, PropertyBool.Ivoryable, PropertyBool.Dyable];
    expect(body(flags.map((f) => [f, false] as [number, boolean]))).toEqual([]);
    expect(body([])).toEqual([]);
  });

  it('Open (2) is not surfaced', () => {
    expect(body([[PropertyBool.Open, true]])).toEqual([]);
  });
});

const ACE_PROPBOOL = resolve(
  REPO,
  'reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyBool.cs',
);

describe.skipIf(!aceReferenceExists(ACE_PROPBOOL))('ACE source pin — all 5 PropertyBool IDs are [AssessmentProperty]', () => {
  // Build the set of AssessmentProperty-decorated members by scanning for
  // each line that follows an [AssessmentProperty] decorator (in beforeAll:
  // skipIf does not skip the describe body).
  const assessmentMembers = new Set<string>();
  beforeAll(() => {
    let lastWasDecorator = false;
    for (const line of readFileSync(ACE_PROPBOOL, 'utf8').split('\n')) {
      if (/\[AssessmentProperty\]/.test(line)) { lastWasDecorator = true; continue; }
      if (lastWasDecorator) {
        const m = line.match(/\s*(\w+)\s*=/);
        if (m) assessmentMembers.add(m[1]);
        lastWasDecorator = false;
      }
    }
  });

  it('Locked is [AssessmentProperty]', () => expect(assessmentMembers.has('Locked')).toBe(true));
  it('UnlimitedUse is [AssessmentProperty]', () => expect(assessmentMembers.has('UnlimitedUse')).toBe(true));
  it('Retained is [AssessmentProperty]', () => expect(assessmentMembers.has('Retained')).toBe(true));
  it('Ivoryable is [AssessmentProperty]', () => expect(assessmentMembers.has('Ivoryable')).toBe(true));
  it('Dyable is [AssessmentProperty]', () => expect(assessmentMembers.has('Dyable')).toBe(true));
});
