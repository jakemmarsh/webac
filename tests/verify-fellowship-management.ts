/**
 * Fellowship management — the fellowship panel's buttons, as retail
 * gmFellowshipUI::ListenToElementMessage @ 004901c0 runs them
 * (ui/FellowshipPanelActions.ts). Retail had no fellowship chat command
 * (FAITHFUL.275's invented `/fellow leader|dismiss|…` is gone with the
 * retail command port); each button calls a panel function directly:
 *  - Leader  → AssignLeadershipToFellow(selected) @ 0048f1e0
 *  - Quit    → a leader first hands leadership to the first non-leader
 *              fellow, then Event_Quit(0)
 *  - Open    → flip the openness (Event_ChangeFellowOpeness)
 *  - Recruit → RecruitFellow(world selection) @ 0048e530
 *  - Dismiss → DismissFellow(selected) @ 0048e470
 *  - Disband → Event_Quit(1)
 * Refusals are 0x1a string-table tokens (or AssignLeadershipToFellow's
 * literal). No step is a local "Promoting…" / "Dismissing…" / "Fellowship
 * is now open." echo (FAITHFUL.506/507): the server's own events are the
 * visible result.
 */
import { describe, it, expect } from 'vitest';
import {
  assignLeadership, quitFellowship, toggleOpenness, recruitFellow, dismissFellow, disbandFellowship,
  type FellowshipView,
} from '../packages/renderer/src/ui/FellowshipPanelActions.js';

const SELF = 0x50000001;
const OTHER = 0x50000002;
const THIRD = 0x50000003;
const STRANGER = 0x50000009;

function fellowship(leader: number, open = false, members = [SELF, OTHER]): FellowshipView {
  return { leaderGuid: leader, open, fellows: members.map((guid) => ({ guid })) };
}

describe('Leader (AssignLeadershipToFellow @ 0048f1e0)', () => {
  it('hands leadership to a fellow', () => {
    expect(assignLeadership(fellowship(SELF), SELF, OTHER)).toEqual([{ kind: 'assignLeader', guid: OTHER }]);
  });
  it('a non-fellow is refused with retail\'s literal; self with the SelfAlreadyLeader token', () => {
    expect(assignLeadership(fellowship(SELF), SELF, STRANGER)).toEqual([{ kind: 'refuse', text: 'That person is not in the fellowship.' }]);
    expect(assignLeadership(fellowship(SELF), SELF, SELF)).toEqual([{ kind: 'refuse', token: 'ID_Fellowship_Error_SelfAlreadyLeader' }]);
  });
  it('no fellowship: nothing', () => {
    expect(assignLeadership(null, SELF, OTHER)).toEqual([]);
  });
});

describe('Quit', () => {
  it('a leader hands leadership to the first non-leader fellow, then quits (Event_Quit(0))', () => {
    expect(quitFellowship(fellowship(SELF, false, [SELF, OTHER, THIRD]), SELF)).toEqual([
      { kind: 'assignLeader', guid: OTHER },
      { kind: 'quit', disband: false },
    ]);
  });
  it('a member, or a leader alone, just quits', () => {
    expect(quitFellowship(fellowship(OTHER), SELF)).toEqual([{ kind: 'quit', disband: false }]);
    expect(quitFellowship(fellowship(SELF, false, [SELF]), SELF)).toEqual([{ kind: 'quit', disband: false }]);
    expect(quitFellowship(null, SELF)).toEqual([{ kind: 'quit', disband: false }]);
  });
});

describe('Open / Disband', () => {
  it('Open flips the current openness', () => {
    expect(toggleOpenness(fellowship(SELF, false))).toEqual([{ kind: 'setOpen', open: true }]);
    expect(toggleOpenness(fellowship(SELF, true))).toEqual([{ kind: 'setOpen', open: false }]);
    expect(toggleOpenness(null)).toEqual([]);
  });
  it('Disband is Event_Quit(1)', () => {
    expect(disbandFellowship()).toEqual([{ kind: 'quit', disband: true }]);
  });
});

describe('Recruit (RecruitFellow @ 0048e530)', () => {
  it('recruits a known player who is not yet a fellow', () => {
    expect(recruitFellow(fellowship(SELF), SELF, STRANGER, true)).toEqual([{ kind: 'recruit', guid: STRANGER }]);
  });
  it('self / an existing fellow get their string-table refusals', () => {
    expect(recruitFellow(fellowship(SELF), SELF, SELF, true)).toEqual([{ kind: 'refuse', token: 'ID_Fellowship_Error_CantRecruitSelf' }]);
    expect(recruitFellow(fellowship(SELF), SELF, OTHER, true)).toEqual([{ kind: 'refuse', token: 'ID_Fellowship_Error_PlayerAlreadyInFellowship' }]);
  });
  it('a non-player selection, an unknown object or no fellowship does nothing', () => {
    expect(recruitFellow(fellowship(SELF), SELF, STRANGER, false)).toEqual([]);
    expect(recruitFellow(fellowship(SELF), SELF, STRANGER, null)).toEqual([]);
    expect(recruitFellow(null, SELF, STRANGER, true)).toEqual([]);
  });
});

describe('Dismiss (DismissFellow @ 0048e470)', () => {
  it('dismisses a fellow', () => {
    expect(dismissFellow(fellowship(SELF), SELF, OTHER)).toEqual([{ kind: 'dismiss', guid: OTHER }]);
  });
  it('a non-fellow and self are refused with their tokens', () => {
    expect(dismissFellow(fellowship(SELF), SELF, STRANGER)).toEqual([{ kind: 'refuse', token: 'ID_Fellowship_Error_DismisseeNotInFellowship' }]);
    expect(dismissFellow(fellowship(SELF), SELF, SELF)).toEqual([{ kind: 'refuse', token: 'ID_Fellowship_Error_CantDismissSelf' }]);
    expect(dismissFellow(null, SELF, OTHER)).toEqual([]);
  });
});
