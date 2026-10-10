/**
 * VitaePanelText — builds the text body of the retail "Vitae" panel
 * (gmVitaeUI, element class 0x10000020, LayoutDesc 0x21000020: a 300x362
 * window whose body is the single text element 0x100001c3).
 *
 * Faithful port of the decompiled retail client (reference/client-eol,
 * build ac1_sep13), gmVitaeUI::Update @ 004a7400:
 *
 *   - vitae at full strength (no penalty)  → ID_Vitae_Text_Full
 *   - otherwise, three StringInfos appended in order:
 *       ID_Vitae_Text_Vitae      (%Percentage% penalty)
 *       ID_Vitae_Text_Skills     (%Percentage% penalty)
 *       ID_Vitae_Text_Experience (%Experience% = XP remaining to next 1%)
 *     where XP remaining = VitaeSystem::VitaeCPPoolThreshold(vitae, level)
 *     − PropertyInt 0x81 (VitaeCpPool, 129), and level is PropertyInt
 *     0x8b (DeathLevel, 139) falling back to 0x19 (Level, 25) when unset.
 *
 * The string IDs live in StringTable 0x23000001 of client_local_English.dat
 * as fragment lists with the variable slot between fragments; the literals
 * below are the verbatim DAT fragments, used as fallbacks when the string
 * tables aren't loaded (the DAT wins whenever it is available).
 */

import { getStringParts } from '@ac/dat-parser/file-types/LayoutDesc.js';
import { vitaeCpPoolThreshold } from '@ac/shared';

/** StringTable 0x23000001 entry ids (resolved from client_local_English.dat). */
export const VITAE_STRING_IDS = {
  /** "Vitae" — window title (layout 0x21000020 title element p23). */
  title: 5801986,
  /** ID_Vitae_Text_Full */
  full: 21159404,
  /** ID_Vitae_Text_Vitae — 2 fragments around %Percentage% */
  vitae: 73234021,
  /** ID_Vitae_Text_Skills — 2 fragments around %Percentage% */
  skills: 94782579,
  /** ID_Vitae_Text_Experience — 2 fragments around %Experience% */
  experience: 231574581,
} as const;

/** Verbatim DAT fragments — fallback when string tables aren't loaded. */
const FALLBACK_PARTS: Record<number, string[]> = {
  [VITAE_STRING_IDS.full]: ['Your Vitae, or life force, is at full strength.'],
  [VITAE_STRING_IDS.vitae]: [
    'Due to your recent death, you have temporarily lost ',
    '% of your Vitae, or life force.',
  ],
  [VITAE_STRING_IDS.skills]: [
    '\n\nThis means that your health, stamina, mana, and skills are temporarily reduced by ',
    '%.  A reduction of less than 15% will not hinder you much, but beware losing much more than that.',
  ],
  [VITAE_STRING_IDS.experience]: [
    '\n\nYou will regain 1% of your Vitae once you earn ',
    ' more experience.',
  ],
};

export interface VitaePanelSource {
  /** Current vitae penalty fraction (0 = none … 0.40 = max). */
  vitaePenalty: number;
  /** PropertyInt.VitaeCpPool (129) — XP paid toward the next 1% decay. */
  vitaeCpPool: number;
  /** PropertyInt.DeathLevel (139) — level at last death; 0/undefined = unset. */
  deathLevel: number;
  /** PropertyInt.Level (25) — fallback when DeathLevel is unset. */
  level: number;
}

/** Retail shows the penalty as an integer percentage. */
export function vitaePenaltyPercent(vitaePenalty: number): number {
  return Math.round(vitaePenalty * 100);
}

/**
 * XP still needed to decay vitae by the next 1% step:
 * trunc(VitaeCPPoolThreshold(multiplier, deathLevel||level)) − vitaeCpPool.
 * The client's VitaeCPPoolThreshold returns a truncated ulong; ACE casts
 * `(int)` the same way (Player_Xp.cs:148).
 */
export function vitaeXpRemaining(s: VitaePanelSource): number {
  const level = s.deathLevel > 0 ? s.deathLevel : s.level;
  const multiplier = 1 - s.vitaePenalty;
  const threshold = Math.trunc(vitaeCpPoolThreshold(multiplier, level));
  return Math.max(0, threshold - s.vitaeCpPool);
}

/** A resolved string as [before-variable, after-variable] fragments. */
function parts(id: number): string[] {
  return getStringParts(id) ?? FALLBACK_PARTS[id];
}

/** Join a fragment list with a rendered variable in the slot between fragments. */
function fill(fragments: string[], variable: string): string {
  if (fragments.length <= 1) return fragments.join('');
  return fragments.join(variable);
}

/**
 * Build the panel body text exactly as gmVitaeUI::Update assembles it.
 * Numbers use comma grouping (retail PStringBase::InsertCommas semantics).
 */
export function buildVitaePanelText(s: VitaePanelSource): string {
  const pct = vitaePenaltyPercent(s.vitaePenalty);
  if (pct <= 0) return fill(parts(VITAE_STRING_IDS.full), '');
  const xp = vitaeXpRemaining(s);
  return (
    fill(parts(VITAE_STRING_IDS.vitae), String(pct)) +
    fill(parts(VITAE_STRING_IDS.skills), String(pct)) +
    fill(parts(VITAE_STRING_IDS.experience), xp.toLocaleString('en-US'))
  );
}
