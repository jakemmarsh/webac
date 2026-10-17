/**
 * Stream reports, 2026-10-17 16:07Z (segment 15:06–16:08Z, build 7bddbaec; Claude Arcanist and Claude Bulwark on the
 * local end-of-retail ACE server). Each item's cause, from the page logs and transcripts:
 *
 * 1. Arcanist's `use` of the Facility Hub's Tusker Habitat portal (#78A02079) was sent at 15:18:25Z while she was still
 *    in portal space from the Hub portal before; the walk set off from the server's arrival spot, the arrival of that
 *    earlier trip ("portal: arrived", 15:18:57Z) came during it, and portedSince took any 'portal' event since the use
 *    began for its own trip: "used Tusker Habitat: it took you through" at 15:19:10Z with her still in the Hub. Now a use
 *    in portal space waits for the arrival first, and only your own entry into portal space by that portal (or one on
 *    its spot, or by no portal the client could name) counts as its trip.
 * 2. Bulwark's `use` of Cragstone's Portal to Town Network #7BC9F075 (15:17:09Z) and Arcanist's (15:16:28Z) each ended
 *    "took longer than 45 s and stopped 29.6 / 31.8 m away": ace_world has a second Portal to Town Network, #7BC9F435,
 *    on the very same spot (0xBC9F003C (178.418, 78.8008, 32.198)), and the walk into #7BC9F075 kept out of #7BC9F435's
 *    disk, which covers the goal: every search found none. walk_to the same portal (stopping outside the disks) found its
 *    way in 0.2 s right after. Then both players' use of the Tusker Habitat portal in the Facility Hub (15:18:21Z) stood
 *    searching at the doorway 0x8A0201C9 → 0x8A0201C8 at (60, −75): a 6 m tall opening (floor 0) that the ramp down from
 *    the arrival crosses at z 3. The probe reached the doorway at z 3 and every leg and search toward it called it
 *    "blocked" ("the probe stops at (26556.0, 309.0, z 3.0)", the doorway's own point), as at (60, −45) after it. A
 *    doorway's leg is now reached anywhere up its opening (navPlanner NavGoal.zTop, cellPath RoutePoint.top).
 * 3. Arcanist's second Heavy Bracelet replaced the first on the right wrist: both wrists held bracelets then (the log's
 *    auto-dequips of 0x8000e96c and 0x8000c371, both slot 0x20000). Retail does the same (CPlayerSystem::AutoWield
 *    @ 00560a60: the right wrist, else the left when free, else the right's item comes off); the reply now says both
 *    were taken and the slot= that replaces the other one.
 * 4. Impenetrability / Bludgeon Bane "expired" on Gloves and Steel Toed Boots in her pack (15:43:33–15:44:14Z): the
 *    server's line for an item's own enchantment, wherever the item is (retail prints it the same). The buff-expired
 *    event no longer fires for items you don't wear, and "spells on your gear" counts only the pieces still worn (it said
 *    "on 10 items" all segment after two went into the pack).
 * 5. Bulwark's walk to "25.8N, 49.2E" (Cragstone's smithy, 15:08:16–15:10:02Z) searched 105 s at its wall with
 *    "0 doorway(s) ahead": the point's room (0xBC9F014B, floor z 32) was looked for within 3 m of his feet when he
 *    crossed into the landblock (z 54 on its west edge), found none, and the walk kept the point as the landscape. A map
 *    coordinate out on the landscape now finds the building's room on the land under the point.
 */
import { existsSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import type { AgentItem } from '../packages/renderer/src/agent/types.ts';
import { formatObservation } from '../packages/renderer/src/agent/format.ts';
import { onGoalLevel, straightWalk } from '../packages/renderer/src/agent/navPlanner.ts';
import { findRouteViaOutside, floorsAt, loadCellGraph, type CellGraph } from '../packages/renderer/src/agent/cellPath.ts';
import { EquipMask, UISlotSide, resolveAutoWield } from '@ac/shared';
import { DatReader } from '../packages/dat-parser/src/DatReader.ts';
import { RegionDesc } from '../packages/dat-parser/src/file-types/RegionDesc.ts';
import { FakeHost, HOLTBURG, run } from './_harness/agentFake.ts';
import { DAT_PATHS, openDat } from './_harness/dat.ts';
import type { DungeonNav } from './_harness/dungeonNav.ts';

async function settle<T>(api: AgentApi, host: FakeHost, p: Promise<T>, maxMs = 60_000): Promise<T> {
  let out: T | undefined;
  let done = false;
  void p.then((r) => { out = r; done = true; });
  for (let t = 0; t < maxMs && !done; t += 100) { run(api, host, 100); await vi.advanceTimersByTimeAsync(0); }
  if (!done) throw new Error('never answered');
  return out as T;
}

const PORTAL_FLAGS = { itemType: 0x10000, objectDescFlags: 0x40000 };

describe('stream reports 2026-10-17 16:07Z: use, equip, gear spells, map coordinates', () => {
  let host: FakeHost;
  let api: AgentApi;
  let approachMs = AgentApi.USE_APPROACH_MS;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    api = new AgentApi(host);
    approachMs = AgentApi.USE_APPROACH_MS;
  });
  afterEach(() => { AgentApi.USE_APPROACH_MS = approachMs; vi.restoreAllMocks(); vi.useRealTimers(); });

  describe('1. only your own entry into a portal is its use', () => {
    const HUB = 0xa9b40150;
    const HABITAT = 0x78a02079;

    it('a use sent in portal space waits for the arrival, and the trip before\'s arrival is not this portal\'s trip', async () => {
      // Arcanist: in portal space from the Hub portal; the Tusker Habitat portal walled off from where she lands.
      host.cellSealed = (c) => (c & 0xffff) >= 0x100;
      host.me.cell = HUB; host.me.x = 60; host.me.y = 20;
      host.add({ guid: HABITAT, name: 'Tusker Habitat', ...PORTAL_FLAGS, cell: HUB, x: 90, y: 60 });
      host.wall = (x, y) => (y > 39 && y < 41) || (x > 74 && x < 76);
      host.screenName = 'portal-space';
      run(api, host, 300);
      AgentApi.USE_APPROACH_MS = 8_000;
      const p = api.use(HABITAT);
      let r: Awaited<typeof p> | undefined;
      void p.then((x) => { r = x; });
      run(api, host, 2000);
      await vi.advanceTimersByTimeAsync(0);
      expect(r).toBeUndefined();
      // Nothing is used, nor walked toward, from portal space.
      expect(host.sent.filter((s) => s.startsWith('use'))).toEqual([]);
      host.screenName = 'world';
      const out = await settle(api, host, p, 120_000);
      expect(api.eventsSince().filter((e) => e.type === 'portal').map((e) => e.text)).toEqual(['entered portal space', 'arrived']);
      expect(out.ok).toBe(false);
      expect(out.message).toMatch(/^couldn't reach Tusker Habitat: /);
      expect(out.message).not.toMatch(/took you through/);
    });

    it('still in portal space after the wait: not used, and says to wait for the arrival', async () => {
      host.add({ guid: HABITAT, name: 'Tusker Habitat', ...PORTAL_FLAGS, x: 90, y: 60 });
      host.screenName = 'portal-space';
      run(api, host, 300);
      const r = await settle(api, host, api.use(HABITAT), 40_000);
      expect(r).toEqual({ ok: false, message: 'not used: you are still in portal space (the last portal\'s trip); nothing can be used until you arrive. ac_wait types=portal for the arrival, then use Tusker Habitat' });
      expect(host.sent.filter((s) => s.startsWith('use'))).toEqual([]);
    });

    it('"it already took you" only for the portal you stepped into, not after another portal\'s trip', async () => {
      host.cellSealed = (c) => (c & 0xffff) >= 0x100;
      const TOWN = 0x7a9b4080, OTHER = 0x7a9b4081;
      host.add({ guid: TOWN, name: 'Portal to Town Network', ...PORTAL_FLAGS, x: 80, y: 30 });
      host.add({ guid: OTHER, name: 'Portal to Cragstone', ...PORTAL_FLAGS, x: 20, y: 30 });
      // Stepped into Portal to Cragstone, not the Town Network one.
      host.me.x = 20; host.me.y = 28.5;
      run(api, host, 200);
      host.screenName = 'portal-space';
      run(api, host, 500);
      host.me.cell = 0x00070143; host.me.x = 60; host.me.y = 60;
      host.screenName = 'world';
      run(api, host, 1500);
      expect(api.eventsSince().find((e) => e.text === 'entered portal space')?.guid).toBe(OTHER);
      const r = await settle(api, host, api.use('Portal to Town Network'), 120_000);
      expect(r.message).not.toMatch(/already took you/);
      expect(r.message).toMatch(/^couldn't reach Portal to Town Network: .*that is outside this dungeon.*No walk gets there/);
      // The one stepped into is the one that took you.
      const r2 = await settle(api, host, api.use(OTHER), 120_000);
      expect(r2.message).toMatch(/^used Portal to Cragstone: it already took you through \d+ s ago/);
    });
  });

  describe('2. into a portal with a duplicate on its spot (Cragstone\'s two Portals to Town Network)', () => {
    it('the use walks into it round the wall; the duplicate\'s disk is no wall round the goal', async () => {
      // ace_world: #7BC9F075 and #7BC9F435, both ace43065-portaltotownnetwork at 0xBC9F003C (178.418, 78.8008, 32.198).
      const A = 0x7bc9f075, B = 0x7bc9f435;
      host.add({ guid: A, name: 'Portal to Town Network', ...PORTAL_FLAGS, x: 80, y: 60 });
      host.add({ guid: B, name: 'Portal to Town Network', ...PORTAL_FLAGS, x: 80, y: 60 });
      host.objectReach = () => 1;
      // A wall across the straight line, open at its east end: the use walks the planner's way (straightStopsShort).
      host.wall = (x, y) => y > 39 && y < 41 && x < 86;
      host.me.x = 80; host.me.y = 20;
      AgentApi.USE_APPROACH_MS = 45_000;
      let entered = false;
      const physics = host.physics.bind(host);
      // The body touching a portal (its 1 m reach plus the body's radius) takes you through it: either of the two.
      host.physics = (dt: number) => { physics(dt); if (!entered && Math.hypot(host.me.x - 80, host.me.y - 60) < 1.6) { entered = true; host.screenName = 'portal-space'; } };
      const r = await settle(api, host, api.use(A), 120_000);
      expect(r.ok, r.message).toBe(true);
      expect(r.message).toMatch(/^used Portal to Town Network: walked into it/);
      expect(entered).toBe(true);
    });
  });

  describe('3. equip: a free wrist or ring first, as retail\'s AutoWield; with both taken, the reply says which', () => {
    const resolve = (worn: Array<{ id: number; slot: number }>, valid: number) => resolveAutoWield(
      { id: 99, validLocations: valid },
      worn.reduce((m, w) => m | w.slot, 0),
      (bits) => worn.find((w) => w.slot & bits)?.id ?? 0,
      UISlotSide.Right,
      true,
    );
    const WRISTS = EquipMask.WristWearLeft | EquipMask.WristWearRight;
    it('CPlayerSystem::AutoWield @ 00560a60: the right wrist, else the left when free, else the right one comes off', () => {
      expect(resolve([], WRISTS)).toEqual({ kind: 'wield', slot: EquipMask.WristWearRight });
      expect(resolve([{ id: 1, slot: EquipMask.WristWearRight }], WRISTS)).toEqual({ kind: 'wield', slot: EquipMask.WristWearLeft });
      expect(resolve([{ id: 2, slot: EquipMask.WristWearLeft }], WRISTS)).toEqual({ kind: 'wield', slot: EquipMask.WristWearRight });
      expect(resolve([{ id: 1, slot: EquipMask.WristWearRight }, { id: 2, slot: EquipMask.WristWearLeft }], WRISTS)).toMatchObject({ kind: 'blocked', blockingId: 1 });
    });

    it('a free left wrist: no swap and no note', async () => {
      const FIRST: AgentItem = { guid: 0x8000c371, name: 'Heavy Bracelet', where: 'equipped', mask: 0x20000, validLocations: 0x30000 };
      const SECOND: AgentItem = { guid: 0x8000c68d, name: 'Heavy Bracelet', where: 'main pack', validLocations: 0x30000 };
      host.inv = [{ ...FIRST }, { ...SECOND }];
      host.wield = (g: number) => { host.inv = host.inv.map((i) => (i.guid === g ? { ...i, where: 'equipped', mask: 0x10000 } : i)); return true; };
      const r = await settle(api, host, api.equip(SECOND.guid), 20_000);
      expect(r).toEqual({ ok: true, message: 'equipped Heavy Bracelet (left wrist)' });
    });

    it('both wrists taken (Arcanist, 15:48:29Z): replaced the right one, and names the left one and the slot= for it', async () => {
      const RIGHT: AgentItem = { guid: 0x8000c371, name: 'Heavy Bracelet', where: 'equipped', mask: 0x20000, validLocations: 0x30000 };
      const LEFT: AgentItem = { guid: 0x8000e760, name: 'Heavy Bracelet', where: 'equipped', mask: 0x10000, validLocations: 0x30000 };
      const NEW: AgentItem = { guid: 0x8000c68d, name: 'Heavy Bracelet', where: 'main pack', validLocations: 0x30000 };
      host.inv = [{ ...RIGHT }, { ...LEFT }, { ...NEW }];
      host.wield = (g: number) => {
        host.inv = host.inv.map((i) => (i.guid === RIGHT.guid ? { ...i, where: 'main pack', mask: undefined } : i.guid === g ? { ...i, where: 'equipped', mask: 0x20000 } : i));
        return true;
      };
      const r = await settle(api, host, api.equip(NEW.guid), 20_000);
      expect(r).toEqual({ ok: true, message: 'equipped Heavy Bracelet (right wrist), taking off Heavy Bracelet #8000c371 into your pack\n  (both wrists were taken, so it went on the right wrist as a double-click does; to replace Heavy Bracelet #8000e760 on the left wrist instead, equip with slot="left wrist")' });
    });

    it('rings: the same note with the ring slot word', async () => {
      const R: AgentItem = { guid: 0x80000a01, name: 'Ring', where: 'equipped', mask: 0x80000, validLocations: 0xc0000 };
      const L: AgentItem = { guid: 0x80000a02, name: 'Jade Ring', where: 'equipped', mask: 0x40000, validLocations: 0xc0000 };
      const N: AgentItem = { guid: 0x80000a03, name: 'Gold Ring', where: 'main pack', validLocations: 0xc0000 };
      host.inv = [{ ...R }, { ...L }, { ...N }];
      host.wield = (g: number) => { host.inv = host.inv.map((i) => (i.guid === R.guid ? { ...i, where: 'main pack', mask: undefined } : i.guid === g ? { ...i, where: 'equipped', mask: 0x80000 } : i)); return true; };
      const r = await settle(api, host, api.equip(N.guid), 20_000);
      expect(r.message).toMatch(/\(both ring fingers were taken, so it went on the right ring finger as a double-click does; to replace Jade Ring #80000a02 on the left ring instead, equip with slot="left ring"\)$/);
    });
  });

  describe('4. an item spell running out in your pack is no buff of yours to recast', () => {
    beforeEach(() => {
      host.inv = [
        { guid: 0x80000101, name: 'Platemail Gauntlets', where: 'equipped', slot: 'Hands' },
        { guid: 0x80000102, name: 'Gloves', where: 'equipped', slot: 'Hands' },
        { guid: 0x80000103, name: 'Steel Toed Boots', where: 'equipped', slot: 'Feet' },
      ];
      Object.assign(host, { spellTableData: () => ({ spells: new Map([[1510, { name: 'Impenetrability V', desc: '', category: 0, school: 3, bitfield: 0, power: 250, duration: 1800 }]]) }) });
      for (const n of ['Platemail Gauntlets', 'Gloves', 'Steel Toed Boots']) api.pushChat(`You cast Impenetrability V on ${n}`, 0x07);
      // Gloves and boots swapped for plate: into the pack.
      host.inv = host.inv.map((i) => (i.name === 'Platemail Gauntlets' ? i : { ...i, where: 'main pack', slot: undefined }));
    });

    it('"spells on your gear" counts the pieces still worn', () => {
      host.t += 60_000;
      expect(api.gearSpells()).toEqual([{ spell: 'Impenetrability V', items: 1, castAgoS: 60, leftS: 1740 }]);
      expect(formatObservation(api.observe())).toContain('Impenetrability V on 1 item');
    });

    it('expiry lines for pack items alone make no buff-expired event; mixed ones name the pack items apart', () => {
      api.pushChat('The spell Impenetrability V on Gloves has expired.', 0x07);
      api.pushChat('The spell Impenetrability V on Steel Toed Boots has expired.', 0x07);
      run(api, host, 600);
      expect(api.eventsSince().filter((e) => e.type === 'buff-expired')).toEqual([]);
      for (const n of ['Gloves', 'Platemail Gauntlets']) api.pushChat(`The spell Impenetrability V on ${n} has expired.`, 0x07);
      run(api, host, 600);
      expect(api.eventsSince().filter((e) => e.type === 'buff-expired').map((e) => e.text)).toEqual([
        'Impenetrability V has expired on your Platemail Gauntlets (an item spell on your gear): recast it (ac_cast spell="Impenetrability V"); it also ran out on Gloves in your pack (not worn: nothing to recast there)',
      ]);
    });
  });

  describe('5. a map coordinate in a building, walked to from the landscape a storey above it', () => {
    it('finds the room on the land under the point, not within 3 m of your feet: the walk gets its doorway route', async () => {
      // Cragstone: the smithy's room 0xBC9F014B (floor 32) under "25.8N, 49.2E"; Bulwark at z 54 on the hill. In the
      // fake's landblock: the room at local (100, 100), the land there at 32.
      const ROOM = 0xa9b4014b;
      host.me.z = 54;
      host.floorsAt = (_lb, x, y) => (Math.abs(x - 100) < 3 && Math.abs(y - 100) < 3 ? [{ cell: ROOM, z: 32 }] : []);
      host.navTerrain = () => ({ sea: false, steep: false, wade: 0, height: 32 });
      const routedTo: number[] = [];
      const route = host.route;
      host.route = (fc, f, tc, to) => { routedTo.push(tc >>> 0); return route(fc, f, tc, to); };
      host.routeTo = [{ x: 100, y: 96, z: 32 }];
      const ox = ((HOLTBURG >>> 24) & 0xff) * 192, oy = ((HOLTBURG >>> 16) & 0xff) * 192;
      const ns = (oy + 100) / 240 - 101.95, ew = (ox + 100) / 240 - 101.95;
      void api.walkTo(`${ns.toFixed(4)}N, ${ew.toFixed(4)}E`, { timeoutMs: 5000 });
      run(api, host, 300);
      expect(routedTo).toContain(ROOM);
    });
  });
});

const haveDat = existsSync(DAT_PATHS.cell) && existsSync(DAT_PATHS.portal);

describe.skipIf(!haveDat)('the Facility Hub (0x8A02, cell DAT): the ramp crosses a 6 m doorway 3 m above its floor', () => {
  const LB = 0x8a020000;
  let nav: DungeonNav;
  let graph: CellGraph;
  beforeAll(async () => {
    const { dungeonNav } = await import('./_harness/dungeonNav.ts');
    nav = await dungeonNav(LB, { statics: true });
    const portal = openDat(DAT_PATHS.portal);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const region: any = new RegionDesc(new DatReader(portal.getFileData(0x13000000)!));
    graph = loadCellGraph(openDat(DAT_PATHS.cell), portal, LB, { landHeightTable: region.landDefs?.landHeightTable ?? region.landHeightTable });
  }, 120_000);
  afterEach(() => vi.useRealTimers());

  const rampTop = (): { x: number; y: number; z: number } => {
    const f = floorsAt(graph, 60, -79).filter((q) => q.cell === 0x8a0201c9).sort((a, b) => b.z - a.z)[0];
    return { x: 60, y: -79, z: f.z };
  };

  it('the route\'s doorway at (60, −75) has its floor at 0 and its top at 6; the ramp reaches it at about z 3', () => {
    const route = findRouteViaOutside(graph, 0x8a0201c9, rampTop(), 0x8a020122, { x: 90, y: -40, z: -12.05 }, { maxDrop: 5 })!;
    const door = route.find((p) => Math.hypot(p.x - 60, p.y + 75) < 0.1)!;
    expect(door).toMatchObject({ feet: 0, top: 6 });
    // The probe works in the collision's frame: the cells at their landblock's offset (the agent's global metres).
    const OX = 0x8a * 192, OY = 0x02 * 192;
    const from = { ...rampTop(), x: OX + 60, y: OY - 79 };
    // The live trace: "the probe stops at (26556.0, 309.0, z 3.0)", the doorway's own point.
    const end = nav.probe(from, { x: OX + 60, y: OY - 75 })!;
    expect([OX + 60, OY - 75]).toEqual([26556, 309]);
    expect(Math.hypot(end.x - (OX + 60), end.y - (OY - 75))).toBeLessThan(0.15);
    expect(end.z).toBeGreaterThan(2.5);
    expect(end.z).toBeLessThan(3.5);
    // Without the opening's top the leg is "blocked" by the 3 m; with it, reached.
    expect(straightWalk(nav.probe, from, { x: OX + 60, y: OY - 75, z: 0 })).toBe(false);
    expect(straightWalk(nav.probe, from, { x: OX + 60, y: OY - 75, z: 0, zTop: 6 })).toBe(true);
    expect(onGoalLevel({ x: 0, y: 0, z: 0, zTop: 6 }, end.z)).toBe(true);
    expect(onGoalLevel({ x: 0, y: 0, z: 0, zTop: 6 }, 4.5)).toBe(false);
  });

  it('the real walk from the ramp to the Tusker Habitat portal\'s room arrives, with no "no way into the doorway"', async () => {
    vi.useFakeTimers();
    const { DungeonHost } = await import('./_harness/dungeonWalk.ts');
    const host = new DungeonHost(nav, { portal: openDat(DAT_PATHS.portal), cell: openDat(DAT_PATHS.cell) }, LB);
    try {
      const r = await host.walk(0x8a0201c9, rampTop(), { cell: 0x8a020122, x: 88, y: -40, z: -12.05, name: 'Beside the Tusker Habitat portal' }, { within: 2, maxMs: 150_000 });
      expect(r, host.traces.join('\n')).toMatchObject({ ok: true });
      expect(host.traces.filter((l) => /no way into the doorway at \(\d+\.\d, \d+\.\d\)/.test(l) && /\(26556\.0, 309\.0\)/.test(l))).toEqual([]);
    } finally {
      host.dispose();
    }
  }, 180_000);
});

