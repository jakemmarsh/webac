/**
 * CharacterGenerationVerificationResponse audit + text-helper test.
 *
 * Server's character-create response is a uint32 code per
 *   reference/ACE/Source/ACE.Server/Network/Enum/CharacterGenerationVerificationResponse.cs
 * Values must match 1:1 — drift would mislabel failures (or skip the
 * GUID/name fields in the Ok branch, breaking world-enter).
 *
 * FAITHFUL.135 replaced a bare `=== 1` check + ad-hoc error Record with
 * symbolic enum + canonical-text helper. This test locks both ends.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CharacterGenerationVerificationResponse as Resp,
  characterCreateErrorToken,
} from '../packages/shared/src/enums/CharacterGenerationVerificationResponse.js';

const REPO = resolve(__dirname, '..');
const ACE_PATH = resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/Enum/CharacterGenerationVerificationResponse.cs');

describe.skipIf(!aceReferenceExists(ACE_PATH))('ACE CharacterGenerationVerificationResponse coverage (FAITHFUL.135)', () => {
  let src: string;
  // Loaded in beforeAll: skipIf does not skip the describe body (CLAUDE.md).
  beforeAll(() => {
    src = readFileSync(ACE_PATH, 'utf8');
  });
  it('matches ACE default-indexed enum order 1:1', () => {
    // ACE uses default C# auto-increment from 0. Our enum must match.
    expect(src).toMatch(/Undef\b[^=]/);
    expect(src).toMatch(/Ok\b[^=]/);
    expect(src).toMatch(/Pending\b[^=]/);
    expect(src).toMatch(/NameInUse\b[^=]/);
    expect(src).toMatch(/NameBanned\b[^=]/);
    expect(src).toMatch(/Corrupt\b[^=]/);
    expect(src).toMatch(/DatabaseDown\b[^=]/);
    expect(src).toMatch(/AdminPrivilegeDenied\b[^=]/);
    expect(src).toMatch(/Count\b/);

    expect(Resp.Undef).toBe(0);
    expect(Resp.Ok).toBe(1);
    expect(Resp.Pending).toBe(2);
    expect(Resp.NameInUse).toBe(3);
    expect(Resp.NameBanned).toBe(4);
    expect(Resp.Corrupt).toBe(5);
    expect(Resp.DatabaseDown).toBe(6);
    expect(Resp.AdminPrivilegeDenied).toBe(7);
    expect(Resp.Count).toBe(8);
  });
});

/**
 * SWEEP1006 chargen failure — gmCharGenMainUI::RecvNotice_CharGenVerificationResponse
 * @ 004e9030 picks one of four table-0x10000002 tokens (retail's switch:
 * 3 / 4 / 7, everything else NameDBDown) and shows it in an error dialog.
 */
describe('characterCreateErrorToken', () => {
  it('Ok has no error', () => {
    expect(characterCreateErrorToken(Resp.Ok)).toBeNull();
  });
  it('the three named failures pick their own token', () => {
    expect(characterCreateErrorToken(Resp.NameInUse)).toBe('ID_Character_Err_NameReserved');
    expect(characterCreateErrorToken(Resp.NameBanned)).toBe('ID_Character_Err_NameBanned');
    expect(characterCreateErrorToken(Resp.AdminPrivilegeDenied)).toBe('ID_Character_Err_NameAdminDenied');
  });
  it('every other code is the DB-down text (retail default arm)', () => {
    for (const c of [Resp.Undef, Resp.Pending, Resp.Corrupt, Resp.DatabaseDown, Resp.Count, 999]) {
      expect(characterCreateErrorToken(c)).toBe('ID_Character_Err_NameDBDown');
    }
  });
});

describe.skipIf(!existsSync(resolve(REPO, 'dat/client_local_English.dat')))('the tokens resolve in string table 0x23000002', () => {
  it('each token has DAT text', async () => {
    const { openDat } = await import('./_harness/dat.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    const L = await import('../packages/dat-parser/src/file-types/LayoutDesc.js');
    const db = openDat('dat/client_local_English.dat');
    L.registerStringTable(L.parseStringTable(new DatReader(db.getFileData(0x23000002)!)));
    expect(L.getStringFromTable(0x23000002, L.acStringHash('ID_Character_Err_NameReserved'))).toBe('The name you have selected is already in use.');
    for (const t of ['ID_Character_Err_NameBanned', 'ID_Character_Err_NameAdminDenied', 'ID_Character_Err_NameDBDown']) {
      expect(L.getStringFromTable(0x23000002, L.acStringHash(t))).toBeTruthy();
    }
  });
});
