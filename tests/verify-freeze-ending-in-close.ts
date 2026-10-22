/**
 * TELEMETRY.freeze-ending-in-close — an interval cut short by the tab closing still counts.
 *
 * 2026-10-21 17:29Z: a drain's hard cut ended a routine player's session; the page never resumed
 * and at 18:00:48 sent world_left exit=closed_tab freezes=0 frozenMs=0. Its JavaScript had been
 * frozen (Chrome page lifecycle, https://developer.chrome.com/docs/web-platform/page-lifecycle-api),
 * but WorldReporter counted a freeze only on 'resume', which never came before the close.
 *
 * Now world_left counts a freeze still open up to the report (once, no double count on a later
 * 'resume'), says how long before the report the page's 1 s tick last ran (lastBeatAgoMs), and
 * how long the session's bridge had been draining without a handover (drainWaitMs,
 * DrainHandover.drainingForMs). The bridge's sanitizer keeps both new fields.
 */
import { describe, expect, it } from 'vitest';
import { WorldReporter, type WorldEvent, type WorldLeftEvent } from '../packages/renderer/src/telemetry/WorldReporter.js';
import { DrainHandover, HANDOVER_POLL_MS } from '../packages/renderer/src/session/DrainHandover.js';
import { sanitizeClientWorld } from '../services/ws-tcp-bridge/src/clientWorld.js';

function reporter() {
  const clock = { t: 0 };
  const events: WorldEvent[] = [];
  const r = new WorldReporter({
    endpoint: 'http://x/client-preworld', build: 'abc1234', trace: 'feedc0de12345678', era: () => 'eor', server: () => 'coldeve',
    now: () => clock.t, send: (_u, b) => { events.push(JSON.parse(b) as WorldEvent); },
  });
  const left = () => events.find((e): e is WorldLeftEvent => e.outcome === 'world_left')!;
  return { r, clock, events, left };
}

/** Enter, and tick past the first minute so the session's end is a world_left. */
function pastFirstMinute(g: ReturnType<typeof reporter>) {
  g.r.enteredWorld();
  const start = g.clock.t;
  for (let s = 1; s <= 61; s++) { g.clock.t = start + s * 1000; g.r.tick(); }
  expect(g.events.map(e => e.outcome)).toEqual(['first_minute']);
}

describe('a freeze that ends with the tab closing', () => {
  it('freeze then close with no resume: counted, up to the close', () => {
    const g = reporter();
    pastFirstMinute(g);
    g.clock.t = 100_000;
    g.r.hidden();
    g.clock.t = 120_000;
    g.r.frozen();
    // Frozen: no ticks run. The tab closes 31 min later.
    g.clock.t = 120_000 + 31 * 60_000;
    g.r.left('closed_tab');
    expect(g.left()).toMatchObject({ exit: 'closed_tab', freezes: 1, frozenMs: 31 * 60_000, lastBeatAgoMs: 120_000 + 31 * 60_000 - 61_000 });
    expect(sanitizeClientWorld(g.left())).toMatchObject({ freezes: 1, frozenMs: 31 * 60_000, lastBeatAgoMs: 1_919_000 });
    // A 'resume' after the session ended adds nothing, and a later session starts from zero.
    g.r.pageResumed();
    g.r.enteredWorld();
    g.clock.t += 61_000;
    g.r.tick();
    g.clock.t += 1_000;
    g.r.left('logout');
    const second = g.events.filter((e): e is WorldLeftEvent => e.outcome === 'world_left')[1];
    expect(second).toMatchObject({ exit: 'logout', freezes: 0, frozenMs: 0, lastBeatAgoMs: 1_000 });
  });

  it('freeze → resume → close: one freeze, not counted twice', () => {
    const g = reporter();
    pastFirstMinute(g);
    g.clock.t = 200_000;
    g.r.frozen();
    g.clock.t = 230_000;
    g.r.pageResumed();
    g.r.tick();
    g.clock.t = 300_000;
    g.r.left('closed_tab');
    expect(g.left()).toMatchObject({ freezes: 1, frozenMs: 30_000, lastBeatAgoMs: 70_000 });
  });

  it('a closed freeze plus one still open: both, each once', () => {
    const g = reporter();
    pastFirstMinute(g);
    g.clock.t = 100_000; g.r.frozen();
    g.clock.t = 110_000; g.r.pageResumed();
    g.clock.t = 150_000; g.r.frozen();
    g.clock.t = 175_000;
    g.r.left('disconnected', { endCause: 'socket_closed', closeCode: 1006 });
    expect(g.left()).toMatchObject({ freezes: 2, frozenMs: 35_000 });
  });

  it('a freeze open since before the enter counts only from the enter (the clamp stays)', () => {
    const g = reporter();
    g.clock.t = 0;
    g.r.frozen();
    g.clock.t = 5_000;
    pastFirstMinute(g); // enters at 5 s; the ticks move the clock to 66 s
    g.clock.t = 100_000;
    g.r.left('closed_tab');
    expect(g.left()).toMatchObject({ freezes: 1, frozenMs: 95_000 });
  });

  it('a live page: lastBeatAgoMs is the time since its last tick', () => {
    const g = reporter();
    pastFirstMinute(g);
    g.clock.t = 61_400;
    g.r.left('logout');
    expect(g.left()).toMatchObject({ freezes: 0, frozenMs: 0, lastBeatAgoMs: 400, drainWaitMs: null });
  });
});

describe('a session that ends while its bridge drains says how long it waited', () => {
  it('DrainHandover.drainingForMs → world_left drainWaitMs; the bridge keeps it', () => {
    let t = 1_000_000;
    const poll: { fn: (() => void) | null } = { fn: null };
    const d = new DrainHandover({
      now: () => t,
      // Never safe: a fight that never ends.
      safety: () => ({ inWorld: true, entering: false, combatStance: true, dead: false, portalSpace: false, trade: false, vendor: false, dialog: null, lastCombatAt: t, hostilesSeeking: 1 }),
      handover: () => { throw new Error('never safe'); },
      report: () => {},
      setInterval: (fn) => { poll.fn = fn; return 1; },
      clearInterval: () => { poll.fn = null; },
    });
    expect(d.drainingForMs()).toBeNull();
    const g = reporter();
    g.r.setSources({ drainWaitMs: () => d.drainingForMs() });
    pastFirstMinute(g);
    d.onDraining(true);
    for (let i = 0; i < 20; i++) { t += HANDOVER_POLL_MS; poll.fn?.(); }
    // A repeated notice doesn't restart the wait.
    d.onDraining(true);
    t += 5_000;
    expect(d.drainingForMs()).toBe(15_000);
    // The hard cut: world_left goes out first (main.ts), then the drop stops the drain.
    g.r.left('disconnected', { endCause: 'socket_closed', closeCode: 1006 });
    d.onSessionDropped();
    expect(g.left()).toMatchObject({ drainWaitMs: 15_000 });
    expect(sanitizeClientWorld(g.left())).toMatchObject({ drainWaitMs: 15_000 });
    expect(d.drainingForMs()).toBeNull();
  });

  it('the sanitizer drops junk in the new fields and leaves them out for an older page', () => {
    const base = { outcome: 'world_left', era: 'eor', server: 'coldeve', trace: 'feedc0de12345678', build: 'abc1234', exit: 'closed_tab', sessionMs: 1000, contextLost: false, errors: 0 };
    expect(sanitizeClientWorld({ ...base, lastBeatAgoMs: -5, drainWaitMs: 'x' })).toMatchObject({ lastBeatAgoMs: null, drainWaitMs: null });
    const old = sanitizeClientWorld(base)!;
    expect(old).not.toHaveProperty('lastBeatAgoMs');
    expect(old).not.toHaveProperty('drainWaitMs');
  });
});

/**
 * COMPAT.telemetry-browser-unknowns — document 'freeze' / 'resume' exist only in Chromium
 * (https://caniuse.com/mdn-api_document_freeze_event). In Firefox and Safari a session could not
 * have seen a freeze, so world_left says freezes / frozenMs are unknown (null), not 0.
 */
describe('freeze counts where the browser has no page-lifecycle events', () => {
  const fakeWin = () => ({ addEventListener: () => {}, setInterval: () => 1 });
  const fakeDoc = (withFreeze: boolean) => ({
    addEventListener: () => {}, visibilityState: 'visible',
    ...(withFreeze ? { onfreeze: null } : {}),
  });

  it('Firefox / Safari (no document.onfreeze): freezes and frozenMs are null, and the bridge keeps null', () => {
    const g = reporter();
    g.r.install(fakeWin() as never, fakeDoc(false) as never, null);
    pastFirstMinute(g);
    g.r.left('closed_tab');
    expect(g.left()).toMatchObject({ freezes: null, frozenMs: null });
    expect(sanitizeClientWorld(g.left())).toMatchObject({ freezes: null, frozenMs: null });
  });

  it('Chromium (document.onfreeze present): counts as before', () => {
    const g = reporter();
    g.r.install(fakeWin() as never, fakeDoc(true) as never, null);
    pastFirstMinute(g);
    g.r.left('closed_tab');
    expect(g.left()).toMatchObject({ freezes: 0, frozenMs: 0 });
  });
});
