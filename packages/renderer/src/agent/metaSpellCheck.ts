/**
 * Can you cast this spell under the macro's settings? VirindiTank's
 * getcancastspell_hunt / getcancastspell_buff and /vt testspell (wiki
 * Meta_Expressions: "examines scarab count, buffed skill, and presence in the
 * spellbook. Skill is checked against SpellDiffExcessThreshold-Hunt" or
 * "-Buff"; Virindi_Tank_Commands: "Tests whether you know a spell and if you
 * can cast it based on your threshold mods"). The spell's difficulty (power)
 * plus the threshold must be within your buffed skill in its school, and you
 * must carry every component the server will charge.
 */
import type { AgentItem, AgentSpell } from './types.ts';

/** The magic schools' skills (ACE Skill: Creature 31, Item 32, Life 33, War 34, Void 43). */
const SCHOOL_SKILL: Record<string, number> = { 'creature enchantment': 31, 'item enchantment': 32, 'life magic': 33, 'war magic': 34, 'void magic': 43 };

export interface SpellCheckInput {
  spells(filter: string, max: number): AgentSpell[];
  skillList(): Array<{ id: number; name: string; training: 'untrained' | 'trained' | 'specialized'; base: number; buffed: number }>;
  spellComponents(spellId: number): string[];
  inventory(): AgentItem[];
}

export interface SpellCheck {
  id: number;
  name: string;
  known: boolean;
  school: string;
  power: number;
  /** Your buffed skill in the school; null when you lack it (untrained or absent). */
  skill: number | null;
  threshold: number;
  skillOk: boolean;
  /** Components the server would charge that you don't carry. */
  missing: string[];
  castable: boolean;
}

export function checkSpell(api: SpellCheckInput, setting: (name: string) => unknown, id: number, kind: 'hunt' | 'buff'): SpellCheck {
  const spell = api.spells('', 100000).find((s) => s.id === id);
  const threshold = Number(setting(kind === 'hunt' ? 'SpellDiffExcessThreshold-Hunt' : 'SpellDiffExcessThreshold-Buff')) || 0;
  const school = spell?.school ?? '';
  const sk = api.skillList().find((s) => s.name.toLowerCase() === school.toLowerCase()) ?? api.skillList().find((s) => s.id === SCHOOL_SKILL[school.toLowerCase()]);
  const skill = sk && sk.training !== 'untrained' ? sk.buffed : null;
  const power = spell?.power ?? 0;
  const skillOk = skill !== null && power + threshold <= skill;
  const carried = new Set(api.inventory().map((i) => i.name.toLowerCase()));
  const missing = spell ? [...new Set(api.spellComponents(id))].filter((c) => !carried.has(c.toLowerCase())) : [];
  return { id, name: spell?.name ?? '', known: !!spell, school, power, skill, threshold, skillOk, missing, castable: !!spell && skillOk && missing.length === 0 };
}

/** /vt testspell's answer, a line for chat. */
export function spellCheckText(c: SpellCheck): string {
  if (!c.known) return `Spell ${c.id}: not in your spellbook.`;
  const hunt = `${c.name} (${c.id}, ${c.school}, difficulty ${c.power})`;
  const skill = c.skill === null ? `you have no ${c.school} skill` : `skill ${c.skill} vs ${c.power} + ${c.threshold} threshold${c.skillOk ? '' : ': too low'}`;
  const comps = c.missing.length ? `; missing ${c.missing.join(', ')}` : '';
  return `${hunt}: ${c.castable ? 'castable' : 'not castable'} (${skill}${comps}).`;
}
