/**
 * AGENT.stay-with-pace (stream day, 2026-10-14). Two rounds:
 *
 * 17:25–17:27 UTC: Claude Bulwark (the faster runner) walked a 4 km trip with stay_with="Claude Arcanist" in bursts:
 * "walk: waiting for Claude Arcanist, 16 m behind" about once a second, as the walk stopped at the 15 m leash and set off
 * the moment the gap was back under it. The fix then eased the run to a walk (Shift) half a leash ahead, and walked
 * follow / the routine's Follow leg near the leader.
 *
 * 20:32–20:34 UTC: that walk was most of what viewers saw. Arcanist walked ~25 s, ran ~2 s, walked again ("walking to
 * let Claude Bulwark catch up, 13 m behind" / "running again, 3 m away"), because Bulwark's run is a little slower than
 * his. Jake: "why do they keep shift walking!!" Players run, and the one ahead stops a moment when the other falls well
 * back. Now no pacing ever holds Shift: a stay_with walk runs, stops once when the fellow is a leash (15 m) behind, and
 * runs on when they are within STAY_WITH_TOGETHER_M (4 m), so they set off together; follow runs to within, stands, and
 * runs again; only a jump's take-off still slows to a walk.
 *
 * Driven through the real AgentApi on the fake host (tests/_harness/agentFake.ts: 4 m/s run, 3.12 m/s walk).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { FakeHost, run } from './_harness/agentFake.ts';

const ARCANIST = 0x50000002;
const vitals = { cur: 40, max: 50 };

/** Run the page's ticks until the promise settles (or `ms` pass); `each` runs before every 100 ms tick. */
async function settle<T>(api: AgentApi, host: FakeHost, p: Promise<T>, ms: number, each?: () => void): Promise<T | null> {
  let out: T | null = null;
  let done = false;
  void p.then((x) => { out = x; done = true; });
  for (let t = 0; t < ms && !done; t += 100) { each?.(); run(api, host, 100); await Promise.resolve(); await Promise.resolve(); }
  return out;
}

/**
 * Watches the keys: every Shift press (any key call, not only between ticks), and the stops (W let go between ticks)
 * with how long each lasted and how far the fellow was when it ended.
 */
function watchKeys(host: FakeHost, gap: () => number = () => NaN) {
  const pauses: Array<{ at: number; ms: number; endGap: number }> = [];
  let shiftPresses = 0;
  let wasW = false;
  const key = host.key;
  host.key = (code: string, down: boolean) => {
    if (code === 'ShiftLeft' && down && !host.keys.has('ShiftLeft')) shiftPresses++;
    key(code, down);
  };
  return {
    pauses, get shiftPresses() { return shiftPresses; },
    sample(): void {
      const w = host.keys.has('KeyW');
      if (wasW && !w) pauses.push({ at: host.t, ms: 0, endGap: NaN });
      if (!w && pauses.length) { const p = pauses[pauses.length - 1]; p.ms = host.t - p.at; p.endGap = gap(); }
      wasW = w;
    },
  };
}

describe('walking with a slower companion: always a run, and one clean stop per gap', () => {
  let host: FakeHost;
  let api: AgentApi;
  let traces: string[];
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    traces = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { traces.push(a.join(' ')); });
    host.add({ guid: ARCANIST, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, x: 80, y: 18 });
    host.fellows = () => [{ guid: ARCANIST, name: 'Claude Arcanist', health: vitals, stamina: vitals, mana: vitals }];
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  /** Arcanist runs north at `mps`, in step with you along the same road. */
  const arcanistRuns = (mps: number) => () => { host.objs.get(ARCANIST)!.y += mps / 10; };
  const gap = (): number => { const a = host.objs.get(ARCANIST)!; return Math.hypot(a.x - host.me.x, a.y - host.me.y); };

  it('stay_with: a fellow a little slower than your run (the live pair): no Shift over 500 m, a few stops that end with them beside you', async () => {
    const k = watchKeys(host, gap);
    const run35 = arcanistRuns(3.5);
    const r = await settle(api, host, api.walkTo('500m north', { within: 2, stayWith: 'Claude Arcanist', timeoutMs: 600_000 }), 300_000, () => { run35(); k.sample(); });
    const log = traces.filter((t) => /walk:/.test(t)).join('\n');
    expect(r, log).toMatchObject({ ok: true });
    // Before: Shift held for "walking to let Claude Arcanist catch up" most of the way.
    expect(k.shiftPresses, log).toBe(0);
    expect(traces.some((t) => /walking to let|running again/.test(t)), log).toBe(false);
    // 0.5 m/s apart: the leash fills in ~22 s of running, so a stop every ~25 s, never one a second.
    const waits = traces.filter((t) => /waiting for Claude Arcanist/.test(t)).length;
    expect(waits, log).toBeGreaterThanOrEqual(2);
    expect(waits, log).toBeLessThanOrEqual(8);
    expect(k.pauses.length, JSON.stringify(k.pauses)).toBe(waits);
    // Each stop lasts until they are within ~4 m (11 m at 3.5 m/s: about 3 s), so you set off together.
    for (const p of k.pauses) { expect(p.ms).toBeGreaterThanOrEqual(2500); expect(p.endGap).toBeLessThanOrEqual(4.5); }
    expect(r!.message).toMatch(/waited \d+ s for Claude Arcanist/);
    // Never more than a leash and a tick apart.
    expect(gap()).toBeLessThan(16);
  });

  it('stay_with: a fellow slower than your walk: still no Shift, a stop each time they fall a leash back, each until they are near', async () => {
    const k = watchKeys(host, gap);
    const walk25 = arcanistRuns(2.5);
    const r = await settle(api, host, api.walkTo('300m north', { within: 2, stayWith: 'Claude Arcanist', timeoutMs: 600_000 }), 300_000, () => { walk25(); k.sample(); });
    const log = traces.filter((t) => /walk:/.test(t)).join('\n');
    expect(r, log).toMatchObject({ ok: true });
    expect(k.shiftPresses).toBe(0);
    const waits = traces.filter((t) => /waiting for Claude Arcanist/.test(t)).length;
    expect(waits).toBeGreaterThanOrEqual(2);
    expect(waits).toBeLessThanOrEqual(12);
    expect(k.pauses.length, JSON.stringify(k.pauses)).toBe(waits);
    for (const p of k.pauses) { expect(p.ms).toBeGreaterThanOrEqual(2500); expect(p.endGap).toBeLessThanOrEqual(4.5); }
  });

  it('stay_with: a fellow who comes near and stops there (not within 4 m) is beside you: the walk goes on, not "hasn\'t moved"', async () => {
    const k = watchKeys(host, gap);
    // She runs 2.5 m/s; once you stop for her she comes to 6 m back of you, stands there 5 s, then runs on at 3.8 m/s.
    let stopAt: number | null = null;
    let stoodAt: number | null = null;
    const her = (): void => {
      const a = host.objs.get(ARCANIST)!;
      if (k.pauses.length && stopAt === null) stopAt = host.me.y - 6;
      if (stopAt === null) { a.y += 0.25; return; }
      if (a.y < stopAt) { a.y = Math.min(a.y + 0.25, stopAt); return; }
      stoodAt ??= host.t;
      if (host.t - stoodAt > 5000) a.y += 0.38;
    };
    const r = await settle(api, host, api.walkTo('60m north', { within: 2, stayWith: 'Claude Arcanist', timeoutMs: 600_000 }), 120_000, () => { her(); k.sample(); });
    const log = traces.filter((t) => /walk:/.test(t)).join('\n');
    expect(r, log).toMatchObject({ ok: true });
    expect(r!.message).not.toMatch(/hasn't moved/);
    expect(traces.some((t) => /Claude Arcanist caught up \(6 m\); on/.test(t)), log).toBe(true);
    expect(k.shiftPresses).toBe(0);
  });

  it('stay_with with running not the default: no Shift pressed, and the stops still last until they catch up', async () => {
    host.runDefault = false;
    const k = watchKeys(host, gap);
    const slow = arcanistRuns(2);
    const r = await settle(api, host, api.walkTo('200m north', { within: 2, stayWith: 'Claude Arcanist', timeoutMs: 600_000 }), 300_000, () => { slow(); k.sample(); });
    expect(r, traces.join('\n')).toMatchObject({ ok: true });
    expect(k.shiftPresses).toBe(0);
    expect(k.pauses.length).toBeGreaterThanOrEqual(1);
    for (const p of k.pauses) { expect(p.ms).toBeGreaterThanOrEqual(2500); expect(p.endGap).toBeLessThanOrEqual(4.5); }
  });

  it('stay_with while fleeing: runs, no Shift', async () => {
    const k = watchKeys(host);
    const run35 = arcanistRuns(3.5);
    const r = await settle(api, host, api.walkTo('200m north', { within: 2, stayWith: 'Claude Arcanist', flee: true, timeoutMs: 600_000 }), 120_000, () => { run35(); k.sample(); });
    expect(r, traces.join('\n')).toMatchObject({ ok: true });
    expect(k.shiftPresses).toBe(0);
  });

  it('follow: a leader slower than your run: run up to within, stand, run on once they are 3 m past it; never Shift', async () => {
    host.objs.get(ARCANIST)!.y = 50;
    const lead = host.objs.get(ARCANIST)!;
    const k = watchKeys(host, gap);
    const run35 = arcanistRuns(3.5);
    const r = await settle(api, host, api.follow('Claude Arcanist', { within: 4, durationMs: 90_000 }), 120_000, () => { if (host.t < 80_000) run35(); k.sample(); });
    expect(r, traces.join('\n')).toMatchObject({ ok: true });
    expect(k.shiftPresses).toBe(0);
    // Each stand ends once they are past within + FOLLOW_SLACK_M (4 + 3): a stand of a second or so, not every tick.
    const moving = k.pauses.filter((p) => p.at < 80_000 && p.endGap === p.endGap);
    expect(moving.length).toBeGreaterThanOrEqual(1);
    expect(moving.length).toBeLessThanOrEqual(15);
    for (const p of moving.slice(0, -1)) expect(p.endGap).toBeGreaterThan(6.5);
    expect(Math.hypot(host.me.x - lead.x, host.me.y - lead.y)).toBeLessThan(4 + 3.5);
  });

  it('a walk to a moving leader (the routine engine\'s Follow leg): runs all the way, no Shift, and arrives', async () => {
    host.objs.get(ARCANIST)!.y = 40;
    const k = watchKeys(host);
    const r = await settle(api, host, api.walkTo(ARCANIST, { within: 2, timeoutMs: 60_000 }), 60_000, () => { host.objs.get(ARCANIST)!.y += 0.2; k.sample(); });
    expect(r!.message).toMatch(/^arrived/);
    expect(k.shiftPresses).toBe(0);
    expect(k.pauses.length).toBeLessThanOrEqual(1);
  });
});

describe('a jump still slows to a walk for its take-off', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('jumping a gap: Shift is held only in the last metres before the take-off', async () => {
    const host = new FakeHost();
    const api = new AgentApi(host);
    const inX = (x: number): boolean => x > 70 && x < 90;
    host.floors = (x, y) => (inX(x) && y > 0 && y < 60 ? (y < 30 || y > 32.5 ? [94, 50] : [50]) : []);
    host.add({ guid: 0x80000062, name: 'Far Ledge Post', x: 80, y: 40, z: 94 });
    const shiftAt: number[] = [];
    const key = host.key;
    host.key = (code: string, down: boolean) => { if (code === 'ShiftLeft' && down && !host.keys.has('ShiftLeft')) shiftAt.push(host.me.y); key(code, down); };
    const p = api.walkTo('Far Ledge Post', { within: 1.5, timeoutMs: 60_000 });
    run(api, host, 40_000);
    const r = await p;
    expect(r).toMatchObject({ ok: true });
    expect(r.message).toMatch(/jumped once/);
    expect(shiftAt.length).toBeGreaterThanOrEqual(1);
    // Pressed within 3 m of the gap's edge (y 30), never from the start of the walk (y 20).
    for (const y of shiftAt) expect(y).toBeGreaterThan(26);
  });
});
