/**
 * ConnectionNotices — how the retail client reports a lost connection, a
 * CharacterError and a client-side connection failure (CORE.17.k.b).
 *
 * None of these is a chat line. Decompiled EoL client
 * (reference/client-eol/decomp/acclient-decompiled.c):
 *
 *  - **Lost connection → the Disconnected SCREEN.** `gmUIFlow::RecvNotice_ServerDied`
 *    @ 0047a9a0 builds a StringInfo for `compute_str_hash("ID_NetErr_ConnectionLost")`
 *    in table enum 0x10000002 and, unless the flow is already in or headed for
 *    UI mode 0x10000002, calls `UIFlow::QueueUIModeWithError(0x10000002, text)`
 *    @ 004793f0 (vtable +0x20 — a UI MODE switch, not a message box). Mode
 *    0x10000002 is registered at `gmDisconnectedUI::Register(0x10000002)`
 *    (the mode table @ 125554–125561: patch 0x10000003, intro 0x10000001,
 *    charactermanagement 0x1000000a, gameplay 0x10000008, epilogue 0x10000009,
 *    disconnected 0x10000002, chargen 0x1000000b, credits 0x10000005).
 *    `UIFlow::UseNewMode` @ 004796a0 destroys the current framework, creates
 *    the new one and hands it the error text through vtable +0x3c =
 *    `gmDisconnectedUI::SetErrorMsg` @ 004e99f0 → `UIElement_Text::SetStringInfo`
 *    on child 0x10000417. The screen is UILAYOUT enum 0x10000003 → layout
 *    0x21000002 (`gmDisconnectedUI::gmDisconnectedUI` @ 004e9a10:
 *    CreateAndAddRootElement(0x10000003, 0x10000416)): the 800x600 backdrop
 *    0x06005d3f, a 290x205 plate 0x10000333 at (430,115) (media 0x06004cc0,
 *    base 0x21000042:0x100002b0), the text 0x10000417 at (15,15) 260x126 and
 *    the 100x32 button 0x10000418 at (95,158) labelled string 105320788
 *    "Quit Game" (table 0x23000002). `ListenToElementMessage` @ 004e99c0:
 *    the button's click (message 1) queues mode 0x10000009 = gmEpilogueUI,
 *    whose ctor @ 004e9b00 logs the character off and whose element message
 *    0x10000002 calls `Device::Done` — the client exits. Who raises ServerDied:
 *    `ClientNet::RemoveConnection` @ 005453c0 (a live recipient dropped and no
 *    log-off was sent), `ClientNet::ProcessOptionalHeader` @ 005451a0 (a
 *    NetError optional header outside the logon context) and
 *    `CPlayerSystem::UseTime` @ 00563110 (log-on request unanswered for
 *    REQUEST_TIMEOUT, or every CHECK_LINK_STATUS_INTERVAL: DISCONNECT_TIME <
 *    seconds since the last packet, or the LinkStatusHolder no longer
 *    connected — .rdata doubles 0x7cc5b8 = 110.0, 0x7cc540 = 4.0,
 *    0x7cc5c8 = 40.0).
 *
 *  - **CharacterError → the Disconnected screen OR a char-select dialog.**
 *    `gmUIFlow::RecvNotice_CharacterError` @ 0047a7c0 tokenizes
 *    `ID_CHAR_ERROR_*` (table enum 0x10000002 → table 0x23000002) and queues
 *    mode 0x10000002 (Disconnected screen) for LOGON, ACCOUNT_LOGON,
 *    SERVER_CRASH / ACCOUNT_IN_USE, ACCOUNT_INVALID, ACCOUNT_DOESNT_EXIST,
 *    ENTER_GAME_PLAYER_ACCOUNT_MISSING, LOGON_SERVER_FULL and
 *    SUBSCRIPTION_EXPIRED; every other listed code queues mode 0x1000000a
 *    (gmCharacterManagementUI) with the text, which `SetErrorMsg` @ 004ed430
 *    turns into `DialogFactory::MakeDialog` with property 0x8e = 3: the
 *    OK message dialog (`DialogFactory::CreateDialog_` @ 00477ad0 case 3 →
 *    element 0x24 / type 0x17 of template layout 0x2100003C: 400x95 plate,
 *    text 0x3e at (15,15) 370 wide, one 80x32 "OK" button 0x26 at x=160 in
 *    the row 0x10000338 at y=48; label string 228229507 "OK"). The switch's
 *    `default:` shows nothing.
 *
 *  - **Client-side connection failures → a modal error box.** `ClientNet`
 *    ends its logon state machine with an `ID_ConnectionError_*` /
 *    `ID_NetError_*` NetError (table enum 8 → table 0x23000010): e.g.
 *    `LogonUseTime` @ 00544a10 → `ID_ConnectionError_ClientTimedOutServer`
 *    after 20 unanswered login requests, `InitAddresses` → CantSocket /
 *    CantBind / BadServerAddress. `Client::Init` (decomp :19694–19730) reads
 *    the final error and calls `PopupError` @ 00554c40 → a native
 *    `MessageBoxW`; `Client::Run` @ 004117b0 then returns without entering
 *    the loop — the client exits after the box is dismissed.
 *
 * ACE never sends the NetError optional headers (it only honours
 * PacketHeaderFlags.NetErrorDisconnect on receive, NetworkSession.cs:325), so
 * the 0x23000010 family only ever arises client-side for us too.
 */

import { acStringHash, getString } from '@ac/dat-parser/file-types/LayoutDesc.js';
import { CharacterError, characterErrorMessage } from '@ac/shared';

/** CPlayerSystem::UseTime — seconds since the last packet before ServerDied (0x7cc5c8). */
export const DISCONNECT_TIME_S = 40.0;
/** CPlayerSystem::UseTime — unanswered log-on request budget before ServerDied (0x7cc5b8). */
export const REQUEST_TIMEOUT_S = 110.0;

/** String table the ID_NetErr_ConnectionLost / ID_CHAR_ERROR_* tokens live in (table enum 0x10000002). */
export const CHAR_ERROR_STRING_TABLE = 0x23000002;
/** String table the ID_ConnectionError_* / ID_NetError_* tokens live in (table enum 8). */
export const NET_ERROR_STRING_TABLE = 0x23000010;

/** UILAYOUT enum 0x10000003 → the Disconnected screen. */
export const DISCONNECTED_LAYOUT_ID = 0x21000002;
export const DISCONNECTED_ROOT_ELEMENT = 0x10000416;
export const DISCONNECTED_PLATE_ELEMENT = 0x10000333;
export const DISCONNECTED_TEXT_ELEMENT = 0x10000417;
export const DISCONNECTED_BUTTON_ELEMENT = 0x10000418;
/** The backdrop 0x10000416 carries (800x600 JPEG). */
export const DISCONNECTED_BACKDROP_TEXTURE = 0x06005d3f;
/** Button label string of 0x10000418 (p23). */
export const DISCONNECTED_BUTTON_STRING_ID = 105320788;
/** "OK" — label string of the message dialog's button 0x26 (p23). */
export const MESSAGE_DIALOG_OK_STRING_ID = 228229507;

/**
 * The resolved UIElement_Text style of one text element: font (p26), colour
 * (p27), CalcJustification p20/p21, and CORE.17.k.b.a's outline pair — p33
 * (`UIElement_Text::OnSetAttribute @ 0046a640` case 0x21 → `SetOutline @
 * 00466630`, bitfield 0x10) with p34 (case 0x22 → `m_curOutlineColor`,
 * default black). The instance's own properties override its template's.
 */
export interface TextTemplate {
  readonly font: number;
  readonly colorArgb: number;
  readonly hJustify: number;
  readonly vJustify: number;
  readonly outline: boolean;
  readonly outlineColorArgb: number;
}

/** `m_curOutlineColor` when p33 is set without a p34 (RGBAColor_Black). */
export const DEFAULT_OUTLINE_COLOR_ARGB = 0xFF000000;

/**
 * The 0x2100003f:0x10000371 text template itself: font 0x40000001 (18px),
 * colour 0xFFCCCCCC, p20 = 2 / p21 = 4 (near-edge both ways = top-left), no
 * outline. Every DialogFactory dialog text region 0x3e bases on it and
 * overrides it — see DIALOG_TEXT_TEMPLATE.
 */
export const DIALOG_TEXT_BASE_TEMPLATE: TextTemplate = Object.freeze({
  font: 0x40000001, colorArgb: 0xFFCCCCCC, hJustify: 2, vJustify: 4, outline: false, outlineColorArgb: DEFAULT_OUTLINE_COLOR_ARGB,
});

/**
 * The DialogFactory text region 0x3e as instantiated: all six dialog
 * elements of 0x2100003C (0x15 confirmation, 0x1b, 0x1f, 0x24 the type-3 OK
 * message, 0x2c, 0x31) carry the same 0x3e — base 0x2100003f:0x10000371
 * (font 0x40000001) with their OWN p27 0xFFFFF7CC (cream), p20 = 1 (centred)
 * / p21 = 4 (top), p33 = true and p34 = 0xFF110F07 (the near-black outline).
 * CORE.17.k.b had rendered the base template's grey top-left; CORE.17.k.b.a
 * corrects it to the instance.
 */
export const DIALOG_TEXT_TEMPLATE: TextTemplate = Object.freeze({
  font: 0x40000001, colorArgb: 0xFFFFF7CC, hJustify: 1, vJustify: 4, outline: true, outlineColorArgb: 0xFF110F07,
});

/**
 * The Disconnected screen's text 0x10000417: base 0x2100003f:0x10000377
 * (font 0x40000001, white, p20 = 1 / p21 = 1 — centred both ways in its
 * 260x126 cell) with its own p27 0xFFFFF7CC, p33 = true and p34 0xFF110F07.
 */
export const DISCONNECTED_TEXT_TEMPLATE: TextTemplate = Object.freeze({
  font: 0x40000001, colorArgb: 0xFFFFF7CC, hJustify: 1, vJustify: 1, outline: true, outlineColorArgb: 0xFF110F07,
});

export const CONNECTION_LOST_TOKEN = 'ID_NetErr_ConnectionLost';
/** compute_str_hash("ID_NetErr_ConnectionLost") = 0x646eb64. */
export const CONNECTION_LOST_STRING_ID = acStringHash(CONNECTION_LOST_TOKEN);

/** Which retail surface a notice lands on. */
export type ErrorSurface = 'disconnected' | 'dialog' | 'none';

export interface ConnectionNotice {
  readonly surface: ErrorSurface;
  /** The `ID_*` token the decompiled client tokenizes. */
  readonly token: string;
  /** compute_str_hash(token) — the DAT string id. */
  readonly stringId: number;
  /** Text to show: the DAT string when the table is registered, else the documented fallback. */
  readonly text: string;
}

/** Text tables the DAT gives for each token — the fallback when the string tables are not loaded. */
const NET_ERROR_FALLBACK: Readonly<Record<string, string>> = Object.freeze({
  ID_ConnectionError_Generic: 'There was an error with this connection',
  ID_ConnectionError_ServerFull: 'Server Full',
  ID_ConnectionError_SecondLogon: 'Connection prempted by another connection attempt',
  ID_ConnectionError_BadCryptoKey: 'Invalid or corrupted authentication',
  ID_ConnectionError_NoLogonServer: 'There is no logon server available for your account.',
  ID_ConnectionError_RunningSpeedhack: 'Connection closed because use of a speed-altering program was detected',
  ID_ConnectionError_ClientLogOnFailed: 'Client logon failed',
  ID_ConnectionError_NetVersionMismatch: 'You do not have the current version of the client installed.',
  ID_ConnectionError_LogonServerMigrated: 'Logon was aborted by the server.\nPlease try again.',
  ID_ConnectionError_ServerTimedOutClient: 'Server timed out the connection',
  ID_ConnectionError_ClientTimedOutServer: 'Client timed out the connection',
  ID_ConnectionError_PlayerAlreadyLoggedOn: 'Player already logged on',
  ID_ConnectionError_ServerClosedConnection: 'Server has closed this connection',
  ID_ConnectionError_InsufficientPriveledge: 'Your account has insufficient priveleges to continue',
  ID_ConnectionError_AccountAuthenticationFailed: 'Access Denied.',
  ID_NetError_CantBind: "Can't bind local socket.  Is another client running?",
  ID_NetError_CantSocket: "Couldn't create local socket.  Make sure you have a working network.",
  ID_NetError_CantCrypto: 'Couldn\'t initialize crypto API. Error ',
  ID_NetError_BadServerAddress: 'Invalid server address',
  ID_NetError_AbortedHandshake: 'Connection attempt was aborted by the user',
});

/** Every ClientNet NetError token (table 0x23000010), for audits and tests. */
export const NET_ERROR_TOKENS: readonly string[] = Object.freeze(Object.keys(NET_ERROR_FALLBACK));

/**
 * The NetError our own connection layer raises for each failure it can
 * detect. The WebSocket to the bridge is the browser client's local socket
 * layer, so a socket that never opens is retail's `ID_NetError_CantSocket`;
 * a bridge that answers but an ACE that never replies to the LoginRequest
 * is `ClientNet::LogonUseTime`'s exhausted request budget.
 */
export const NET_ERROR_FOR_EVENT = Object.freeze({
  /** WebSocket error before the socket ever opened. */
  socketNeverOpened: 'ID_NetError_CantSocket',
  /** LoginRequest retries exhausted with no ConnectRequest from the server. */
  loginTimedOut: 'ID_ConnectionError_ClientTimedOutServer',
  /** Auto-reconnect budget exhausted. */
  reconnectExhausted: 'ID_ConnectionError_ClientTimedOutServer',
});

/** "The connection to the server has been lost!" — string 0x646eb64 in table 0x23000002. */
export function connectionLostText(): string {
  return getString(CONNECTION_LOST_STRING_ID) ?? 'The connection to the server has been lost!';
}

/** The ID_ConnectionError_* / ID_NetError_* text for a token (DAT first, documented fallback second). */
export function netErrorNotice(token: string): ConnectionNotice {
  const stringId = acStringHash(token);
  const text = getString(stringId) ?? NET_ERROR_FALLBACK[token] ?? NET_ERROR_FALLBACK.ID_ConnectionError_Generic;
  // Retail: PopupError → MessageBoxW, then Client::Run returns. Ours renders
  // it as the DialogFactory OK message dialog over the connecting screen.
  return Object.freeze({ surface: 'dialog', token, stringId, text });
}

interface CharErrorRow { readonly token: string; readonly surface: ErrorSurface }

/** gmUIFlow::RecvNotice_CharacterError @ 0047a7c0 — the switch, case by case. */
const CHAR_ERROR_ROWS: ReadonlyMap<number, CharErrorRow> = new Map<number, CharErrorRow>([
  [CharacterError.Logon, { token: 'ID_CHAR_ERROR_LOGON', surface: 'disconnected' }],
  [CharacterError.AccountLogin, { token: 'ID_CHAR_ERROR_ACCOUNT_LOGON', surface: 'disconnected' }],
  [CharacterError.ServerCrash1, { token: 'ID_CHAR_ERROR_SERVER_CRASH', surface: 'disconnected' }],
  [CharacterError.Logoff, { token: 'ID_CHAR_ERROR_LOGOFF', surface: 'dialog' }],
  [CharacterError.Delete, { token: 'ID_CHAR_ERROR_DELETE', surface: 'dialog' }],
  // CHAR_ERROR_ACCOUNT_IN_USE (0x8) shares the SERVER_CRASH case.
  [CharacterError.ServerCrash2, { token: 'ID_CHAR_ERROR_SERVER_CRASH', surface: 'disconnected' }],
  [CharacterError.AccountInvalid, { token: 'ID_CHAR_ERROR_ACCOUNT_INVALID', surface: 'disconnected' }],
  [CharacterError.AccountDoesntExist, { token: 'ID_CHAR_ERROR_ACCOUNT_DOESNT_EXIST', surface: 'disconnected' }],
  [CharacterError.EnterGameGeneric, { token: 'ID_CHAR_ERROR_ENTER_GAME_GENERIC', surface: 'dialog' }],
  [CharacterError.EnterGameStressAccount, { token: 'ID_CHAR_ERROR_ENTER_GAME_STRESS_ACCOUNT', surface: 'dialog' }],
  [CharacterError.EnterGameCharacterInWorld, { token: 'ID_CHAR_ERROR_ENTER_GAME_CHARACTER_IN_WORLD', surface: 'dialog' }],
  [CharacterError.EnterGamePlayerAccountMissing, { token: 'ID_CHAR_ERROR_ENTER_GAME_PLAYER_ACCOUNT_MISSING', surface: 'disconnected' }],
  [CharacterError.EnterGameCharacterNotOwned, { token: 'ID_CHAR_ERROR_ENTER_GAME_CHARACTER_NOT_OWNED', surface: 'dialog' }],
  [CharacterError.EnterGameCharacterInWorldServer, { token: 'ID_CHAR_ERROR_ENTER_GAME_CHARACTER_IN_WORLD_SERVER', surface: 'dialog' }],
  [CharacterError.EnterGameOldCharacter, { token: 'ID_CHAR_ERROR_ENTER_GAME_OLD_CHARACTER', surface: 'dialog' }],
  [CharacterError.EnterGameCorruptCharacter, { token: 'ID_CHAR_ERROR_ENTER_GAME_CORRUPT_CHARACTER', surface: 'dialog' }],
  [CharacterError.EnterGameStartServerDown, { token: 'ID_CHAR_ERROR_ENTER_GAME_START_SERVER_DOWN', surface: 'dialog' }],
  [CharacterError.EnterGameCouldntPlaceCharacter, { token: 'ID_CHAR_ERROR_ENTER_GAME_COULDNT_PLACE_CHARACTER', surface: 'dialog' }],
  [CharacterError.LogonServerFull, { token: 'ID_CHAR_ERROR_LOGON_SERVER_FULL', surface: 'disconnected' }],
  [CharacterError.EnterGameCharacterLocked, { token: 'ID_CHAR_ERROR_ENTER_GAME_CHARACTER_LOCKED', surface: 'dialog' }],
  [CharacterError.SubscriptionExpired, { token: 'ID_CHAR_ERROR_SUBSCRIPTION_EXPIRED', surface: 'disconnected' }],
]);

/**
 * Where a CharacterError code lands and what it says. Codes outside the
 * retail switch (its `default:` label) show nothing, like retail. The DAT
 * text is used verbatim — including the EoL quirk that
 * ID_CHAR_ERROR_ENTER_GAME_GENERIC's entry reads
 * "ID_CHAR_ERROR_ENTER_GAME_OLD_CHARACTER" and the OLD_CHARACTER token has
 * no entry at all; when the string tables are not loaded the ACE wording
 * (`characterErrorMessage`, the same retail resource text) stands in.
 */
export function characterErrorNotice(code: number): ConnectionNotice {
  const row = CHAR_ERROR_ROWS.get(code);
  if (!row) {
    return Object.freeze({ surface: 'none', token: '', stringId: 0, text: characterErrorMessage(code) });
  }
  const stringId = acStringHash(row.token);
  const text = getString(stringId) ?? characterErrorMessage(code);
  return Object.freeze({ surface: row.surface, token: row.token, stringId, text });
}

/** Every CharacterError code the retail switch handles, for audits and tests. */
export function characterErrorCodesHandled(): number[] {
  return [...CHAR_ERROR_ROWS.keys()];
}

/**
 * CPlayerSystem::UseTime's ServerDied trigger for one link sample:
 * `DISCONNECT_TIME < seconds since the last packet || !connected`.
 */
export function linkSampleIsDead(sample: { connected: boolean; secondsSinceLastPacket: number }): boolean {
  return !sample.connected || sample.secondsSinceLastPacket > DISCONNECT_TIME_S;
}
