/**
 * Mountain Keep (dungeon landblock 0x01D2), the stream players' segment 01:44–02:44Z on 2026-10-17, end of retail local
 * ACE, build c38fcc5d (reports stream/reports/{mage-2026-10-17T02-44-50-857Z,soldier-2026-10-17T02-44-36-545Z}-seg1.md;
 * transcripts stream/sessions/{mage,soldier}-2026-10-16-seg1.jsonl; page traces mage.log / soldier.log):
 *   1. Arcanist's follow said "no way to them was found from here … they are 15 m SW" (02:36:02Z, 0x01D202A2) while her
 *      walk_to Bulwark right after "found a way". Both plan with the same planner: her follow aimed its whole search ladder
 *      at where Bulwark was in mid-jump (02:35:24, "searching 6.6 m to (276.9, 40263.8)") and ended once the last search
 *      failed, though he had landed 9 m on; her walk_to went on searching (a door, stalls) until he jumped back to her
 *      (02:37:18). He stood at the fountain room's height over the pit 0x01D201F7 after drops that never fell ("walk drop
 *      landed off the plan at (269.5, 40258.3, z 0.0)"): the real collision has no floor there (offline: only 0x01F7's at
 *      −6), so no walk reached that spot and "walls all round" was no explanation.
 *   2. Bulwark's walk_to 0x01D2014A stay_with Arcanist stopped "57.6 m short: Claude Arcanist is 15 m NE of you and hasn't
 *      moved for 12 s" (02:35:56Z) and again "61.7 m short" (02:39:31Z): his way went down a drop, hers stayed above.
 *   3. ac_attack #80010988 two seconds after "attackers-up: +Dread Mu-miyah #80010988" answered "out of sight: your client
 *      let it go … Go back there and look again" (02:34:30Z).
 */
import { existsSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getClientRunRate } from '@ac/shared';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { formatObservation } from '../packages/renderer/src/agent/format.ts';
import { FakeHost, run } from './_harness/agentFake.ts';
import { DAT_PATHS, openDat } from './_harness/dat.ts';

const ROOM = 0xa9b40150;
const MU = 0x80010988;

async function settle<T>(api: AgentApi, host: FakeHost, p: Promise<T>, ms: number, each?: () => void): Promise<T | null> {
  let out: T | null = null;
  let done = false;
  void p.then((x) => { out = x; done = true; });
  for (let t = 0; t < ms && !done; t += 100) { each?.(); run(api, host, 100); await Promise.resolve(); await Promise.resolve(); }
  return out;
}

describe('3. a monster that just attacked you stays the fight once the client lets it go', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host.me.cell = ROOM; host.me.x = 80; host.me.y = 20; host.me.z = 0;
    host.me.combatMode = 'melee';
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  /** The Dread beside you hits you, steps 12 m east into a room yours can't see, and the client lets it go. */
  const ambush = (opts: { hit?: boolean } = {}): void => {
    host.add({ guid: MU, name: 'Dread Mu-miyah', itemType: 0x10, objectDescFlags: 0x10, cell: ROOM, x: 81.5, y: 20, z: 0, heardAt: host.t });
    run(api, host, 1000);
    if (opts.hit !== false) api.pushChat('Dread Mu-miyah grazes your foot for 3 points of bludgeoning damage!', 0x15);
    Object.assign(host.objs.get(MU)!, { x: 92, heardAt: host.t });
    run(api, host, 1000);
    Object.assign(host.objs.get(MU)!, { lost: true, heardAt: host.t - 6000 });
  };

  it('ac_attack goes to where it was last seen and attacks it there (was "out of sight … Go back there and look again")', async () => {
    ambush();
    const r = api.attack(MU);
    expect(r.ok, r.message).toBe(true);
    expect(r.message).toMatch(/^Dread Mu-miyah #80010988 is out of your client's sight \(it let it go\), but it attacked (just now|\d+ s ago): going to where it was last seen \(.*\), then attacking it once it is in sight/);
    // In sight again once you come into its room (the server speaks of it again: ServerObjectManager.reviveReleased).
    await settle(api, host, new Promise<void>(() => {}), 15_000, () => {
      const o = host.objs.get(MU)!;
      if (o.lost && Math.hypot(o.x - host.me.x, o.y - host.me.y) < 4) Object.assign(o, { lost: false, heardAt: host.t });
    });
    expect(host.me.x).toBeGreaterThan(87);
    expect(host.sent.some((s) => s.startsWith('attack 80010988')), host.sent.join('\n')).toBe(true);
  });

  it('not in sight at its last place either: a target-lost event says so', async () => {
    ambush();
    const since = api.eventsSince(0).at(-1)?.seq ?? 0;
    expect(api.attack(MU).ok).toBe(true);
    await settle(api, host, new Promise<void>(() => {}), 15_000);
    const lost = api.eventsSince(since).find((e) => e.type === 'target-lost');
    expect(lost?.text).toMatch(/Dread Mu-miyah #80010988: no attack: it is not in sight at the spot where it was last seen/);
    expect(host.sent.some((s) => s.startsWith('attack 80010988'))).toBe(false);
  });

  it('observe names it as a foe of a moment ago, not only "out of sight"', () => {
    ambush();
    host.target = MU;
    expect(formatObservation(api.observe())).toMatch(/OUT OF SIGHT: only where it was last seen, but it attacked (just now|\d+ s ago) \(ac_attack goes to where it was last seen and fights it there\)/);
  });

  it('one that never attacked you or a fellow, or did so over 30 s ago, is refused as before', () => {
    ambush({ hit: false });
    expect(api.attack(MU).message).toMatch(/is out of sight: your client let it go: .*(?:Go back there and look again|walk_to #80010988 goes to where it was)/);
    host.objs.delete(MU);
    ambush();
    run(api, host, AgentApi.RECENT_FOE_MS + 1000);
    expect(api.attack(MU).message).toMatch(/is out of sight: your client let it go: .*(?:Go back there and look again|walk_to #80010988 goes to where it was)/);
  });

  it('one standing on a fellow counts too', () => {
    const ARC = 0x50000002;
    host.fellows = () => [{ guid: ARC, name: 'Claude Arcanist', health: { cur: 170, max: 174 }, stamina: { cur: 200, max: 236 }, mana: { cur: 300, max: 318 } }];
    host.add({ guid: ARC, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, cell: ROOM, x: 95, y: 20, z: 0, heardAt: host.t });
    host.add({ guid: MU, name: 'Dread Mu-miyah', itemType: 0x10, objectDescFlags: 0x10, cell: ROOM, x: 96, y: 20, z: 0, heardAt: host.t, seeks: { kind: 'stick', guid: ARC } });
    run(api, host, 1000);
    Object.assign(host.objs.get(MU)!, { lost: true, heardAt: host.t - 6000, seeks: undefined });
    const r = api.attack(MU);
    expect(r.ok, r.message).toBe(true);
    expect(r.message).toMatch(/but it attacked/);
  });
});

const haveDat = existsSync(DAT_PATHS.cell) && existsSync(DAT_PATHS.portal);
const LB = 0x01d20000;
const C = (n: number): number => (LB | n) >>> 0;
const BUL = 0x500000a4, ARC = 0x50000002;

describe.skipIf(!haveDat)('the real Mountain Keep (0x01D2): walks through the real collision (DungeonHost)', () => {
  let nav: Awaited<ReturnType<typeof import('./_harness/dungeonNav.ts')['dungeonNav']>>;
  let navSoldier: typeof nav;
  beforeAll(async () => {
    const { dungeonNav } = await import('./_harness/dungeonNav.ts');
    // Arcanist (Jump and Run about 200 buffed) and Bulwark unbuffed (Jump 191, Run 179).
    nav = await dungeonNav(LB, { statics: true, jumpSkill: 230, runRate: getClientRunRate(0.5, 200) });
    navSoldier = await dungeonNav(LB, { statics: true, jumpSkill: 191, runRate: getClientRunRate(0.5, 179) });
  }, 180_000);
  const dats = (): { portal: ReturnType<typeof openDat>; cell: ReturnType<typeof openDat> } => ({ portal: openDat(DAT_PATHS.portal), cell: openDat(DAT_PATHS.cell) });
  const fellow = (host: import('./_harness/dungeonWalk.js').DungeonHost, guid: number, name: string): void => {
    host.fellows = () => [{ guid, name, health: { cur: 180, max: 180 }, stamina: { cur: 200, max: 250 }, mana: { cur: 100, max: 300 } }];
  };
  // Arcanist where she stood in the fountain room 0x01D202A2 (278.0, 40266.0, z 0).
  const ARC_AT = { x: 86, y: -54, z: 0 };

  describe('1. follow plans the way to the leader as walk_to does', () => {
    it('a leader who lands on another floor during the searches is planned to again and reached (was "no way to them")', async () => {
      vi.useFakeTimers();
      vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const { DungeonHost } = await import('./_harness/dungeonWalk.js');
        const host = new DungeonHost(nav, dats(), LB, { rooms: true });
        host.me.health = { current: 174, max: 174 };
        fellow(host, BUL, 'Claude Bulwark');
        // In mid-drop over the pit when the follow sets off (the server still naming the fountain room), then on the floor of
        // 0x01D201F7 at −5.5, where his planned drop lands (soldier.log 02:35:23Z: landing (268.6, 40256.6, z −5.5)).
        const b = host.add({ guid: BUL, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, cell: C(0x2a2), x: 78.5, y: -56, z: 3 });
        try {
          const r = await host.run(C(0x2a2), ARC_AT, (api) => api.follow('Claude Bulwark'), {
            maxMs: 200_000,
            each: () => { b.heardAt = host.t; if (host.t === 300) Object.assign(b, { cell: C(0x1f7), x: 76.6, y: -63.4, z: -5.5 }); },
          });
          expect(r.ok, `${r.message}\n${host.traces.join('\n')}`).toBe(true);
          expect(r.message).toMatch(/^followed Claude Bulwark for \d+ s, until they stopped/);
          expect(host.me.z).toBeLessThan(-4);
          expect(Math.hypot(host.me.x - b.x, host.me.y - b.y)).toBeLessThan(5);
          // Planned to his floor again once he landed, or (since 2026-10-17 08:15Z: a goal in mid-air off your storey is in
          // the room whose floor is under it, feetCell) to the floor under him from the start.
          const firstLeg = host.traces.find((l) => /^\[AC:Agent\] walk leg /.test(l) || /^walk leg /.test(l)) ?? '';
          expect(host.traces.some((l) => /follow: Claude Bulwark moved \d+ m during the searches; planning the way to them again/.test(l)) || (/\d+ doorway\(s\) ahead/.test(firstLeg) && !/ 0 doorway/.test(firstLeg)), host.traces.slice(0, 8).join('\n')).toBe(true);
          expect(host.traces.some((l) => /walk leg .*\d+ doorway\(s\) ahead/.test(l) && !/ 0 doorway/.test(l))).toBe(true);
        } finally { host.dispose(); }
      } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
    }, 240_000);

    it('walk_to the same leader from the same spot gets there too (the planner both use)', async () => {
      vi.useFakeTimers();
      vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const { DungeonHost } = await import('./_harness/dungeonWalk.js');
        const host = new DungeonHost(nav, dats(), LB, { rooms: true });
        host.me.health = { current: 174, max: 174 };
        fellow(host, BUL, 'Claude Bulwark');
        const b = host.add({ guid: BUL, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, cell: C(0x1f7), x: 76.6, y: -63.4, z: -5.5 });
        try {
          const r = await host.run(C(0x2a2), ARC_AT, (api) => api.walkTo('Claude Bulwark', { within: 3 }), { maxMs: 200_000, each: () => { b.heardAt = host.t; } });
          expect(r, host.traces.join('\n')).toMatchObject({ ok: true });
          expect(host.me.z).toBeLessThan(-4);
        } finally { host.dispose(); }
      } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
    }, 240_000);

    it('a leader standing over open air (no floor under them) is said so (was "walls all round")', async () => {
      vi.useFakeTimers();
      vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const { DungeonHost } = await import('./_harness/dungeonWalk.js');
        const host = new DungeonHost(nav, dats(), LB, { rooms: true });
        host.me.health = { current: 174, max: 174 };
        fellow(host, BUL, 'Claude Bulwark');
        // Where Bulwark's drops "landed off the plan" at z 0 (269.5, 40258.3): over 0x01D201F7, whose floor is 6 m down.
        const b = host.add({ guid: BUL, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, cell: C(0x2a2), x: 77.5, y: -61.7, z: 0 });
        try {
          const r = await host.run(C(0x2a2), ARC_AT, (api) => api.follow('Claude Bulwark'), { maxMs: 60_000, each: () => { b.heardAt = host.t; } });
          expect(r.ok).toBe(false);
          expect(r.message).toMatch(/^couldn't follow Claude Bulwark: Claude Bulwark stands where the game's collision has no floor under them \(open air, 6 m over the floor below\): no walk or jump lands beside them there/);
          expect(r.message).not.toMatch(/walls all round/);
        } finally { host.dispose(); }
      } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
    }, 240_000);
  });

  describe('2. stay_with: a fellow standing still off your way is gone back to first, then on together', () => {
    // Bulwark in 0x01D202A6 (the fountain wing, z 0) walks to 0x01D2014A with stay_with; his way drops to the −6 deck and
    // runs west. Arcanist stands on the −12 hall under the pit (0x01D20127), off his way; once he is beside her she comes
    // along a few steps behind him (her follow).
    const go = async (walk: Partial<import('../packages/renderer/src/agent/AgentApi.ts').WalkOptions>): Promise<{ r: import('../packages/renderer/src/agent/types.ts').AgentResult; host: import('./_harness/dungeonWalk.js').DungeonHost; api: AgentApi | null }> => {
      const { DungeonHost } = await import('./_harness/dungeonWalk.js');
      const host = new DungeonHost(navSoldier, dats(), LB, { rooms: true });
      host.me.health = { current: 187, max: 187 };
      fellow(host, ARC, 'Claude Arcanist');
      const a = host.add({ guid: ARC, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, cell: C(0x127), x: 89.9, y: -67.3, z: -12 });
      const trail: Array<{ cell: number; x: number; y: number; z: number }> = [];
      let joined = false;
      let api: AgentApi | null = null;
      try {
        const r = await host.run(C(0x2a6), { x: 90, y: -60, z: 0 }, (x) => { api = x; return x.walkTo('0x01D2014A', { stayWith: 'Claude Arcanist', onAwayKeepGoing: true, ...walk }); }, {
          maxMs: 400_000,
          each: () => {
            a.heardAt = host.t;
            trail.push({ cell: host.me.cell, x: host.me.x, y: host.me.y, z: host.me.z });
            if (!joined && Math.hypot(host.me.x - a.x, host.me.y - a.y) < 3.5 && Math.abs(host.me.z - a.z) < 1) joined = true;
            if (joined && trail.length > 15) Object.assign(a, trail[trail.length - 15]);
          },
        });
        return { r, host, api };
      } finally { host.dispose(); }
    };

    it('goes back for her, then on to 0x01D2014A with her (was "stopped 57.6 m short: … hasn\'t moved for 12 s")', async () => {
      vi.useFakeTimers();
      vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        // drop=true: she comes along behind him, down the drops too (without it the walk stops at the first edge while she
        // is on his floor: verify-agent-stream-movement-2026-10-17-0614z).
        const { r, host, api } = await go({ drop: true });
        expect(r.ok, `${r.message}\n${host.traces.join('\n')}`).toBe(true);
        expect(r.message).toMatch(/^Claude Arcanist, \d+ m [NSEW]+ of you, hadn't moved for 1\d s and wasn't on your way \(on another floor \(\d+ m down\)\): went back to them first \(arrived [^)]*\)[^:]*, then on together: arrived/);
        expect(host.me.cell).toBe(C(0x14a));
        // One answer for the whole chain: the legs' own ends woke no ac_wait types=task-done.
        const done = api!.eventsSince(0).filter((e) => e.type === 'task-done');
        expect(done.map((e) => e.text)).toHaveLength(1);
        expect(done[0].text).toMatch(/^walking to cell 0x01D2014A: arrived/);
        expect(api!.eventsSince(0).some((e) => e.type === 'chat' && /\[Agent\] walk: Claude Arcanist, \d+ m [NSEW]+ of you, hasn't moved for 1\d s, and isn't on your way \(on another floor \(\d+ m down\)\); going back to them first, then on/.test(e.text))).toBe(true);
      } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
    }, 400_000);

    it('once gone back for, a second split ends the walk saying so', async () => {
      vi.useFakeTimers();
      vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const { r } = await go({ stayRejoins: AgentApi.STAY_WITH_REJOINS });
        expect(r.ok).toBe(false);
        expect(r.message).toMatch(/hasn't moved for 1\d s \(fighting, busy, stuck or waiting for you\?\); you went back for them once already on this walk, and the way you take is one they don't come by: lead another way, or follow them/);
      } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
    }, 400_000);
  });
});
