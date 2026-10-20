/**
 * REND.landblock-streaming-one-frame — LandblockLoadScheduler spreads a
 * landblock-row crossing's object loads over frames: the player's own block +
 * neighbours finish synchronously (their collision exists before the player
 * can reach it), everything else advances nearest-first under a per-frame
 * time budget, resuming the one block in progress; the same steps run in the
 * same per-block order as a synchronous load (identical end state).
 * Also: RateLimitedWarn, the console channel replacing the region's silent
 * skip-catches. Behavioural: drives the real modules with a fake clock.
 */
import { describe, it, expect } from 'vitest';
import { LandblockLoadScheduler } from '../packages/renderer/src/world/LandblockLoadScheduler.js';
import { RateLimitedWarn } from '../packages/renderer/src/utils/RateLimitedWarn.js';

/** A fake world: each block's load is `stepsPerBlock` steps of `stepMs` fake ms; records every step. */
function world(stepsPerBlock: number, stepMs: number) {
  let t = 0;
  const log: string[] = [];
  const done = new Set<string>();
  const factory = (bx: number, by: number): Iterator<void> => (function* () {
    for (let i = 0; i < stepsPerBlock; i++) {
      t += stepMs;
      log.push(`${bx},${by}:${i}`);
      if (i < stepsPerBlock - 1) yield;
    }
    done.add(`${bx},${by}`);
  })();
  return { factory, log, done, now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('LandblockLoadScheduler', () => {
  it('a row crossing no longer runs in one frame: each pump stays within budget + one step', () => {
    const w = world(10, 1); // 10 ms per block
    const s = new LandblockLoadScheduler(w.factory, { budgetMs: 6, now: w.now });
    // Player at (100,100) already has the 17×17 grid; the new row at y=108 queues.
    for (let dx = -8; dx <= 8; dx++) s.request(100 + dx, 108, 0);
    expect(s.queuedCount).toBe(17);
    let frames = 0;
    while (s.queuedCount > 0) {
      const t0 = w.now();
      s.pump(100, 100);
      expect(w.now() - t0).toBeLessThanOrEqual(6 + 1);
      frames++;
      expect(frames).toBeLessThan(1000);
    }
    expect(w.done.size).toBe(17);
    expect(frames).toBeGreaterThan(17); // ≥ 170 ms of work spread over many frames
  });

  it('nearest block first, the block in progress is always resumed before another starts', () => {
    const w = world(4, 1);
    const s = new LandblockLoadScheduler(w.factory, { budgetMs: 2, now: w.now, syncRadius: 0 });
    s.request(50, 50, 3); // 7×7 around (50,50), player standing at (47,47)
    const order: string[] = [];
    while (s.queuedCount > 0) s.pump(47, 47);
    for (const e of w.log) { const b = e.split(':')[0]; if (order[order.length - 1] !== b) order.push(b); }
    // Each block appears as one contiguous run (never interleaved)…
    expect(new Set(order).size).toBe(order.length);
    // …and blocks start in non-decreasing distance from the player.
    const d = order.map(b => { const [x, y] = b.split(',').map(Number); return (x - 47) ** 2 + (y - 47) ** 2; });
    for (let i = 1; i < d.length; i++) expect(d[i]).toBeGreaterThanOrEqual(d[i - 1]);
    expect(order[0]).toBe('47,47');
  });

  it('the player\'s block and neighbours load synchronously, whatever the budget', () => {
    const w = world(50, 1); // 50 ms per block
    const s = new LandblockLoadScheduler(w.factory, { budgetMs: 1, now: w.now });
    s.request(10, 10, 2);
    s.pump(10, 10);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) expect(w.done.has(`${10 + dx},${10 + dy}`)).toBe(true);
    expect(w.done.size).toBe(9 + 0); // nothing outside the ring finished in the same pump beyond one step
  });

  it('a half-built block the player walks into is finished at once (mandatory ring)', () => {
    const w = world(10, 1);
    const s = new LandblockLoadScheduler(w.factory, { budgetMs: 3, now: w.now, syncRadius: 1 });
    s.request(20, 20, 0);
    s.pump(25, 25); // far: 3 budgeted steps
    expect(w.done.has('20,20')).toBe(false);
    s.pump(21, 20); // now adjacent
    expect(w.done.has('20,20')).toBe(true);
    expect(w.log.filter(e => e.startsWith('20,20')).length).toBe(10); // no step repeated or skipped
  });

  it('cancelOutside drops only waiting blocks; complete() finishes the one in progress; flush drains all', () => {
    const w = world(5, 1);
    const s = new LandblockLoadScheduler(w.factory, { budgetMs: 2, now: w.now, syncRadius: 0 });
    s.request(30, 30, 1);
    s.pump(28, 30); // player 2 blocks west of the centre: the nearest block (29,30) starts, 2 of its 5 steps run
    const inProgress = w.log[w.log.length - 1].split(':')[0];
    expect(inProgress).toBe('29,30');
    s.cancelOutside(40, 40, 1);
    expect(s.queuedCount).toBe(1); // only the in-progress block survives
    s.complete(29, 30);
    expect(w.done.has('29,30')).toBe(true);
    expect(s.queuedCount).toBe(0);
    s.request(60, 60, 1);
    s.flush(60, 60);
    expect(w.done.size).toBe(10);
  });

  it('the scheduled end state equals a synchronous load (same steps, same per-block order)', () => {
    const a = world(6, 1);
    const b = world(6, 1);
    const sync = new LandblockLoadScheduler(a.factory, { budgetMs: 1e9, now: a.now, syncRadius: 0 });
    const sliced = new LandblockLoadScheduler(b.factory, { budgetMs: 2, now: b.now, syncRadius: 0 });
    sync.request(5, 5, 2);
    sliced.request(5, 5, 2);
    sync.pump(5, 5);
    while (sliced.queuedCount > 0) sliced.pump(5, 5);
    expect(new Set(b.log)).toEqual(new Set(a.log));
    expect(b.log.length).toBe(a.log.length);
  });

  /** Pump once per frame of `frameMs` (the frame's other work is the rest of it); the ms of loading done per second. */
  function loadingPerSecond(frameMs: number): { perSecond: number; maxPumpMs: number; budget: number } {
    const w = world(1000, 1);
    const s = new LandblockLoadScheduler(w.factory, { now: w.now, syncRadius: 0 });
    for (let dx = -8; dx <= 8; dx++) s.request(100 + dx, 108, 0);
    let work = 0, maxPumpMs = 0;
    const frames = Math.round(10_000 / frameMs);
    for (let f = 0; f < frames; f++) {
      const t0 = w.now();
      s.pump(100, 100);
      const spent = w.now() - t0;
      if (f >= 10) { work += spent; maxPumpMs = Math.max(maxPumpMs, spent); }
      w.advance(Math.max(0, frameMs - spent));
    }
    return { perSecond: work / ((frames - 10) * frameMs / 1000), maxPumpMs, budget: s.frameBudgetMs };
  }

  it('PERF slow machine: at 3 FPS the budget follows the frame (not 6 ms a frame), capped; 60 FPS unchanged', () => {
    // 60 FPS: the 6 ms budget, as before.
    const fast = loadingPerSecond(1000 / 60);
    expect(fast.budget).toBe(6);
    expect(fast.maxPumpMs).toBeLessThanOrEqual(6 + 1);
    // ~13 FPS: still the plain budget.
    expect(loadingPerSecond(75).budget).toBe(6);
    // 3.3 FPS (300 ms frames, the prod UHD 630 first minute): 6 ms a frame was ~20 ms of loading a second.
    const slow = loadingPerSecond(300);
    expect(slow.budget).toBeGreaterThanOrEqual(23);
    expect(slow.budget).toBeLessThanOrEqual(24);
    expect(slow.maxPumpMs).toBeLessThanOrEqual(24 + 1);
    expect(slow.perSecond).toBeGreaterThan(70);
    // A hidden tab's multi-second gap counts as at most 1 s: the cap still holds.
    const w = world(1000, 1);
    const s = new LandblockLoadScheduler(w.factory, { now: w.now, syncRadius: 0 });
    s.request(50, 50, 2);
    s.pump(0, 0); w.advance(60_000); s.pump(0, 0);
    expect(s.frameBudgetMs).toBe(24);
  });
});

describe('RateLimitedWarn', () => {
  it('counts every failure, prints at most once per interval with the suppressed count', () => {
    let t = 0;
    const lines: string[] = [];
    const w = new RateLimitedWarn('LandblockStream', 5000, () => t, (m) => lines.push(String(m)));
    w.warn('EnvCell 0xa9b40105 failed to build', new Error('boom'));
    w.warn('EnvCell 0xa9b40106 failed to build');
    w.warn('EnvCell 0xa9b40107 failed to build');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('0xa9b40105');
    expect(lines[0]).toContain('boom');
    t = 6000;
    w.warn('Scene 0x12000001 unreadable');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('4 total');
    expect(lines[1]).toContain('+2 suppressed');
    expect(w.count).toBe(4);
  });
});
