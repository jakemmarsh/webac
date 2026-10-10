/**
 * The wire → SkillSystem mappings of the two skill paths (FAITHFUL.590,
 * RECON.skill-raise-ignores-pp). Both carry InitLevel (the specialization
 * bonus) and ExperienceSpent (Skill::_pp, which retail's raise cost
 * subtracts), and both were once dropped here.
 */
export interface SkillStore {
  setSkill(skillId: number, advancementClass: number, raises: number, initLevel?: number, experienceSpent?: number): void;
}

/** PlayerDescription (login snapshot): one skill record. */
export function applyDescriptionSkill(
  skills: SkillStore,
  sk: { skillId: number; advancementClass: number; ranks: number; initLevel: number; cpSpent?: number },
): void {
  skills.setSkill(sk.skillId, sk.advancementClass, sk.ranks, sk.initLevel, sk.cpSpent);
}

/** PrivateUpdateSkill: `points` is ACE's Ranks (FAITHFUL.566). */
export function applySkillUpdate(
  skills: SkillStore,
  data: { key: number; advancementClass: number; points?: number; initLevel?: number; cpSpent?: number },
): void {
  skills.setSkill(data.key, data.advancementClass, data.points ?? 0, data.initLevel ?? 0, data.cpSpent);
}
