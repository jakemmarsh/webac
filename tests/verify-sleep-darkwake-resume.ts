/**
 * BUG.sleep-darkwake-resume-loop — a laptop asleep with the game open dark-wakes
 * about every 17 min; each wake found the session dead ('client_suspended'),
 * resumed it in the hidden tab, and the re-sleep dropped it again (prod
 * 2026-11-15, FrostfACE: 15 unattended logins in a few hours). A resume begun
 * from a sleep now waits while the tab is hidden, then goes at once when shown.
 *
 * Drives the real SessionLifecycle + ResumeRunner (main.ts scheduleResume minus
 * the UI), UnexpectedDrop.sleepDrop / silentReloginDrop, the PreworldReporter
 * and the bridge's sanitizer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionLifecycle } from '../packages/renderer/src/session/SessionLifecycle.js';
import { ResumeRunner, documentVisibilitySource, type OnlineSource } from '../packages/renderer/src/session/ResumeRunner.js';
import { silentReloginDrop, sleepDrop } from '../packages/renderer/src/session/UnexpectedDrop.js';
import { RESUME_DELAYS_MS } from '../packages/renderer/src/session/RetryPolicy.js';
import { PreworldReporter, type PreworldEvent } from '../packages/renderer/src/telemetry/PreworldReporter.js';
import { sanitizeClientPreworld } from '../services/ws-tcp-bridge/src/clientPreworld.js';

/** A document's visibility: state + 'visibilitychange' listeners. */
class FakeDoc {
  visibilityState: 'visible' | 'hidden' = 'hidden';
  private listeners = new Set<() => void>();
  addEventListener(_t: 'visibilitychange', fn: () => void): void { this.listeners.add(fn); }
  removeEventListener(_t: 'visibilitychange', fn: () => void): void { this.listeners.delete(fn); }
  set(v: 'visible' | 'hidden'): void { this.visibilityState = v; for (const l of [...this.listeners]) l(); }
  get listenerCount(): number { return this.listeners.size; }
}

const online: OnlineSource = { isOffline: () => false, onOnline: () => () => {} };

function rig(opts: { inWorld?: boolean } = {}) {
  const life = new SessionLifecycle();
  life.noteEnterWorldRequested(0x50000001);
  if (opts.inWorld !== false) life.noteWorldEntered(Date.now());
  const doc = new FakeDoc();
  const connects: number[] = [];
  const holds: Array<[string, number]> = [];
  const runner = new ResumeRunner({
    lifecycle: life, connect: () => connects.push(Date.now()), online,
    visibility: documentVisibilitySource(doc), onHold: (p, ms) => holds.push([p, ms]), now: () => Date.now(),
  });
  /** main.ts scheduleResume, minus the UI: a drop with `endCause`. */
  const drop = (endCause: string, o: { unreachable?: boolean } = {}) => {
    life.noteDisconnected();
    const delay = life.nextResumeDelay({
      unreachable: o.unreachable, silentRelogin: silentReloginDrop(endCause, {}), afterSleep: sleepDrop(endCause), now: Date.now(),
    });
    if (delay === null) { runner.cancel(); return false; }
    runner.schedule(delay);
    return true;
  };
  return { life, doc, runner, connects, holds, drop };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('sleepDrop: only the machine sleeping holds', () => {
  it('client_suspended holds; every other cause does not', () => {
    expect(sleepDrop('client_suspended')).toBe(true);
    for (const c of ['socket_closed', 'link_dead', 'server_silent', 'server_disconnect', 'server_net_error', 'local', null, undefined]) {
      expect(sleepDrop(c)).toBe(false);
    }
  });
});

describe('a resume after the machine slept waits for the tab to be shown', () => {
  it('suspended + hidden: no connect while hidden (for hours), then at once when shown', () => {
    const { doc, runner, connects, holds, drop, life } = rig();
    expect(drop('client_suspended')).toBe(true);
    expect(life.holdWhileHidden).toBe(true);
    vi.advanceTimersByTime(RESUME_DELAYS_MS[0]);
    expect(connects).toHaveLength(0);
    expect(runner.heldWhileHidden).toBe(true);
    expect(holds).toEqual([['held', 0]]);
    vi.advanceTimersByTime(3 * 3600_000);
    expect(connects).toHaveLength(0);
    doc.set('visible');
    expect(connects).toHaveLength(1);
    expect(runner.heldWhileHidden).toBe(false);
    expect(holds[1][0]).toBe('released');
    expect(holds[1][1]).toBe(3 * 3600_000);
    expect(doc.listenerCount).toBe(0);
  });

  it('suspended + visible: resumes on the usual schedule', () => {
    const { doc, connects, holds, drop } = rig();
    doc.visibilityState = 'visible';
    drop('client_suspended');
    vi.advanceTimersByTime(RESUME_DELAYS_MS[0]);
    expect(connects).toHaveLength(1);
    expect(holds).toEqual([]);
  });

  it('a page that was visible at the drop but hidden when the attempt is due holds (checked when the resume would start)', () => {
    const { doc, connects, drop } = rig();
    doc.visibilityState = 'visible';
    drop('client_suspended');
    doc.set('hidden');
    vi.advanceTimersByTime(RESUME_DELAYS_MS[0]);
    expect(connects).toHaveLength(0);
    doc.set('visible');
    expect(connects).toHaveLength(1);
  });

  it.each(['socket_closed', 'link_dead', 'server_silent'])('%s + hidden: resumes at once (a background window comes back from a blip or a drain cut)', (cause) => {
    const { connects, holds, drop, life } = rig();
    drop(cause);
    expect(life.holdWhileHidden).toBe(false);
    vi.advanceTimersByTime(RESUME_DELAYS_MS[0]);
    expect(connects).toHaveLength(1);
    expect(holds).toEqual([]);
  });

  it('a logout during the hold cancels it: showing the tab connects nothing and reports no release', () => {
    const { doc, connects, holds, drop, life } = rig();
    drop('client_suspended');
    vi.advanceTimersByTime(RESUME_DELAYS_MS[0]);
    life.noteLoggedOut();
    doc.set('visible');
    expect(connects).toHaveLength(0);
    expect(holds).toEqual([['held', 0]]);
    expect(doc.listenerCount).toBe(0);
  });

  it('another tab taking the account (endResume) or a cancel during the hold connects nothing', () => {
    const a = rig();
    a.drop('client_suspended');
    vi.advanceTimersByTime(RESUME_DELAYS_MS[0]);
    a.life.endResume();
    a.doc.set('visible');
    expect(a.connects).toHaveLength(0);
    const b = rig();
    b.drop('client_suspended');
    vi.advanceTimersByTime(RESUME_DELAYS_MS[0]);
    b.runner.cancel();
    expect(b.doc.listenerCount).toBe(0);
    b.doc.set('visible');
    expect(b.connects).toHaveLength(0);
  });

  it('repeated visibility flips fire the attempt once', () => {
    const { doc, connects, holds, drop } = rig();
    drop('client_suspended');
    vi.advanceTimersByTime(RESUME_DELAYS_MS[0]);
    doc.set('visible');
    doc.set('hidden');
    doc.set('visible');
    doc.set('visible');
    vi.advanceTimersByTime(60_000);
    expect(connects).toHaveLength(1);
    expect(holds.filter(([p]) => p === 'released')).toHaveLength(1);
  });

  it('the hold spends no budget: after a long hold the resume still has every later attempt', () => {
    const { doc, connects, drop, life } = rig();
    drop('client_suspended');
    vi.advanceTimersByTime(RESUME_DELAYS_MS[0]);
    for (let i = 0; i < 10; i++) { vi.advanceTimersByTime(17 * 60_000); doc.set('hidden'); }
    doc.set('visible');
    expect(connects).toHaveLength(1);
    // That attempt failed (an answer, not an outage): the next ones follow RESUME_DELAYS_MS.
    for (let n = 1; n < RESUME_DELAYS_MS.length; n++) {
      expect(life.nextResumeDelay({ now: Date.now() })).toBe(RESUME_DELAYS_MS[n]);
    }
    expect(life.nextResumeDelay({ now: Date.now() })).toBeNull();
    expect(life.resumeBound).toBeNull();
  });

  it('the hold lasts the whole resume: an attempt that fails while the lid is shut again waits too; a new resume after success starts clean', () => {
    const { doc, runner, connects, drop, life } = rig();
    drop('client_suspended');
    vi.advanceTimersByTime(RESUME_DELAYS_MS[0]);
    doc.set('visible');
    expect(connects).toHaveLength(1);
    doc.set('hidden');
    // The attempt's socket never opened (no network): the next attempt, still a sleep resume.
    const d = life.nextResumeDelay({ unreachable: true, now: Date.now() })!;
    runner.schedule(d);
    vi.advanceTimersByTime(d);
    expect(connects).toHaveLength(1);
    doc.set('visible');
    expect(connects).toHaveLength(2);
    life.noteWorldEntered(Date.now());
    expect(life.holdWhileHidden).toBe(false);
    // A blip later, hidden: no hold.
    doc.set('hidden');
    vi.advanceTimersByTime(10 * 60_000);
    drop('socket_closed');
    vi.advanceTimersByTime(RESUME_DELAYS_MS[0]);
    expect(connects).toHaveLength(3);
  });

  it('the trace\'s dark-wake loop: many wakes while asleep log in once, when the lid opens', () => {
    const { doc, connects, drop } = rig();
    drop('client_suspended');
    for (let wake = 0; wake < 15; wake++) vi.advanceTimersByTime(17 * 60_000);
    expect(connects).toHaveLength(0);
    doc.set('visible');
    expect(connects).toHaveLength(1);
  });

  it('the pre-world kinds share the hold (a char-select drop while asleep)', () => {
    const { doc, connects, drop, life } = rig({ inWorld: false });
    life.noteLoggedOut();
    life.beginCharSelectResume('1');
    drop('client_suspended');
    vi.advanceTimersByTime(RESUME_DELAYS_MS[0]);
    expect(connects).toHaveLength(0);
    doc.set('visible');
    expect(connects).toHaveLength(1);
  });

  it('AC1999 silent-relogin rule unchanged: client_suspended is never a silent relogin', () => {
    expect(silentReloginDrop('client_suspended', { reloginKillsSilently: true })).toBe(false);
    expect(silentReloginDrop('server_silent', { reloginKillsSilently: true })).toBe(true);
  });
});

describe('resume_held telemetry', () => {
  it('held, then released with heldMs; the bridge keeps it and drops heldMs elsewhere', () => {
    const sent: PreworldEvent[] = [];
    const r = new PreworldReporter({
      endpoint: 'https://bridge.example/client-preworld', build: 'abc1234', era: () => 'eor', server: () => 'frostface',
      screen: () => 'resuming', now: () => 1000, trace: 'feedc0de12345678',
      send: (_url, raw) => sent.push(JSON.parse(raw) as PreworldEvent),
    });
    r.resumeHeld('held', 0);
    r.resumeHeld('released', 1234.4);
    expect(sent[0]).toMatchObject({ outcome: 'resume_held', token: 'held' });
    expect(sent[0]).not.toHaveProperty('heldMs');
    expect(sent[1]).toMatchObject({ outcome: 'resume_held', token: 'released', heldMs: 1234 });
    expect(sanitizeClientPreworld(sent[1])).toMatchObject({ outcome: 'resume_held', token: 'released', heldMs: 1234 });
    expect(sanitizeClientPreworld({ ...sent[1], outcome: 'char_list' })).not.toHaveProperty('heldMs');
    expect(sanitizeClientPreworld({ ...sent[1], heldMs: -5 })).not.toHaveProperty('heldMs');
  });
});
