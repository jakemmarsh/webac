/**
 * BUG.ac1999-silent-refusals (2026-11-03) — one line for the AC1999 server's refusals of a player's own
 * click that the 1999 client printed nothing for.
 *
 * The AC1999 server sends these codes as a bare 0x1C AttemptFailed with no text of its own. The 1999
 * client's failure switch, UI_HandleFailureEvent @ 0x004ccd10 (ui/FailureEventText1999.ts), has no arm
 * for any of them (they come from a later code set), so the click did nothing a player could see. A
 * week of prod telemetry (2026-10-28 .. 11-03, `sink="none"`):
 *   - 0x550 WERROR_MISSILE_OUT_OF_RANGE, a cast or a research cast at a target past the spell's range
 *     (SpellcastingManager::CheckTargetValidity → ReportTargetError hands it back → NotifyUseDone):
 *     about 150 refusals over 12 sessions, players pressing cast again and again.
 *   - 0x4FC WERROR_HEAL_NOT_TRAINED and 0x501 WERROR_HEAL_PLAYERS_ONLY, a healing kit used without the
 *     skill or on a creature (Healer.cpp CHealerWeenie::UseWith).
 *   - 0x4C8 WERROR_ACTIVATION_NOT_ENOUGH_MANA, a wand or orb too low on mana to cast its spell
 *     (Player.cpp, the wand use event).
 *   - 0x4B2 WERROR_CHEST_WRONG_KEY, a key used on a lock it doesn't open (Key.cpp; only a sound).
 *   - 0x498 WERROR_MOVED_TOO_FAR, a use cancelled because the player moved off (UseManager Cancel).
 *
 * A departure from 1999 (docs/ac1999-support.md, "Failure codes"), the same one as
 * ui/SocialRefusalLines1999.ts: each code gets end of retail's own text and sink for it
 * (ClientCommunicationSystem::HandleFailureEvent @ 00571990, @ac/shared weenieErrorText /
 * weenieErrorTextType), so the wording is a retail client's, not ours. Every code here is sent only
 * in answer to the player's own request, so no action window is needed.
 *
 * Not here, because the AC1999 server already says why in its own text line just before the code:
 * 0x405 WERROR_MAGIC_SPELLBOOK_ADDSPELL_FAILURE ("That is not a valid spell formula.", the 0x4B
 * research handler for a formula under 5 components or with no Talisman), 0x3FC
 * WERROR_MAGIC_INVALID_SPELL_TYPE ("You are not trained in that skill!"), 0x1E
 * WERROR_EXTERNAL_ACTIONS_LOCKED ("{Name} is busy."), and 0x468 WERROR_SKILL_TOO_LOW from a scroll.
 * Nor 0x43 WERROR_NO_MTABLE_DATA (the server could not play a motion: a healing kit in a combat stance, the
 * 1999 table having the heal motions only in peace; both clients only end a repeat attack on it,
 * WeenieErrorNotices.ts abortRepeatAttackOnFailure, BUG.ac1999-server-no-mtable-data), nor any
 * code the 1999 switch has an arm for.
 */
import { weenieErrorText, weenieErrorTextType } from '@ac/shared';
import type { FailureEventArm, FailureEventTable } from './FailureEventText1999.js';

/** The AC1999 server's codes (Server/Source/PhatSDK/GameEnums.h), numbered as it sends them. */
export const SILENT_WERROR_1999 = Object.freeze({
  MOVED_TOO_FAR: 0x498,
  CHEST_WRONG_KEY: 0x4b2,
  ACTIVATION_NOT_ENOUGH_MANA: 0x4c8,
  HEAL_NOT_TRAINED: 0x4fc,
  HEAL_PLAYERS_ONLY: 0x501,
  MISSILE_OUT_OF_RANGE: 0x550,
});

/** End of retail's arm for `code`: its HandleFailureEvent text and AddTextToScroll type. */
function eorArm(code: number): FailureEventArm {
  const text = weenieErrorText(code);
  const type = weenieErrorTextType(code);
  if (!text || type === null) throw new Error(`end of retail has no arm for 0x${code.toString(16)}`);
  return Object.freeze({ type, text });
}

export const SILENT_REFUSAL_LINES_1999: FailureEventTable = new Map(
  Object.values(SILENT_WERROR_1999).map((code) => [code, eorArm(code)] as const),
);
