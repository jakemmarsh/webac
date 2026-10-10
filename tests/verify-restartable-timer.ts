/**
 * BUG.portal-space-hide-timer-race — main.ts's startGame()/
 * handleTeleportToPosition() each scheduled their own independent
 * hidePortalSpace() setTimeout with no stored id or cancellation. If a
 * second teleport (recall, death respawn — neither gated by the portal
 * object's own cooldown, see Player_Teleport.cs teleport paths in
 * reference/ACE/Source/ACE.Server/WorldObjects/) arrived while the first
 * teleport's hide-timer was still pending, the stale timer fired later and
 * hid the SECOND teleport's overlay early, cutting its transition short.
 *
 * Fix: route every scheduled hide through packages/renderer/src/utils/
 * RestartableTimer.ts — a single pending-callback slot where scheduling a
 * new call always cancels any call still pending, so only the most
 * recently scheduled call ever fires. main.ts now holds one
 * `portalSpaceHideTimer` instance and calls `.schedule(...)` from
 * startGame() (3000ms) and handleTeleportToPosition() (2000ms), and
 * `.cancel()` from teardownWorldState()'s immediate hide.
 *
 * This drives the real shipped RestartableTimer class with vitest fake
 * timers — not a source-text pin against main.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RestartableTimer } from '../packages/renderer/src/utils/RestartableTimer.js';

describe('BUG.portal-space-hide-timer-race — RestartableTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires the callback after the scheduled delay when nothing supersedes it', () => {
    const timer = new RestartableTimer();
    const cb = vi.fn();
    timer.schedule(cb, 2000);
    vi.advanceTimersByTime(1999);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('a later schedule() cancels an earlier pending one — only the later callback fires (the teleport race)', () => {
    const timer = new RestartableTimer();
    const firstTeleportHide = vi.fn();
    const secondTeleportHide = vi.fn();

    // First teleport lands, schedules its 2000ms hide.
    timer.schedule(firstTeleportHide, 2000);
    // Second teleport (e.g. death respawn) arrives 500ms later, before the
    // first hide has fired, and schedules its own 2000ms hide.
    vi.advanceTimersByTime(500);
    timer.schedule(secondTeleportHide, 2000);

    // At the first teleport's original fire time (2000ms after IT was
    // scheduled = 1500ms from now), its hide must NOT have fired — that
    // would incorrectly cut the second teleport's overlay short.
    vi.advanceTimersByTime(1500);
    expect(firstTeleportHide).not.toHaveBeenCalled();
    expect(secondTeleportHide).not.toHaveBeenCalled();

    // At the second teleport's own fire time, only its callback runs.
    vi.advanceTimersByTime(500);
    expect(firstTeleportHide).not.toHaveBeenCalled();
    expect(secondTeleportHide).toHaveBeenCalledTimes(1);
  });

  it('cancel() prevents a pending callback from ever firing', () => {
    const timer = new RestartableTimer();
    const cb = vi.fn();
    timer.schedule(cb, 2000);
    timer.cancel();
    vi.advanceTimersByTime(5000);
    expect(cb).not.toHaveBeenCalled();
  });

  it('isPending reflects whether a callback is currently scheduled', () => {
    const timer = new RestartableTimer();
    expect(timer.isPending).toBe(false);
    timer.schedule(() => {}, 1000);
    expect(timer.isPending).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(timer.isPending).toBe(false);
  });

  it('cancel() on an already-fired (or never-scheduled) timer is a safe no-op', () => {
    const timer = new RestartableTimer();
    expect(() => timer.cancel()).not.toThrow();
    const cb = vi.fn();
    timer.schedule(cb, 100);
    vi.advanceTimersByTime(100);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(() => timer.cancel()).not.toThrow();
  });
});
