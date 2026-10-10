/**
 * How retail shows a skill's value (BUG.skill-values-red-under-vitae) —
 * vitae is NEVER shown as a debuff:
 *
 *  - SkillInfoRegion::GetVitaeModifier @ 004f0fa0: with a vitae enchantment
 *    below 1.0, the modifier is ftol(raw × vitae) − raw (raw = the
 *    unenchanted skill, InqSkill(…, 1)) — negative.
 *  - The list row, SkillInfoRegion::Update @ 004f1ae0: ONE number ("%d",
 *    .rdata 0x7a0184) in the row value's colour index 1 (green) or 2 (red)
 *    by comparing the current value WITHOUT the vitae modifier against the
 *    base — vitae alone leaves the row green (reference/images/hud/
 *    character-panel-skills.jpg: an unbuffed character's skills are green).
 *  - The footer title, gmSkillUI::DisplaySelectionFooter_Trained @ 0049b860
 *    (formats read from acclient.exe .rdata): "%s: %d" (0x7a7854) — the name
 *    and the current value, colour 0 — then, with vitae, " (%d)" (0x7a7848)
 *    the vitae modifier in colour 3, then the enchantment delta (current −
 *    vitae modifier − raw), when non-zero, " (%s%d)" (0x7a7834) with "+"
 *    (0x7a7844) in colour 1 when positive, colour 2 when negative.
 *    0x21000045:0x1000024e p27 = white, green, red, 0xFF7FFFFF.
 */
export const FOOTER_TITLE_COLORS = [0xffffffff, 0xff00ff00, 0xffff0000, 0xff7fffff] as const;

/** GetVitaeModifier: ftol(raw × vitae) − raw, 0 without (a below-1.0) vitae. */
export function skillVitaeModifier(raw: number, vitae: number): number {
  if (!(vitae < 1)) return 0;
  return Math.trunc(raw * vitae) - raw;
}

/** The list row's colour: green unless something other than vitae lowered it below its base (then red). */
export function skillRowTone(current: number, raw: number, vitae: number): 'raised' | 'lowered' {
  return current - skillVitaeModifier(raw, vitae) < raw ? 'lowered' : 'raised';
}

export interface TextRun { text: string; colorIndex: 0 | 1 | 2 | 3 }

/** The selected-skill footer title runs. */
export function skillFooterTitleRuns(name: string, current: number, raw: number, vitae: number): TextRun[] {
  const runs: TextRun[] = [{ text: `${name}: ${current}`, colorIndex: 0 }];
  const vitaeMod = skillVitaeModifier(raw, vitae);
  if (vitaeMod < 0) runs.push({ text: ` (${vitaeMod})`, colorIndex: 3 });
  const delta = current - vitaeMod - raw;
  if (delta !== 0) runs.push({ text: ` (${delta > 0 ? '+' : ''}${delta})`, colorIndex: delta > 0 ? 1 : 2 });
  return runs;
}

export const argbToCss = (argb: number): string => `#${((argb >>> 0) & 0xffffff).toString(16).padStart(6, '0')}`;
