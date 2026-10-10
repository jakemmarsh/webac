/**
 * GAP.88 — Use / IdentifyObject client-side target-resolution gate.
 *
 * ACE ground truth (both silent — no WeenieError text the client renders):
 *  - Player_Use.cs:210-214 (HandleActionUseItem): FindObject returning null
 *    logs server-side and falls through to a bare SendUseDoneEvent(), whose
 *    default WeenieError.None is already silent client-side (FAITHFUL.386).
 *  - Player.cs:265-272 (HandleActionIdentifyObject): FindObject returning
 *    null sends a GameEventIdentifyObjectResponse with no `wo`, i.e. no
 *    appraisal data to show.
 *
 * The gate exists to suppress the doomed round-trip for a target guid that
 * went stale between capture (a right-click context menu stays open; a
 * keybound Use/Examine fires against a possibly long-selected
 * `currentTargetGuid`) and dispatch — not to add new player-facing text,
 * since neither server path has any to mirror.
 */
import { describe, it, expect } from 'vitest';
import { canUseTarget } from '../packages/shared/src/systems/UseTargetGate.js';

describe('GAP.88 — canUseTarget mirrors Player_Use.cs:210-214 / Player.cs:265-272 silent target-resolution gate', () => {
  it('a target guid that no longer resolves to anything is never usable', () => {
    expect(canUseTarget(false)).toBe(false);
  });

  it('a target guid that still resolves passes the gate', () => {
    expect(canUseTarget(true)).toBe(true);
  });
});
