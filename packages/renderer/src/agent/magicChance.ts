/**
 * The chance a cast gets past the skill roll: ACE SkillCheck.GetMagicSkillChance (and the AC1999 server's, the same
 * curve): 1 − 1 / (1 + e^(0.07 · (skill − difficulty))), the difficulty being the spell's power. ACE also lets no cast
 * land at all with the skill under difficulty − 50 (Player_Magic GetCastingPreCheckStatus); AC1999 has no such floor.
 * Its own module so the macro's pure planners (buffPlan.ts) read the same curve as AgentApi's level picks.
 */
export function magicSkillChance(skill: number, difficulty: number): number {
  return Math.min(1, Math.max(0, 1 - 1 / (1 + Math.exp(0.07 * (skill - difficulty)))));
}
