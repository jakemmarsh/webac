/**
 * A walk to an NPC on a building's balcony (end of retail local ACE, 2026-10-16 18:31–18:37Z; mage.log). Claude Arcanist's
 * walk_to the Master Scrivener of War Magic (#749B6038, wcid 20223) in the scriveners' building of landblock 0x49B6 searched
 * "none" for ~5 minutes and stalled five times under the balcony (14032.4, 35071.8), 0.7 m from the scrivener seen from above.
 *
 * What the data says:
 *  - World DB (landblock_instance): #749B6038 at (16.39, 127.82, z 243.005) with obj_Cell_Id 0x49B60000. ACE places a cell-0
 *    instance on the landcell under it (Position ctor → SetPosition), so the scrivener is in OUTDOOR cell 0x49B60006 at z 243.
 *  - Cell DAT (0x49B6): no EnvCell floor at z 243 under that point; the only floor is the room 0x49B60130 at z 240. The z-243
 *    surface is the building model's own balcony, outside the upper doorways 0x0135 (14.2, 128.1) and 0x013F (15.3, 131.9)
 *    (doors #749B6031 / #749B6030), which no stair from the landscape reaches (CellDoor.grounded false). The way up is the
 *    stair cell 0x013E.
 *  - So the walk took an outdoor goal for a point on the street: planRoute returned no route for landscape-to-landscape, and
 *    from inside 0x0130 the route left by the ground door 0x0133 and aimed at the balcony 3 m overhead.
 *
 * Fix (cellPath perchExits + routeViaOutside; AgentApi.planRoute): an outdoor end standing on the surfaces outside an
 * ungrounded doorway is on a balcony, reached only through those doorways.
 */
import { existsSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { findRouteViaOutside, loadCellGraph, type CellGraph, type RoutePoint } from '../packages/renderer/src/agent/cellPath.ts';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { RegionDesc } from '../packages/dat-parser/src/file-types/RegionDesc.js';
import { FakeHost, HOLTBURG, run } from './_harness/agentFake.ts';
import { DAT_PATHS, openDat } from './_harness/dat.ts';

const haveDat = existsSync(DAT_PATHS.cell) && existsSync(DAT_PATHS.portal);
const LB = 0x49b60000;
/** The Master Scrivener of War Magic (world DB landblock_instance #749B6038), landblock-local feet. */
const WAR = { x: 16.3913, y: 127.819, z: 243.005 };
const OUT = (LB | 0x0006) >>> 0; // the landcell ACE names for it
const near = (p: RoutePoint, x: number, y: number, m = 0.3): boolean => Math.hypot(p.x - x, p.y - y) <= m;

describe.skipIf(!haveDat)('the real scriveners\' building of landblock 0x49B6', () => {
  let g: CellGraph;
  beforeAll(() => {
    const portal = openDat(DAT_PATHS.portal);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const region: any = new RegionDesc(new DatReader(portal.getFileData(0x13000000)!));
    g = loadCellGraph(openDat(DAT_PATHS.cell), portal, LB, { landHeightTable: region.landDefs?.landHeightTable ?? region.landHeightTable });
  });

  it('the balcony doorways (0x0135, 0x013F) are not grounded; the ground doors (0x0133, 0x0134) are', () => {
    const exit = (c: number) => g.doors.get((LB | c) >>> 0)!.find((d) => d.b === 0xffff)!;
    expect(exit(0x0135).grounded).toBe(false);
    expect(exit(0x013f).grounded).toBe(false);
    expect(exit(0x0133).grounded).toBe(true);
    expect(exit(0x0134).grounded).toBe(true);
  });

  it('from the room under the balcony (0x0130): up the stair 0x013E and out onto the balcony, not out the ground door 0x0133', () => {
    const r = findRouteViaOutside(g, LB | 0x0130, { x: 15.9, y: 128.4, z: 240 }, OUT, WAR)!;
    expect(r).not.toBeNull();
    expect(r.at(-1)).toEqual(WAR);
    expect(r.some((p) => near(p, 8.2, 134.4))).toBe(true); // the stair cell's doorway
    expect(r.some((p) => near(p, 14.2, 128.1) || near(p, 15.3, 131.9))).toBe(true); // a balcony doorway
    expect(r.some((p) => near(p, 16.7, 130.5))).toBe(false); // never the ground door
    // Was: (15.6,128.2) (16.5,130.5) (16.7,130.5) doorstep, then the goal 3 m overhead.
  });

  it('from the street: in by a ground door, up, and out onto the balcony (was: a straight line to under it)', () => {
    const r = findRouteViaOutside(g, OUT, { x: 12.2, y: 124.1, z: 240 }, OUT, WAR)!;
    expect(r.length).toBeGreaterThan(3);
    expect(r.some((p) => near(p, 8.2, 134.4))).toBe(true);
    expect(r.at(-1)).toEqual(WAR);
  });

  it('off the balcony to the street: back in, down the stair, out a ground door', () => {
    const street = { x: 12.2, y: 120, z: 240 };
    const r = findRouteViaOutside(g, OUT, WAR, OUT, street)!;
    expect(r.length).toBeGreaterThan(3);
    expect(r.slice(0, 2).some((p) => near(p, 14.2, 128.1) || near(p, 15.3, 131.9))).toBe(true);
    expect(r.at(-1)).toEqual(street);
  });

  it('on the balcony itself, or street to street: a straight line as before', () => {
    expect(findRouteViaOutside(g, OUT, { x: 15.8, y: 128.6, z: 243 }, OUT, WAR)).toEqual([WAR]);
    const far = { x: 30, y: 120, z: 240 };
    expect(findRouteViaOutside(g, OUT, { x: 12.2, y: 120, z: 240 }, OUT, far)).toEqual([far]);
  });
});

describe('fake host: a walk to an NPC on a balcony over the landscape', () => {
  let host: FakeHost;
  let api: AgentApi;
  const SCRIVENER = 0x749b6038;
  /** Ground at 94 everywhere; a ramp from (20, 30) up to (30, 30) at 97; an upper walkway and a balcony at 97 over the ground. */
  const floors = (x: number, y: number): number[] => {
    const out = [94];
    if (x >= 20 && x <= 30 && y >= 29 && y <= 31) out.push(94 + 0.3 * (x - 20));
    if (x >= 30 && x <= 34 && y >= 18 && y <= 32) out.push(97);
    if (x >= 34 && x <= 40 && y >= 18 && y <= 24) out.push(97);
    return out;
  };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    api = new AgentApi(host);
    host.floors = floors;
    host.me.cell = HOLTBURG; host.me.x = 10; host.me.y = 30; host.me.z = 94;
    host.add({ guid: SCRIVENER, name: 'Master Scrivener of War Magic', itemType: 0x10, objectDescFlags: 0x8, cell: HOLTBURG, x: 37, y: 21, z: 97 });
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('asks the route even with both ends outdoors, and walks it up onto the balcony (was: straight, to under it)', async () => {
    const asked: Array<{ fc: number; tc: number; to: { z: number } }> = [];
    host.route = (fc, _f, tc, to) => {
      asked.push({ fc, tc, to });
      // The building's way: the ramp's foot, its top, the balcony doorway; then the goal.
      return [{ x: 20, y: 30, z: 94 }, { x: 31, y: 30, z: 97 }, { x: 32, y: 21, z: 97 }, to];
    };
    const p = api.walkTo(SCRIVENER, { within: 2 });
    run(api, host, 40_000);
    const r = await p;
    expect(r.ok).toBe(true);
    expect(asked[0]).toMatchObject({ fc: HOLTBURG, tc: HOLTBURG, to: { z: 97 } });
    expect(host.me.z).toBeCloseTo(97, 1);
    expect(Math.hypot(host.me.x - 37, host.me.y - 21)).toBeLessThan(2.5);
  });

  it('a host with no doorway route for it (the open landscape): straight on, and no "no doorway route" line', async () => {
    host.objs.get(SCRIVENER)!.z = 94;
    host.floors = null;
    const lines: string[] = [];
    (console.log as unknown as { mockImplementation: (f: (...a: unknown[]) => void) => void }).mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
    const p = api.walkTo(SCRIVENER, { within: 2 });
    run(api, host, 20_000);
    expect((await p).ok).toBe(true);
    expect(lines.filter((l) => /no doorway route/.test(l))).toEqual([]);
  });

  it('a goal in another landblock is not routed through this one', async () => {
    const asked: number[] = [];
    host.route = (fc) => { asked.push(fc); return null; };
    host.floors = null;
    host.add({ guid: 0x749b6039, name: 'Far Sign', cell: (HOLTBURG + 0x01000000) >>> 0, x: 5, y: 30, z: 94 });
    const p = api.walkTo(0x749b6039, { within: 2 });
    run(api, host, 3_000);
    void p;
    expect(asked).toEqual([]);
  });
});
