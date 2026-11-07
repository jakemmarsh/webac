/**
 * WeenieErrorNotices — deliver a server WeenieError / WeenieErrorWithString /
 * UseDone text through the sink the retail client used for that CODE
 * (CORE.17.k.c).
 *
 * Retail: `ClientCommunicationSystem::HandleFailureEvent @ 00571990` is the
 * one switch every server failure code runs through — from
 * `Handle_Communication__WeenieError @ 0057adf0` (0x028A),
 * `Handle_Communication__WeenieErrorWithString @ 0057cb90` (0x028B, the
 * value substituted into the code's template) and
 * `ClientUISystem::Handle_Item__UseDone` (0x01C7 with a non-zero code). Each
 * arm is `ClientSystem::AddTextToScroll(this, text, TYPE, true, 0)`:
 *   - 0x1a → the spew box over the 3D view ("You're too busy!", "You are too
 *     encumbered to carry that!", "You are unprepared to cast a spell", …);
 *     chat windows show it only with Chat Options > Errors ticked.
 *   - 0 → a plain chat line ("You must be a monarch to purchase this
 *     dwelling.", the fellowship / allegiance / house listings) in the type-0
 *     colour.
 *   - 7 → a chat line of text type 7 (the Olthoi refusals, the PK
 *     "fails to affect you" lines) in the Magic colour.
 *   - no arm → NOTHING. The retail client had no text for e.g. TradeClosed,
 *     FullInventoryLocation, FellowshipIgnoringRequests or SkillTooLow — the
 *     ACE <summary> strings we carry for them were never on screen.
 * The map itself is generated from the decomp: @ac/shared WeenieErrorSink.ts.
 *
 * Not text: `ClientCombatSystem::HandleAttackDoneEvent @ 0056c4d0` only
 * aborts the auto-repeat on a non-zero code, `gmSecureTradeUI::
 * RecvNotice_TradeFailure @ 004ca680` only removes the item, and
 * `ClientAllegianceSystem::Handle_Allegiance__AllegianceUpdateAborted @
 * 00569fd0` only raises the UI notice — none of those events print.
 */
import { chatColorFor, weenieErrorTextType, WEENIE_ERROR_TEXT_TYPE_SPEW, type WeenieErrorSink } from '@ac/shared';
import type { NoticeSurface } from './ClientNotices.js';
import type { FailureEventArm, FailureEventTable } from './FailureEventText1999.js';

export interface WeenieErrorDelivery {
  readonly sink: WeenieErrorSink;
  /** The retail AddTextToScroll text type, or null when retail printed nothing. */
  readonly type: number | null;
  readonly text: string | null;
}

/**
 * Deliver `text` for `code` through its retail sink. A null / empty text, or
 * a code the retail switch has no arm for, prints nothing (sink 'none').
 *
 * `table` is the era client's own failure switch when it is not end of
 * retail's (eraClientRules().failureEventText; SWEEP1999.messages HC-6): the
 * arm's type and text replace `text`, and a code with no arm prints nothing.
 * A 0x028B WithString caller passes no table: the 1999 client had no 0x28B
 * case at all, but the AC1999 server meant those lines (its own TODO), so
 * they keep end of retail's switch (docs/ac1999-support.md).
 *
 * `departure` is the line the era adds where its switch has no arm (BUG.ac1999-fellow-recruit-silent:
 * ui/SocialRefusalLines1999.ts, a refused recruit or swear); an arm the switch has always wins.
 */
export function deliverWeenieError(
  ui: NoticeSurface, code: number, text: string | null, table: FailureEventTable | null = null,
  departure: FailureEventArm | null = null,
): WeenieErrorDelivery {
  if (table) {
    const arm = table.get(code) ?? departure;
    if (!arm) return { sink: 'none', type: null, text: null };
    if (arm.type === WEENIE_ERROR_TEXT_TYPE_SPEW) {
      ui.displayErrorText(arm.text);
      return { sink: 'spew', type: arm.type, text: arm.text };
    }
    ui.addSystemMessage(arm.text, chatColorFor(arm.type), arm.type);
    return { sink: 'chat', type: arm.type, text: arm.text };
  }
  const type = weenieErrorTextType(code);
  if (!text || type === null) return { sink: 'none', type, text };
  if (type === WEENIE_ERROR_TEXT_TYPE_SPEW) {
    ui.displayErrorText(text);
    return { sink: 'spew', type, text };
  }
  ui.addSystemMessage(text, chatColorFor(type), type);
  return { sink: 'chat', type, text };
}

/**
 * BUG.ac1999-server-no-mtable-data — the codes whose HandleFailureEvent arm first ends a repeating attack.
 * Before any text, both clients' switch checks for five codes whether an automatic attack is running and,
 * if so, aborts it (CancelAttack goes out, the repeat stops, a combat bar hides):
 *   - end of retail, ClientCommunicationSystem::HandleFailureEvent @ 00571990, the branch @ 005719de: 0x23, 0x36,
 *     0x3e, then 0x43 / 0x3f7 jump to it → RepeatAttackInProgress @ 0056a860 → AbortAutomaticAttack @ 0056ae90;
 *   - 1999, UI_HandleFailureEvent @ 0x004ccd10 (the branch @ 0x004ccd4a): 0x23, 0x36, 0x3e, 0x43, 0x3f7 → 0x004f8e50
 *     (repeat on and an attack running) → 0x004f94b0 → CancelAttack @ 0x004f9530.
 * 0x43 WERROR_NO_MTABLE_DATA (a motion the server could not play) prints nothing in either client; this
 * abort is all it does. The other four keep their text (0x23 "Unable to move to object!", 0x36 "Action
 * cancelled!", 0x3e / 0x3f7 "You are too fatigued to attack!" in 1999).
 */
export const FAILURE_ABORTS_REPEAT_ATTACK: ReadonlySet<number> = new Set([0x23, 0x36, 0x3e, 0x43, 0x3f7]);

/** The two ClientCombatSystem calls HandleFailureEvent's abort branch makes (AttackRequestController). */
export interface RepeatAttackControl {
  repeatAttackInProgress(): boolean;
  abortAutomaticAttack(): void;
}

/**
 * HandleFailureEvent's leading branch: for a FAILURE_ABORTS_REPEAT_ATTACK code with a repeat attack in
 * progress, abort it. Runs for every way a code reaches the switch (WeenieError 0x28A / the AC1999 0x1C,
 * WeenieErrorWithString 0x28B, a non-zero UseDone 0x1C7, the 0xA0 codes that run the switch). Returns
 * whether it aborted.
 */
export function abortRepeatAttackOnFailure(code: number, combat: RepeatAttackControl | null | undefined): boolean {
  if (!combat || !FAILURE_ABORTS_REPEAT_ATTACK.has(code)) return false;
  if (!combat.repeatAttackInProgress()) return false;
  combat.abortAutomaticAttack();
  return true;
}

// BUG.duplicate-local-sounds — weenieErrorChimes (FAITHFUL.415/.416/.425) is
// gone: ClientCommunicationSystem::HandleFailureEvent @ 00571990 prints the
// text and plays nothing; no retail code path plays UI_GeneralError
// (audio/RetailLocalSounds).

/**
 * The 0x00A0 InventoryServerSaveFailed codes retail keeps OUT of
 * HandleFailureEvent (the dispatch switch @ decomp :339961): the templated
 * "_ …" texts that ACCWeenieObject::ServerSaysAttemptFailed prints itself
 * with the object's name, through SendNotice_DisplayStringInfo(0x1a).
 */
export const ATTEMPT_FAILED_NAME_TEMPLATED: ReadonlySet<number> = new Set([
  0x001e, // _IsTooBusyToAcceptGifts
  0x002b, // _CannotCarryAnymore
  0x03ef, // _IsNotAcceptingGiftsRightNow
  0x043e, // YouHaveSolvedThisQuestTooRecently
  0x046a, // TradeAiDoesntWant "_ doesn't know what to do with that."
  0x04ce, // AiRefuseItemDuringEmote
  0x04cf, // _CannotAcceptStackedItems
]);
