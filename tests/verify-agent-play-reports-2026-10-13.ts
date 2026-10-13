/**
 * AGENT.play-reports-2026-10-13 — what Claude Arcanist (war mage) and Claude Bulwark (sword and board) hit on the local
 * end-of-retail ACE in Dungeon Fern and Holtburg Dungeon (landblock 0x01F6), 2026-10-12 23:37 – 2026-10-13 01:02 UTC,
 * each driven through the real AgentApi on the fake host (tests/_harness/agentFake.ts), the real tool table, and for
 * the follow that stood still, the real Holtburg Dungeon cells and statics from the DAT (tests/_harness/dungeonWalk.ts).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { AgentApi, compassToYaw } from '../packages/renderer/src/agent/AgentApi.ts';
import type { AgentItem, AgentResult } from '../packages/renderer/src/agent/types.ts';
import { formatObservation } from '../packages/renderer/src/agent/format.ts';
import { castRepeatArgs } from '../tools/ac-agent/tools.ts';
import * as THREE from 'three';
import { ServerObjectManager, type ServerObject } from '../packages/renderer/src/world/ServerObjectManager.js';
import { FakeHost, run } from './_harness/agentFake.ts';
import { DAT_PATHS, openDat } from './_harness/dat.ts';
import type { DungeonNav } from './_harness/dungeonNav.js';

const ARCANIST = 0x50000002;
const BULWARK = 0x50000003;
const vitals = { cur: 40, max: 50 };
const fellow = (guid: number, name: string) => ({ guid, name, health: vitals, stamina: vitals, mana: vitals });

/** Run the page's ticks until the promise settles (or `ms` pass). */
async function settle<T>(api: AgentApi, host: FakeHost, p: Promise<T>, ms: number, each?: () => void): Promise<T | null> {
  let out: T | null = null;
  let done = false;
  void p.then((x) => { out = x; done = true; });
  for (let t = 0; t < ms && !done; t += 100) { each?.(); run(api, host, 100); await Promise.resolve(); await Promise.resolve(); }
  return out;
}

describe('agent play reports 2026-10-13', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); AgentApi.reachHeights.clear(); });

  describe('2, 3. fellows: in view while the server places them, and on which floor', () => {
    beforeEach(() => {
      host.fellows = () => [fellow(ARCANIST, 'Claude Arcanist')];
      // Her cell is not in the VisibleCells of yours (Holtburg Dungeon 0x01F60289 / 0x01F60269 lack each other).
      Object.assign(host, { cellSees: (): boolean => false });
    });

    it('a fellow the server placed a moment ago is in view whatever the PVS says; one it stopped placing is out of sight', () => {
      const o = host.add({ guid: ARCANIST, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, x: 80.3, y: 20 });
      o.heardAt = host.t;
      expect(api.snapshot().fellows?.[0].dist).toBeCloseTo(0.3, 1);
      // The map's letters come from the same list: it agrees.
      expect(api.nearby(10).some((x) => x.guid === ARCANIST)).toBe(true);
      host.t += AgentApi.HEARD_FRESH_MS + 1000;
      expect(api.snapshot().fellows?.[0].dist).toBeUndefined();
      expect(api.nearby(10).some((x) => x.guid === ARCANIST)).toBe(false);
    });

    it('the client stamps when the server last placed an object (ServerObject.serverPlaceAt → the agent\'s heardAt)', () => {
      const som = new ServerObjectManager({ loadSetupModel: () => null } as never, {} as never, new THREE.Scene());
      const o = { guid: ARCANIST, name: 'Claude Arcanist', itemType: 0x10, physicsState: 0, worldX: 0, worldZ: 0, worldY: 0, cellId: 0, objCellId: 0 } as unknown as ServerObject;
      (som as unknown as { objects: Map<number, ServerObject> }).objects.set(ARCANIST, o);
      const before = performance.now();
      som.applyPublicLocationUpdate(ARCANIST, 0x01f60269, 70, -20, 0, 1, 0, 0, 0);
      expect(o.serverPlace).toMatchObject({ cell: 0x01f60269 });
      expect(o.serverPlaceAt).toBeGreaterThanOrEqual(before);
    });

    it('the fellows line says up / down when a fellow is on another level (6 m below under the Fern ledge read "2 m SW")', () => {
      const o = host.add({ guid: ARCANIST, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, x: 78.6, y: 18.6, z: 88 });
      o.heardAt = host.t;
      expect(formatObservation(api.observe())).toMatch(/fellows: Claude Arcanist 80% HP, 2 m SW, down 6 m/);
      o.z = 93.5;
      expect(formatObservation(api.observe())).toMatch(/fellows: Claude Arcanist 80% HP, 2 m SW(;|\n|$)/);
    });

    it('stay_with: a fellow beside you who drops from view for a moment is still with you; one gone for long stops the walk', async () => {
      const o = host.add({ guid: ARCANIST, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, x: 79, y: 20 });
      let hiddenFrom = 2000, hiddenTo = 6000;
      const keepBeside = (): void => { o.x = host.me.x - 1; o.y = host.me.y; o.heardAt = host.t >= hiddenFrom && host.t < hiddenTo ? host.t - 60_000 : host.t; };
      const r = await settle(api, host, api.walkTo('40m east', { stayWith: 'Claude Arcanist' }), 30_000, keepBeside);
      expect(r, String(r?.message)).toMatchObject({ ok: true });
      expect(r!.message).toMatch(/^arrived/);
      // Out of view for longer than the grace: the walk stops and says so.
      host.me.x = 80; host.me.y = 20;
      hiddenFrom = host.t + 1000; hiddenTo = host.t + 60_000;
      const r2 = await settle(api, host, api.walkTo('60m east', { stayWith: 'Claude Arcanist' }), 30_000, keepBeside);
      expect(r2!.ok).toBe(false);
      expect(r2!.message).toMatch(/Claude Arcanist is out of sight/);
    });
  });

  describe('4. a name means the living one here before a corpse or a place remembered elsewhere', () => {
    it('cast at "Claude Bulwark" never takes his corpse; with him in view it is him', async () => {
      host.fellows = () => [fellow(BULWARK, 'Claude Bulwark')];
      host.add({ guid: 0x80006001, name: 'Corpse of Claude Bulwark', itemType: 0x200, objectDescFlags: 0x2000, x: 82, y: 22 });
      const r = await api.cast('Flame Bolt I', 'Claude Bulwark');
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/^Claude Bulwark is not in view \(in your fellowship, but not in sight.*only Corpse of Claude Bulwark #80006001 matches/);
      expect(host.sent.some((s) => s.startsWith('cast'))).toBe(false);
      expect(api.resolve('Corpse of Claude Bulwark')).toBe(0x80006001);
      expect(api.resolve('Claude Bulwark corpse')).toBe(0x80006001);
      host.add({ guid: BULWARK, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, x: 85, y: 25 });
      expect(api.resolve('Claude Bulwark')).toBe(BULWARK);
    });

    it('"Surface" in Holtburg Dungeon is its own exit, not Dungeon Fern\'s remembered one', () => {
      const FERN_SURFACE = 0x701b300b, HOLTBURG_SURFACE = 0x701f6062;
      host.me = { ...host.me, cell: 0x01b30120, x: 40, y: -10, z: 0 };
      host.add({ guid: FERN_SURFACE, name: 'Surface', itemType: 0x10000, objectDescFlags: 0x40000, cell: 0x01b30120, x: 40, y: -1, z: 0 });
      run(api, host, 200, { physics: false });
      host.objs.delete(FERN_SURFACE);
      host.me = { ...host.me, cell: 0x01f60224, x: 34, y: -48, z: 0 };
      host.add({ guid: HOLTBURG_SURFACE, name: 'Surface', itemType: 0x10000, objectDescFlags: 0x40000, cell: 0x01f6022e, x: 38.86, y: 1.4, z: 0.07 });
      run(api, host, 200, { physics: false });
      expect(api.resolve('Surface', 'world')).toBe(HOLTBURG_SURFACE);
      // Both only remembered now: the one in this landblock first.
      host.objs.delete(HOLTBURG_SURFACE);
      run(api, host, 200, { physics: false });
      expect(api.resolve('Surface', 'world')).toBe(HOLTBURG_SURFACE);
    });

    it('"Holtburg Dungeon Directions" (a sign) is never the "Holtburg Dungeon" portal; the exact name wins when both are here', () => {
      const PORTAL = 0x7a9b4001, SIGN = 0x7a9b4002;
      host.add({ guid: PORTAL, name: 'Holtburg Dungeon', itemType: 0x10000, objectDescFlags: 0x40000, x: 90, y: 20 });
      expect(api.resolve('Holtburg Dungeon Directions', 'world')).toBeNull();
      host.add({ guid: SIGN, name: 'Holtburg Dungeon Directions', itemType: 0x80, objectDescFlags: 0, x: 92, y: 22 });
      expect(api.resolve('Holtburg Dungeon Directions', 'world')).toBe(SIGN);
      expect(api.resolve('Holtburg Dungeon', 'world')).toBe(PORTAL);
      // An item named with its material still matches the plain name (ACE GetNameWithMaterial).
      host.inv = [{ guid: 0x80007001, name: 'Lugian Hammer', where: 'main pack' } as AgentItem];
      expect(api.resolve('Pine Lugian Hammer', 'inventory')).toBe(0x80007001);
    });
  });

  describe('5, 6, 10. casts: what blocks a bolt, the outcome first, and bolts that do nothing', () => {
    const SERVANT = 0x80005001;
    let reply: (n: number) => void;
    let castsSent: number;
    beforeEach(() => {
      host.spells = () => [
        { id: 27, name: 'Flame Bolt I', school: 'War', level: 1, projectile: true, range: 20 },
        { id: 6, name: 'Heal Self I', school: 'Life', level: 1, self: true },
      ];
      host.add({ guid: SERVANT, name: 'Spikey Armoredillo', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 21.6 });
      host.me.mana = { current: 60, max: 60 };
      castsSent = 0;
      reply = () => { api.pushChat('Casting Flame Bolt I', 0x11); api.pushChat('You say, "Zojak Quaguz"', 0x11); };
      host.cast = (id: number, t: number | null) => {
        host.sent.push(`cast ${id} ${t === null ? 'self' : t.toString(16)}`);
        const n = ++castsSent;
        setTimeout(() => reply(n), 300);
        return true;
      };
    });
    const cast = async (p: Promise<AgentResult>): Promise<AgentResult> => (await settle(api, host, p, 20_000))!;

    it('no line of fire names what is in the way', async () => {
      host.lineOfFire = () => ({ dist: 12, blockedAt: 3.2, blocker: 'Bookshelf' });
      const r = await cast(api.cast('Flame Bolt I', SERVANT));
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/no line of fire to Spikey Armoredillo \(12\.0 m away\): Bookshelf 3\.2 m along the line would take the bolt/);
      expect(castsSent).toBe(0);
    });

    it('a bolt with no damage line says "no hit seen", on the line after the head, before the incantation', async () => {
      const r = await cast(api.cast('Flame Bolt I', SERVANT));
      const lines = r.message.split('\n');
      expect(lines[0]).toBe('casting Flame Bolt I at Spikey Armoredillo #80005001');
      expect(lines[1]).toMatch(/^ {2}no hit seen: no damage line came for it \(Spikey Armoredillo is 1\.6 m away\)/);
      expect(lines.slice(2)).toEqual(['  Casting Flame Bolt I', '  You say, "Zojak Quaguz"']);
    });

    it('a fizzle leads the reply (it was printed last and cut off by `| head`)', async () => {
      reply = () => { api.pushChat('You say, "Zojak Quaguz"', 0x11); api.pushChat('Your spell fizzled.', 0x07); };
      const r = await cast(api.cast('Flame Bolt I', SERVANT));
      expect(r.ok).toBe(false);
      expect(r.message.split('\n').slice(0, 2)).toEqual(['casting Flame Bolt I at Spikey Armoredillo #80005001', '  Your spell fizzled.']);
    });

    it('repeat stops after two bolts running that did nothing, and says so', async () => {
      const r = await cast(api.cast('Flame Bolt I', SERVANT, { repeat: true }));
      expect(castsSent).toBe(2);
      expect(r.message).toMatch(/stopped: 2 bolts running did no damage you were told of \(Spikey Armoredillo 1\.6 m away\)/);
      expect(r.message).toContain('  1: no hit seen: no damage line (Spikey Armoredillo 1.6 m away)');
    });
  });

  it('7. until_health takes a fraction or a percent, as vitals_below does (0.4 was read as 0.4%)', () => {
    expect(castRepeatArgs({ repeat: true, until_health: 0.4 })).toEqual({ repeat: true, untilHealth: 0.4 });
    expect(castRepeatArgs({ repeat: 'true', until_health: '40' })).toEqual({ repeat: true, untilHealth: 0.4 });
    expect(castRepeatArgs({ repeat: true, until_health: 0 })).toEqual({ repeat: true, untilHealth: 0 });
    expect(castRepeatArgs({ repeat: true, until_health: 1 })).toEqual({ repeat: true, untilHealth: 1 });
  });

  describe('8. pick-up waits while the server walks you to the item', () => {
    const NOTE = 0x80005702;
    beforeEach(() => { host.add({ guid: NOTE, name: 'Parchment', itemType: 0x2000, objectDescFlags: 0, x: 80, y: 30 }); });

    it('a server walk longer than 15 s still ends "picked up"', async () => {
      let arrived = false;
      const r = await settle(api, host, api.pickUp('Parchment'), 60_000, () => {
        // The server's MoveTo: the body creeps on round the shelves for 25 s, then the item lands in the pack.
        if (host.t < 25_000) host.me.y += 0.03;
        else if (!arrived) { arrived = true; host.inv = [{ guid: NOTE, name: 'Parchment', where: 'main pack' } as AgentItem]; }
      });
      expect(r).toMatchObject({ ok: true, message: "picked up Parchment: it's in your pack now" });
    });

    it('no answer and no walk: says how far it is and that it may still land', async () => {
      const r = await settle(api, host, api.pickUp('Parchment'), 60_000);
      expect(r!.ok).toBe(false);
      expect(r!.message).toMatch(/^no answer from the server about Parchment in 15 s; it is not in your pack yet \(it is 10\.0 m from you\)\. The pick-up may still land/);
    });
  });

  it('9. attack says how far the target is, on which floor, and who would be left behind', () => {
    const CELL = 0x01f60224;
    host.me = { ...host.me, cell: CELL, x: 30, y: -50, z: 0 };
    host.fellows = () => [fellow(ARCANIST, 'Claude Arcanist')];
    host.add({ guid: ARCANIST, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, cell: CELL, x: 31, y: -50, z: 0 });
    host.add({ guid: 0x80004cf6, name: 'Spikey Armoredillo', itemType: 0x10, objectDescFlags: 0x10, cell: CELL, x: 30, y: -15, z: 6 });
    const r = api.attack('Spikey Armoredillo');
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/^running up to Spikey Armoredillo \(#80004cf6\): 35 m N, 6 m above you \(another floor: the way there climbs\); Claude Arcanist \(1 m from you now\) would be 35 m from you there, on another floor, then attacking/);
    api.stopMoving();
  });

  describe('11. the smaller reports', () => {
    it('/tell without a comma says how to write it (retail DoTell takes the name up to a comma)', () => {
      host.fellows = () => [fellow(ARCANIST, 'Claude Arcanist')];
      const r = api.say('/tell Claude Arcanist meet me at the portal');
      expect(r.ok).toBe(false);
      expect(r.message).toContain('/tell Claude Arcanist, meet me at the portal');
      expect(api.say('/tell Somebody Else hi').message).toContain('/tell Their Name, your message');
      expect(api.say('/tell Claude Arcanist, meet me at the portal')).toEqual({ ok: true, message: 'sent: /tell Claude Arcanist, meet me at the portal' });
    });

    it('use_on interrupted by your death says you died, not the portal-space lines alone', async () => {
      host.inv = [{ guid: 0x80008001, name: 'Crude Healing Kit', where: 'main pack' } as AgentItem];
      host.add({ guid: BULWARK, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, x: 81, y: 20 });
      const r = await settle(api, host, api.useOnReported('Crude Healing Kit', 'Claude Bulwark'), 15_000, () => {
        if (host.t === 1000) { host.me.dead = true; api.pushChat('Spikey Armoredillo splits you apart!', 0x15); api.pushChat('In Portal Space', 0x00); }
      });
      expect(r!.ok).toBe(false);
      expect(r!.message).toMatch(/^used Crude Healing Kit on Claude Bulwark: you died before it finished/);
    });

    it('a melee target no swing reaches at any height (a ghost) ends the attack with target-lost, inside one 45 s wait', async () => {
      host.me.combatMode = 'melee';
      host.add({ guid: 0x80004cf6, name: 'Spikey Armoredillo', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 21.5 });
      api.attack('Spikey Armoredillo');
      const w = api.wait({ types: ['target-died', 'target-lost'] }, 45_000);
      const evs = await settle(api, host, w, 45_000, () => { host.pending = false; });
      expect(evs?.map((e) => e.type)).toEqual(['target-lost']);
      expect(evs?.[0].text).toMatch(/swings at all three heights reported nothing/);
      expect(host.sent.filter((s) => s.startsWith('height'))).toEqual(['height low', 'height high']);
    });
  });
});

/**
 * 1. `follow` stood still in Holtburg Dungeon (cell 0x01F60224, 2026-10-13 00:16–00:19 UTC) while walk_to the same
 * fellow went at once: the doorway route's next point (0x0224 → 0x0233, at (227, 47182)) was within the follow's 4 m,
 * so it counted as reached and no way round was searched, while a row of bookshelves (statics 0x02000183) stands in
 * that doorway; W held into the shelves for 12 s, three times. A doorway is reached on it, never within the goal's reach.
 */
describe.skipIf(!existsSync(DAT_PATHS.cell) || !existsSync(DAT_PATHS.portal))('1. follow in Holtburg Dungeon (0x01F6): round the bookshelves in the doorway', () => {
  const LB = 0x01f60000;
  let nav: DungeonNav;
  beforeAll(async () => {
    const { dungeonNav } = await import('./_harness/dungeonNav.js');
    nav = await dungeonNav(LB, { statics: true });
  }, 120_000);
  afterEach(() => vi.useRealTimers());

  it('follows a fellow 33 m off from beside the shelves, as walk_to did', async () => {
    vi.useFakeTimers();
    const { DungeonHost } = await import('./_harness/dungeonWalk.js');
    const host = new DungeonHost(nav, { portal: openDat(DAT_PATHS.portal), cell: openDat(DAT_PATHS.cell) }, LB);
    host.me = { ...host.me, cell: (LB | 0x224) >>> 0, x: 33.5, y: -48.2, z: 0, yaw: compassToYaw(0) };
    // Bulwark by the Directions sign, 30 m east (cell 0x01F601DB).
    host.add({ guid: BULWARK, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, cell: (LB | 0x1db) >>> 0, x: 65, y: -34, z: -6 });
    const api = new AgentApi(host);
    const log = console.log;
    console.log = (...a: unknown[]) => { host.traces.push(a.join(' ')); };
    try {
      let r: AgentResult | null = null;
      void api.follow('Claude Bulwark', { durationMs: 40_000 }).then((x) => { r = x; });
      for (let t = 0; t < 60_000 && !r; t += 100) {
        host.t += 100;
        vi.advanceTimersByTime(100);
        host.physics(100);
        api.tick();
        await Promise.resolve();
      }
      expect(r, host.traces.join('\n')).toMatchObject({ ok: true });
      expect(r!.message).toMatch(/^followed Claude Bulwark for 40 s; they are [0-9] m/);
      const d = Math.hypot(host.me.x - 65, host.me.y + 34);
      expect(d).toBeLessThan(7);
    } finally {
      console.log = log;
      host.dispose();
    }
  }, 120_000);
});
