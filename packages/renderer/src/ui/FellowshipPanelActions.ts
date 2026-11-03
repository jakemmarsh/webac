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
 *
 * BUG.ac1999-fellowship-refusal-wording — the 1999 client.exe words them its own way and runs
 * Recruit / Dismiss as a click-a-character target mode (FellowshipText, eraClientRules().
 * fellowshipText): FellowPanel_RecruitObject @ 0x00535670 / FellowPanel_DismissObject @ 0x00535570
 * print "<name> is already in your Fellowship" / "<name> isn't in your Fellowship" (no full stop)
 * and "You can't recruit yourself." / "You can't dismiss yourself." on the status line (UI vtable
 * +0x114, our spew); FellowPanel_ListenToMessage @ 0x00535770 arms SetTargetMode(7 / 8) with
 * "Click a character to recruit." (only when the selection is not a known player) / "Click a
 * character to dismiss." (always), and the next click on a character (PanelUI_HandleMouseDownOnObject
 * @ 0x004f83c0 → 0x004f85a0 / 0x004f8580, or a fellow's row for dismiss, 0x00533e50) runs the check.
 * 1999 has no leader hand-off, openness or disband (their buttons are hidden in that era).
 */

export interface FellowshipView {
  leaderGuid: number;
  open: boolean;
  fellows: ReadonlyArray<{ guid: number; name?: string }>;
}

/** One refusal as an era words it: a string-table token (end of retail) or a literal ("%s" = the name). */
export type FellowshipRefusal = { readonly token: string } | { readonly text: string };

/** The fellowship panel's refusals and target-mode prompts of one era's client. */
export interface FellowshipText {
  readonly cantRecruitSelf: FellowshipRefusal;
  readonly alreadyInFellowship: FellowshipRefusal;
  readonly notInFellowship: FellowshipRefusal;
  readonly cantDismissSelf: FellowshipRefusal;
  /**
   * The 1999 click-a-character target mode: Recruit with no known player selected, and every
   * Dismiss press, arm it with these prompts. null: end of retail's buttons act on the world
   * selection (Recruit) and the selected fellow (Dismiss) at once.
   */
  readonly targetMode: { readonly recruit: string; readonly dismiss: string } | null;
}

/** End of retail (and Dark Majesty, the same exe): RecruitFellow @ 0048e530 / DismissFellow @ 0048e470's tokens. */
export const EOR_FELLOWSHIP_TEXT: FellowshipText = Object.freeze({
  cantRecruitSelf: Object.freeze({ token: 'ID_Fellowship_Error_CantRecruitSelf' }),
  alreadyInFellowship: Object.freeze({ token: 'ID_Fellowship_Error_PlayerAlreadyInFellowship' }),
  notInFellowship: Object.freeze({ token: 'ID_Fellowship_Error_DismisseeNotInFellowship' }),
  cantDismissSelf: Object.freeze({ token: 'ID_Fellowship_Error_CantDismissSelf' }),
  targetMode: null,
});

/**
 * The 1999 client.exe's literals (features-1999.json: FellowPanel_RecruitObject @ 0x00535670,
 * FellowPanel_DismissObject @ 0x00535570, FellowPanel_ListenToMessage @ 0x00535770). The name is
 * GetObjectName_ById's, prefixed; capital F, no full stop on the two name lines.
 */
export const AC1999_FELLOWSHIP_TEXT: FellowshipText = Object.freeze({
  cantRecruitSelf: Object.freeze({ text: "You can't recruit yourself." }),
  alreadyInFellowship: Object.freeze({ text: '%s is already in your Fellowship' }),
  notInFellowship: Object.freeze({ text: "%s isn't in your Fellowship" }),
  cantDismissSelf: Object.freeze({ text: "You can't dismiss yourself." }),
  targetMode: Object.freeze({ recruit: 'Click a character to recruit.', dismiss: 'Click a character to dismiss.' }),
});

/** The 1999 lines with a name slot and the prompts (the refusal telemetry keys them by template). */
export const AC1999_FELLOWSHIP_NAME_TEMPLATES: readonly string[] = Object.freeze([
  '%s is already in your Fellowship',
  "%s isn't in your Fellowship",
]);

/** How a refusal names its object: the fellow's roster name, else the caller's lookup (the world object). */
export interface FellowshipNames {
  nameOf?: (guid: number) => string | undefined;
}

export type FellowshipStep =
  | { kind: 'assignLeader'; guid: number }
  | { kind: 'quit'; disband: boolean }
  | { kind: 'setOpen'; open: boolean }
  | { kind: 'recruit'; guid: number }
  | { kind: 'dismiss'; guid: number }
  /** A 0x1a line: a string-table token, or retail's literal text. */
  | { kind: 'refuse'; token?: string; text?: string }
  /** 1999: arm the click-a-character target mode and print its prompt (a status line, not a refusal). */
  | { kind: 'targetMode'; mode: 'recruit' | 'dismiss'; text: string };

const isFellow = (f: FellowshipView, guid: number): boolean => f.fellows.some((m) => m.guid === guid);

function refuse(r: FellowshipRefusal, f: FellowshipView, guid: number, names: FellowshipNames): FellowshipStep {
  if ('token' in r) return { kind: 'refuse', token: r.token };
  if (!r.text.includes('%s')) return { kind: 'refuse', text: r.text };
  const name = f.fellows.find((m) => m.guid === guid)?.name ?? names.nameOf?.(guid) ?? '';
  return { kind: 'refuse', text: r.text.replace('%s', name) };
}

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
 * the self / already-a-fellow refusal. The 1999 FellowPanel_RecruitObject
 * @ 0x00535670 runs the same checks in the same order with its own words.
 */
export function recruitFellow(
  f: FellowshipView | null, selfGuid: number, guid: number, isPlayer: boolean | null,
  text: FellowshipText = EOR_FELLOWSHIP_TEXT, names: FellowshipNames = {},
): FellowshipStep[] {
  if (!f || !isPlayer) return [];
  if (!isFellow(f, guid)) return [{ kind: 'recruit', guid }];
  return [refuse(guid === selfGuid ? text.cantRecruitSelf : text.alreadyInFellowship, f, guid, names)];
}

/**
 * The Recruit button. End of retail: RecruitFellow on the selection. 1999 (FellowPanel_ListenToMessage
 * @ 0x00535770): RecruitObject on the selection, and when that did nothing (no object, not a player)
 * SetTargetMode(7) with "Click a character to recruit.".
 */
export function recruitPress(
  f: FellowshipView | null, selfGuid: number, guid: number, isPlayer: boolean | null,
  text: FellowshipText = EOR_FELLOWSHIP_TEXT, names: FellowshipNames = {},
): FellowshipStep[] {
  const steps = recruitFellow(f, selfGuid, guid, isPlayer, text, names);
  if (steps.length || !f || !text.targetMode) return steps;
  return [{ kind: 'targetMode', mode: 'recruit', text: text.targetMode.recruit }];
}

/**
 * DismissFellow @ 0048e470. The 1999 FellowPanel_DismissObject @ 0x00535570 (the click on a
 * character in dismiss mode) first drops an unknown object or a non-player silently (`isPlayer`,
 * vtable +0x10), then the same not-a-fellow / self checks in its own words.
 */
export function dismissFellow(
  f: FellowshipView | null, selfGuid: number, guid: number,
  text: FellowshipText = EOR_FELLOWSHIP_TEXT, names: FellowshipNames = {}, isPlayer: boolean | null = true,
): FellowshipStep[] {
  if (!f || !isPlayer) return [];
  if (!isFellow(f, guid)) return [refuse(text.notInFellowship, f, guid, names)];
  if (guid === selfGuid) return [refuse(text.cantDismissSelf, f, guid, names)];
  return [{ kind: 'dismiss', guid }];
}

/**
 * The Dismiss button. End of retail: DismissFellow(m_iidSelectedFellow). 1999: SetTargetMode(8)
 * with "Click a character to dismiss." whatever is selected; the click picks the fellow.
 */
export function dismissPress(
  f: FellowshipView | null, selfGuid: number, selectedFellow: number | null,
  text: FellowshipText = EOR_FELLOWSHIP_TEXT, names: FellowshipNames = {},
): FellowshipStep[] {
  if (!f) return [];
  if (text.targetMode) return [{ kind: 'targetMode', mode: 'dismiss', text: text.targetMode.dismiss }];
  return selectedFellow === null ? [] : dismissFellow(f, selfGuid, selectedFellow, text, names);
}

/** The Disband button: Event_Quit(1). */
export function disbandFellowship(): FellowshipStep[] {
  return [{ kind: 'quit', disband: true }];
}
