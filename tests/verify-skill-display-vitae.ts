/**
 * BUG.skill-values-red-under-vitae — "why are my skill levels in red?"
 * (+TestChar at the 40 % vitae cap). Retail never shows vitae as a debuff
 * (ui/SkillDisplay.ts): SkillInfoRegion::GetVitaeModifier @ 004f0fa0 takes
 * it out before the list row's colour (SkillInfoRegion::Update @ 004f1ae0,
 * one "%d") and the footer title (DisplaySelectionFooter_Trained @ 0049b860:
 * "%s: %d", vitae " (%d)" in colour 3, the enchantment delta " (%s%d)").
 */
import { describe, it, expect } from 'vitest';
import { skillVitaeModifier, skillRowTone, skillFooterTitleRuns, FOOTER_TITLE_COLORS } from '../packages/renderer/src/ui/SkillDisplay.js';

describe('skill display under vitae', () => {
  it('the vitae modifier is ftol(raw × vitae) − raw (0 without vitae)', () => {
    expect(skillVitaeModifier(627, 0.6)).toBe(376 - 627);
    expect(skillVitaeModifier(627, 1)).toBe(0);
  });
  it('the list row stays green under vitae alone; a real debuff turns it red', () => {
    expect(skillRowTone(376, 627, 0.6)).toBe('raised');
    expect(skillRowTone(627, 627, 1)).toBe('raised');
    expect(skillRowTone(360, 627, 0.6)).toBe('lowered');
    expect(skillRowTone(600, 627, 1)).toBe('lowered');
  });
  it('the footer: "<name>: <value>", the vitae part in colour 3, a buff delta in green', () => {
    expect(skillFooterTitleRuns('Heavy Weapons', 376, 627, 0.6)).toEqual([
      { text: 'Heavy Weapons: 376', colorIndex: 0 },
      { text: ' (-251)', colorIndex: 3 },
    ]);
    expect(skillFooterTitleRuns('Heavy Weapons', 396, 627, 0.6)).toEqual([
      { text: 'Heavy Weapons: 396', colorIndex: 0 },
      { text: ' (-251)', colorIndex: 3 },
      { text: ' (+20)', colorIndex: 1 },
    ]);
    expect(skillFooterTitleRuns('Run', 290, 300, 1)).toEqual([
      { text: 'Run: 290', colorIndex: 0 },
      { text: ' (-10)', colorIndex: 2 },
    ]);
  });
  it('the footer title colours are the DAT p27 of 0x21000045:0x1000024e', () => {
    expect([...FOOTER_TITLE_COLORS]).toEqual([0xffffffff, 0xff00ff00, 0xffff0000, 0xff7fffff]);
  });
});
