/**
 * Stream reports, 2026-10-18 14:27–15:30Z (build 899a2cce): Claude Arcanist (mage) and Claude Bulwark (soldier) on the
 * doll loop in Aerbax Laboratory 0x029E. Reports stream/reports/{mage-2026-10-18T15-29-19-821Z,
 * soldier-2026-10-18T15-29-26-495Z}-seg1.md; page traces mage.log / soldier.log; transcripts *-2026-10-18-seg1.jsonl.
 *
 * 1. "Routine follow gives up once the partner is out of sight" (at the portals and the pocket). Not a drop, a stale spot
 *    or the failed-leap exclusion: at 14:51:58Z Bulwark used the Surface portal #7029e005 (0x029E0122) 2 m from her. Her
 *    client placed him outside the dungeon, so fellowLastSeen had no spot ("out of sight; standing still"). At 14:52:14Z he
 *    came back in at the entrance, 0x029E0269, 622 m off; the Follow walked at that spot 36 times in 20 s, every one "no
 *    doorway route from cell 0x29e0117 to cell 0x29e0269 ... (routeCutOff)": the pocket half reaches the entrance only by
 *    that portal. The drops were taken (14:44:10Z, 15:24:21Z). The routine's Follow now goes through the portal its leader
 *    took (beyond VTank, FollowThroughPortals, on), and through the portal that took you to their landblock before when
 *    they are in another space. The other split (15:26:37Z) was her own walk_to 0x029E0122 flee=true, which ran on ahead
 *    of him through the dolls' hits (her routine held: "you took over"), not the Follow.
 * 2. stay_with split the pair:
 *    - a pack while walking: 14:41:18Z and 15:16:18Z, "didn't stop to wait ... you were being hit", Arcanist 76 m and 42 m
 *      behind. Those hits were 0-damage nicks (fix8 4f0d4697 now waits through them). Real danger (a pack near his level, a
 *      caster whose spells hurt, health under 60%) walked on without her; now it holds there to fight.
 *    - the pocket: at 15:24:19Z his stay_with drop=true walk landed and walked on 85 m to 0x029E0197 while she was still up
 *      on the ledge floor, out of his sight; she was 44 m behind at his arrival. A stay_with walk down a drop now waits
 *      at the bottom until the fellow is down too. The last walk out (15:26:33Z) waited for her ("caught up (4 m); on")
 *      and then stopped for a pack; she was not left below. It was her flee walk that went on 115 m ahead of him.
 *    - "or walk on without waiting (no stay_with)" closed the edge wait's answer at 15:24:10Z; it, and the run-up drop
 *      answers' "far=true drop=true to go anyway", now say to wait for them or go down together.
 * 3. cast repeat=true at 0x029E0116 (15:27:33–41Z) stopped after one bolt for "Marionette (it casts Feeblemind Other II,
 *    Slowness Other II), Innocent Doll (it casts Lightning Vulnerability Other III, ...)", both on her from the start. One
 *    on you from the start now stops it only as real danger: a spell of its kind's that took a tenth of your health (the
 *    Doll's kind had: Lightning Bolt III 54 and Flame Bolt III 56 at 15:27:00–09Z, and a 76 crit came 0.4 s after the
 *    stop), a heavy hit, or far above you. A debuffer (the Marionette) is named and cast on through. The reason names
 *    the spell that hurt, not the first two it was seen casting.
 * 4. "stopped 135 m / 115 m / 86 m short": the straight line from where he stood to the goal cell's floor point. It was
 *    right: 0x029E0197's point is (40, −440), 85 m south of the drop's edge (55.9, −355.2). Where the doorway route is
 *    much longer than the straight line, the answer now gives both.
 * 5. Checked, retail (ACE): Heal Other on a full-health target spends its mana: Player_Magic.cs spends it at the cast
 *    (UpdateVitalDelta(Mana, -manaUsed)) before WorldObject_Magic.HandleBoostTransferSpell clamps the boost to what the
 *    target can take ("restore 0 points"). Heal Self's 11 and 2 (15:27:24.96Z, 15:28:00Z) came after the routine's own
 *    heals of 54 and 89 had landed first.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { ALL_MODULES_OFF, type RoutineProfile } from '../packages/shared/src/routines/index.ts';
import type { AgentResult } from '../packages/renderer/src/agent/types.ts';
import { routineFromFile } from '../tools/ac-agent/tools.ts';
import { FakeHost, run } from './_harness/agentFake.ts';
import { DAT_PATHS, openDat } from './_harness/dat.ts';

const REPO = resolve(__dirname, '..');
const ARC = 0x500000a3, BUL = 0x500000a4;
const SURFACE = 0x7029e005, LAB = 0x78972000;
const haveDat = existsSync(DAT_PATHS.cell) && existsSync(DAT_PATHS.portal);

/** mage.json's "With Bulwark" Follow alone (navigation on, the rest off): what the Follow does, not the macro. */
const followOnly = (settings: Record<string, string | number | boolean> = {}): RoutineProfile => {
  const r = routineFromFile(join(REPO, 'tools', 'stream', 'routines', 'mage.json'));
  if ('text' in r) throw new Error(r.text);
  return { ...r.profile, modules: { ...ALL_MODULES_OFF, navigation: true }, settings: { ...r.profile.settings, ...settings } };
};
const fellowsOf = (guid: number, name: string): FakeHost['fellows'] => () => [{ guid, name, health: { cur: 190, max: 193 }, stamina: { cur: 200, max: 278 }, mana: { cur: 100, max: 103 } }];

type Nav = Awaited<ReturnType<typeof import('./_harness/dungeonNav.ts')['dungeonNav']>>;
const LB = 0x029e0000;
const C = (n: number): number => (LB | n) >>> 0;
// Aerbax Laboratory's frame: global − (384, 30336) (the page traces' (434, 29696) is local (50, −640)).
const cellAt = (nav: Nav, x: number, y: number, z: number, hint: number): number => {
  const c = nav.col.findCellContaining(384 + x, 30336 + y, z + 0.5, hint);
  if (!c) throw new Error(`no cell at (${x}, ${y}, ${z})`);
  return c >>> 0;
};

describe.skipIf(!haveDat)('1. the routine\'s Follow takes the portal its leader went through (Aerbax Laboratory 0x029E)', () => {
  let nav: Nav;
  beforeAll(async () => {
    const { dungeonNav } = await import('./_harness/dungeonNav.ts');
    nav = await dungeonNav(LB, { statics: true });
  }, 180_000);
  beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  /**
   * 14:51:46–14:52:34Z: Arcanist in 0x029E0117 beside Bulwark, who walks to Surface #7029e005 (0x029E0122, (50, −690,
   * −18)) and goes through: placed on the landscape (0x89720026) 6 s later, back in at the entrance 0x029E0269 at 20 s.
   */
  const lap = async (settings: Record<string, string | number | boolean>): Promise<{ hist: string; traces: string; sent: string[]; me: { x: number; y: number } }> => {
    const { DungeonHost } = await import('./_harness/dungeonWalk.js');
    const host = new DungeonHost(nav, { portal: openDat(DAT_PATHS.portal), cell: openDat(DAT_PATHS.cell) }, LB, { rooms: true });
    try {
      host.me = { ...host.me, guid: ARC, name: 'Claude Arcanist', level: 52, health: { current: 186, max: 186 }, stamina: { current: 250, max: 251 } };
      host.add({ guid: SURFACE, name: 'Surface', itemType: 0x10000, objectDescFlags: 0x40000, cell: C(0x122), x: 50, y: -690, z: -17.995 });
      host.add({ guid: BUL, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, cell: C(0x117), x: 50, y: -632, z: -18 });
      host.fellows = fellowsOf(BUL, 'Claude Bulwark');
      const use = host.use;
      host.use = (g: number): boolean => {
        if (g !== SURFACE) return use(g);
        host.sent.push(`use ${g.toString(16)}`);
        host.screenName = 'portal-space';
        return true;
      };
      let api: AgentApi | null = null;
      const reports: string[] = [];
      const t0 = host.t;
      await host.run(C(0x117), { x: 50, y: -628, z: -18 }, (a) => { api = a; a.routine.onReport = (t) => { reports.push(t); }; a.routine.start(followOnly(settings)); return new Promise<AgentResult>(() => {}); }, {
        maxMs: 60_000,
        each: () => {
          const b = host.objs.get(BUL)!, t = host.t - t0;
          if (t < 5000) { b.y = Math.max(-687, -632 - t / 70); b.cell = cellAt(nav, b.x, b.y, -18, C(0x122)); b.heardAt = host.t; }
          else if (t < 11_000) { b.cell = 0x89720026; b.x = 120; b.y = 130; b.z = 0; b.heardAt = host.t; }
          else if (t < 11_200) { b.cell = C(0x269); b.x = 50; b.y = -11.7; b.z = 6; b.heardAt = host.t; }
        },
      });
      // The routine's notes and its reports (to chat live: "[Automation] Follow: … standing still").
      const a = api as AgentApi | null;
      const hist = a ? [...a.routine.history(), ...reports].join('\n') : '';
      if (a) a.routine.stop();
      return { hist, traces: host.traces.join('\n'), sent: host.sent, me: { x: host.me.x, y: host.me.y } };
    } finally { host.dispose(); }
  };

  it('Bulwark through the Surface portal 2 m off: the Follow says so and goes through it, not "standing still"', async () => {
    const r = await lap({});
    const why = `${r.hist}\n${r.traces.slice(-3000)}`;
    expect(r.hist, why).toMatch(/Follow: Claude Bulwark went through Surface #7029e005 \(they went through it \d+ s ago\); following through it/);
    expect(r.sent, why).toContain(`use ${SURFACE.toString(16)}`);
    expect(r.hist, why).not.toMatch(/out of sight; standing still/);
    expect(r.traces, why).not.toMatch(/routeCutOff/);
  }, 300_000);

  it('VTank\'s Follow (FollowThroughPortals off), as live: "standing still", then no foot route to his re-entry spot, said once, not walked at 36 times', async () => {
    const r = await lap({ FollowThroughPortals: false });
    const why = `${r.hist}\n${r.traces.slice(-3000)}`;
    expect(r.sent, why).not.toContain(`use ${SURFACE.toString(16)}`);
    expect(r.hist, why).toMatch(/Follow: Claude Bulwark is out of sight; standing still/);
    // The live failure, reproduced: the pocket half has no doorway route to the entrance (0x029E0269).
    expect(r.traces, why).toMatch(/no doorway route from cell 0x29e01(17|19|22) to cell 0x29e0269/);
    expect(r.hist, why).toMatch(/Follow: no way on foot to where Claude Bulwark was last placed: .*standing still \(ask them where they are\)/);
    // In the 49 s after his re-entry: one try each FOLLOW_NO_WAY_MS (15 s), not one every 0.6 s.
    expect((r.traces.match(/routeCutOff\); ending at once/g) ?? []).length, why).toBeLessThanOrEqual(5);
  }, 300_000);

  it('Bulwark drops 6 m into the Pristine pocket and walks on south: the Follow takes the drop and reaches him on his floor', async () => {
    const { DungeonHost } = await import('./_harness/dungeonWalk.js');
    const host = new DungeonHost(nav, { portal: openDat(DAT_PATHS.portal), cell: openDat(DAT_PATHS.cell) }, LB, { rooms: true });
    try {
      host.me = { ...host.me, guid: ARC, name: 'Claude Arcanist', level: 52, health: { current: 186, max: 186 }, stamina: { current: 250, max: 251 } };
      // The ledge (soldier.log 15:23:21Z: edge (439.9, 29980.8, z 0), landing (436.6, 29977.5, z −6)).
      const ledge = cellAt(nav, 58, -352, 0, C(0x1a3));
      const below = cellAt(nav, 50, -365, -6, C(0x197));
      host.add({ guid: BUL, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, cell: below, x: 50, y: -365, z: -6 });
      host.fellows = fellowsOf(BUL, 'Claude Bulwark');
      let api: AgentApi | null = null;
      await host.run(ledge, { x: 58, y: -352, z: 0 }, (a) => { api = a; a.routine.start(followOnly()); return new Promise<AgentResult>(() => {}); }, {
        maxMs: 45_000,
        each: () => {
          const b = host.objs.get(BUL)!;
          // His legs after the landing (soldier.log 15:24:19–28Z): south along x 50 to −405, then x 40 to −437.5.
          if (b.y > -405) b.y -= 0.3;
          else if (b.x > 40) { b.x = 40; b.y = -412.5; }
          else if (b.y > -437.5) b.y -= 0.3;
          b.cell = cellAt(nav, b.x, b.y, -6, b.cell ?? below);
        },
      });
      const hist = api ? (api as AgentApi).routine.history().join('\n') : '';
      if (api) (api as AgentApi).routine.stop();
      const why = `${hist}\n${host.traces.slice(-40).join('\n')}`;
      expect(host.me.z, why).toBeLessThan(-5);
      expect(Math.hypot(host.me.x - host.objs.get(BUL)!.x, host.me.y - host.objs.get(BUL)!.y), why).toBeLessThan(12);
    } finally { host.dispose(); }
  }, 300_000);
});

describe('1. (no DAT) a Follow after a leader in another space takes the portal that took you there; no portal for a walk', () => {
  let host: FakeHost;
  let api: AgentApi;
  const LAND = 0x89720026;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    host.wall = () => false;
    host.me = { ...host.me, guid: ARC, name: 'Claude Arcanist', level: 52, cell: LAND, x: 100, y: 100, z: 0, health: { current: 186, max: 186 } };
    host.fellows = fellowsOf(BUL, 'Claude Bulwark');
    api = new AgentApi(host);
  });
  afterEach(() => { api.routine.stop(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it('on the landscape with Bulwark back inside 0x029E: through "Aerbax Laboratory", which took her in before', async () => {
    host.add({ guid: LAB, name: 'Aerbax Laboratory', itemType: 0x10000, objectDescFlags: 0x40000, cell: LAND, x: 100, y: 103, z: 0 });
    // Her trip in through it earlier: stood by it, portal space, placed in the dungeon.
    host.me = { ...host.me, x: 100, y: 101.5 };
    run(api, host, 300, { physics: false });
    host.screenName = 'portal-space'; run(api, host, 300, { physics: false });
    host.me = { ...host.me, cell: C(0x269), x: 50, y: -11.7, z: 6 }; host.screenName = 'world'; run(api, host, 300, { physics: false });
    // Out again by Surface (no portal recorded beside her there), back on the landscape 6 m from the Lab portal.
    host.screenName = 'portal-space'; run(api, host, 300, { physics: false });
    host.me = { ...host.me, cell: LAND, x: 100, y: 97, z: 0 }; host.screenName = 'world'; run(api, host, 300, { physics: false });
    host.add({ guid: BUL, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, cell: C(0x269), x: 50, y: -11.7, z: 6 });
    const used: number[] = [];
    host.use = (g: number) => { host.sent.push(`use ${g.toString(16)}`); used.push(g); host.screenName = 'portal-space'; return true; };
    expect(api.fellowPortal('Claude Bulwark')).toMatchObject({ guid: LAB, name: 'Aerbax Laboratory' });
    api.routine.start(followOnly());
    for (let i = 0; i < 100 && !used.length; i++) { run(api, host, 100); await vi.advanceTimersByTimeAsync(0); }
    const hist = api.routine.history().join('\n');
    expect(hist, hist).toMatch(/Follow: Claude Bulwark went through Aerbax Laboratory #78972000 \(they are in landblock 0x029E \(a dungeon\), where it took you before\); following through it/);
    expect(used, hist).toEqual([LAB]);
  });

  it('a leader who walks off past a portal and out of view at a run is no portal trip', async () => {
    host.add({ guid: LAB, name: 'Aerbax Laboratory', itemType: 0x10000, objectDescFlags: 0x40000, cell: LAND, x: 100, y: 130, z: 0 });
    host.add({ guid: BUL, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, cell: LAND, x: 100, y: 127, z: 0 });
    run(api, host, 500, { physics: false });
    // He runs on 4 m/s past it for 15 s: placed 60 m on, nothing a portal does.
    for (let i = 0; i < 15; i++) { const b = host.objs.get(BUL)!; b.y += 4; b.heardAt = host.t; run(api, host, 1000, { physics: false }); }
    expect(api.fellowPortal('Claude Bulwark')).toBeNull();
  });

  it('the server moving him 600 m in a step from beside a portal in your dungeon is one (the same-landblock re-entry)', async () => {
    host.me = { ...host.me, cell: C(0x117), x: 50, y: -630, z: -18 };
    host.add({ guid: SURFACE, name: 'Surface', itemType: 0x10000, objectDescFlags: 0x40000, cell: C(0x122), x: 50, y: -690, z: -17.995 });
    host.add({ guid: BUL, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, cell: C(0x122), x: 50, y: -687, z: -18 });
    run(api, host, 500, { physics: false });
    const b = host.objs.get(BUL)!;
    b.cell = C(0x269); b.x = 50; b.y = -11.7; b.z = 6; b.heardAt = host.t;
    run(api, host, 300, { physics: false });
    expect(api.fellowPortal('Claude Bulwark')).toMatchObject({ guid: SURFACE, why: expect.stringMatching(/they went through it \d+ s ago/) });
  });
});

describe.skipIf(!haveDat)('2. stay_with in the Pristine pocket: hold under real danger, wait at the bottom of the drop (0x029E)', () => {
  let nav: Nav;
  beforeAll(async () => {
    const { dungeonNav } = await import('./_harness/dungeonNav.ts');
    nav = await dungeonNav(LB, { statics: true });
  }, 180_000);
  beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  const bulwark = async () => {
    const { DungeonHost } = await import('./_harness/dungeonWalk.js');
    const host = new DungeonHost(nav, { portal: openDat(DAT_PATHS.portal), cell: openDat(DAT_PATHS.cell) }, LB, { rooms: true });
    host.me = { ...host.me, guid: BUL, name: 'Claude Bulwark', level: 49, health: { current: 193, max: 193 }, stamina: { current: 250, max: 281 } };
    host.fellows = fellowsOf(ARC, 'Claude Arcanist');
    return host;
  };

  it('three L50 Innocent Dolls on him with Arcanist 25 m back: the walk to 0x029E0117 holds there for her, not on 76 m ahead', async () => {
    const host = await bulwark();
    try {
      const at = host.cellPoint!(C(0x197))!;
      host.add({ guid: ARC, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, cell: cellAt(nav, 40, -417.5, -6, C(0x198)), x: 40, y: -417.5, z: -6 });
      const dolls = [0x8000b378, 0x8000b00e, 0x8000b009];
      let hitAt = 0;
      const r = await host.run(C(0x197), at, (api) => api.walkTo('0x029E0117', { stayWith: 'Claude Arcanist', stopOnAggro: false }), {
        maxMs: 60_000,
        each: (api) => {
          if (host.t < 4000) return;
          for (const g of dolls) {
            if (!host.objs.get(g)) host.add({ guid: g, name: 'Innocent Doll', itemType: 0x10, objectDescFlags: 0x10, level: 50, cell: host.me.cell, x: host.me.x + 1, y: host.me.y, z: host.me.z });
            const m = host.objs.get(g)!; m.x = host.me.x + 1; m.y = host.me.y; m.z = host.me.z; m.cell = host.me.cell;
          }
          if (host.t - hitAt >= 1000) { hitAt = host.t; api.pushChat('Innocent Doll scratches your foot for 2 points of slashing damage!', 0x15); }
        },
      });
      const why = `${r.message}\n${host.traces.slice(-30).join('\n')}`;
      expect(r.message, why).toMatch(/^stopped [\d.]+ m short to hold with Claude Arcanist: real danger on you \(being hit\) and they are \d+ m [NESW]+ of you, past the 15 m leash\. A stay_with walk neither stands waiting under it nor goes on without them: fight here, where they catch up/);
      expect(Math.hypot(host.me.x - 40, host.me.y + 417.5), why).toBeLessThan(40);
    } finally { host.dispose(); }
  }, 300_000);

  /** 15:24:14Z: Bulwark at the drop's edge with Arcanist beside him, walk_to 0x029E0197 drop=true stay_with. */
  const dropWalk = async (comesAtMs: number | null) => {
    const host = await bulwark();
    const ledge = cellAt(nav, 55.9, -355.2, 0, C(0x1a3));
    host.add({ guid: ARC, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, cell: ledge, x: 57, y: -353, z: 0 });
    const seen: { landedAt: { x: number; y: number } | null; atComing: { x: number; y: number } | null } = { landedAt: null, atComing: null };
    try {
      const r = await host.run(ledge, { x: 55.9, y: -355.2, z: 0 }, (api) => api.walkTo('0x029E0197', { stayWith: 'Claude Arcanist', drop: true }), {
        maxMs: 120_000,
        each: () => {
          if (!seen.landedAt && host.me.z < -5) seen.landedAt = { x: host.me.x, y: host.me.y };
          const a = host.objs.get(ARC)!;
          if (comesAtMs !== null && host.t >= comesAtMs) {
            if (a.z > -1) { seen.atComing = { x: host.me.x, y: host.me.y }; a.x = 52.6; a.y = -359.4; a.z = -6; a.cell = cellAt(nav, 52.6, -359.4, -6, C(0x197)); }
            else { const dx = host.me.x - a.x, dy = host.me.y - a.y, d = Math.hypot(dx, dy); if (d > 3) { a.x += (dx / d) * 0.4; a.y += (dy / d) * 0.4; a.cell = cellAt(nav, a.x, a.y, -6, a.cell ?? C(0x197)); } }
          }
        },
      });
      return { r, landedAt: seen.landedAt, atComing: seen.atComing, traces: host.traces, host };
    } finally { host.dispose(); }
  };

  it('down the 6 m drop, he waits at the bottom until she is down, then walks on with her', async () => {
    const { r, landedAt, atComing, traces } = await dropWalk(20_000);
    const why = `${r.message}\n${traces.slice(-30).join('\n')}`;
    expect(traces.join('\n'), why).toMatch(/walk: down the 6\.0 m drop; waiting at the bottom for Claude Arcanist to come down/);
    expect(landedAt, why).not.toBeNull();
    expect(atComing, why).not.toBeNull();
    // Still at the bottom when she came down 20 s in (live he was 85 m on by then).
    expect(Math.hypot(atComing!.x - landedAt!.x, atComing!.y - landedAt!.y), why).toBeLessThan(6);
    expect(traces.join('\n'), why).toMatch(/walk: Claude Arcanist came down the drop \(\d+ m\); on/);
    expect(r.ok, why).toBe(true);
    expect(r.message, why).toMatch(/waited \d+ s for Claude Arcanist/);
  }, 300_000);

  it('she never comes down: he says so at the bottom after the wait, and never walks on leaving her above', async () => {
    const { r, landedAt, host } = await dropWalk(null);
    const why = `${r.message}\n${host.traces.slice(-20).join('\n')}`;
    expect(r.message, why).toMatch(/^stopped [\d.]+ m short at the bottom of the 6\.0 m drop: waited 4\d s there for Claude Arcanist to come down after you, and they haven't \(\d+ m [NESW]+ of you, 6 m up\)\. The drop is one way, so stay_with doesn't walk on and leave them above/);
    expect(Math.hypot(host.me.x - landedAt!.x, host.me.y - landedAt!.y), why).toBeLessThan(6);
  }, 300_000);
});

describe('2. (no DAT) a stay_with answer suggests waiting for the fellow, never walking without stay_with', () => {
  it('Arcanist 20 m back standing still: the answer says to wait on for her, not "walk on without waiting (no stay_with)"', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const host = new FakeHost();
      host.wall = () => false;
      host.me = { ...host.me, guid: BUL, name: 'Claude Bulwark', level: 49 };
      host.fellows = fellowsOf(ARC, 'Claude Arcanist');
      host.add({ guid: ARC, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, x: 100, y: 20 });
      const api = new AgentApi(host);
      let r: AgentResult | null = null;
      void api.walkTo('40m west', { stayWith: 'Claude Arcanist' }).then((x) => { r = x; });
      for (let t = 0; t < 60_000 && !r; t += 100) { run(api, host, 100); await Promise.resolve(); await Promise.resolve(); }
      expect(r).not.toBeNull();
      expect(r!.message, r!.message).toMatch(/hasn't moved for \d+ s/);
      expect(r!.message).toMatch(/or wait on for them here \(a walk without stay_with leaves them behind\)/);
      expect(r!.message).not.toMatch(/no stay_with\)/);
    } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
  });
});

describe('3. cast repeat=true: casters on you from the start whose spells took no real health are cast on through', () => {
  let host: FakeHost;
  let api: AgentApi;
  let reply: (n: number) => void;
  let castsSent: number;
  const TARGET = 0x8000b30d, MAR = 0x8000b122, DOLL = 0x8000b0ff, NEW = 0x8000b40d;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    const t0 = Date.now();
    host.now = () => Date.now() - t0;
    api = new AgentApi(host);
    host.me.level = 52;
    host.me.health = { current: 162, max: 186 };
    host.me.mana = { current: 300, max: 331 };
    host.spells = () => [{ id: 27, name: 'Flame Bolt V', school: 'War', level: 5, projectile: true, range: 20 }];
    (host as unknown as { lineOfFire: () => { dist: number; blockedAt: null } }).lineOfFire = () => ({ dist: 3, blockedAt: null });
    host.add({ guid: TARGET, name: 'Innocent Doll', itemType: 0x10, objectDescFlags: 0x10, x: 84, y: 23, level: 50 });
    host.add({ guid: MAR, name: 'Marionette', itemType: 0x10, objectDescFlags: 0x10, x: 81, y: 19, level: 26 });
    castsSent = 0;
    reply = (n) => { api.pushChat('You incinerate Innocent Doll for 119 points with Flame Bolt V.', 0x16); if (n === 4) host.dying.add(TARGET); };
    host.cast = (id: number, t: number | null) => {
      host.sent.push(`cast ${id} ${t === null ? 'self' : t.toString(16)}`);
      const n = ++castsSent;
      setTimeout(() => { host.me.mana.current -= 10; reply(n); }, 600);
      return true;
    };
  });
  afterEach(() => vi.useRealTimers());
  async function settle(p: Promise<AgentResult>, ms = 60_000): Promise<AgentResult> {
    let out: AgentResult | undefined;
    void p.then((r) => { out = r; });
    for (let t = 0; t < ms && out === undefined; t += 200) await vi.advanceTimersByTimeAsync(200);
    if (!out) throw new Error('repeat never answered');
    return out;
  }
  /** The Marionette on you already, its kind seen only debuffing, nicking for 1 through the casts. */
  const marionetteOn = (): void => {
    api.pushChat('Marionette cast Feeblemind Other II on you', 0x16);
    api.pushChat('Marionette cast Slowness Other II on you', 0x16);
    api.pushChat('Marionette grazes your foot for 1 point of bludgeoning damage!', 0x15);
    run(api, host, 200, { physics: false });
  };

  it('a Marionette on you from the start, seen only debuffing: four bolts to the kill, and it is named', async () => {
    marionetteOn();
    const base = reply;
    reply = (n) => { base(n); api.pushChat('Marionette grazes your chest for 1 point of bludgeoning damage!', 0x15); };
    const r = await settle(api.cast('Flame Bolt V', TARGET, { repeat: true }));
    expect(castsSent, r.message).toBe(4);
    expect(r.message.split('\n')[0]).toBe('cast Flame Bolt V at Innocent Doll 4 times (repeat); stopped: Innocent Doll died');
    expect(r.message).toContain('cast on through, on you from the start: Marionette #8000b122 (it casts Feeblemind Other II, Slowness Other II; its spells took no tenth of your health)');
  });

  it('an Innocent Doll on you from the start whose kind\'s Flame Bolt III took 56: stops after the first, naming that bolt', async () => {
    marionetteOn();
    host.add({ guid: DOLL, name: 'Innocent Doll', itemType: 0x10, objectDescFlags: 0x10, x: 80.6, y: 20.4, level: 50 });
    api.pushChat('Innocent Doll cast Lightning Vulnerability Other III on you', 0x16);
    api.pushChat('Innocent Doll burns you for 56 points with Flame Bolt III.', 0x15);
    api.pushChat('Innocent Doll scratches your lower leg for 1 point of slashing damage!', 0x15);
    run(api, host, 200, { physics: false });
    const base = reply;
    reply = (n) => { base(n); api.pushChat('Innocent Doll scratches your upper arm for 1 point of slashing damage!', 0x15); api.pushChat('Marionette grazes your chest for 1 point of bludgeoning damage!', 0x15); };
    const r = await settle(api.cast('Flame Bolt V', TARGET, { repeat: true }));
    expect(castsSent, r.message).toBe(1);
    expect(r.message.split('\n')[0]).toMatch(/stopped: Innocent Doll #8000b0ff \(\d× in 10 s; its kind's Flame Bolt III took 56 of your 1\d\d health\), on you from the start and not your target, is real danger now$/);
    expect(r.message.split('\n')[0]).not.toMatch(/Marionette/);
  });

  it('a new caster joining in still stops it (unknown danger), as before', async () => {
    marionetteOn();
    const base = reply;
    reply = (n) => {
      base(n);
      if (n === 1) {
        host.add({ guid: NEW, name: 'Pristine Doll', itemType: 0x10, objectDescFlags: 0x10, x: 82, y: 20, level: 60 });
        api.pushChat('Pristine Doll cast Frailty Other III on you', 0x16);
        api.pushChat('Pristine Doll scratches your foot for 1 point of slashing damage!', 0x15);
      }
    };
    const r = await settle(api.cast('Flame Bolt V', TARGET, { repeat: true }));
    expect(castsSent, r.message).toBe(1);
    expect(r.message.split('\n')[0]).toMatch(/stopped: Pristine Doll #8000b40d \(1× in 10 s; it casts Frailty Other III\) started attacking you, and isn't your target$/);
  });
});

describe.skipIf(!haveDat)('4. "stopped N m short" is the straight line; a much longer doorway way is said beside it (0x029E)', () => {
  let nav: Nav;
  beforeAll(async () => {
    const { dungeonNav } = await import('./_harness/dungeonNav.ts');
    nav = await dungeonNav(LB, { statics: true });
  }, 180_000);
  beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('at the drop\'s edge (15:24:10Z): 86 m short is the straight line to 0x029E0197\'s floor point, 85 m south', async () => {
    const { DungeonHost } = await import('./_harness/dungeonWalk.js');
    const host = new DungeonHost(nav, { portal: openDat(DAT_PATHS.portal), cell: openDat(DAT_PATHS.cell) }, LB, { rooms: true });
    try {
      host.me = { ...host.me, guid: BUL, name: 'Claude Bulwark', level: 49, health: { current: 193, max: 193 } };
      host.fellows = fellowsOf(ARC, 'Claude Arcanist');
      const ledge = cellAt(nav, 55.9, -355.2, 0, C(0x1a3));
      host.add({ guid: ARC, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, cell: ledge, x: 57, y: -353, z: 0 });
      const r = await host.run(ledge, { x: 55.9, y: -355.2, z: 0 }, (api) => api.walkTo('0x029E0197', { stayWith: 'Claude Arcanist' }), { maxMs: 30_000 });
      const pt = host.cellPoint!(C(0x197))!;
      const m = /^stopped ([\d.]+) m short/.exec(r.message);
      expect(m, r.message).not.toBeNull();
      expect(Math.abs(Number(m![1]) - Math.hypot(pt.x - host.me.x, pt.y - host.me.y)), r.message).toBeLessThan(0.2);
      expect(Number(m![1])).toBeGreaterThan(80);
      expect(r.message).toMatch(/at the edge of a 6\.0 m drop/);
    } finally { host.dispose(); }
  }, 300_000);

  it('from 0x029E016A to 0x029E019E (51 m straight, 94 m by the doorways): a walk stopped on the way says both', async () => {
    const { DungeonHost } = await import('./_harness/dungeonWalk.js');
    const host = new DungeonHost(nav, { portal: openDat(DAT_PATHS.portal), cell: openDat(DAT_PATHS.cell) }, LB, { rooms: true });
    try {
      host.me = { ...host.me, guid: BUL, name: 'Claude Bulwark', level: 49, health: { current: 193, max: 193 } };
      const at = host.cellPoint!(C(0x16a))!;
      const r = await host.run(C(0x16a), at, (api) => api.walkTo('0x029E019E', { timeoutMs: 1500 }), { maxMs: 10_000 });
      expect(r.message, r.message).toMatch(/^timed out [\d.]+ m short in a straight line \(\d+ m left by the doorway route\) after 2 s/);
      const m = /^timed out ([\d.]+) m short in a straight line \((\d+) m left/.exec(r.message)!;
      expect(Number(m[2]) - Number(m[1]), r.message).toBeGreaterThanOrEqual(AgentApi.WAY_LEFT_NOTE_M);
    } finally { host.dispose(); }
  }, 300_000);
});
