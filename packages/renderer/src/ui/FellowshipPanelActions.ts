/**
 * The fellowship panel's buttons, as gmFellowshipUI::ListenToElementMessage
 * @ 004901c0 runs them (decomp :145966). Each button calls a panel function
 * directly — no chat command is involved:
 *  - Leader  → AssignLeadershipToFellow(m_iidSelectedFellow) @ 0048f1e0
 *  - Quit    → (a leader with another fellow first hands leadership to
 *              Fellowship::GetNonLeaderFellowID) then Event_Quit(0)
 *  - Open    → flip the fellowship's openness, Event_ChangeFellowOpeness
 *  - Recruit → RecruitFellow(ACCWeenieObject::selectedID) @ 0048e530
 *  - Dismiss → DismissFellow(m_iidSelectedFellow) @ 0048e470
 *  - Disband → Event_Quit(1)
 * Refusals are SendNotice_DisplayStringInfo(0x1a) with a string-table token
 * (StringInfo::SetStringIDandTableEnum(compute_str_hash(token), 0x10000001))
 * or, for AssignLeadershipToFellow's not-a-fellow case, a literal.
 */

export interface FellowshipView {
  leaderGuid: number;
  open: boolean;
  fellows: ReadonlyArray<{ guid: number }>;
}

export type FellowshipStep =
  | { kind: 'assignLeader'; guid: number }
  | { kind: 'quit'; disband: boolean }
  | { kind: 'setOpen'; open: boolean }
  | { kind: 'recruit'; guid: number }
  | { kind: 'dismiss'; guid: number }
  /** A 0x1a line: a string-table token, or retail's literal text. */
  | { kind: 'refuse'; token?: string; text?: string };

const isFellow = (f: FellowshipView, guid: number): boolean => f.fellows.some((m) => m.guid === guid);

/** AssignLeadershipToFellow @ 0048f1e0. */
export function assignLeadership(f: FellowshipView | null, selfGuid: number, guid: number): FellowshipStep[] {
  if (!f) return [];
  if (!isFellow(f, guid)) return [{ kind: 'refuse', text: 'That person is not in the fellowship.' }];
  if (guid === selfGuid) return [{ kind: 'refuse', token: 'ID_Fellowship_Error_SelfAlreadyLeader' }];
  return [{ kind: 'assignLeader', guid }];
}

/** The Quit button: a leader hands leadership to the first non-leader fellow before Event_Quit(0). */
export function quitFellowship(f: FellowshipView | null, selfGuid: number): FellowshipStep[] {
  const steps: FellowshipStep[] = [];
  if (f && f.leaderGuid === selfGuid) {
    const other = f.fellows.find((m) => m.guid !== f.leaderGuid)?.guid ?? 0;
    if (other !== 0) steps.push(...assignLeadership(f, selfGuid, other));
  }
  steps.push({ kind: 'quit', disband: false });
  return steps;
}

/** The Open button: flip the fellowship's openness. */
export function toggleOpenness(f: FellowshipView | null): FellowshipStep[] {
  return f ? [{ kind: 'setOpen', open: !f.open }] : [];
}

/**
 * RecruitFellow @ 0048e530 on the world selection: only a known player
 * (vtable +0x10 IsPlayer) is considered; a non-fellow is recruited, else
 * the self / already-a-fellow refusal.
 */
export function recruitFellow(f: FellowshipView | null, selfGuid: number, guid: number, isPlayer: boolean | null): FellowshipStep[] {
  if (!f || !isPlayer) return [];
  if (!isFellow(f, guid)) return [{ kind: 'recruit', guid }];
  return [{ kind: 'refuse', token: guid === selfGuid ? 'ID_Fellowship_Error_CantRecruitSelf' : 'ID_Fellowship_Error_PlayerAlreadyInFellowship' }];
}

/** DismissFellow @ 0048e470. */
export function dismissFellow(f: FellowshipView | null, selfGuid: number, guid: number): FellowshipStep[] {
  if (!f) return [];
  if (!isFellow(f, guid)) return [{ kind: 'refuse', token: 'ID_Fellowship_Error_DismisseeNotInFellowship' }];
  if (guid === selfGuid) return [{ kind: 'refuse', token: 'ID_Fellowship_Error_CantDismissSelf' }];
  return [{ kind: 'dismiss', guid }];
}

/** The Disband button: Event_Quit(1). */
export function disbandFellowship(): FellowshipStep[] {
  return [{ kind: 'quit', disband: true }];
}
