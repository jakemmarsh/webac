/**
 * OBS.upgrade-aborted (prod 2026-11-10 trace 2665376d1e9e1019, 2026-11-08 trace 24a98ca9): a background
 * tab's session dropped, its resume attempts failed while hidden, and the player came back to the
 * resuming screen and reloaded by hand ~60 s later, while the next attempt sat on a throttled timer.
 *
 * Now a pending resume attempt (its delay, or the offline wait) runs at once when the page comes back
 * into view (ResumeRunner + VisibilitySource), once, never on top of an attempt already connecting,
 * with the budget unchanged. Drives the real ResumeRunner + SessionLifecycle on fake timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionLifecycle, RESUME_DELAYS_MS } from '../packages/renderer/src/session/SessionLifecycle.js';
import {
  ResumeRunner, RESUME_ONLINE_SETTLE_MS, documentVisibilitySource, type OnlineSource, type VisibilitySource,
} from '../packages/renderer/src/session/ResumeRunner.js';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

class FakeNet implements OnlineSource {
  offline = false;
  private subs = new Set<() => void>();
  isOffline(): boolean { return this.offline; }
  onOnline(fn: () => void): () => void { this.subs.add(fn); return () => this.subs.delete(fn); }
  comeBack(): void { this.offline = false; for (const f of [...this.subs]) f(); }
}

class FakeVisibility implements VisibilitySource {
  private subs = new Set<() => void>();
  onVisible(fn: () => void): () => void { this.subs.add(fn); return () => this.subs.delete(fn); }
  get listeners(): number { return this.subs.size; }
  show(): void { for (const f of [...this.subs]) f(); }
}

function harness() {
  const life = new SessionLifecycle();
  const net = new FakeNet();
  const vis = new FakeVisibility();
  const connects: number[] = [];
  const runner = new ResumeRunner({ lifecycle: life, connect: () => connects.push(Date.now()), online: net, visibility: vis, now: () => Date.now() });
  // main.ts scheduleResume, minus the UI.
  const schedule = (o: { unreachable?: boolean } = {}) => {
    const delay = life.nextResumeDelay({ unreachable: o.unreachable, now: Date.now() });
    if (delay === null) { runner.cancel(); return false; }
    runner.schedule(delay);
    return true;
  };
  life.noteEnterWorldRequested(0x50000001);
  life.noteWorldEntered();
  life.noteDisconnected();
  expect(schedule()).toBe(true);
  return { life, net, vis, runner, connects, schedule };
}

describe('a pending resume attempt runs when the page comes into view', () => {
  it('hidden → visible during the delay runs the attempt now, once; the old timer does not run it again', () => {
    const h = harness();
    vi.advanceTimersByTime(500);
    expect(h.connects).toEqual([]);
    h.vis.show();
    expect(h.connects).toHaveLength(1);
    expect(h.vis.listeners).toBe(0);
    h.vis.show(); // another visibility change while the attempt connects: left alone
    vi.advanceTimersByTime(RESUME_DELAYS_MS[0] * 10);
    expect(h.connects).toHaveLength(1);
  });

  it('no attempt fires while one is in flight: after the timer ran it, a visible event does nothing', () => {
    const h = harness();
    vi.advanceTimersByTime(RESUME_DELAYS_MS[0]);
    expect(h.connects).toHaveLength(1);
    expect(h.vis.listeners).toBe(0);
    h.vis.show();
    expect(h.connects).toHaveLength(1);
  });

  it('a visible event with nothing pending does nothing (never scheduled, cancelled, resume over)', () => {
    const life = new SessionLifecycle();
    const vis = new FakeVisibility();
    const connects: number[] = [];
    const runner = new ResumeRunner({ lifecycle: life, connect: () => connects.push(1), online: new FakeNet(), visibility: vis });
    vis.show();
    expect(connects).toEqual([]);
    const h = harness();
    h.runner.cancel();
    expect(h.vis.listeners).toBe(0);
    h.vis.show();
    expect(h.connects).toEqual([]);
    const h2 = harness();
    h2.life.endResume(); // a deliberate logout / back in the world meanwhile
    h2.vis.show();
    vi.advanceTimersByTime(60_000);
    expect(h2.connects).toEqual([]);
    expect(runner.waitingForNetwork).toBe(false);
  });

  it('a newer schedule replaces the watch: one visible event runs only the newest attempt', () => {
    const h = harness();
    h.runner.schedule(5000);
    expect(h.vis.listeners).toBe(1);
    h.vis.show();
    expect(h.connects).toHaveLength(1);
    vi.advanceTimersByTime(60_000);
    expect(h.connects).toHaveLength(1);
  });

  it('the budget is unchanged: three counted attempts, each run early by a visible event, then it ends', () => {
    const h = harness();
    for (let i = 0; i < RESUME_DELAYS_MS.length; i++) {
      if (i > 0) expect(h.schedule()).toBe(true);
      vi.advanceTimersByTime(100);
      h.vis.show();
      expect(h.connects).toHaveLength(i + 1);
    }
    expect(h.schedule()).toBe(false); // the Disconnected screen, as without the visible events
    h.vis.show();
    expect(h.connects).toHaveLength(RESUME_DELAYS_MS.length);
  });

  it('during the offline wait: still offline, it keeps waiting; online but not yet settled, visible runs it now', () => {
    const h = harness();
    h.net.offline = true;
    vi.advanceTimersByTime(RESUME_DELAYS_MS[0]);
    expect(h.runner.waitingForNetwork).toBe(true);
    h.vis.show();
    expect(h.connects).toEqual([]); // the browser says offline: an attempt would be spent on nothing
    expect(h.runner.waitingForNetwork).toBe(true);
    h.net.comeBack();
    vi.advanceTimersByTime(RESUME_ONLINE_SETTLE_MS / 2);
    h.vis.show();
    expect(h.connects).toHaveLength(1);
    expect(h.runner.waitingForNetwork).toBe(false);
    vi.advanceTimersByTime(RESUME_ONLINE_SETTLE_MS * 10);
    expect(h.connects).toHaveLength(1);
  });

  it('without a VisibilitySource (older callers) nothing changes', () => {
    const life = new SessionLifecycle();
    const connects: number[] = [];
    const runner = new ResumeRunner({ lifecycle: life, connect: () => connects.push(1), online: new FakeNet() });
    life.noteEnterWorldRequested(0x50000001);
    life.noteWorldEntered();
    life.noteDisconnected();
    runner.schedule(life.nextResumeDelay({ now: Date.now() })!);
    vi.advanceTimersByTime(RESUME_DELAYS_MS[0] - 1);
    expect(connects).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(connects).toHaveLength(1);
  });
});

describe('documentVisibilitySource', () => {
  it('calls back on visibilitychange only when the document is visible, and unsubscribes', () => {
    const listeners = new Set<() => void>();
    const doc = {
      visibilityState: 'hidden',
      addEventListener: (_t: 'visibilitychange', fn: () => void) => { listeners.add(fn); },
      removeEventListener: (_t: 'visibilitychange', fn: () => void) => { listeners.delete(fn); },
    };
    const src = documentVisibilitySource(doc);
    let n = 0;
    const off = src.onVisible(() => { n++; });
    for (const f of listeners) f(); // went hidden
    expect(n).toBe(0);
    doc.visibilityState = 'visible';
    for (const f of listeners) f();
    expect(n).toBe(1);
    off();
    expect(listeners.size).toBe(0);
  });
});
