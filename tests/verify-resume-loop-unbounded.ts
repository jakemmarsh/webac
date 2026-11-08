/**
 * BUG.resume-loop-unbounded (2026-11-05) — a server that takes the login,
 * sends the character list and drops the session ~30 ms later (locally: a GDL
 * server reached with the wrong era profile) made the page reconnect forever:
 * each resume that came back ended its budget (resume_ended
 * charselect_restored), so the next drop armed a fresh 2 / 5 / 10 s resume.
 * 13 reconnects in 30 s; on a server with per-address caps (AC1999) that
 * pattern risks a ban.
 *
 * Now a drop within RESUME_HEALTHY_MS of a resume that came back continues
 * that resume's budget (three attempts in all, then the Disconnected screen),
 * for every kind of resume (world, enter, chargen, char select), and
 * RESUME_PAGE_CAP attempts in ten minutes is a page-wide backstop. A session
 * up past the window gets a whole budget again; a deliberate close never
 * resumes.
 *
 * Drives the real SessionLifecycle and the drop routing main.ts uses
 * (UnexpectedDrop.armDropResume / handleUnexpectedDrop, SessionLiveness.
 * sessionDropped), with main.ts's order of calls: armDropResume, then
 * noteDisconnected, then scheduleResume (nextResumeDelay); a character list
 * takes a chargen / char-select resume (takeListResume) or auto-enters the
 * world resume's character (pickAutoEnterSlot); PlayerCreate is
 * noteWorldEntered.
 */
import { describe, expect, it } from 'vitest';
import {
  SessionLifecycle, RESUME_DELAYS_MS, RESUME_HEALTHY_MS, RESUME_PAGE_CAP, RESUME_PAGE_CAP_WINDOW_MS,
} from '../packages/renderer/src/session/SessionLifecycle.js';
import { armDropResume, handleUnexpectedDrop, type DropResumeKind } from '../packages/renderer/src/session/UnexpectedDrop.js';
import { sessionDropped } from '../packages/renderer/src/session/SessionLiveness.js';

const GUID = 0x50000001;
const SLOTS = [{ id: String(GUID) }];
/** A socket that had opened and closed under the player. */
const DROP = { everOpened: true, deliberate: false };
/** Our own close (Exit, a logout, a refusal's endRefusedSession). */
const OUR_CLOSE = { everOpened: true, deliberate: true };

type Screen = 'char-select' | 'chargen' | 'world' | 'disconnected';

/** The page as main.ts runs it, on a test clock. */
class Page {
  readonly lc = new SessionLifecycle();
  screen: Screen = 'char-select';
  now = 1_000_000;
  /** Every automatic attempt the page made (the reconnects the server saw). */
  attempts: number[] = [];
  kinds: (DropResumeKind | null)[] = [];

  /** The connection ended (main.ts 'disconnected'): arm, note, schedule, or the Disconnected screen. */
  drop(event = DROP): 'resuming' | 'disconnected' {
    const kind = armDropResume(this.lc, {
      unexpected: sessionDropped(event, true),
      wasInWorld: this.lc.inWorld,
      enterPending: this.lc.enterWorldPending,
      screen: this.screen === 'world' ? 'in-world' : this.screen,
      // main.ts keepChargenDraft: saves the draft and arms the chargen resume when chargen is the screen.
      keepChargenDraft: () => { if (this.screen !== 'chargen') return false; this.lc.beginChargenResume(); return true; },
      selection: () => String(GUID),
    });
    this.kinds.push(kind);
    this.lc.noteDisconnected();
    if (kind !== null && this.scheduleResume()) return 'resuming';
    this.screen = 'disconnected';
    return 'disconnected';
  }

  /** main.ts scheduleResume: the next attempt's delay, or false (the caller shows the Disconnected screen). */
  scheduleResume(): boolean {
    const delay = this.lc.nextResumeDelay({ now: this.now });
    if (delay === null) return false;
    this.now += delay;
    this.attempts.push(delay);
    return true;
  }

  /** The attempt's login got in: the character list, as main.ts handles it. */
  characterList(): void {
    this.now += 30;
    const { chargen, charSelect } = this.lc.takeListResume(this.now);
    if (chargen) { this.screen = 'chargen'; return; }
    if (charSelect) { this.screen = 'char-select'; return; }
    const slot = this.lc.pickAutoEnterSlot(SLOTS, false);
    this.screen = 'char-select';
    if (slot) this.enter();
  }

  enter(): void {
    this.lc.noteEnterWorldRequested(parseInt(SLOTS[0].id, 10));
    this.screen = 'char-select';
  }

  playerCreate(): void {
    this.now += 500;
    this.lc.noteWorldEntered(this.now);
    this.screen = 'world';
  }

  /** The bug's server: every login is accepted (and the world one entered), then dropped 30 ms on. */
  loopUntilDisconnected(maxCycles = 50): void {
    for (let i = 0; i < maxCycles; i++) {
      if (this.drop() === 'disconnected') return;
      this.characterList();
      if (this.lc.enterWorldPending) this.playerCreate();
      this.now += 30;
    }
    throw new Error('the page never stopped reconnecting');
  }
}

/** A page in the world with a character (entered by the player). */
function inWorld(): Page {
  const p = new Page();
  p.enter();
  p.playerCreate();
  return p;
}

describe('BUG.resume-loop-unbounded — a success then an immediate drop continues the same budget', () => {
  it('char select (the reported loop): three attempts in all, 2 / 5 / 10 s, then the Disconnected screen', () => {
    const p = new Page();
    p.loopUntilDisconnected();
    expect(p.attempts).toEqual([...RESUME_DELAYS_MS]);
    expect(p.kinds.slice(0, 3)).toEqual(['charselect', 'charselect', 'charselect']);
    expect(p.screen).toBe('disconnected');
    expect(p.lc.resumeBound).toBe('chain');
    expect(p.lc.resumingAfterDrop).toBe(false);
  });

  it('the world: enter succeeds, then a drop at once — three attempts in all', () => {
    const p = inWorld();
    p.loopUntilDisconnected();
    expect(p.attempts).toEqual([...RESUME_DELAYS_MS]);
    expect(p.kinds.slice(0, 3)).toEqual(['world', 'world', 'world']);
    expect(p.screen).toBe('disconnected');
  });

  it('entering: a drop while Entering World waits resumes as the world resume, bounded the same', () => {
    const p = new Page();
    p.enter();
    p.loopUntilDisconnected();
    expect(p.kinds[0]).toBe('enter');
    expect(p.attempts).toEqual([...RESUME_DELAYS_MS]);
    expect(p.screen).toBe('disconnected');
  });

  it('chargen: the draft comes back, then a drop at once — three attempts in all', () => {
    const p = new Page();
    p.screen = 'chargen';
    p.loopUntilDisconnected();
    expect(p.kinds.slice(0, 3)).toEqual(['chargen', 'chargen', 'chargen']);
    expect(p.attempts).toEqual([...RESUME_DELAYS_MS]);
    expect(p.screen).toBe('disconnected');
  });

  it('the link check finding the session dead (handleUnexpectedDrop) is bounded by the same budget', () => {
    const p = inWorld();
    // Two quick resumes that came back, each followed by a drop at once.
    for (let i = 0; i < 2; i++) {
      expect(p.drop()).toBe('resuming');
      p.characterList();
      p.playerCreate();
    }
    expect(p.drop()).toBe('resuming');
    p.characterList();
    p.playerCreate();
    // The third came back too; the link check now finds it dead within the minute.
    p.now += 5_000;
    let died = false;
    const r = handleUnexpectedDrop({
      lifecycle: p.lc,
      reportLeft: () => {},
      teardownWorld: () => {},
      scheduleResume: () => p.scheduleResume(),
      raiseServerDied: () => { died = true; },
    });
    expect(r).toBe('server_died');
    expect(died).toBe(true);
    expect(p.attempts).toEqual([...RESUME_DELAYS_MS]);
  });
});

describe('BUG.resume-loop-unbounded — the inverse: real blips still resume, deliberate closes never do', () => {
  it('a single blip resumes (2 s), and a session up past RESUME_HEALTHY_MS gets a whole budget again', () => {
    const p = inWorld();
    expect(p.drop()).toBe('resuming');
    expect(p.attempts).toEqual([2000]);
    p.characterList();
    p.playerCreate();
    // Played a minute: the next drop is a new blip.
    p.now += RESUME_HEALTHY_MS;
    expect(p.drop()).toBe('resuming');
    expect(p.attempts).toEqual([2000, 2000]);
  });

  it('a second blip inside the minute continues the budget at its next delay, not at the end of it', () => {
    const p = new Page();
    expect(p.drop()).toBe('resuming');
    p.characterList();
    p.now += RESUME_HEALTHY_MS - 1000;
    expect(p.drop()).toBe('resuming');
    expect(p.attempts).toEqual([2000, 5000]);
    expect(p.lc.resumeBound).toBeNull();
  });

  it('a long play session with occasional blips resumes from every one', () => {
    const p = inWorld();
    for (let i = 0; i < 20; i++) {
      p.now += 15 * 60_000;
      expect(p.drop()).toBe('resuming');
      p.characterList();
      p.playerCreate();
    }
    expect(p.attempts).toEqual(Array(20).fill(2000));
  });

  it('a deliberate close never resumes, and a logout forgets a recent resume', () => {
    const p = inWorld();
    expect(p.drop(OUR_CLOSE)).toBe('disconnected');
    expect(p.attempts).toEqual([]);

    const q = inWorld();
    // Three quick resumes that each came back: the budget is used up for the next minute…
    for (let i = 0; i < 3; i++) {
      expect(q.drop()).toBe('resuming');
      q.characterList();
      q.playerCreate();
    }
    // …but the player logs out (CharacterLogOff): that is not a loop.
    q.lc.noteLoggedOut();
    q.now += 1000;
    // The player's own login after it: a drop at character select gets a whole budget.
    q.screen = 'char-select';
    q.attempts = [];
    expect(q.drop()).toBe('resuming');
    expect(q.attempts).toEqual([2000]);
  });

  it("after the Disconnected screen, the player's own relaunch gets a whole budget", () => {
    const p = new Page();
    p.loopUntilDisconnected();
    // The Disconnected screen's button: a manual login lands on character select (no resume under way).
    p.now += 3000;
    p.screen = 'char-select';
    p.attempts = [];
    expect(p.drop()).toBe('resuming');
    expect(p.attempts).toEqual([2000]);
  });
});

/**
 * BUG.resume-chain-window-blip (prod 2026-11-08, trace 7fcff3ce1adfaaac, end of
 * retail): a flaky home connection dropped, the resume spent all three attempts
 * (one ID_NetError_CantSocket) and came back at 16:28:16, and the next drop 53 s
 * later got the Disconnected screen (resume_ended loop_chain_spent) under the
 * first cut's 60 s window: the guard's only prod firing in 10 days, a false
 * positive. The window is 20 s now: past the 8 s worst case of a refused session.
 */
describe('BUG.resume-chain-window-blip — the chain window catches refusal loops, not later blips', () => {
  /** A world page whose resume spent the whole budget (two failed attempts, the third came back). */
  function restoredAfterFullBudget(): Page {
    const p = inWorld();
    expect(p.drop()).toBe('resuming');
    // Attempts 1 and 2 fail (the 16:27:59 CantSocket counted, as a fast-refused open does).
    expect(p.scheduleResume()).toBe(true);
    expect(p.scheduleResume()).toBe(true);
    expect(p.attempts).toEqual([...RESUME_DELAYS_MS]);
    p.characterList();
    p.playerCreate();
    expect(p.lc.resumingAfterDrop).toBe(false);
    return p;
  }

  it('the window is 20 s', () => {
    expect(RESUME_HEALTHY_MS).toBe(20_000);
  });

  it('the prod case: a drop 53 s after a full-budget resume came back gets a fresh resume (2 s)', () => {
    const p = restoredAfterFullBudget();
    p.now += 53_000;
    expect(p.drop()).toBe('resuming');
    expect(p.attempts).toEqual([...RESUME_DELAYS_MS, RESUME_DELAYS_MS[0]]);
    expect(p.lc.resumeBound).toBeNull();
  });

  it('a drop ~5 s after a full-budget resume (a server logout clock) still ends with the chain bound', () => {
    const p = restoredAfterFullBudget();
    p.now += 5_000;
    expect(p.drop()).toBe('disconnected');
    expect(p.lc.resumeBound).toBe('chain');
    expect(p.attempts).toEqual([...RESUME_DELAYS_MS]);
  });

  it('an 8 s logout clock, and the account-in-use boot ~2 s on, are inside the window', () => {
    for (const after of [2_000, 8_000]) {
      const p = restoredAfterFullBudget();
      p.now += after;
      expect(p.drop()).toBe('disconnected');
      expect(p.lc.resumeBound).toBe('chain');
    }
  });

  it('the boundary: 1 ms short of the window continues the budget; at the window a whole budget', () => {
    const short = restoredAfterFullBudget();
    short.now += RESUME_HEALTHY_MS - 1;
    expect(short.drop()).toBe('disconnected');
    expect(short.lc.resumeBound).toBe('chain');

    const at = restoredAfterFullBudget();
    at.now += RESUME_HEALTHY_MS;
    expect(at.drop()).toBe('resuming');
    expect(at.attempts.at(-1)).toBe(RESUME_DELAYS_MS[0]);
    expect(at.lc.resumeBound).toBeNull();
  });

  it('the GDL wrong-era loop (list, then a drop 30 ms on) still stops after three attempts', () => {
    const p = new Page();
    p.loopUntilDisconnected();
    expect(p.attempts).toEqual([...RESUME_DELAYS_MS]);
    expect(p.lc.resumeBound).toBe('chain');
  });

  it('the trace replayed: drops 53 s, then ~3.6 min and ~2.6 min apart, and a 4th blip at ~16:37, all resume', () => {
    const p = restoredAfterFullBudget();
    // 16:29:09, 16:32:59, 16:35:37, then a 4th at ~16:37:10 (inside the 10 min from 16:27:57).
    for (const gap of [53_000, 216_000, 147_000, 90_000]) {
      p.now += gap;
      expect(p.drop()).toBe('resuming');
      expect(p.lc.resumeBound).toBeNull();
      p.characterList();
      p.playerCreate();
    }
    expect(p.attempts).toEqual([...RESUME_DELAYS_MS, 2000, 2000, 2000, 2000]);
    expect(p.attempts.length).toBeLessThan(RESUME_PAGE_CAP);
  });

  it('the page cap is three budgets: 9 attempts in ten minutes', () => {
    expect(RESUME_PAGE_CAP).toBe(9);
  });

  it('a server that drops each session every 21 s (just past the window) still stops at 9 attempts', () => {
    const p = inWorld();
    let outcome: 'resuming' | 'disconnected' = 'resuming';
    for (let i = 0; i < 50; i++) {
      outcome = p.drop();
      if (outcome === 'disconnected') break;
      p.characterList();
      p.playerCreate();
      p.now += 21_000;
    }
    expect(outcome).toBe('disconnected');
    expect(p.attempts.length).toBe(9);
    expect(p.lc.resumeBound).toBe('page_cap');
  });
});

describe('BUG.resume-loop-unbounded — the page-wide cap', () => {
  it('a server that drops each session just past the healthy window stops after RESUME_PAGE_CAP attempts in ten minutes', () => {
    const p = inWorld();
    let outcome: 'resuming' | 'disconnected' = 'resuming';
    for (let i = 0; i < 20 && outcome === 'resuming'; i++) {
      outcome = p.drop();
      if (outcome === 'disconnected') break;
      p.characterList();
      p.playerCreate();
      p.now += RESUME_HEALTHY_MS + 1000;
    }
    expect(outcome).toBe('disconnected');
    expect(p.attempts.length).toBe(RESUME_PAGE_CAP);
    expect(p.lc.resumeBound).toBe('page_cap');
    expect(RESUME_PAGE_CAP_WINDOW_MS).toBe(600_000);
  });

  it('attempts spread past ten minutes are not capped', () => {
    const p = inWorld();
    for (let i = 0; i < RESUME_PAGE_CAP * 3; i++) {
      p.now += RESUME_PAGE_CAP_WINDOW_MS / RESUME_PAGE_CAP + 1000;
      expect(p.drop()).toBe('resuming');
      p.characterList();
      p.playerCreate();
    }
  });

  it('attempts given back while the network is out do not fill the cap', () => {
    const lc = new SessionLifecycle();
    lc.noteEnterWorldRequested(GUID);
    lc.noteWorldEntered(0);
    lc.noteDisconnected();
    let now = 1000;
    expect(lc.nextResumeDelay({ now })).toBe(RESUME_DELAYS_MS[0]);
    // A dozen attempts that found no network inside the grace: each given back.
    for (let i = 0; i < 12; i++) {
      now += 5000;
      expect(lc.nextResumeDelay({ unreachable: true, now })).toBe(RESUME_DELAYS_MS[0]);
    }
    expect(lc.resumeBound).toBeNull();
  });
});
