/**
 * BUG.ac1999-relogin-resume-pingpong (2026-11-08) — proven live on the local
 * AC1999 server with two webAC sessions on one account (lgate99, two
 * browsers): the second login made the server kill the first without a word
 * (Network.cpp CNetwork::AcceptClientLogin, "Re-connect for account lgate99 ->
 * dropping stale session", CClient::Kill), the killed page saw only silence,
 * its quiet resume logged back in and killed the other session, which resumed
 * in turn: a takeover every ~40 s, forever. Prod trace 36bd770743abbfc9 is the
 * same against a client outside webAC. Retail 1999 had no resume: the killed
 * client showed the Disconnected screen.
 *
 * Now a session an automatic resume brought back that is lost to server
 * silence again within RESUME_SILENT_AGAIN_WINDOW_MS, on a server that kills
 * silently on a re-login (EraProfile.reloginKillsSilently: only the AC1999
 * server), is not resumed: the Disconnected screen, resume_ended silent_again.
 * A first silent drop still resumes; socket closes, our own stalls and every
 * other era keep the usual resume.
 *
 * Drives the real SessionLifecycle, UnexpectedDrop (armDropResume,
 * handleUnexpectedDrop, silentReloginDrop), SessionLiveness.sessionDropped and
 * the real ERA_PROFILES, in main.ts's order of calls.
 */
import { describe, expect, it } from 'vitest';
import {
  SessionLifecycle,
} from '../packages/renderer/src/session/SessionLifecycle.js';
import { armDropResume, handleUnexpectedDrop, silentReloginDrop } from '../packages/renderer/src/session/UnexpectedDrop.js';
import { sessionDropped } from '../packages/renderer/src/session/SessionLiveness.js';
import { ERA_PROFILES, EOR_ERA_ID, type EraProfile } from '../packages/renderer/src/era/EraProfiles.js';
import { RESUME_DELAYS_MS, RESUME_HEALTHY_MS, RESUME_SILENT_AGAIN_WINDOW_MS } from '../packages/renderer/src/session/RetryPolicy.js';

const GUID = 0x50000001;
const SLOTS = [{ id: String(GUID) }];
const AC1999 = ERA_PROFILES['ac1999-retail'];
const EOR = ERA_PROFILES[EOR_ERA_ID];

type Screen = 'char-select' | 'world' | 'disconnected';
type EndCause = 'server_silent' | 'link_dead' | 'socket_closed' | 'client_suspended' | 'server_disconnect';

/** One page as main.ts runs it, on a test clock. */
class Page {
  readonly lc = new SessionLifecycle();
  screen: Screen = 'char-select';
  now = 1_000_000;
  attempts: number[] = [];
  ended: string[] = [];
  constructor(readonly era: EraProfile = AC1999) {}

  /** main.ts 'disconnected' (or the link check's handleUnexpectedDrop): arm, note, schedule, or the Disconnected screen. */
  drop(endCause: EndCause): 'resuming' | 'disconnected' {
    const kind = armDropResume(this.lc, {
      unexpected: sessionDropped({ everOpened: true, deliberate: false }),
      wasInWorld: this.lc.inWorld,
      enterPending: this.lc.enterWorldPending,
      screen: this.screen === 'world' ? 'in-world' : this.screen,
      keepChargenDraft: () => false,
      selection: () => String(GUID),
    });
    this.lc.noteDisconnected();
    if (kind !== null && this.scheduleResume({ silentRelogin: silentReloginDrop(endCause, this.era) })) return 'resuming';
    this.serverDied();
    return 'disconnected';
  }

  /** main.ts scheduleResume, with its telemetry. */
  scheduleResume(opts: { silentRelogin?: boolean } = {}): boolean {
    const wasResuming = this.lc.resumingAfterDrop;
    const delay = this.lc.nextResumeDelay({ silentRelogin: opts.silentRelogin, now: this.now });
    if (delay === null) {
      const bound = this.lc.resumeBound;
      if (bound === 'silent_again') this.ended.push('silent_again');
      else if (bound) this.ended.push(bound === 'chain' ? 'loop_chain_spent' : 'loop_page_cap');
      else if (wasResuming) this.ended.push('budget_spent');
      return false;
    }
    this.now += delay;
    this.attempts.push(delay);
    return true;
  }

  /** main.ts raiseServerDied. */
  serverDied(): void {
    this.lc.endResume();
    this.screen = 'disconnected';
  }

  /** The login got in: the character list (a resume lands, or auto-enters its character). */
  characterList(): void {
    this.now += 30;
    const { charSelect } = this.lc.takeListResume(this.now);
    this.screen = 'char-select';
    if (charSelect) return;
    if (this.lc.pickAutoEnterSlot(SLOTS, false)) this.enter();
  }

  enter(): void {
    this.lc.noteEnterWorldRequested(GUID);
  }

  playerCreate(): void {
    this.now += 500;
    this.lc.noteWorldEntered(this.now);
    this.screen = 'world';
  }

  /** The resume's login got in and (for a world resume) entered. */
  resumeLands(): void {
    this.characterList();
    if (this.lc.enterWorldPending) this.playerCreate();
  }
}

function inWorld(era: EraProfile = AC1999): Page {
  const p = new Page(era);
  p.enter();
  p.playerCreate();
  return p;
}

describe('silentReloginDrop — which drops can be a silent re-login kill', () => {
  it('AC1999: server silence (the connection\'s own, or the 40 s link check) only', () => {
    expect(AC1999.reloginKillsSilently).toBe(true);
    expect(silentReloginDrop('server_silent', AC1999)).toBe(true);
    expect(silentReloginDrop('link_dead', AC1999)).toBe(true);
    for (const c of ['socket_closed', 'client_suspended', 'server_disconnect', 'server_net_error', 'local', null, undefined]) {
      expect(silentReloginDrop(c, AC1999)).toBe(false);
    }
  });

  it('every other era: never (their servers refuse a taken-over session in words)', () => {
    for (const era of Object.values(ERA_PROFILES)) {
      if (era.id === 'ac1999-retail') continue;
      expect(era.reloginKillsSilently ?? false).toBe(false);
      expect(silentReloginDrop('server_silent', era)).toBe(false);
      expect(silentReloginDrop('link_dead', era)).toBe(false);
    }
  });
});

describe('BUG.ac1999-relogin-resume-pingpong — a resumed session lost to silence again is not resumed', () => {
  it('a first silent drop in the world resumes (a server hiccup or restart still recovers)', () => {
    const p = inWorld();
    expect(p.lc.resumedSessionSince).toBeNull();
    expect(p.drop('link_dead')).toBe('resuming');
    expect(p.attempts).toEqual([RESUME_DELAYS_MS[0]]);
    p.resumeLands();
    expect(p.screen).toBe('world');
    expect(p.lc.resumedSessionSince).toBe(p.now);
  });

  it('silent again within the window after that resume: the Disconnected screen, resume_ended silent_again', () => {
    const p = inWorld();
    p.drop('link_dead');
    p.resumeLands();
    p.now += 42_000; // the other side's resume took the account back; our link check finds it 40 s on
    expect(p.drop('link_dead')).toBe('disconnected');
    expect(p.lc.resumeBound).toBe('silent_again');
    expect(p.ended).toEqual(['silent_again']);
    expect(p.attempts).toEqual([RESUME_DELAYS_MS[0]]);
    expect(p.lc.resumingAfterDrop).toBe(false);
    // The give-up clears the mark: the player's own next login starts afresh.
    expect(p.lc.resumedSessionSince).toBeNull();
  });

  it('the connection\'s own server_silent (60 s) counts the same as the link check', () => {
    const p = inWorld();
    p.drop('server_silent');
    p.resumeLands();
    p.now += 60_000;
    expect(p.drop('server_silent')).toBe('disconnected');
    expect(p.ended).toEqual(['silent_again']);
  });

  it('window edges: just inside stops, at the window resumes', () => {
    const a = inWorld();
    a.drop('link_dead');
    a.resumeLands();
    a.now += RESUME_SILENT_AGAIN_WINDOW_MS - 1;
    expect(a.drop('link_dead')).toBe('disconnected');

    const b = inWorld();
    b.drop('link_dead');
    b.resumeLands();
    b.now += RESUME_SILENT_AGAIN_WINDOW_MS;
    expect(b.drop('link_dead')).toBe('resuming');
    expect(b.attempts).toEqual([RESUME_DELAYS_MS[0], RESUME_DELAYS_MS[0]]);
  });

  it('a socket close / 1006, a network outage or our own stall after a resume still resumes', () => {
    for (const cause of ['socket_closed', 'client_suspended', 'server_disconnect'] as const) {
      const p = inWorld();
      p.drop('link_dead');
      p.resumeLands();
      p.now += 60_000;
      expect(p.drop(cause)).toBe('resuming');
      p.resumeLands();
      expect(p.screen).toBe('world');
      expect(p.ended).toEqual([]);
    }
  });

  it('a socket-close resume followed by a silent drop: that session came from a resume, so it stops', () => {
    const p = inWorld();
    p.drop('socket_closed'); // a bridge drain's hard cut
    p.resumeLands();
    p.now += 90_000;
    expect(p.drop('server_silent')).toBe('disconnected');
    expect(p.ended).toEqual(['silent_again']);
  });

  it('an attempt of a resume under way that meets silence is not cut short (the rule is for new resumes)', () => {
    const p = inWorld();
    p.drop('link_dead');
    p.resumeLands();
    p.now += 60_000;
    // A non-silent drop starts a resume; its first attempt's session then goes silent before the world.
    expect(p.drop('socket_closed')).toBe('resuming');
    expect(p.drop('server_silent')).toBe('resuming');
    expect(p.attempts).toEqual([RESUME_DELAYS_MS[0], RESUME_DELAYS_MS[0], RESUME_DELAYS_MS[1]]);
  });

  it('the player\'s own login after the Disconnected screen gets one resume again on its first silent drop', () => {
    const p = inWorld();
    p.drop('link_dead');
    p.resumeLands();
    p.now += 42_000;
    expect(p.drop('link_dead')).toBe('disconnected');
    // Quit Game → a fresh connect cycle, entered by the player.
    p.now += 5_000;
    p.enter();
    p.playerCreate();
    p.now += 60_000;
    expect(p.drop('link_dead')).toBe('resuming');
  });

  it('a logout to character select ends the resumed session: its next silent drop resumes', () => {
    const p = inWorld();
    p.drop('link_dead');
    p.resumeLands();
    p.lc.noteLoggedOut();
    p.screen = 'char-select';
    p.now += 30_000;
    expect(p.lc.resumedSessionSince).toBeNull();
    expect(p.drop('server_silent')).toBe('resuming');
  });

  it('character select (prod trace 36bd770743abbfc9): charselect_restored, then silent again → the Disconnected screen', () => {
    const p = new Page();
    p.screen = 'char-select';
    expect(p.drop('server_silent')).toBe('resuming');
    p.characterList();
    expect(p.screen).toBe('char-select');
    expect(p.lc.resumedSessionSince).not.toBeNull();
    p.now += 57_000; // the server cut the resumed session 56-58 s after the resume
    expect(p.drop('server_silent')).toBe('disconnected');
    expect(p.ended).toEqual(['silent_again']);
    expect(p.lc.resumingCharSelect).toBe(false);
  });

  it('the link check path (handleUnexpectedDrop) stops the same way', () => {
    const p = inWorld();
    p.drop('link_dead');
    p.resumeLands();
    p.now += 42_000;
    const log: string[] = [];
    const verdict = handleUnexpectedDrop({
      lifecycle: p.lc,
      reportLeft: () => log.push('world_left'),
      teardownWorld: () => log.push('teardown'),
      // main.ts: scheduleResume({ silentRelogin: silentReloginDrop(cause, activeEra) })
      scheduleResume: () => p.scheduleResume({ silentRelogin: silentReloginDrop('link_dead', p.era) }),
      raiseServerDied: () => { log.push('server_died'); p.serverDied(); },
    });
    expect(verdict).toBe('server_died');
    expect(log).toEqual(['world_left', 'teardown', 'server_died']);
    expect(p.ended).toEqual(['silent_again']);
  });

  it('other eras are unchanged: a silent drop after a resume resumes again (end of retail, Dark Majesty)', () => {
    for (const era of [EOR, ERA_PROFILES['classic-dereth'], ERA_PROFILES['classicace-customdm']]) {
      const p = inWorld(era);
      p.drop('link_dead');
      p.resumeLands();
      p.now += 42_000;
      expect(p.drop('link_dead')).toBe('resuming');
      expect(p.ended).toEqual([]);
    }
  });

  it('the other loop guards still apply first-come: a quick drop after a full-budget resume is still loop_chain_spent', () => {
    const p = inWorld(EOR);
    p.drop('socket_closed');
    p.drop('socket_closed');
    p.drop('socket_closed');
    p.resumeLands();
    p.now += RESUME_HEALTHY_MS - 1;
    expect(p.drop('socket_closed')).toBe('disconnected');
    expect(p.ended).toEqual(['loop_chain_spent']);
  });
});

/**
 * The live repro, simulated: two pages on one account against an AC1999 server
 * whose login kills the account's other session silently. A page notices the
 * silence after its link check (40 s in the world) or its connection's
 * server_silent (60 s at character select), then resumes after RESUME_DELAYS_MS.
 */
describe('two sessions on one account against the AC1999 server', () => {
  function run(screens: { a: 'world' | 'char-select'; b: 'world' | 'char-select' }, era: EraProfile = AC1999) {
    const pages = { a: new Page(era), b: new Page(era) };
    let t = 0;
    let holder: 'a' | 'b' | null = null;
    const takeovers: { at: number; by: 'a' | 'b'; auto: boolean }[] = [];
    const detectAt: Record<'a' | 'b', number | null> = { a: null, b: null };
    const silenceMs = (k: 'a' | 'b') => (pages[k].screen === 'world' ? 40_000 : 60_000);
    const login = (k: 'a' | 'b', auto: boolean) => {
      const other = k === 'a' ? 'b' : 'a';
      if (holder === other) { takeovers.push({ at: t, by: k, auto }); detectAt[other] = t + silenceMs(other); }
      holder = k;
    };
    const land = (k: 'a' | 'b', screen: 'world' | 'char-select') => {
      const p = pages[k];
      p.now = t;
      if (screen === 'world') { p.enter(); p.playerCreate(); } else p.screen = 'char-select';
    };
    // A is on the account; B logs in from elsewhere 10 s later.
    land('a', screens.a); login('a', false);
    t = 10_000; land('b', screens.b); login('b', false);
    for (let i = 0; i < 100; i++) {
      const next = (['a', 'b'] as const).filter((k) => detectAt[k] !== null).sort((x, y) => detectAt[x]! - detectAt[y]!)[0];
      if (!next) break;
      t = detectAt[next]!;
      detectAt[next] = null;
      const p = pages[next];
      p.now = t;
      if (p.drop(p.screen === 'world' ? 'link_dead' : 'server_silent') === 'disconnected') continue;
      t = p.now; // the resume's delay
      login(next, true);
      p.resumeLands();
    }
    return { pages, takeovers, holder };
  }

  it('in the world: one automatic takeover each, then the older page stops on the Disconnected screen', () => {
    const r = run({ a: 'world', b: 'world' });
    expect(r.takeovers.filter((x) => x.auto).map((x) => x.by)).toEqual(['a', 'b']);
    expect(r.takeovers.length).toBe(3); // B's own login, A's resume, B's resume
    expect(r.pages.a.screen).toBe('disconnected');
    expect(r.pages.a.ended).toEqual(['silent_again']);
    expect(r.pages.b.screen).toBe('world');
    expect(r.holder).toBe('b');
  });

  it('at character select (the prod shape): the same bound', () => {
    const r = run({ a: 'char-select', b: 'char-select' });
    expect(r.takeovers.filter((x) => x.auto).length).toBe(2);
    expect(r.pages.a.screen).toBe('disconnected');
    expect(r.pages.b.screen).toBe('char-select');
  });

  it('without the era flag the same two pages keep trading the account (the bug)', () => {
    const noFlag: EraProfile = { ...AC1999, reloginKillsSilently: false };
    const r = run({ a: 'world', b: 'world' }, noFlag);
    expect(r.takeovers.filter((x) => x.auto).length).toBeGreaterThan(10);
  });
});
