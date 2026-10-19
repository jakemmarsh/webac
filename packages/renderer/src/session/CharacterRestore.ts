/**
 * CharacterRestore — what the character-select screen shows for the server's
 * answer to RESTORE (CharacterRestore 0xF7D9 → 0xF643, the CharGen
 * verification opcode).
 *
 * Retail: CPlayerSystem::Handle_CharGenVerificationResponse @ 0055e8b0 reads
 * the u32 response. 1 updates the character's identity in the CharacterSet
 * and re-sends the set (the list redraws; no dialog, no chat line); 3 / 4 /
 * 5 / 6 send CM_CharGen's CharGenVerificationResponse notice, which
 * gmCharacterManagementUI::RecvNotice_CharGenVerificationResponse @ 004ebf60
 * answers by closing its dialog and, for NAME_IN_USE (3), CORRUPT (5) and
 * DATABASE_DOWN (6), SetErrorMsg with
 * ID_CharacterManagement_CG_VERIFICATION_RESPONSE_* (table enum 0x10000002 →
 * 0x23000002): the OK dialog over character select. Any other code shows
 * nothing in retail; ours shows the CORRUPT text ("can not be restored") so
 * a refused restore is never silent (a browser-UX consistency choice; no
 * known server sends another code: ACE answers NameInUse / Corrupt,
 * CharacterHandler.cs CharacterRestore; GDLE only re-sends the list).
 */

import { acStringHash, getStringFromTable } from '@ac/dat-parser/file-types/LayoutDesc.js';

export const CHARACTER_RESTORE_STRING_TABLE = 0x23000002;

/** CG_VERIFICATION_RESPONSE codes gmCharacterManagementUI has text for → token + EoL DAT text. */
const RESTORE_REFUSALS: ReadonlyMap<number, { token: string; fallback: string }> = new Map([
  [3, { token: 'ID_CharacterManagement_CG_VERIFICATION_RESPONSE_NAME_IN_USE', fallback: 'Sorry, another character already exists by that name. Your character can not be restored.' }],
  [5, { token: 'ID_CharacterManagement_CG_VERIFICATION_RESPONSE_CORRUPT', fallback: 'Sorry, that character can not be restored.' }],
  [6, { token: 'ID_CharacterManagement_CG_VERIFICATION_RESPONSE_DATABASE_DOWN', fallback: 'Sorry, that character can not be restored. Please try again later.' }],
]);

/** The token retail shows for a refused restore's response code (undefined: retail shows nothing). */
export function characterRestoreRefusalToken(responseCode: number): string | undefined {
  return RESTORE_REFUSALS.get(responseCode)?.token;
}

/**
 * The OK dialog text for a restore answer, or null when it was accepted
 * (responseCode 1). Codes outside retail's three get the CORRUPT text.
 */
export function characterRestoreRefusalText(responseCode: number): string | null {
  if (responseCode === 1) return null;
  const row = RESTORE_REFUSALS.get(responseCode) ?? RESTORE_REFUSALS.get(5)!;
  return getStringFromTable(CHARACTER_RESTORE_STRING_TABLE, acStringHash(row.token)) ?? row.fallback;
}
