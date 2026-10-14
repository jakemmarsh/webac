/**
 * AGENT.stay-with-abeam (stream day, 2026-10-14 20:00 UTC; Jake: "why does bulwark shift walk every few feet"). Bulwark
 * walked a 1.2 km trip in 35 m stretches with stay_with="Claude Arcanist", who was on her own walk to (nearly) the same
 * place 35–65 m off to the SIDE: her stretch had turned 90° round a lake. The log read "walking to let Claude Arcanist
 * catch up, 48 m behind" / "running again, Claude Arcanist 48 m away" every 1–3 s, 130 times. The pace and the leash
 * measured "behind" along the way to the goal only: a fellow abeam is ~0 m behind there however far off, so the leash
 * (15 m) never stopped the walk and the pace's 3 m / 7.5 m hysteresis flipped as each gained a few metres on the other.
 * Now a fellow who is not clearly ahead counts by the straight distance: past the leash it is one clean stop until they
 * are within 4 m (or the wait ends the walk). Since 20:34 UTC the walking pace is gone altogether (Jake: "why do they
 * keep shift walking!!"): a stay_with walk never holds Shift, it runs and stops.
 *
 * Driven through the real AgentApi on the fake host (tests/_harness/agentFake.ts: 4 m/s run, 3.12 m/s walk), with the
 * nav probe on so the far goal is walked in 35 m stretches as live.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { FakeHost, run } from './_harness/agentFake.ts';

const ARCANIST = 0x50000002;
const vitals = { cur: 40, max: 50 };

async function settle<T>(api: AgentApi, host: FakeHost, p: Promise<T>, ms: number, each?: () => void): Promise<T | null> {
  let out: T | null = null;
  let done = false;
  void p.then((x) => { out = x; done = true; });
  for (let t = 0; t < ms && !done; t += 100) { each?.(); run(api, host, 100); await Promise.resolve(); await Promise.resolve(); }
  return out;
}

/** Counts Shift's changes and W's releases, every key call (not only between ticks). */
function watchKeys(host: FakeHost) {
  let shiftChanges = 0;
  let wUps = 0;
  const key = host.key;
  host.key = (code: string, down: boolean) => {
    if (code === 'KeyW' && !down && host.keys.has('KeyW')) wUps++;
    if (code === 'ShiftLeft' && down !== host.keys.has('ShiftLeft')) shiftChanges++;
    key(code, down);
  };
  return { get shiftChanges() { return shiftChanges; }, get wUps() { return wUps; } };
}

describe('stay_with a fellow far off to the side: no walk/run flip every few seconds', () => {
  let host: FakeHost;
  let api: AgentApi;
  let traces: string[];
  /** When (host ms) each stop for her was traced. */
  let waitAt: number[];
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    host.wall = () => false; // a probe: the far goal is walked in 35 m stretches, as live
    api = new AgentApi(host);
    traces = [];
    waitAt = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      const t = a.join(' ');
      traces.push(t);
      if (/waiting for Claude Arcanist/.test(t)) waitAt.push(host.t);
    });
    host.fellows = () => [{ guid: ARCANIST, name: 'Claude Arcanist', health: vitals, stamina: vitals, mana: vitals }];
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('a fellow 50 m abeam on a parallel way (the live shape): one stop, not a flip every few seconds', async () => {
    host.add({ guid: ARCANIST, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, x: 130, y: 15 });
    const k = watchKeys(host);
    // She walks her own way north, 50 m east, a little faster than your walk and slower than your run (the live pair).
    const r = await settle(api, host, api.walkTo('600m north', { within: 2, stayWith: 'Claude Arcanist', timeoutMs: 600_000 }), 120_000,
      () => { host.objs.get(ARCANIST)!.y += 0.35; });
    const log = traces.filter((t) => /walk:/.test(t)).join('\n');
    // Before: "walking to let … catch up, 48 m behind" / "running again, … 48 m away" every 1–3 s. Now no Shift at all.
    expect(traces.some((t) => /walking to let|running again/.test(t)), log).toBe(false);
    expect(k.shiftChanges, log).toBe(0);
    // One stop for her; the wait ends the walk (she never comes nearer), told with where she is.
    expect(traces.filter((t) => /waiting for Claude Arcanist/.test(t)), log).toHaveLength(1);
    expect(r, log).toMatchObject({ ok: false });
    expect(r!.message).toMatch(/to wait for Claude Arcanist, but they went on past you on another way: now \d+ m [NESW]+ of you/);
    expect(k.wUps, log).toBeLessThanOrEqual(2);
  });

  it('a fellow 45 m off and 30 m back, closing in on your way: a stop until she is within 4 m, then a run with a clean stop per gap', async () => {
    host.add({ guid: ARCANIST, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, x: 125, y: -10 });
    const k = watchKeys(host);
    // She heads mostly west onto your line (3.4 m/s), then north along it at 3.5 m/s.
    const her = (): void => {
      const a = host.objs.get(ARCANIST)!;
      if (a.x - host.me.x > 1) { a.x -= 0.3; a.y += 0.15; } else a.y += 0.35;
    };
    const r = await settle(api, host, api.walkTo('500m north', { within: 2, stayWith: 'Claude Arcanist', timeoutMs: 600_000 }), 300_000, her);
    const log = traces.filter((t) => /walk:/.test(t)).join('\n');
    expect(r, log).toMatchObject({ ok: true });
    expect(traces.some((t) => /walking to let|running again/.test(t)), log).toBe(false);
    expect(k.shiftChanges, log).toBe(0);
    // A wait for her crossing over; then she is a little slower than your run (3.5 against 4 m/s), so a stop each time
    // she falls a leash back (~11 m at 0.5 m/s: one every ~25 s), each until she is within 4 m, never the live 1–3 s.
    const waits = waitAt.length;
    expect(waits, log).toBeGreaterThanOrEqual(2);
    expect(waits, log).toBeLessThanOrEqual(8);
    for (let i = 1; i < waitAt.length; i++) expect(waitAt[i] - waitAt[i - 1], log).toBeGreaterThanOrEqual(15_000);
    expect(traces.filter((t) => /Claude Arcanist caught up \(\d+ m\); on/.test(t)).every((t) => Number(/up \((\d+) m\)/.exec(t)![1]) <= 4), log).toBe(true);
    // W is let go once per stop, plus the 35 m stretches' replans.
    expect(k.wUps, log).toBeLessThanOrEqual(waits + 4);
  });
});
