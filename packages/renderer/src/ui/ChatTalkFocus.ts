/**
 * ChatTalkFocus — where the main chat window's plain typed text goes, and
 * the "Chat" button's menu that picks it (gmMainChatUI, layout 0x2100006f
 * button 0x10000014 / label 0x10000015, popup layout 0x21000006).
 *
 * Ground truth (decompiled EoL client, build ac1_sep13):
 *  - gmCCommunicationSystem ctor @ 005893c0: talk focus 1 (Say), allowed
 *    bitmask 2 (only Say). SetTalkFocusEnabled @ 00589080 sets / clears
 *    bit 1 << id; RecvNotice_EnableChatTargetSelection @ 004ce270 greys the
 *    item (state 0xd) and, for the current focus, falls back to Say.
 *  - InitTalkFocusMenu @ 004cdc50 appends the items in MENU_ITEMS order into
 *    a two-column listbox (0x1000001d, p95 = 2): the Squelch toggle first,
 *    then each focus. HandleSelection @ 004cd540 ignores a disabled item,
 *    calls SetTalkFocus (7 also SetWantsToBeInAllegChat(1)), relabels the
 *    button from ID_Chat_ChatTargetMenu* and presses the chosen item
 *    (0x10000001).
 *  - SetSelected @ 004cd730 (from RecvNotice_SelectionChanged @ 004ce050
 *    for a talkable creature that is not the player, and UseTime's 1 s
 *    range check): a name → "Tell to %s" / "Squelch (ignore) %s" enabled,
 *    focus 2 allowed; no name → "Tell to Selected" / "Squelch (ignore) "
 *    greyed, focus 2 disallowed (falling back to Say). The squelch item is
 *    pressed while that person is squelched.
 *  - ClientCommunicationSystem::OnChatCommand @ 00581320: a line with no
 *    leading / @ : ; from the main chat (command source 1 / 8) goes by
 *    focus — 1 Talk, 2 TalkDirect(lastSpeakable; nothing when 0), 3 / 4 / 5 /
 *    6 ChannelBroadcast Fellow 0x800 / Patron 0x2000 / Monarch 0x4000 /
 *    Vassals 0x1000, 7–12 TurbineChat in the tracker's allegiance / general /
 *    trade / LFG / roleplay / society room, 13 the Olthoi room.
 */

/** The talk focuses (SetTalkFocus ids). */
export const TalkFocus = {
  Say: 1, Selected: 2, Fellows: 3, Patron: 4, Monarch: 5, Vassals: 6, Allegiance: 7,
  General: 8, Trade: 9, Lfg: 10, Roleplay: 11, Society: 12, Olthoi: 13,
} as const;
export type TalkFocusId = (typeof TalkFocus)[keyof typeof TalkFocus];

/** One menu row: its 0x23000001 string id (and initial text), and its focus (null = the Squelch toggle). */
export interface TalkFocusMenuItem { stringId: number; text: string; focus: TalkFocusId | null }

/** InitTalkFocusMenu's insertion order. */
export const MENU_ITEMS: readonly TalkFocusMenuItem[] = [
  { stringId: 20261950, text: 'Squelch (ignore) Selected', focus: null },
  { stringId: 192505976, text: 'Tell to Monarch', focus: TalkFocus.Monarch },
  { stringId: 160873886, text: 'Tell to Selected', focus: TalkFocus.Selected },
  { stringId: 184248158, text: 'Tell to Patron', focus: TalkFocus.Patron },
  { stringId: 232840988, text: 'Chat to All', focus: TalkFocus.Say },
  { stringId: 95910035, text: 'Tell to Vassals', focus: TalkFocus.Vassals },
  { stringId: 94426675, text: 'Tell to Fellows', focus: TalkFocus.Fellows },
  { stringId: 97687141, text: 'Tell to Allegiance', focus: TalkFocus.Allegiance },
  { stringId: 77146284, text: 'Tell to General Chat', focus: TalkFocus.General },
  { stringId: 10664517, text: 'Tell to Trade Chat', focus: TalkFocus.Trade },
  { stringId: 232843671, text: 'Tell to LFG Chat', focus: TalkFocus.Lfg },
  { stringId: 133331113, text: 'Tell to Roleplay Chat', focus: TalkFocus.Roleplay },
  { stringId: 23338009, text: 'Tell to Society Chat', focus: TalkFocus.Society },
  { stringId: 248541529, text: 'Tell to Olthoi Chat', focus: TalkFocus.Olthoi },
];

/** "Tell to " + value / "Squelch (ignore) " + value (ID_Chat_TellToSelected / ID_Chat_SquelchSelected). */
export const TELL_TO_SELECTED_STRING = 167092404;
export const SQUELCH_SELECTED_STRING = 262987316;

/** The button label per focus (ID_Chat_ChatTargetMenu*), with its string id. */
export const BUTTON_LABELS: Readonly<Record<TalkFocusId, { stringId: number; text: string }>> = {
  1: { stringId: 179227509, text: 'Chat' },
  2: { stringId: 115399300, text: 'Tell' },
  3: { stringId: 107979219, text: 'Fell' },
  4: { stringId: 13005870, text: 'Pat' },
  5: { stringId: 180895704, text: 'Mon' },
  6: { stringId: 107356467, text: 'Vas' },
  7: { stringId: 11315573, text: 'Alg' },
  8: { stringId: 124288844, text: 'Gen' },
  9: { stringId: 117533461, text: 'Trade' },
  10: { stringId: 213338695, text: 'LFG' },
  11: { stringId: 216474297, text: 'RP' },
  12: { stringId: 78990265, text: 'Soc' },
  13: { stringId: 84764201, text: 'Olt' },
};

/** UIElement states of a menu row. */
export const ITEM_STATE = { normal: 1, disabled: 0xd, pressed: 0x10000001 } as const;

/** gmCCommunicationSystem's talk focus + gmMainChatUI's menu state. */
export class ChatTalkFocusModel {
  focus: TalkFocusId = TalkFocus.Say;
  /** m_uiAllowedTalkFocusBitmask — Say only at first. */
  allowedMask = 1 << TalkFocus.Say;
  /** SetLastSpeakableTarget — the Tell / Squelch target (0 = none). */
  lastSpeakable = 0;
  lastSpeakableName = '';
  /** The squelch item is pressed while the target is squelched. */
  targetSquelched = false;
  /** SetWantsToBeInAllegChat(1) — set by picking Tell to Allegiance. */
  wantsAllegianceChat = false;

  isEnabled(id: TalkFocusId): boolean {
    return (this.allowedMask & (1 << id)) !== 0;
  }

  /** HandleSelection @ 004cd540: false when the item is disabled. */
  handleSelection(id: TalkFocusId): boolean {
    if (!this.isEnabled(id)) return false;
    if (id === TalkFocus.Allegiance) this.wantsAllegianceChat = true;
    this.focus = id;
    return true;
  }

  /** SetTalkFocusEnabled @ 00589080 → RecvNotice_EnableChatTargetSelection: a disabled current focus reverts to Say. */
  setEnabled(id: TalkFocusId, on: boolean): void {
    if (on) this.allowedMask |= 1 << id;
    else this.allowedMask &= ~(1 << id);
    this.allowedMask |= 1 << TalkFocus.Say;
    if (!on && this.focus === id) this.focus = TalkFocus.Say;
  }

  /** SetSelected @ 004cd730 ('' / 0 = nobody). */
  setSelected(guid: number, name: string, squelched: boolean): void {
    this.lastSpeakable = name ? guid : 0;
    this.lastSpeakableName = name;
    this.targetSquelched = !!name && squelched;
    this.setEnabled(TalkFocus.Selected, !!name);
  }

  /** The button's label (HandleSelection's relabel). */
  buttonLabel(): { stringId: number; text: string } {
    return BUTTON_LABELS[this.focus];
  }

  /** ResetAllTalkFocusMenuButtons @ 004cd4a0 + the pressed focus / squelch: each row's state. */
  itemState(item: TalkFocusMenuItem, isOlthoi = false): number {
    if (item.focus === null) {
      if (!this.lastSpeakableName) return ITEM_STATE.disabled;
      return this.targetSquelched ? ITEM_STATE.pressed : ITEM_STATE.normal;
    }
    const id = item.focus;
    // An Olthoi player keeps only Say, Olthoi and Tell to Selected.
    if (isOlthoi && id !== TalkFocus.Say && id !== TalkFocus.Olthoi && id !== TalkFocus.Selected) return ITEM_STATE.disabled;
    if (!this.isEnabled(id)) return ITEM_STATE.disabled;
    return id === this.focus ? ITEM_STATE.pressed : ITEM_STATE.normal;
  }

}

/** The allegiance records the talk-focus enables read (GameUI's allegianceInfo). */
export interface TalkFocusAllegiance {
  selfGuid?: number;
  members: ReadonlyArray<{ guid: number; parentGuid: number; isOnline: boolean }>;
}

/**
 * The allegiance-driven talk-focus enables. Patron: gmAllegianceUI::
 * UpdatePatronData @ 004917c0 enables focus 4 when AllegianceProfile::
 * GetPatron finds a patron and AllegianceData::IsLoggedIn, whether or not the
 * patron is also the monarch (only the PATRON *section* is hidden then). So
 * resolve the patron from the player's own record, never from allegianceInfo's
 * derived `patron`, which is left out when patron == monarch. Monarch: the
 * root record, unless that is the player. Vassals: any online direct vassal.
 */
export function talkFocusAllegianceEnables(a: TalkFocusAllegiance | null | undefined): { patron: boolean; monarch: boolean; vassals: boolean } {
  if (!a) return { patron: false, monarch: false, vassals: false };
  const self = a.selfGuid != null ? a.members.find(m => m.guid === a.selfGuid) : undefined;
  const patron = self && self.parentGuid !== 0 ? a.members.find(m => m.guid === self.parentGuid) : undefined;
  const monarch = a.members.find(m => m.parentGuid === 0);
  return {
    patron: !!patron?.isOnline,
    monarch: !!monarch && monarch.guid !== a.selfGuid && monarch.isOnline,
    vassals: a.selfGuid != null && a.members.some(m => m.parentGuid === a.selfGuid && m.isOnline),
  };
}

/**
 * The popup's DAT geometry (layout 0x21000006): popup 0x1000001c 382x104
 * (0x0600124c), listbox 0x1000001d at (0,2) in two columns, item template
 * 0x1000001e 191x17 (base 0x2100003f:0x10000377): state 1 0x0600124e,
 * 0x10000001 0x0600124d, 13 the same tile with text ARGB 0xff999999; text
 * left-justified 20 px in.
 */
export const TALK_MENU_GEOMETRY = {
  popup: { w: 382, h: 104, tex: 0x0600124c },
  list: { x: 0, y: 2, w: 382, h: 102, columns: 2 },
  item: { w: 191, h: 17, textX: 20, normalTex: 0x0600124e, pressedTex: 0x0600124d, disabledTextArgb: 0xff999999 },
} as const;
