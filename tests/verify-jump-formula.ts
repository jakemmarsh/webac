/**
 * Jump height uses the EFFECTIVE Jump skill, not raises-only (FAITHFUL.230 →
 * sweep 2026-06-11).
 *
 * `getJumpHeight(burden, jumpSkill, power)` expects the effective Jump skill.
 * Historical bugs: it once derived from (Str+Coord)/2 (FAITHFUL.230), then
 * passed `getRaises(Jump)` — ranks ONLY, ~0 for most characters — so it clamped
 * to the 50 floor and jumps fell far short of retail (skill 50 → height factor
 * ≈0.87 vs ~250 → ≈3.6), causing visible server position-correction on landing.
 *
 * Fix: feed getBase(Jump, skillTable, attributes) = ACE CreatureSkill.Base.
 * This test drives the real SkillSystem.getBase + getJumpHeight.
 *
 * Reference: ACE.Server/WorldObjects/Player.cs jump handler →
 *   MovementSystem.GetJumpHeight(burden, GetCreatureSkill(Jump).Current, …)
 */
import { describe, it, expect } from 'vitest';
import { getJumpHeight, getJumpVelocity, SkillSystem, AttributeSystem, SkillAdvancementClass } from '@ac/shared';
import type { SkillBase } from '@ac/dat-parser/file-types/SkillTable.js';

const SKILL_ID_JUMP = 22;

/** Minimal Jump SkillBase: attribute-derived (Str+Coord)/2, untrained-usable. */
function jumpSkillTable(): Map<number, SkillBase> {
  const base: SkillBase = {
    description: 'Jump', name: 'Jump', iconId: 0, trainedCost: 0, specializedCost: 0,
    category: 0, chargenUse: 0,
    minLevel: 1,
    formula: { w: 0, x: 1, y: 1, z: 2, attr1: 1 /* Strength */, attr2: 4 /* Coordination */ },
    upperBound: 0, lowerBound: 0, learnMod: 0,
  };
  return new Map([[SKILL_ID_JUMP, base]]);
}

describe('jump height is driven by the effective (attribute-derived) Jump skill', () => {
  it('getBase(Jump) reflects Str/Coord even with ZERO raises — not the 50 floor', () => {
    const attrs = new AttributeSystem({ strength: 200, endurance: 100, coordination: 200, quickness: 100, focus: 100, self: 100 });
    const skills = new SkillSystem(new Map([[SKILL_ID_JUMP, SkillAdvancementClass.Untrained]]));
    const effective = skills.getBase(SKILL_ID_JUMP, jumpSkillTable(), attrs);
    expect(skills.getRaises(SKILL_ID_JUMP)).toBe(0); // the old (broken) input
    expect(effective).toBe(200);                     // floor((200+200)/2)
  });

  it('feeding getBase produces a much taller jump than the old raises-floor (50)', () => {
    const attrs = new AttributeSystem({ strength: 200, endurance: 100, coordination: 200, quickness: 100, focus: 100, self: 100 });
    const skills = new SkillSystem(new Map([[SKILL_ID_JUMP, SkillAdvancementClass.Untrained]]));
    const effective = Math.max(0, skills.getBase(SKILL_ID_JUMP, jumpSkillTable(), attrs));
    const oldFloored = 50; // what getRaises() clamped to under the historical floor
    expect(getJumpHeight(0, effective, 1.0)).toBeGreaterThan(getJumpHeight(0, oldFloored, 1.0) * 1.5);
  });

  it('BUG.run-jump-skill-floor-invented: NO input floor — Jump 10 bottoms out at the 0.35 RESULT minimum', () => {
    // ACE passes GetCreatureSkill(Jump).Current raw into GetJumpHeight
    // (Player.cs:891); MovementSystem.cs floors only the RESULT at 0.35,
    // never the skill input. Str/Coord 10 → Jump 10 →
    // (10/1310*22.2 + 0.05) ≈ 0.219 → clamped to 0.35 — NOT the ≈0.872 a
    // Math.max(50, skill) input floor would produce.
    const attrs = new AttributeSystem({ strength: 10, endurance: 100, coordination: 10, quickness: 100, focus: 100, self: 100 });
    const skills = new SkillSystem(new Map([[SKILL_ID_JUMP, SkillAdvancementClass.Untrained]]));
    const effective = Math.max(0, skills.getBase(SKILL_ID_JUMP, jumpSkillTable(), attrs));
    expect(effective).toBe(10);
    expect(getJumpHeight(0, effective, 1.0)).toBeCloseTo(0.35, 6);
    expect(getJumpHeight(0, effective, 1.0)).toBeLessThan(getJumpHeight(0, 50, 1.0)); // 50-floor would inflate to ≈0.872
  });

  it('higher Jump skill produces higher jump height (monotonic)', () => {
    expect(getJumpHeight(0, 600, 1.0)).toBeGreaterThan(getJumpHeight(0, 200, 1.0));
    expect(getJumpHeight(0, 800, 1.0)).toBeGreaterThan(getJumpHeight(0, 600, 1.0));
  });

  it('FAITHFUL.231: over-burdened (>= 1.0) reduces jump height per ACE getBurdenMod', () => {
    // burdenMod: 1.0 for burden<1.0; 1.0<b<2.0 → 2.0-b; b>=2.0 → 0.0.
    const unloaded = getJumpHeight(0, 400, 1.0);     // burdenMod 1.0
    const overloaded = getJumpHeight(1.5, 400, 1.0); // burdenMod 0.5
    expect(overloaded).toBeLessThan(unloaded);
    expect(overloaded).toBeCloseTo(unloaded * 0.5);
  });
});

describe('FORMULA.20: getJumpVelocity matches ACE launch formula v0 = sqrt(height * 19.6)', () => {
  it('is sqrt(2·g·h) for the corresponding jump height (WeenieObject.cs:95)', () => {
    for (const [burden, skill, power] of [[0, 200, 1.0], [0, 600, 1.0], [1.5, 400, 0.5]] as const) {
      const h = getJumpHeight(burden, skill, power);
      expect(getJumpVelocity(burden, skill, power)).toBeCloseTo(Math.sqrt(h * 19.6), 6);
    }
  });

  it('higher Jump skill -> higher launch velocity (monotonic)', () => {
    expect(getJumpVelocity(0, 600, 1.0)).toBeGreaterThan(getJumpVelocity(0, 200, 1.0));
  });

  it('apex height from v0 under g=9.8 equals the target jump height (v0^2/2g = h)', () => {
    const h = getJumpHeight(0, 400, 1.0);
    const v0 = getJumpVelocity(0, 400, 1.0);
    expect((v0 * v0) / (2 * 9.8)).toBeCloseTo(h, 6);
  });
});
