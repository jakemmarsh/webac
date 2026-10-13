/**
 * AGENT.play-reports-2026-10-12-night — what Claude Arcanist (a war mage) and Claude Bulwark (sword and board) hit in
 * Holtburg, Dungeon Fern (0x01B3) and Holtburg Dungeon (0x01F6) on the local end-of-retail ACE, 20:33–21:55 UTC, each
 * driven through the real AgentApi on the fake host (tests/_harness/agentFake.ts), the real planner, the real cell
 * graph and the real tool table: flees that stood still while drudges killed the mage (and said "you kept going"),
 * walks inside a dungeon aimed at the landscape 34 km off, "ATTACKING YOU" on the wrong monster, a pick-up reported
 * done that the server cancelled, bolts refused for no reason seen, a shopkeeper behind his counter no walk reached,
 * an unaffordable service read as "busy", a portal Use that never walked, stale vendor ids, a dead target at "hp 32%".
 * Plus ac_wait's vitals-low mark (50% by default, per wait), a big single hit, attackers-up and cast-at-you
 * (Azreath on Coldeve, the same day).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import * as THREE from 'three';
import { ItemType } from '@ac/shared';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { formatObservation } from '../packages/renderer/src/agent/format.ts';
import { counterSpot, findRouteViaOutside, loadCellGraph, type CellGraph } from '../packages/renderer/src/agent/cellPath.ts';
import { ServerObjectManager, type ServerObject } from '../packages/renderer/src/world/ServerObjectManager.js';
import { TOOLS, TOOL_CALLER, type ToolCaller } from '../tools/ac-agent/tools.ts';
import { FakeHost, HOLTBURG, run } from './_harness/agentFake.ts';
import { DAT_PATHS, openDat } from './_harness/dat.ts';

const OX = 0xa9 * 192, OY = 0xb4 * 192;

/** Run the page's ticks until the promise settles (or `ms` pass). */
async function settle<T>(api: AgentApi, host: FakeHost, p: Promise<T>, ms: number, each?: () => void): Promise<T | null> {
  let out: T | null = null;
  let done = false;
  void p.then((x) => { out = x; done = true; });
  for (let t = 0; t < ms && !done; t += 100) { each?.(); run(api, host, 100); await Promise.resolve(); await Promise.resolve(); }
  return out;
}

describe('agent play reports 2026-10-12 (night)', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  const DRUDGE = 0x80004001;
  const drudge = (x: number, y: number, guid = DRUDGE): void => { host.add({ guid, name: 'Drudge Servant', itemType: 0x10, objectDescFlags: 0x10, x, y }); };
  const hit = (): void => api.pushChat('The Drudge Servant nicks your lower leg for 6 points of piercing damage!', 0x15);

  describe('1. a flee moves, and never says "you kept going" for a body that stood still', () => {
    it('"15m east" into rock under attack: the walk runs to the farthest open point at once instead of standing to search', async () => {
      // A corridor running north-south; east of x 86 is rock (the dungeon wall the mage faced).
      host.wall = (x) => x > 86 || x < 76;
      drudge(79, 20);
      const p = api.walkTo('15m east', { within: 1, flee: true });
      hit();
      const r = (await settle(api, host, p, 15_000))!;
      expect(r).not.toBeNull();
      // It went east as far as the corridor goes, and says what's beyond and where it's open.
      expect(host.me.x).toBeGreaterThan(84);
      expect(r.message).toMatch(/went \d+ m and stopped [\d.]+ m short: no way on toward it past there/);
      expect(r.message).toMatch(/Open ways from here: (N|S) 20\+ m/);
      // It did get away from where the first hit came, and says by how much.
      expect(r.message).toMatch(/you kept going \d+ m/);
    });

    it('walled in on every side under attack: answered within seconds with the open ways (none), no standing search', async () => {
      // A wall right in front, east; the corridor runs north and south.
      host.wall = (x) => x > 80.6;
      drudge(79, 20);
      const p = api.walkTo('15m east', { within: 1, flee: true });
      hit();
      const r = (await settle(api, host, p, 6000))!;
      expect(r).not.toBeNull();
      expect(r).toMatchObject({ ok: false, attacked: true });
      expect(r.message).toMatch(/no way on that way from here \(walls\), and you're under attack\. Open ways from here: .*\bN 20\+ m/);
      expect(r.message).toMatch(/Open ways from here: .*\bS 20\+ m/);
      expect(r.message).not.toMatch(/Open ways from here: [^\n]*\bE \d/);
      expect(r.message).toMatch(/you did NOT get away/);
    });

    it('dying where you stood: the result says you did NOT get away, not "you kept going"', async () => {
      // Monsters all round: the body can't move, though the walk's probe (which leaves creatures out) sees open floor.
      host.wall = () => false;
      const physics = host.physics.bind(host);
      host.physics = () => { void physics; };
      drudge(80, 21);
      const p = api.walkTo('30m north', { within: 1, flee: true });
      hit();
      run(api, host, 300);
      host.me.dead = true;
      const r = (await settle(api, host, p, 2000))!;
      expect(r.message).toMatch(/you died/);
      expect(r.message).toMatch(/and you did NOT get away: you moved 0\.0 m after the first hit/);
      expect(r.message).not.toMatch(/you kept going/);
    });

    it('a flee that got away says how far it went', async () => {
      drudge(80, 18);
      const p = api.walkTo('20m north', { within: 1, flee: true });
      run(api, host, 300);
      hit();
      const r = (await settle(api, host, p, 15_000))!;
      expect(r.ok).toBe(true);
      expect(r.message).toMatch(/hit on the way \(The Drudge Servant nicks your lower leg.*\); you kept going \d+ m/);
    });

    it('a cast stopped the body while W stayed down (retail ignores a key already held): the walk presses W again', async () => {
      // The client's MaybeStopCompletely: a held movement key moves nothing until it is pressed again.
      let stopped = false;
      const key = host.key;
      host.key = (code: string, down: boolean) => { if (code === 'KeyW' && down && !host.keys.has('KeyW')) stopped = false; key(code, down); };
      const physics = host.physics.bind(host);
      host.physics = (dt: number) => { if (!stopped) physics(dt); };
      const p = api.walkTo('20m north', { within: 1 });
      run(api, host, 500);
      const y0 = host.me.y;
      expect(y0).toBeGreaterThan(20.5);
      // A bolt goes out: the client's stop, with W still held.
      host.spells = () => [{ id: 27, name: 'Flame Bolt I', school: 'War', level: 1, projectile: true, range: 20 }];
      host.add({ guid: 0x80004009, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 40 });
      host.cast = () => { stopped = true; return true; };
      void api.cast('Flame Bolt I', '#80004009');
      run(api, host, 1500);
      expect(host.me.y).toBeGreaterThan(y0 + 1); // moving again within about half a second
      const r = (await settle(api, host, p, 15_000))!;
      expect(r.ok).toBe(true);
    });

    it('a slow climb (no cast, no attack) never lets go of W: Bulwark went up a hill a step at a time (2026-10-12)', async () => {
      const physics = host.physics.bind(host);
      host.physics = (dt: number) => physics(dt * 0.02); // 0.08 m/s: under 0.05 m each half second
      let released = 0;
      const key = host.key;
      host.key = (code: string, down: boolean) => { if (code === 'KeyW' && !down && host.keys.has('KeyW')) released++; key(code, down); };
      void api.walkTo('20m north', { within: 1 });
      run(api, host, 2500);
      expect(released).toBe(0);
      api.stopMoving();
    });

    it('hemmed in by monsters while hit: says who stands in the way and where it is open', async () => {
      // An invisible ring the body can't pass (the monsters' bodies) that the probe doesn't see.
      host.wall = () => false;
      const ring = (x: number, y: number): boolean => Math.hypot(x - 80, y - 20) > 0.5;
      const physics = host.physics.bind(host);
      host.physics = (dt: number) => { const { x, y } = host.me; physics(dt); if (ring(host.me.x, host.me.y)) { host.me.x = x; host.me.y = y; } };
      drudge(80, 21.2);
      drudge(81.2, 20, 0x80004002);
      const p = api.walkTo('20m north', { within: 1, flee: true });
      hit();
      const r = (await settle(api, host, p, 20_000))!;
      expect(r).toMatchObject({ ok: false, attacked: true });
      // It tries round them first (tests/verify-agent-use-under-attack.ts); a ring nothing passes ends it, saying so.
      expect(r.message).toMatch(/hemmed in, Drudge Servant [\d.]+ m N, Drudge Servant [\d.]+ m E in the way \(creatures block your body as walls do\); tried 3 ways round them\. Open ways from here: .*\bN 20\+ m/);
    });
  });

  describe('2. a dungeon is its own space', () => {
    const DUNGEON = 0x01f60289;
    const intoDungeon = (): void => { host.me.cell = DUNGEON; host.me.x = 104.5; host.me.y = 113.2; host.me.z = 0; };
    beforeEach(() => {
      host.cellSealed = (c: number) => ((c & 0xffff) < 0x100 ? false : (c >>> 16) === 0x01f6);
    });
    it('walk_to a place seen outdoors, from inside the dungeon: refused at once with where it is, not a walk 34 km long', async () => {
      // Seen outside by the portal (remembered), then the portal.
      host.me.cell = 0xa8b50030; host.me.x = 108; host.me.y = 170; host.me.z = 28;
      host.add({ guid: 0x7a8b5001, name: 'Holtburg Dungeon Directions', itemType: 0x10, cell: 0xa8b50030, x: 110.6, y: 173.4, z: 28 });
      run(api, host, 200, { physics: false });
      host.objs.delete(0x7a8b5001);
      intoDungeon();
      run(api, host, 200, { physics: false });
      const r = await api.walkTo('Holtburg Dungeon Directions');
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/that is outside this dungeon .* \(it is at [\d.]+N, [\d.]+E\)\. No walk gets there from here: leave by the way out/);
      expect(host.keys.has('KeyW')).toBe(false);
    });
    it('map coordinates from inside a dungeon: refused (they are the landscape)', async () => {
      intoDungeon();
      const r = await api.walkTo('43.6N, 33.0E');
      expect(r.message).toMatch(/map coordinates are the landscape, and you are in a dungeon/);
    });
    it('the same dungeon (or a town building beside the landscape) is no other space', async () => {
      intoDungeon();
      host.add({ guid: 0x7f600001, name: 'Surface', cell: 0x01f60230, x: 40, y: 15, z: 0, itemType: 0x10000, objectDescFlags: 0x40000 });
      const p = api.walkTo('Surface', { timeoutMs: 2000 });
      run(api, host, 300);
      expect(host.keys.has('KeyW')).toBe(true);
      api.stopMoving();
      await p;
      host.me.cell = 0xa9b40019; host.me.x = 80; host.me.y = 20; host.me.z = 94;
      host.cellSealed = () => false;
      host.add({ guid: 0x7a9b4141, name: 'Renald', cell: 0xa9b40141, x: 139.2, y: 18.3, z: 94 });
      const q = api.walkTo('Renald', { timeoutMs: 2000 });
      run(api, host, 300);
      expect(host.keys.has('KeyW')).toBe(true);
      api.stopMoving();
      await q;
    });
  });

  describe('3. who is attacking you, placed when the line comes', () => {
    it('a line naming a monster none of whose name is within reach: named, not pinned on the far one', () => {
      drudge(80, 42); // 22 m off
      hit();
      const obs = api.observe();
      expect(obs.nearby.find((o) => o.guid === DRUDGE)?.attackingYou).toBeUndefined();
      expect(formatObservation(obs)).toMatch(/hit by, but not placed: Drudge Servant \(1× in 10 s\) \(none of that name within reach of you/);
    });
    it('the one that hit you died: its lines are not moved onto another of its name standing off', () => {
      drudge(80, 21.5);
      drudge(80, 40, 0x80004002);
      hit(); hit();
      expect(api.attackersOfMe().get(DRUDGE)).toBe(2);
      host.objs.delete(DRUDGE);
      expect(api.attackersOfMe().get(0x80004002)).toBeUndefined();
      expect(formatObservation(api.observe())).not.toContain('ATTACKING YOU');
    });
    it('a spell from range is placed (spell reach), and wakes cast-at-you', async () => {
      host.add({ guid: 0x80005001, name: 'Lich', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 45 });
      const w = api.wait({ types: ['cast-at-you'] }, 5000);
      api.pushChat('Lich frosts you for 25 points with Frost Bolt I.', 0x15);
      const evs = await w;
      expect(evs.map((e) => e.type)).toContain('cast-at-you');
      expect(api.attackersOfMe().get(0x80005001)).toBe(1);
    });
    it('a creature nearby speaking spell words wakes cast-at-you, and says who and where', async () => {
      host.add({ guid: 0x80005001, name: 'Lich', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 30 });
      const w = api.wait({ types: ['cast-at-you'] }, 5000);
      api.pushChat('Lich says, "Zojak Quaguz"', 0x11);
      const evs = await w;
      expect(evs[0].text).toMatch(/^Lich #80005001 10 m N is casting \("Zojak Quaguz"/);
    });
    it('a second creature joining in wakes attackers-up', async () => {
      drudge(80, 21.5);
      hit();
      api.observe();
      const w = api.wait({ types: ['attackers-up'] }, 5000);
      host.add({ guid: 0x80004009, name: 'Drudge Slave', itemType: 0x10, objectDescFlags: 0x10, x: 81.5, y: 20 });
      api.pushChat('The Drudge Slave hits your chest for 4 points of bludgeoning damage!', 0x15);
      const evs = await w;
      expect(evs[0].text).toMatch(/^2 creatures attacking you now \(\+Drudge Slave #80004009\): /);
    });
  });

  describe('A. vitals-low: half your health by default, a mark per wait, and a big single hit', () => {
    it('crosses 50% by default', async () => {
      host.me.health = { current: 180, max: 180 };
      run(api, host, 100, { physics: false });
      const w = api.wait({ types: ['vitals-low'] }, 5000);
      host.me.health = { current: 85, max: 180 };
      run(api, host, 100, { physics: false });
      const evs = await w;
      expect(evs.some((e) => /health 85\/180 \(47%\): below half/.test(e.text))).toBe(true);
    });
    it('a hit taking over a quarter of your health at once wakes it, whatever the level', async () => {
      host.me.health = { current: 180, max: 180 };
      run(api, host, 100, { physics: false });
      const w = api.wait({ types: ['vitals-low'] }, 5000);
      host.me.health = { current: 125, max: 180 };
      run(api, host, 100, { physics: false });
      const evs = await w;
      expect(evs[0].text).toMatch(/health fell 180 → 125 of 180 at once \(−31% of your health in one hit\)/);
    });
    it('vitals_below=0.8 (and mana_below) through the tool: wakes at that mark', async () => {
      host.me.health = { current: 180, max: 180 };
      host.me.mana = { current: 100, max: 100 };
      run(api, host, 100, { physics: false });
      const seen: Array<[string, unknown[]]> = [];
      const caller: ToolCaller = { call: async <T>(m: string, args: unknown[] = []) => { seen.push([m, args]); return api.wait(args[0] as never, 3000) as unknown as T; } } as ToolCaller;
      const tool = TOOLS.find((t) => t.name === 'ac_wait')!;
      const out = TOOL_CALLER.run(caller, () => tool.run({ types: 'death', vitals_below: 0.8, mana_below: 30, timeout_s: 3 }));
      await Promise.resolve();
      expect(seen[0][1][0]).toEqual({ types: ['death', 'vitals-low'], healthBelow: 0.8, manaBelow: 0.3 });
      host.me.health = { current: 140, max: 180 }; // 78%
      run(api, host, 100, { physics: false });
      expect((await out).text).toMatch(/health 140\/180 \(78%\): below your 80% mark/);
    });
  });

  describe('4. pick-up and notes say what really happened', () => {
    const NOTE = 0x800033d5;
    beforeEach(() => { host.add({ guid: NOTE, name: 'A torn note', itemType: 0x2000, x: 81, y: 20 }); });
    it('the server cancels the pick-up: "not picked up", with its words and why', async () => {
      const p = api.pickUp(NOTE);
      await Promise.resolve();
      expect(host.sent).toContain('pickup 800033d5');
      api.pushChat('The A torn note  can\'t be picked up - action cancelled', 0x1a);
      api.pushChat('Action cancelled!', 0x1a);
      const r = (await settle(api, host, p, 2000))!;
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/^not picked up: A torn note: .*can't be picked up - action cancelled.*moving or acting before it gets there cancels the pick-up/);
    });
    it('in the pack: picked up', async () => {
      const p = api.pickUp(NOTE);
      run(api, host, 400);
      host.inv.push({ guid: NOTE, name: 'A torn note', where: 'main pack' });
      const r = (await settle(api, host, p, 2000))!;
      expect(r).toMatchObject({ ok: true, message: "picked up A torn note: it's in your pack now" });
    });
    it('using a note on the ground: read from the pack, says so', async () => {
      const p = api.use(NOTE);
      const r = (await settle(api, host, p, 20_000))!;
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/a note or book is read from your pack \(ac_pick_up it, then ac_use it there to read it\)/);
    });
  });

  describe('7, 9. buying: not enough pyreals is said, stale ids are found by name', () => {
    const HEALER = 0x7a9b4011;
    beforeEach(() => {
      host.add({ guid: HEALER, name: 'Thelnoth Cort the Healer', itemType: 0x10, objectDescFlags: 0x200, x: 81, y: 20 });
      host.vendorOpen = { name: 'Thelnoth Cort the Healer', guid: HEALER, currency: 'Pyreals', items: [
        { guid: 0x80007001, name: 'Willpower Other IV', price: 2000 },
        { guid: 0x80007002, name: 'Focus Other IV', price: 2000 },
      ] } as never;
      host.me.pyreals = 1500;
    });
    it('too few pyreals: says the price and the purse, sends nothing, and does not retry', async () => {
      const r = await api.buyReported('Willpower Other IV');
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/not enough pyreals: it costs 2,000, you have 1,500 \(trade notes don't count: an ACE vendor takes only pyreals/);
      expect(host.sent.filter((s) => s.startsWith('buy'))).toEqual([]);
      expect(api.vendorView().message).toMatch(/sells \(Pyreals; you have 1,500, and only coins pay: trade notes don't\)/);
    });
    it('an id from an earlier listing buys the same item by name, and says the id changed', async () => {
      host.me.pyreals = 10_000;
      api.vendorView();
      host.vendorOpen!.items = [{ guid: 0x80009001, name: 'Willpower Other IV', price: 2000 }, { guid: 0x80009002, name: 'Focus Other IV', price: 2000 }] as never;
      const vb = host.vendorBuy;
      host.vendorBuy = (g: number, n: number) => { host.me.pyreals! -= 2000; return vb(g, n); };
      const p = api.buyReported(0x80007001);
      const r = (await settle(api, host, p, 20_000))!;
      expect(host.sent).toContain('buy 80009001 x1');
      expect(r.message).toMatch(/#80007001 was Willpower Other IV's id in an earlier listing: .* it is #80009001 now/);
      // An unknown old id says what to do.
      expect((await api.buyReported(0x80001234)).message).toMatch(/doesn't sell #80001234: the id may be from an earlier listing/);
    });
    it('ac_buy takes an id in decimal (a JSON number: 2147494839 is 0x80002BB7), as observe printed it', async () => {
      const seen: unknown[][] = [];
      const caller: ToolCaller = { call: async (m: string, args: unknown[] = []) => { seen.push([m, ...args]); return { ok: true, message: 'ok' }; } } as ToolCaller;
      await TOOL_CALLER.run(caller, () => TOOLS.find((t) => t.name === 'ac_buy')!.run({ item: '2147494839' }));
      expect(seen[0][1]).toBe(0x80002bb7);
    });
  });

  describe('8, 12. portals: use walks into one; walk_to stops beside it', () => {
    const PORTAL = 0x7adb5035;
    beforeEach(() => {
      host.wall = () => false;
      host.add({ guid: PORTAL, name: 'Dungeon Fern', itemType: 0x10000, objectDescFlags: 0x40000, x: 80, y: 27 });
    });
    it('ac_use from 7 m: when the server MoveTo never moves the body, it walks into the portal itself', async () => {
      const each = (): void => {
        if (host.screenName === 'world' && Math.hypot(host.me.x - 80, host.me.y - 27) < 1) { host.screenName = 'portal-space'; host.me.x = 10; host.me.y = 170; }
      };
      const r = (await settle(api, host, api.use(PORTAL), 30_000, each))!;
      expect(r).toMatchObject({ ok: true });
      expect(r.message).toMatch(/used Dungeon Fern: the server's walk to it didn't move you, so you walked into it and through/);
    });
    it('walk_to a portal stops outside it', async () => {
      const r = (await settle(api, host, api.walkTo(PORTAL), 20_000))!;
      expect(r.ok).toBe(true);
      expect(Math.hypot(host.me.x - 80, host.me.y - 27)).toBeGreaterThan(1.8);
    });
  });

  describe('10. a dying target is dying, not "hp 32%"', () => {
    it('even once it is no longer attackable', () => {
      host.add({ guid: 0x80006001, name: 'Spikey Armoredillo', itemType: 0x10, objectDescFlags: 0, x: 82, y: 20 });
      host.target = 0x80006001;
      host.dying.add(0x80006001);
      const text = formatObservation(api.observe());
      expect(text).toMatch(/target: #80006001\s+Spikey Armoredillo .*DYING \(dead: not a target\)/);
      expect(text).not.toMatch(/target: .*hp \d+%/);
    });
  });

  describe('6. a shopkeeper behind his counter: the walk goes to the counter and says so', () => {
    it('arrives at the spot the route ends on (across), not stuck at the counter for 45 s', async () => {
      host.wall = (_x, y) => y > 39.5; // the counter
      host.add({ guid: 0x7a9b4141, name: 'Shopkeeper Renald the Elder', itemType: 0x10, objectDescFlags: 0x200, cell: 0xa9b40141, x: 80, y: 41, z: 94 });
      host.route = () => [{ x: 80, y: 38.6, z: 94, across: true }, { x: 80, y: 41, z: 94 }].slice(0, 1) as never;
      const r = (await settle(api, host, api.walkTo(0x7a9b4141, { within: 1 }), 20_000))!;
      expect(r.ok).toBe(true);
      expect(r.message).toMatch(/^arrived at the counter: it is across it, [\d.]+ m away \(a counter or window between you; ac_use works across it/);
    });
  });
});

describe('5. line of fire: only objects in the world block, and the line says what blocks it', () => {
  const makeSOM = (): ServerObjectManager => {
    const som = new ServerObjectManager({ loadSetupModel: () => null } as never, {} as never, new THREE.Scene());
    som.missileLocalPlayer = () => ({ x: 100, y: 100, z: 10, radius: 0.5, height: 1.8 });
    return som;
  };
  const put = (som: ServerObjectManager, guid: number, x: number, y: number, z: number, over: Partial<ServerObject> = {}): void => {
    const o = { guid, name: 'Lich', itemType: ItemType.Creature, physicsState: 0, mesh: new THREE.Group(), worldX: x, worldZ: y, worldY: z, collisionRadius: 0.5, collisionHeight: 1.6, ...over } as unknown as ServerObject;
    (som as unknown as { objects: Map<number, ServerObject> }).objects.set(guid, o);
  };
  it('a held item (out of the world) or one released out of range blocks nothing; a chest in the room does, by name', () => {
    const som = makeSOM();
    put(som, 0x80000080, 100, 112, 10);
    put(som, 0x70000002, 100, 101.8, 10, { name: 'Shield', itemType: ItemType.Armor, outOfWorld: true });
    put(som, 0x70000003, 100, 102, 10, { name: 'Torch', itemType: ItemType.Misc, lostCell: true });
    som.missileEnvironmentSweep = () => null;
    som.missileObjectSweep = (o, from, to) => ({ t: (o.worldZ - from.y) / (to.y - from.y), normal: null });
    expect(som.lineOfFire(0x80000080)).toEqual({ dist: 12, blockedAt: null });
    put(som, 0x70000004, 100, 106, 10, { name: 'Chest', itemType: ItemType.Container });
    expect(som.lineOfFire(0x80000080)).toMatchObject({ blocker: 'Chest' });
    expect(som.lineOfFire(0x80000080)!.blockedAt).toBeCloseTo(6, 0);
  });
  it('a wall or the ceiling is named by its face', () => {
    const som = makeSOM();
    put(som, 0x80000080, 100, 112, 10);
    som.missileEnvironmentSweep = (from, to) => ({ t: (105 - from.y) / (to.y - from.y), normal: { x: 0, y: -1, z: 0 } });
    expect(som.lineOfFire(0x80000080)).toMatchObject({ blocker: 'a wall' });
    som.missileEnvironmentSweep = (from, to) => ({ t: (105 - from.y) / (to.y - from.y), normal: { x: 0, y: 0, z: -1 } });
    expect(som.lineOfFire(0x80000080)).toMatchObject({ blocker: 'the ceiling' });
  });
});

describe.skipIf(!existsSync(DAT_PATHS.cell) || !existsSync(DAT_PATHS.portal))('6. Renald the Elder behind his street window (Holtburg 0xA9B4, the DAT)', () => {
  let g: CellGraph;
  beforeAll(() => { g = loadCellGraph(openDat(DAT_PATHS.cell), openDat(DAT_PATHS.portal), 0xA9B40000); });
  // ACE world: Shopkeeper Renald the Elder at A9B40141 (139.23, 18.33, 94.005), the booth behind window cell 0x14F.
  const RENALD = { x: 139.234, y: 18.3293, z: 94.005 };
  it('only counters lead to his booth; where a player stands is the street outside the service window', () => {
    const spot = counterSpot(g, 0xA9B40141, RENALD)!;
    expect(spot.cell).toBe(0xA9B40001);
    expect(spot.at.x).toBeCloseTo(139.4, 1);
    expect(spot.at.y).toBeCloseTo(20.3, 1);
  });
  it('the route from the lifestone ends there (across), not through the 1 m counter sill inside the shop', () => {
    const r = findRouteViaOutside(g, 0xA9B40019, { x: 81.3, y: 11.8, z: 94 }, 0xA9B40141, RENALD)!;
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ across: true });
    expect(Math.hypot(r[0].x - RENALD.x, r[0].y - RENALD.y)).toBeLessThan(2.5);
    // A shopkeeper on the shop floor (Scribe Renald the Younger, A9B4013F) still goes in by the door.
    const scribe = findRouteViaOutside(g, 0xA9B40019, { x: 81.3, y: 11.8, z: 94 }, 0xA9B4013F, { x: 131.4, y: 12.24, z: 94.005 })!;
    expect(scribe.some((p) => p.across)).toBe(false);
    expect(scribe.length).toBeGreaterThan(1);
  });
});

void HOLTBURG; void OX; void OY;
