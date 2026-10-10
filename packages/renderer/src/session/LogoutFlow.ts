/**
 * LogoutFlow — the logout to character select, ported from the decompiled
 * EoL client (reference/client-eol/decomp/acclient-decompiled.annotated.c).
 * Pure: GameUI and main.ts supply the dialog, the chat/spew sinks, the send
 * and the teleport animation.
 *
 * Retail's sequence:
 *  1. The indicator-strip X (gmIndicatorsUI / gmFloatyIndicatorsUI 0x100000fa)
 *     and Options → Exit to Character Selection (gmGameplayOptionsUI
 *     0x10000203) raise CM_UI::SendNotice_EndCharacterSession(1).
 *     gmGamePlayUI::RecvNotice_EndCharacterSession @ 004ebea0 then opens the
 *     Yes/No dialog ID_Client_EndCharacterSessionConfirm (table 0x10000001 =
 *     0x23000001) through MakeLogoutConfirmationDialog @ 004eb6a0, which
 *     refuses a second dialog while m_logoutContext is set.
 *     The End Character Session key (0x10000026, Shift+Escape) skips the
 *     dialog: HandleKeyPress @ 004e9df0 sets m_bLogoutConfirmed directly.
 *  2. Yes (RecvNotice_CloseDialog @ 004ea4f0) sets m_doEndSession and
 *     m_bLogoutConfirmed; the next gmGamePlayUI::UseTime @ 004ea3a0 refuses
 *     a player off the ground (transient_state & 1 == 0) with the spew line
 *     "Cannot log off while in mid-air." and latches nothing, else calls
 *     CPlayerSystem::LogOffCharacter(false) @ 00563520.
 *  3. LogOffCharacter: CPlayerModule::SaveToServer; with an inventory
 *     request in flight it prints "Logging off..." and defers (DeferredLogOff:
 *     CPlayerSystem::UseTime requests once the reply lands); else RequestLogOff
 *     @ 00562dd0: AddTextToScroll("Logging off...\n", type 0, window 0),
 *     Proto_UI::LogOffCharacter, logOffRequested = true and logOffRequestTime
 *     = now + LOG_OFF_DELAY_ANIM_TIME (3), plus 20 when the player's
 *     ACCWeenieObject vtable +0x1c (IsPlayerKiller @ 0058c910) is true.
 *  4. gmSmartBoxUI::UseTime @ 004d6e30: once that time passes,
 *     BeginTeleportAnimation(TAS_WORLD_FADE_OUT) (Sound_UI_EnterPortal; the
 *     world zooms out and the tunnel fades in), SetTeleportInProgress(true)
 *     and SetLogOffStarted (logOffRequested = false). No position update is
 *     pending, so the teleport-in-progress mismatch ends the animation as
 *     soon as it reaches TAS_TUNNEL (EndTeleportAnimation): 2–5 s more of
 *     tunnel, then the world fades back in.
 *  5. The server's CharacterLogOff (0xF653) → CPlayerSystem::ExecuteLogOff
 *     @ 0055d780: logOffRequested = false, back to character select.
 *
 * Exit Game (0x10000617 → global 0x10000027) is retail's quit: HandleKeyPress
 * sets m_shouldQuitOnLogout, so UseTime queues the epilogue (0x10000009)
 * BEFORE the contact check, and gmEpilogueUI calls LogOffCharacter(true) →
 * ExecuteLogOff: no dialog, no mid-air refusal, no "Logging off..." line, no
 * fade. None of this module applies to it.
 */

/** gmGamePlayUI::RecvNotice_EndCharacterSession's dialog text (string table 0x23000001). */
export const END_CHARACTER_SESSION_CONFIRM_TOKEN = 'ID_Client_EndCharacterSessionConfirm';
/** The EoL client_local_English.dat text of that string (used only if the table is not loaded). */
export const END_CHARACTER_SESSION_CONFIRM_FALLBACK = 'This will exit your character from the game world.\n\nAre you sure?';
/** gmGamePlayUI::UseTime / EndSession: StringInfo::SetLiteralValue, spew (0x1a). */
export const LOG_OFF_MID_AIR_TEXT = 'Cannot log off while in mid-air.';
/** CPlayerSystem::RequestLogOff's AddTextToScroll literal (trailing "\n" dropped: one chat line). */
export const LOGGING_OFF_TEXT = 'Logging off...';
/** LOG_OFF_DELAY_ANIM_TIME (globals.tsv): seconds from the request to the world fade. */
export const LOG_OFF_DELAY_ANIM_TIME = 3;
/** RequestLogOff's `___real_4034000000000000` (20.0): the extra delay for a player killer. */
export const PLAYER_KILLER_LOG_OFF_EXTRA_DELAY = 20;

/** ACE PlayerKillerStatus (Enum/PlayerKillerStatus.cs). */
const PK_STATUS_PK = 0x04;
const PK_STATUS_PKLITE = 0x40;

/**
 * ACCWeenieObject::IsPlayerKiller @ 0058c910: PublicWeenieDesc bitfield 0x20
 * (PlayerKiller) or 0x2000000 (PkLiteStatus). ACE sets those two bits from
 * PlayerKillerStatus == PK / == PKLite (WorldObject_Networking.cs:865/876).
 */
export function isPlayerKiller(playerKillerStatus: number | undefined): boolean {
  return playerKillerStatus === PK_STATUS_PK || playerKillerStatus === PK_STATUS_PKLITE;
}

/** Seconds from RequestLogOff to the world fade. */
export function logOffRequestDelay(playerKiller: boolean): number {
  return LOG_OFF_DELAY_ANIM_TIME + (playerKiller ? PLAYER_KILLER_LOG_OFF_EXTRA_DELAY : 0);
}

/** CPlayerSystem's logOffRequested / logOffRequestTime pair (seconds clock). */
export class LogOffRequest {
  requested = false;
  requestTime = 0;

  /** RequestLogOff's timer half. */
  request(now: number, playerKiller: boolean): void {
    this.requested = true;
    this.requestTime = now + logOffRequestDelay(playerKiller);
  }

  /**
   * gmSmartBoxUI::UseTime's check: true exactly once, on the first pass after
   * the request time (`logOffRequestTime < now`), which also clears the
   * request (SetLogOffStarted @ 0055d7d0).
   */
  due(now: number): boolean {
    if (!this.requested || !(this.requestTime < now)) return false;
    this.requested = false;
    return true;
  }

  /** ExecuteLogOff @ 0055d780 (the server's CharacterLogOff) / teardown. */
  cancel(): void {
    this.requested = false;
  }
}

/** What the confirmed logout touches. */
export interface ConfirmedLogoutDeps {
  /** SmartBox::player->transient_state & 1 (contact). */
  onGround: boolean;
  /** ECM_UI::SendNotice_DisplayStringInfo(0x1a, …). */
  spew(text: string): void;
  /** Client-side session state that goes with the logoff (our SessionLifecycle, ground object). */
  prepare(): void;
  /** CPlayerModule::SaveToServer(false). */
  save(): void;
  /** RequestLogOff's AddTextToScroll(…, 0, true, 0): a plain type-0 chat line. */
  chatLine(text: string): void;
  /** Proto_UI::LogOffCharacter (CharacterLogOff 0xF653). */
  send(): void;
  /** logOffRequested / logOffRequestTime (the world fade timer). */
  requested(): void;
  /** ACCWeenieObject::prevRequest != IR_NONE: an inventory request awaits its reply. */
  requestPending?: boolean;
  /** CPlayerSystem::loggingOff = true: RequestLogOff waits for the reply (DeferredLogOff). */
  defer?(): void;
}

/** RequestLogOff's half of the deps (what the deferred request needs later). */
export type RequestLogOffDeps = Pick<ConfirmedLogoutDeps, 'prepare' | 'chatLine' | 'send' | 'requested'>;

/**
 * CPlayerSystem::RequestLogOff @ 00562dd0: the "Logging off..." chat line,
 * Proto_UI::LogOffCharacter and the world-fade timer.
 */
export function requestLogOff(d: RequestLogOffDeps): void {
  d.prepare();
  d.chatLine(LOGGING_OFF_TEXT);
  d.send();
  d.requested();
}

/**
 * CPlayerSystem::loggingOff. LogOffCharacter(false) @ 00563520 with an
 * inventory request in flight (prevRequest != IR_NONE) prints "Logging
 * off..." and sets it instead of requesting; CPlayerSystem::UseTime
 * @ 00563110 (:345801) runs RequestLogOff — a second "Logging off..." line —
 * on the first pass with no request pending. The CPlayerSystem ctor clears it.
 */
export class DeferredLogOff {
  loggingOff = false;

  defer(): void {
    this.loggingOff = true;
  }

  /** UseTime's check: true exactly once, when the latch is set and no request is pending. */
  poll(requestPending: boolean): boolean {
    if (!this.loggingOff || requestPending) return false;
    this.loggingOff = false;
    return true;
  }

  cancel(): void {
    this.loggingOff = false;
  }
}

/**
 * gmGamePlayUI::UseTime's confirmed, non-quit branch: the mid-air refusal,
 * else LogOffCharacter(false) → RequestLogOff. Returns true when the logoff
 * was sent. A refusal latches nothing (m_endingSession = false), so the next
 * attempt is judged afresh.
 */
export function endCharacterSessionConfirmed(d: ConfirmedLogoutDeps): boolean {
  if (!d.onGround) {
    d.spew(LOG_OFF_MID_AIR_TEXT);
    return false;
  }
  if (d.requestPending) {
    // LogOffCharacter(false): SaveToServer, then the line and the latch;
    // RequestLogOff follows once the request is answered (DeferredLogOff).
    d.save();
    d.chatLine(LOGGING_OFF_TEXT);
    d.defer?.();
    return false;
  }
  d.prepare();
  d.save();
  d.chatLine(LOGGING_OFF_TEXT);
  d.send();
  d.requested();
  return true;
}
