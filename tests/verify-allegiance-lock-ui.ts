/**
 * BUG.allegiance-islocked-flag-unrendered — MessageSerializer.ts parses
 * AllegianceData.isLocked from GameEventAllegianceUpdate (ACE
 * AllegianceHierarchy.cs Write():33-39,63) into allegianceInfo.isLocked,
 * but renderSocialPanel's allegiance branch never read it — no UI
 * consumer for the monarch-toggleable /allegiance lock state
 * (Player_Allegiance.cs:1010-1025 HandleActionDoAllegianceLockAction),
 * which per Player_Allegiance.cs:375 gates whether new vassals can swear
 * in without prior approval.
 *
 * This drives the shipped pure derivation function GameUI now uses to
 * build the indicator text, without executing GameUI's monolithic
 * renderSocialPanel (which requires a live LayoutRenderer + loaded portal
 * DAT to render anything at all) — same approach as
 * verify-fellowship-openness-ui.ts for the sibling fellowship fix.
 */
import { describe, it, expect } from 'vitest';
import { allegianceLockIndicatorText } from '@ac/renderer/ui/AllegianceLock.js';

describe('allegianceLockIndicatorText (BUG.allegiance-islocked-flag-unrendered, ACE Player_Allegiance.cs:1010-1025 DoAllegianceLockAction)', () => {
  it('shows "(Locked)" when isLocked is true', () => {
    expect(allegianceLockIndicatorText(true)).toBe('(Locked)');
  });
  it('shows nothing when isLocked is false', () => {
    expect(allegianceLockIndicatorText(false)).toBe('');
  });
});
