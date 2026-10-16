/**
 * walk_to keeps out of portals that aren't its destination (packages/renderer/src/agent/portalAvoid.ts).
 * Portals are ethereal, so the movement collision the planner probes with walks over them, and a
 * walk in Banderling Ruin (2026-10-10) planned its first leg over the exit portal by the entry and
 * left the dungeon ("went through a portal on the way").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { avoidDisks, portalGuard } from '../packages/renderer/src/agent/portalAvoid.ts';
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

  it('the only way on runs through a portal: stops short and says so, never steps in', async () => {
    // A 3 m corridor north with a portal in it (its 1.8 m disk leaves no room past it).
    host.wall = (x, y) => x < 78.5 || x > 81.5 || y > 60;
    host.add({ guid: 0x7a9b3000, name: 'Exit Portal', itemType: 0x10000, objectDescFlags: 0x40000, x: 80, y: 30 });
    host.add({ guid: 0x80000042, name: 'Chest', itemType: 0x200, x: 80, y: 45 });
    const p = api.walkTo('Chest');
    let closest = Infinity;
    for (let t = 0; t < 120_000; t += 100) {
      run(api, host, 100);
      closest = Math.min(closest, Math.hypot(host.me.x - 80, host.me.y - 30));
    }
    const r = await p;
    expect(r.ok, r.message).toBe(false);
    expect(r.message).toMatch(/kept out of Exit Portal #7a9b3000 \(\d+ m N\): a walk never steps into a portal it wasn't sent to/);
    expect(closest).toBeGreaterThan(1.4);
  });

  it('walks into a portal that is the destination', async () => {
    host.wall = () => false;
    host.add({ guid: 0x7a9b3000, name: 'Exit Portal', itemType: 0x10000, objectDescFlags: 0x40000, x: 80, y: 26 });
    const r = api.walkTo('Exit Portal');
    run(api, host, 15_000);
    expect((await r).message).toMatch(/^arrived/);
  });
});

describe('portalGuard', () => {
  const disk = { x: 5, y: 0, z: 0, r: 2, guid: 1, label: 'P' };
  it('inside a disk and heading nearer the portal: hold', () => {
    expect(portalGuard({ x: 3.5, y: 0, z: 0 }, { x: 10, y: 0 }, [disk])?.kind).toBe('inside');
  });
  it('inside a disk and heading away: no hold', () => {
    expect(portalGuard({ x: 3.5, y: 0, z: 0 }, { x: 0, y: 0 }, [disk])).toBeNull();
  });
  it('the disk on the next few metres of the heading: walk (even past a waypoint short of it)', () => {
    // The aim is 0.5 m ahead, but the body runs on past it in the same direction.
    expect(portalGuard({ x: 0, y: 0, z: 0 }, { x: 0.5, y: 0 }, [disk])?.kind).toBe('near');
    expect(portalGuard({ x: -3, y: 0, z: 0 }, { x: 10, y: 0 }, [disk])).toBeNull(); // 6 m off the rim
    expect(portalGuard({ x: 0, y: 3, z: 0 }, { x: 10, y: 3 }, [disk])).toBeNull(); // passes beside it
    expect(portalGuard({ x: 0, y: 0, z: 0 }, { x: 10, y: 0 }, [{ ...disk, z: 6 }])).toBeNull(); // another floor
  });
});

/**
 * The ring of seven housing portals SE of Holtburg (landblock 0xABB1, ACE-World landblock_instance 0x7ABB1000–1007,
 * local positions; Setup 0x020001B3: part radius 1.92 m, its one sphere 1.357 m). Bulwark stood between the Mountain Keep
 * Cottages and Holtburg Wilderness Settlement portals and was sent on past them (2026-10-16 21:18:30Z); he ran past the
 * search's first waypoint, 2.8 m from the Wilderness portal, and through it. A run of 11 m/s and a slow frame (a look
 * every 300 ms) carries the body 3.3 m between looks.
 */
class FastHost extends FakeHost {
  physics(dtMs: number): void {
    if (!this.keys.has('KeyW')) return;
    const speed = this.keys.has('ShiftLeft') ? 3.12 : 11;
    const step = (speed * dtMs) / 1000;
    this.me.x += -Math.sin(this.me.yaw) * step;
    this.me.y += -Math.cos(this.me.yaw) * step;
  }
}
const RING = [
  ['Evensong Settlement Portal', 60.27, 121.88], ['Lilyglen Cottages Portal', 51.9, 124.3], ['Woodsbane Cottages Portal', 50.54, 131.54],
  ['Mountain Keep Cottages Portal', 52.61, 139.54], ['Holtburg Wilderness Settlement Portal', 61.72, 140.6],
  ['New Colier Portal', 68.63, 126.41], ['West Holtburg Villas Portal', 69.01, 133.52],
] as const;
/** Where the body touches a portal: its sphere (1.357 m) and the body's (0.48 m). */
const TOUCH_M = 1.357 + 0.48;

describe('walk_to through the Holtburg housing-portal ring never touches a portal it was not sent to', () => {
  afterEach(() => vi.useRealTimers());
  const ring = (): { host: FastHost; api: AgentApi } => {
    vi.useFakeTimers();
    const host = new FastHost();
    host.wall = () => false;
    RING.forEach(([name, x, y], i) => host.add({ guid: 0x7abb1000 + i, name, itemType: 0x10000, objectDescFlags: 0x40000, x, y }));
    host.objectReach = (g) => ((g & 0xfffff000) === 0x7abb1000 ? 1.92 : 0);
    host.me.x = 56.9; host.me.y = 139.2;
    return { host, api: new AgentApi(host) };
  };
  const closestPortal = (host: FakeHost): number => Math.min(...RING.map(([, x, y]) => Math.hypot(host.me.x - x, host.me.y - y)));
  const drive = (api: AgentApi, host: FakeHost, ms: number): number => {
    let closest = Infinity;
    for (let t = 0; t < ms; t += 300) {
      host.t += 300; vi.advanceTimersByTime(300); host.physics(300); api.tick();
      closest = Math.min(closest, closestPortal(host));
    }
    return closest;
  };

  it('a detour whose waypoint is 2.8 m from a portal it heads toward: the run past it slows to a walk, short of the portal', async () => {
    const { host, api } = ring();
    // Just inside the Mountain Keep portal's disk, a fence to the north: the way north goes east first, to a waypoint by
    // the Wilderness portal's rim, as Bulwark's search did. Without the guard the run past it came 1.76 m from its centre.
    host.wall = (x, y) => x > 40 && x < 58.6 && y > 141.3 && y < 142.3;
    host.me.x = 55.2; host.me.y = 139.3;
    const p = api.walkTo('40m north');
    const closest = drive(api, host, 8_000);
    expect(closest).toBeGreaterThan(TOUCH_M);
    expect((await p).message).toMatch(/^arrived/);
  });

  it('every way out of the ring centre: no portal touched', async () => {
    for (const dir of ['north', 'south', 'east', 'west', 'northeast', 'southwest']) {
      const { host, api } = ring();
      const p = api.walkTo(`25m ${dir}`);
      const closest = drive(api, host, 25_000);
      expect(closest, dir).toBeGreaterThan(TOUCH_M);
      await p;
      vi.useRealTimers();
    }
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
