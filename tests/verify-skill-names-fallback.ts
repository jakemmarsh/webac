/**
 * FAITHFUL.249 — Fix off-by-2 SKILL_NAMES fallback in GameUI.
 *
 * Pre-fix GameUI shipped a hand-rolled SKILL_NAMES map keyed by id. The map
 * skipped Skill.Awareness (id 25) and Skill.ArmsAndArmorRepair (id 26), so
 * everything from id 25 onward had the wrong label — e.g. asking for the
 * name of id 54 (real ACE Summoning) returned 'Skill #54'.
 *
 * The fix deletes the hand-rolled map and routes the fallback through the
 * @ac/shared `skillIdLabel` helper, which derives names from the SkillId
 * enum (which itself matches ACE Skill.cs exactly).
 *
 * This test pins the label correctness for every id ACE defines, plus the
 * specific off-by-2 fix sites (25/26/27 + 54).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { skillIdLabel, SkillId } from '@ac/shared';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

describe('FAITHFUL.249 — skill-name fallback uses ACE-anchored skillIdLabel', () => {
  let H: GameUIFixture;
  beforeAll(async () => { H = await mountGameUI(); });
  afterAll(() => H.teardown());

  it('GameUI.getSkillName (no DAT SkillTable) returns skillIdLabel for every ACE skill id 1..54 — the off-by-2 SKILL_NAMES map is gone', () => {
    expect(H.ui.skillTable ?? null).toBeNull();
    for (let id = 1; id <= 54; id++) expect(H.ui.getSkillName(id), `id ${id}`).toBe(skillIdLabel(id));
    // the specific pre-fix bad sites
    expect(H.ui.getSkillName(SkillId.Awareness)).toBe('Awareness');
    expect(H.ui.getSkillName(SkillId.AssessCreature)).toBe('Assess Creature');
    expect(H.ui.getSkillName(SkillId.Summoning)).toBe('Summoning');
  });

  it("an id skillIdLabel doesn't know falls back to 'Skill #N'", () => {
    expect(skillIdLabel(9999 as SkillId)).toBe('');
    expect(H.ui.getSkillName(9999)).toBe('Skill #9999');
  });

  it('a loaded DAT SkillTable name wins over the fallback', () => {
    const prev = H.ui.skillTable;
    H.ui.skillTable = { skills: new Map([[SkillId.Awareness, { name: 'DAT Awareness' }]]) };
    try {
      expect(H.ui.getSkillName(SkillId.Awareness)).toBe('DAT Awareness');
      expect(H.ui.getSkillName(SkillId.Summoning)).toBe('Summoning');
    } finally { H.ui.skillTable = prev; }
  });

  it('skillIdLabel produces the exact ACE Skill.cs:115-211 strings', () => {
    // Sample a handful of named ids that cover the pre-fix bad range.
    expect(skillIdLabel(SkillId.MeleeDefense)).toBe('Melee Defense');
    expect(skillIdLabel(SkillId.Awareness)).toBe('Awareness'); // id 25 — pre-fix bad
    expect(skillIdLabel(SkillId.ArmsAndArmorRepair)).toBe('Arms And Armor Repair'); // id 26 — pre-fix bad
    expect(skillIdLabel(SkillId.AssessCreature)).toBe('Assess Creature'); // id 27 — pre-fix showed 'Weapon Tinkering'
    expect(skillIdLabel(SkillId.WeaponTinkering)).toBe('Weapon Tinkering'); // id 28
    expect(skillIdLabel(SkillId.LifeMagic)).toBe('Life Magic');
    expect(skillIdLabel(SkillId.WarMagic)).toBe('War Magic');
    expect(skillIdLabel(SkillId.TwoHandedCombat)).toBe('Two Handed Combat');
    expect(skillIdLabel(SkillId.Summoning)).toBe('Summoning'); // id 54 — pre-fix showed 'Skill #54'
  });

  it('skillIdLabel covers every numeric id from 1 to 54 with a non-empty name', () => {
    for (let id = 1; id <= 54; id++) {
      const label = skillIdLabel(id);
      expect(label, `id ${id}`).not.toBe('');
      // The label should never be the raw enum value (i.e. no spaces would be
      // a sign that the helper failed to find a name).
      expect(label.length, `id ${id}`).toBeGreaterThan(0);
    }
  });
});
