/**
 * BUG.fellowship-open-closed-flag-unused — pure derivation of the
 * recruiting-openness indicator text and the row-1 toggle button's label +
 * outbound chat command from fellowshipData.open. Extracted so this logic
 * is unit-testable without executing GameUI's monolithic
 * renderSocialPanel().
 *
 * The server echoes the current openness in every GameEventFellowshipFullUpdate
 * (ACE Fellowship.cs:410-414 UpdateOpenness) but our renderer parsed it into
 * fellowshipData.open with zero UI consumers. DAT element 0x1000027d — the
 * third button in the fellowship panel's row-1 (0x21000030, (198,534)
 * 79x30) — carries no p23 string in the layout; the retail capture
 * (fellowship-panel-2.jpg, see verification/panel-specs/social-fellowship.md)
 * shows it labeled "Close", meaning the label is runtime-computed from the
 * CURRENT state, not a fixed DAT string. This is the leader-only recruiting
 * toggle (ACE Player_Fellowship.cs:33 HandleActionFellowshipChangeOpenness —
 * WeenieError.YouMustBeLeaderOfFellowship for non-leaders), wired through
 * the existing `/fellow open`/`/fellow close` chat commands.
 */
export function fellowshipOpennessIndicatorText(open: boolean): string {
  return open ? 'Open to new members' : 'Closed to new members';
}

export function fellowshipOpennessButtonLabel(open: boolean): string {
  return open ? 'Close' : 'Open';
}

/**
 * BUG.fellowship-islocked-flag-unrendered — pure derivation of the
 * lock-state suffix appended to the openness indicator.
 *
 * ACE's Fellowship.UpdateLock (reference/ACE/Source/ACE.Server/Entity/
 * Fellowship.cs:417-445, only reachable via emotemanager — "Unlocking a
 * fellowship is not possible without disbanding in retail worlds") always
 * forces Open = false when isLocked is set, so a locked fellowship is
 * always also closed. This is additive to fellowshipOpennessIndicatorText
 * rather than a replacement: locked communicates something Closed alone
 * doesn't (recruiting is blocked, not just currently toggled off).
 */
export function fellowshipLockIndicatorText(isLocked: boolean): string {
  return isLocked ? '(Locked)' : '';
}

/**
 * BUG.fellowship-shareloot-flag-unrendered — pure derivation of the
 * loot-sharing indicator text.
 *
 * Fellowship.ShareLoot (reference/ACE/Source/ACE.Server/Entity/
 * Fellowship.cs:32) is a single fellowship-wide setting, fixed from the
 * leader's ShareFellowshipLoot character option at creation time — not a
 * per-member toggle, despite each wire record carrying its own copy of it
 * (GameEventFellowshipFullUpdate.cs WriteFellow / GameEventFellowshipUpdateFellow.cs).
 * ACE re-broadcasts it on every fellow vitals tick (Fellowship.cs:723
 * OnVitalUpdate), so it's live leader-configured state with no prior UI
 * consumer, mirroring the already-fixed BUG.fellowship-open-closed-flag-unused
 * / BUG.fellowship-islocked-flag-unrendered pattern.
 */
export function fellowshipShareLootIndicatorText(shareLoot: boolean): string {
  return shareLoot ? 'Sharing Loot' : 'Not Sharing Loot';
}
