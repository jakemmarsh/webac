/**
 * ServerMessageText — the text (and chat text type) the retail client builds
 * when a server message arrives, for the handlers whose whole reaction is a
 * line of text or a dialog. Every builder here is a port of one decompiled
 * EoL client function (reference/client-eol/decomp/acclient-decompiled.
 * annotated.c); main.ts's ServerMessageHandler callbacks call them and hand
 * the result to `addTextToScroll` (or a GameUI dialog).
 *
 * Text type decides both the colour and which chat windows show a line
 * (ChatInterface::TypeIsActive): 0 = Broadcast (green, every window), 0x15
 * CombatEnemy / 0x16 CombatSelf (the Combat filters), 0x1a = the spew box
 * (gmSpewBoxUI) and only chat windows with Errors ticked. `ClientSystem::
 * AddTextToScroll @ 00563c50` trims the "\n" retail appends to every line,
 * so the builders leave it off.
 *
 * DECOMP sweep 2026-09-30, group M (docs/decomp-diff-sweep-2026-09-30.md).
 */

import { ChatMessageType, chatColorFor } from '@ac/shared';
import { acStringHash, getStringPartsFromTable } from '@ac/dat-parser/file-types/LayoutDesc.js';
import { ERROR_TEXT_TYPE } from './SpewBoxModel.js';

/** One `ClientSystem::AddTextToScroll(text, type, true, 0)`. */
export interface ScrollLine {
  readonly text: string;
  readonly type: number;
}

/** The GameUI surface a ScrollLine lands on. */
export interface ScrollSurface {
  displayErrorText(text: string): void;
  addSystemMessage(text: string, color?: string, type?: number): void;
}

/**
 * AddTextToScroll for an untargeted line: type 0x1a is the spew-box notice
 * (GameUI.displayErrorText also copies it to Errors-enabled chat windows);
 * every other type is a chat line in that type's retail colour.
 */
export function addTextToScroll(ui: ScrollSurface, line: ScrollLine | null): void {
  if (!line) return;
  if (line.type === ERROR_TEXT_TYPE) ui.displayErrorText(line.text);
  else ui.addSystemMessage(line.text, chatColorFor(line.type), line.type);
}

// ── Combat (ClientCombatSystem) ──────────────────────────────────────────

/**
 * `HandleEvasionAttackerNotificationEvent @ 0056c7a0`: name + " evaded your
 * attack." as CombatSelf (0x16).
 */
export function evasionAttackerLine(defenderName: string): ScrollLine {
  return { text: `${defenderName} evaded your attack.`, type: ChatMessageType.CombatSelf };
}

/**
 * `HandleEvasionDefenderNotificationEvent @ 0056c620`: "You evaded " + name
 * + "!" as CombatEnemy (0x15).
 */
export function evasionDefenderLine(attackerName: string): ScrollLine {
  return { text: `You evaded ${attackerName}!`, type: ChatMessageType.CombatEnemy };
}

/** HandleAttackerNotificationEvent @ 0056b420 posts its one line as CombatSelf (0x16). */
export function attackerHitLine(text: string): ScrollLine {
  return { text, type: ChatMessageType.CombatSelf };
}

/** HandleDefenderNotificationEvent @ 0056c920 posts its one line as CombatEnemy (0x15). */
export function defenderHitLine(text: string): ScrollLine {
  return { text, type: ChatMessageType.CombatEnemy };
}

/**
 * `HandleVictimNotificationEvent @ 0056c410` — the handler for BOTH
 * VictimNotification (0x1ac) and KillerNotification (0x1ad) (the
 * dispatcher @ 340090 sends both there): the server's death message as a
 * type-0 line, nothing when the string is empty.
 */
export function victimOrKillerLine(message: string): ScrollLine | null {
  return message ? { text: message, type: ChatMessageType.Broadcast } : null;
}

/**
 * `HandlePlayerDeathEvent @ 0056c320` (PlayerKilled 0x19e, broadcast to
 * everyone nearby): printed as type 0 only when this client is NEITHER the
 * victim NOR the killer — those two already got their private Victim /
 * Killer notification — and the string is non-empty.
 */
export function playerKilledLine(
  message: string, victimGuid: number, killerGuid: number, selfGuid: number | null,
): ScrollLine | null {
  const self = selfGuid ?? 0;
  if (self === victimGuid || self === killerGuid || !message) return null;
  return { text: message, type: ChatMessageType.Broadcast };
}

// ── Communication (ClientCommunicationSystem) ────────────────────────────

/**
 * `Handle_Communication__TransientString @ 0057d460`: the string as-is,
 * type 0x1a — the spew-box notice ("You are out of ammunition!").
 */
export function transientStringLine(message: string): ScrollLine {
  return { text: message, type: ERROR_TEXT_TYPE };
}

/**
 * `Handle_Communication__ChannelIndex @ 0057d0c0`: a header line, then one
 * line per channel indented three spaces, all type 0 (the header prints even
 * for an empty list).
 */
export function channelIndexLines(channels: readonly string[]): ScrollLine[] {
  return listingLines('The following channels are available to you:', channels);
}

/** `Handle_Communication__ChannelList @ 0057d230` — same shape, the listeners. */
export function channelListLines(players: readonly string[]): ScrollLine[] {
  return listingLines('The following characters are currently listening on the channel:', players);
}

function listingLines(header: string, names: readonly string[]): ScrollLine[] {
  return [header, ...names.map((n) => `   ${n}`)].map((text) => ({ text, type: ChatMessageType.Broadcast }));
}

// ── Trade (ClientTradeSystem) ────────────────────────────────────────────

/**
 * `Handle_Trade__Recv_CloseTrade @ 0056de30`: always the wide literal
 * "The trade has been cancelled." as type 0x1a, whatever the end reason.
 */
export const TRADE_CLOSED_TEXT = 'The trade has been cancelled.';
export function tradeClosedLine(): ScrollLine {
  return { text: TRADE_CLOSED_TEXT, type: ERROR_TEXT_TYPE };
}

// ── Allegiance (gmAllegianceUI) ──────────────────────────────────────────

/**
 * `gmAllegianceUI::RecvNotice_AllegianceLogin @ 00492220`: nothing unless
 * the guid is in the allegiance data (AllegianceProfile::GetData), then the
 * data's name + " is logged in." / " has logged out." as type 0.
 * `allegianceName` is that lookup's result (null = not in the allegiance).
 */
export function allegianceLoginLine(allegianceName: string | null, loggedIn: boolean): ScrollLine | null {
  if (allegianceName === null) return null;
  return {
    text: `${allegianceName}${loggedIn ? ' is logged in.' : ' has logged out.'}`,
    type: ChatMessageType.Broadcast,
  };
}

// ── ConfirmationRequest (ClientUISystem) ─────────────────────────────────

/** StringInfo table enum 0x10000001 → StringTable 0x23000001. */
export const CONFIRMATION_STRING_TABLE = 0x23000001;
export const CONFIRMATION_STRING_IDS = {
  /** gmAllegianceUI::MakeAcceptSwearConfirmationDialog @ 00492990. */
  swearAllegiance: acStringHash('ID_Allegiance_AcceptSwearConfirmation'),
  /** gmFellowshipUI::MakeFellowRequestDialog @ 00490620. */
  fellowship: acStringHash('ID_Fellowship_FellowshipRequest'),
} as const;

/** Verbatim DAT fragments (string table 0x23000001), fallback only. */
const CONFIRMATION_FALLBACK: Record<number, string[]> = {
  [CONFIRMATION_STRING_IDS.swearAllegiance]: ['', ' would like to swear allegiance to you. Do you accept?'],
  [CONFIRMATION_STRING_IDS.fellowship]: ['', ' has invited you to join their fellowship. Do you accept?'],
};

/** ACE ConfirmationType (ACE.Entity/Enum/ConfirmationType.cs). */
export const ConfirmationType = {
  SwearAllegiance: 1,
  AlterSkill: 2,
  AlterAttribute: 3,
  Fellowship: 4,
  CraftInteraction: 5,
  Augmentation: 6,
  YesNo: 7,
} as const;

/** The template's fragments with %PLAYER% in the one variable slot. */
function fillPlayer(id: number, name: string): string {
  const parts = getStringPartsFromTable(CONFIRMATION_STRING_TABLE, id) ?? CONFIRMATION_FALLBACK[id];
  return parts.length <= 1 ? parts.join('') : parts.join(name);
}

/**
 * The Yes / No dialog text for a ConfirmationRequest —
 * `ClientUISystem::Handle_Character__ConfirmationRequest @ 005640a0`
 * dispatches by type:
 *   1 → ID_Allegiance_AcceptSwearConfirmation with PLAYER = the string;
 *   4 → ID_Fellowship_FellowshipRequest with PLAYER = the string;
 *   2 / 3 / 5 / 6 → gmGamePlayUI::RecvNotice_{AlterSkill,AlterAttribute,
 *       CraftInteraction,Augmentation}_ConfirmationRequest: string + " Continue?";
 *   7 → RecvNotice_YesNo_ConfirmationRequest @ 004ebd10: the string as-is.
 * Any other type raises nothing (null).
 */
export function confirmationRequestText(confirmationType: number, text: string): string | null {
  switch (confirmationType) {
    case ConfirmationType.SwearAllegiance: return fillPlayer(CONFIRMATION_STRING_IDS.swearAllegiance, text);
    case ConfirmationType.Fellowship: return fillPlayer(CONFIRMATION_STRING_IDS.fellowship, text);
    case ConfirmationType.AlterSkill:
    case ConfirmationType.AlterAttribute:
    case ConfirmationType.CraftInteraction:
    case ConfirmationType.Augmentation:
      return `${text} Continue?`;
    case ConfirmationType.YesNo: return text;
    default: return null;
  }
}
