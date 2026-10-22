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

/**
 * A stat as the 1999 client's InfoBox::SetBase reads it (REVERT.ac1999-forked-panels:
 * the 1999 wording in the shared footer; eraClientRules().statLineText 'ac1999').
 */
export interface StatLine1999 {
  kind: 'attribute' | 'vital' | 'skill';
  name: string;
  /** Attribute / skill: the enchanted value. Vital: the current value. */
  value: number;
  /** Vital: the enchanted maximum. */
  max?: number;
  /** The unenchanted value (attribute / skill), or a vital's unenchanted maximum without vitae. */
  base: number;
  /** An enchantment (not vitae) touches it: SetBase's " (+0)" when they cancel out. */
  enchanted: boolean;
}

/**
 * The 1999 vitae part of a value (0x005b2b90): none for an attribute (vitae
 * never touched primaries) or without vitae, else round(base × multiplier) −
 * base, the float floored at 0 below 0.5.
 */
export function vitaeDelta1999(stat: Pick<StatLine1999, 'kind' | 'base'>, vitaeMultiplier: number): number {
  if (stat.kind === 'attribute' || !(vitaeMultiplier < 1)) return 0;
  let v = stat.base * vitaeMultiplier;
  if (v <= 0.5) v = 0;
  return Math.floor(v + 0.5) - stat.base;
}

/** The 1999 enchantments' part (0x005b2ca0): the enchanted value less vitae, less the base. */
export function enchantDelta1999(stat: StatLine1999, vitaeMultiplier: number): number {
  const value = stat.kind === 'vital' ? (stat.max ?? 0) : stat.value;
  return value - vitaeDelta1999(stat, vitaeMultiplier) - stat.base;
}

/** " (Must be trained)" (1999 client.exe .rdata 0x608e04). */
export const MUST_BE_TRAINED_1999 = ' (Must be trained)';

/**
 * The 1999 client's stat line, InfoBox::SetBase @ 0x00544a70, as the shared
 * footer title's runs: "Name value" ("cur/max" for a vital, " (Must be
 * trained)" for a skill at 0) in colour 0, then the vitae " (-n)" (UI+0x198,
 * (0x80,0xff,0xff): colour 3), then the enchantments " (+n)" green (UI+0x1a4,
 * colour 1) / " (-n)" red (UI+0x1a0, colour 2), " (+0)" green when they
 * cancel out. A Strength of 65 with a +15 buff reads "Strength 80 (+15)".
 */
export function statLineRuns1999(stat: StatLine1999, vitaeMultiplier: number): TextRun[] {
  const max = stat.kind === 'vital' ? (stat.max ?? 0) : 0;
  let text = `${stat.name} `;
  if (stat.value === 0 && max === 0) text += MUST_BE_TRAINED_1999;
  else text += max > 0 ? `${stat.value}/${max}` : `${stat.value}`;
  const runs: TextRun[] = [{ text, colorIndex: 0 }];
  const vitae = vitaeDelta1999(stat, vitaeMultiplier);
  if (vitae !== 0) runs.push({ text: ` (${vitae > 0 ? '+' : ''}${vitae})`, colorIndex: 3 });
  const ench = enchantDelta1999(stat, vitaeMultiplier);
  if (ench > 0) runs.push({ text: ` (+${ench})`, colorIndex: 1 });
  else if (ench < 0) runs.push({ text: ` (${ench})`, colorIndex: 2 });
  else if (stat.enchanted) runs.push({ text: ' (+0)', colorIndex: 1 });
  return runs;
}

export const argbToCss = (argb: number): string => `#${((argb >>> 0) & 0xffffff).toString(16).padStart(6, '0')}`;
