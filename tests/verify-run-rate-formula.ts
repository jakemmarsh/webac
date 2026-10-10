/**
 * Run rate uses the EFFECTIVE Run skill, not raises-only (FAITHFUL.228 →
 * sweep 2026-06-11).
 *
 * `getRunRate(burden, runSkill)` expects the effective Run skill (~150-350 for
 * real characters). Two historical bugs: it once passed the Quickness ATTRIBUTE
 * (FAITHFUL.228), then passed `getRaises(Run)` — XP-purchased ranks ONLY, which
 * is 0 for nearly every character (Run is attribute-derived and rarely raised),
 * so it clamped to the 50 floor and the player ran at ~half retail speed.
 *
 * Fix: feed getBase(Run, skillTable, attributes) = ACE CreatureSkill.Base
 * (attribute formula + InitLevel + ranks; Current==Base in our model). This
 * test drives the real SkillSystem.getBase + getRunRate so it pins the BEHAVIOUR
 * (effective skill → rate), not the source text.
 *
 * Reference: ACE.Server/Physics/Common/WeenieObject.cs:129 (runSkill =
 * GetCreatureSkill(Run).Current) + Physics/Animation/MovementSystem.cs:20.
 */
import { describe, it, expect } from 'vitest';
import { getRunRate, SkillSystem, AttributeSystem, SkillAdvancementClass } from '@ac/shared';
import type { SkillBase } from '@ac/dat-parser/file-types/SkillTable.js';

const SKILL_ID_RUN = 24;

/** A minimal Run SkillBase whose formula is Quickness-derived (attr1=3, /1). */
function runSkillTable(): Map<number, SkillBase> {
  const base: SkillBase = {
    description: 'Run', name: 'Run', iconId: 0, trainedCost: 0, specializedCost: 0,
    category: 0, chargenUse: 0,
    minLevel: 1, // untrained-usable for everyone (so getBase applies the formula)
    formula: { w: 0, x: 1, y: 0, z: 1, attr1: 3 /* Quickness */, attr2: 0 },
    upperBound: 0, lowerBound: 0, learnMod: 0,
  };
  return new Map([[SKILL_ID_RUN, base]]);
}

describe('run rate is driven by the effective (attribute-derived) Run skill', () => {
  it('getBase(Run) reflects Quickness even with ZERO raises — not the 50 floor', () => {
    const attrs = new AttributeSystem({ strength: 100, endurance: 100, coordination: 100, quickness: 300, focus: 100, self: 100 });
    const skills = new SkillSystem(new Map([[SKILL_ID_RUN, SkillAdvancementClass.Untrained]]));
    const effective = skills.getBase(SKILL_ID_RUN, runSkillTable(), attrs);
    expect(skills.getRaises(SKILL_ID_RUN)).toBe(0);  // the old (broken) input
    expect(effective).toBe(300);                      // the correct input
  });

  it('feeding getBase gives a much faster rate than the old raises-floor (50)', () => {
    const attrs = new AttributeSystem({ strength: 100, endurance: 100, coordination: 100, quickness: 300, focus: 100, self: 100 });
    const skills = new SkillSystem(new Map([[SKILL_ID_RUN, SkillAdvancementClass.Untrained]]));
    const effective = Math.max(0, skills.getBase(SKILL_ID_RUN, runSkillTable(), attrs));
    const oldFloored = 50; // what getRaises() clamped to under the historical floor
    expect(getRunRate(0, effective)).toBeGreaterThan(getRunRate(0, oldFloored) * 1.5);
  });

  it('BUG.run-jump-skill-floor-invented: NO input floor — Quickness 10 runs at the raw-skill rate', () => {
    // ACE passes GetCreatureSkill(Run).Current raw into MovementSystem.GetRunRate
    // (Monster_Navigation.cs:346); the only skill clamp is Math.Max(iTotal, 0)
    // in CreatureSkill.cs:191. A Quickness-10 character has Run 10 and must get
    // (1*(10/210*11)+4)/4 ≈ 1.1310 — NOT the 1.55 a Math.max(50, skill) floor
    // would produce.
    const attrs = new AttributeSystem({ strength: 100, endurance: 100, coordination: 100, quickness: 10, focus: 100, self: 100 });
    const skills = new SkillSystem(new Map([[SKILL_ID_RUN, SkillAdvancementClass.Untrained]]));
    const effective = Math.max(0, skills.getBase(SKILL_ID_RUN, runSkillTable(), attrs));
    expect(effective).toBe(10);
    expect(getRunRate(0, effective)).toBeCloseTo(1.131, 3);
    expect(getRunRate(0, effective)).toBeLessThan(getRunRate(0, 50)); // 50-floor would inflate to 1.55
  });

  it('ACE formula behavior: higher Run skill produces faster run rate (up to cap)', () => {
    expect(getRunRate(0, 400)).toBeGreaterThan(getRunRate(0, 200));
    expect(getRunRate(0, 600)).toBeGreaterThan(getRunRate(0, 400));
  });

  it('Run skill >= 800 hits the hard cap (4.5)', () => {
    expect(getRunRate(0, 800)).toBeCloseTo(4.5);
    expect(getRunRate(0, 900)).toBeCloseTo(4.5);
  });
});
