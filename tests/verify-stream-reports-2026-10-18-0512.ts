/**
 * Stream reports, 2026-10-18 04:11–05:13Z (build bcf222ec): Claude Bulwark and Claude Arcanist in the doll dungeon 0x029E
 * and Aerbax Haven 0x029F. Each block is one report item, reproduced first.
 */
import { existsSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getClientRunRate } from '@ac/shared';
import { AgentApi, skillLineHint } from '../packages/renderer/src/agent/AgentApi.ts';
import { chordNeedsReport } from '../packages/renderer/src/agent/portalAvoid.ts';
import { skillKey, skillSpellLines, spellSkillMod } from '../packages/renderer/src/agent/spellFamilies.ts';
import { createHostAttack } from '../packages/renderer/src/agent/hostAttack.ts';
import type { AgentResult, AgentSpell } from '../packages/renderer/src/agent/types.ts';
import { ROUTINE_ACTING_MS, quietNudge, runningTask } from '../tools/stream/policy.ts';
import { SpellTable } from '../packages/dat-parser/src/file-types/SpellTable.ts';
import { ALL_MODULES_OFF, type RoutineProfile } from '../packages/shared/src/routines/index.ts';
import { FakeHost, run } from './_harness/agentFake.ts';
import { DAT_PATHS, openDat } from './_harness/dat.ts';

async function settle<T>(api: AgentApi, host: FakeHost, p: Promise<T>, ms: number, each?: () => void): Promise<T | null> {
  let out: T | null = null;
  let done = false;
  void p.then((x) => { out = x; done = true; });
  for (let t = 0; t < ms && !done; t += 100) { each?.(); run(api, host, 100); await Promise.resolve(); await Promise.resolve(); }
  return out;
}

const fightProfile = (): RoutineProfile => ({
  name: 'hunt', modules: { ...ALL_MODULES_OFF, combat: true },
  initialState: 'Hunt', loot: [], buffSets: [], routes: [],
  states: [{ name: 'Hunt', rules: [{ label: 'Fight', when: [{ kind: 'monster-within', meters: 40 }], do: [{ kind: 'attack-nearest', meters: 40 }] }] }],
});

const haveDat = existsSync(DAT_PATHS.cell) && existsSync(DAT_PATHS.portal);

/**
 * The server's view of the walk: ACE moves the player only from the positions the client reports (Player.
 * UpdatePlayerPosition → PhysicsObj.update_object_server: one straight transition from the last reported spot to the new
 * one), and a portal teleports whoever that transition touches (Portal.OnCollideObject). The client reports when its
 * cell changes, at most once a second otherwise (MovementSync shouldSendPositionEvent, TIME_BETWEEN_POSITION_EVENTS), and
 * whenever the agent asks (AgentHost.reportPosition). Each report's straight line from the last is checked against the
 * portal's touch: its collision sphere (Setup 0x020001B3: 1.357 m) plus the body's (0.48 m).
 */
class ServerChords {
  last: { x: number; y: number; t: number; cell: number } | null = null;
  closest = Infinity;
  reports = 0;
  constructor(private readonly host: FakeHost, private readonly portal: { x: number; y: number }) {}
  private send(): void {
    const me = this.host.me;
    if (this.last) {
      const ax = this.last.x, ay = this.last.y, bx = me.x, by = me.y;
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((this.portal.x - ax) * dx + (this.portal.y - ay) * dy) / l2)) : 0;
      this.closest = Math.min(this.closest, Math.hypot(ax + dx * t - this.portal.x, ay + dy * t - this.portal.y));
    }
    this.last = { x: me.x, y: me.y, t: this.host.t, cell: me.cell };
  }
  /** Each tick: the client's own cadence. */
  tick(): void {
    const me = this.host.me;
    if (!this.last || this.last.cell !== me.cell || (this.host.t - this.last.t > 1000 && Math.hypot(me.x - this.last.x, me.y - this.last.y) > 0.01)) this.send();
  }
  /** The agent's own report (AgentHost.reportPosition). */
  report = (): void => { this.reports++; this.send(); };
}

describe.skipIf(!haveDat)('1. walk_to never goes through a portal it was not sent to: the server\'s straight line between reports (0x029E)', () => {
  const LB = 0x029e0000;
  const C = (n: number): number => (LB | n) >>> 0;
  // Aerbax Haven #7029e002 in 0x029E0119 at (50, −640, −18.0) (ACE-World landblock_instance), Setup 0x020001B3.
  const AERBAX = 0x7029e002;
  const PORTAL = { x: 50, y: -640, z: -17.995 };
  const TOUCH_M = 1.357 + 0.48;
  let nav: Awaited<ReturnType<typeof import('./_harness/dungeonNav.ts')['dungeonNav']>>;
  beforeAll(async () => {
    const { dungeonNav } = await import('./_harness/dungeonNav.ts');
    nav = await dungeonNav(LB, { statics: true, jumpSkill: 191, runRate: getClientRunRate(0.5, 179) });
  }, 180_000);
  const dats = (): { portal: ReturnType<typeof openDat>; cell: ReturnType<typeof openDat> } => ({ portal: openDat(DAT_PATHS.portal), cell: openDat(DAT_PATHS.cell) });

  it('Bulwark\'s walk from 0x029E0136 to 0x029E0122 passes the Aerbax Haven portal with every reported line clear of it', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { DungeonHost } = await import('./_harness/dungeonWalk.js');
      // Bulwark runs ~11 m/s (Run 179 buffed): the fake body runs 4, so each tick moves it 2.8 ticks' worth.
      class Fast extends DungeonHost { override physics(dt: number): void { super.physics(this.keys.has('ShiftLeft') ? dt : dt * 2.8); } }
      const host = new Fast(nav, dats(), LB, { rooms: true });
      host.me.health = { current: 187, max: 187 };
      host.add({ guid: AERBAX, name: 'Aerbax Haven', itemType: 0x10000, objectDescFlags: 0x40000, cell: C(0x119), ...PORTAL });
      host.objectReach = (g) => (g === AERBAX ? 1.919 : 0);
      const server = new ServerChords(host, PORTAL);
      host.reportPosition = server.report;
      // Where his walk set off (soldier.log 04:35:43Z: first leg 1.6 m to (424.0, 29838.5) global, 0x029E0136).
      try {
        const r = await host.run(C(0x136), { x: 40, y: -496.5, z: -12 }, (api) => api.walkTo('0x029E0122'), { maxMs: 120_000, each: () => server.tick() });
        expect(r.ok, `${r.message}\n${host.traces.join('\n')}`).toBe(true);
        expect(r.message).toMatch(/^arrived/);
        expect(server.closest, `closest ${server.closest.toFixed(2)} m; ${r.message}\n${host.traces.join("\n")}`).toBeGreaterThan(TOUCH_M);
      } finally { host.dispose(); }
    } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
  }, 240_000);
});

describe.skipIf(!haveDat)('4. a walk to a cell stops on it, not "run past it a little" (0x029F011E)', () => {
  const LB = 0x029f0000;
  const C = (n: number): number => (LB | n) >>> 0;
  let nav: Awaited<ReturnType<typeof import('./_harness/dungeonNav.ts')['dungeonNav']>>;
  beforeAll(async () => {
    const { dungeonNav } = await import('./_harness/dungeonNav.ts');
    nav = await dungeonNav(LB, { statics: true, jumpSkill: 191, runRate: getClientRunRate(0.5, 179) });
  }, 180_000);
  const dats = (): { portal: ReturnType<typeof openDat>; cell: ReturnType<typeof openDat> } => ({ portal: openDat(DAT_PATHS.portal), cell: openDat(DAT_PATHS.cell) });

  for (const tickMs of [100, 300, 500, 700]) {
    it(`from 0x029F0130 at 11 m/s, the page looking every ${tickMs} ms: arrives within reach of 011E's middle`, async () => {
      vi.useFakeTimers();
      vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const { DungeonHost } = await import('./_harness/dungeonWalk.js');
        class Fast extends DungeonHost { override physics(dt: number): void { super.physics(this.keys.has('ShiftLeft') ? dt : dt * 2.8); } }
        const host = new Fast(nav, dats(), LB, { rooms: true });
        try {
          // Bulwark's walk at 04:49:40Z: first leg 1.4 m to (419.0, 30118.0) global, from 0x029F0130.
          const r = await host.walkTarget(C(0x130), { x: 36.2, y: -410.5, z: 0 }, '0x029F011E', { tickMs });
          expect(r.ok, `${r.message}\n${host.traces.join('\n')}`).toBe(true);
          expect(r.message, host.traces.join('\n')).not.toMatch(/run past it/);
          expect(Math.hypot(host.me.x - 30, host.me.y + 420)).toBeLessThan(2.6);
        } finally { host.dispose(); }
      } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
    }, 240_000);
  }
});

describe.skipIf(!haveDat)('6. "12m west" from 0x029F01B2 into the rock goes as far as the way goes, stall or not', () => {
  const LB = 0x029f0000;
  const C = (n: number): number => (LB | n) >>> 0;
  let nav: Awaited<ReturnType<typeof import('./_harness/dungeonNav.ts')['dungeonNav']>>;
  beforeAll(async () => {
    const { dungeonNav } = await import('./_harness/dungeonNav.ts');
    nav = await dungeonNav(LB, { statics: true, jumpSkill: 191, runRate: getClientRunRate(0.5, 179) });
  }, 180_000);
  const dats = (): { portal: ReturnType<typeof openDat>; cell: ReturnType<typeof openDat> } => ({ portal: openDat(DAT_PATHS.portal), cell: openDat(DAT_PATHS.cell) });

  for (const stall of [false, true]) {
    it(`${stall ? 'three dolls\' bodies hold the body still 4 s on the way' : 'nothing in the way'}: ends at the corridor west, not "stuck … walls all round"`, async () => {
      vi.useFakeTimers();
      vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const { DungeonHost } = await import('./_harness/dungeonWalk.js');
        // The dolls (Innocent Doll 1.0 m NE, 1.1 m N, 1.7 m E at stall 1, soldier.log 05:11:40Z) as a hold on the body.
        class Held extends DungeonHost {
          holdFrom = 0;
          override physics(dt: number): void {
            const on = stall && this.t >= this.holdFrom + 1500 && this.t < this.holdFrom + 5500;
            // Three Innocent Dolls standing round the body (one 1.0 m NE, 1.1 m N, 1.7 m E), then gone (killed).
            const dolls = [[0.7, 0.7], [0, 1.1], [1.7, 0]] as const;
            dolls.forEach(([dx, dy], i) => {
              const g = 0x80007600 + i;
              if (on && !this.objs.has(g)) this.add({ guid: g, name: 'Innocent Doll', itemType: 0x10, objectDescFlags: 0x10, cell: this.me.cell, x: this.me.x + dx, y: this.me.y + dy, z: this.me.z, level: 50 });
              if (!on) this.objs.delete(g);
            });
            if (on) return;
            super.physics(dt);
          }
        }
        const host = new Held(nav, dats(), LB, { rooms: true });
        host.holdFrom = host.t;
        try {
          // Where he stood, facing west (soldier.log 05:11:34Z: the probe west stops at (471.8, 30073.0), 0x029F01B2).
          const r = await host.walkTarget(C(0x1b2), { x: 89.2, y: -455, z: 0 }, '12m west');
          expect(r.message, host.traces.join('\n')).not.toMatch(/walls all round/);
          // Once the walk took the farthest open point, every later plan aims there, never back at the point in the rock
          // (live: stalls 2–6 "aiming (461.2, 30073.0)" and four searches that found none).
          const from = host.traces.findIndex((l) => /going as far as the way goes/.test(l));
          expect(from).toBeGreaterThanOrEqual(0);
          expect(host.traces.slice(from + 1).filter((l) => /(searching [\d.]+ m to|aiming) \(461\.2, 30073\.0\)|searching wide straight for the goal|search none/.test(l)), host.traces.join('\n')).toEqual([]);
          expect(r.message).toMatch(/^went \d+ m and stopped [\d.]+ m short: no way on toward it past there \(walls\)/);
          // West along the corridor north of the point (the search's own find: (461.7, 30075.8) global).
          expect(host.me.x, host.traces.join('\n')).toBeLessThan(80);
        } finally { host.dispose(); }
      } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
    }, 240_000);
  }
});


describe('1. (no DAT) the walk reports each bend near a portal, so the server\'s straight line keeps out of it', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('chordNeedsReport: on coming near, and when the line from the last report would cross the disk', () => {
    const disk = { x: 0, y: 0, z: 0, r: 2.7 };
    expect(chordNeedsReport(null, { x: 20, y: 0, z: 0 }, { x: 18, y: 0 }, [disk])).toBe(false); // far off
    expect(chordNeedsReport(null, { x: 0, y: 6, z: 0 }, { x: 0, y: 5 }, [disk])).toBe(true); // first time near
    // Round the disk's east side: the line from (3.5, 4) to (3.5, −4) stays 3.5 m off; on to (0, −5) it would cut in.
    expect(chordNeedsReport({ x: 3.5, y: 4 }, { x: 3.5, y: 0, z: 0 }, { x: 3.5, y: -2 }, [disk])).toBe(false);
    expect(chordNeedsReport({ x: 3.5, y: 4 }, { x: 3.5, y: -3, z: 0 }, { x: 1.5, y: -5 }, [disk])).toBe(true);
    // A storey up or down: no line of yours reaches it.
    expect(chordNeedsReport(null, { x: 0, y: 6, z: 8 }, { x: 0, y: 5 }, [disk])).toBe(false);
  });

  it('a corridor with a portal in it: walked round, and every line the server sweeps stays out of the portal\'s touch', async () => {
    const host = new FakeHost();
    const api = new AgentApi(host);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // A 7 m corridor north; the portal in its middle, its disk 2.7 m: the way round hugs the east wall.
    host.wall = (x, y) => x < 76.5 || x > 83.5 || y > 70;
    const PORTAL = { x: 80, y: 40 };
    host.add({ guid: 0x7a9b3000, name: 'Aerbax Haven', itemType: 0x10000, objectDescFlags: 0x40000, ...PORTAL });
    host.add({ guid: 0x80000042, name: 'Chest', itemType: 0x200, x: 80, y: 60 });
    host.objectReach = (g) => (g === 0x7a9b3000 ? 1.919 : 0);
    // Run at 11 m/s (the fake runs 4): each tick moves the body 2.8 ticks' worth.
    const physics = host.physics.bind(host);
    host.physics = (dt) => physics(host.keys.has('ShiftLeft') ? dt : dt * 2.8);
    const server = new ServerChords(host, PORTAL);
    host.reportPosition = server.report;
    const r = await settle(api, host, api.walkTo('Chest'), 60_000, () => server.tick());
    expect(r?.message).toMatch(/^arrived/);
    expect(server.closest).toBeGreaterThan(1.357 + 0.48);
    expect(server.reports).toBeGreaterThan(0);
    expect(server.reports).toBeLessThan(40); // a report at each bend near it, not every tick of the walk
  });
});

describe('2. the supervisor\'s quiet check counts a routine that is acting as running', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('runningTask: the motor task, else a routine running, not paused, that acted within ROUTINE_ACTING_MS', () => {
    expect(runningTask({ task: 'walking to X', routine: null })).toBe('walking to X');
    expect(runningTask({ task: null, routine: { profile: 'hunt', paused: false, actedAgoMs: 4000 } })).toBe('routine "hunt" acting (4 s ago)');
    expect(runningTask({ task: null, routine: { profile: 'hunt', paused: true, actedAgoMs: 4000 } })).toBeNull();
    expect(runningTask({ task: null, routine: { profile: 'hunt', paused: false, actedAgoMs: ROUTINE_ACTING_MS + 1 } })).toBeNull();
    expect(runningTask({ task: null, routine: { profile: 'hunt', paused: false, actedAgoMs: null } })).toBeNull();
    expect(runningTask({ task: null })).toBeNull();
    const q = { nowMs: 200_000, quietMs: 180_000, inTurn: true, wrapUpSent: false, stopping: false, lastActiveMs: 0, lastNudgeMs: -Infinity };
    expect(quietNudge({ ...q, task: runningTask({ task: null, routine: { profile: 'hunt', paused: false, actedAgoMs: 2000 } }) })).toBe(false);
  });

  it('vitals() says the routine and how long since its last swing or cast (the daemon\'s /vitals the supervisor polls)', () => {
    const host = new FakeHost();
    const api = new AgentApi(host);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(api.vitals()!.routine).toBeNull();
    // Combat off in the profile: its own rules don't fight here; the casts below stand for its macro's bolts.
    api.routine.start({ ...fightProfile(), modules: { ...ALL_MODULES_OFF } });
    expect(api.vitals()!.routine).toEqual({ profile: 'hunt', paused: false, actedAgoMs: null });
    // Its bolts as a VirindiTank macro sends them (single casts, no motor task of the agent's own).
    host.add({ guid: 0x80000100, name: 'Pristine Doll', itemType: 0x10, objectDescFlags: 0x10, x: 81, y: 50, level: 60 });
    void api.cast('Flame Bolt I', 0x80000100);
    run(api, host, 3000);
    expect(host.sent.some((x) => x.startsWith('cast 27 80000100'))).toBe(true);
    const v = api.vitals()!;
    expect(v.task).toBeNull();
    expect(v.routine?.actedAgoMs).not.toBeNull();
    expect(v.routine!.actedAgoMs!).toBeLessThan(ROUTINE_ACTING_MS);
    expect(runningTask(v)).toMatch(/^routine "hunt" acting/);
  });
});

describe('3. a follow beside its leader doesn\'t stop for sleepers the leader is as near to', () => {
  const BUL = 0x500000a4;
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host.me.cell = 0xa9b40105; host.cellSealed = () => true; host.me.level = 50;
    host.fellows = () => [{ guid: BUL, name: 'Claude Bulwark', health: { cur: 187, max: 187 }, stamina: { cur: 200, max: 278 }, mana: { cur: 97, max: 97 } }];
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  const doll = (guid: number, x: number, y: number) => host.add({ guid, name: 'Innocent Doll', itemType: 0x10, objectDescFlags: 0x10, cell: host.me.cell, x, y, z: 94, level: 50 });

  it('Arcanist 1.7 m from Bulwark, two Innocent Dolls asleep 21–22 m E of both: the follow follows (was "stopped following …, 1.7 m from them")', async () => {
    host.add({ guid: BUL, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, cell: host.me.cell, x: 80, y: 21.7, z: 94 });
    // Respawned (or come into view) while the follow runs: new to it, 21–22 m E of both.
    let n = 0;
    const r = await settle(api, host, (api.surface() as { follow: (t: string, o?: object) => Promise<AgentResult> }).follow('Claude Bulwark', { durationMs: 8000 }), 20_000,
      () => { if (++n === 10) { doll(0x80007629, 100.5, 21); doll(0x8000762c, 101.5, 22); } });
    expect(r?.message ?? '').not.toMatch(/not awake yet/);
  });

  it('a pack by your way that the leader, 30 m on, is far from still stops it short', async () => {
    host.add({ guid: BUL, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, cell: host.me.cell, x: 80, y: 50, z: 94 });
    // Three: with no routine, sleepers near your level are a pack only at 3+ (2026-10-18 21:32Z segment).
    doll(0x80007629, 97, 34); doll(0x8000762c, 98, 35); doll(0x8000762d, 97, 35);
    const r = await settle(api, host, (api.surface() as { follow: (t: string, o?: object) => Promise<AgentResult> }).follow('Claude Bulwark', { durationMs: 20_000 }), 30_000);
    expect(r?.message).toMatch(/^stopped following Claude Bulwark, [\d.]+ m from them: going on brings you within 18 m of 3 monsters not awake yet/);
  });
});

describe('5. a walk of yours with your routine running stops only for a pack, a hurting caster or a heavy hitter', () => {
  const ME = 0x50000001;
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host.me.level = 48; host.me.health = { current: 187, max: 187 };
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  const walk = (): Promise<AgentResult> => (api.surface() as { walkTo: (t: string, o?: object) => Promise<AgentResult> }).walkTo('0.0N, 0.0E', {}) as Promise<AgentResult>;
  // Chasers 20 m east coming at you, a step nearer each tick.
  const chasers = (n: number, name = 'Marionette', level = 26): number[] => {
    const gs: number[] = [];
    for (let i = 0; i < n; i++) {
      const g = 0x80006a00 + i;
      host.add({ guid: g, name, itemType: 0x10, objectDescFlags: 0x10, x: 100 + i, y: 20 + i * 2, level, seeks: { guid: ME, kind: 'move' } });
      gs.push(g);
    }
    return gs;
  };
  const chase = (gs: number[]) => () => { for (const g of gs) { const o = host.objs.get(g)!; const dx = host.me.x - o.x, dy = host.me.y - o.y, d = Math.hypot(dx, dy); if (d > 3) { o.x += (dx / d) * 0.3; o.y += (dy / d) * 0.3; } } };
  const goWest = (): void => { host.add({ guid: 0x80000042, name: 'Chest', itemType: 0x200, x: 20, y: 20 }); };

  const walkTo = (): Promise<AgentResult> => (api.surface() as { walkTo: (t: string, o?: object) => Promise<AgentResult> }).walkTo('Chest', {}) as Promise<AgentResult>;

  // 2026-10-18 21:32Z segment: with no routine too, a chaser well below you that has done nothing that hurt walks on
  // (Arcanist, L53, stopped twice in a minute by Dark Marionettes L35); one near your level still stops the walk.
  it('no routine: a single mild Marionette L26 is walked on past', async () => {
    goWest();
    const gs = chasers(1);
    const r = await settle(api, host, walkTo(), 40_000, chase(gs));
    expect(r?.message).toMatch(/^arrived/);
    expect(r?.message).toMatch(/passed a mild chaser \(Marionette: well below you, nothing that hurt\)/);
  });
  it('no routine: one near your level (Innocuous Doll L46, him L48) stops the walk, as before', async () => {
    goWest();
    const gs2 = chasers(1, 'Innocuous Doll', 46);
    const r2 = await settle(api, host, walkTo(), 15_000, chase(gs2));
    expect(r2?.message).toMatch(/^stopped [\d.]+ m short: Innocuous Doll #80006a00 \(level 46\) is coming at you/);
    expect(r2?.message).not.toMatch(/routine/);
  });

  it('your fight routine running: a single mild Marionette is walked on past, and the answer says so', async () => {
    api.routine.start(fightProfile());
    goWest();
    const p = walkTo();
    const gs = chasers(1);
    const r = await settle(api, host, p, 40_000, chase(gs));
    expect(r?.message).toMatch(/^arrived/);
    expect(r?.message).toMatch(/passed a mild chaser \(Marionette: well below you, nothing that hurt; your routine takes them\)/);
  });

  // Three near his level (Marionettes L26 against his 48 no longer count: verify-stream-reports-2026-10-18-0717.ts, 5).
  it('…three coming at once near your level are a pack: stopped, saying the rule', async () => {
    api.routine.start(fightProfile());
    goWest();
    const p = walkTo();
    const gs = chasers(3, 'Innocuous Doll', 46);
    const r = await settle(api, host, p, 15_000, chase(gs));
    expect(r?.message).toMatch(/^stopped [\d.]+ m short: Innocuous Doll #80006a0\d \(level 46\) is coming at you/);
    expect(r?.message).toMatch(/\(a pack: 3 near your level; your routine "hunt" takes mild ones\)\./);
  });

  it('…one whose kind\'s spell took a tenth of your health stops it (a debuff-only caster doesn\'t)', async () => {
    api.routine.start(fightProfile());
    goWest();
    // Pristine Dolls were seen casting Harm Other III for 22 (12% of 187); Marionettes only Feeblemind (no health taken).
    host.add({ guid: 0x80007c4e, name: 'Pristine Doll', itemType: 0x10, objectDescFlags: 0x10, x: 120, y: 60, level: 60 });
    host.add({ guid: 0x80007c4f, name: 'Marionette', itemType: 0x10, objectDescFlags: 0x10, x: 120, y: 64, level: 26 });
    api.pushChat('You lose 22 points of health due to Pristine Doll casting Harm Other III on you');
    api.pushChat('Marionette cast Feeblemind Other II on you');
    host.objs.delete(0x80007c4e); host.objs.delete(0x80007c4f);
    const p = walkTo();
    const gs = chasers(1, 'Pristine Doll', 47);
    const r = await settle(api, host, p, 15_000, chase(gs));
    expect(r?.message).toMatch(/^stopped [\d.]+ m short: Pristine Doll #80006a00 \(level 47\) is coming at you/);
    expect(r?.message).toMatch(/\(its kind's Harm Other III took 22 of your 187 health; your routine "hunt" takes mild ones\)\./);
  });

  it('stop_on_aggro=false and flee walk on as before, routine or not', async () => {
    goWest();
    const gs = chasers(3);
    const r = await settle(api, host, (api.surface() as { walkTo: (t: string, o?: object) => Promise<AgentResult> }).walkTo('Chest', { stopOnAggro: false }) as Promise<AgentResult>, 40_000, chase(gs));
    expect(r?.message).toMatch(/^arrived/);
  });
});

describe('7. a held chaser loses "AIMED AT YOU BUT NOT REACHING YOU" once things change, and says so when it comes', () => {
  const ME = 0x50000001, M = 0x80006a48;
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host.me.cell = 0xa9b40105; host.cellSealed = () => true; host.me.level = 48;
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  const stuck = (): boolean | undefined => api.observe().nearby.find((o) => o.guid === M)?.comingAtYouStuck;

  // 2026-10-18 0819 (verify-stream-reports-2026-10-18-0819.ts, item 3): your moving no longer drops the hold (a fight's
  // footwork kept three wall-bound Marionettes "COMING AT YOU" for 15 minutes); its own coming does, at once.
  it('held behind a wall; you move 5 m: still held; it then comes 3 m nearer: an aggro event at once', () => {
    host.add({ guid: M, name: 'Marionette', itemType: 0x10, objectDescFlags: 0x10, cell: host.me.cell, x: 96, y: 20, z: 94, level: 26, seeks: { guid: ME, kind: 'move' } });
    run(api, host, 25_000, { physics: false });
    expect(stuck()).toBe(true);
    const seq0 = api.observe().seq;
    // Bulwark runs on toward a Pristine past it (5 m east).
    host.me.x = 85;
    run(api, host, 500, { physics: false });
    expect(stuck()).toBe(true);
    // It finds its way now: 3 m nearer.
    host.objs.get(M)!.x = 93;
    run(api, host, 500, { physics: false });
    const evs = api.eventsSince(seq0);
    expect(evs.some((e) => e.type === 'aggro' && /Marionette #80006a48 \(level 26\) is coming at you/.test(e.text))).toBe(true);
  });

  it('held a storey up; it comes down onto your floor: an aggro event at once, no 3 m first', () => {
    host.add({ guid: M, name: 'Marionette', itemType: 0x10, objectDescFlags: 0x10, cell: host.me.cell, x: 92, y: 20, z: 100, level: 26, seeks: { guid: ME, kind: 'move' } });
    run(api, host, 10_000, { physics: false });
    expect(stuck()).toBe(true);
    const seq0 = api.observe().seq;
    Object.assign(host.objs.get(M)!, { z: 94, x: 93 });
    run(api, host, 500, { physics: false });
    expect(stuck()).toBeFalsy();
    expect(api.eventsSince(seq0).some((e) => e.type === 'aggro' && /is coming at you/.test(e.text))).toBe(true);
  });

  it('still behind its wall with you standing where you were: held, and no new aggro', () => {
    host.add({ guid: M, name: 'Marionette', itemType: 0x10, objectDescFlags: 0x10, cell: host.me.cell, x: 96, y: 20, z: 94, level: 26, seeks: { guid: ME, kind: 'move' } });
    run(api, host, 25_000, { physics: false });
    const seq0 = api.observe().seq;
    host.me.x = 81; // a step
    run(api, host, 20_000, { physics: false });
    expect(stuck()).toBe(true);
    expect(api.eventsSince(seq0).filter((e) => e.type === 'aggro' && /is coming at you/.test(e.text))).toEqual([]);
  });
});

describe('8. a spell named by its skill points to the line retail calls it', () => {
  const known: AgentSpell[] = [
    { id: 243, name: 'Invulnerability Other V', school: 'Creature Enchantment', level: 5, skill: { name: 'Melee Defense', raises: true } },
    { id: 244, name: 'Invulnerability Self V', school: 'Creature Enchantment', level: 5, self: true, skill: { name: 'Melee Defense', raises: true } },
    { id: 245, name: 'Invulnerability Other IV', school: 'Creature Enchantment', level: 4, skill: { name: 'Melee Defense', raises: true } },
    { id: 1, name: 'Strength Other IV', school: 'Creature Enchantment', level: 4 },
  ];

  it('spellSkillMod reads the description', () => {
    expect(spellSkillMod("Increases the target's Melee Defense skill by 30 points.")).toEqual({ skill: 'Melee Defense', raises: true });
    expect(spellSkillMod("Decreases the target's Missile Defense skill by 10 points.")).toEqual({ skill: 'Missile Defense', raises: false });
    expect(spellSkillMod('Increases the target\'s Strength by 30 points.')).toBeNull();
  });

  it('"Melee Defense Other" at a fellow: Invulnerability Other V (was "you don\'t know a spell matching")', async () => {
    const host = new FakeHost();
    host.spells = () => known;
    host.add({ guid: 0x500000a4, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, x: 82, y: 20 });
    const api = new AgentApi(host);
    const r = await api.cast('Melee Defense Other', 'Claude Bulwark');
    expect(r).toMatchObject({ ok: false });
    expect(r.message).toBe('you don\'t know a spell matching "Melee Defense Other": Melee Defense spells are called Invulnerability: Invulnerability Other V');
    expect(skillLineHint(known, 'Melee Defense Self', null)).toBe('Melee Defense spells are called Invulnerability: Invulnerability Self V');
    expect(skillLineHint(known, 'Melee Defence Other IV', 'other')).toBe('Melee Defense spells are called Invulnerability: Invulnerability Other IV');
    expect(skillLineHint(known, 'Melee Defense Other VII', 'other')).toBe('Melee Defense spells are called Invulnerability: Invulnerability Other V (the highest of yours; you know no level 7 of it)');
    // A skill you know none of: the table's line, said so.
    expect(skillLineHint(known, 'Missile Defense Other', 'other', (k) => (skillKey(k) === 'missile defense' ? { skill: 'Missile Defense', line: 'Impregnability' } : null))).toBe('Missile Defense spells are called Impregnability, and you know none of them (ac_spells lists yours)');
    // A line named as its skill needs no pointing to; nor does a name that is no skill's.
    expect(skillLineHint(known, 'Strength Other', 'other')).toBeNull();
    expect(skillLineHint(known, 'Flame Bolt', null)).toBeNull();
  });

  describe.skipIf(!haveDat)('the sweep over the real spell table (portal 0x0E00000E)', () => {
    let table: SpellTable;
    beforeAll(() => { table = new SpellTable(openDat(DAT_PATHS.portal).getReader(0x0e00000e)); });

    it('every skill whose castable line is named otherwise, by the table', () => {
      const lines = skillSpellLines(table.spells.values());
      const line = (k: string): string | undefined => lines.get(skillKey(k))?.line;
      expect(line('Melee Defense')).toBe('Invulnerability');
      expect(line('Missile Defense')).toBe('Impregnability');
      expect(line('Magic Defense')).toBe('Magic Resistance');
      expect(line('Run')).toBe('Sprint');
      expect(line('Jump')).toBe('Jumping Mastery');
      expect(line('Loyalty')).toBe('Fealty');
      expect(line('Heavy Weapons')).toBe('Heavy Weapon Mastery');
      expect(line('Arcane Lore')).toBe('Arcane Enlightenment');
      expect(line('Assess Monster')).toBe('Monster Attunement');
      expect(line('Item Enchantment')).toBe('Item Enchantment Mastery');
      expect(line('Salvaging')).toBe('Arcanum Salvaging');
      // Every entry is a line the table casts as Self and Other, levelled.
      for (const { line: l } of lines.values()) expect([...table.spells.values()].some((sp) => sp.name.startsWith(`${l} Other`) || sp.name.startsWith(`${l} Self`))).toBe(true);
    });

    it('Arcanist\'s book from the table: "Melee Defense Other" → Invulnerability Other V', () => {
      const book: AgentSpell[] = [...table.spells.entries()].filter(([, sp]) => /^(Invulnerability (Other|Self) (I|II|III|IV|V)|Flame Bolt V)$/.test(sp.name)).map(([id, sp]) => {
        const m = spellSkillMod(sp.desc);
        return { id, name: sp.name, school: 'Creature Enchantment', ...(m ? { skill: { name: m.skill, raises: m.raises } } : {}) };
      });
      expect(skillLineHint(book, 'Melee Defense Other', 'other')).toBe('Melee Defense spells are called Invulnerability: Invulnerability Other V');
    });
  });
});

describe('9. the attack: no swing at a target that died meanwhile, and its death is told after a re-attack', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('the stance switch\'s delayed swing is not sent at a target gone or dying (was "You must select a valid combat target")', () => {
    const swings: number[] = [];
    let alive = true;
    const t: Array<() => void> = [];
    const a = createHostAttack({
      inAttackStance: () => false, autoEnterPlan: () => ({ sendAttack: true, mode: 2 }), changeCombatMode: () => {},
      swing: (g) => { swings.push(g); }, requestPending: () => false, now: () => 0, schedule: (fn) => { t.push(fn); }, canSwing: () => alive,
    });
    a.attack(0x80004f35, 0.6, 'medium');
    alive = false;
    t.shift()!();
    expect(swings).toEqual([]);
    expect(a.pending()).toBe(false);
    a.attack(0x80004f70, 0.6, 'medium');
    alive = true;
    t.shift()!();
    expect(swings).toEqual([0x80004f70]);
  });

  it('a second attack on the same target (the routine resuming after your hand-over) still raises target-died when it dies', async () => {
    const host = new FakeHost();
    const api = new AgentApi(host);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const G = 0x80004f35;
    host.add({ guid: G, name: 'Pristine Doll', itemType: 0x10, objectDescFlags: 0x10, x: 81, y: 21, level: 60 });
    expect(api.attack(G).ok).toBe(true);
    run(api, host, 2000);
    expect(api.attack(G, { power: 0.6 }).ok).toBe(true);
    run(api, host, 2000);
    const seq0 = api.observe().seq;
    host.dying.add(G);
    run(api, host, 500);
    expect(api.eventsSince(seq0).map((e) => `${e.type}: ${e.text}`)).toContainEqual(expect.stringMatching(/^target-died: Pristine Doll #80004f35 died/));
  });

  it('a target no longer attackable mid-fight gets no new attack request', () => {
    const host = new FakeHost();
    const api = new AgentApi(host);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const G = 0x80004f36;
    host.add({ guid: G, name: 'Pristine Doll', itemType: 0x10, objectDescFlags: 0x10, x: 81, y: 21, level: 60 });
    expect(api.attack(G).ok).toBe(true);
    run(api, host, 500);
    const sends = (): number => host.sent.filter((x) => x.startsWith('attack 80004f36')).length;
    expect(sends()).toBe(1);
    host.pending = false;
    host.objs.get(G)!.objectDescFlags = 0; // dead on the server's side: no longer attackable
    run(api, host, 5000);
    expect(sends()).toBe(1);
  });
});
