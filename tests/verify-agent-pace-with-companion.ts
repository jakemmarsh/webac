/**
 * AGENT.stay-with-pace (stream day, 2026-10-14 17:25–17:27 UTC): Claude Bulwark (the faster runner) walked a 4 km trip
 * with stay_with="Claude Arcanist", and the viewer saw him move in bursts. His log read "walk: waiting for Claude
 * Arcanist, 16 m behind" about once a second for minutes: the walk stopped as the gap passed the 15 m leash, set off
 * again the moment it was back under, and stopped a second later. Now the faster one walks (the hold-run key, Shift,
 * running being the default) once the fellow is half the leash behind, runs again when they have caught up, and a walk
 * that does stop for them goes on only once they are within half the leash. The same stop-start shape in follow (a
 * leader slower than your run: run up, stand, run up) and the routine engine's Follow route gets the same pace.
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

/** Watches the keys after every tick: the stops (W let go between ticks) and how long each lasted, and Shift's changes. */
function watchKeys(host: FakeHost) {
  const pauses: Array<{ at: number; ms: number }> = [];
  let wasW = false;
  let wasShift = false;
  let shiftChanges = 0;
  let wUps = 0;
  const key = host.key;
  host.key = (code: string, down: boolean) => { if (code === 'KeyW' && !down && host.keys.has('KeyW')) wUps++; key(code, down); };
  return {
    pauses, get shiftChanges() { return shiftChanges; }, get wUps() { return wUps; },
    sample(): void {
      const w = host.keys.has('KeyW');
      if (wasW && !w) pauses.push({ at: host.t, ms: 0 });
      if (!w && pauses.length) pauses[pauses.length - 1].ms = host.t - pauses[pauses.length - 1].at;
      wasW = w;
      const s = host.keys.has('ShiftLeft');
      if (s !== wasShift) shiftChanges++;
      wasShift = s;
    },
  };
}

describe('a faster walker keeps a slower companion\'s pace without stop-start', () => {
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

  it('stay_with: a fellow slower than your run but faster than your walk: no stop at all over a long walk, a walk while ahead', async () => {
    const k = watchKeys(host);
    const run35 = arcanistRuns(3.5);
    const r = await settle(api, host, api.walkTo('500m north', { within: 2, stayWith: 'Claude Arcanist', timeoutMs: 600_000 }), 300_000, () => { run35(); k.sample(); });
    expect(r, traces.join('\n')).toMatchObject({ ok: true });
    expect(r!.message).not.toMatch(/waited/);
    // Before: "waiting for Claude Arcanist, 15 m behind" over and over, a stop every few ticks once the gap reached 15 m.
    expect(traces.filter((t) => /waiting for Claude Arcanist/.test(t))).toHaveLength(0);
    // The only W let go between ticks is the arrival's.
    expect(k.pauses.length).toBeLessThanOrEqual(1);
    // It walked to let them catch up, and ran again once they had: a few changes of pace over 500 m, not one a second.
    expect(traces.some((t) => /walking to let Claude Arcanist catch up/.test(t))).toBe(true);
    expect(k.shiftChanges).toBeGreaterThanOrEqual(2);
    expect(k.shiftChanges).toBeLessThanOrEqual(30);
    // Each change of pace re-presses W once (the movement event that carries the hold key), never more.
    expect(k.wUps).toBeLessThanOrEqual(k.shiftChanges + 2);
    // They kept together: never more than the leash apart.
    expect(Math.abs(host.objs.get(ARCANIST)!.y - host.me.y)).toBeLessThan(15);
  });

  it('stay_with: a fellow slower than your walk: one clean pause each time they fall a leash behind, each lasting seconds', async () => {
    const k = watchKeys(host);
    const walk2 = arcanistRuns(2.5);
    const r = await settle(api, host, api.walkTo('300m north', { within: 2, stayWith: 'Claude Arcanist', timeoutMs: 600_000 }), 300_000, () => { walk2(); k.sample(); });
    expect(r, traces.join('\n')).toMatchObject({ ok: true });
    const waits = traces.filter((t) => /waiting for Claude Arcanist/.test(t)).length;
    // 300 m at 2.5 m/s is 120 s: a pause about every 15 s, never one a second (the stream-day log had ~60 a minute).
    expect(waits).toBeGreaterThanOrEqual(2);
    expect(waits).toBeLessThanOrEqual(12);
    const stops = k.pauses; // (the arrival comes after the last sample)
    expect(stops.length, JSON.stringify(stops)).toBe(waits);
    // Each pause lasts until they are within half the leash (7.5 m at 2.5 m/s is 3 s), not a tick.
    for (const p of stops) expect(p.ms).toBeGreaterThanOrEqual(2500);
    expect(r!.message).toMatch(/waited \d+ s for Claude Arcanist/);
  });

  it('stay_with with running not the default (Shift runs then): no Shift pressed, and the pauses still last until they catch up', async () => {
    host.runDefault = false;
    const k = watchKeys(host);
    // You walk (3.12 m/s) by default now; they walk slower still.
    const slow = arcanistRuns(2);
    const r = await settle(api, host, api.walkTo('200m north', { within: 2, stayWith: 'Claude Arcanist', timeoutMs: 600_000 }), 300_000, () => { slow(); k.sample(); });
    expect(r, traces.join('\n')).toMatchObject({ ok: true });
    expect(k.shiftChanges).toBe(0);
    const stops = k.pauses;
    expect(stops.length).toBeGreaterThanOrEqual(1);
    for (const p of stops) expect(p.ms).toBeGreaterThanOrEqual(2500);
  });

  it('stay_with: being hit, or fleeing, always runs (no Shift held)', async () => {
    const k = watchKeys(host);
    const run35 = arcanistRuns(3.5);
    const r = await settle(api, host, api.walkTo('200m north', { within: 2, stayWith: 'Claude Arcanist', flee: true, timeoutMs: 600_000 }), 120_000, () => { run35(); k.sample(); });
    expect(r, traces.join('\n')).toMatchObject({ ok: true });
    expect(k.shiftChanges).toBe(0);
  });

  it('follow: a leader slower than your run is kept pace with, never run up to and stood beside every second', async () => {
    host.objs.get(ARCANIST)!.y = 50;
    const k = watchKeys(host);
    const run35 = arcanistRuns(3.5);
    const r = await settle(api, host, api.follow('Claude Arcanist', { within: 4, durationMs: 90_000 }), 120_000, () => { if (host.t < 80_000) run35(); k.sample(); });
    expect(r, traces.join('\n')).toMatchObject({ ok: true });
    // While the leader runs (80 s), no stop; one stand once they stop, and the follow's end.
    const moving = k.pauses.filter((p) => p.at < 80_000);
    expect(moving, JSON.stringify(k.pauses)).toHaveLength(0);
    expect(k.shiftChanges).toBeGreaterThanOrEqual(1);
    const lead = host.objs.get(ARCANIST)!;
    expect(Math.hypot(host.me.x - lead.x, host.me.y - lead.y)).toBeLessThan(4 + 3.5);
  });

  it('a walk with pace (the routine engine\'s Follow leg): walks within within + pace of a moving leader, runs when they pull away', async () => {
    host.objs.get(ARCANIST)!.y = 40;
    const k = watchKeys(host);
    const run5 = arcanistRuns(4.5); // faster than your run: the walk never arrives
    const r = await settle(api, host, api.walkTo(ARCANIST, { within: 2, pace: 4, timeoutMs: 15_000 }), 20_000, () => { run5(); k.sample(); });
    expect(r!.message).toMatch(/timed out/);
    // From 20 m off it ran (no Shift) and never came within 6 m: no walk.
    expect(k.shiftChanges).toBe(0);
    // A leader slower than your walk: it walks the last metres and arrives.
    host.me.y = 20; host.objs.get(ARCANIST)!.y = 40;
    const k2 = watchKeys(host);
    const r2 = await settle(api, host, api.walkTo(ARCANIST, { within: 2, pace: 4, timeoutMs: 60_000 }), 60_000, () => { host.objs.get(ARCANIST)!.y += 0.2; k2.sample(); });
    expect(r2!.message).toMatch(/^arrived/);
    expect(k2.shiftChanges).toBeGreaterThanOrEqual(1);
    expect(k2.pauses.length).toBeLessThanOrEqual(1);
  });
});
