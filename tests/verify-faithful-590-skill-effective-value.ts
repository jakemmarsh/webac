/**
 * FAITHFUL.590 — Skill panel effective value.
 *
 * Two defects (faithfulness sweep 2026-06-03, findings #1 + #2):
 *
 * 1. GameUI.syncFromPlayerState built each skill row with
 *    `base: raises, effective: raises` — only the XP-purchased raises count —
 *    so every skill in the Character panel displayed without its
 *    attribute-derived base (a 651 War Magic showed as ~290).
 *
 * 2. Skill InitLevel (+10 for specialized skills, ACE Player_Skills.cs:236)
 *    was parsed off the wire by both PlayerDescriptionParser
 *    (GameEventPlayerDescription.cs:317) and the PrivateUpdateSkill handler,
 *    but dropped by both setSkill call sites — specialized skills read 10 low.
 *
 * ACE ground truth — ACE.Server/WorldObjects/Entity/CreatureSkill.cs:
 *   IsUsable (:48-65)  = Trained || Specialized
 *                        || (Untrained && DAT SkillTable MinLevel == 1)
 *   Base     (:136-151) = (IsUsable ? AttributeFormula : 0) + InitLevel + Ranks
 *   Current  (:153-193) = Base, then enchantment/vitae/aug layers (not modeled
 *                         in SkillSystem, so Current == Base client-side)
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SkillSystem, computeSkillBase } from '../packages/shared/src/character/SkillSystem.js';
import { AttributeSystem } from '../packages/shared/src/character/AttributeSystem.js';
import { SkillAdvancementClass } from '../packages/shared/src/character/Heritage.js';
import type { SkillBase, SkillFormula } from '@ac/dat-parser';

const __dir = dirname(fileURLToPath(import.meta.url));
const RENDERER = join(__dir, '..', 'packages', 'renderer', 'src');

/** Synthetic SkillBase rows so these tests run without DAT files (CI-safe). */
function fakeSkill(formula: Partial<SkillFormula>, minLevel: number): SkillBase {
  return {
    description: '', name: 'Fake', iconId: 0,
    trainedCost: 4, specializedCost: 8, category: 1, chargenUse: 1,
    minLevel,
    formula: { w: 0, x: 1, y: 1, z: 2, attr1: 5, attr2: 6, ...formula },
    upperBound: 0, lowerBound: 0, learnMod: 1,
  } as SkillBase;
}

// Focus 200, Self 196 → War-Magic-style formula (Focus+Self)/4 = 99
const attrs = new AttributeSystem({
  strength: 100, endurance: 100, coordination: 100,
  quickness: 100, focus: 200, self: 196,
});

const WAR = 34;
const skillTable = new Map<number, SkillBase>([
  [WAR, fakeSkill({ x: 1, y: 1, z: 4, attr1: 5, attr2: 6 }, 5)], // unusable untrained (minLevel 5)
  [22, fakeSkill({ x: 1, y: 1, z: 2, attr1: 3, attr2: 4 }, 1)],  // Jump-like, usable untrained
]);

describe('FAITHFUL.590: SkillSystem matches ACE CreatureSkill.Base/Current', () => {
  it('specialized skill = formula + InitLevel(10) + ranks (CreatureSkill.cs:136-151)', () => {
    const sys = new SkillSystem(new Map());
    sys.setSkill(WAR, SkillAdvancementClass.Specialized, 290, 10);
    const formula = computeSkillBase(skillTable.get(WAR)!.formula, attrs); // (200+196)/4 = 99
    expect(formula).toBe(99);
    expect(sys.getBase(WAR, skillTable, attrs)).toBe(99 + 10 + 290);
    expect(sys.getTotal(WAR, skillTable, attrs)).toBe(399);
  });

  it('trained skill = formula + ranks (InitLevel 0)', () => {
    const sys = new SkillSystem(new Map());
    sys.setSkill(WAR, SkillAdvancementClass.Trained, 50, 0);
    expect(sys.getTotal(WAR, skillTable, attrs)).toBe(99 + 50);
  });

  it('untrained skill with MinLevel == 1 gets the attribute formula (IsUsable, CreatureSkill.cs:48-65)', () => {
    const sys = new SkillSystem(new Map([[22, SkillAdvancementClass.Untrained]]));
    // (Quickness 100 + Coordination 100) / 2 = 100
    expect(sys.getTotal(22, skillTable, attrs)).toBe(100);
  });

  it('untrained skill with MinLevel != 1 is unusable → 0 (no formula)', () => {
    const sys = new SkillSystem(new Map([[WAR, SkillAdvancementClass.Untrained]]));
    expect(sys.getTotal(WAR, skillTable, attrs)).toBe(0);
    expect(sys.getBase(WAR, skillTable, attrs)).toBe(0);
  });

  it('inactive skill → 0', () => {
    const sys = new SkillSystem(new Map([[WAR, SkillAdvancementClass.Inactive]]));
    expect(sys.getTotal(WAR, skillTable, attrs)).toBe(0);
  });

  it('setSkill stores initLevel and defaults it to 0 when omitted (back-compat)', () => {
    const sys = new SkillSystem(new Map());
    sys.setSkill(WAR, SkillAdvancementClass.Specialized, 5, 10);
    expect(sys.getInitLevel(WAR)).toBe(10);
    sys.setSkill(WAR, SkillAdvancementClass.Trained, 5);
    expect(sys.getInitLevel(WAR)).toBe(0); // re-set without initLevel clears it
  });

  it('getTotal == getBase (Current adds only enchant/vitae/aug layers, none modeled)', () => {
    const sys = new SkillSystem(new Map());
    sys.setSkill(WAR, SkillAdvancementClass.Specialized, 123, 10);
    expect(sys.getTotal(WAR, skillTable, attrs)).toBe(sys.getBase(WAR, skillTable, attrs));
  });
});

describe('FAITHFUL.590: wire→state→panel plumbing (source-anchored)', () => {
  const gameUiSrc = readFileSync(join(RENDERER, 'ui', 'GameUI.ts'), 'utf8');

  // The two wire paths now run through network/skillState.ts (behavioural
  // tests below); main.ts calls them for PlayerDescription and PrivateUpdateSkill.

  it('GameUI.syncFromPlayerState derives effective from getTotal, not raises', () => {
    expect(gameUiSrc).toMatch(/state\.skills\.getTotal\(id,\s*this\.skillTable\.skills,\s*state\.attributes\)/);
    // The old defect — both fields hardcoded to the raises count — must not return.
    expect(gameUiSrc).not.toMatch(/base:\s*raises,\s*effective:\s*raises/);
  });
});

describe('FAITHFUL.590 / RECON.skill-raise-ignores-pp — the wire → SkillSystem mappings (behavioural)', () => {
  it('PlayerDescription and PrivateUpdateSkill both keep initLevel and ExperienceSpent', async () => {
    const { SkillSystem } = await import('../packages/shared/src/character/SkillSystem.js');
    const { applyDescriptionSkill, applySkillUpdate } = await import('../packages/renderer/src/network/skillState.js');
    const s = new SkillSystem(new Map());
    applyDescriptionSkill(s, { skillId: 24, advancementClass: 3, ranks: 9, initLevel: 10, cpSpent: 588 });
    expect([s.getRaises(24), s.getInitLevel(24), s.getExperienceSpent(24)]).toEqual([9, 10, 588]);
    applySkillUpdate(s, { key: 24, advancementClass: 3, points: 10, initLevel: 10, cpSpent: 671 });
    expect([s.getRaises(24), s.getInitLevel(24), s.getExperienceSpent(24)]).toEqual([10, 10, 671]);
  });
});
