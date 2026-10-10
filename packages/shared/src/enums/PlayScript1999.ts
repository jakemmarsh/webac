/**
 * The 1999 (Nov 1999 retail) PScriptType ordinals vs end of retail's PlayScript.
 *
 * The 1999 enum lacks PS_SkillDownBlack (end-of-retail ordinal 30), so every
 * 1999 ordinal from 30 up is one LOWER than end of retail's: 1999 HealthUpRed
 * 30 = EoL 31, Fizzle 80 = 81, Create/Destroy 87/88 = 88/89, PortalStorm 114
 * = 115, Hide/UnHide/Hidden 115–117 = 116–118, LevelUp 137 = 138,
 * WeddingBliss 140 = 141. Below 30 they agree (Launch 4 / Explode 5 pin the
 * low end). Evidence: the 1999 portal.dat's 67 PhysicsScriptTables grouped by
 * the ordinals they carry (AC1999 kb dat/PortalDat/PhysicsScriptTable, "Ordinal
 * map"), the 1999 client's hardcoded portal-storm ordinal 0x72 (kb
 * PortalStorm/README), and the AC1999 server's GameEnums.h, which deleted
 * PS_SkillDownBlack to match.
 */

/** Ordinal of end of retail's PS_SkillDownBlack, the entry 1999 does not have. */
export const PLAYSCRIPT_EOL_ONLY_SKILLDOWNBLACK = 30;

/** A 1999 PScriptType ordinal → the end-of-retail PlayScript value. */
export function playScript1999ToEoL(ordinal: number): number {
  return ordinal >= PLAYSCRIPT_EOL_ONLY_SKILLDOWNBLACK ? ordinal + 1 : ordinal;
}

/** An end-of-retail PlayScript value → the 1999 ordinal, or null for SkillDownBlack (no 1999 entry). */
export function playScriptEoLTo1999(value: number): number | null {
  if (value === PLAYSCRIPT_EOL_ONLY_SKILLDOWNBLACK) return null;
  return value > PLAYSCRIPT_EOL_ONLY_SKILLDOWNBLACK ? value - 1 : value;
}
