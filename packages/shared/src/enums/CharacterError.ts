/**
 * CharacterError — server-emitted error code on the `CharacterError`
 * (0xF659) GameMessage. Sent during the login → character-select →
 * enter-world flow when the server has to bail.
 *
 * Source: reference/ACE/Source/ACE.Server/Network/Enum/CharacterError.cs.
 * That file's xmldoc preserves the EXACT retail client text for each
 * code (the original AC executable's ID_CHAR_ERROR_* string resources).
 *
 * Wire format: uint32 at the start of the CharacterError payload.
 *
 * Values are non-contiguous — 0x02, 0x07 and 0x16 are unused, 0x04 and
 * 0x08 are both "ServerCrash" variants, 0x11 (EnterGameOldCharacter) is
 * a behavior signal with no user-visible text.
 */
export enum CharacterError {
  /** ID_CHAR_ERROR_LOGON — Cannot have two accounts logged on at the same time. */
  Logon                        = 0x00000001,
  /** ID_CHAR_ERROR_ACCOUNT_LOGON — Server could not access your account information. */
  AccountLogin                 = 0x00000003,
  /** ID_CHAR_ERROR_SERVER_CRASH — The server has disconnected. */
  ServerCrash1                 = 0x00000004,
  /** ID_CHAR_ERROR_LOGOFF — Server could not log off your character. */
  Logoff                       = 0x00000005,
  /** ID_CHAR_ERROR_DELETE — Server could not delete your character. */
  Delete                       = 0x00000006,
  /** ID_CHAR_ERROR_SERVER_CRASH (alt code) — The server has disconnected. */
  ServerCrash2                 = 0x00000008,
  /** ID_CHAR_ERROR_ACCOUNT_INVALID — The account name you specified was not valid. */
  AccountInvalid               = 0x00000009,
  /** ID_CHAR_ERROR_ACCOUNT_DOESNT_EXIST — The account you specified doesn't exist. */
  AccountDoesntExist           = 0x0000000A,
  /** ID_CHAR_ERROR_ENTER_GAME_GENERIC — Generic popup with OK button (no detailed text). */
  EnterGameGeneric             = 0x0000000B,
  /** ID_CHAR_ERROR_ENTER_GAME_STRESS_ACCOUNT — You cannot enter the game with a stress creating character. */
  EnterGameStressAccount       = 0x0000000C,
  /** ID_CHAR_ERROR_ENTER_GAME_CHARACTER_IN_WORLD — One of your characters is still in the world. */
  EnterGameCharacterInWorld    = 0x0000000D,
  /** ID_CHAR_ERROR_ENTER_GAME_PLAYER_ACCOUNT_MISSING — Server unable to find player account. */
  EnterGamePlayerAccountMissing = 0x0000000E,
  /** ID_CHAR_ERROR_ENTER_GAME_CHARACTER_NOT_OWNED — You do not own this character. */
  EnterGameCharacterNotOwned   = 0x0000000F,
  /** ID_CHAR_ERROR_ENTER_GAME_CHARACTER_IN_WORLD_SERVER — Internal server error variant. */
  EnterGameCharacterInWorldServer = 0x00000010,
  /** ID_CHAR_ERROR_ENTER_GAME_OLD_CHARACTER — Forces back to char-select (no user text). */
  EnterGameOldCharacter        = 0x00000011,
  /** ID_CHAR_ERROR_ENTER_GAME_CORRUPT_CHARACTER — Character data has been corrupted. */
  EnterGameCorruptCharacter    = 0x00000012,
  /** ID_CHAR_ERROR_ENTER_GAME_START_SERVER_DOWN — Starting server is experiencing difficulties. */
  EnterGameStartServerDown     = 0x00000013,
  /** ID_CHAR_ERROR_ENTER_GAME_COULDNT_PLACE_CHARACTER — Character couldn't be placed in the world. */
  EnterGameCouldntPlaceCharacter = 0x00000014,
  /** ID_CHAR_ERROR_LOGON_SERVER_FULL — The Asheron's Call server is full currently. */
  LogonServerFull              = 0x00000015,
  /** ID_CHAR_ERROR_ENTER_GAME_CHARACTER_LOCKED — A save of this character is still in progress. */
  EnterGameCharacterLocked     = 0x00000017,
  /** ID_CHAR_ERROR_SUBSCRIPTION_EXPIRED — Your subscription has expired. */
  SubscriptionExpired          = 0x00000018,
}

/**
 * Map a CharacterError code to the canonical retail-client text. Wording
 * is sourced from ACE CharacterError.cs xmldoc which preserves the
 * original AC executable's ID_CHAR_ERROR_* string-resource text.
 *
 * Returns a generic fallback for unmapped codes so the player always sees
 * SOMETHING — the original retail client did the same. EnterGameOldCharacter
 * (0x11) and EnterGameGeneric (0x0B) are explicitly fall-through because the
 * retail behavior is a generic OK popup with no detailed message; we
 * approximate with a short generic.
 */
export function characterErrorMessage(code: number): string {
  switch (code) {
    case CharacterError.Logon:
      return 'Cannot have two accounts logged on at the same time.';
    case CharacterError.AccountLogin:
      return 'Server could not access your account information. Please try again in a few minutes.';
    case CharacterError.ServerCrash1:
    case CharacterError.ServerCrash2:
      return 'The server has disconnected. Please try again in a few minutes.';
    case CharacterError.Logoff:
      return 'Server could not log off your character.';
    case CharacterError.Delete:
      return 'Server could not delete your character.';
    case CharacterError.AccountInvalid:
      return 'The account name you specified was not valid.';
    case CharacterError.AccountDoesntExist:
      return "The account you specified doesn't exist.";
    case CharacterError.EnterGameStressAccount:
      return 'You cannot enter the game with a stress creating character.';
    case CharacterError.EnterGameCharacterInWorld:
      return 'One of your characters is still in the world. Please try again in a few minutes.';
    case CharacterError.EnterGamePlayerAccountMissing:
      return 'Server unable to find player account. Please try again later.';
    case CharacterError.EnterGameCharacterNotOwned:
      return 'You do not own this character.';
    case CharacterError.EnterGameCharacterInWorldServer:
      return 'One of your characters is currently in the world. Please try again later. This is likely an internal server error.';
    case CharacterError.EnterGameCorruptCharacter:
      return "This character's data has been corrupted. Please delete it and create a new character.";
    case CharacterError.EnterGameStartServerDown:
      return "This character's starting server is experiencing difficulties. Please try again in a few minutes.";
    case CharacterError.EnterGameCouldntPlaceCharacter:
      return "This character couldn't be placed in the world right now. Please try again in a few minutes.";
    case CharacterError.LogonServerFull:
      return "Sorry, but the Asheron's Call server is full currently. Please try again later.";
    case CharacterError.EnterGameCharacterLocked:
      return 'A save of this character is still in progress. Please try again later.';
    case CharacterError.SubscriptionExpired:
      return 'Your subscription to this game has expired.';
    case CharacterError.EnterGameGeneric:
    case CharacterError.EnterGameOldCharacter:
      return 'Could not enter the game. Please try again.';
    default:
      return `Character error code 0x${code.toString(16).toUpperCase()}`;
  }
}
