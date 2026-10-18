/**
 * The Crystal Core (dungeon landblock 0x5861), end of retail local ACE, the stream soldier's walk_to 0x58610179 flee=true
 * from 0x58610120 (2026-10-18 16:57:00–16:57:41Z; transcript stream/sessions/soldier-2026-10-18-seg1.jsonl, page trace
 * soldier.log): it ran 60 m to 0x5861015C, stalled six times sliding along that room's north wall between its corners
 * (x 66 / 74, y −126) past the doorway (70, −125.5) into 0x58610160, and ended "stuck 97.2 m short in a straight line
 * (142 m left by the doorway route) (blocked)", naming nothing.
 *
 * On the cell DAT the doorway route is right and the only one: every way from 0x0120 (and 0x015C) to the Surface portal's
 * cell 0x0179 goes through that north doorway. In it stands the Wall of Ice (ACE-World-16PY-Patches 5861.sql: 0x75861085,
 * weenie 48724, cell 0x58610160 at (70, −125.25)): a Creature, not attackable, NpcLooksLikeObject, ItemUseable No, deleted
 * by the "UsedCrystal" signal of the Crystal (48723) in the middle of 0x015C ("melting the north wall"), and made again by
 * its generator. Its Setup 0x0200195E collides as a 3.33 m × 0.5 m physics box (GfxObj 0x0100439B) that fills the 3 m
 * doorway, while its spheres are 0.35 m: the walk's NPC disk (0.35 + 0.45 m) left room round it, the searches found ways
 * past and the body stalled on the box.
 *
 * Now the walk ends at the stall saying what stands in the doorway, that it is the only doorway route and not a door
 * (walkTo doorwayStander / standerResult); with another doorway route, it routes round by that.
 */
import { existsSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getClientRunRate } from '@ac/shared';
import { cellStandPoint, findRouteViaOutside, loadCellGraph, type CellGraph } from '../packages/renderer/src/agent/cellPath.ts';
import type { AgentResult } from '../packages/renderer/src/agent/types.ts';
import { DAT_PATHS, openDat } from './_harness/dat.ts';
import type { DungeonNav } from './_harness/dungeonNav.ts';
import type { Ac1999Fixture } from './_harness/ac1999Fixtures.ts';

const haveDat = existsSync(DAT_PATHS.cell) && existsSync(DAT_PATHS.portal);
const LB = 0x58610000;
const C = (n: number): number => (LB | n) >>> 0;
const WALL = 0x75861085;
/** The Wall of Ice as ACE places it (weenie 48724: PhysicsState ReportCollisions | Gravity, Setup 0x0200195E). */
const wallOfIce = (guid: number, cell: number, x: number, y: number, quat = { w: 1, x: 0, y: 0, z: 0 }): Ac1999Fixture => ({
  guid, wcid: 48724, name: 'Wall of Ice', cell: C(cell), x, y, z: 0, quat, setupId: 0x0200195e, itemType: 0x10, physicsState: 1032, locked: false, door: false,
});
/** The north doorway of 0x5861015C into 0x58610160, as the route gives it. */
const NORTH = { x: 70, y: -125.5, z: 0 };

describe.skipIf(!haveDat)('the real Crystal Core (0x5861): the Wall of Ice in the only doorway to the Surface portal', () => {
  let g: CellGraph;
  let nav: DungeonNav;
  beforeAll(async () => {
    g = loadCellGraph(openDat(DAT_PATHS.cell), openDat(DAT_PATHS.portal), LB);
    const { dungeonNav } = await import('./_harness/dungeonNav.ts');
    // Bulwark: Run 200 at the 0.5 burden band, Jump 100.
    nav = await dungeonNav(LB, { statics: true, jumpSkill: 100, runRate: getClientRunRate(0.5, 200) });
  }, 120_000);
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('the doorway route from 0x0120 and from 0x015C to 0x0179 passes the north doorway of 0x015C, and with it left out there is none', () => {
    const to = cellStandPoint(g, C(0x179))!;
    for (const [cell, from] of [[0x120, cellStandPoint(g, C(0x120))!], [0x15c, { x: 74, y: -126, z: 0 }]] as const) {
      const r = findRouteViaOutside(g, C(cell), from, C(0x179), to, { maxDrop: 8 });
      expect(r, `0x${C(cell).toString(16)}`).not.toBeNull();
      expect(r!.some((p) => Math.hypot(p.x - NORTH.x, p.y - NORTH.y) < 0.1)).toBe(true);
      expect(findRouteViaOutside(g, C(cell), from, C(0x179), to, { maxDrop: 8, closed: [NORTH] })).toBeNull();
    }
    // 0x015C's other doorways (west into 0x015E, east into 0x015F, the opening up into 0x015D) lead nowhere else.
    expect((g.doors.get(C(0x15c)) ?? []).map((d) => d.b >>> 0).sort()).toEqual([C(0x15d), C(0x15e), C(0x15f), C(0x160)].sort());
  });

  const walk = async (cell: number, at: { x: number; y: number; z: number } | null, fixtures: Ac1999Fixture[], reach: number): Promise<{ r: AgentResult; t: number; traces: string[] }> => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { DungeonHost } = await import('./_harness/dungeonWalk.js');
    const host = new DungeonHost(nav, { portal: openDat(DAT_PATHS.portal), cell: openDat(DAT_PATHS.cell) }, LB, { rooms: true, creatures: true, fixtures });
    // The client's reach for a creature is its body's blocking radius (its Setup's spheres: 0.35 m).
    host.objectReach = (guid) => (fixtures.some((f) => f.guid === guid) ? reach : 0);
    host.me.health = { current: 185, max: 185 };
    try {
      const r = await host.walkTarget(C(cell), at ?? cellStandPoint(g, C(cell))!, '0x58610179', { maxMs: 300_000, tickMs: 300 });
      return { r, t: host.t, traces: host.traces };
    } finally { host.dispose(); }
  };
  const SAYS_WALL = /^stuck [\d.]+ m short in a straight line \(\d+ m left by the doorway route\) \(Wall of Ice #75861085 stands in the doorway \d+ m [NESW]{1,2} of you \(cell 0x58610160\), and its body blocks the opening: the doorway route there goes only through that doorway, no other doorway leads there, and it is not a door a walk opens\)\. ac_appraise or ac_look at it/;

  it('without the Wall of Ice (melted) the walk from 0x0120 arrives: the route is walkable', async () => {
    const { r } = await walk(0x120, null, [], 0);
    expect(r.ok, r.message).toBe(true);
    expect(r.message).toMatch(/^arrived .* cell 0x58610179/);
  }, 120_000);

  it('walk_to 0x58610179 from 0x0120 (the live start) ends by the doorway naming the Wall of Ice, not "(blocked)"', async () => {
    const { r, t } = await walk(0x120, null, [wallOfIce(WALL, 0x160, 70, -125.25)], 0.35);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(SAYS_WALL);
    expect(r.message).not.toMatch(/\(blocked\)/);
    // The live walk took 41 s; the run to the doorway is ~15 s of it.
    expect(t).toBeLessThan(30_000);
  }, 120_000);

  it('from 0x015C\'s north-east corner (where the live walk stalled) it ends at once naming it', async () => {
    const { r, t } = await walk(0x15c, { x: 74, y: -126, z: 0 }, [wallOfIce(WALL, 0x160, 70, -125.25)], 0.35);
    expect(r.message).toMatch(SAYS_WALL);
    expect(t).toBeLessThan(15_000);
  }, 120_000);

  it('when the searches find ways past its disk (as live) the stall by the doorway ends it, naming it', async () => {
    // A smaller disk, so the searches into the doorway succeed and the body stalls on the box, as the live walk's did.
    const { r, traces } = await walk(0x120, null, [wallOfIce(WALL, 0x160, 70, -125.25)], 0.05);
    expect(r.message).toMatch(SAYS_WALL);
    expect(traces.some((l) => /Wall of Ice #75861085 stands in the doorway at \(16966\.0, 18498\.5\) and the body stalls there; no other doorway route; ending/.test(l))).toBe(true);
  }, 120_000);

  it('with another doorway route, the walk routes round the doorway a creature stands in and arrives', async () => {
    // The same wall in the west doorway of 0x015C (from 0x015E): the way on is round by 0x015C's east side.
    const S = Math.SQRT1_2;
    const { r, traces } = await walk(0x120, null, [wallOfIce(0x75861099, 0x15e, 65.25, -130, { w: S, x: 0, y: 0, z: S })], 0.35);
    expect(r.ok, r.message).toBe(true);
    expect(r.message).toMatch(/^arrived .* cell 0x58610179/);
    expect(traces.some((l) => /Wall of Ice #75861099 stands in the doorway at .*; routing round it, \d+ doorway\(s\)/.test(l))).toBe(true);
  }, 300_000);
});
