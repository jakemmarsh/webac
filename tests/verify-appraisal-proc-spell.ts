/**
 * 'Cast on Strike' in the item appraisal (FAITHFUL.314).
 *
 * Two co-located properties on proc weapons:
 *   PropertyDataId.ProcSpell    (55, [AssessmentProperty])  — spell ID
 *   PropertyFloat.ProcSpellRate (156, [AssessmentProperty]) — per-strike chance
 *
 * Now verifies what the end-of-retail client shows, via the shipped builder
 * `packages/renderer/src/ui/examine/ItemAppraisalText.ts`:
 * Appraisal_ShowSpecialProperties @ 004b0140 adds the bare token
 * "Cast on Strike" to the "Properties: …" line whenever ProcSpell (DID 55)
 * is present. Retail names neither the proc spell nor its rate there — the
 * old invented "Cast on Strike: <SpellName> (N% on strike)" row is gone.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PropertyDataId, PropertyFloat } from '@ac/shared';
import type { IdentifyResponseData } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { buildItemAppraisalText } from '../packages/renderer/src/ui/examine/ItemAppraisalText.js';

const REPO = resolve(__dirname, '..');

function body(data: Partial<IdentifyResponseData>): string {
  return buildItemAppraisalText({ guid: 0x80001111, flags: 0, ...data }, {
    hasValueBurdenElements: true,
    resolvers: { spell: (id) => (id === 1234 ? { name: 'Lightning Bolt VI', description: 'Shoots a bolt.' } : null) },
  }).text;
}

describe('Appraisal — Cast on Strike property (FAITHFUL.314, Appraisal_ShowSpecialProperties @ 004b0140)', () => {
  it('ProcSpell adds "Cast on Strike" to the Properties line', () => {
    const text = body({
      propertiesDataID: new Map([[PropertyDataId.ProcSpell, 1234]]),
      propertiesFloat: new Map([[PropertyFloat.ProcSpellRate, 0.15]]),
    });
    expect(text.split('\n')).toContain('Properties: Cast on Strike');
  });

  it('it joins the other properties in retail order (after Resistance Cleaving, before Ivoryable)', () => {
    const text = body({
      propertiesDataID: new Map([[PropertyDataId.ProcSpell, 1234]]),
      propertiesBool: new Map([[99, true] /* Ivoryable */]),
      propertiesFloat: new Map([[PropertyFloat.CriticalFrequency, 1.5]]),
    });
    expect(text.split('\n')).toContain('Properties: Biting Strike, Cast on Strike, Ivoryable');
  });

  it('retail names neither the proc spell nor its rate', () => {
    const text = body({
      propertiesDataID: new Map([[PropertyDataId.ProcSpell, 1234]]),
      propertiesFloat: new Map([[PropertyFloat.ProcSpellRate, 0.15]]),
    });
    expect(text).not.toContain('Lightning Bolt VI');
    expect(text).not.toContain('15%');
    expect(text).not.toContain('Cast on Strike:');
  });

  it('no ProcSpell (a rate alone) → no Cast on Strike', () => {
    expect(body({ propertiesFloat: new Map([[PropertyFloat.ProcSpellRate, 0.5]]) })).not.toContain('Cast on Strike');
  });
});

const ACE_DATAID = resolve(
  REPO,
  'reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyDataId.cs',
);
const ACE_FLOAT = resolve(
  REPO,
  'reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyFloat.cs',
);

describe.skipIf(!aceReferenceExists(ACE_DATAID) || !aceReferenceExists(ACE_FLOAT))(
  'ACE source pin — ProcSpell + ProcSpellRate IDs + decorators',
  () => {
    let didSrc: string;
    let floatSrc: string;
    // Loaded in beforeAll: skipIf does not skip the describe body (CLAUDE.md).
    beforeAll(() => {
      didSrc = readFileSync(ACE_DATAID, 'utf8');
      floatSrc = readFileSync(ACE_FLOAT, 'utf8');
    });

    it('PropertyDataId.ProcSpell = 55 + [AssessmentProperty]', () => {
      expect(didSrc).toMatch(/ProcSpell\s+=\s*55\b/);
      const idx = didSrc.indexOf('ProcSpell                        = 55');
      expect(idx).toBeGreaterThan(0);
      expect(didSrc.slice(Math.max(0, idx - 200), idx)).toMatch(/\[AssessmentProperty\]/);
    });

    it('PropertyFloat.ProcSpellRate = 156 + [AssessmentProperty]', () => {
      expect(floatSrc).toMatch(/ProcSpellRate\s+=\s*156/);
      const idx = floatSrc.indexOf('ProcSpellRate                  = 156');
      expect(idx).toBeGreaterThan(0);
      expect(floatSrc.slice(Math.max(0, idx - 200), idx)).toMatch(/\[AssessmentProperty\]/);
    });
  },
);
