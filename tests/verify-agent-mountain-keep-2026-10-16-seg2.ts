/**
 * Mountain Keep (dungeon landblock 0x01D2), the second stream segment there: 2026-10-16 16:08–17:08Z, end of retail local
 * ACE, build 99d94c07. Stream players Claude Arcanist (mage) and Claude Bulwark (tank) reported (reports
 * stream/reports/{mage-2026-10-16T17-08-46-896Z,soldier-2026-10-16T17-09-08-396Z}-seg1.md; transcripts
 * stream/sessions/{mage,soldier}-2026-10-16-seg1.jsonl, 16:07–17:10Z; page traces mage.log / soldier.log):
 *   1. monsters "12 m up/down" landing melee (#80008e3f, #800098a2, #800093bd, #80009297);
 *   2. walk_to and attack run-ups routing through the locked Door #701d2021 (0x01D201A6 / 0x01D6) again and again;
 *   3. follow "not in view" with the fellow out of sight;
 *   4. an attack run-up of 16–19 m leaving the caster behind, and stop_moving not stopping the server's approach;
 *   5. walk_to "arrived (9.1 m away, run past it a little)";
 *   6. "surpassed by Incantation of … Other" read as the caster's own buffs blocking.
 */
import { existsSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { cellStandPoint, findRouteViaOutside, loadCellGraph, type CellGraph } from '../packages/renderer/src/agent/cellPath.ts';
import { formatObservation } from '../packages/renderer/src/agent/format.ts';
import { FakeHost, run } from './_harness/agentFake.ts';
import { DAT_PATHS, openDat } from './_harness/dat.ts';

/** Two interior cells of the fake host's landblock (0xA9B4). */
const UPPER = 0xa9b40150, OTHER = 0xa9b40152;
const ARC = 0x50000002;
const MU = (n: number): number => (0x80000000 + n) >>> 0;

async function settle<T>(api: AgentApi, host: FakeHost, p: Promise<T>, ms: number, each?: () => void): Promise<T | null> {
  let out: T | null = null;
  let done = false;
  void p.then((x) => { out = x; done = true; });
  for (let t = 0; t < ms && !done; t += 100) { each?.(); run(api, host, 100); await Promise.resolve(); await Promise.resolve(); }
  return out;
}

const fellowship = (host: FakeHost): void => {
  host.fellows = () => [{ guid: ARC, name: 'Claude Arcanist', health: { cur: 160, max: 166 }, stamina: { cur: 200, max: 214 }, mana: { cur: 300, max: 306 } }];
};
const mummy = (host: FakeHost, n: number, x: number, y: number, z: number): void => {
  host.add({ guid: MU(n), name: 'Dread Mu-miyah', itemType: 0x10, objectDescFlags: 0x10, cell: UPPER, x, y, z, level: 60 });
};

describe('fake host', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host.me.cell = UPPER; host.me.x = 80; host.me.y = 20; host.me.z = 0;
    host.me.level = 35;
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  describe('1. a swing is credited to the creature that can reach you, not one a floor up', () => {
    it('the one beside you gets it, not the one 12 m overhead 1.5 m across (was "ATTACKING YOU" on #80008e3f, 16:24Z)', () => {
      mummy(host, 0x8e3f, 81.5, 20, 12); // in the room overhead (0x01D202A6 over 0x01D2011F)
      mummy(host, 0x3179, 80, 23.5, 0); // on your floor, 3.5 m off
      api.pushChat('Reckless! Dread Mu-miyah grazes your lower arm for 0 points of bludgeoning damage!', 0x15);
      const obs = api.observe();
      expect(obs.nearby.find((o) => o.guid === MU(0x3179))?.attackingYou).toBe(1);
      expect(obs.nearby.find((o) => o.guid === MU(0x8e3f))?.attackingYou).toBeUndefined();
    });

    it('with only the overhead one near, the swing is placed on no one (it can\'t reach you: ACE CylinderDistance, 0.75 m)', () => {
      mummy(host, 0x98a2, 81.5, 20, 12);
      mummy(host, 0x93dd, 80, 45, 0); // 25 m off: too far to be the swing
      api.pushChat('Dread Mu-miyah grazes your foot for 3 points of bludgeoning damage!', 0x15);
      const obs = api.observe();
      expect(obs.nearby.some((o) => o.attackingYou)).toBe(false);
      expect(formatObservation(obs)).not.toMatch(/ATTACKING YOU/);
    });

    it('its kill\'s "is on you" hint never names the one overhead (target-died, 16:24:47Z / 16:40:21Z)', () => {
      mummy(host, 0x98a2, 81.5, 20, 12);
      api.pushChat('Dread Mu-miyah grazes your foot for 3 points of bludgeoning damage!', 0x15);
      expect([...(api as unknown as { attackersOfMe(): Map<number, number> }).attackersOfMe().keys()]).toEqual([]);
    });

    it('a spell still reaches across floors (its reach is 60 m, straight line)', () => {
      host.add({ guid: MU(0x1001), name: 'Dread Lich', itemType: 0x10, objectDescFlags: 0x10, cell: UPPER, x: 81, y: 20, z: 6 });
      api.pushChat('Dread Lich frosts you for 25 points with Frost Bolt I.', 0x15);
      expect(api.observe().nearby.find((o) => o.guid === MU(0x1001))?.attackingYou).toBe(1);
    });
  });

  describe('2. a door found locked is remembered: routes go round it, and a walk whose only way is through it says so', () => {
    const DOOR = 0x701d2021;
    beforeEach(() => {
      // The door in the doorway at (80, 30), shut; the goal beyond it at (80, 60).
      host.add({ guid: DOOR, name: 'Door', itemType: 0x80, objectDescFlags: 0x1000, cell: UPPER, x: 80, y: 30, z: 0, physicsState: 0 });
      host.add({ guid: 0x7f000001, name: 'Altar', cell: OTHER, x: 80, y: 60, z: 0 });
    });
    /** The doorway route: through the door's doorway, or (when `round`) round by a second doorway at (95, 40). */
    const routes = (round: boolean): void => {
      const route = (_fc: number, _f: unknown, _tc: number, to: { x: number; y: number; z: number }, opts?: { closed?: Array<{ x: number; y: number }> }): Array<{ x: number; y: number; z: number }> | null => {
        // planRoute passes the shut doors in the landblock's frame (the fake host's cell frame).
        const doorShut = (opts?.closed ?? []).some((c) => Math.hypot(c.x - 80, c.y - 30) < 2.5);
        if (!doorShut) return [{ x: 80, y: 30, z: 0 }, to];
        return round ? [{ x: 95, y: 40, z: 0 }, to] : null;
      };
      (host as unknown as { route: typeof route }).route = route;
    };
    const locked = (): void => {
      // Standing at the door when its reply comes (the Use walked you there).
      const was = { x: host.me.x, y: host.me.y };
      host.me.x = 80; host.me.y = 28;
      api.pushChat('The door is locked!');
      api.pushChat("The key doesn't fit this lock.");
      host.me.x = was.x; host.me.y = was.y;
    };

    it('the only way through it: the walk ends at once naming it (was: walk to it, Use it, try the key, every walk)', async () => {
      routes(false);
      locked();
      const r = await settle(api, host, api.walkTo(0x7f000001), 10_000);
      expect(r?.ok).toBe(false);
      expect(r?.message).toMatch(/^stopped [\d.]+ m short: the only doorway route there goes through Door #701d2021 \(10 m N; locked: the key doesn't fit this lock\), found locked this session, and no other way leads there from here/);
      expect(host.sent.filter((s) => s.startsWith('use'))).toEqual([]);
    });

    it('with a way round, the walk takes it and never goes back to the door', async () => {
      routes(true);
      locked();
      let east = 0;
      const r = await settle(api, host, api.walkTo(0x7f000001), 40_000, () => { east = Math.max(east, host.me.x); });
      expect(r?.ok, r?.message).toBe(true);
      expect(east).toBeGreaterThan(92); // by the doorway at (95, 40), not straight through the door at (80, 30)
      expect(host.sent.filter((s) => s.startsWith('use'))).toEqual([]);
      const traces = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => c.join(' '));
      expect(traces.some((l) => /Door #701d2021/.test(l))).toBe(false);
    });

    it('once seen open (someone opened it from the other side) it is a way again', async () => {
      routes(false);
      locked();
      host.objs.get(DOOR)!.physicsState = 0x4; // ethereal: open
      const r = await settle(api, host, api.walkTo(0x7f000001), 40_000);
      expect(r?.ok, r?.message).toBe(true);
      expect(r?.message).not.toMatch(/locked/);
    });

    it('observe\'s other-floor line and the attack refusal name the locked door as the only way', () => {
      routes(false);
      locked();
      fellowship(host);
      host.add({ guid: ARC, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, cell: UPPER, x: 81, y: 21, z: 0 });
      host.add({ guid: MU(0x8c8f), name: 'Dread Mu-miyah', itemType: 0x10, objectDescFlags: 0x10, cell: OTHER, x: 80, y: 60, z: 6, level: 60 });
      host.target = MU(0x8c8f);
      expect(formatObservation(api.observe())).toMatch(/ON ANOTHER FLOOR, 6 m up: no melee from here; no walk reaches it from here but through Door #701d2021 \(10 m N; locked: the key doesn't fit this lock\)/);
      expect(api.attack(MU(0x8c8f)).message).toMatch(/and no walk reaches it from here anyway but through Door #701d2021/);
    });

    it('a "locked" line with no shut door beside you records nothing', async () => {
      routes(false);
      api.pushChat('The door is locked!'); // 10 m from it
      const p = api.walkTo(0x7f000001);
      run(api, host, 300);
      expect(host.keys.has('KeyW')).toBe(true);
      api.stopMoving();
      await settle(api, host, p, 1000);
    });
  });

  describe('3. follow a fellow the client has destroyed (25 s out of view): to their last place, not "not in view"', () => {
    it('walks to where they were last seen (was "in your fellowship but not in view", 16:35:46Z)', async () => {
      fellowship(host);
      host.add({ guid: ARC, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, cell: UPPER, x: 80, y: 45, z: 0, heardAt: 0 });
      run(api, host, 600); // in sight: the agent keeps her place
      host.t += 40_000;
      host.objs.delete(ARC); // ObjectMaint destroyed her object
      const obs = formatObservation(api.observe());
      expect(obs).toMatch(/fellows: Claude Arcanist 96% HP, out of sight, last seen 25 m N of you, 40 s ago/);
      const r = await settle(api, host, api.follow('Claude Arcanist', { durationMs: 30_000 }), 40_000);
      expect(r?.message).not.toMatch(/not in view/);
      expect(r?.message).toMatch(/^Claude Arcanist is out of your sight \(in a dungeon you see only the rooms in sight of yours\); going to where they were last seen: 25 m N of you, 40 s ago/);
      expect(Math.hypot(host.me.x - 80, host.me.y - 45)).toBeLessThan(3);
    });

    it('a fellow standing still in sight for minutes keeps a fresh place (it was the server\'s last placement\'s age)', () => {
      fellowship(host);
      host.add({ guid: ARC, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, cell: UPPER, x: 80, y: 45, z: 0, heardAt: 0 });
      for (let i = 0; i < 10; i++) { host.t += 60_000; run(api, host, 100); }
      host.objs.delete(ARC);
      host.t += 5000;
      expect(formatObservation(api.observe())).toMatch(/out of sight, last seen 25 m N of you, 5 s ago/);
    });
  });

  describe('4. attack: no long run-up away from the fellow at your side', () => {
    beforeEach(() => {
      fellowship(host);
      host.add({ guid: ARC, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, cell: UPPER, x: 81, y: 20, z: 0 });
    });

    it('a target 16 m off is refused, saying who would be left how far behind (was: 19 m run, 16:57Z)', () => {
      mummy(host, 0x92bb, 80, 4, 0);
      const r = api.attack(MU(0x92bb));
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/^Dread Mu-miyah #800092bb is 16 m S: running up to it leaves Claude Arcanist \(1 m from you now\) 16 m behind, so no attack was started \(the fellow leash: past 12 m a melee attack runs up only when every fellow beside you stays within 15 m of you there, a fellow who has kept up with you as you moved lately counting as coming along; far=true lifts it\)\./);
      expect(r.message).toMatch(/ac_attack target=#800092bb far=true to go anyway$/);
      expect(host.sent.filter((s) => s.startsWith('attack'))).toEqual([]);
    });

    it('far=true goes; one within 12 m goes; one on the fellow goes', () => {
      mummy(host, 0x92bb, 80, 4, 0);
      expect(api.attack(MU(0x92bb), { far: true }).ok).toBe(true);
      mummy(host, 0x939a, 80, 10, 0);
      expect(api.attack(MU(0x939a)).ok).toBe(true);
      // The fellow 13 m off with a mummy on her: going to it keeps you by her.
      Object.assign(host.objs.get(ARC)!, { x: 80, y: 33 });
      mummy(host, 0x9338, 80, 35, 0);
      expect(api.attack(MU(0x9338)).ok).toBe(true);
    });

    it('with no target named, the near one is taken over a far one', () => {
      mummy(host, 0x92bb, 80, 4, 0);
      mummy(host, 0x939a, 85, 28, 0);
      host.target = null;
      expect(api.attack(null).ok).toBe(true);
      expect(host.target).toBe(MU(0x939a));
    });

    it('stop_moving takes control back from the server (its approach to the target stops), as retail\'s Stop Moving does', () => {
      const stops: number[] = [];
      (host as unknown as { stopMovingAction: () => void }).stopMovingAction = () => { stops.push(host.t); };
      mummy(host, 0x939a, 80, 28, 0);
      expect(api.attack(MU(0x939a)).ok).toBe(true);
      run(api, host, 200);
      const r = api.stopMoving();
      expect(stops).toHaveLength(1);
      expect(r.message).toBe('stopped (the attack and its run-up too)');
      expect(api.stopMoving().message).toBe('stopped');
    });
  });

  describe('5. a walk that ran well past its goal between two looks turns back for it', () => {
    it('"arrived (1.x m)", not "arrived (9.1 m away, run past it a little)" (16:46:29Z)', async () => {
      fellowship(host);
      host.add({ guid: ARC, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, cell: UPPER, x: 80, y: 40, z: 0, heardAt: 0 });
      const p = api.walkTo('Claude Arcanist', { within: 2 });
      let jumped = false;
      const r = await settle(api, host, p, 30_000, () => {
        // A slow frame at a run: from 8 m short to 9 m past in one look.
        if (!jumped && host.me.y > 32) { jumped = true; host.me.y = 49; }
      });
      expect(jumped).toBe(true);
      expect(r?.ok, r?.message).toBe(true);
      expect(r?.message).not.toMatch(/run past it/);
      expect(Math.hypot(host.me.x - 80, host.me.y - 40)).toBeLessThan(3.5);
    });
  });

  describe('6. "surpassed by" names the target\'s own enchantment', () => {
    beforeEach(() => {
      fellowship(host);
      host.add({ guid: 0x500000a4, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, cell: UPPER, x: 81, y: 21, z: 0 });
      host.spells = () => [{ id: 1, name: 'Strength Other IV', school: 'Creature', level: 4 }];
      host.cast = (id, t) => {
        host.sent.push(`cast ${id} ${t}`);
        setTimeout(() => api.pushChat('You cast Strength Other IV on Claude Bulwark, but it is surpassed by Incantation of Strength Other'), 300);
        return true;
      };
    });

    it('says it is on Bulwark, that the caster\'s own plays no part, and that hers is kept under it (17:01:39Z)', async () => {
      host.buffs = [{ name: 'Incantation of Strength Other', remaining: 1, beneficial: true }];
      const r = await settle(api, host, api.cast('Strength Other IV', 'Claude Bulwark'), 10_000);
      expect(r?.message).toMatch(/surpassed on Claude Bulwark: Claude Bulwark still has Incantation of Strength Other on them, the stronger, which stays in effect \(the server compares the target's own enchantments, not yours; yours, 1s left, plays no part\); the cast still cost its mana \(the server spends it as the spell goes off, before it finds the stronger one: as in retail\)\. Strength Other IV is kept under it on Claude Bulwark and takes over when theirs wears off/);
    });
  });
});

const haveDat = existsSync(DAT_PATHS.cell) && existsSync(DAT_PATHS.portal);
const LB = 0x01d20000;
const C = (n: number): number => (LB | n) >>> 0;

describe.skipIf(!haveDat)('the real Mountain Keep (0x01D2): the locked Door #701d2021', () => {
  let g: CellGraph;
  beforeAll(() => { g = loadCellGraph(openDat(DAT_PATHS.cell), openDat(DAT_PATHS.portal), LB); });
  // ACE-World 16PY 01D2.sql: Door #701D2021 (wcid 1298) in 0x01D201A6 at (64.75, −60, −6), the doorway to 0x01D201D6.
  const door = { x: 64.75, y: -60, z: -6 };

  it('stands in the doorway between 0x01D201D6 and 0x01D201A6', () => {
    const d = g.doors.get(C(0x1d6))!.find((x) => (x.b >>> 0) === C(0x1a6))!;
    expect(Math.hypot(d.at.x - door.x, d.at.y - door.y)).toBeLessThan(1);
  });

  it('every doorway route to 0x01D20101 from where the pair fought goes through it: locked, there is none (walk_to says so)', () => {
    for (const from of [0x1d6, 0x1a7, 0x11c, 0x1d9]) {
      const a = cellStandPoint(g, C(from))!, to = cellStandPoint(g, C(0x101))!;
      const open = findRouteViaOutside(g, C(from), a, C(0x101), to, { maxDrop: 12 })!;
      expect(open.some((p) => Math.hypot(p.x - door.x, p.y - door.y) < 3)).toBe(true);
      expect(findRouteViaOutside(g, C(from), a, C(0x101), to, { maxDrop: 12, closed: [door] })).toBeNull();
    }
  });
});
