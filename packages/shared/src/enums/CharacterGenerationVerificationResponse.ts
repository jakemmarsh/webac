/**
 * CharacterGenerationVerificationResponse — server's response code on
 * CharacterCreateResponse (0xF643) GameMessage.
 *
 * Source: reference/ACE/Source/ACE.Server/Network/Enum/CharacterGenerationVerificationResponse.cs
 *
 *   Undef                = 0
 *   Ok                   = 1
 *   Pending              = 2
 *   NameInUse            = 3
 *   NameBanned           = 4
 *   Corrupt              = 5
 *   DatabaseDown         = 6
 *   AdminPrivilegeDenied = 7
 *   Count                = 8   — sentinel
 *
 * Wire format: uint32 at the start of the CharacterCreateResponse payload.
 * Per ACE GameMessageCharacterCreateResponse.cs, ONLY when response == Ok
 * does the server also write the new character's GUID + name.
 *
 * NOTE: this is the SERVER-emitted verification result, distinct from
 * the client-side validation `CreateResult` enum in CharacterCreation.ts
 * (which is used pre-submit to reject obviously-invalid character specs).
 */
export enum CharacterGenerationVerificationResponse {
  Undef                = 0,
  Ok                   = 1,
  Pending              = 2,
  NameInUse            = 3,
  NameBanned           = 4,
  Corrupt              = 5,
  DatabaseDown         = 6,
  AdminPrivilegeDenied = 7,
  Count                = 8,
}

/**
 * SWEEP1006 chargen failure — the string-table token the retail client shows
 * for a verification response. gmCharGenMainUI::
 * RecvNotice_CharGenVerificationResponse @ 004e9030: OK closes the wait
 * dialog and carries on; any other code closes it and opens
 * MakeErrorMessageDialog with a table-0x10000002 (= 0x23000002) string:
 * NAME_IN_USE → ID_Character_Err_NameReserved, NAME_BANNED →
 * ID_Character_Err_NameBanned, ADMIN_PRIVILEGE_DENIED →
 * ID_Character_Err_NameAdminDenied, everything else (Pending, Corrupt,
 * DatabaseDown, unknown) → ID_Character_Err_NameDBDown. Retail never wrote
 * these to chat; the invented English table this replaces is gone.
 */
export function characterCreateErrorToken(code: number): string | null {
  switch (code) {
    case CharacterGenerationVerificationResponse.Ok:                   return null;
    case CharacterGenerationVerificationResponse.NameInUse:            return 'ID_Character_Err_NameReserved';
    case CharacterGenerationVerificationResponse.NameBanned:           return 'ID_Character_Err_NameBanned';
    case CharacterGenerationVerificationResponse.AdminPrivilegeDenied: return 'ID_Character_Err_NameAdminDenied';
    default:                                                           return 'ID_Character_Err_NameDBDown';
  }
}
