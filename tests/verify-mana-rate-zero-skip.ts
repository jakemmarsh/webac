/**
 * Item examine "Mana Cost" line — ItemExamineUI::Appraisal_ShowMagicInfo
 * @ 004b2e10, now through the real builder (ui/examine/ItemAppraisalText.ts;
 * the old appraisalManaCostRow helper and its invented zero-rate skip are
 * gone with the old panel):
 *  - the Spellcraft / Mana / Mana Cost cluster renders ONLY when the spell
 *    list holds an intrinsic spell (a creature's ManaRate never prints);
 *  - InqFloat(ManaRate) present → "Mana Cost: 1 point per %d seconds." with
 *    %d = _ftol2(|1/rate| + 0.5) — signed rates (burn items) use |rate|;
 *  - a ManaRate of 0.0 (ACE world data for "no drain"; retail's server never
 *    sent one) is treated as absent — retail's _ftol2(1/0) would print
 *    "-2147483648 seconds" (BUG.mana-cost-zero-rate);
 *  - no ManaRate → PropertyInt ItemManaCost (117): "Mana Cost: %d." plus the
 *    Mana Conversion note when positive.
 */
import { describe, it, expect } from 'vitest';
import { buildItemAppraisalText } from '../packages/renderer/src/ui/examine/ItemAppraisalText.js';
import { ftol } from '../packages/renderer/src/ui/examine/appraisalFormat.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const item = (spellBook: number[], floats: [number, number][], ints: [number, number][] = []): any => ({
  guid: 1, flags: 0, spellBook,
  propertiesInt: new Map([[106, 25], [107, 59], [108, 60], ...ints]),
  propertiesFloat: new Map(floats),
});
const manaLines = (d: unknown) => buildItemAppraisalText(d as never, {
  hasValueBurdenElements: true, resolvers: { spell: () => ({ name: 'Flame Bolt I', description: 'Shoots a bolt of flame.' }) },
}).lines.map((l) => l.text).filter((t) => /^Mana/.test(t));

describe('Appraisal_ShowMagicInfo mana cost', () => {
  it('an intrinsic spell + ManaRate: "1 point per N seconds." (|rate|, rounded)', () => {
    expect(manaLines(item([27], [[5, -1 / 30]]))).toEqual(['Mana: 59 / 60.', 'Mana Cost: 1 point per 30 seconds.']);
    expect(manaLines(item([27], [[5, 1 / 60]]))).toContain('Mana Cost: 1 point per 60 seconds.');
  });
  it("no intrinsic spell → no mana cluster at all (a creature's ManaRate never prints)", () => {
    expect(manaLines(item([], [[5, -1 / 30]]))).toEqual([]);
  });
  it('a zero rate (ACE world data: "no drain") is treated as absent — no "-2147483648 seconds" line', () => {
    // _ftol2 keeps its x87 semantics for any genuine overflow…
    expect(ftol(Infinity)).toBe(-2147483648);
    expect(ftol(Number.NaN)).toBe(-2147483648);
    expect(ftol(12.9)).toBe(12);
    // …but ACE's ManaRate 0.0 (e.g. Sceptre wcid 31164) never reaches 1/0.
    const lines = manaLines(item([27], [[5, 0]]));
    expect(lines.join('\n')).not.toContain('-2147483648');
    expect(lines).toEqual(['Mana: 59 / 60.']);
    expect(buildItemAppraisalText(item([27], [[5, 0]], [[117, 10]]), { hasValueBurdenElements: true }).text).toContain('Mana Cost: 10.');
  });
  it('no ManaRate → ItemManaCost: "Mana Cost: N." with the Mana Conversion note when positive', () => {
    const lines = buildItemAppraisalText(item([27], [], [[117, 10]]), { hasValueBurdenElements: true }).text;
    expect(lines).toContain('Mana Cost: 10.\n(Can be reduced by the Mana Conversion skill)');
  });
});
