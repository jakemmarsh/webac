/**
 * BUG.fellowship-open-closed-flag-unused — the server echoes the
 * fellowship's recruiting-openness flag (ACE Fellowship.cs:410-414
 * UpdateOpenness) in every GameEventFellowshipFullUpdate, and our parser
 * captured it into fellowshipData.open (MessageSerializer.ts:3796), but
 * renderSocialPanel's fellowship tab never read it — no indicator, and the
 * DAT's third row-1 button (0x1000027d, (198,534) 79x30 — no p23 string;
 * retail capture fellowship-panel-2.jpg labels it "Close") wasn't rendered
 * at all.
 *
 * This drives the shipped pure derivation functions GameUI now uses to
 * build the indicator text and the toggle button's label from
 * fellowshipData.open (the button itself flips the openness directly:
 * FellowshipPanelActions.toggleOpenness, verify-fellowship-management.ts),
 * without executing GameUI's monolithic renderSocialPanel (which requires
 * a live LayoutRenderer + loaded portal DAT to render anything at all).
 */
import { describe, it, expect } from 'vitest';
import {
  fellowshipOpennessIndicatorText,
  fellowshipOpennessButtonLabel,
  fellowshipLockIndicatorText,
  fellowshipShareLootIndicatorText,
} from '@ac/renderer/ui/FellowshipOpenness.js';

describe('fellowshipOpennessIndicatorText', () => {
  it('reads "Open to new members" when open', () => {
    expect(fellowshipOpennessIndicatorText(true)).toBe('Open to new members');
  });
  it('reads "Closed to new members" when closed', () => {
    expect(fellowshipOpennessIndicatorText(false)).toBe('Closed to new members');
  });
});

describe('fellowshipOpennessButtonLabel (DAT 0x1000027d, no p23 — runtime-computed)', () => {
  it('shows "Close" when currently open (retail-observed label, fellowship-panel-2.jpg)', () => {
    expect(fellowshipOpennessButtonLabel(true)).toBe('Close');
  });
  it('shows "Open" when currently closed', () => {
    expect(fellowshipOpennessButtonLabel(false)).toBe('Open');
  });
});

describe('fellowshipLockIndicatorText (BUG.fellowship-islocked-flag-unrendered, ACE Fellowship.cs:417-445 UpdateLock)', () => {
  it('shows "(Locked)" when isLocked is true', () => {
    expect(fellowshipLockIndicatorText(true)).toBe('(Locked)');
  });
  it('shows nothing when isLocked is false (additive to the openness indicator, not a replacement)', () => {
    expect(fellowshipLockIndicatorText(false)).toBe('');
  });
});

describe('fellowshipShareLootIndicatorText (BUG.fellowship-shareloot-flag-unrendered, ACE Fellowship.cs:32 ShareLoot / :723 OnVitalUpdate)', () => {
  it('shows "Sharing Loot" when the fellowship-wide flag is set', () => {
    expect(fellowshipShareLootIndicatorText(true)).toBe('Sharing Loot');
  });
  it('shows "Not Sharing Loot" when unset', () => {
    expect(fellowshipShareLootIndicatorText(false)).toBe('Not Sharing Loot');
  });
});
