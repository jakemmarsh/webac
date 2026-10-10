/**
 * PlayerKillerStatus — bitfield carried on PropertyInt.PlayerKillerStatus (134).
 *
 * Source: reference/ACE/Source/ACE.Entity/Enum/PlayerKillerStatus.cs
 *
 *   Undef       = 0x00
 *   Protected   = 0x01   — NPCs
 *   NPK         = 0x02   — non-player-killer
 *   PK          = 0x04   — player-killer (red)
 *   Unprotected = 0x08   — creatures + traps
 *   RubberGlue  = 0x10   — vendors
 *   Free        = 0x20   — Baelzharon-class
 *   PKLite      = 0x40   — player-killer lite (orange)
 *
 * Local-player display in classic AC client maps to four labels:
 *   PK         → "Player Killer"
 *   PKLite     → "Player Killer Lite"
 *   any other  → "Non-Player Killer"
 */
export enum PlayerKillerStatus {
  Undef       = 0x00,
  Protected   = 0x01,
  NPK         = 0x02,
  PK          = 0x04,
  Unprotected = 0x08,
  RubberGlue  = 0x10,
  Free        = 0x20,
  PKLite      = 0x40,
}

/**
 * The label the classic AC client shows on the character panel for the
 * local player's PK status. Anchored to the three-label convention from
 * fan documentation (PK / PKLite are the only states a non-NPC player
 * actually inhabits in retail; everything else collapses to NPK).
 */
export function playerKillerStatusLabel(value: number): string {
  if (value & PlayerKillerStatus.PK)     return 'Player Killer';
  if (value & PlayerKillerStatus.PKLite) return 'Player Killer Lite';
  return 'Non-Player Killer';
}

/**
 * PK-status label for the EXAMINE / assess panel, or null when no row
 * should be shown. PlayerKillerStatus is a [SendOnLogin][AssessmentProperty]
 * (ACE PropertyInt.cs:195 — property 134), so a player's PK state is carried
 * in the identify/appraisal response the retail client renders on examine.
 *
 * Only the two player-warning states (PK → red, PKLite → pink, per
 * RadarColor.cs: PlayerKiller=Red, PKLite=Pink) surface a row — NPK and the
 * non-player states (Protected/Unprotected/RubberGlue/Free that monsters,
 * NPCs, vendors carry) collapse to null so an examined monster never gets a
 * spurious "Non-Player Killer" line. This matches the self character-panel
 * indicator gate (PK|PKLite bits).
 */
export function playerKillerAssessLabel(value: number): string | null {
  if (value & PlayerKillerStatus.PK)     return 'Player Killer';
  if (value & PlayerKillerStatus.PKLite) return 'Player Killer Lite';
  return null;
}
