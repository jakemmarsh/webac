/**
 * BUG.bunker-sealed-at-ground (sweep) — a stuck walk names the landscape in its way (open sea, ground too steep)
 * only out on the landscape. From an interior cell under the terrain (a cellar, the drudge statues' ramps) the
 * terrain is the ground overhead, and its slope was blamed for a stall it had nothing to do with.
 * AgentApi on the fake host (tests/_harness/agentFake.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { FakeHost, run } from './_harness/agentFake.ts';

const OX = 0xa9 * 192;

async function settle<T>(api: AgentApi, host: FakeHost, p: Promise<T>, ms: number): Promise<T | null> {
  let out: T | null = null;
  let done = false;
  void p.then((x) => { out = x; done = true; });
  for (let t = 0; t < ms && !done; t += 100) { run(api, host, 100); await Promise.resolve(); await Promise.resolve(); }
  return out;
}

describe('a stuck walk\'s "in the way" (wayBlocker) indoors', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // Terrain rising steeply eastward past local x 100; a wall at x 104 stops the walk.
    host.navTerrain = (x: number) => ({ sea: false, steep: x - OX > 100, wade: 0, height: 94 + Math.max(0, x - OX - 100) });
    host.wall = (x) => x > 104 && x < 112;
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('out on the landscape the steep ground is named', async () => {
    const r = await settle(api, host, api.walkTo('35m east', { timeoutMs: 120_000 }), 120_000);
    expect(r!.ok).toBe(false);
    expect(r!.message).toMatch(/in the way: ground rising too steeply to climb/);
  });

  it('in an interior cell the terrain overhead is not', async () => {
    host.me.cell = 0xa9b40177;
    const r = await settle(api, host, api.walkTo('35m east', { timeoutMs: 120_000 }), 120_000);
    expect(r!.ok).toBe(false);
    expect(r!.message).not.toMatch(/rising too steeply/);
  });
});
