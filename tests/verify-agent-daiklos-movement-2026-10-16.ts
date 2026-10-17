/**
 * Stream movement reports, Holtburg → Daiklos Dungeon (0x0185), end of retail local ACE, 2026-10-16 06:28–07:29Z
 * (Claude Arcanist / Claude Bulwark; transcripts stream/sessions/{mage,soldier}-2026-10-16-seg1.jsonl, page traces
 * mage.log / soldier.log, reports stream/reports/*2026-10-16T07-29*.md).
 *
 * 1. "stopped 741 m short" / "1489 m short" read as impossible. The distances were right (2.3S 50.6E → 0.7N 51.4E is
 *    3.0 units north and 0.8 east: 745 m; Holtburg → Daiklos 2.3 km): a walk to map coordinates that ends short now says
 *    how far the point is, where you are, and the map's scale (0.1 = 24 m).
 * 2. "113 m NNW" answered "no object matching": offsets (and ac_turn) take all 16 compass points and degrees.
 * 3. The line-of-fire hint's "1m north" walk answered "arrived (1.0 m away)" without a step (the default within=2), and
 *    the next refusal looked like a wrong hint while the Lich had moved 10 m. A short offset is a step now, and the next
 *    refusal for the same target says it moved since the hint (or that you never got to the spot).
 * 4. Two stay_with walks to Daiklos each ended "they went on past you on another way" as the other came by 16 m off on
 *    the same heading: a fellow who passes on your way leads now, and the walk goes on.
 * 5. follow stop_on_aggro=false "ended because of" the Pumpkin Buffer: the event was the earlier follow's, already
 *    answered at its call; and a creature seen only buffing you (all its spells beneficial) is no threat.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi, parseDirection, parseOffset, toGlobal } from '../packages/renderer/src/agent/AgentApi.ts';
import type { AgentResult } from '../packages/renderer/src/agent/types.ts';
import { FakeHost, run } from './_harness/agentFake.ts';

const ARCANIST = 0x50000002;
const BULWARK = 0x50000003;
const LICH = 0x80010a12;
const PUMPKIN = 0x8000ede9;
const vitals = { cur: 40, max: 50 };

async function settle<T>(api: AgentApi, host: FakeHost, p: Promise<T>, ms: number, each?: () => void): Promise<T | null> {
  let out: T | null = null;
  let done = false;
  void p.then((x) => { out = x; done = true; });
  for (let t = 0; t < ms && !done; t += 100) { each?.(); run(api, host, 100); await Promise.resolve(); await Promise.resolve(); }
  return out;
}

describe('Daiklos walk reports (2026-10-16 07:29Z)', () => {
  let host: FakeHost;
  let api: AgentApi;
  let traces: string[];
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    traces = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { traces.push(a.join(' ')); });
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  describe('2. the 16 compass points and degrees', () => {
    it('parses NNW, west-southwest, north-north-east, 330° and bearing words', () => {
      expect(parseOffset('113 m NNW')).toEqual({ dist: 113, bearing: 337.5 });
      expect(parseOffset('10m nne')).toEqual({ dist: 10, bearing: 22.5 });
      expect(parseOffset('10m WSW')).toEqual({ dist: 10, bearing: 247.5 });
      expect(parseOffset('4 m west-southwest')).toEqual({ dist: 4, bearing: 247.5 });
      expect(parseOffset('4 m north-north-east')).toEqual({ dist: 4, bearing: 22.5 });
      expect(parseOffset('4 m to the ese')).toEqual({ dist: 4, bearing: 112.5 });
      expect(parseOffset('10m 330°')).toEqual({ dist: 10, bearing: 330 });
      expect(parseOffset('10 m 330 deg')).toEqual({ dist: 10, bearing: 330 });
      expect(parseOffset('10 m bearing 450')).toEqual({ dist: 10, bearing: 90 });
      expect(parseOffset('5m ahead')).toEqual({ dist: 5, turn: 0 });
      expect(parseOffset('25 m NE')).toEqual({ dist: 25, bearing: 45 });
      expect(parseOffset('10m north of the well')).toBeNull();
      expect(parseOffset('10m nnn')).toBeNull();
      expect(parseDirection('SSW')).toEqual({ bearing: 202.5 });
      expect(parseDirection('left')).toEqual({ turn: -90 });
    });

    it('walk_to "40 m NNW" walks there (was "no object matching")', async () => {
      const g0 = toGlobal(host.me.cell, host.me.x, host.me.y);
      const r = await settle(api, host, api.walkTo('40 m NNW'), 60_000);
      expect(r, traces.join('\n')).toMatchObject({ ok: true });
      const g1 = toGlobal(host.me.cell, host.me.x, host.me.y);
      const b = (Math.atan2(g1.x - g0.x, g1.y - g0.y) * 180) / Math.PI;
      expect(Math.abs(b - -22.5)).toBeLessThan(5);
      expect(Math.hypot(g1.x - g0.x, g1.y - g0.y)).toBeGreaterThan(37);
    });

    it('turn toward "NNW" and "330°"', () => {
      expect(api.turn('NNW').message).toBe('facing 338°');
      expect(api.turn('330°').message).toBe('facing 330°');
      expect(api.turn('west-southwest').message).toBe('facing 248°');
    });
  });

  describe('3. a short offset is a step, and the next refusal says what changed', () => {
    it('walk_to "1m north" moves about a metre (was "arrived (1.0 m away)" standing still)', async () => {
      const y0 = host.me.y;
      const r = await settle(api, host, api.walkTo('1m north'), 10_000);
      expect(r, traces.join('\n')).toMatchObject({ ok: true });
      expect(host.me.y - y0).toBeGreaterThan(0.7);
      expect(Number(/arrived \((\d+\.\d) m from /.exec(r!.message)![1])).toBeLessThanOrEqual(0.4);
    });

    it('"0.5m east" steps too; a within= given still counts', async () => {
      const x0 = host.me.x;
      await settle(api, host, api.walkTo('0.5m east'), 10_000);
      expect(host.me.x - x0).toBeGreaterThan(0.25);
      const x1 = host.me.x;
      const r = await settle(api, host, api.walkTo('1m east', { within: 2 }), 5000);
      expect(r!.message).toMatch(/^arrived/);
      expect(host.me.x - x1).toBeLessThan(0.1);
    });

    function lich(): void {
      host.spells = () => [{ id: 82, name: 'Flame Bolt IV', school: 'War', level: 4, projectile: true, range: 30 }];
      host.add({ guid: LICH, name: 'Lich', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 28 });
      host.me.mana = { current: 198, max: 198 };
      host.cast = () => { throw new Error('a refused cast must not go out'); };
      host.lineOfFire = () => ({ dist: 8, blockedAt: 4.8, blocker: 'a wall' });
      host.lineOfFireOpenSpot = () => ({ dx: 0, dy: 1, dist: 1 });
    }
    async function cast(): Promise<AgentResult> {
      const r = await settle(api, host, api.cast('Flame Bolt IV', LICH), 10_000);
      return r!;
    }

    it('at the hinted spot with the target moved 10 m: says so, with the new spot', async () => {
      lich();
      const first = await cast();
      expect(first.message).toMatch(/The line is open from 1 m north of you \(walk_to "1m north"\), if it stays put\. Then cast\.$/);
      await settle(api, host, api.walkTo('1m north'), 10_000);
      const lo = host.objs.get(LICH)!;
      lo.x += 6; lo.y += 8;
      host.lineOfFireOpenSpot = () => ({ dx: 1.5, dy: 0, dist: 1.5 });
      const second = await cast();
      expect(second.message).toMatch(/would take the bolt\. You're at the spot the last hint named, but Lich has moved 10 m since \(the hint was for where it stood then\)\. The line is open from 1\.5 m east of you/);
    });

    it('the target stayed put and you never got to the spot: says how far off it you are', async () => {
      lich();
      await cast();
      const second = await cast();
      expect(second.message).toMatch(/You're 1\.0 m from the spot the last hint named\./);
      expect(second.message).not.toMatch(/has moved/);
    });

    it('a different target, or no hint before: nothing extra', async () => {
      lich();
      const first = await cast();
      expect(first.message).not.toMatch(/last hint/);
    });
  });

  describe('1. a coordinate walk that ends short says how far the point is and the map scale', () => {
    it('stay_with a fellow out of sight: "7xx m short" plus where the point is and the map scale', async () => {
      host.fellows = () => [{ guid: BULWARK, name: 'Claude Bulwark', health: vitals, stamina: vitals, mana: vitals }];
      const g = toGlobal(host.me.cell, host.me.x, host.me.y);
      const ns = (g.y + 720) / 240 - 101.95, ew = (g.x + 192) / 240 - 101.95;
      const target = `${Math.abs(ns).toFixed(1)}${ns < 0 ? 'S' : 'N'}, ${Math.abs(ew).toFixed(1)}${ew < 0 ? 'W' : 'E'}`;
      const r = await settle(api, host, api.walkTo(target, { stayWith: 'Claude Bulwark' }), 5000);
      expect(r!.ok).toBe(false);
      expect(r!.message).toMatch(/^stopped 7\d\d\.\d m short: Claude Bulwark is out of sight/);
      expect(r!.message.split('\n')[1]).toMatch(/^ {2}\d+\.\dN, \d+\.\dE is 7\d\d m N of you \(you're at 42\.1N, 33\.6E; on the map 0\.1 is 24 m, 1\.0 is 240 m\)$/);
      expect(r!.message).toContain(`  ${target} is `);
    });

    it('a short coordinate walk that arrives says nothing extra', async () => {
      const g = toGlobal(host.me.cell, host.me.x, host.me.y);
      const ns = (g.y + 24) / 240 - 101.95, ew = g.x / 240 - 101.95;
      const r = await settle(api, host, api.walkTo(`${ns.toFixed(1)}N, ${ew.toFixed(1)}E`), 60_000);
      expect(r!.message).not.toMatch(/on the map/);
    });
  });

  describe('4. stay_with: a fellow who passes you on your way leads, not "went on past you on another way"', () => {
    it('she comes by 5 m off your line and goes ahead: the walk goes on after her', async () => {
      host.wall = () => false;
      host.fellows = () => [{ guid: ARCANIST, name: 'Claude Arcanist', health: vitals, stamina: vitals, mana: vitals }];
      // 20 m behind you (south), 5 m east of your line north; she walks north at 4.5 m/s, faster than your run.
      host.add({ guid: ARCANIST, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, x: 85, y: 0 });
      let held = 3000;
      const r = await settle(api, host, api.walkTo('300m north', { within: 2, stayWith: 'Claude Arcanist', timeoutMs: 600_000 }), 120_000, () => {
        // She stands buffing for 3 s first (so you stop for her), then comes on.
        if (held > 0) { held -= 100; return; }
        const a = host.objs.get(ARCANIST)!;
        if (a.y < 312) a.y += 0.45;
      });
      const log = traces.filter((t) => /walk:/.test(t)).join('\n');
      expect(traces.some((t) => /waiting for Claude Arcanist/.test(t)), log).toBe(true);
      expect(r?.message ?? '', log).not.toMatch(/went on past you on another way/);
      expect(traces.some((t) => /Claude Arcanist (went on ahead|caught up)/.test(t)), log).toBe(true);
      expect(r, `${log}\n${r?.message} me ${host.me.x},${host.me.y} her ${host.objs.get(ARCANIST)!.x},${host.objs.get(ARCANIST)!.y}`).toMatchObject({ ok: true });
    });

    it('one far off your line (a parallel way) still ends the walk, told so', async () => {
      host.wall = () => false;
      host.fellows = () => [{ guid: ARCANIST, name: 'Claude Arcanist', health: vitals, stamina: vitals, mana: vitals }];
      host.add({ guid: ARCANIST, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, x: 130, y: 15 });
      const r = await settle(api, host, api.walkTo('600m north', { within: 2, stayWith: 'Claude Arcanist', timeoutMs: 600_000 }), 120_000,
        () => { host.objs.get(ARCANIST)!.y += 0.35; });
      expect(r!.message).toMatch(/they went on past you on another way/);
    });
  });

  describe('5. follow and the Pumpkin Buffer', () => {
    const pumpkin = (): void => {
      host.me.level = 31;
      host.add({ guid: PUMPKIN, name: 'Pumpkin Buffer', itemType: 0x10, objectDescFlags: 0x10, x: 95, y: 40, level: 42, seeks: { guid: host.me.guid, kind: 'turn' } });
      (host as unknown as { spellTableData: () => unknown }).spellTableData = () => ({
        spells: new Map([
          [4290, { name: 'Incantation of Armor Other', desc: '', category: 0, school: 3, bitfield: 0x4 | 0x1, power: 400 }],
          [4291, { name: 'Incantation of Cold Protection Other', desc: '', category: 0, school: 3, bitfield: 0x4 | 0x1, power: 400 }],
          [1, { name: 'Strength Other I', desc: '', category: 0, school: 3, bitfield: 0x4, power: 10 }],
          [2, { name: 'Weakness Other I', desc: '', category: 0, school: 3, bitfield: 0x1, power: 10 }],
        ]),
      });
    };

    it('one seen only buffing you is not "coming at you": a walk and a follow go on', async () => {
      pumpkin();
      api.pushChat('Pumpkin Buffer cast Incantation of Armor Other on you', 0x17);
      api.pushChat('Pumpkin Buffer cast Incantation of Cold Protection Other on you', 0x17);
      run(api, host, 500, { physics: false });
      expect(api.comingAt(host.me.guid)).toEqual([]);
      expect(api.harmlessKind('Pumpkin Buffer')).toBe(true);
      const r = await settle(api, host, api.walkTo('30m north', { stopOnAggro: true }), 30_000);
      expect(r, traces.join('\n')).toMatchObject({ ok: true });
    });

    it('before any cast seen, or after a harmful one or a blow, it counts', async () => {
      pumpkin();
      run(api, host, 500, { physics: false });
      expect(api.comingAt(host.me.guid).map((c) => c.name)).toEqual(['Pumpkin Buffer']);
      api.pushChat('Pumpkin Buffer cast Incantation of Armor Other on you', 0x17);
      expect(api.harmlessKind('Pumpkin Buffer')).toBe(true);
      api.pushChat('Pumpkin Buffer cast Weakness Other I on you', 0x17);
      expect(api.harmlessKind('Pumpkin Buffer')).toBe(false);
      const api2 = new AgentApi(host);
      api2.pushChat('Pumpkin Buffer cast Strength Other I on you', 0x17);
      api2.pushChat('Pumpkin Buffer slashes your hand for 6 points of slashing damage!', 0x15);
      expect(api2.harmlessKind('Pumpkin Buffer')).toBe(false);
      // No spell table: never assumed harmless.
      const api3 = new AgentApi(host);
      (host as unknown as { spellTableData?: unknown }).spellTableData = undefined;
      api3.pushChat('Pumpkin Buffer cast Incantation of Armor Other on you', 0x17);
      expect(api3.harmlessKind('Pumpkin Buffer')).toBe(false);
    });

    it('a follow that ended at its call does not answer the next one\'s ac_wait types=task-done', async () => {
      host.fellows = () => [{ guid: ARCANIST, name: 'Claude Arcanist', health: vitals, stamina: vitals, mana: vitals }];
      host.add({ guid: ARCANIST, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, x: 80, y: 60 });
      host.add({ guid: 0x8000aaaa, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 110, y: 40, seeks: { guid: host.me.guid, kind: 'move' } });
      api.observe();
      // The first follow stops for the Skulker coming at you, within a few seconds: its answer is the call's.
      const first = await settle(api, host, api.follow(ARCANIST, { stopOnAggro: true }), 10_000);
      expect(first!.message).toMatch(/Drudge Skulker .* is coming at you/);
      // The second, stop_on_aggro=false, keeps going; the wait hears nothing of the first.
      const second = api.follow(ARCANIST, { durationMs: 60_000 });
      void second;
      const w = api.wait({ types: ['task-done'] }, 3000);
      run(api, host, 3100);
      const evs = await w;
      expect(evs.map((e) => e.text)).toEqual([]);
      // Its own end is heard.
      const w2 = api.wait({ types: ['task-done'] }, 5000);
      api.stopMoving();
      run(api, host, 200);
      const evs2 = await w2;
      expect(evs2.length).toBe(1);
      expect(evs2[0].text).toMatch(/^following Claude Arcanist: /);
    });

    it('a task that outlived its call still has its task-done heard after a newer one starts', async () => {
      const long = api.walkTo('120m north');
      run(api, host, 20_000);
      void long;
      // Replaced after 20 s: its "interrupted" is history the caller never had; it stays deliverable.
      void api.walkTo('5m south');
      const evs = await api.wait({ types: ['task-done'] }, 1000);
      expect(evs.map((e) => e.text)).toEqual([expect.stringMatching(/^walking 120 m N: interrupted \(replaced by walking 5 m S\)/)]);
    });
  });
});
