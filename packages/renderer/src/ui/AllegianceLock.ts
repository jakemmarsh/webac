/**
 * BUG.allegiance-islocked-flag-unrendered — pure derivation of the
 * allegiance lock indicator text, mirroring fellowshipLockIndicatorText
 * (./FellowshipOpenness.ts).
 *
 * MessageSerializer.ts parses AllegianceData.isLocked from
 * GameEventAllegianceUpdate (ACE AllegianceHierarchy.cs Write():33-39,63)
 * and GameUI stores it on allegianceInfo, but nothing rendered it. Per
 * ACE Player_Allegiance.cs:375, a locked allegiance rejects new vassals
 * (targetNode.Allegiance.IsLocked && !HasApprovedVassal(...)) unless the
 * swearer is a pre-approved vassal or an officer of Castellan rank or
 * higher — the monarch-toggleable /allegiance lock state
 * (Player_Allegiance.cs:1010-1025, DoAllegianceLockAction) that this
 * indicator surfaces.
 */
export function allegianceLockIndicatorText(isLocked: boolean): string {
  return isLocked ? '(Locked)' : '';
}
