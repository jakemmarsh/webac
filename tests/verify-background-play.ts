/**
 * AGENT.hosted-mcp-connector — the game keeps playing when the browser stops
 * drawing it (Claude Desktop in front of the game's window). Measured in a
 * real Chrome with the game tab hidden: before, Claude's walk didn't move in
 * 22 s; after, it arrived in 10 s (7.7 s visible).
 *  - BackgroundTicker: a worker's beat runs the frame step (no drawing)
 *    whenever requestAnimationFrame has been silent for STARVED_MS.
 *  - installWorkerTimers: while Claude is on, page timers ride a worker's
 *    unthrottled clock (the agent's waits, the relay's deadlines).
 */
import { describe, expect, it } from 'vitest';
import { BackgroundTicker, STARVED_MS, TICK_MS } from '../packages/renderer/src/scene/BackgroundTicker';
import { installWorkerTimers, type TimerHost } from '../packages/renderer/src/scene/workerTimers';

function fakeWorker() {
  const w = { posted: [] as unknown[], onmessage: null as ((e: MessageEvent) => void) | null, terminated: false,
    postMessage(m: unknown) { this.posted.push(m); }, terminate() { this.terminated = true; },
    beat(data: unknown = 0) { this.onmessage?.({ data } as MessageEvent); } };
  return w;
}

describe('BackgroundTicker', () => {
  it('steps only while rAF is silent; starts the worker\'s beat at TICK_MS and stops it', () => {
    let t = 1000;
    let steps = 0;
    const w = fakeWorker();
    const ticker = new BackgroundTicker(() => { steps++; }, () => t, () => w as never);
    ticker.start();
    expect(w.posted).toEqual([TICK_MS]);
    t += STARVED_MS - 1; w.beat();
    expect(steps).toBe(0); // frames still coming
    ticker.frame();
    t += STARVED_MS + 1; w.beat(); w.beat();
    expect(steps).toBe(2); // rAF stopped (hidden or covered window): the beat runs the step
    ticker.frame(); w.beat();
    expect(steps).toBe(2); // frames are back
    ticker.stop();
    expect(w.posted.at(-1)).toBe(0);
    expect(w.terminated).toBe(true);
  });

  it('without workers it does nothing (the page pauses when hidden, as before)', () => {
    const ticker = new BackgroundTicker(() => {}, () => 0, () => { throw new Error('no workers'); });
    expect(() => ticker.start()).not.toThrow();
  });
});

describe('installWorkerTimers', () => {
  function host() {
    const nativeCalls: string[] = [];
    const h: TimerHost = {
      setTimeout: ((fn: unknown, ms?: number) => { nativeCalls.push(`setTimeout ${ms}`); return 7; }) as unknown as typeof setTimeout,
      setInterval: ((fn: unknown, ms?: number) => { nativeCalls.push(`setInterval ${ms}`); return 8; }) as unknown as typeof setInterval,
      clearTimeout: ((id: unknown) => { nativeCalls.push(`clearTimeout ${id}`); }) as typeof clearTimeout,
      clearInterval: ((id: unknown) => { nativeCalls.push(`clearInterval ${id}`); }) as typeof clearInterval,
    };
    return { h, nativeCalls };
  }

  it('timeouts and intervals run on the worker\'s clock with their arguments; clear stops them; native ids still clear natively', () => {
    const { h, nativeCalls } = host();
    const w = fakeWorker();
    expect(installWorkerTimers(h, () => w as never)).toBe(true);
    const got: string[] = [];
    const a = h.setTimeout(((x: string) => got.push(`once ${x}`)) as never, 100, 'a') as unknown as number;
    const b = h.setInterval((() => got.push('tick')) as never, 50) as unknown as number;
    expect(w.posted).toEqual([{ op: 'set', id: a, ms: 100, repeat: false }, { op: 'set', id: b, ms: 50, repeat: true }]);
    w.beat(a); w.beat(a); w.beat(b); w.beat(b);
    expect(got).toEqual(['once a', 'tick', 'tick']); // a timeout fires once
    h.clearInterval(b as never);
    expect(w.posted.at(-1)).toEqual({ op: 'clear', id: b });
    w.beat(b);
    expect(got).toHaveLength(3);
    h.clearTimeout(7 as never); // a timer set before the swap
    expect(nativeCalls).toEqual(['clearTimeout 7']);
    // A string handler (legacy) stays native.
    h.setTimeout('void 0' as never, 5);
    expect(nativeCalls.at(-1)).toBe('setTimeout 5');
  });

  it('installs once; no workers: leaves the timers alone', () => {
    const { h } = host();
    const before = h.setTimeout;
    expect(installWorkerTimers(h, () => { throw new Error('no workers'); })).toBe(false);
    expect(h.setTimeout).toBe(before);
    const w = fakeWorker();
    installWorkerTimers(h, () => w as never);
    const swapped = h.setTimeout;
    installWorkerTimers(h, () => { throw new Error('not called again'); });
    expect(h.setTimeout).toBe(swapped);
  });
});
