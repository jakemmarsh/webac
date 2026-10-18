/**
 * Stream reports, 2026-10-18 12:24–13:25Z (build e2860914, which had 914c301d's chord reports): Claude Arcanist (mage)
 * and Claude Bulwark (soldier) in Aerbax Laboratory 0x029E. Reports stream/reports/{mage-2026-10-18T13-25-30-211Z,
 * soldier-2026-10-18T13-25-30-950Z}-seg1.md; page traces mage.log / soldier.log.
 *
 * 1. REPEAT CLASS (dfa53b46, 914c301d, 2994488e): Arcanist's `follow target="Claude Bulwark"` took him through Aerbax
 *    Haven #7029e002 (0x029E0119) into 0x029F017E at 13:11:11.775Z. This time it was the BODY, not the server's chord:
 *    mage.log 13:11:11.754Z "walk: 1.4 m from Aerbax Haven #7029e002 and heading nearer it; holding back (1)", inside
 *    the portal's 1.84 m touch, 21 ms before ITeleported. The follow's legs ran south down the corridor to (434.0,
 *    29701.0), 4.9 m short of the portal's middle (434, 29696), and the walk steers only at its looks: at a run
 *    (~11 m/s) a look 0.3 s or more after the last carries the body 3+ m past a leg's end along its heading, here into
 *    the portal, before the walk turns it. Reproduced below on the cell DAT with Bulwark's own path. The fix is one
 *    central guard (AgentApi's portal sentinel) that every agent movement passes: whatever task or tool holds the keys,
 *    the stride the body could run before the next look is kept out of every portal it wasn't sent into (walk instead
 *    of run, else let go of the keys), and the body's place is reported at each bend near one. A player's own keys are
 *    never touched.
 * 2. "out of sight" at 0 m: Bulwark's stay_with walk set off 18 s after his own arrival in the Laboratory while Arcanist
 *    was still in portal space (mage.chat.log: "Using the Aerbax Laboratory" 13:12:39.5Z, placed 13:12:48Z), and it
 *    stopped at once. The 0 m observe came 25 s later. Now a walk waits up to 20 s for a fellow not placed yet after a
 *    portal, and the fellows line says "not placed here yet".
 * 3. Two fizzles at "98%": checked, no fault. ACE GetCastingPreCheckStatus rolls SkillCheck.GetMagicSkillChance(Current
 *    skill, spell.Power) = 1 − 1/(1 + e^(0.07·(256 − 200))) = 98.05%, the same curve and numbers as ours; the segment had
 *    32 Item Enchantment casts with 2 fizzles (12:43:31Z Lightning Bane V, 13:12:50Z Acid Bane V, half an hour apart),
 *    and two or more fizzles in 32 casts at 1.95% each happens about one segment in eight.
 * 4. The leash refusal of a monster aimed at a fellow but stuck behind a wall now says it is stuck, and whether a walk
 *    (so a far=true run-up) gets to it at all.
 */
import { existsSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getClientRunRate } from '@ac/shared';
import { AgentApi, compassToYaw } from '../packages/renderer/src/agent/AgentApi.ts';
import { formatObservation } from '../packages/renderer/src/agent/format.ts';
import { magicSkillChance } from '../packages/renderer/src/agent/magicChance.ts';
import { portalStepThreat } from '../packages/renderer/src/agent/portalAvoid.ts';
import type { AgentResult } from '../packages/renderer/src/agent/types.ts';
import { FakeHost, run } from './_harness/agentFake.ts';
import { DAT_PATHS, openDat } from './_harness/dat.ts';

const haveDat = existsSync(DAT_PATHS.cell) && existsSync(DAT_PATHS.portal);

describe.skipIf(!haveDat)('1. follow behind Bulwark past Aerbax Haven #7029e002: the body and the server\'s line keep out of it (0x029E)', () => {
  const LB = 0x029e0000;
  const C = (n: number): number => (LB | n) >>> 0;
  // Aerbax Haven #7029e002 in 0x029E0119 at (50, −640, −18.0) (ACE-World landblock_instance), Setup 0x020001B3: its
  // collision sphere 1.357 m plus the body's 0.48 m is where the server's line teleports you.
  const AERBAX = 0x7029e002;
  const PORTAL = { x: 50, y: -640, z: -17.995 };
  const TOUCH_M = 1.357 + 0.48;
  const BUL = 0x500000a4;
  // Bulwark's walk to the Surface portal (soldier.log 13:11:02.8–13:11:11Z, global − (384, 30336)), in seconds after
  // Arcanist's follow set off (13:11:04.15Z): down the corridor, the detour west of the portal, on south, then waiting.
  const PATH: Array<[number, number, number]> = [
    [-1.3, 50, -613.4], [2.5, 50, -625], [3.3, 50, -632.5], [3.5, 50, -635], [3.73, 50, -635], [4.5, 47, -639.4], [5.2, 47.6, -641.8],
    [5.7, 50, -644.8], [6.5, 50, -652.5], [6.85, 50, -655], [60, 50, -655],
  ];
  const leaderAt = (t: number): { x: number; y: number } => {
    for (let i = 1; i < PATH.length; i++) {
      const [t1, x1, y1] = PATH[i], [t0, x0, y0] = PATH[i - 1];
      if (t <= t1) { const k = Math.max(0, (t - t0) / (t1 - t0)); return { x: x0 + (x1 - x0) * k, y: y0 + (y1 - y0) * k }; }
    }
    return { x: 50, y: -655 };
  };
  let nav: Awaited<ReturnType<typeof import('./_harness/dungeonNav.ts')['dungeonNav']>>;
  beforeAll(async () => {
    const { dungeonNav } = await import('./_harness/dungeonNav.ts');
    nav = await dungeonNav(LB, { statics: true, jumpSkill: 191, runRate: getClientRunRate(0.5, 179) });
  }, 180_000);

  // Each pairing failed before the sentinel (the body came within 0.1–1.5 m of the portal's middle).
  for (const [lookMs, speed] of [[300, 3], [300, 2.5], [500, 3.5], [700, 2.5], [700, 3]] as const) {
    it(`the page looking every ${lookMs} ms, Arcanist running ${(4 * speed).toFixed(0)} m/s: never within the portal's touch, every reported line clear of it, Bulwark followed past it`, async () => {
      vi.useFakeTimers();
      try {
        const { DungeonHost } = await import('./_harness/dungeonWalk.js');
        class Fast extends DungeonHost { override physics(dt: number): void { super.physics(this.keys.has('ShiftLeft') ? dt : dt * speed); } }
        const host = new Fast(nav, { portal: openDat(DAT_PATHS.portal), cell: openDat(DAT_PATHS.cell) }, LB, { rooms: true });
        host.add({ guid: AERBAX, name: 'Aerbax Haven', itemType: 0x10000, objectDescFlags: 0x40000, cell: C(0x119), ...PORTAL });
        host.objectReach = (g) => (g === AERBAX ? 1.919 : 0);
        host.me = { ...host.me, name: 'Claude Arcanist', cell: C(0x119), x: 50, y: -611.9, z: -18, yaw: compassToYaw(180) };
        (host as unknown as { updateCell(): void }).updateCell();
        const bc = nav.col.findCellContaining(384 + 50, 30336 - 613.4, -17.5, host.me.cell);
        host.add({ guid: BUL, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, cell: (bc ?? host.me.cell) >>> 0, x: 50, y: -613.4, z: -18 });
        host.fellows = () => [{ guid: BUL, name: 'Claude Bulwark', health: { cur: 187, max: 187 }, stamina: { cur: 200, max: 278 }, mana: { cur: 97, max: 97 } }];
        // The server's view: one straight line from each reported spot to the next (the client's own cadence: each cell
        // change, else once a second; and the agent's reports).
        let last = null as { x: number; y: number; t: number; cell: number } | null;
        let chord = Infinity, body = Infinity;
        const send = (): void => {
          const me = host.me;
          if (last) {
            const dx = me.x - last.x, dy = me.y - last.y, l2 = dx * dx + dy * dy;
            const k = l2 > 0 ? Math.max(0, Math.min(1, ((PORTAL.x - last.x) * dx + (PORTAL.y - last.y) * dy) / l2)) : 0;
            chord = Math.min(chord, Math.hypot(last.x + dx * k - PORTAL.x, last.y + dy * k - PORTAL.y));
          }
          last = { x: me.x, y: me.y, t: host.t, cell: me.cell };
        };
        host.reportPosition = send;
        const api = new AgentApi(host);
        const log = console.log;
        const traces: string[] = [];
        console.log = (...a: unknown[]) => { traces.push(`${(host.t / 1000).toFixed(2)} ${a.join(' ')}`); };
        let r: AgentResult | null = null;
        try {
          void api.follow('Claude Bulwark', { durationMs: 12_000 }).then((x) => { r = x; });
          let since = 0;
          for (let t = 0; t < 16_000 && !r; t += 50) {
            host.t += 50;
            vi.advanceTimersByTime(50);
            const L = leaderAt(host.t / 1000), o = host.objs.get(BUL)!;
            o.x = L.x; o.y = L.y;
            host.physics(50);
            body = Math.min(body, Math.hypot(host.me.x - PORTAL.x, host.me.y - PORTAL.y));
            if (!last || last.cell !== host.me.cell || host.t - last.t > 1000) send();
            since += 50;
            if (since >= lookMs) { since = 0; api.tick(); }
            await Promise.resolve(); await Promise.resolve();
          }
        } finally { console.log = log; host.dispose(); }
        const why = `${JSON.stringify(r)}\n${traces.join('\n')}`;
        expect(body, why).toBeGreaterThan(TOUCH_M + 0.3);
        expect(chord, why).toBeGreaterThan(TOUCH_M);
        expect(r, why).not.toBeNull();
        expect(r!.message, why).toMatch(/^followed Claude Bulwark for 1\d s/);
        expect(r!.message, why).not.toMatch(/went through a portal/);
        // Past the portal: south of it, behind Bulwark.
        expect(host.me.y, why).toBeLessThan(PORTAL.y - 3);
      } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
    }, 120_000);
  }
});

describe('1. (no DAT) the portal sentinel: every agent movement, and only the agent\'s', () => {
  const PORTAL = 0x7029e002;
  let host: FakeHost;
  let api: AgentApi;
  const traces: string[] = [];
  beforeEach(() => {
    vi.useFakeTimers();
    traces.length = 0;
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { traces.push(a.join(' ')); });
    host = new FakeHost();
    // A portal 6 m due north of the body (the fake landblock's frame: y north), the body facing it.
    host.add({ guid: PORTAL, name: 'Aerbax Haven', itemType: 0x10000, objectDescFlags: 0x40000, cell: host.me.cell, x: 80, y: 26, z: 94 });
    host.objectReach = (g) => (g === PORTAL ? 1.357 : 0);
    host.me.yaw = compassToYaw(0);
    api = new AgentApi(host);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  const fromPortal = (): number => Math.hypot(host.me.x - 80, host.me.y - 26);
  const TOUCH = 1.357 + 0.48;

  it('portalStepThreat: a stride into the disk is one; along it, out of it, or a storey away is not', () => {
    const disk = { x: 0, y: 0, z: 0, r: 2 };
    expect(portalStepThreat({ x: 0, y: 5, z: 0 }, { x: 0, y: -1 }, 4, [disk])?.closest).toBeCloseTo(1, 5);
    expect(portalStepThreat({ x: 0, y: 5, z: 0 }, { x: 0, y: -1 }, 2.5, [disk])).toBeNull(); // stops 2.5 m out
    expect(portalStepThreat({ x: 2.5, y: 5, z: 0 }, { x: 0, y: -1 }, 10, [disk])).toBeNull(); // passes 2.5 m off
    expect(portalStepThreat({ x: 0, y: 1.5, z: 0 }, { x: 0, y: 1 }, 3, [disk])).toBeNull(); // inside, leaving
    expect(portalStepThreat({ x: 0, y: 5, z: 6 }, { x: 0, y: -1 }, 10, [disk])).toBeNull(); // a storey up
  });

  it('a hand move forward (ac_move) toward a portal stops outside its touch, and says why', async () => {
    const p = api.move('forward', 4);
    run(api, host, 4000);
    await vi.advanceTimersByTimeAsync(0);
    await p;
    expect(fromPortal()).toBeGreaterThan(TOUCH + 0.1);
    expect(fromPortal()).toBeLessThan(4);
    expect(traces.some((l) => /portal sentinel: [\d.]+ m from Aerbax Haven #7029e002, and the next [\d.]+ m .* let go of KeyW/.test(l)), traces.join('\n')).toBe(true);
  });

  it('a held motion (UB setmotion Forward, the routine\'s holdMove) is stopped the same way', () => {
    let closest = Infinity;
    const go = (ms: number): void => { for (let t = 0; t < ms; t += 100) { run(api, host, 100); closest = Math.min(closest, fromPortal()); } };
    api.holdMotion('Forward', true);
    go(3000);
    expect(closest).toBeGreaterThan(TOUCH + 0.1);
    api.holdMove('forward', true);
    go(3000);
    expect(closest).toBeGreaterThan(TOUCH + 0.1);
    expect(host.me.y).toBeLessThan(26);
  });

  it('a player\'s own key is never touched: W held by hand walks on into the portal', () => {
    host.key('KeyW', true); // the player's keyboard (main.ts), not the agent
    let closest = Infinity;
    for (let t = 0; t < 2500; t += 100) { run(api, host, 100); closest = Math.min(closest, fromPortal()); }
    expect(host.keys.has('KeyW')).toBe(true);
    expect(closest).toBeLessThan(0.5);
    expect(traces.some((l) => /portal sentinel/.test(l))).toBe(false);
  });

  it('a walk sent into the portal (a use\'s walk-in) still goes in', async () => {
    let r: AgentResult | null = null;
    void api.walkTo(PORTAL, { within: 0.5, enterPortal: true, timeoutMs: 20_000 }).then((x) => { r = x; });
    for (let t = 0; t < 10_000 && !r; t += 100) { run(api, host, 100); await vi.advanceTimersByTimeAsync(0); }
    expect(fromPortal()).toBeLessThan(TOUCH);
    expect(traces.some((l) => /portal sentinel/.test(l))).toBe(false);
  });

  it('walking past beside it (3 m off) is left alone, and the body\'s place is reported near it', () => {
    host.me.x = 83; host.me.y = 14;
    const reports: Array<{ x: number; y: number }> = [];
    host.reportPosition = () => { reports.push({ x: host.me.x, y: host.me.y }); };
    api.holdMove('forward', true);
    run(api, host, 5000);
    expect(host.me.y).toBeGreaterThan(30); // went on past it
    expect(traces.some((l) => /portal sentinel/.test(l))).toBe(false);
    expect(reports.length).toBeGreaterThan(0);
  });
});

describe('2. stay_with just after a portal: a fellow not placed yet is waited for, not "out of sight"', () => {
  const ARC = 0x500000a3;
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    host.me = { ...host.me, name: 'Claude Bulwark', guid: 0x500000a4, level: 49 };
    host.fellows = () => [{ guid: ARC, name: 'Claude Arcanist', health: { cur: 184, max: 184 }, stamina: { cur: 189, max: 250 }, mana: { cur: 330, max: 330 } }];
    api = new AgentApi(host);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  const arrive = (): void => {
    host.screenName = 'portal-space';
    run(api, host, 200, { physics: false });
    host.screenName = 'world';
    run(api, host, 200, { physics: false });
  };

  it('18 s after your own arrival, Arcanist placed beside you 8 s into the walk: the walk waits, then goes on with them', async () => {
    arrive();
    run(api, host, 18_000, { physics: false });
    expect(formatObservation(api.observe())).toMatch(/fellows: Claude Arcanist 100% HP, not placed here yet \(you came through a portal 18 s ago; they may still be in portal space, so give it a few seconds\)/);
    let r: AgentResult | null = null;
    void api.walkTo('60m north', { stayWith: 'Claude Arcanist' }).then((x) => { r = x; });
    for (let t = 0; t < 8000 && !r; t += 100) { run(api, host, 100); await vi.advanceTimersByTimeAsync(0); }
    expect(r).toBeNull();
    expect(host.me.y).toBeLessThan(21); // stood waiting
    host.add({ guid: ARC, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, x: host.me.x, y: host.me.y - 0.5, z: host.me.z });
    for (let t = 0; t < 3000 && !r; t += 100) { run(api, host, 100); await vi.advanceTimersByTimeAsync(0); }
    expect(host.me.y).toBeGreaterThan(25); // on its way
  });

  it('no portal lately: out of sight at once, as before', async () => {
    const r = await (async () => {
      let out: AgentResult | null = null;
      void api.walkTo('60m north', { stayWith: 'Claude Arcanist' }).then((x) => { out = x; });
      for (let t = 0; t < 2000 && !out; t += 100) { run(api, host, 100); await vi.advanceTimersByTimeAsync(0); }
      return out as AgentResult | null;
    })();
    expect(r?.message).toMatch(/^stopped [\d.]+ m short: Claude Arcanist is out of sight \(too far behind, or not a fellow\)/);
  });

  it('they never come: after 20 s of waiting it says out of sight', async () => {
    arrive();
    let r: AgentResult | null = null;
    void api.walkTo('60m north', { stayWith: 'Claude Arcanist' }).then((x) => { r = x; });
    for (let t = 0; t < 25_000 && !r; t += 100) { run(api, host, 100); await vi.advanceTimersByTimeAsync(0); }
    expect(r).not.toBeNull();
    expect(r!.message).toMatch(/is out of sight \(too far behind, or not a fellow\)/);
  });
});

describe('3. the fizzle chance is ACE\'s: 256 against 200', () => {
  it('SkillCheck.GetMagicSkillChance(256, 200) = 98.05%; two or more fizzles in 32 casts happen ~13% of the time', () => {
    const p = magicSkillChance(256, 200);
    expect(p).toBeCloseTo(1 - 1 / (1 + Math.exp(0.07 * 56)), 12);
    expect(p).toBeCloseTo(0.9805, 4);
    const q = 1 - p;
    const twoPlus = 1 - p ** 32 - 32 * q * p ** 31;
    expect(twoPlus).toBeGreaterThan(0.1);
    expect(twoPlus).toBeLessThan(0.16);
  });
});

describe('4. attack past the leash at a monster stuck on a fellow says it is stuck, and whether a walk gets there', () => {
  const ARC = 0x500000a3, DOLL = 0x80009f7e;
  it('an Innocuous Doll 20 m S, aimed at Arcanist and no nearer to her in 30 s: "stuck … a walk does get to it"', () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const host = new FakeHost();
      host.me = { ...host.me, name: 'Claude Bulwark', guid: 0x500000a4, level: 49, combatMode: 'melee' };
      host.add({ guid: ARC, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, x: 80, y: 22, z: 94 });
      host.fellows = () => [{ guid: ARC, name: 'Claude Arcanist', health: { cur: 184, max: 184 }, stamina: { cur: 1, max: 1 }, mana: { cur: 1, max: 1 } }];
      host.add({ guid: DOLL, name: 'Innocuous Doll', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 0, z: 94, level: 50, seeks: { guid: ARC, kind: 'move' } });
      const api = new AgentApi(host);
      run(api, host, 30_000, { physics: false });
      expect(formatObservation(api.observe())).toMatch(/AIMED AT THEM BUT NOT REACHING THEM: Innocuous Doll L50 #80009f7e/);
      const r = api.attack(DOLL);
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/^Innocuous Doll #80009f7e is 20 m S: running up to it leaves Claude Arcanist \(2 m from you now\) \d+ m behind, so no attack was started \(the fellow leash/);
      expect(r.message).toMatch(/It is aimed at Claude Arcanist but stuck: no nearer to them in [23]\d s \(a wall or no way round on its side\), so it won't come to you\. A walk does get to it \(by the way round\), so a far=true run-up is not pointless; it only leaves the fellow behind\. Go together \(ask in \/f\)/);
      expect(r.message).not.toMatch(/Let it come to you/);
      expect(r.message).toMatch(/or ac_attack target=#80009f7e far=true to go anyway$/);
    } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
  });
});
