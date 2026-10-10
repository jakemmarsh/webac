/**
 * Fellowship XP-share percentage — the "LVL/XP%" value retail shows per
 * member row in the populated Fellowship panel (e.g. "1/55%").
 *
 * ACE's server-side cpCached/lumCached fields (GameEventFellowshipFullUpdate.cs,
 * GameEventFellowshipUpdateFellow.cs) are hardcoded to 0 server-side, so this
 * value cannot come from the wire. The decompiled retail client computes it
 * client-side instead, from data already on the wire (each fellow's level,
 * the shareXP/evenShare flags, and fellow count):
 *
 * - gmFellowshipUI::UpdateFellowStats (acclient-decompiled.c:144764)
 * - Fellowship::CalculateExperienceProportionSum (acclient-decompiled.c:426778)
 * - FellowshipSystem::GetExperienceProportion (acclient-decompiled.c:427465) —
 *   a per-fellow "weight" = ExperienceToRaiseLevel(level, level+1)
 * - FellowshipSystem::GetEvenSplitXPPctg (acclient-decompiled.c:427477) —
 *   a literal party-size lookup table
 */

/**
 * Literal switch-statement lookup table from FellowshipSystem::GetEvenSplitXPPctg
 * (acclient-decompiled.c:427477). Returns each member's flat XP-share fraction
 * (0..1) when the fellowship uses an even split. Retail hardcodes no entry
 * past 10 members (default case returns 0).
 */
const EVEN_SPLIT_XP_PCTG: Record<number, number> = {
  1: 1.0,
  2: 0.75,
  3: 0.6,
  4: 0.55,
  5: 0.5,
  6: 0.45,
  7: 0.4,
  8: 0.35,
  9: 0.311111111,
  10: 0.28,
};

export function getEvenSplitXpPctg(fellowCount: number): number {
  return EVEN_SPLIT_XP_PCTG[fellowCount] ?? 0;
}

/**
 * FellowshipSystem::GetExperienceProportion(level) — the raw XP needed to
 * advance from `level` to `level + 1` (ExperienceSystem::ExperienceToRaiseLevel),
 * used as a fellow's proportional-split weight.
 */
export function getExperienceProportion(level: number, levelXpTable: bigint[]): bigint {
  if (level < 0 || level + 1 >= levelXpTable.length) return 0n;
  const delta = levelXpTable[level + 1] - levelXpTable[level];
  return delta > 0n ? delta : 0n;
}

/**
 * Per-fellow XP-share percentage (0..100), matching gmFellowshipUI::UpdateFellowStats.
 * Only meaningful when the fellowship is sharing XP — callers should keep the
 * bare level display when `shareXP` is false.
 */
export function getFellowshipXpSharePercent(
  fellowLevel: number,
  allFellowLevels: number[],
  evenShare: boolean,
  levelXpTable: bigint[],
): number {
  return getFellowshipXpShareFraction(fellowLevel, allFellowLevels, evenShare, levelXpTable) * 100;
}

function getFellowshipXpShareFraction(
  fellowLevel: number,
  allFellowLevels: number[],
  evenShare: boolean,
  levelXpTable: bigint[],
): number {
  if (evenShare) {
    return getEvenSplitXpPctg(allFellowLevels.length);
  }
  const weight = getExperienceProportion(fellowLevel, levelXpTable);
  if (weight <= 0n) return 0;
  const sum = allFellowLevels.reduce(
    (acc, lvl) => acc + getExperienceProportion(lvl, levelXpTable),
    0n,
  );
  if (sum <= 0n) return 0;
  return Number(weight) / Number(sum);
}

/**
 * The EXPERIENCE integer gmFellowshipUI::UpdateFellowStats @ 0048eb20 formats
 * into ID_Fellowship_FellowStats ("LEVEL/EXPERIENCE%"). The share fraction
 * starts at 0 (`mov [esp+0x10], 0` @ 0048ec17) and is only computed when the
 * fellowship shares XP, so a no-share fellowship shows "N/0%". The fraction is
 * stored as a float32 (`fstp dword` @ 0048ec92), multiplied by 100.0f and
 * truncated by _ftol2 — so a six-member even split (0.45f) reads 44%, not 45%.
 */
export function getFellowshipXpShareDisplayPercent(
  fellowLevel: number,
  allFellowLevels: number[],
  shareXP: boolean,
  evenShare: boolean,
  levelXpTable: bigint[] | null,
): number {
  // A proportional split needs the XP table (not loaded until the first
  // player-state sync); the even split is a party-size lookup.
  if (!shareXP || (!evenShare && !levelXpTable)) return 0;
  const fraction = Math.fround(getFellowshipXpShareFraction(fellowLevel, allFellowLevels, evenShare, levelXpTable ?? []));
  return Math.trunc(fraction * 100);
}
