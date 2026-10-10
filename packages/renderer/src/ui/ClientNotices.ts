/**
 * ClientNotices — where each CLIENT-originated notice goes (CORE.17.k.a).
 *
 * Retail routes text the client itself authors through three sinks, and the
 * decompiled EoL client (reference/client-eol/decomp/acclient-decompiled.c)
 * is consistent about which is which:
 *
 *  - **spew** — `ECM_UI::SendNotice_DisplayStringInfo(0x1a, …)` (96 UI call
 *    sites: "You can't put that item there" @ 163913, "You must select a
 *    suitable target before casting this spell" @ 350300, the four portal
 *    storm notices @ 347589–347661, "You must unwield your shirt and pants to
 *    wield that." @ 344748 …) and every `ClientSystem::AddTextToScroll(…,
 *    0x1a, …)` in the `ClientCommunicationSystem::Do*` chat-command handlers:
 *    the client's ARGUMENT / VALIDATION FAILURES. `DoTell` @ 363430 "Use comma
 *    after the name for targeted chat.", `DoReply` @ 363131/363147, `DoReTell`
 *    @ 363301, `DoFriends` @ 367119, `DoFriendsAdd` @ 364592/364635,
 *    `DoSquelch` @ 365356, `DoPermit` @ 363913/363970, `DoConsent` @
 *    368921/368933, `DoHouse` @ 370954, `DoAllegiance` @ 368645, `DoLoc` @
 *    365605 "Not in valid cell!", `DoSaveUI` @ 358016/358042 … Text type 0x1a
 *    lands in the spew box (gmSpewBoxUI, layout 0x21000011); an UNTARGETED
 *    copy reaches a chat window only when Chat Options > Errors is ticked
 *    (SpewBoxModel.ts), a targeted one always (see "Which WINDOW" below).
 *  - **chat** — `AddTextToScroll(…, 0, …)`: STATE CONFIRMATIONS and LISTINGS.
 *    "You are now set to away-from-keyboard.\n" @ 367940, "You can now accept
 *    corpse looting permissions from other players.\n" @ 368840, "Turbine
 *    chat is not available.\n" @ 368724, the `@help` output (`DoHelp` @
 *    370397), "The following channels are available to you:\n" @ 368264,
 *    `DoTitle` @ 365848 "This command must be issued from a popup chat
 *    window." — plain type-0 lines in the chat log.
 *  - **console** — nothing. Retail's `DoClear` @ 356590 only raises
 *    `CM_UI::SendNotice_ClearChatBuffer`; there is no `@logout`, `@time`,
 *    `@who`, `@reconnect`, `@logging`, `@cancelattack`, `@querymana` or
 *    fellowship chat command in the `ClientCommunicationSystem::Do*` table at
 *    all (the retail fellowship/allegiance flows are panel buttons that are
 *    simply disabled without a target). Progress echoes for those commands
 *    are ours, so they go to the developer console, never the player's chat.
 *
 * Which WINDOW (BUG.main-chat-shows-error-lines-in-retail): every `Do*`
 * handler passes `this->m_idCurrentCommandSource` — the ChatInterface window
 * id whose entry the command was typed in (`ClientCommunicationSystem`
 * command-line handler @ 371399) — as AddTextToScroll's target window, and
 * `ChatInterface::RecvNotice_DisplayFinalStringInfo` @ 004f4640 shows a line
 * targeted at its own id REGARDLESS of its type filter and drops it in every
 * other window. So "You must specify the text you wish to say!" lands in the
 * spew box AND in the main chat when typed there (the Wine frame
 * verification/bug-spew-under-vitals/retail-reply-short.png), but in the
 * floaty window instead when typed in one. UI call sites
 * (`SendNotice_DisplayStringInfo(0x1a, str)`) and the AFK / "You do not
 * belong to a Fellowship." lines pass window 0: untargeted, so filtered.
 * Catalogue entries carry that as `commandFeedback`.
 *
 * Wording: where retail has the string we use it verbatim (line cites below);
 * where a notice guards a flow retail never had we keep our own text but
 * still use the retail sink for its KIND (validation failure → spew).
 */

import { SPELL_COMPONENTS_MISSING_TEXT } from '@ac/shared';
import { LOGGING_OFF_TEXT } from '../session/LogoutFlow.js';

export type NoticeSink = 'spew' | 'chat' | 'console';

export interface ClientNotice {
  readonly id: string;
  readonly sink: NoticeSink;
  readonly text: string;
  /** Decompiled-client evidence for the text and/or the sink. */
  readonly cite: string;
  /**
   * Raised by a chat-command handler with `m_idCurrentCommandSource` as the
   * target window: the chat copy goes to the window the command was typed
   * in, unfiltered, and nowhere else.
   */
  readonly commandFeedback: boolean;
}

/** The subset of GameUI a notice needs. */
export interface NoticeSurface {
  displayErrorText(text: string, targetWindowId?: number): void;
  addSystemMessage(text: string, color?: string, type?: number, targetWindowId?: number): void;
  /** Window id of the chat entry the last command was typed in (retail m_idCurrentCommandSource). */
  readonly commandSourceWindowId?: number;
}

/** Retail AddTextToScroll's "no target window" id: filtered per window. */
export const UNTARGETED_WINDOW_ID = 0;

function n(id: string, sink: NoticeSink, text: string, cite: string, commandFeedback = true): ClientNotice {
  return Object.freeze({ id, sink, text, cite, commandFeedback });
}

/** A notice retail raises untargeted (UI call sites, window-0 AddTextToScroll). */
function ui(id: string, sink: NoticeSink, text: string, cite: string): ClientNotice {
  return n(id, sink, text, cite, false);
}

const SPEW_CMD = 'ClientCommunicationSystem::Do* AddTextToScroll(…, 0x1a, …) — validation failure';
const CHAT_CMD = 'ClientCommunicationSystem::Do* AddTextToScroll(…, 0, …) — state confirmation';
const NOT_RETAIL = 'no ClientCommunicationSystem::Do* handler for this command — our own echo';

export const CLIENT_NOTICES = Object.freeze({
  // ── /tell, /r, /retell (DoTell @ 363407, DoReply @ 363110, DoReTell @ 363265) ──

  // ── /friends (DoFriends @ 367045, DoFriendsAdd @ 364577) ──

  // ── /squelch, /unsquelch (DoSquelch, DoUnSquelch @ 367249) ──

  // ── /permit, /consent (DoPermit @ 363890, DoConsent @ 368810) ──

  // ── /house, /allegiance (DoHouse @ 370930, DoAllegiance @ 368620) ──

  // ── /chat, /notell, /afk ──
  afkOn: ui('afkOn', 'chat', 'You are now set to away-from-keyboard.', '@ 367940, type 0'),
  afkOff: ui('afkOff', 'chat', 'You are no longer set to away-from-keyboard.', '@ 367945, type 0'),

  // ── item use / wield / cast pre-checks (UI call sites of SendNotice_DisplayStringInfo(0x1a)) ──
  // BUG.spellcast-cost-components — ClientMagicSystem::CastSpell component pre-check.
  castMissingComponents: ui('castMissingComponents', 'spew', SPELL_COMPONENTS_MISSING_TEXT, '@ 350254, 0x1a'),
  castNoTarget: ui('castNoTarget', 'spew', 'You must select a suitable target before casting this spell', '@ 350300, 0x1a'),
  // SWEEP1006B.magic-casting.targeted-casts-skip-objectcompatiblewithspell-casting —
  // ObjectCompatibleWithSpellTargetType @ 00567230 (loud): "You cannot cast this
  // spell upon yourself" / "Cannot cast spell on a stack of items." / "This spell
  // cannot be cast on %s" (text supplied per raise, spellTargetRefusalText).
  castTargetRefused: ui('castTargetRefused', 'spew', 'This spell cannot be cast on %s', 'ObjectCompatibleWithSpellTargetType @ 00567230, SendNotice_DisplayStringInfo(0x1a)'),
  // ObjectCompatibleWithSpell @ 00567c30 on a compatible target: "Casting %hs" (.rdata 0x7ce8f0).
  castingSpell: ui('castingSpell', 'spew', 'Casting %hs', 'ObjectCompatibleWithSpell @ 00567c30, SendNotice_DisplayStringInfo(0x1a)'),
  // CORE.17.k.b.b.a.g.c — gmSpellcastingUI::Cast @ 004c6050 with no selected shortcut.
  castNoSpellSelected: ui('castNoSpellSelected', 'spew', 'You must select a spell to cast', 'gmSpellcastingUI::Cast @ 004c6050, 0x1a'),

  // ── movement (CommandInterpreter::SetAutoRun @ 006b4850, SendNotice_DisplayStringInfo(0x1a)) ──
  autoRunOn: ui('autoRunOn', 'spew', 'AutoRun ON', 'CommandInterpreter::SetAutoRun @ 006b4850, SendNotice_DisplayStringInfo(0x1a)'),
  autoRunOff: ui('autoRunOff', 'spew', 'AutoRun OFF', 'CommandInterpreter::SetAutoRun @ 006b4850, SendNotice_DisplayStringInfo(0x1a)'),
  actionInterrupted: ui('actionInterrupted', 'spew', 'Action interrupted', 'ClientUISystem::OnAction case 0x27 (Escape while moving), AddTextToScroll(…, 0x1a)'),
  // ── jump refusals (ClientCombatSystem::CommenceJump @ 0056af90 / DoJump @ 0056b110, AddTextToScroll(…, 0x1a, true, 0)) ──
  cantJumpPosition: ui('cantJumpPosition', 'spew', "You can't jump from this position", 'cant_jump_position ($E139 @ 00709040), 0x1a'),
  cantJumpInAir: ui('cantJumpInAir', 'spew', "You can't jump while in the air", 'cant_jump_in_air ($E142 @ 00709080), 0x1a'),
  combatModeIncompatible: ui('combatModeIncompatible', 'spew', "You can't enter %hs mode while wielding the %s", 'ClientCombatSystem::SetCombatMode @ 0056be30 (:354322-354340, CompatibleCombatMode @ 0056a580), AddTextToScroll(…, 0x1a)'),
  combatModeInPortalSpace: ui('combatModeInPortalSpace', 'spew', "You can't enter combat mode while in portal space", 'ClientCombatSystem::SetCombatMode @ 0056be30 (:354346, teleportInProgress), AddTextToScroll(…, 0x1a)'),
  cantJumpLoad: ui('cantJumpLoad', 'spew', "You're too loaded down to jump", 'cant_jump_load ($E145 @ 007090c0), 0x1a'),

  // ── portal storm (ClientUISystem::Handle_Misc__PortalStorm*) ──
  portalStormBrewing: ui('portalStormBrewing', 'spew', 'This area is getting too crowded - a Portal Storm is brewing.', '@ 347620, SendNotice_DisplayStringInfo(0x1a)'),
  portalStormImminent: ui('portalStormImminent', 'spew', 'A Portal Storm is imminent - leave this crowded area!', '@ 347661, SendNotice_DisplayStringInfo(0x1a)'),
  portalStormSubsided: ui('portalStormSubsided', 'spew', 'The Portal Storm has subsided', '@ 347589, SendNotice_DisplayStringInfo(0x1a)'),

  // ── fellowship / allegiance flows (retail: panel buttons, disabled without a target) ──
  noTargetSelected: ui('noTargetSelected', 'spew', 'No target selected. Select a player first.', SPEW_CMD + ' (our text; retail disables the button)'),
  swearNeedsPlayer: ui('swearNeedsPlayer', 'spew', 'You must target another player to swear allegiance.', SPEW_CMD + ' (our text)'),
  swearAlreadyMember: ui('swearAlreadyMember', 'spew', 'That player is already in your allegiance.', SPEW_CMD + ' (our text)'),
  breakNeedsPlayer: ui('breakNeedsPlayer', 'spew', 'You must target a player from your allegiance to break.', SPEW_CMD + ' (our text)'),

  // ── logout to character select (session/LogoutFlow.ts) ──
  // RequestLogOff prints it; retail's quit (Exit Game → the epilogue →
  // ExecuteLogOff) prints nothing, so only the logout raises it.
  loggingOff: ui('loggingOff', 'chat', LOGGING_OFF_TEXT, 'CPlayerSystem::RequestLogOff @ 00562dd0 / LogOffCharacter @ 00563520, AddTextToScroll(…, 0, true, 0): type 0, window 0'),

  // ── our regex chat filter (retail @filter filters message TYPES; ours is a text filter) ──

  // ── commands retail never had: echoes stay in the developer console ──
  reconnecting: ui('reconnecting', 'console', 'Reconnecting to the ACE server…', NOT_RETAIL),
  // CORE.17.k.b — the stale-session login retry: retail shows the Disconnected
  // screen for CharacterError.Logon and never prints connection progress.
  loginRetryWaiting: ui('loginRetryWaiting', 'console', 'Account still logged on server-side — retrying login…', 'no retail progress text; the connecting screen carries the wait (CORE.17.k.b)'),
  allegianceSwearing: ui('allegianceSwearing', 'console', 'Swearing allegiance to target...', NOT_RETAIL),
  restoredToLife: ui('restoredToLife', 'console', 'You have been restored to life.', 'no retail or ACE source for this line'),
  // RELEASE.portal-space-cell-gate — the streamed-DAT gate gave up (timeout /
  // failed download) and let the player out of portal space anyway. Retail's
  // DATs were local, so it has no such line; the spew sink is its kind's
  // (a transient warning over the 3D view).
  datStreamFailed: ui('datStreamFailed', 'spew', 'Some game data for this area could not be downloaded.', 'no retail equivalent (retail DATs are local); RELEASE.portal-space-cell-gate'),
});

export type ClientNoticeId = keyof typeof CLIENT_NOTICES;

export interface RaiseOptions {
  /** Chat colour for the `chat` sink. */
  color?: string;
  /** Chat text type for the `chat` sink. */
  type?: number;
  /** Text override (dynamic notices keep the catalogue entry's sink). */
  text?: string;
  /** Console sink target (default `console.log`). */
  log?: (line: string) => void;
}

/**
 * Deliver a client notice through its retail sink: spew box (0x1a), plain
 * chat line, or the developer console. Returns the sink used.
 */
export function raiseClientNotice(surface: NoticeSurface, notice: ClientNotice, opts: RaiseOptions = {}): NoticeSink {
  const text = opts.text ?? notice.text;
  const target = notice.commandFeedback
    ? (surface.commandSourceWindowId ?? UNTARGETED_WINDOW_ID)
    : UNTARGETED_WINDOW_ID;
  switch (notice.sink) {
    case 'spew':
      surface.displayErrorText(text, target);
      break;
    case 'chat':
      surface.addSystemMessage(text, opts.color, opts.type, target);
      break;
    case 'console':
      (opts.log ?? ((line: string) => console.log(line)))(`[AC] ${text}`);
      break;
  }
  return notice.sink;
}

/**
 * ClientCombatSystem::SetCombatMode @ 0056be30, user path (param_2 true):
 * while CPlayerSystem::teleportInProgress is set, every requested mode change
 * (into combat AND back to peace) is refused with this line and nothing is
 * sent (decomp :354345-354354). The server-driven path (OnQualityChanged →
 * SetCombatMode(mode, false)) skips the check.
 */
export function combatModeChangeRefusal(state: { teleportInProgress: boolean }): ClientNotice | null {
  return state.teleportInProgress ? CLIENT_NOTICES.combatModeInPortalSpace : null;
}

/**
 * The line a refused jump raises, by its WeenieError code (the switch in
 * ClientCombatSystem::CommenceJump @ 0056af90 / DoJump @ 0056b110): 0x24 in
 * the air, 0x48 position, 0x49 load. Any other code has no case: silent.
 */
export function jumpRefusalNotice(code: number): ClientNotice | null {
  switch (code) {
    case 0x24: return CLIENT_NOTICES.cantJumpInAir;
    case 0x48: return CLIENT_NOTICES.cantJumpPosition;
    case 0x49: return CLIENT_NOTICES.cantJumpLoad;
    default: return null;
  }
}

/** Every catalogue entry, for audits and tests. */
export function allClientNotices(): ClientNotice[] {
  return Object.values(CLIENT_NOTICES);
}

