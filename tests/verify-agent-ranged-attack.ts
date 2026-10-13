/**
 * AGENT.ranged-attack-range (Jake, Coldeve, 2026-10-12): Azreath, an archer with a Shortbow (Range 65 yd ≈ 59 m) in
 * missile mode, was told "running up to Virindi Observer, then attacking" at 53.7 m and run to ~1 m of it. The server
 * never walks you to a missile target (ACE Player_Missile turns and fires; past the launcher's reach it answers
 * MissileOutOfRange + AttackDone), so the agent's attack now shoots from where you stand when the server would launch
 * (TargetInRange, then the ballistic arc: Creature_Missile.GetProjectileVelocity / Trajectory.solve_ballistic_arc),
 * and closes in only until the target is in reach with a clear line. Driven through the real AgentApi on the fake host.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { getMaxMissileRange, getProjectileSpeed, missileArcGroundReach, missileShot, MISSILE_RANGE_CAP } from '@ac/shared';
import { FakeHost, run } from './_harness/agentFake.ts';

const BOW = 0x50000101;
const OBSERVER = 0x80007001;
/** Shortbow-like: MaximumVelocity 24 → 576 × 0.10204 ≈ 58.8 m, the examine panel's "Range: 60 yds." */
const V = 24;

async function ticks(api: AgentApi, host: FakeHost, ms: number, until?: () => boolean): Promise<void> {
  for (let t = 0; t < ms && !(until?.() ?? false); t += 100) { run(api, host, 100); await Promise.resolve(); await Promise.resolve(); }
}
const shots = (host: FakeHost): string[] => host.sent.filter((s) => s.startsWith('attack '));
const distTo = (host: FakeHost, x: number, y: number): number => Math.hypot(host.me.x - x, host.me.y - y);

describe('the missile reach rule (ACE TargetInRange + the ballistic arc)', () => {
  it('TargetInRange: MaximumVelocity² / g, capped at 85 yd', () => {
    expect(getMaxMissileRange(V)).toBeCloseTo(58.78, 1);
    expect(getMaxMissileRange(40)).toBeCloseTo(MISSILE_RANGE_CAP, 3);
  });
  it('the arc reaches less far uphill: a 24.9 m/s Shortbow ~40 m across at +19 m', () => {
    expect(missileArcGroundReach(24.9, 19)).toBeCloseTo(40.0, 0);
    // On the level the arc's reach is the same v²/g TargetInRange uses.
    expect(missileArcGroundReach(V, 0)).toBeCloseTo(getMaxMissileRange(V), 3);
    expect(missileArcGroundReach(V, 40)).toBe(0);
  });
  it('Use Fast Missiles is × 1.2 of the velocity (the arc), not of TargetInRange; 50 m/s at most', () => {
    expect(getProjectileSpeed(V, true)).toBeCloseTo(28.8, 5);
    expect(getProjectileSpeed(45, true)).toBe(50);
    const up = { dx: 0, dy: 45, dz: 19, maximumVelocity: V, shooterHeight: 1.8, targetHeight: 1.5 };
    expect(missileShot(up).inRange).toBe(false);
    expect(missileShot({ ...up, useFastMissiles: true }).inRange).toBe(true);
    // Far on the level: TargetInRange refuses whatever the speed.
    expect(missileShot({ dx: 0, dy: 62, dz: 0, maximumVelocity: V, useFastMissiles: true, shooterHeight: 1.8, targetHeight: 1.5 }).inRange).toBe(false);
  });
});

describe('ac_attack with a bow', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host.me.combatMode = 'missile';
    host.me.height = 1.8;
    host.inv = [{ guid: BOW, name: 'Shortbow', where: 'equipped', slot: 'MissileWeapon', itemType: 0x100, ammoType: 1 },
      { guid: 0x50000102, name: 'Arrow', where: 'equipped', slot: 'MissileAmmo', itemType: 0x100, stack: 80 }];
    host.appraisalDatas.set(BOW, { int: {}, float: {}, string: {}, bool: {}, did: {}, spells: [], maxVelocity: V });
    host.appraised.push(BOW);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  const observer = (x: number, y: number, z = 94) => host.add({ guid: OBSERVER, name: 'Virindi Observer', itemType: 0x10, objectDescFlags: 0x10, x, y, z, height: 1.5 });

  it('in range with a clear line: shoots from where you stand (Jake\'s 53.7 m Virindi Observer)', async () => {
    observer(80, 73.7);
    const r = api.attack('Virindi Observer');
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/^shooting at Virindi Observer \(#80007001\) from here: 53\.7 m away, within your Shortbow's ~59 m;/);
    expect(r.message).not.toMatch(/running up/);
    run(api, host, 100);
    expect(shots(host)).toEqual(['attack 80007001 0.6 medium']);
    await ticks(api, host, 3000);
    expect(host.keys.has('KeyW')).toBe(false);
    expect(host.me.y).toBe(20);
  });

  it('in peace mode with the bow wielded it shoots too (the attack enters missile mode)', () => {
    host.me.combatMode = 'peace';
    observer(80, 60);
    expect(api.attack('Virindi Observer').message).toMatch(/^shooting at Virindi Observer .* from here: 40\.0 m away/);
    run(api, host, 100);
    expect(shots(host)).toHaveLength(1);
  });

  it('out of range: walks only to just inside the bow\'s reach, then shoots', async () => {
    observer(80, 95); // 75 m north
    const r = api.attack('Virindi Observer');
    expect(r.message).toMatch(/is 75\.0 m away, out of your Shortbow's ~59 m: closing in only until it is in range with a clear shot/);
    expect(shots(host)).toEqual([]);
    await ticks(api, host, 30_000, () => shots(host).length > 0);
    expect(shots(host)).toHaveLength(1);
    const d = distTo(host, 80, 95);
    expect(d).toBeLessThanOrEqual(V * V / 9.8 * AgentApi.MISSILE_APPROACH_MARGIN + 0.01);
    expect(d).toBeGreaterThan(45); // ~20 m walked, not 72
  });

  it('uphill the arc falls short sooner: closes in to the arc\'s reach, not the flat range', async () => {
    observer(80, 65, 94 + 19); // 45 m across, 19 m up
    const r = api.attack('Virindi Observer');
    expect(r.message).toMatch(/out of your Shortbow's ~59 m, ~3\d m across with it 18 m above your bow \(the arc falls short uphill\)/);
    await ticks(api, host, 30_000, () => shots(host).length > 0);
    const d = distTo(host, 80, 65);
    expect(d).toBeLessThan(36);
    expect(d).toBeGreaterThan(28);
  });

  it('a wall in the line of fire: moves until the line opens, not to 2.5 m', async () => {
    observer(80, 70); // 50 m: in range
    (host as unknown as { lineOfFire: (g: number) => { dist: number; blockedAt: number | null } }).lineOfFire = () => {
      const d = distTo(host, 80, 70);
      return { dist: d, blockedAt: d > 30 ? 4 : null };
    };
    const r = api.attack('Virindi Observer');
    expect(r.message).toMatch(/is 50\.0 m away and in range, but no clear line of fire \(a wall, the ground or an object 4\.0 m out\): closing in/);
    await ticks(api, host, 30_000, () => shots(host).length > 0);
    expect(shots(host)).toHaveLength(1);
    const d = distTo(host, 80, 70);
    expect(d).toBeLessThanOrEqual(30);
    expect(d).toBeGreaterThan(25);
  });

  it('"Out of Range!" from the server is reported plainly, and the attack closes in under where it was said', async () => {
    observer(80, 73.7);
    api.attack('Virindi Observer');
    run(api, host, 100);
    expect(shots(host)).toHaveLength(1);
    // The server disagrees (its own position of you lags, the target moved): the transient and AttackDone.
    api.pushChat('Out of Range!', 0x1a);
    host.pending = false;
    api.pushAttackDone();
    run(api, host, 100);
    const done = api.eventsSince(0).filter((e) => e.type === 'task-done').map((e) => e.text);
    expect(done.some((t) => /Out of Range! \(the server\): Virindi Observer is 53\.7 m away, beyond what your Shortbow reaches from here; closing in/.test(t))).toBe(true);
    await ticks(api, host, 30_000, () => shots(host).length > 1);
    expect(shots(host)).toHaveLength(2);
    expect(distTo(host, 80, 73.7)).toBeLessThanOrEqual(53.7 * AgentApi.MISSILE_APPROACH_MARGIN + 0.01);
    expect(distTo(host, 80, 73.7)).toBeGreaterThan(40);
  });

  it('"Out of Range!" three times: says the shots can\'t reach it, as target-lost', async () => {
    observer(80, 73.7);
    api.attack('Virindi Observer');
    for (let i = 0; i < 3; i++) {
      await ticks(api, host, 30_000, () => shots(host).length > i);
      api.pushChat('Out of Range!', 0x1a);
      host.pending = false;
      api.pushAttackDone();
      run(api, host, 100);
      await Promise.resolve();
    }
    const lost = api.eventsSince(0).filter((e) => e.type === 'target-lost');
    expect(lost.map((e) => e.text)).toEqual([expect.stringMatching(/Virindi Observer #80007001: Out of Range! \(the server\) at [\d.]+ m away, three times/)]);
  });

  it('an unappraised bow is examined quietly first, then the plan follows as a chat line', async () => {
    host.appraised = [];
    observer(80, 73.7);
    const r = api.attack('Virindi Observer');
    expect(r.message).toMatch(/^examining your Shortbow for its range, then shooting at Virindi Observer/);
    expect(host.appraiseCalls).toEqual([{ guid: BOW, quiet: true }]);
    await ticks(api, host, 500, () => shots(host).length > 0);
    expect(shots(host)).toHaveLength(1);
    expect(api.eventsSince(0).some((e) => /\[Agent\] shooting at Virindi Observer .* from here: 53\.7 m away, within your Shortbow's ~59 m/.test(e.text))).toBe(true);
  });

  it('no appraisal reply: says the range assumed is the server\'s default (20 m/s, ~41 m)', async () => {
    host.appraised = [];
    host.appraisalData = (g: number) => (g === BOW ? { int: {}, float: {}, string: {}, bool: {}, did: {}, spells: [] } : null);
    observer(80, 55); // 35 m
    api.attack('Virindi Observer');
    await ticks(api, host, 3000, () => shots(host).length > 0);
    expect(api.eventsSince(0).some((e) => /\[Agent\] shooting at Virindi Observer .* 35\.0 m away, within your Shortbow's ~41 m \(its range isn't known: no appraisal of your Shortbow, so the server's default for a missing velocity, 20 m\/s, is assumed\)/.test(e.text))).toBe(true);
  });
});

describe('ac_attack in melee is unchanged', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => { vi.useFakeTimers(); host = new FakeHost(); api = new AgentApi(host); vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('melee mode with a sword: runs up first, as before', () => {
    host.me.combatMode = 'melee';
    host.inv = [{ guid: 0x50000201, name: 'Long Sword', where: 'equipped', slot: 'MeleeWeapon', itemType: 0x1 }];
    host.add({ guid: OBSERVER, name: 'Virindi Observer', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 73.7 });
    expect(api.attack('Virindi Observer').message).toMatch(/^running up to Virindi Observer/);
    expect(shots(host)).toEqual([]);
  });
});
