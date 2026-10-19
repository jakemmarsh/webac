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
 *  - **Server NetError during logon → the same error box.** A NetError
 *    optional header (flag 0x00100000, `NetError::UnPack @ 004114a0`: u32
 *    string id, u32 string-table enum) inside the logon context goes to
 *    `ClientNet::EndState @ 00543380` (`ProcessOptionalHeader @ 005451a0`),
 *    which fails the logon with that error, and `Client::Init` shows its
 *    StringInfo text through PopupError like the client-side ones. Outside
 *    the logon context it is LogOffServer + ServerDied.
 *
 * ACE never sends the NetError optional headers (it only honours
 * PacketHeaderFlags.NetErrorDisconnect on receive, NetworkSession.cs:318).
 * GDLE / ClassicDereth do: a refused LoginRequest is answered with
 * `CNetwork::SendConnectLoginFailure` (reference/classic/ClassicDereth/
 * Source/Network.cpp: BT_NETERROR, {error, ST_SERVER_ERRORS = 8}), the
 * error one of STR_LOGIN_FAILED 0x04DF9C54, STR_LOGIN_SERVER_FULL,
 * STR_LOGIN_CLIENT_VERSION, STR_LOGIN_ACCOUNT_ONLINE, STR_LOGIN_INVALID_AUTH
 * (NetworkDefs.h). Each is the compute_str_hash of an ID_ConnectionError_*
 * token in table 0x23000010 — 0x04DF9C54 = "ID_ConnectionError_ClientLogOnFailed"
 * = "Client logon failed" — so table enum 8 is that table.
 */

import { acStringHash, getString, getStringFromTable } from '@ac/dat-parser/file-types/LayoutDesc.js';
import { CharacterError, characterErrorMessage, playerText, withNextStep } from '@ac/shared';
import { silenceIsOwnStall, type BridgeRefusal, type LinkSample } from '@ac/network';

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
/** 0x10000417's DAT size: retail's fixed text box on the Disconnected plate. */
export const DISCONNECTED_TEXT_WIDTH = 260;
export const DISCONNECTED_TEXT_HEIGHT = 126;

/**
 * Whether the Disconnected text needs its scrollbar. 0x10000417 is a
 * UIElement_Text, which is a UIElement_Scrollable (its vftable 'for
 * UIElement_Scrollable'; InqScrollDelta, ScrollToPosition, ScrollPage): text
 * taller than the box scrolls inside it, and the visible bar is a linked
 * UIElement_Scrollbar (p0x72, UIElement_Scrollable::OnSetAttribute @
 * 00474630) whose p121 hides it while the text fits (the chargen framed
 * texts' 0x100002e7). The DAT gives 0x10000417 no bar because every retail
 * text fit in 260x126; a server's own boot or ban reason (plus our next-step
 * line) does not, and the box clipped it mid-sentence. Text that fits keeps
 * retail's exact cell; taller text gets the HUD scrollbar at the box's right.
 */
export function disconnectedTextScrolls(contentHeight: number): boolean {
  return contentHeight > DISCONNECTED_TEXT_HEIGHT;
}
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

/** Pick another world, or wait: the next step after a failure the world itself caused. */
export const RETRY_OR_OTHER_WORLD_HINT = 'Try again in a minute, or pick another world.';
/** webAC players can't install a client: a version refusal is fixed by reloading the page. */
export const RELOAD_FOR_LATEST_HINT = 'Reload the page to get the latest webAC.';
/** An account already in use elsewhere. */
export const ACCOUNT_IN_USE_HINT = 'Close any other window logged in to this account, or wait a minute and try again.';

/**
 * The plain next-step sentence each NetError gets under its retail text
 * (launcher/worldDirectory.ts loginFailureText adds it: retail text, one
 * blank line, the hint). Retail's own texts were written for a client a
 * player installed and restarted ("You do not have the current version of
 * the client installed.", "Server Full") and stop there. Tokens whose retail
 * text already says what to do (CantSocket, CantBind, LogonServerMigrated)
 * and ClientLogOnFailed (its hints depend on the world: loginFailureText)
 * are absent.
 */
export const NET_ERROR_NEXT_STEP: Readonly<Record<string, string>> = Object.freeze({
  ID_ConnectionError_Generic: RETRY_OR_OTHER_WORLD_HINT,
  ID_ConnectionError_ServerFull: 'Wait a few minutes and try again, or pick another world.',
  ID_ConnectionError_SecondLogon: ACCOUNT_IN_USE_HINT,
  ID_ConnectionError_BadCryptoKey: 'Reload the page and try again.',
  ID_ConnectionError_NoLogonServer: RETRY_OR_OTHER_WORLD_HINT,
  ID_ConnectionError_NetVersionMismatch: RELOAD_FOR_LATEST_HINT,
  ID_ConnectionError_ServerTimedOutClient: RETRY_OR_OTHER_WORLD_HINT,
  ID_ConnectionError_ClientTimedOutServer: RETRY_OR_OTHER_WORLD_HINT,
  ID_ConnectionError_PlayerAlreadyLoggedOn: ACCOUNT_IN_USE_HINT,
  ID_ConnectionError_ServerClosedConnection: RETRY_OR_OTHER_WORLD_HINT,
  ID_ConnectionError_InsufficientPriveledge: "This account can't log in here; ask this server's operators.",
  ID_ConnectionError_AccountAuthenticationFailed: 'Check the account name and password, then try again.',
});

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
  const text = playerText(getStringFromTable(NET_ERROR_STRING_TABLE, stringId) ?? getString(stringId),
    NET_ERROR_FALLBACK[token] ?? NET_ERROR_FALLBACK.ID_ConnectionError_Generic);
  // Retail: PopupError → MessageBoxW, then Client::Run returns. Ours renders
  // it as the DialogFactory OK message dialog over the connecting screen.
  return Object.freeze({ surface: 'dialog', token, stringId, text });
}

/**
 * BUG.multi-tab-login-pingpong — the bridge refused the connection and said
 * why with its close code (@ac/network BridgeRefusal). Retail had no bridge
 * and no per-address cap, so there is no DAT string for it; the text is
 * plain English, and the token is ours (telemetry reads it). Shown as the
 * same OK dialog as a client-side NetError.
 */
export const BRIDGE_IP_CAP_TOKEN = 'BRIDGE_IP_CAP';
export const BRIDGE_IP_CAP_TEXT = 'Too many game windows are open from your network. Close some webAC tabs and try again.';

/** A world whose sessions each get their own address from the bridge has none free (BRIDGE_CLOSE_WORLD_FULL). */
export const BRIDGE_WORLD_FULL_TOKEN = 'BRIDGE_WORLD_FULL';
export const BRIDGE_WORLD_FULL_TEXT = 'This server is full for webAC players right now. Try again in a few minutes.';
/** That world's new-account limit per network, which the bridge applies (BRIDGE_CLOSE_NEW_ACCOUNT_CAP). */
export const BRIDGE_NEW_ACCOUNT_CAP_TOKEN = 'BRIDGE_NEW_ACCOUNT_CAP';
export const BRIDGE_NEW_ACCOUNT_CAP_TEXT = 'This server limits how many new accounts one network can create, and yours has reached it. '
  + 'Log in with an account you already made here.';

/** No bridge address may still create an account on that world (BRIDGE_CLOSE_NEW_ACCOUNT_UNAVAILABLE). */
export const BRIDGE_NEW_ACCOUNT_UNAVAILABLE_TOKEN = 'BRIDGE_NEW_ACCOUNT_UNAVAILABLE';
export const BRIDGE_NEW_ACCOUNT_UNAVAILABLE_TEXT = "New accounts can't be made through webAC on this server right now. "
  + 'Try again later, or log in with an existing account.';

export function bridgeRefusalNotice(refusal: BridgeRefusal): ConnectionNotice {
  switch (refusal) {
    case 'new_account_unavailable':
      return Object.freeze({ surface: 'dialog', token: BRIDGE_NEW_ACCOUNT_UNAVAILABLE_TOKEN, stringId: 0, text: BRIDGE_NEW_ACCOUNT_UNAVAILABLE_TEXT });
    case 'world_full':
      return Object.freeze({ surface: 'dialog', token: BRIDGE_WORLD_FULL_TOKEN, stringId: 0, text: BRIDGE_WORLD_FULL_TEXT });
    case 'new_account_cap':
      return Object.freeze({ surface: 'dialog', token: BRIDGE_NEW_ACCOUNT_CAP_TOKEN, stringId: 0, text: BRIDGE_NEW_ACCOUNT_CAP_TEXT });
    case 'ip_cap':
    default:
      return Object.freeze({ surface: 'dialog', token: BRIDGE_IP_CAP_TOKEN, stringId: 0, text: BRIDGE_IP_CAP_TEXT });
  }
}

/**
 * The OK-dialog notice for a connection 'error' event that ended the connect
 * (main.ts raiseNetError): the bridge's refusal (BUG.multi-tab-login-pingpong),
 * a server NetError that ended the logon, or a client-side NetError. null for
 * any other error (a CharacterError, a WebSocket error on a live socket).
 */
export function connectionFailureNotice(event: {
  bridgeRefusal?: BridgeRefusal;
  serverNetError?: { stringId: number; tableId: number };
  netErrorId?: string;
}): ConnectionNotice | null {
  if (event.bridgeRefusal) return bridgeRefusalNotice(event.bridgeRefusal);
  if (event.serverNetError) return serverNetErrorNotice(event.serverNetError.stringId, event.serverNetError.tableId);
  if (event.netErrorId) return netErrorNotice(event.netErrorId);
  return null;
}

/**
 * StringInfo table enums a server NetError names, and the string table each
 * resolves to: enum 8 (GDLE's ST_SERVER_ERRORS) holds the
 * ID_ConnectionError_* hashes, which live only in 0x23000010; enum
 * 0x10000002 is the ID_CHAR_ERROR_* / ID_NetErr_* table.
 */
export const NET_ERROR_TABLE_ENUMS: ReadonlyMap<number, number> = new Map([
  [8, NET_ERROR_STRING_TABLE],
  [0x10000002, CHAR_ERROR_STRING_TABLE],
]);

/** compute_str_hash(token) → token, for every ClientNet NetError token. */
const NET_ERROR_TOKEN_BY_ID: ReadonlyMap<number, string> = new Map(
  NET_ERROR_TOKENS.map((t) => [acStringHash(t), t] as [number, string]),
);

/**
 * The text of a NetError the SERVER sent (string id + table enum, as
 * `NetError::UnPack` reads them): the table-bound DAT string first, then
 * the documented wording of the ID_ConnectionError_* token that hashes to
 * the id. An id no table resolves leaves retail's StringInfo empty
 * (`StringTable::GetString @ 004300d0` → gsMissingString), which would be a
 * blank box; ours says ID_ConnectionError_Generic's "There was an error
 * with this connection" instead, the same fallback as an unknown token.
 */
export function serverNetErrorNotice(stringId: number, tableEnum: number): ConnectionNotice {
  const table = NET_ERROR_TABLE_ENUMS.get(tableEnum);
  const token = NET_ERROR_TOKEN_BY_ID.get(stringId) ?? '';
  const text = playerText((table !== undefined ? getStringFromTable(table, stringId) : null) ?? getString(stringId),
    (token ? NET_ERROR_FALLBACK[token] : undefined) ?? NET_ERROR_FALLBACK.ID_ConnectionError_Generic);
  return Object.freeze({ surface: 'dialog', token, stringId, text });
}

/**
 * The failures a fresh account on a register-first world produces: a world
 * that answers an unknown account with silence times the login out
 * (ClientTimedOutServer); GDLE / ClassicDereth refuse it with the
 * STR_LOGIN_FAILED NetError (ClientLogOnFailed). Both get the world's
 * registration hint before entering the world.
 */
export const LOGIN_REFUSED_TOKENS: ReadonlySet<string> = new Set([
  'ID_ConnectionError_ClientTimedOutServer',
  'ID_ConnectionError_ClientLogOnFailed',
]);

interface CharErrorRow { readonly token: string; readonly surface: ErrorSurface; readonly nextStep?: string }

/** Pick another character: the next step for a char-select refusal about the chosen one. */
export const PICK_ANOTHER_CHARACTER_HINT = 'Pick another character.';

/** gmUIFlow::RecvNotice_CharacterError @ 0047a7c0 — the switch, case by case. */
const CHAR_ERROR_ROWS: ReadonlyMap<number, CharErrorRow> = new Map<number, CharErrorRow>([
  [CharacterError.Logon, { token: 'ID_CHAR_ERROR_LOGON', surface: 'disconnected', nextStep: ACCOUNT_IN_USE_HINT }],
  [CharacterError.AccountLogin, { token: 'ID_CHAR_ERROR_ACCOUNT_LOGON', surface: 'disconnected' }],
  [CharacterError.ServerCrash1, { token: 'ID_CHAR_ERROR_SERVER_CRASH', surface: 'disconnected' }],
  [CharacterError.Logoff, { token: 'ID_CHAR_ERROR_LOGOFF', surface: 'dialog', nextStep: 'Try again in a minute.' }],
  [CharacterError.Delete, { token: 'ID_CHAR_ERROR_DELETE', surface: 'dialog', nextStep: 'Try again in a minute.' }],
  // CHAR_ERROR_ACCOUNT_IN_USE (0x8) shares the SERVER_CRASH case.
  [CharacterError.ServerCrash2, { token: 'ID_CHAR_ERROR_SERVER_CRASH', surface: 'disconnected' }],
  [CharacterError.AccountInvalid, { token: 'ID_CHAR_ERROR_ACCOUNT_INVALID', surface: 'disconnected', nextStep: 'Check the account name and password, then try again.' }],
  [CharacterError.AccountDoesntExist, { token: 'ID_CHAR_ERROR_ACCOUNT_DOESNT_EXIST', surface: 'disconnected', nextStep: "Check the account name. If this server needs an account registered first, register on its website." }],
  [CharacterError.EnterGameGeneric, { token: 'ID_CHAR_ERROR_ENTER_GAME_GENERIC', surface: 'dialog', nextStep: PICK_ANOTHER_CHARACTER_HINT }],
  [CharacterError.EnterGameStressAccount, { token: 'ID_CHAR_ERROR_ENTER_GAME_STRESS_ACCOUNT', surface: 'dialog' }],
  [CharacterError.EnterGameCharacterInWorld, { token: 'ID_CHAR_ERROR_ENTER_GAME_CHARACTER_IN_WORLD', surface: 'dialog' }],
  [CharacterError.EnterGamePlayerAccountMissing, { token: 'ID_CHAR_ERROR_ENTER_GAME_PLAYER_ACCOUNT_MISSING', surface: 'disconnected' }],
  [CharacterError.EnterGameCharacterNotOwned, { token: 'ID_CHAR_ERROR_ENTER_GAME_CHARACTER_NOT_OWNED', surface: 'dialog', nextStep: PICK_ANOTHER_CHARACTER_HINT }],
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
 * text comes first; when the string tables are not loaded, or the entry is
 * only a resource token (the EoL and Dark Majesty DATs store
 * ID_CHAR_ERROR_ENTER_GAME_GENERIC's entry as the literal
 * "ID_CHAR_ERROR_ENTER_GAME_OLD_CHARACTER", which retail drew as is), the
 * ACE wording (`characterErrorMessage`) stands in (playerText). A refusal
 * whose retail text stops short of saying what to do carries one plain
 * next-step line after a blank line (`nextStep`).
 */
export function characterErrorNotice(code: number): ConnectionNotice {
  const row = CHAR_ERROR_ROWS.get(code);
  if (!row) {
    return Object.freeze({ surface: 'none', token: '', stringId: 0, text: characterErrorMessage(code) });
  }
  const stringId = acStringHash(row.token);
  const text = withNextStep(playerText(getString(stringId), characterErrorMessage(code)), row.nextStep);
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

/**
 * NET.client-suspended-endcause — what a dead link sample (linkSampleIsDead)
 * reports: 'client_suspended' when the receiving thread's own stop (a sleeping
 * machine, a frozen worker) longer than DISCONNECT_TIME ended inside the
 * silence and the quiet since is within it, else 'link_dead'. The stop is the
 * worker's (the thread that measures receives), not the page timer's: a
 * throttled hidden page whose worker kept running heard a really silent server.
 */
export function linkDeadCause(sample: LinkSample): 'link_dead' | 'client_suspended' {
  return sample.connected && silenceIsOwnStall(sample.stall, sample.secondsSinceLastPacket * 1000, DISCONNECT_TIME_S * 1000)
    ? 'client_suspended' : 'link_dead';
}
