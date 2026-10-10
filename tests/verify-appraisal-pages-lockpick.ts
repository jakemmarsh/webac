/**
 * Book pages + lockpick success chance in the item appraisal (FAITHFUL.304).
 *
 * Three `[AssessmentProperty]` PropertyInt fields:
 *   173 = AppraisalLockpickSuccessPercent — % chance to pick the lock at
 *         the appraising player's Lockpick skill (ACE
 *         `Network/Structure/AppraiseInfo.cs`, LockHelper.GetResistLockpick)
 *   174 = AppraisalPages    — pages written in a book
 *   175 = AppraisalMaxPages — the book's page capacity
 *
 * Now verifies the shipped pure builder
 * `packages/renderer/src/ui/examine/ItemAppraisalText.ts` produces the
 * end-of-retail strings:
 *  - Appraisal_ShowCapacity @ 004b2680: "<pages> of <max> pages full." when
 *    BOTH 174 and 175 are present (the old invented "Pages: X of Y" row is
 *    gone);
 *  - Appraisal_ShowLockAppraiseInfo @ 004b2790: a locked item reads
 *    "Locked", a blank line (both are separate-paragraph AddItemInfo calls), then "The lock looks <adjective> to pick (Resistance R)." —
 *    the percent is shown only as LockpickSuccessPercentToString's
 *    adjective, never as "Lockpick Success Chance: N%".
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PropertyInt } from '@ac/shared';
import type { IdentifyResponseData } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { buildItemAppraisalText } from '../packages/renderer/src/ui/examine/ItemAppraisalText.js';

const REPO = resolve(__dirname, '..');
const LOCKED = 3; // PropertyBool.Locked

function examine(ints: Array<[number, number]>, bools: Array<[number, boolean]> = []): string {
  const data: IdentifyResponseData = { guid: 0x80001111, flags: 0, propertiesInt: new Map(ints), propertiesBool: new Map(bools) };
  return buildItemAppraisalText(data, { hasValueBurdenElements: true }).text;
}

describe('Appraisal — book pages (FAITHFUL.304, Appraisal_ShowCapacity @ 004b2680)', () => {
  it("renders '<pages> of <max> pages full.' from AppraisalPages (174) + AppraisalMaxPages (175)", () => {
    expect(examine([[PropertyInt.AppraisalPages, 3], [PropertyInt.AppraisalMaxPages, 10]])).toBe('3 of 10 pages full.');
    expect(examine([[PropertyInt.AppraisalPages, 0], [PropertyInt.AppraisalMaxPages, 5]])).toBe('0 of 5 pages full.');
  });

  it('retail needs both properties — either one alone shows no pages line', () => {
    expect(examine([[PropertyInt.AppraisalMaxPages, 5]])).not.toContain('pages full');
    expect(examine([[PropertyInt.AppraisalPages, 2]])).not.toContain('pages full');
  });
});

describe('Appraisal — lock difficulty (FAITHFUL.304, Appraisal_ShowLockAppraiseInfo @ 004b2790)', () => {
  it('a locked item names the pick difficulty from AppraisalLockpickSuccessPercent (173) and its resistance', () => {
    const text = examine([[PropertyInt.AppraisalLockpickSuccessPercent, 45], [PropertyInt.ResistLockpick, 250]], [[LOCKED, true]]);
    expect(text).toBe('Locked\n\nThe lock looks difficult to pick (Resistance 250).');
  });

  it('the adjective tracks the percent (0 = impossible, 95+ = trivial)', () => {
    const line = (pct: number) => examine([[PropertyInt.AppraisalLockpickSuccessPercent, pct], [PropertyInt.ResistLockpick, 100]], [[LOCKED, true]]).split('\n\n')[1];
    expect(line(0)).toBe('The lock looks impossible to pick (Resistance 100).');
    expect(line(60)).toBe('The lock looks challenging to pick (Resistance 100).');
    expect(line(99)).toBe('The lock looks trivial to pick (Resistance 100).');
  });

  it('no resistance known → "You can\'t tell how hard the lock is to pick."; unlocked → "Unlocked"', () => {
    expect(examine([[PropertyInt.AppraisalLockpickSuccessPercent, 45]], [[LOCKED, true]])).toBe("Locked\n\nYou can't tell how hard the lock is to pick.");
    expect(examine([[PropertyInt.AppraisalLockpickSuccessPercent, 45]], [[LOCKED, false]])).toBe('Unlocked');
  });

  it('retail never prints a "Lockpick Success Chance: N%" line (the old invented row)', () => {
    const text = examine([[PropertyInt.AppraisalLockpickSuccessPercent, 45], [PropertyInt.ResistLockpick, 250]], [[LOCKED, true]]);
    expect(text).not.toContain('Lockpick Success Chance');
    expect(text).not.toContain('45%');
  });
});

const ACE_PROPINT = resolve(
  REPO,
  'reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyInt.cs',
);

describe.skipIf(!aceReferenceExists(ACE_PROPINT))('ACE source pin — 3 PropertyInt IDs all [AssessmentProperty]', () => {
  let src: string;
  // Loaded in beforeAll: skipIf does not skip the describe body (CLAUDE.md).
  beforeAll(() => { src = readFileSync(ACE_PROPINT, 'utf8'); });

  function pinValue(name: string, value: number) {
    expect(src).toMatch(new RegExp(`${name}\\s+=\\s*${value}\\b`));
    const lineMatch = src.match(new RegExp(`(\\s+${name}\\s+=\\s*${value})`));
    if (lineMatch) {
      const idx = lineMatch.index ?? 0;
      const window = src.slice(Math.max(0, idx - 300), idx);
      expect(window).toMatch(/\[AssessmentProperty\]/);
    }
  }

  it('AppraisalLockpickSuccessPercent = 173 + [AssessmentProperty]', () => pinValue('AppraisalLockpickSuccessPercent', 173));
  it('AppraisalPages = 174 + [AssessmentProperty]', () => pinValue('AppraisalPages', 174));
  it('AppraisalMaxPages = 175 + [AssessmentProperty]', () => pinValue('AppraisalMaxPages', 175));
});
