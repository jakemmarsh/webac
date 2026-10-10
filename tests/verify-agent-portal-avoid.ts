/**
 * walk_to keeps out of portals that aren't its destination (packages/renderer/src/agent/portalAvoid.ts).
 * Portals are ethereal, so the movement collision the planner probes with walks over them, and a
 * walk in Banderling Ruin (2026-10-10) planned its first leg over the exit portal by the entry and
 * left the dungeon ("went through a portal on the way").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { avoidDisks } from '../packages/renderer/src/agent/portalAvoid.ts';
import type { NavProbe } from '../packages/renderer/src/agent/navPlanner.ts';
import { FakeHost, run } from './_harness/agentFake.ts';

const open: NavProbe = (from, to) => ({ x: to.x, y: to.y, z: from.z });

describe('avoidDisks', () => {
  const disk = { x: 5, y: 0, z: 0, r: 1 };
  const probe = avoidDisks(open, () => [disk]);

  it('stops a probe at the rim of a disk on its path', () => {
    const got = probe({ x: 0, y: 0, z: 0 }, { x: 10, y: 0 })!;
    expect(got.x).toBeGreaterThan(3.9);
    expect(got.x).toBeLessThan(4);
  });

  it('leaves a path that passes beside the disk alone', () => {
    expect(probe({ x: 0, y: 2, z: 0 }, { x: 10, y: 2 })).toEqual({ x: 10, y: 2, z: 0 });
  });

  it('ignores a disk on another floor', () => {
    const upstairs = avoidDisks(open, () => [{ ...disk, z: 6 }]);
    expect(upstairs({ x: 0, y: 0, z: 0 }, { x: 10, y: 0 })).toEqual({ x: 10, y: 0, z: 0 });
  });

  it('from inside the rim lets the body move away but not further in', () => {
    expect(probe({ x: 4.5, y: 0, z: 0 }, { x: 0, y: 0 })).toEqual({ x: 0, y: 0, z: 0 });
    expect(probe({ x: 4.5, y: 0, z: 0 }, { x: 10, y: 0 })).toEqual({ x: 4.5, y: 0, z: 0 });
  });
});

describe('walk_to routes round a portal that is not its destination', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
  });
  afterEach(() => vi.useRealTimers());

  it('a portal on the straight line is walked round, never into', async () => {
    host.wall = () => false; // the collision-probe path, with nothing solid in the way
    host.add({ guid: 0x7a9b3000, name: 'Exit Portal', itemType: 0x10000, objectDescFlags: 0x40000, x: 80, y: 26 });
    host.add({ guid: 0x80000042, name: 'Chest', itemType: 0x200, x: 80, y: 32 });
    const p = api.walkTo('Chest');
    let closest = Infinity;
    for (let t = 0; t < 30_000; t += 100) {
      run(api, host, 100);
      closest = Math.min(closest, Math.hypot(host.me.x - 80, host.me.y - 26));
    }
    const r = await p;
    expect(r.message).toMatch(/^arrived/);
    expect(closest).toBeGreaterThan(1.4); // 1 m reach + 0.8 m clearance, less the steering slack
  });

  it('walks into a portal that is the destination', async () => {
    host.wall = () => false;
    host.add({ guid: 0x7a9b3000, name: 'Exit Portal', itemType: 0x10000, objectDescFlags: 0x40000, x: 80, y: 26 });
    const r = api.walkTo('Exit Portal');
    run(api, host, 15_000);
    expect((await r).message).toMatch(/^arrived/);
  });
});

describe('ac_jump passes its hold time and direction through the tool surface', () => {
  afterEach(() => vi.useRealTimers());
  it('surface().jump holds Space for holdMs with W held through it (it used to drop every option: a bare tap)', async () => {
    vi.useFakeTimers();
    const host = new FakeHost();
    const api = new AgentApi(host);
    const { TOOL_BY_NAME } = await import('../tools/ac-agent/tools.ts');
    const tool = TOOL_BY_NAME.get('ac_jump')!;
    expect(Object.keys(tool.props)).toEqual(expect.arrayContaining(['hold_ms', 'forward', 'walk']));
    const surface = api.surface() as Record<string, (...a: unknown[]) => { message: string }>;
    expect(surface.jump({ holdMs: 900, forward: true }).message).toBe('jumped forward (held 900 ms)');
    expect(host.keys.has('Space')).toBe(true);
    expect(host.keys.has('KeyW')).toBe(true);
    vi.advanceTimersByTime(850);
    expect(host.keys.has('Space')).toBe(true); // still charging
    vi.advanceTimersByTime(100);
    expect(host.keys.has('Space')).toBe(false);
    vi.advanceTimersByTime(500);
    expect(host.keys.has('KeyW')).toBe(false);
  });
});
