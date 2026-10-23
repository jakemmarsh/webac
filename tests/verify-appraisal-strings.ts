/**
 * Appraisal PropertyStrings — Inscription / Destination / Tinker name
 * (FAITHFUL.306; label corrected by VISUAL.examine-portal-destination-label).
 *
 * Three `[AssessmentProperty]` PropertyString fields surface on examine:
 *
 *   7  = Inscription                — player-applied inscribed text
 *   38 = AppraisalPortalDestination — destination string for portals
 *   39 = TinkerName                 — name of player who last tinkered the item
 *
 * Now verifies the shipped end-of-retail builders:
 *  - ItemAppraisalText (buildItemAppraisalText): Appraisal_ShowLevelLimitInfo
 *    @ 004b2920 writes "Destination: " + InqString(38) (no "Portal" in the
 *    label); Appraisal_ShowTinkeringInfo @ 004b0e70 writes
 *    "Last tinkered by <name>." (retail has no "Tinkered By:" row).
 *  - ExaminationWindow.examineInscription: ItemExamineUI::SetInscription
 *    @ 004ae2f0 puts the inscription in its own element 0x1000013e with the
 *    "--<scribe>" signature in 0x1000013f — never an "Inscription:" body row.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PropertyString } from '@ac/shared';
import { buildItemAppraisalText } from '../packages/renderer/src/ui/examine/ItemAppraisalText.js';
import { examineInscription } from '../packages/renderer/src/ui/examine/ExaminationWindow.js';

const REPO = resolve(__dirname, '..');
const SCRIBE_NAME = 8; // PropertyString.ScribeName
const INSCRIBABLE = 0x2; // PublicWeenieDesc ObjectDescriptionFlags

const body = (strings: Array<[number, string]>) =>
  buildItemAppraisalText({ guid: 0x60001234, flags: 0, propertiesString: new Map(strings) }, { hasValueBurdenElements: true }).text;

describe('Appraisal string properties (retail ItemExamineUI wording)', () => {
  it("portal destination renders retail's 'Destination: <name>' — no 'Portal' in the label", () => {
    const text = body([[PropertyString.AppraisalPortalDestination, 'Redspire']]);
    expect(text).toBe('Destination: Redspire');
    expect(text).not.toContain('Portal Destination');
  });

  it("tinker name renders as 'Last tinkered by <name>.'", () => {
    const text = body([[PropertyString.TinkerName, 'Tinkerbell']]);
    expect(text.split('\n')[0]).toBe('Last tinkered by Tinkerbell.');
    expect(text).not.toContain('Tinkered By:');
  });

  it('the inscription is not part of the appraisal body', () => {
    const text = body([[PropertyString.Inscription, 'For the Queen'], [SCRIBE_NAME, 'Asheron']]);
    expect(text).not.toContain('For the Queen');
    expect(text).not.toContain('Inscription');
  });

  it('absent properties write none of these lines', () => {
    const text = body([]);
    expect(text).not.toContain('Destination');
    expect(text).not.toContain('tinkered');
  });
});

describe('Inscription block 0x1000013e / 0x1000013f (ItemExamineUI::SetInscription @ 004ae2f0)', () => {
  it('an inscribed item shows the text with a "--<scribe>" signature', () => {
    expect(examineInscription(INSCRIBABLE, new Map([[PropertyString.Inscription, 'For the Queen'], [SCRIBE_NAME, 'Asheron']])))
      .toEqual({ visible: true, text: 'For the Queen', signature: '--Asheron', scribe: 'Asheron', inscription: 'For the Queen' });
  });

  it('an inscribable item nobody has signed invites "<Inscribe here>"', () => {
    expect(examineInscription(INSCRIBABLE, new Map())).toEqual({ visible: true, text: '<Inscribe here>', signature: '', scribe: '', inscription: '', placeholder: true });
  });

  it('a non-inscribable item hides the block even if it carries an inscription string', () => {
    expect(examineInscription(0, new Map([[PropertyString.Inscription, 'For the Queen']])).visible).toBe(false);
  });
});

// ─── ACE source pin — PropertyString IDs + [AssessmentProperty] decorators ───
const ACE_PROPSTR = resolve(
  REPO,
  'reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyString.cs',
);

describe.skipIf(!aceReferenceExists(ACE_PROPSTR))('ACE source pin — 3 PropertyString IDs + decorators', () => {
  // CLAUDE.md landmine: describe.skipIf does NOT skip the callback body, so
  // the file read must live in beforeAll — never at the top of the callback.
  let src = '';
  beforeAll(() => { src = readFileSync(ACE_PROPSTR, 'utf8'); });

  function pinAssessment(name: string, value: number) {
    expect(src).toMatch(new RegExp(`${name}\\s+=\\s*${value}\\b`));
    const idx = src.search(new RegExp(`\\s${name}\\s+=\\s*${value}`));
    if (idx >= 0) {
      const window = src.slice(Math.max(0, idx - 200), idx);
      expect(window).toMatch(/\[AssessmentProperty\]/);
    }
  }

  it('Inscription = 7 + [AssessmentProperty]', () => pinAssessment('Inscription', 7));
  it('AppraisalPortalDestination = 38 + [AssessmentProperty]', () => pinAssessment('AppraisalPortalDestination', 38));
  it('TinkerName = 39 + [AssessmentProperty]', () => pinAssessment('TinkerName', 39));
});
