/**
 * AGENT.play-reports-2026-10-12 — what Claude Arcanist (a mage) and Claude Bulwark (a soldier) hit playing together
 * around Holtburg and the river east of it (local end-of-retail ACE, 10:19–11:45 EDT), each driven through the real
 * AgentApi on the fake host (tests/_harness/agentFake.ts), the real planner, the real tool table and the daemon's
 * real call deadline: walks that paced for minutes toward places they couldn't reach, an attack that ran up to
 * nothing, stay_with deadlocks, no way to follow, lost buys, unlabelled buff services, loots refused in combat, a
 * dead target "not attackable", a CLI "fetch failed", gives refused without a reason, a misleading purse note and
 * side packs never listed. (The river itself: tests/verify-agent-river-holtburg.ts.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { planPath, type NavPoint } from '../packages/renderer/src/agent/navPlanner.ts';
import { TOOLS, TOOL_CALLER, type ToolCaller } from '../tools/ac-agent/tools.ts';
import { withCallDeadline } from '../tools/ac-agent/callDeadline.ts';
import { formatInventory, formatObservation } from '../packages/renderer/src/agent/format.ts';
import { FakeHost, HOLTBURG, run } from './_harness/agentFake.ts';

const OX = 0xa9 * 192, OY = 0xb4 * 192;
type Result = Awaited<ReturnType<AgentApi['walkTo']>>;

/** Run the page's ticks until the promise settles (or `ms` pass). */
async function settle<T>(api: AgentApi, host: FakeHost, p: Promise<T>, ms: number, each?: () => void): Promise<T | null> {
  let out: T | null = null;
  let done = false;
  void p.then((x) => { out = x; done = true; });
  for (let t = 0; t < ms && !done; t += 100) { each?.(); run(api, host, 100); await Promise.resolve(); await Promise.resolve(); }
  return out;
}

describe('the planner knows when the floor you stand on is closed in', () => {
  const probeIn = (inside: (x: number, y: number) => boolean) => (from: NavPoint, to: { x: number; y: number }): NavPoint => {
    const n = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 0.05));
    let last = from;
    for (let s = 1; s <= n; s++) {
      const p = { x: from.x + ((to.x - from.x) * s) / n, y: from.y + ((to.y - from.y) * s) / n, z: from.z };
      if (!inside(p.x, p.y)) return last;
      last = p;
    }
    return last;
  };
  it('a pen 10 m across: none, enclosed, its area; open ground that runs into the box: none, boxed, not enclosed', () => {
    const pen = planPath(probeIn((x, y) => Math.abs(x) < 5 && Math.abs(y) < 5), { x: 0, y: 0, z: 0 }, { x: 0, y: 40 }, { spacing: 1, margin: 20 });
    expect(pen).toMatchObject({ status: 'none', enclosed: true, boxed: false });
    if (pen.status === 'none') expect(pen.area).toBeGreaterThan(60);
    const wall = planPath(probeIn((_x, y) => y < 10), { x: 0, y: 0, z: 0 }, { x: 0, y: 40 }, { spacing: 1, margin: 5 });
    expect(wall).toMatchObject({ status: 'none', enclosed: false, boxed: true });
  });
});

describe('agent play reports 2026-10-12', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  describe('walks that can\'t get there answer promptly, and say what is in the way', () => {
    it('closed in (water, cliffs or walls all round): "no way out of here on foot" at once, not minutes of pacing', async () => {
      host.wall = (x, y) => Math.hypot(x - 80, y - 20) > 8;
      const r = await settle(api, host, api.walkTo('42.5N, 36.6E'), 20_000);
      expect(r).not.toBeNull();
      expect(r!.ok).toBe(false);
      expect(r!.message).toMatch(/no way out of here on foot\. The ground you can reach is closed in \(about \d+ m²\)/);
    });

    it('a spot out in open sea is refused before a step, and a stuck walk names the sea in the way', async () => {
      // A strait of open sea (landblocks all deep water) from local x 104 to 112: the collision stops you at it.
      host.navTerrain = (x: number) => ({ sea: x - OX > 104 && x - OX < 112, steep: false, wade: 0, height: 94 });
      const sea = await api.walkTo('28m east');
      expect(sea).toMatchObject({ ok: false });
      expect(sea.message).toMatch(/out in open sea \(a landblock of deep water: no one can wade it, and AC has no swimming\)\. Pick a point on land/);
      expect(host.keys.has('KeyW')).toBe(false);
      host.wall = (x) => x > 104 && x < 112;
      const r = await settle(api, host, api.walkTo('35m east', { timeoutMs: 120_000 }), 120_000);
      expect(r!.ok).toBe(false);
      expect(r!.message).toMatch(/in the way: open sea \d+ m E \(a landblock of deep water/);
    });

    it('a walk going round in circles (a bay with no way out north) stops and says so, well before its time limit', async () => {
      // A bay 100 m wide: walls north at y 60 and down both sides, the goal 300 m north beyond it.
      host.wall = (x, y) => (y > 60 && y < 64 && x > 20 && x < 140) || ((x > 16 && x < 20) || (x > 140 && x < 144)) && y > -200 && y < 64;
      const r = await settle(api, host, api.walkTo('300m north', { timeoutMs: 600_000 }), 600_000);
      expect(r).not.toBeNull();
      expect(r!.ok).toBe(false);
      expect(r!.message).toMatch(/the walk went round in circles \(back where it was \d+ s ago, no nearer\), so no walkable way was found/);
      expect(host.t).toBeLessThan(90_000);
    });

    it('an attack whose run-up finds no way says so as target-lost, not 40 s of nothing', async () => {
      host.wall = (x, y) => Math.hypot(x - 80, y - 20) > 6;
      host.add({ guid: 0x80006002, name: 'Young Banderling', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 60 });
      const r = api.attack('Young Banderling');
      expect(r.message).toMatch(/running up to Young Banderling/);
      const lost = api.waitFor({ types: ['target-lost'] }, 60_000);
      const evs = await settle(api, host, lost, 30_000);
      expect(evs![0].text).toMatch(/Young Banderling #80006002: no attack, you couldn't get to it \(stuck/);
      expect(host.sent.some((s) => s.startsWith('attack '))).toBe(false);
    });
  });

  describe('keeping the pair together', () => {
    const BUL = 0x50000004;
    const fellow = (x: number, y: number): void => {
      host.add({ guid: BUL, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, x, y });
      host.fellows = () => [{ guid: BUL, name: 'Claude Bulwark', health: { cur: 50, max: 50 }, stamina: { cur: 50, max: 50 }, mana: { cur: 10, max: 10 } }];
    };
    it('stay_with never waits for a fellow AHEAD of you (both walking with stay_with stood waiting for each other)', async () => {
      fellow(80, 45); // 25 m north, where you are going
      const r = await settle(api, host, api.walkTo('40m north', { within: 1, stayWith: 'Claude Bulwark' }), 20_000);
      expect(r).toMatchObject({ ok: true });
      expect(r!.message).not.toMatch(/waited/);
    });
    it('stay_with: a fellow behind who stands still is named, with where they are, after 12 s, not 45', async () => {
      fellow(80, 2);
      const r = await settle(api, host, api.walkTo('60m north', { within: 1, stayWith: 'Claude Bulwark' }), 60_000);
      expect(r!.ok).toBe(false);
      expect(r!.message).toMatch(/Claude Bulwark is 1\d m S of you and hasn't moved for 1[23] s \(fighting, busy, stuck or waiting for you\?\)/);
      expect(host.t).toBeLessThan(25_000);
    });
    it('stay_with: a fellow behind who heads off elsewhere is named, with where they are now', async () => {
      fellow(80, 2);
      const r = await settle(api, host, api.walkTo('60m north', { within: 1, stayWith: 'Claude Bulwark' }), 60_000, () => {
        const o = host.objs.get(BUL)!;
        if (host.t > 4000) o.y -= 0.4; // walking off south, 4 m/s
      });
      expect(r!.ok).toBe(false);
      expect(r!.message).toMatch(/to wait for Claude Bulwark, but they are going elsewhere: now \d+ m S of you, \d+ m farther from where you're going/);
    });
    it('follow: keeps within reach of a moving leader, stands when they stop, and ends after its time', async () => {
      fellow(80, 40);
      const r = await settle(api, host, api.follow('Claude Bulwark', { within: 4, durationMs: 40_000 }), 60_000, () => {
        const o = host.objs.get(BUL)!;
        if (host.t < 15_000) o.y += 0.3; // 3 m/s north for 15 s, then stands
      });
      expect(r).toMatchObject({ ok: true });
      expect(r!.message).toMatch(/^followed Claude Bulwark for 4\d s; they are \d m N of you/);
      expect(Math.hypot(host.me.x - 80, host.me.y - host.objs.get(BUL)!.y)).toBeLessThan(4 + 3.5);
      expect(host.keys.has('KeyW')).toBe(false);
    });
    it('follow: a leader out of sight for 10 s ends it, saying where they were last seen; ac_stop_moving ends it too', async () => {
      fellow(80, 40);
      const p = api.follow('Claude Bulwark', { durationMs: 120_000 });
      await settle(api, host, Promise.resolve(), 3000);
      host.objs.get(BUL)!.lost = true;
      const r = await settle(api, host, p, 20_000);
      expect(r!.message).toMatch(/stopped following: Claude Bulwark went out of sight, last seen \d+ m N of you/);
      host.objs.get(BUL)!.lost = false;
      const q = api.follow('Claude Bulwark', { durationMs: 120_000 });
      await settle(api, host, Promise.resolve(), 2000);
      api.stopMoving();
      expect((await q).message).toMatch(/following Claude Bulwark: interrupted \(stopped\)/);
    });
    it('follow: being hit ends it (a fresh decision while the tank walks on); flee=true keeps following through the hits until beside the leader (Arcanist, 2026-10-12; 2026-10-17)', async () => {
      const SERVANT = 0x80003c31;
      const run = async (flee: boolean) => {
        host.me.x = 80; host.me.y = 0;
        fellow(80, 40);
        host.add({ guid: SERVANT, name: 'Drudge Servant', itemType: 0x10, objectDescFlags: 0x10, x: 81.5, y: 0 });
        const t0 = host.t;
        let hit = t0;
        const r = await settle(api, host, api.follow('Claude Bulwark', { within: 4, durationMs: 30_000, ...(flee ? { flee: true } : {}) }), 40_000, () => {
          // The servant keeps up at your side (not behind, which walking on already leaves), hitting every second.
          const o = host.objs.get(SERVANT)!; o.x = host.me.x + 1.5; o.y = host.me.y;
          if (host.t - hit >= 1000) { hit = host.t; api.pushChat('The Drudge Servant hits your leg for 6 points of bludgeoning damage!', 0x15); }
        });
        return { r: r!, took: host.t - t0 };
      };
      const stopped = await run(false);
      expect(stopped.r.message).toMatch(/under attack/);
      expect(stopped.took).toBeLessThan(15_000);
      // flee=true runs on through the hits all the way to the leader, then (beside them: getting there is done) the next
      // hit ends it for a fresh decision (stream 2026-10-17 18:03:58Z / 18:42:21Z: follows beside a mobbed leader).
      const kept = await run(true);
      expect(kept.r.message).toMatch(/^stopped following Claude Bulwark: you're beside them/);
      expect(kept.r.message).toMatch(/hit on the way \(The Drudge Servant hits your leg/);
      expect(Math.hypot(host.me.x - 80, host.me.y - 40)).toBeLessThan(4 + 3.5);
    });
    it('follow: a leader walking away as fast as you never reads as a stall (live: "stuck 85.6 m short" after covering 90 m)', async () => {
      host.me.x = 80; host.me.y = 0;
      fellow(80, 30);
      const r = await settle(api, host, api.follow('Claude Bulwark', { within: 4, durationMs: 40_000 }), 60_000, () => {
        // At your own run speed (4 m/s in the fake), away from you, for 30 s.
        if (host.t < 30_000) host.objs.get(BUL)!.y += 0.4;
      });
      expect(r!.message).not.toMatch(/stuck|stall/);
      expect(r!.message).toMatch(/^followed Claude Bulwark for (39|40) s/);
      expect(host.me.y).toBeGreaterThan(100);
    });
    it('the ac_follow tool passes flee=true through', async () => {
      const seen: unknown[][] = [];
      const caller: ToolCaller = { notice: null, call: async <T,>(m: string, a?: unknown[]) => { seen.push([m, ...(a ?? [])]); return { ok: true, message: 'followed' } as T; } };
      const tool = TOOLS.find((t) => t.name === 'ac_follow')!;
      await TOOL_CALLER.run(caller, () => tool.run({ target: 'Claude Bulwark', flee: true }));
      expect(seen[0]).toEqual(['follow', 'Claude Bulwark', { within: null, durationMs: null, flee: true }]);
    });
    it('the ac_follow tool passes within and duration through', async () => {
      const seen: unknown[][] = [];
      const caller: ToolCaller = { notice: null, call: async <T,>(m: string, a?: unknown[]) => { seen.push([m, ...(a ?? [])]); return { ok: true, message: 'followed' } as T; } };
      const tool = TOOLS.find((t) => t.name === 'ac_follow')!;
      await TOOL_CALLER.run(caller, () => tool.run({ target: 'Claude Bulwark', within: 6, duration_s: 90 }));
      expect(seen[0]).toEqual(['follow', 'Claude Bulwark', { within: 6, durationMs: 90_000 }]);
    });
  });

  describe('the Healer\'s buff services', () => {
    const HEALER = 0x7a9b4027;
    const services = (): void => {
      host.me.pyreals = 20_000;
      host.vendorOpen = { name: 'Thelnoth Cort the Healer', guid: HEALER, currency: 'Pyreals', items: [
        { guid: 0x80007001, name: 'Strength Other IV', price: 2000, service: true },
        { guid: 0x80007002, name: 'Focus Other IV', price: 2000, service: true },
        { guid: 0x80007003, name: 'Adept Healing Kit', price: 50 },
      ] } as never;
    };
    it('vendor labels a service (ItemType TYPE_SERVICE) as one the vendor casts on you, not a scroll', () => {
      services();
      const text = api.vendorView().message;
      expect(text).toMatch(/Strength Other IV {2}2000 {2}\(service: Thelnoth Cort the Healer casts it on you when you buy it; not a scroll\)/);
      expect(text).toMatch(/Adept Healing Kit {2}50$/m);
    });
    it('back-to-back buys go one at a time: the second waits for the first cast, and each says what happened', async () => {
      services();
      // ACE Vendor.ApplyService: busy casting for ~3 s after a sale; a service bought meanwhile is refused.
      let busyUntil = 0;
      host.vendorBuy = (g: number) => {
        host.sent.push(`buy ${g.toString(16)}`);
        const it = host.vendorOpen!.items.find((i) => i.guid === g)!;
        if (host.t < busyUntil) { api.pushChat('Thelnoth Cort the Healer is too busy to accept gifts right now.'); return true; }
        setTimeout(() => { host.me.pyreals! -= it.price; }, 300);
        setTimeout(() => api.pushChat(`Thelnoth Cort the Healer cast ${it.name} on you, increasing your attribute.`), 1500);
        busyUntil = host.t + 3000;
        return true;
      };
      const a = api.buyReported('Strength Other IV');
      const b = api.buyReported('Focus Other IV');
      const ra = await settle(api, host, a, 20_000);
      const rb = await settle(api, host, b, 20_000);
      expect(ra).toMatchObject({ ok: true });
      expect(ra!.message).toMatch(/^bought Strength Other IV for 2000 pyreals: Thelnoth Cort the Healer casts it on you/);
      expect(rb).toMatchObject({ ok: true });
      expect(rb!.message).toMatch(/^bought Focus Other IV for 2000 pyreals/);
      expect(host.me.pyreals).toBe(16_000);
    });
    it('a service buy the busy vendor silently ignores is sent once more 3 s later (live, Thelnoth)', async () => {
      services();
      let busyUntil = 0;
      host.vendorBuy = (g: number) => {
        host.sent.push(`buy ${g.toString(16)}`);
        const it = host.vendorOpen!.items.find((i) => i.guid === g)!;
        if (host.t < busyUntil) return true; // no answer at all while it is still casting
        setTimeout(() => { host.me.pyreals! -= it.price; }, 300);
        setTimeout(() => api.pushChat(`Thelnoth Cort the Healer cast ${it.name} on you, increasing your attribute.`), 1500);
        busyUntil = host.t + 13_000; // longer than the settle after the first cast
        return true;
      };
      const a = api.buyReported('Strength Other IV');
      const b = api.buyReported('Focus Other IV');
      await settle(api, host, a, 20_000);
      const rb = await settle(api, host, b, 30_000);
      expect(host.sent.filter((x) => x === 'buy 80007002')).toHaveLength(2);
      expect(rb).toMatchObject({ ok: true });
      expect(host.me.pyreals).toBe(16_000);
    });
    it('a buy the server refuses says it was not bought and why', async () => {
      services();
      host.vendorBuy = (g: number) => { host.sent.push(`buy ${g.toString(16)}`); setTimeout(() => api.pushChat('Thelnoth Cort the Healer is too busy to accept gifts right now.'), 200); return true; };
      const r = await settle(api, host, api.buyReported('Focus Other IV'), 20_000);
      expect(r).toMatchObject({ ok: false });
      expect(r!.message).toMatch(/Focus Other IV was not bought \(no money taken\)\n {2}Thelnoth Cort the Healer is too busy to accept gifts right now\./);
    });
  });

  it('loot right after a kill waits for peace mode to take before the Use, and Uses again if nothing opened', async () => {
    host.me.combatMode = 'melee';
    host.add({ guid: 0x80000070, name: 'Corpse of Young Mosswart', objectDescFlags: 0x2000, x: 82, y: 23 });
    // Mid-swing: the peace request waits for a ready position (pendingCombatMode) and lands 3 s later.
    host.setCombatMode = (m: string) => { host.sent.push(`mode ${m}`); setTimeout(() => { host.me.combatMode = m as never; }, 3000); };
    let uses = 0;
    host.use = (g: number) => {
      host.sent.push(`use ${g.toString(16)}`);
      // A Use while the stance is still changing: the server's walk is cut short, nothing opens. The first Use
      // after peace is cut short too (the mode change landing on it); the second opens it.
      if (host.me.combatMode === 'peace' && ++uses >= 2) host.container = { guid: g, items: [{ guid: 0x80000072, name: 'Drudge Charm' }] };
      return true;
    };
    host.pickUp = (g: number) => { host.sent.push(`pickup ${g.toString(16)}`); host.inv.push({ guid: g, name: 'Drudge Charm', where: 'main pack' }); return true; };
    const r = await settle(api, host, api.loot(null, null), 30_000);
    expect(host.sent.filter((x) => x === 'use 80000070').length).toBe(2);
    expect(host.sent.indexOf('use 80000070')).toBeGreaterThan(-1);
    expect(r).toMatchObject({ ok: true });
    expect(r!.message).toMatch(/took 1: Drudge Charm/);
  });

  it('attack on a monster that has just died says it died, and where its corpse is', () => {
    host.add({ guid: 0x800021c0, name: 'Mudlurk Mosswart', itemType: 0x10, objectDescFlags: 0x10, x: 82, y: 22 });
    run(api, host, 200);
    host.objs.delete(0x800021c0);
    api.pushChat('You flatten Mudlurk Mosswart\'s body with the force of your assault!', 0x0);
    host.add({ guid: 0x800021c5, name: 'Corpse of Mudlurk Mosswart', objectDescFlags: 0x2000, x: 82, y: 22 });
    run(api, host, 200);
    expect(api.attack(0x800021c0).message).toMatch(/^Mudlurk Mosswart #800021c0 died: its corpse is #800021c5, \d m NE \(loot it, or pick another target\)/);
    host.add({ guid: 0x800021d0, name: 'Shreth', itemType: 0x10, objectDescFlags: 0x10, x: 82, y: 22 });
    run(api, host, 200);
    host.objs.delete(0x800021d0);
    run(api, host, 6000);
    expect(api.attack(0x800021d0).message).toMatch(/^Shreth is gone from view \(it died, fled out of range, or you moved away\)/);
  });

  it('a give the server cancels (its walk to them cut short) is tried once more, then explained', async () => {
    host.add({ guid: 0x50000004, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, x: 81, y: 21 });
    host.inv = [{ guid: 0x8000fe30, name: 'Pyreal', where: 'main pack', stack: 5000 }];
    let gives = 0;
    host.give = (t: number, i: number, n: number) => { gives++; host.sent.push(`give ${i.toString(16)} x${n}`); setTimeout(() => { api.pushChat('The Pyreals can\'t be given - action cancelled'); api.pushChat('Action cancelled!'); }, 200); return true; };
    const r = await settle(api, host, api.give('Pyreal', 'Claude Bulwark', 5000), 20_000);
    expect(gives).toBe(2);
    expect(r).toMatchObject({ ok: false });
    expect(r!.message).toMatch(/the server walks you to them before a give, and that walk was cut short \(one of you moved, or turned away\): stand still beside them and give again, or open a trade \(ac_trade\)/);
  });

  it('inventory lists a side pack\'s contents under it, and says when a pack is empty', () => {
    const text = formatInventory([
      { guid: 0x80003574, name: 'Foci of Strife', where: 'pack slots', wcid: 15271 },
      { guid: 0x800030b3, name: 'Sack', where: 'pack slots', itemType: 0x200, type: 'Container' },
      { guid: 0x800030b4, name: 'Sack', where: 'pack slots', itemType: 0x200, type: 'Container' },
      { guid: 0x800030ba, name: 'Pyreal', where: 'main pack', stack: 293, value: 293 },
      { guid: 0x80009001, name: 'Lead Pea', where: 'Sack', inside: 0x800030b3 },
      { guid: 0x80009002, name: 'Bread', where: 'Sack', inside: 0x800030b3 },
    ]);
    expect(text).toMatch(/#800030b3 Sack {2}\(Container, holds 2, listed under it\)/);
    expect(text).toMatch(/#800030b4 Sack {2}\(Container, empty\)/);
    expect(text).toMatch(/Sack \(side pack #800030b3\):\n {2}#80009001 Lead Pea\n {2}#80009002 Bread/);
    expect(text.indexOf('side pack #800030b3')).toBeGreaterThan(text.indexOf('pack slots:'));
  });

  it('the purse note is true on every server: half are lost (ACE destroys them by default), notes aren\'t coins', () => {
    host.me.pyreals = 4500; host.me.level = 13;
    expect(formatObservation(api.observe())).toMatch(/pyreals 4500 \(half are lost if you die; trade notes, bought from most vendors, aren't coins\)/);
  });
});

describe('the daemon answers a long call before the HTTP client gives up (CLI "fetch failed", 2026-10-12)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  it('a walk still going at the reply deadline answers "still in progress"; a fast one its own result', async () => {
    const slow = withCallDeadline(new Promise(() => {}), 'walkTo', 320_000);
    await vi.advanceTimersByTimeAsync(240_000);
    expect(await slow).toEqual({ ok: true, message: expect.stringMatching(/^walkTo is still in progress after 240 s and keeps going: ac_wait types=task-done/) });
    const fast = withCallDeadline(Promise.resolve({ ok: true, message: 'arrived' }), 'walkTo', 320_000);
    expect(await fast).toEqual({ ok: true, message: 'arrived' });
  });
  it('a reading call that slow is an error; a late failure of the work is swallowed', async () => {
    const read = withCallDeadline(new Promise(() => {}), 'observe', 60_000).catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await read).toBe('observe timed out after 60000 ms');
    let fail!: (e: Error) => void;
    const p = withCallDeadline(new Promise((_r, j) => { fail = j; }), 'walkTo', 1000);
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    fail(new Error('late'));
    await vi.advanceTimersByTimeAsync(10);
  });
});
