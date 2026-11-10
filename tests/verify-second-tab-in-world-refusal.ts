/**
 * BUG.second-tab-in-world-refusal — production 2026-11-03 (DreamWeave, ACE,
 * one player): a tab in the world, a second tab of the same browser created a
 * character and entered; the server answered every enter with CharacterError
 * 0x0D and ours retried for 75 s behind a silent Entering World dialog. The
 * player left three times (5-22 s) and played another world.
 *
 * Drives the real modules:
 *  - AccountTabGuard on a shared fake BroadcastChannel: the world query is
 *    answered only by tabs in the world on the same server (any account), and
 *    the logout request reaches only the holder of the asking tab's exact key
 *    (never another account, another world, a tab at character select, or a
 *    lone tab);
 *  - InWorldHolder's decision and texts;
 *  - SessionLifecycle's fresh 1 s budget once the holder was asked to leave;
 *  - the 0x0D notice's next step once the retries are spent;
 *  - GameUI's Entering World status line (happy-dom).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { CharacterError } from '@ac/shared';
import {
  AccountTabGuard, accountSessionKey, serverOfSessionKey, type SessionChannelLike, type WorldHolder,
} from '../packages/renderer/src/session/AccountTabGuard';
import {
  inWorldHolderAction, IN_WORLD_WAIT_STATUS, HOLDER_LEAVING_STATUS, LOGGED_OUT_FOR_OTHER_TAB_TEXT,
  InWorldEnterWait, otherAccountStatus, sameAccountStatus,
} from '../packages/renderer/src/session/InWorldHolder';
import {
  SessionLifecycle,
} from '../packages/renderer/src/session/SessionLifecycle';
import { characterErrorNotice, IN_WORLD_ELSEWHERE_HINT } from '../packages/renderer/src/ui/ConnectionNotices';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { IN_WORLD_RETRY_BUDGET, IN_WORLD_RETRY_DELAY_MS, RESUME_IN_WORLD_RETRY_DELAYS_MS } from '../packages/renderer/src/session/RetryPolicy';

/** BroadcastChannel semantics: every other channel on the hub gets the message (not the sender). */
class FakeChannelHub {
  private channels: FakeChannel[] = [];
  open(): FakeChannel { const c = new FakeChannel(this); this.channels.push(c); return c; }
  deliver(from: FakeChannel, data: unknown): void {
    for (const c of this.channels) if (c !== from) c.listeners.forEach(l => l({ data: structuredClone(data) }));
  }
}
class FakeChannel implements SessionChannelLike {
  listeners: ((ev: { data: unknown }) => void)[] = [];
  constructor(private hub: FakeChannelHub) {}
  postMessage(m: unknown): void { this.hub.deliver(this, m); }
  addEventListener(_t: 'message', l: (ev: { data: unknown }) => void): void { this.listeners.push(l); }
}

const DW = 'wss://bridge.example/connect?server=1f069f0d-1b2a-421b-a723-297486a82cd7';
const OTHER_WORLD = 'wss://bridge.example/connect?server=a94b42cb-898c-4209-9246-82d21211aac1';

interface Tab { guard: AccountTabGuard; world: { name: string | null } | null; loggedOut: number; stoodDown: number }

/** A page: its guard, whether its character is in the world (main.ts reads SessionLifecycle.inWorld), its handlers. */
function makeTab(hub: FakeChannelHub, id: string): Tab {
  const tab: Tab = {
    world: null, loggedOut: 0, stoodDown: 0,
    guard: undefined as unknown as AccountTabGuard,
  };
  tab.guard = new AccountTabGuard({
    channel: hub.open(),
    tabId: id,
    onStandDown: () => { tab.stoodDown++; },
    onLogoutRequested: () => { tab.loggedOut++; },
    worldCharacter: () => tab.world,
    // Delivery on the fake hub is synchronous: the answers are in before the wait ends.
    setTimeout: (fn) => { fn(); return 0; },
  });
  return tab;
}

describe('BUG.second-tab-in-world-refusal — who holds the world, asked across tabs', () => {
  beforeAll(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); });

  it('a tab in the world on the same server under another account answers, named, not as this account', async () => {
    const hub = new FakeChannelHub();
    const a = makeTab(hub, 'tab-a');
    const b = makeTab(hub, 'tab-b');
    a.guard.claim(accountSessionKey(DW, 'mainacct'));
    a.world = { name: 'Eldrin' };
    const keyB = accountSessionKey(DW, 'newacct');
    b.guard.claim(keyB);
    // A different account: B's claim does not make A stand down.
    expect(a.stoodDown).toBe(0);
    const holders = await b.guard.queryWorldHolders(keyB);
    expect(holders).toEqual([{ tab: 'tab-a', character: 'Eldrin', sameAccount: false, inWorld: true }]);
    // The logout path never fires for another account: nothing sent, and A stays in.
    expect(b.guard.requestLogout(holders[0])).toBe(false);
    expect(a.loggedOut).toBe(0);
    expect(a.guard.heldKey).toBe(accountSessionKey(DW, 'mainacct'));
  });

  it('a forged request under another key, or to a tab at character select, logs nobody out', () => {
    const hub = new FakeChannelHub();
    const a = makeTab(hub, 'tab-a');
    const b = makeTab(hub, 'tab-b');
    const keyA = accountSessionKey(DW, 'mainacct');
    a.guard.claim(keyA);
    a.world = { name: 'Eldrin' };
    b.guard.claim(accountSessionKey(DW, 'newacct'));
    const sender = hub.open();
    sender.postMessage({ kind: 'webac-logout-request', key: accountSessionKey(DW, 'newacct'), to: 'tab-a', from: 'tab-b' });
    sender.postMessage({ kind: 'webac-logout-request', key: accountSessionKey(OTHER_WORLD, 'mainacct'), to: 'tab-a', from: 'tab-b' });
    expect(a.loggedOut).toBe(0);
    // The right key, but A is at character select (not in the world): nothing to log out.
    a.world = null;
    sender.postMessage({ kind: 'webac-logout-request', key: keyA, to: 'tab-a', from: 'tab-b' });
    expect(a.loggedOut).toBe(0);
    // The right key, in the world, addressed to another tab: not A's.
    a.world = { name: 'Eldrin' };
    sender.postMessage({ kind: 'webac-logout-request', key: keyA, to: 'tab-c', from: 'tab-b' });
    expect(a.loggedOut).toBe(0);
    expect(a.guard.heldKey).toBe(keyA);
  });

  it('tabs on another world, at character select, or holding nothing do not answer; a lone tab hears nothing', async () => {
    const hub = new FakeChannelHub();
    const other = makeTab(hub, 'tab-other');
    other.guard.claim(accountSessionKey(OTHER_WORLD, 'mainacct'));
    other.world = { name: 'Elsewhere' };
    const charSelect = makeTab(hub, 'tab-select');
    charSelect.guard.claim(accountSessionKey(DW, 'thirdacct'));
    const launcher = makeTab(hub, 'tab-launcher');
    launcher.world = { name: 'Stale' }; // no key held: it is in no session
    const b = makeTab(hub, 'tab-b');
    const keyB = accountSessionKey(DW, 'newacct');
    b.guard.claim(keyB);
    expect(await b.guard.queryWorldHolders(keyB)).toEqual([]);

    const lone = new AccountTabGuard({ channel: null, onStandDown: () => {} });
    expect(await lone.queryWorldHolders(keyB)).toEqual([]);
    expect(serverOfSessionKey(keyB)).toBe(serverOfSessionKey(accountSessionKey(DW, 'someone')));
  });

  it('the same account in the world in another tab: the request logs out that tab only, once', async () => {
    const hub = new FakeChannelHub();
    const a = makeTab(hub, 'tab-a');
    const c = makeTab(hub, 'tab-c');
    const b = makeTab(hub, 'tab-b');
    const key = accountSessionKey(DW, 'Player1');
    // A holds the key in the world; B's claim crossed / was lost (an older build in A, say):
    // simulate B holding the same key without A having stood down.
    a.guard.claim(key);
    a.world = { name: 'Eldrin' };
    c.guard.claim(accountSessionKey(DW, 'otheracct'));
    c.world = { name: 'Cobalt' };
    (b.guard as unknown as { held: { key: string; at: number } }).held = { key, at: 0 };
    const holders = await b.guard.queryWorldHolders(key);
    expect(holders).toContainEqual({ tab: 'tab-a', character: 'Eldrin', sameAccount: true, inWorld: true });
    expect(holders).toContainEqual({ tab: 'tab-c', character: 'Cobalt', sameAccount: false, inWorld: true });
    const action = inWorldHolderAction(holders, 'retail');
    expect(action.kind).toBe('offer-logout');
    if (action.kind !== 'offer-logout') return;
    expect(action.holder.tab).toBe('tab-a');
    expect(b.guard.requestLogout(action.holder)).toBe(true);
    expect(a.loggedOut).toBe(1);
    expect(a.guard.heldKey).toBeNull();
    expect(c.loggedOut).toBe(0);
    // A repeat finds nothing to act on.
    expect(b.guard.requestLogout(action.holder)).toBe(true);
    expect(a.loggedOut).toBe(1);
  });
});

describe('BUG.second-tab-in-world-refusal — what the player sees', () => {
  const retail = characterErrorNotice(CharacterError.EnterGameCharacterInWorld).text.split('\n\n')[0];
  const other: WorldHolder = { tab: 't', character: 'Eldrin', sameAccount: false };
  const same: WorldHolder = { tab: 't2', character: 'Mira', sameAccount: true };

  it('another account: retail text, then the line naming the other tab\'s character', () => {
    const action = inWorldHolderAction([other], retail);
    expect(action.kind).toBe('other-account');
    if (action.kind !== 'other-account') return;
    expect(action.text.startsWith(`${retail}\n\n`)).toBe(true);
    expect(action.text).toContain('Another tab of this browser is in the world on this server as Eldrin.');
    expect(action.text).toContain('log out in that tab, then enter again');
  });

  it('the same account wins over another, and asks before logging anything out', () => {
    const action = inWorldHolderAction([other, same], retail);
    expect(action.kind).toBe('offer-logout');
    if (action.kind !== 'offer-logout') return;
    expect(action.text).toBe('This account is already in the world in another tab, as Mira.\n\nLog out that tab and enter here?');
    expect(inWorldHolderAction([{ ...same, character: null }], retail).kind).toBe('offer-logout');
  });

  it('no tab: none (the retries go on)', () => {
    expect(inWorldHolderAction([], retail)).toEqual({ kind: 'none' });
  });

  it('retail\'s 0x0D dialog keeps its text and, once the retries are spent, says where else the character can be', () => {
    const notice = characterErrorNotice(CharacterError.EnterGameCharacterInWorld);
    expect(notice.surface).toBe('dialog');
    expect(notice.text).toBe(`${retail}\n\n${IN_WORLD_ELSEWHERE_HINT}`);
    expect(retail).toBe('One of your characters is still in the world. Please try again in a few minutes.');
    expect(LOGGED_OUT_FOR_OTHER_TAB_TEXT).toMatch(/another tab/);
  });
});

describe('BUG.second-tab-in-world-refusal — the enter after the holder was asked to leave', () => {
  it('a fresh budget at the 1 s cadence; a new enter or a refusal goes back to the usual waits', () => {
    const life = new SessionLifecycle();
    life.noteEnterWorldRequested(0x50000001);
    expect(life.characterInWorldRefusal()).toBe('retry');
    expect(life.inWorldRefusalCount).toBe(1);
    expect(life.inWorldRetryDelay()).toBe(IN_WORLD_RETRY_DELAY_MS);
    life.noteHolderLeaving();
    expect(life.inWorldRefusalCount).toBe(0);
    for (let i = 0; i < RESUME_IN_WORLD_RETRY_DELAYS_MS.length; i++) {
      expect(life.characterInWorldRefusal()).toBe('retry');
      expect(life.inWorldRetryDelay()).toBe(1000);
    }
    expect(life.characterInWorldRefusal()).toBe('retry');
    expect(life.inWorldRetryDelay()).toBe(IN_WORLD_RETRY_DELAY_MS);
    // The budget still ends in retail's dialog.
    for (let i = life.inWorldRefusalCount; i < IN_WORLD_RETRY_BUDGET; i++) life.characterInWorldRefusal();
    expect(life.characterInWorldRefusal()).toBe('dialog');

    life.noteEnterWorldRequested(0x50000001);
    life.noteHolderLeaving();
    life.noteEnterRefused();
    life.noteEnterWorldRequested(0x50000001);
    life.characterInWorldRefusal();
    expect(life.inWorldRetryDelay()).toBe(IN_WORLD_RETRY_DELAY_MS);
  });
});

/**
 * The page around InWorldEnterWait, as main.ts wires it: a real SessionLifecycle, a real
 * AccountTabGuard on the fake hub, fake timers and a recording UI.
 */
function makeEnterPage(hub: FakeChannelHub, account: string, opts: { lostClaim?: boolean } = {}) {
  const life = new SessionLifecycle();
  const tab = makeTab(hub, `tab-${account}`);
  const key = accountSessionKey(DW, account);
  // lostClaim: the tab holds the key but its claim never reached the other tab (an older
  // build there, a crossed claim), the only way two tabs hold one key in the world.
  if (opts.lostClaim) (tab.guard as unknown as { held: { key: string; at: number } }).held = { key, at: 0 };
  else tab.guard.claim(key);
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const page = {
    life, tab, sent: 0, status: [] as (string | null)[],
    offers: [] as { text: string; answer: (yes: boolean) => void; open: boolean }[],
    reported: [] as string[],
    wait: undefined as unknown as InWorldEnterWait,
    /** Fire the pending retry timer; its delay, or -1 when none is pending. */
    fireRetry(): number {
      const t = [...timers].reverse().find(x => x.live);
      if (!t) return -1;
      t.live = false;
      t.fn();
      return t.ms;
    },
    get pendingTimers(): number { return timers.filter(x => x.live).length; },
    /** A new enter (character select's ENTER, chargen's FINISH OK): request + its 0xF7C8. */
    enter(): void { life.noteEnterWorldRequested(0x50000002); page.sent++; },
  };
  page.wait = new InWorldEnterWait({
    verdict: () => life.characterInWorldRefusal(),
    retryDelay: () => life.inWorldRetryDelay(),
    refusalCount: () => life.inWorldRefusalCount,
    enterSerial: () => life.enterSerial,
    resuming: () => life.resumingAfterDrop,
    waitingOnHolder: () => life.waitingOnHolder,
    mayRetry: () => life.mayRetryEnterWorld(),
    holderLeaving: () => life.noteHolderLeaving(),
    queryHolders: () => tab.guard.queryWorldHolders(key),
    requestLogout: (h) => tab.guard.requestLogout(h),
    sendRetry: () => { page.sent++; },
    schedule: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return () => { t.live = false; }; },
    now: () => 0,
    setStatus: (text) => { page.status.push(text); },
    showEnteringWorld: () => {},
    confirm: (text, answer) => { const o = { text, answer, open: true }; page.offers.push(o); return () => { o.open = false; }; },
    report: (kind) => { page.reported.push(kind); },
  });
  return page;
}
const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };
const IN_WORLD_NOTICE = (): string => characterErrorNotice(CharacterError.EnterGameCharacterInWorld).text;
const retailOf = (notice: string): string => notice.split('\n\n')[0];

describe('BUG.second-tab-in-world-refusal — the retries never stop for a holder (live check 2026-11-03)', () => {
  beforeAll(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });

  it('another account in tab A, B\'s own crashed character the real holder: B names A under Entering World, keeps retrying, gets in', async () => {
    const hub = new FakeChannelHub();
    const a = makeTab(hub, 'tab-a');
    a.guard.claim(accountSessionKey(DW, 'testacjs2'));
    a.world = { name: '+TestPartner' };
    const b = makeEnterPage(hub, 'testacjs3');
    b.enter();
    // ACE: the crashed tab's character is still in the world (0x0D).
    expect(b.wait.onRefusal()).toBe('retry');
    await flush();
    expect(b.reported).toEqual(['other-account']);
    expect(b.wait.seenHolder).toMatchObject({ character: '+TestPartner', sameAccount: false });
    expect(b.status).toEqual([IN_WORLD_WAIT_STATUS, otherAccountStatus({ tab: 'tab-a', character: '+TestPartner', sameAccount: false })]);
    expect(b.offers).toEqual([]);
    expect(a.loggedOut).toBe(0);
    // The retries go on at the usual cadence (ACE frees the crashed character ~14 s later).
    expect(b.fireRetry()).toBe(IN_WORLD_RETRY_DELAY_MS);
    expect(b.sent).toBe(2);
    for (let i = 0; i < 4; i++) {
      expect(b.wait.onRefusal()).toBe('retry');
      expect(b.fireRetry()).toBe(IN_WORLD_RETRY_DELAY_MS);
    }
    expect(b.sent).toBe(6);
    expect(b.reported).toEqual(['other-account']); // asked once per enter
    // The server lets the character in: nothing pending.
    b.life.noteWorldEntered();
    b.wait.end();
    expect(b.pendingTimers).toBe(0);
    expect(b.fireRetry()).toBe(-1);
  });

  it('the budget spent with another account\'s tab seen: the final dialog names it; the next ENTER starts clean', async () => {
    const hub = new FakeChannelHub();
    const a = makeTab(hub, 'tab-a');
    a.guard.claim(accountSessionKey(DW, 'testacjs2'));
    a.world = { name: '+TestPartner' };
    const b = makeEnterPage(hub, 'testacjs3');
    b.enter();
    b.wait.onRefusal();
    await flush();
    let verdict: string = 'retry';
    let refusals = 1;
    while (verdict === 'retry') {
      expect(b.fireRetry()).toBe(IN_WORLD_RETRY_DELAY_MS);
      verdict = b.wait.onRefusal();
      refusals++;
    }
    expect(verdict).toBe('dialog');
    expect(refusals).toBe(IN_WORLD_RETRY_BUDGET + 1);
    expect(b.pendingTimers).toBe(0);
    const notice = IN_WORLD_NOTICE();
    const text = b.wait.finalText(notice, retailOf(notice));
    expect(text.startsWith(`${retailOf(notice)}\n\n`)).toBe(true);
    expect(text).toContain('Another tab of this browser is in the world on this server as +TestPartner.');
    // The next ENTER: A has left; nothing carried over.
    a.world = null;
    b.enter();
    expect(b.wait.onRefusal()).toBe('retry');
    await flush();
    expect(b.wait.seenHolder).toBeNull();
    expect(b.wait.finalText(notice, retailOf(notice))).toBe(notice);
  });

  it('no tab answers: the plain wait line; the final dialog is retail\'s text + the next step', async () => {
    const b = makeEnterPage(new FakeChannelHub(), 'testacjs3');
    b.enter();
    b.wait.onRefusal();
    await flush();
    expect(b.reported).toEqual(['none']);
    expect(b.status).toEqual([IN_WORLD_WAIT_STATUS]);
    expect(b.fireRetry()).toBe(IN_WORLD_RETRY_DELAY_MS);
    const notice = IN_WORLD_NOTICE();
    expect(b.wait.finalText(notice, retailOf(notice))).toBe(notice);
  });

  it('a resume (our own dropped character) never asks the tabs, and retries every second', async () => {
    const hub = new FakeChannelHub();
    const a = makeTab(hub, 'tab-a');
    a.guard.claim(accountSessionKey(DW, 'testacjs2'));
    a.world = { name: '+TestPartner' };
    const b = makeEnterPage(hub, 'testacjs3');
    b.life.noteEnterWorldRequested(0x50000002);
    b.life.noteWorldEntered();
    b.life.noteDisconnected();
    expect(b.life.nextResumeDelay()).not.toBeNull();
    expect(b.life.resumingAfterDrop).toBe(true);
    b.enter();
    expect(b.wait.onRefusal()).toBe('retry');
    await flush();
    expect(b.reported).toEqual([]);
    expect(b.fireRetry()).toBe(1000);
  });

  it('same account: the offer comes up over running retries; No keeps retrying with a line; an unanswered offer is closed by the world', async () => {
    const hub = new FakeChannelHub();
    const a = makeTab(hub, 'tab-a');
    const key = accountSessionKey(DW, 'testacjs3');
    a.guard.claim(key);
    a.world = { name: 'Mira' };
    const b = makeEnterPage(hub, 'testacjs3', { lostClaim: true });
    b.enter();
    b.wait.onRefusal();
    await flush();
    expect(b.offers).toHaveLength(1);
    expect(b.wait.offerOpen).toBe(true);
    // No answer yet: the retry still goes out.
    expect(b.pendingTimers).toBe(1);
    expect(b.fireRetry()).toBe(IN_WORLD_RETRY_DELAY_MS);
    expect(b.sent).toBe(2);
    // No: retries go on, with the line naming the tab; A untouched.
    b.offers[0].answer(false);
    expect(b.status.at(-1)).toBe(sameAccountStatus({ tab: 'tab-a', character: 'Mira', sameAccount: true }));
    expect(a.loggedOut).toBe(0);
    expect(b.wait.onRefusal()).toBe('retry');
    expect(b.pendingTimers).toBe(1);
    const notice = IN_WORLD_NOTICE();
    expect(b.wait.finalText(notice, retailOf(notice))).toContain('This account is in the world in another tab as Mira');

    // Another enter where the player never answers: the world arriving closes the offer.
    b.enter();
    b.wait.onRefusal();
    await flush();
    expect(b.offers).toHaveLength(2);
    expect(b.offers[1].open).toBe(true);
    b.life.noteWorldEntered();
    b.wait.end();
    expect(b.offers[1].open).toBe(false);
    expect(b.pendingTimers).toBe(0);
  });

  it('same account, Yes: only that tab logs out; the enter retries every second on a fresh budget, not doubled', async () => {
    const hub = new FakeChannelHub();
    const a = makeTab(hub, 'tab-a');
    const key = accountSessionKey(DW, 'testacjs3');
    a.guard.claim(key);
    a.world = { name: 'Mira' };
    const c = makeTab(hub, 'tab-c');
    c.guard.claim(accountSessionKey(DW, 'otheracct'));
    c.world = { name: 'Cobalt' };
    const b = makeEnterPage(hub, 'testacjs3', { lostClaim: true });
    b.enter();
    b.wait.onRefusal();
    await flush();
    b.offers[0].answer(true);
    expect(a.loggedOut).toBe(1);
    expect(c.loggedOut).toBe(0);
    expect(b.status.at(-1)).toBe(HOLDER_LEAVING_STATUS);
    expect(b.pendingTimers).toBe(1);
    expect(b.fireRetry()).toBe(1000);
    for (let i = 0; i < 5; i++) {
      expect(b.wait.onRefusal()).toBe('retry');
      expect(b.fireRetry()).toBe(1000);
    }
    expect(b.reported).toEqual(['offer-logout']);
    b.life.noteWorldEntered();
    b.wait.end();
    expect(b.pendingTimers).toBe(0);
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'requestAnimationFrame'] as const;

describe('BUG.second-tab-in-world-refusal — the Entering World status line (GameUI)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  beforeAll(() => installDomGlobals(domWindow, DOM_GLOBALS, saved, 'functions'));
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

  it('says what the enter waits for, and goes with the dialog', async () => {
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    domWindow.document.body.innerHTML = '';
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    const ui = new mod.GameUI(container);
    ui.showCharacterSelect([{ id: '1342177281', name: 'Alpha' }] as unknown as Parameters<typeof ui.showCharacterSelect>[0]);
    // No dialog: nothing to put the line on.
    ui.setEnteringWorldStatus(IN_WORLD_WAIT_STATUS);
    expect(ui.enteringWorldStatusText).toBeNull();
    ui.showEnteringWorldDialog();
    expect(ui.enteringWorldStatusText).toBe('');
    ui.setEnteringWorldStatus(IN_WORLD_WAIT_STATUS);
    expect(ui.enteringWorldStatusText).toBe(IN_WORLD_WAIT_STATUS);
    expect(container.querySelectorAll('#charsel-enteringworld').length).toBe(1);
    expect(container.querySelector('#charsel-enteringworld')!.textContent).toContain('Waiting for the server');
    ui.setEnteringWorldStatus(HOLDER_LEAVING_STATUS);
    expect(container.querySelector('#charsel-enteringworld')!.textContent).toContain('Logging out the other tab');
    ui.hideEnteringWorldDialog();
    expect(ui.enteringWorldStatusText).toBeNull();
  });
});
