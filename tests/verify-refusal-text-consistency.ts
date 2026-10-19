/**
 * Every refusal a player can hit before (or on leaving) the world reads as
 * plain English with the same shape: retail's text first, then one blank
 * line, then one plain next-step sentence where retail's text stops short.
 *
 *  - No `ID_*` resource token ever reaches the player: the EoL and both Dark
 *    Majesty client_local_English.dat store ID_CHAR_ERROR_ENTER_GAME_GENERIC's
 *    entry as the literal "ID_CHAR_ERROR_ENTER_GAME_OLD_CHARACTER" (ACE sends
 *    that code when the chosen character no longer exists, CharacterHandler.cs
 *    CharacterEnterWorldRequest), and the chargen refusal dialogs fell back to
 *    their own token when the table was not loaded (playerText,
 *    characterCreateErrorFallbackText).
 *  - No dead link: ACE's ClientVersionIncorrect boot ("…Please visit
 *    http://play.emu.ac/ to update to latest client") becomes a reload hint
 *    (webAC players install nothing); the ban's support.turbine.com line is
 *    tested in verify-account-banned-text.ts.
 *  - Retail texts that end without a next step ("Server Full", "You do not
 *    have the current version of the client installed.") get one
 *    (NET_ERROR_NEXT_STEP via loginFailureText; characterErrorNotice rows).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import {
  playerText, isStringToken, withNextStep,
  characterCreateErrorToken, characterCreateErrorFallbackText, CharacterGenerationVerificationResponse,
  CharacterError, characterErrorMessage,
} from '../packages/shared/src/index.js';
import {
  characterErrorNotice, characterErrorCodesHandled, netErrorNotice, serverNetErrorNotice,
  NET_ERROR_TOKENS, NET_ERROR_NEXT_STEP, NET_ERROR_STRING_TABLE, CHAR_ERROR_STRING_TABLE,
  RELOAD_FOR_LATEST_HINT,
} from '../packages/renderer/src/ui/ConnectionNotices.js';
import {
  accountBootedText, splitServerReason, isClientVersionBootReason, RELOAD_FOR_LATEST_TEXT, PASSWORD_MISMATCH_BOOT_REASON,
} from '../packages/renderer/src/session/AccountBoot.js';
import { loginFailureText, accountBootLoginText } from '../packages/renderer/src/launcher/worldDirectory.js';
import { parseStringTable, registerStringTable, getString, acStringHash } from '../packages/dat-parser/src/index.js';
import { openDat, DAT_PATHS } from './_harness/dat.js';

const TOKEN_ANYWHERE = /\bID_[A-Za-z0-9_]+\b/;
const DEAD_LINK = /turbine\.com|emu\.ac|https?:\/\//i;
const NO_WORLD = null;

describe('playerText / withNextStep', () => {
  it('takes the DAT text unless it is missing, blank or a bare ID_* token', () => {
    expect(playerText('Server Full', 'x')).toBe('Server Full');
    expect(playerText('ID_CHAR_ERROR_ENTER_GAME_OLD_CHARACTER', 'plain')).toBe('plain');
    expect(playerText(' ID_Foo_Bar ', 'plain')).toBe('plain');
    for (const v of [null, undefined, '', '   ']) expect(playerText(v, 'plain')).toBe('plain');
    // Text that merely mentions a token-like word is real text.
    expect(playerText('See ID_Foo for details', 'plain')).toBe('See ID_Foo for details');
    expect(isStringToken('ID_ConnectionError_ServerFull')).toBe(true);
    expect(isStringToken('Server Full')).toBe(false);
  });

  it('joins retail text and one next step with exactly one blank line', () => {
    expect(withNextStep('Server could not log off your character ', 'Try again in a minute.'))
      .toBe('Server could not log off your character\n\nTry again in a minute.');
    expect(withNextStep('A', undefined)).toBe('A');
    expect(withNextStep('A', '')).toBe('A');
  });
});

describe('chargen refusals never show their token', () => {
  it('each verification response falls back to the DAT words for its token', () => {
    expect(characterCreateErrorFallbackText('ID_Character_Err_NameReserved')).toBe('The name you have selected is already in use.');
    expect(characterCreateErrorFallbackText('ID_Character_Err_NameBanned')).toBe('Sorry, but that name is not permitted. Please choose another.');
    expect(characterCreateErrorFallbackText('ID_Character_Err_NameAdminDenied'))
      .toBe('Sorry, but you do not have the privileges to make an administrator character.');
    expect(characterCreateErrorFallbackText('ID_Character_Err_NameDBDown'))
      .toBe('The server cannot create your new character at this time. Please try again later.');
    expect(characterCreateErrorFallbackText('ID_Bogus')).toBe(characterCreateErrorFallbackText('ID_Character_Err_NameDBDown'));
    expect(characterCreateErrorFallbackText(null)).toBe(characterCreateErrorFallbackText('ID_Character_Err_NameDBDown'));
    for (let code = 0; code <= CharacterGenerationVerificationResponse.Count; code++) {
      const token = characterCreateErrorToken(code);
      if (token === null) continue;
      expect(characterCreateErrorFallbackText(token)).not.toMatch(TOKEN_ANYWHERE);
    }
  });
});

describe('CharacterError notices (no string tables loaded)', () => {
  it('no code shows a token or a dead link; refusals that stop short carry one next step', () => {
    for (const code of characterErrorCodesHandled()) {
      const n = characterErrorNotice(code);
      expect(n.text, n.token).not.toMatch(TOKEN_ANYWHERE);
      expect(n.text, n.token).not.toMatch(DEAD_LINK);
      expect(n.text.split('\n\n').length, n.token).toBeLessThanOrEqual(2);
    }
  });

  it("0x0B (ACE: the chosen character doesn't exist) says so and what to do", () => {
    expect(characterErrorMessage(CharacterError.EnterGameGeneric)).toBe('That character could not be found.');
    const n = characterErrorNotice(CharacterError.EnterGameGeneric);
    expect(n.surface).toBe('dialog');
    expect(n.text).toBe('That character could not be found.\n\nPick another character.');
  });
});

describe('connection refusals: retail text, then one next step', () => {
  it('"Server Full" says to wait or pick another world (no per-IP caps)', () => {
    const n = serverNetErrorNotice(0x00F9982C, 8);
    expect(n.token).toBe('ID_ConnectionError_ServerFull');
    expect(loginFailureText(n, NO_WORLD, false)).toBe('Server Full\n\nWait a few minutes and try again, or pick another world.');
    expect(loginFailureText(n, { name: 'W', registration: null, registrationUrl: null }, false))
      .toBe('Server Full\n\nWait a few minutes and try again, or pick another world.');
  });

  it("the version mismatch (GDLE STR_LOGIN_CLIENT_VERSION, AC1999's own check) says to reload, since a webAC player can't install a client", () => {
    for (const n of [serverNetErrorNotice(0x00A7E948, 8), netErrorNotice('ID_ConnectionError_NetVersionMismatch')]) {
      expect(n.token).toBe('ID_ConnectionError_NetVersionMismatch');
      expect(loginFailureText(n, NO_WORLD, false))
        .toBe(`You do not have the current version of the client installed.\n\n${RELOAD_FOR_LATEST_HINT}`);
    }
    expect(RELOAD_FOR_LATEST_HINT).toBe(RELOAD_FOR_LATEST_TEXT);
  });

  it('every NetError token reads as text and, where it has one, ends with its next step', () => {
    for (const token of NET_ERROR_TOKENS) {
      const text = loginFailureText(netErrorNotice(token), NO_WORLD, false);
      expect(text, token).not.toMatch(TOKEN_ANYWHERE);
      expect(text, token).not.toMatch(DEAD_LINK);
      const hint = NET_ERROR_NEXT_STEP[token];
      if (hint) {
        expect(text.endsWith(`\n\n${hint}`), token).toBe(true);
        expect(text.split('\n\n').length, token).toBe(2);
      }
    }
  });
});

describe('boot reasons', () => {
  const ACE_VERSION = ' because your client is not the correct version for this server. Please visit http://play.emu.ac/ to update to latest client';

  it("ACE's ClientVersionIncorrect boot drops the download link and says to reload", () => {
    expect(isClientVersionBootReason(ACE_VERSION)).toBe(true);
    expect(accountBootedText(ACE_VERSION)).toBe(
      "You have been booted from Asheron's Call because your client is not the correct version for this server."
      + `\n\n${RELOAD_FOR_LATEST_TEXT}`);
    expect(accountBootLoginText(ACE_VERSION, NO_WORLD, false)).not.toMatch(DEAD_LINK);
  });

  it("ClassicACE's version / data-file boots get the same reload line", () => {
    for (const r of [
      ' because you are not running the correct executable file version for this server',
      ' because you do not have the correct data files for this server',
    ]) {
      expect(accountBootedText(r)).toBe(`You have been booted from Asheron's Call${r}.\n\n${RELOAD_FOR_LATEST_TEXT}`);
    }
  });

  it("ACE's own continuations stay inline, exactly retail's sentence", () => {
    expect(accountBootedText(PASSWORD_MISMATCH_BOOT_REASON))
      .toBe("You have been booted from Asheron's Call because the password entered for this account was not correct.");
    expect(accountBootedText(' - spamming')).toBe("You have been booted from Asheron's Call - spamming.");
    expect(accountBootedText(' because the world is now closed')).toBe("You have been booted from Asheron's Call because the world is now closed.");
    expect(isClientVersionBootReason(PASSWORD_MISMATCH_BOOT_REASON)).toBe(false);
  });

  it("a reason that is its own sentence (ClassicACE's VPN boot, no leading space) is not glued onto retail's", () => {
    expect(accountBootedText(' Connections from VPN / proxy disallowed by server policy'))
      .toBe("You have been booted from Asheron's Call.\n\nConnections from VPN / proxy disallowed by server policy.");
    expect(accountBootedText('Testing')).toBe("You have been booted from Asheron's Call.\n\nTesting.");
    expect(splitServerReason('\n\nBanned.\n\n\n\n')).toEqual(['', 'Banned.']);
    expect(splitServerReason(' - x.')).toEqual([' - x', '']);
    expect(splitServerReason(null)).toEqual(['', '']);
  });
});

describe.skipIf(!existsSync(DAT_PATHS.local))('EoL DAT: the one token-valued entry is replaced, retail wording kept', () => {
  beforeAll(() => {
    const lang = openDat(DAT_PATHS.local);
    for (const t of [0x23000001, CHAR_ERROR_STRING_TABLE, NET_ERROR_STRING_TABLE]) registerStringTable(parseStringTable(lang.getReader(t)));
  });

  it('ID_CHAR_ERROR_ENTER_GAME_GENERIC is a token in the DAT; the notice is plain English', () => {
    expect(getString(acStringHash('ID_CHAR_ERROR_ENTER_GAME_GENERIC'))).toBe('ID_CHAR_ERROR_ENTER_GAME_OLD_CHARACTER');
    expect(characterErrorNotice(CharacterError.EnterGameGeneric).text).toBe('That character could not be found.\n\nPick another character.');
  });

  it('every CharacterError notice and NetError text from the DAT is real text', () => {
    for (const code of characterErrorCodesHandled()) {
      expect(characterErrorNotice(code).text).not.toMatch(TOKEN_ANYWHERE);
    }
    for (const token of NET_ERROR_TOKENS) {
      expect(loginFailureText(netErrorNotice(token), NO_WORLD, false)).not.toMatch(TOKEN_ANYWHERE);
    }
    // Retail's wording leads, unchanged.
    expect(characterErrorNotice(CharacterError.LogonServerFull).text).toBe("Sorry, but the Asheron's Call server is full currently. Please try again later.");
    expect(characterErrorNotice(CharacterError.Logoff).text).toBe('Server could not log off your character\n\nTry again in a minute.');
  });

  it('the chargen tokens resolve to the same words as the fallbacks', () => {
    for (const token of ['ID_Character_Err_NameReserved', 'ID_Character_Err_NameBanned', 'ID_Character_Err_NameAdminDenied', 'ID_Character_Err_NameDBDown']) {
      expect(getString(acStringHash(token))).toBe(characterCreateErrorFallbackText(token));
    }
  });
});
