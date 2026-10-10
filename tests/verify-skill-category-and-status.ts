/**
 * SkillCategory enum + advancement-class label helper (FAITHFUL.282).
 *
 * GameUI.ts had two hardcoded ad-hoc maps:
 *   const categoryLabels: Record<number, string> = { 1: 'Combat', 2: 'Other', 3: 'Magic' };
 *   const advancementNames: Record<number, string> = { 0: 'Unusable', 1: 'Untrained', 2: 'Trained', 3: 'Specialized' };
 *
 * The category map silently funneled the canonical Undef=0 case through
 * the fallback. The advancement-class map duplicated the existing
 * SkillAdvancementClass enum semantics inline. Both now flow through
 * symbolic helpers in @ac/shared:
 *   - skillCategoryLabel(n) — sourced from ACViewer SkillBase.cs (Undef=0/
 *     Combat=1/Other=2/Magic=3).
 *   - skillAdvancementClassLabel(n) — wording sourced from DAT StringTable
 *     0x23000001 ("Unusable Skills" id=117264604, "Untrained Skills"
 *     id=81815804, "Specialized Skills" id=78881532).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { SkillCategory, skillCategoryLabel, skillAdvancementClassLabel } from '@ac/shared';

const REPO = resolve(__dirname, '..');
const ACVIEWER_SRC = resolve(REPO, 'reference/ACViewer/ACViewer/Entity/SkillBase.cs');

describe('SkillCategory enum (FAITHFUL.282)', () => {
  it('matches ACViewer SkillBase.cs values', () => {
    expect(SkillCategory.Undef).toBe(0);
    expect(SkillCategory.Combat).toBe(1);
    expect(SkillCategory.Other).toBe(2);
    expect(SkillCategory.Magic).toBe(3);
  });
});

describe.skipIf(!existsSync(ACVIEWER_SRC))('ACViewer source faithfulness', () => {
  // CI clones only reference/ACE, not reference/ACViewer; a skipped
  // describe's callback still runs at collection, so the read lives in
  // beforeAll (CLAUDE.md).
  let src: string;
  beforeAll(() => { src = readFileSync(ACVIEWER_SRC, 'utf8'); });
  it('the canonical SkillCategory enum exists in ACViewer source', () => {
    expect(src).toMatch(/enum SkillCategory/);
    expect(src).toMatch(/Undef\s*=\s*0/);
    expect(src).toMatch(/Combat\s*=\s*1/);
    expect(src).toMatch(/Other\s*=\s*2/);
    expect(src).toMatch(/Magic\s*=\s*3/);
  });
});

describe('skillCategoryLabel (FAITHFUL.282)', () => {
  it('returns the three retail labels for the canonical cases', () => {
    expect(skillCategoryLabel(SkillCategory.Combat)).toBe('Combat');
    expect(skillCategoryLabel(SkillCategory.Magic)).toBe('Magic');
    expect(skillCategoryLabel(SkillCategory.Other)).toBe('Other');
  });

  it('returns "Other" for Undef (0) — matches retail catch-all behavior', () => {
    expect(skillCategoryLabel(SkillCategory.Undef)).toBe('Other');
  });

  it('returns "Other" for unknown values — defensive fallback', () => {
    expect(skillCategoryLabel(99)).toBe('Other');
    expect(skillCategoryLabel(-1)).toBe('Other');
  });
});

describe('skillAdvancementClassLabel (FAITHFUL.282)', () => {
  it('uses retail-DAT wording for the 4 canonical advancement classes', () => {
    expect(skillAdvancementClassLabel(0)).toBe('Unusable');     // SkillAdvancementClass.Inactive
    expect(skillAdvancementClassLabel(1)).toBe('Untrained');
    expect(skillAdvancementClassLabel(2)).toBe('Trained');
    expect(skillAdvancementClassLabel(3)).toBe('Specialized');
  });

  it('falls back to "Unusable" for unknown values', () => {
    expect(skillAdvancementClassLabel(99)).toBe('Unusable');
    expect(skillAdvancementClassLabel(-1)).toBe('Unusable');
  });
});

// DEBT.test-harness-hygiene: the former GameUI.ts source pins here ("imports
// skillAdvancementClassLabel", "the categoryLabels / advancementNames literals
// are gone", "renderSkillsStep no longer calls skillCategoryLabel") checked
// local-variable text with no runtime surface of their own. The behaviour they
// guarded is executed elsewhere:
//  - the census wording (skillAdvancementClassLabel's Specialized/Trained/
//    Untrained/Unusable reaching charInfo.skills via syncFromPlayerState):
//    tests/verify-char-panel-native-panes.ts ('CORE.6.c — skills census');
//  - GAP.81 (cycle 2026-07-20f): the chargen Skills-step list groups by the
//    retail gmCGSkillsPage::UpdateSkillEntry 4-section split (Specialized/
//    Trained/Useable Untrained/Unuseable Untrained), not by SkillCategory:
//    tests/verify-chargen-skill-sections.ts.
