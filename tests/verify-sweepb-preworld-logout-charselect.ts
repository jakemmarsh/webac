/**
 * SWEEP1006B pre-world — the logout to character select and the
 * character-select flow, against the decompiled EoL client
 * (reference/client-eol/decomp/acclient-decompiled.annotated.c):
 *
 *  - logout-x-options-exit-character: the indicator X and Options → Exit to
 *    Character Selection raise EndCharacterSession(1) →
 *    gmGamePlayUI::RecvNotice_EndCharacterSession @ 004ebea0 → the
 *    ID_Client_EndCharacterSessionConfirm Yes / No dialog
 *    (MakeLogoutConfirmationDialog @ 004eb6a0, one at a time).
 *  - logging-off-mid-air-allowed: gmGamePlayUI::UseTime @ 004ea3a0 refuses
 *    a confirmed logout off the ground ("Cannot log off while in mid-air.").
 *  - logging-off-chat-line-sent: CPlayerSystem::RequestLogOff @ 00562dd0's
 *    "Logging off..." type-0 chat line (covered with the notice catalogue in
 *    verify-core17ka-client-notices.ts; the order is checked here).
 *  - logoff-never-fades-world-into: RequestLogOff arms logOffRequestTime =
 *    now + LOG_OFF_DELAY_ANIM_TIME (3, +20 for IsPlayerKiller);
 *    gmSmartBoxUI::UseTime @ 004d6e30 then begins TAS_WORLD_FADE_OUT, and
 *    the teleport-in-progress mismatch ends the animation at TAS_TUNNEL.
 *  - account-characters-dropped-straight-into: an empty character set is
 *    character select with an empty list (gmCharacterManagementUI::Update
 *    @ 004ecab0 / UpdateButtons @ 004ec240).
 *  - back-character-select-after-logout: UIPersistantData::
 *    m_iidSelectedAvatar survives the world (ctor @ 004ec8f0 :226815).
 *  - charactererror-after-enter-delete-shows: RecvNotice_CharacterError
 *    @ 0047a7c0 → QueueUIModeWithError(0x1000000a): a fresh character
 *    select (no wait dialogs) with the OK dialog on it.
 *  - chargen-finish-can-send-charactercreate: DoFinish @ 004e9170 sends only
 *    from UNDEF_CG_VERIFICATION_RESPONSE; every CharGenVerificationResponse
 *    resets it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import {
  endCharacterSessionConfirmed, isPlayerKiller, logOffRequestDelay, LogOffRequest, DeferredLogOff, requestLogOff,
  LOG_OFF_MID_AIR_TEXT, LOGGING_OFF_TEXT, LOG_OFF_DELAY_ANIM_TIME, PLAYER_KILLER_LOG_OFF_EXTRA_DELAY,
  END_CHARACTER_SESSION_CONFIRM_TOKEN, END_CHARACTER_SESSION_CONFIRM_FALLBACK,
} from '../packages/renderer/src/session/LogoutFlow.js';
import { TeleportAnimState } from '../packages/renderer/src/effects/PortalSpaceModel.js';
import { descRef } from '../packages/renderer/src/ui/DatTextStyle.js';
import { DAT_PATHS, openDat } from './_harness/dat.js';
import type { CharacterSlot } from '../packages/renderer/src/ui/CharacterSelect.js';

describe('LogoutFlow — gmGamePlayUI::UseTime\'s confirmed logout + CPlayerSystem::RequestLogOff', () => {
  function run(onGround: boolean): { calls: string[]; sent: boolean } {
    const calls: string[] = [];
    const sent = endCharacterSessionConfirmed({
      onGround,
      spew: (t) => calls.push(`spew:${t}`),
      prepare: () => calls.push('prepare'),
      save: () => calls.push('save'),
      chatLine: (t) => calls.push(`chat:${t}`),
      send: () => calls.push('send'),
      requested: () => calls.push('requested'),
    });
    return { calls, sent };
  }

  it('off the ground: the spew refusal only — no save, no chat line, no CharacterLogOff, nothing latched', () => {
    const r = run(false);
    expect(r.sent).toBe(false);
    expect(r.calls).toEqual([`spew:${LOG_OFF_MID_AIR_TEXT}`]);
    expect(LOG_OFF_MID_AIR_TEXT).toBe('Cannot log off while in mid-air.');
    // A second attempt is judged afresh (m_endingSession = false).
    expect(run(true).sent).toBe(true);
  });

  it('on the ground: LogOffCharacter(false) — SaveToServer, then RequestLogOff\'s "Logging off..." line, the send, the timer', () => {
    const r = run(true);
    expect(r.sent).toBe(true);
    expect(r.calls).toEqual(['prepare', 'save', `chat:${LOGGING_OFF_TEXT}`, 'send', 'requested']);
    expect(LOGGING_OFF_TEXT).toBe('Logging off...');
  });

  // CPlayerSystem::LogOffCharacter @ 00563520 with prevRequest != IR_NONE,
  // then CPlayerSystem::UseTime @ 00563110 (:345801).
  it('an inventory request in flight defers the logoff: the line now, the request (and a second line) once it is answered', () => {
    const calls: string[] = [];
    const latch = new DeferredLogOff();
    const deps = {
      prepare: () => calls.push('prepare'),
      chatLine: (t: string) => calls.push(`chat:${t}`),
      send: () => calls.push('send'),
      requested: () => calls.push('requested'),
    };
    const sent = endCharacterSessionConfirmed({
      ...deps, onGround: true, spew: (t) => calls.push(`spew:${t}`), save: () => calls.push('save'),
      requestPending: true, defer: () => latch.defer(),
    });
    expect(sent).toBe(false);
    expect(calls).toEqual(['save', `chat:${LOGGING_OFF_TEXT}`]);
    expect(latch.loggingOff).toBe(true);
    // UseTime while the request is still out: nothing.
    expect(latch.poll(true)).toBe(false);
    // The reply lands: RequestLogOff once.
    expect(latch.poll(false)).toBe(true);
    requestLogOff(deps);
    expect(latch.poll(false)).toBe(false);
    expect(calls).toEqual(['save', `chat:${LOGGING_OFF_TEXT}`, 'prepare', `chat:${LOGGING_OFF_TEXT}`, 'send', 'requested']);
    // Mid-air still refuses first, deferring nothing.
    const air = new DeferredLogOff();
    const c2: string[] = [];
    endCharacterSessionConfirmed({ ...deps, onGround: false, spew: (t) => c2.push(t), save: () => c2.push('save'), requestPending: true, defer: () => air.defer() });
    expect(c2).toEqual([LOG_OFF_MID_AIR_TEXT]);
    expect(air.loggingOff).toBe(false);
  });

  it('IsPlayerKiller @ 0058c910 is PK or PKLite (ACE PlayerKillerStatus 0x04 / 0x40); the delay is 3 s, 23 s for one', () => {
    expect(isPlayerKiller(0x04)).toBe(true);
    expect(isPlayerKiller(0x40)).toBe(true);
    expect(isPlayerKiller(0x02)).toBe(false); // NPK
    expect(isPlayerKiller(0x20)).toBe(false); // Free
    expect(isPlayerKiller(undefined)).toBe(false);
    expect(LOG_OFF_DELAY_ANIM_TIME).toBe(3);
    expect(PLAYER_KILLER_LOG_OFF_EXTRA_DELAY).toBe(20);
    expect(logOffRequestDelay(false)).toBe(3);
    expect(logOffRequestDelay(true)).toBe(23);
  });

  it('LogOffRequest: due once, strictly after the request time; cancel (ExecuteLogOff) drops it', () => {
    const r = new LogOffRequest();
    expect(r.due(100)).toBe(false);
    r.request(100, false);
    expect(r.due(103)).toBe(false); // `logOffRequestTime < now`
    expect(r.due(103.01)).toBe(true);
    expect(r.due(104)).toBe(false); // SetLogOffStarted cleared it
    r.request(200, true);
    expect(r.due(222)).toBe(false);
    r.cancel();
    expect(r.due(300)).toBe(false);
  });
});

describe('GameUI — the logout dialog, the logoff fade and character select (happy-dom)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let H: any;
  const sounds: number[] = [];
  const busy: boolean[] = [];
  beforeAll(async () => {
    const { mountGameUI } = await import('./_harness/gameui.js');
    H = await mountGameUI({ callbacks: { onTeleportInProgressChanged: (b: boolean) => { busy.push(b); } } });
    H.ui.setUIHost({ gameFov: 90, setViewDistanceRatio: () => {} });
    H.ui.playUISound = (id: number) => { sounds.push(id); };
  });
  afterAll(() => H?.teardown());

  const slot = (id: string, name: string, extra: Partial<CharacterSlot> = {}): CharacterSlot =>
    ({ id, name, level: 1, heritage: 1, gender: 1, location: '', lastPlayed: 0, ...extra });
  const press = (el: HTMLElement): void => { el.dispatchEvent(new H.win.MouseEvent('click', { bubbles: true })); };
  const dialogButtons = (): HTMLElement[] => [...H.win.document.querySelectorAll('.ac-dialog-button')] as HTMLElement[];
  const charselButton = (elementId: number): HTMLButtonElement | null =>
    H.container.querySelector(`[data-ac-press="${descRef(0x21000004, elementId)}"]`) as HTMLButtonElement | null;

  it('requestEndCharacterSession: one Yes / No dialog; No closes; Yes is the confirmed logout (onLogout)', () => {
    let logouts = 0;
    H.ui.callbacks.onLogout = () => { logouts++; };
    expect(H.ui.requestEndCharacterSession()).toBe(true);
    expect(H.ui.logoutConfirmationOpen).toBe(true);
    expect(dialogButtons().length).toBe(2);
    expect(H.ui.requestEndCharacterSession()).toBe(false); // m_logoutContext set
    expect(dialogButtons().length).toBe(2);
    press(dialogButtons()[1]);
    expect(logouts).toBe(0);
    expect(H.ui.logoutConfirmationOpen).toBe(false);
    expect(H.ui.requestEndCharacterSession()).toBe(true);
    press(dialogButtons()[0]);
    expect(logouts).toBe(1);
    expect(dialogButtons().length).toBe(0);
  });

  it('the logoff fade: nothing for 3 s, then TAS_WORLD_FADE_OUT with UI_EnterPortal; at TAS_TUNNEL it ends at once (TUNNEL_CONTINUE), then the world fades back in', async () => {
    const { Sound } = await import('@ac/shared');
    let t = 1000;
    H.ui.portalClock = () => t;
    sounds.length = 0; busy.length = 0;
    H.ui.noteLogOffRequested(false);
    expect(H.ui.logOffRequestPending).toBe(true);
    expect(H.ui.pollLogOffRequest(1002.9)).toBe(false);
    expect(H.ui.portalSpaceState).toBe(TeleportAnimState.Off);
    t = 1003.05;
    expect(H.ui.pollLogOffRequest(t)).toBe(true);
    expect(H.ui.logOffRequestPending).toBe(false);
    expect(H.ui.portalSpaceState).toBe(TeleportAnimState.WorldFadeOut);
    expect(sounds).toEqual([Sound.UI_EnterPortal]);
    expect(busy).toEqual([true]);
    expect(H.ui.pollLogOffRequest(1004)).toBe(false); // once
    H.ui.teleportTick(1003.5);
    expect(H.ui.portalSpaceCovering).toBe(false); // the world zooms out first
    H.ui.teleportTick(1004.1);
    expect(H.ui.portalSpaceState).toBe(TeleportAnimState.TunnelFadeIn);
    H.ui.teleportTick(1005.2);
    expect(H.ui.portalSpaceState).toBe(TeleportAnimState.Tunnel);
    expect(H.ui.portalSpaceCovering).toBe(true);
    // The mismatch: no position update to wait for.
    H.ui.teleportTick(1005.25);
    expect(H.ui.portalSpaceState).toBe(TeleportAnimState.TunnelContinue);
    H.ui.teleportTick(1010.3); // past the 5 s cap → fade out
    expect(H.ui.portalSpaceState).toBe(TeleportAnimState.TunnelFadeOut);
    H.ui.teleportTick(1011.4);
    expect(H.ui.portalSpaceState).toBe(TeleportAnimState.WorldFadeIn);
    expect(sounds).toContain(Sound.UI_ExitPortal);
    H.ui.teleportTick(1012.5);
    expect(H.ui.portalSpaceState).toBe(TeleportAnimState.Off);
    expect(busy.at(-1)).toBe(false);
    H.ui.hidePortalSpace();
  });

  it('a player killer waits 23 s; the server\'s CharacterLogOff (ExecuteLogOff) before then means no fade at all', () => {
    let t = 2000;
    H.ui.portalClock = () => t;
    H.ui.noteLogOffRequested(true);
    expect(H.ui.pollLogOffRequest(2010)).toBe(false);
    H.ui.noteLogOffExecuted();
    t = 2030;
    expect(H.ui.pollLogOffRequest(t)).toBe(false);
    expect(H.ui.portalSpaceState).toBe(TeleportAnimState.Off);
    H.ui.hidePortalSpace();
  });

  it('a real teleport during the fade is not ended early by the logoff mismatch', () => {
    let t = 3000;
    H.ui.portalClock = () => t;
    H.ui.noteLogOffRequested(false);
    t = 3003.1;
    H.ui.pollLogOffRequest(t);
    H.ui.showPortalSpace(); // a server teleport: TAS_TUNNEL, ended only by endPortalSpace
    H.ui.teleportTick(3003.2);
    H.ui.teleportTick(3003.3);
    expect(H.ui.portalSpaceState).toBe(TeleportAnimState.Tunnel);
    H.ui.hidePortalSpace();
  });

  it('an account with no characters is character select with an empty list: ENTER and DELETE disabled, CREATE enabled', () => {
    H.ui.showConnectingScreen();
    H.ui.showCharacterSelect([], 11);
    expect(H.ui.uiManager.currentScreen).toBe('character-select');
    expect(H.container.querySelector('#chargen-root')).toBeNull();
    expect(H.ui.selectScreen.selectedCharacter).toBeUndefined();
    expect(charselButton(0x100003a2)?.disabled).toBe(true);   // ENTER
    expect(charselButton(0x1000039f)?.disabled).toBe(true);   // DELETE
    const create = charselButton(0x100003a0)!;
    expect(create).toBeTruthy();
    expect(create.dataset.acState).toBeUndefined();          // CREATE enabled (0 < 11)
    press(create);
    expect(H.ui.uiManager.currentScreen).toBe('character-create');
  });

  it('back from the world, character select keeps the character that was played, not the first in server order', () => {
    const set = [slot('1', 'Alpha'), slot('2', 'Bravo'), slot('3', 'Charlie')];
    H.ui.showConnectingScreen();
    H.ui.showCharacterSelect(set, 11);
    expect(H.ui.selectScreen.selectedCharacter?.id).toBe('1');
    // Select Bravo (a click re-renders), then into the world.
    const idx = H.ui.selectScreen.slots.findIndex((c: CharacterSlot) => c.id === '2');
    H.ui.selectScreen.selectCharacter(idx);
    H.ui.renderCharacterSelect();
    H.ui.uiManager.setScreen('game');
    // Session.cs:272's post-logoff CharacterList, in ACE's connect-time order.
    H.ui.showCharacterSelect(set, 11);
    expect(H.ui.selectScreen.selectedCharacter?.id).toBe('2');
    // URL auto-enter / post-chargen entry record the character themselves.
    H.ui.noteSelectedAvatar('3');
    H.ui.uiManager.setScreen('game');
    H.ui.showCharacterSelect(set, 11);
    expect(H.ui.selectScreen.selectedCharacter?.id).toBe('3');
    // Chargen Exit / Back returns to the same selection.
    H.ui.showCharacterCreate();
    H.ui.showCharacterSelect(set, 11);
    expect(H.ui.selectScreen.selectedCharacter?.id).toBe('3');
    // A deleted (gone) character falls back to the default pick.
    H.ui.uiManager.setScreen('game');
    H.ui.showCharacterSelect([slot('1', 'Alpha'), slot('2', 'Bravo')], 11);
    expect(H.ui.selectScreen.selectedCharacter?.id).toBe('1');
    // A fresh connect starts with none.
    H.ui.noteSelectedAvatar('2');
    H.ui.showConnectingScreen();
    H.ui.showCharacterSelect(set, 11);
    expect(H.ui.selectScreen.selectedCharacter?.id).toBe('1');
  });

  it('a CharacterError after ENTER rebuilds character select: Entering World gone, the OK dialog up, the selection kept', () => {
    const set = [slot('1', 'Alpha'), slot('2', 'Bravo')];
    H.ui.showConnectingScreen();
    H.ui.showCharacterSelect(set, 11);
    const idx = H.ui.selectScreen.slots.findIndex((c: CharacterSlot) => c.id === '2');
    H.ui.selectScreen.selectCharacter(idx);
    H.ui.renderCharacterSelect();
    let entered = 0;
    H.ui.callbacks.onEnterWorld = () => { entered++; };
    press(charselButton(0x100003a2)!);
    expect(entered).toBe(1);
    expect(H.container.querySelector('#charsel-enteringworld')).toBeTruthy();
    H.ui.showCharacterErrorDialog('Character not available.', set, 11);
    expect(H.container.querySelector('#charsel-enteringworld')).toBeNull();
    expect(H.win.document.getElementById('ac-message-dialog')).toBeTruthy();
    expect(H.ui.uiManager.currentScreen).toBe('character-select');
    expect(H.ui.selectScreen.selectedCharacter?.id).toBe('2');
    // The list takes input again: ENTER works after OK.
    H.ui.hideMessageDialog();
    press(charselButton(0x100003a2)!);
    expect(entered).toBe(2);
    H.ui.showCharacterErrorDialog('x', set, 11);
    H.ui.hideMessageDialog();
  });

  it('a CharacterError after DELETE drops Please Wait too (the rebuild replaces the screen)', () => {
    const set = [slot('1', 'Alpha')];
    H.ui.showCharacterSelect(set, 11);
    const wait = H.win.document.createElement('div');
    wait.id = 'charsel-pleasewait';
    H.container.querySelector('#charsel-inner')?.parentElement?.appendChild(wait);
    H.ui.showCharacterErrorDialog('Unable to delete', set, 11);
    expect(H.win.document.getElementById('charsel-pleasewait')).toBeNull();
    expect(H.win.document.getElementById('ac-message-dialog')).toBeTruthy();
    H.ui.hideMessageDialog();
  });

  it('FINISH sends one CharacterCreate until the CharGenVerificationResponse; a new chargen starts clear', () => {
    let creates = 0;
    H.ui.callbacks.onCharacterCreated = () => { creates++; };
    H.ui.showCharacterCreate();
    H.ui.chargenNameEntered = true;
    H.ui.wizard.setName('Finish Once');
    H.ui.wizard.attributes.strength += H.ui.wizard.attributesRemaining;
    expect(H.ui.doChargenFinish(true)).toBe(true);
    expect(H.ui.charGenVerificationPending).toBe(true);
    expect(H.ui.doChargenFinish(true)).toBe(false);
    expect(H.ui.doChargenFinish(false)).toBe(false);
    expect(creates).toBe(1);
    // The no-name check still answers while pending (it runs first).
    H.ui.chargenNameEntered = false;
    expect(H.ui.doChargenFinish(true)).toBe(false);
    expect(H.win.document.getElementById('ac-message-dialog')).toBeTruthy();
    H.ui.hideMessageDialog();
    H.ui.chargenNameEntered = true;
    H.ui.noteCharGenVerificationResponse();
    expect(H.ui.doChargenFinish(true)).toBe(true);
    expect(creates).toBe(2);
    H.ui.showCharacterCreate();
    expect(H.ui.charGenVerificationPending).toBe(false);
  });

  // BUG.chargen-hides-login-tunnel — RecvNotice_BeginEnterWorld @ 004e79f0
  // leaves the pre-world UI for gameplay mode as enter-world goes out, so the
  // streamed-DAT cell gate's tunnel must not sit behind the chargen screen.
  it('the login tunnel takes the place of chargen / character select; a later character select comes back', () => {
    H.ui.showCharacterCreate();
    expect(H.ui.uiManager.currentScreen).toBe('character-create');
    expect(H.ui.screenContainer.style.display).not.toBe('none');
    H.ui.showPortalSpace();
    expect(H.ui.screenContainer.style.display).toBe('none');
    expect(H.ui.portalSpaceState).toBe(TeleportAnimState.Tunnel);
    H.ui.hidePortalSpace();
    // Enter-world failed (CharacterError): the rebuilt character select is visible again.
    H.ui.showCharacterErrorDialog('x', [slot('1', 'Alpha')], 11);
    H.ui.hideMessageDialog();
    expect(H.ui.uiManager.currentScreen).toBe('character-select');
    expect(H.ui.screenContainer.style.display).toBe('block');
    H.ui.showPortalSpace();
    expect(H.ui.screenContainer.style.display).toBe('none');
    H.ui.hidePortalSpace();
  });
});

const hasLang = existsSync(DAT_PATHS.local);
describe.skipIf(!hasLang)('the DAT — ID_Client_EndCharacterSessionConfirm in table 0x23000001', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let text: any;
  beforeAll(async () => {
    const dp = await import('../packages/dat-parser/src/index.js');
    const lang = openDat(DAT_PATHS.local);
    const table = dp.parseStringTable(new dp.DatReader(lang.getFileData(0x23000001)!));
    dp.registerStringTable(table);
    text = dp.getStringFromTable(0x23000001, dp.acStringHash(END_CHARACTER_SESSION_CONFIRM_TOKEN));
  });

  it('resolves to the confirmation text the fallback carries', () => {
    expect(text).toBe(END_CHARACTER_SESSION_CONFIRM_FALLBACK);
  });
});
