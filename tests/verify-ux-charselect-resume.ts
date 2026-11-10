/**
 * UX.charselect-resume (2026-11-05) — a connection lost at character select
 * reconnects on its own, the same three attempts at 2 / 5 / 10 s as the
 * in-world and chargen resumes (RetryPolicy.RESUME_DELAYS_MS), behind the
 * connecting screen, and lands back on character select with the list and the
 * selection, entering nothing. The Disconnected screen only once they fail.
 * Production 2026-11-04/05: an AC1999 tab whose network dropped and an
 * end-of-retail tab after a laptop sleep both sat at character select and
 * landed on the Disconnected screen.
 *
 * Drives the real SessionLifecycle, the drop routing main.ts uses
 * (UnexpectedDrop.armDropResume / handleUnexpectedDrop, SessionLiveness.
 * sessionDropped, PreworldReporter.preworldScreenFor, RefusalRoute), the real
 * GameUI character select (happy-dom) and the real PreworldReporter.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SessionLifecycle } from '../packages/renderer/src/session/SessionLifecycle.js';
import {
  armDropResume, handleUnexpectedDrop, resumeAttemptRefusalIsFinal, type DropResumeState,
} from '../packages/renderer/src/session/UnexpectedDrop.js';
import { sessionDropped } from '../packages/renderer/src/session/SessionLiveness.js';
import { accountRefusalRoute } from '../packages/renderer/src/session/RefusalRoute.js';
import {
  PreworldReporter, preworldScreenFor, type PreworldEvent, type PreworldScreenState,
} from '../packages/renderer/src/telemetry/PreworldReporter.js';
import { sanitizeClientPreworld } from '../services/ws-tcp-bridge/src/clientPreworld.js';
import { connectionFailureNotice } from '../packages/renderer/src/ui/ConnectionNotices.js';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import type { CharacterSlot } from '../packages/renderer/src/ui/CharacterSelect.js';
import { RESUME_DELAYS_MS } from '../packages/renderer/src/session/RetryPolicy.js';

const GUID = 0x50000001;
const OTHER = 0x50000002;
const SLOTS = [{ id: String(GUID) }, { id: String(OTHER) }];

/** The screen state at character select with this session's list in hand. */
const AT_CHAR_SELECT: PreworldScreenState = {
  gameStarted: false, disconnected: false, launcherActive: false, eraSwitchPending: false,
  uiScreen: 'character-select', portalSpace: false, charListReceived: true, connectingScreen: false, resuming: false,
};
const screenOf = (over: Partial<PreworldScreenState> = {}): string => preworldScreenFor({ ...AT_CHAR_SELECT, ...over });

/** A socket that had opened and closed under the player (not our own disconnect()). */
const DROP = { everOpened: true, deliberate: false };
/** Our own close: leaving for the launcher, Exit, a refusal's endRefusedSession. */
const OUR_CLOSE = { everOpened: true, deliberate: true };

function state(lifecycle: SessionLifecycle, over: Partial<DropResumeState> & { event?: typeof DROP } = {}): DropResumeState {
  const { event = DROP, ...rest } = over;
  return {
    unexpected: sessionDropped(event),
    wasInWorld: lifecycle.inWorld,
    enterPending: lifecycle.enterWorldPending,
    screen: screenOf(),
    keepChargenDraft: () => false,
    selection: () => String(OTHER),
    ...rest,
  };
}

/** The attempts a resume gets, as main.ts scheduleResume asks for them, until the Disconnected screen. */
function drainDelays(lifecycle: SessionLifecycle): number[] {
  const out: number[] = [];
  for (let d = lifecycle.nextResumeDelay(); d !== null; d = lifecycle.nextResumeDelay()) out.push(d);
  return out;
}

describe('UX.charselect-resume — a drop at character select arms the resume', () => {
  it('a fresh session at character select: char-select resume, 2 / 5 / 10 s, then the Disconnected screen', () => {
    const lc = new SessionLifecycle();
    expect(armDropResume(lc, state(lc))).toBe('charselect');
    expect(drainDelays(lc)).toEqual([2000, 5000, 10000]);
    expect([...RESUME_DELAYS_MS]).toEqual([2000, 5000, 10000]);
    // Spent: nothing more resumes, the caller raises the Disconnected screen.
    expect(lc.resumingAfterDrop).toBe(false);
    expect(lc.nextResumeDelay()).toBeNull();
  });

  it('the reconnect lands on character select with the selection, entering nothing (even with URL auto-enter)', () => {
    const lc = new SessionLifecycle();
    // Played a character, then logged out to character select (ACE's post-logoff list).
    lc.noteEnterWorldRequested(GUID);
    lc.noteWorldEntered();
    lc.noteLoggedOut();
    expect(armDropResume(lc, state(lc))).toBe('charselect');
    expect(lc.nextResumeDelay()).toBe(2000);
    expect(lc.resumingCharSelect).toBe(true);
    expect(lc.resumingWorld).toBe(false);
    expect(lc.resumingChargen).toBe(false);
    expect(lc.charSelectResumeSelection).toBe(String(OTHER));
    expect(lc.pickAutoEnterSlot(SLOTS, true)).toBeNull();
    // The list arrived: main.ts ends the resume and lands on character select.
    lc.endResume();
    expect(lc.resumingAfterDrop).toBe(false);
    expect(lc.charSelectResumeSelection).toBeUndefined();
  });

  it('a failed attempt of a char-select resume continues it (not a new resume kind)', () => {
    const lc = new SessionLifecycle();
    armDropResume(lc, state(lc));
    expect(lc.nextResumeDelay()).toBe(2000);
    // The attempt's own socket opened and dropped before the list.
    expect(armDropResume(lc, state(lc, { screen: screenOf({ connectingScreen: true, resuming: true }) }))).toBe('world');
    expect(lc.nextResumeDelay()).toBe(5000);
    expect(lc.resumingCharSelect).toBe(true);
  });

  it('the page link check (the tick outlives a logout) resumes a dead char-select session too', () => {
    const lc = new SessionLifecycle();
    const log: string[] = [];
    const verdict = handleUnexpectedDrop({
      lifecycle: lc,
      reportLeft: () => log.push('world_left'),
      teardownWorld: () => log.push('teardown'),
      scheduleResume: () => { const d = lc.nextResumeDelay(); if (d === null) return false; log.push(`resume ${d}`); return true; },
      raiseServerDied: () => log.push('server_died'),
      armPreworldResume: () => armDropResume(lc, state(lc)) !== null,
    });
    expect(verdict).toBe('resuming');
    expect(log).toContain('resume 2000');
    expect(log).not.toContain('server_died');
    expect(lc.resumingCharSelect).toBe(true);
  });
});

describe('UX.charselect-resume — nothing resumes that should not', () => {
  it('a deliberate exit (Exit, logout, leaving for the launcher) closes from our side: nothing armed', () => {
    const lc = new SessionLifecycle();
    lc.noteEnterWorldRequested(GUID);
    lc.noteWorldEntered();
    lc.noteLoggedOut(); // leaveForLauncher / Exit Game
    expect(armDropResume(lc, state(lc, { event: OUR_CLOSE }))).toBeNull();
    expect(lc.nextResumeDelay()).toBeNull();
  });

  it('a refusal (boot, ban, account in use) closes the session from our side first: nothing armed', () => {
    const lc = new SessionLifecycle();
    // main.ts endRefusedSession: noteDisconnected, then aceConnection.disconnect() (deliberate).
    lc.noteDisconnected();
    expect(armDropResume(lc, state(lc, { event: OUR_CLOSE }))).toBeNull();
    expect(lc.nextResumeDelay()).toBeNull();
  });

  it('a refusal of a resume attempt ends the resume on the Disconnected screen (raiseServerDied → endResume)', () => {
    const lc = new SessionLifecycle();
    armDropResume(lc, state(lc));
    lc.nextResumeDelay();
    expect(accountRefusalRoute({ inWorld: false, resuming: lc.resumingAfterDrop, launcherLogin: true })).toBe('disconnected');
    lc.noteDisconnected();
    lc.endResume();
    expect(lc.resumingAfterDrop).toBe(false);
    expect(armDropResume(lc, state(lc, { event: OUR_CLOSE }))).toBeNull();
  });

  it('a version-mismatch refusal of an attempt is final; a "Client logon failed" one is retried', () => {
    const version = connectionFailureNotice({ netErrorId: 'ID_ConnectionError_NetVersionMismatch' })!;
    expect(resumeAttemptRefusalIsFinal(version.token)).toBe(true);
    const logon = connectionFailureNotice({ netErrorId: 'ID_ConnectionError_ClientLogOnFailed' })!;
    expect(resumeAttemptRefusalIsFinal(logon.token)).toBe(false);
    expect(resumeAttemptRefusalIsFinal('ID_NetError_CantSocket')).toBe(false);
    expect(resumeAttemptRefusalIsFinal(null)).toBe(false);
  });

  it('a drop while logging out of the world (the world still up) is not a char-select resume', () => {
    const lc = new SessionLifecycle();
    lc.noteEnterWorldRequested(GUID);
    lc.noteWorldEntered();
    lc.noteLoggedOut(); // the logout request (LogoutFlow prepare): inWorld false, the world still drawn
    expect(armDropResume(lc, state(lc, { screen: screenOf({ gameStarted: true }) }))).toBeNull();
    expect(lc.nextResumeDelay()).toBeNull();
  });

  it('the connecting screen (no list yet, or Please Wait up), the launcher, portal space and the Disconnected screen arm nothing', () => {
    for (const over of [
      { charListReceived: false },
      { connectingScreen: true },
      { launcherActive: true },
      { disconnected: true },
      { portalSpace: true },
    ] as Array<Partial<PreworldScreenState>>) {
      const lc = new SessionLifecycle();
      expect(armDropResume(lc, state(lc, { screen: screenOf(over) }))).toBeNull();
      expect(lc.nextResumeDelay()).toBeNull();
    }
  });

  it('a second resume never overrides one under way', () => {
    const lc = new SessionLifecycle();
    lc.noteEnterWorldRequested(GUID);
    lc.noteWorldEntered();
    expect(armDropResume(lc, state(lc))).toBe('world');
    lc.noteDisconnected();
    lc.nextResumeDelay();
    lc.beginCharSelectResume('x');
    expect(lc.resumingCharSelect).toBe(false);
    expect(lc.pickAutoEnterSlot(SLOTS, false)?.id).toBe(String(GUID));
  });
});

describe('UX.charselect-resume — the world and chargen resumes are unchanged; Entering World resumes the enter', () => {
  it('an in-world drop is the world resume: re-enters the same character', () => {
    const lc = new SessionLifecycle();
    lc.noteEnterWorldRequested(GUID);
    lc.noteWorldEntered();
    expect(armDropResume(lc, state(lc, { screen: screenOf({ gameStarted: true }) }))).toBe('world');
    lc.noteDisconnected();
    expect(drainDelays(lc)).toEqual([2000, 5000, 10000]);
    lc.noteEnterWorldRequested(GUID);
    lc.noteWorldEntered();
    lc.noteDisconnected();
    lc.nextResumeDelay();
    expect(lc.resumingWorld).toBe(true);
    expect(lc.resumingCharSelect).toBe(false);
    expect(lc.pickAutoEnterSlot(SLOTS, false)?.id).toBe(String(GUID));
  });

  it('a chargen drop is the chargen resume (its draft kept first), not a char-select one', () => {
    const lc = new SessionLifecycle();
    const kind = armDropResume(lc, state(lc, {
      screen: screenOf({ uiScreen: 'character-create' }),
      keepChargenDraft: () => { lc.beginChargenResume(); return true; },
    }));
    expect(kind).toBe('chargen');
    expect(lc.nextResumeDelay()).toBe(2000);
    expect(lc.resumingChargen).toBe(true);
    expect(lc.resumingCharSelect).toBe(false);
    expect(lc.resumingWorld).toBe(false);
    expect(lc.pickAutoEnterSlot(SLOTS, true)).toBeNull();
  });

  it('a drop while Entering World waited resumes the enter of the chosen character', () => {
    const lc = new SessionLifecycle();
    lc.noteLoggedOut(); // an earlier logout does not matter: the player chose a character since
    lc.noteEnterWorldRequested(OTHER);
    expect(armDropResume(lc, state(lc))).toBe('enter');
    lc.noteDisconnected();
    expect(lc.nextResumeDelay()).toBe(2000);
    expect(lc.resumingWorld).toBe(true);
    expect(lc.pickAutoEnterSlot(SLOTS, false)?.id).toBe(String(OTHER));
  });
});

describe('UX.charselect-resume — GameUI keeps the selection across the connecting screen', () => {
  const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'requestAnimationFrame'] as const;
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let domWindow: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GameUICtor: any;
  const slot = (id: string, name: string): CharacterSlot => ({ id, name, level: 1, heritage: 1, gender: 1, location: '', lastPlayed: 0 } as CharacterSlot);

  beforeAll(async () => {
    domWindow = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
    installDomGlobals(domWindow, DOM_GLOBALS, saved, 'functions');
    GameUICtor = (await import('../packages/renderer/src/ui/GameUI.js')).GameUI;
  });
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

  it('the selected row comes back after the resume; a plain reconnect still starts from the default pick', () => {
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    const ui = new GameUICtor(container, {});
    const set = [slot('1', 'A'), slot('2', 'B')];
    ui.showCharacterSelect(set, 11);
    ui.selectScreen.selectCharacter(ui.selectScreen.slots.findIndex((c: CharacterSlot) => c.id === '2'));
    const selected = ui.charSelectSelectionId;
    expect(selected).toBe('2');
    ui.showConnectingScreen();
    expect(ui.charSelectSelectionId).toBeUndefined(); // Please Wait is up: nothing to keep from it
    ui.showCharacterSelect(set, 11, { selectId: selected });
    expect(ui.selectScreen.selectedCharacter?.id).toBe('2');
    ui.showConnectingScreen();
    ui.showCharacterSelect(set, 11);
    expect(ui.selectScreen.selectedCharacter?.id).toBe('1');
  });
});

describe('UX.charselect-resume — telemetry', () => {
  it("resume_ended 'charselect_restored' passes the bridge as it is", () => {
    const sent: PreworldEvent[] = [];
    const r = new PreworldReporter({
      endpoint: 'http://x/client-preworld', build: 'eb3bcb5e', era: () => 'eor', server: () => 'coldeve',
      screen: () => 'char-select', chargenStep: () => null, now: () => 1, trace: 'feedc0de12345678',
      send: (_u, raw) => { sent.push(JSON.parse(raw) as PreworldEvent); },
    });
    r.resumeEnded('charselect_restored');
    expect(sent).toHaveLength(1);
    expect(sanitizeClientPreworld(sent[0])).toMatchObject({ outcome: 'resume_ended', token: 'charselect_restored', screen: 'char-select' });
  });
});
