/**
 * Refusal flow consistency — every refusal a player can meet is visible and
 * never swallowed:
 *  - session/RefusalRoute.ts: before the world an account-level refusal is the
 *    OK dialog (over the launcher for a launcher login, OK relaunching for a URL
 *    login); from the world (or a resume of a drop from it) retail's
 *    Disconnected screen; a CharacterError outside retail's switch ends a
 *    pre-world wait with the generic dialog; the stale-session wait's line.
 *  - session/CharacterRestore.ts: a refused RESTORE is gmCharacterManagementUI::
 *    RecvNotice_CharGenVerificationResponse @ 004ebf60's OK dialog text.
 *  - SessionLifecycle: CPlayerSystem::UseTime @ 00563110's REQUEST_TIMEOUT on
 *    an unanswered enter-world request.
 *  - GameUI: showRefusalDialog replaces an open dialog (its onOk runs), a
 *    character-select redraw keeps an open dialog, the connecting screen
 *    shows the stale-session wait under Please Wait.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { CharacterError } from '../packages/shared/src/index.js';
import {
  accountRefusalRoute, characterErrorRoute, genericEnterRefusalText, staleSessionWaitText,
} from '../packages/renderer/src/session/RefusalRoute.js';
import {
  characterRestoreRefusalText, characterRestoreRefusalToken,
} from '../packages/renderer/src/session/CharacterRestore.js';
import { SessionLifecycle } from '../packages/renderer/src/session/SessionLifecycle.js';
import { REQUEST_TIMEOUT_S, characterErrorNotice } from '../packages/renderer/src/ui/ConnectionNotices.js';

const REPO = resolve(__dirname, '..');
const LANG_DAT = resolve(REPO, 'dat/client_local_English.dat');

describe('RefusalRoute — where an account-level refusal is shown', () => {
  it('before the world: the launcher for a launcher login, a relaunching OK for a URL login', () => {
    expect(accountRefusalRoute({ inWorld: false, resuming: false, launcherLogin: true })).toBe('launcher');
    expect(accountRefusalRoute({ inWorld: false, resuming: false, launcherLogin: false })).toBe('relaunch');
  });

  it('from the world, or a resume of a drop from it: retail\'s Disconnected screen', () => {
    for (const launcherLogin of [true, false]) {
      expect(accountRefusalRoute({ inWorld: true, resuming: false, launcherLogin })).toBe('disconnected');
      expect(accountRefusalRoute({ inWorld: false, resuming: true, launcherLogin })).toBe('disconnected');
    }
  });
});

describe('RefusalRoute — CharacterError routes', () => {
  it('retail\'s account-level codes are account refusals (their surface is decided by accountRefusalRoute)', () => {
    for (const code of [CharacterError.Logon, CharacterError.AccountDoesntExist, CharacterError.LogonServerFull, CharacterError.SubscriptionExpired]) {
      const r = characterErrorRoute(code, { inWorld: false });
      expect(r.route).toBe('account');
      expect(r.text).toBe(characterErrorNotice(code).text);
      expect(characterErrorRoute(code, { inWorld: true }).route).toBe('account');
    }
  });

  it('retail\'s char-select codes are the OK dialog over character select, with their own text', () => {
    const r = characterErrorRoute(CharacterError.EnterGameCouldntPlaceCharacter, { inWorld: false });
    expect(r).toMatchObject({ route: 'charselect', text: characterErrorNotice(CharacterError.EnterGameCouldntPlaceCharacter).text });
  });

  it('a code outside retail\'s switch ends a pre-world wait with the generic dialog; in the world it shows nothing, as retail', () => {
    const before = characterErrorRoute(0x7f, { inWorld: false });
    expect(before.route).toBe('charselect');
    expect(before.text).toBe('Could not enter the game. Please try again.');
    expect(before.text).toBe(genericEnterRefusalText());
    expect(before.notice.token).toBe('');
    expect(characterErrorRoute(0x7f, { inWorld: true }).route).toBe('none');
  });

  it('on the connecting screen (no character list yet) a would-be char-select dialog ends the connect as an account refusal', () => {
    expect(characterErrorRoute(0x7f, { inWorld: false, connecting: true })).toMatchObject({ route: 'account', text: genericEnterRefusalText() });
    expect(characterErrorRoute(CharacterError.EnterGameCharacterLocked, { inWorld: false, connecting: true }).route).toBe('account');
    // Not connecting: character select is there to come back to.
    expect(characterErrorRoute(CharacterError.EnterGameCharacterLocked, { inWorld: false, connecting: false }).route).toBe('charselect');
  });

  it('the stale-session wait says what it is waiting for, with its progress', () => {
    expect(staleSessionWaitText(3, 40)).toBe('Waiting for the server to release your last session… (try 3 of 40)');
    expect(staleSessionWaitText(0, 0)).toBe('Waiting for the server to release your last session…');
  });
});

describe('CharacterRestore — the OK dialog for a refused RESTORE', () => {
  it('OK (1) shows nothing; retail\'s three refusals have their ID_CharacterManagement_* tokens', () => {
    expect(characterRestoreRefusalText(1)).toBeNull();
    expect(characterRestoreRefusalToken(3)).toBe('ID_CharacterManagement_CG_VERIFICATION_RESPONSE_NAME_IN_USE');
    expect(characterRestoreRefusalToken(5)).toBe('ID_CharacterManagement_CG_VERIFICATION_RESPONSE_CORRUPT');
    expect(characterRestoreRefusalToken(6)).toBe('ID_CharacterManagement_CG_VERIFICATION_RESPONSE_DATABASE_DOWN');
    expect(characterRestoreRefusalToken(4)).toBeUndefined();
  });

  it('every refusal has text (a code retail does not list gets the CORRUPT text, never silence)', () => {
    for (const code of [0, 2, 3, 4, 5, 6, 7]) {
      const t = characterRestoreRefusalText(code);
      expect(t, `code ${code}`).toBeTruthy();
      expect(t).toMatch(/can not be restored/);
    }
    expect(characterRestoreRefusalText(4)).toBe(characterRestoreRefusalText(5));
  });
});

describe.skipIf(!existsSync(LANG_DAT))('CharacterRestore — with the end-of-retail string table', () => {
  beforeAll(async () => {
    const { openDat } = await import('./_harness/dat.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    const L = await import('../packages/dat-parser/src/file-types/LayoutDesc.js');
    const db = openDat('dat/client_local_English.dat');
    L.registerStringTable(L.parseStringTable(new DatReader(db.getFileData(0x23000002)!)));
  });

  it('the dialog reads retail\'s 0x23000002 text', () => {
    expect(characterRestoreRefusalText(3)).toBe('Sorry, another character already exists by that name. Your character can not be restored.');
    expect(characterRestoreRefusalText(5)).toBe('Sorry, that character can not be restored.');
    expect(characterRestoreRefusalText(6)).toBe('Sorry, that character can not be restored. Please try again later.');
  });
});

describe('SessionLifecycle — REQUEST_TIMEOUT on an unanswered enter-world request', () => {
  const T = REQUEST_TIMEOUT_S * 1000;

  it('is retail\'s 110 s; fires once, only when the enter is still unanswered', () => {
    expect(REQUEST_TIMEOUT_S).toBe(110);
    const s = new SessionLifecycle();
    s.noteEnterWorldRequested(0x50000001);
    s.noteEnterRequestSent(1000);
    expect(s.enterRequestTimedOut(T, 1000 + T - 1)).toBe(false);
    expect(s.enterRequestTimedOut(T, 1000 + T)).toBe(true);
    // Cleared: once only, and the enter is over (the player may try again).
    expect(s.enterRequestTimedOut(T, 1000 + 2 * T)).toBe(false);
    expect(s.enterWorldPending).toBe(false);
    expect(s.mayRequestEnterWorld()).toBe(true);
  });

  it('each request (a "still in the world" retry too) restarts the budget, as LogOnCharacter re-stamps it', () => {
    const s = new SessionLifecycle();
    s.noteEnterWorldRequested(0x50000001);
    s.noteEnterRequestSent(0);
    expect(s.characterInWorldRefusal()).toBe('retry');
    s.noteEnterRequestSent(60_000);
    expect(s.enterRequestTimedOut(T, T + 1)).toBe(false);
    expect(s.enterRequestTimedOut(T, 60_000 + T)).toBe(true);
  });

  it('PlayerCreate, a refusal, a logout or a drop stop the clock', () => {
    const stops: Array<(s: SessionLifecycle) => void> = [
      (s) => s.noteWorldEntered(), (s) => s.noteEnterRefused(), (s) => s.noteLoggedOut(), (s) => s.noteDisconnected(),
    ];
    for (const stop of stops) {
      const s = new SessionLifecycle();
      s.noteEnterWorldRequested(0x50000001);
      s.noteEnterRequestSent(0);
      stop(s);
      expect(s.enterRequestSentAt).toBeNull();
      expect(s.enterRequestTimedOut(T, 10 * T)).toBe(false);
    }
  });
});

// ── GameUI under happy-dom ──────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1920, innerHeight: 1080 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'requestAnimationFrame'] as const;

describe('GameUI — refusals are never swallowed', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  beforeAll(() => { installDomGlobals(domWindow, DOM_GLOBALS, saved, 'functions'); });
  afterAll(() => { restoreDomGlobals(DOM_GLOBALS, saved); });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function freshUi(): Promise<any> {
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    domWindow.document.body.innerHTML = '';
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    return new mod.GameUI(container);
  }
  const clickOk = (): void => {
    const ok = domWindow.document.querySelector('#ac-message-dialog-ok') as HTMLElement;
    ok.dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));
  };
  const dialogText = (): string => (domWindow.document.querySelector('#ac-message-dialog') as HTMLElement | null)?.textContent ?? '';

  it('showRefusalDialog replaces an open dialog, and its own OK runs (the way back to the launcher)', async () => {
    const ui = await freshUi();
    ui.showConnectingScreen();
    let stale = 0;
    let back = 0;
    ui.showMessageDialog('A new version is available.', () => { stale++; });
    ui.showRefusalDialog('You have been booted from Asheron\'s Call.', () => { back++; });
    expect(domWindow.document.querySelectorAll('#ac-message-dialog').length).toBe(1);
    expect(dialogText()).toContain('booted');
    clickOk();
    expect(back).toBe(1);
    expect(stale).toBe(0);
    expect(ui.messageDialogOpen).toBe(false);
  });

  it('showRefusalDialog closes an open confirmation too (UseNewMode destroys the old UI\'s dialogs)', async () => {
    const ui = await freshUi();
    ui.showConfirmationDialog('Are you sure you want to leave?', () => {});
    ui.showRefusalDialog('refused');
    expect(ui.openBlockingWindow()).toBe('message');
    expect(domWindow.document.querySelectorAll('.ac-dialog-plate').length).toBe(1);
  });

  it('a character-error dialog is not swallowed by a dialog already up', async () => {
    const ui = await freshUi();
    ui.showCharacterSelect([{ id: '1', name: 'Alpha' }], 11);
    ui.showMessageDialog('something else');
    ui.showCharacterErrorDialog('Could not enter the game. Please try again.');
    expect(domWindow.document.querySelectorAll('#ac-message-dialog').length).toBe(1);
    expect(dialogText()).toContain('Could not enter the game');
    expect(domWindow.document.querySelector('#charsel-inner')).toBeTruthy();
  });

  it('a redraw of character select (a ServerName, a re-sent list, a row click) keeps an open dialog and its OK', async () => {
    const ui = await freshUi();
    ui.showCharacterSelect([{ id: '1', name: 'Alpha' }, { id: '2', name: 'Beta' }], 11);
    let oks = 0;
    ui.showRefusalDialog('Sorry, that character can not be restored.', () => { oks++; });
    ui.setWorldName('Coldeve');
    ui.showCharacterSelect([{ id: '1', name: 'Alpha' }, { id: '2', name: 'Beta' }], 11);
    expect(ui.messageDialogOpen).toBe(true);
    expect(dialogText()).toContain('can not be restored');
    clickOk();
    expect(oks).toBe(1);
  });

  it('a new connect cycle, or character select entered from another screen, closes the old dialog', async () => {
    const ui = await freshUi();
    ui.showCharacterSelect([{ id: '1', name: 'Alpha' }], 11);
    ui.showMessageDialog('old');
    ui.showConnectingScreen();
    expect(ui.messageDialogOpen).toBe(false);

    ui.showDisconnectedScreen('The connection to the server has been lost!', () => {});
    ui.showMessageDialog('over the disconnected screen');
    ui.hideDisconnectedScreen();
    ui.showCharacterSelect([{ id: '1', name: 'Alpha' }], 11);
    expect(ui.messageDialogOpen).toBe(false);
  });
});

describe('GameUI — the connecting screen says what a long wait is for', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  beforeAll(() => { installDomGlobals(domWindow, DOM_GLOBALS, saved, 'functions'); });
  afterAll(() => { restoreDomGlobals(DOM_GLOBALS, saved); });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function freshUi(): Promise<any> {
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    domWindow.document.body.innerHTML = '';
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    return new mod.GameUI(container);
  }
  const waitText = (): string => (domWindow.document.querySelector('#charsel-pleasewait') as HTMLElement | null)?.innerHTML ?? '';

  it('the line goes under Please Wait in the same wait dialog, updates in place, and a new connect or the list clears it', async () => {
    const ui = await freshUi();
    ui.showConnectingScreen();
    expect(waitText()).toContain('Please Wait');
    expect(waitText()).not.toContain('release your last session');

    ui.setConnectingStatus(staleSessionWaitText(1, 40));
    expect(domWindow.document.querySelectorAll('#charsel-pleasewait').length).toBe(1);
    expect(waitText()).toContain('Please Wait');
    expect(waitText()).toContain('release your last session');
    expect(waitText()).toContain('try 1 of 40');
    expect(ui.connectingStatusText).toBe(staleSessionWaitText(1, 40));

    ui.setConnectingStatus(staleSessionWaitText(2, 40));
    expect(domWindow.document.querySelectorAll('#charsel-pleasewait').length).toBe(1);
    expect(waitText()).toContain('try 2 of 40');

    // The character list ends the wait.
    ui.showCharacterSelect([{ id: '1', name: 'Alpha' }], 11);
    expect(domWindow.document.querySelector('#charsel-pleasewait')).toBeNull();
    expect(ui.connectingStatusText).toBeNull();

    // A new connect cycle starts with Please Wait alone.
    ui.showConnectingScreen();
    expect(waitText()).not.toContain('release your last session');
  });

  it('a status set off the connecting screen does nothing visible', async () => {
    const ui = await freshUi();
    ui.showCharacterSelect([{ id: '1', name: 'Alpha' }], 11);
    ui.setConnectingStatus('x');
    expect(domWindow.document.querySelector('#charsel-pleasewait')).toBeNull();
    expect(ui.connectingStatusText).toBeNull();
  });
});
