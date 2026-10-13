/**
 * Two agent reports from 2026-10-12, driven through the real AgentApi on the fake host (tests/_harness/agentFake.ts):
 *
 * - Dungeon Fern (Claude Arcanist, 23:48 UTC): `follow target="Claude Bulwark" flee=true` stood Arcanist directly
 *   under the ledge Bulwark had walked up a ramp onto, 6 m overhead ("so I never saw the fight"). The follow's
 *   "beside them" test was across the ground only. A leader a storey up or down is not beside you: the follow takes
 *   the way to their floor (the floor-aware planner), says so, and says when no way is found.
 * - Vengeance Caverns (Jake's archer Azreath, Coldeve): a target 14.8 m off and 3 m down past a ledge's edge; the
 *   attack said "shooting … from here" and every arrow answered "Your missile attack hit the environment." The clear-
 *   shot test now follows the arrow's real path (the server's spawn point and ballistic arc, `missileArc`), and two
 *   environment hits in a row move the archer off that spot instead of firing on blindly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { formatObservation } from '../packages/renderer/src/agent/format.ts';
import { missileArc, missileArcPoint, missileAimLevelDeg, solveBallisticArc, PROJ_SPAWN_HEIGHT, DEFAULT_PROJECTILE_RADIUS } from '@ac/shared';
import * as THREE from 'three';
import { ItemType } from '@ac/shared';
import { ServerObjectManager, type ServerObject } from '../packages/renderer/src/world/ServerObjectManager.js';
import { FakeHost, run } from './_harness/agentFake.ts';

/** An interior cell of the fake host's landblock (0xA9B4): a dungeon-like room with a ledge. */
const ROOM = 0xa9b40150;

async function settle<T>(api: AgentApi, host: FakeHost, p: Promise<T>, ms: number, each?: () => void): Promise<T | null> {
  let out: T | null = null;
  let done = false;
  void p.then((x) => { out = x; done = true; });
  for (let t = 0; t < ms && !done; t += 100) { each?.(); run(api, host, 100); await Promise.resolve(); await Promise.resolve(); }
  return out;
}

describe('follow: a leader on a ledge overhead is not beside you (Dungeon Fern, 2026-10-12)', () => {
  let host: FakeHost;
  let api: AgentApi;
  const BUL = 0x50000004;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host.me.cell = ROOM;
    host.me.x = 80; host.me.y = 33; host.me.z = 94;
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  const inRoom = (x: number, y: number): boolean => x > 60 && x < 100 && y > 5 && y < 45;
  /** The floor (94) everywhere in the room; a ledge 6 m up over x 66–96, y 30–40; with `ramp`, one up its east side. */
  const world = (ramp: boolean) => (x: number, y: number): number[] => {
    if (!inRoom(x, y)) return [];
    if (ramp && x >= 92 && x <= 96 && y >= 10 && y < 30) return [94 + (y - 10) * 0.3]; // solid ramp: 94 → 100
    if (x >= 66 && x <= 96 && y >= 30 && y <= 40) return [94, 100];
    return [94];
  };
  const leader = (x: number, y: number, z: number): void => {
    host.add({ guid: BUL, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, cell: ROOM, x, y, z });
    host.fellows = () => [{ guid: BUL, name: 'Claude Bulwark', health: { cur: 50, max: 50 }, stamina: { cur: 50, max: 50 }, mana: { cur: 10, max: 10 } }];
  };

  it('2 m across but 6 m up: takes the ramp to their floor and stands beside them there, saying why', async () => {
    host.floors = world(true);
    // The ramp runs between walls (entered only at its foot, from the south).
    host.wall = (x, y) => !inRoom(x, y) || (y > 10 && y < 30 && ((x > 90.5 && x < 92) || (x > 96 && x < 97.5)));
    leader(80, 35, 100);
    const r = await settle(api, host, api.follow('Claude Bulwark', { within: 4, durationMs: 60_000, flee: true }), 70_000);
    expect(r).toMatchObject({ ok: true });
    // On the ledge beside them, not under it.
    expect(host.me.z).toBeCloseTo(100, 0);
    expect(Math.hypot(host.me.x - 80, host.me.y - 35)).toBeLessThan(4 + 3.5);
    const said = api.eventsSince(0).map((e) => e.text);
    expect(said.some((t) => /\[Agent\] following: Claude Bulwark is 6 m above you \(a ledge or upper floor\), not beside you; taking the way up to them/.test(t))).toBe(true);
  });

  it('no way up: says where they are and that no way up was found, instead of standing under them', async () => {
    host.floors = world(false);
    host.wall = (x, y) => !inRoom(x, y);
    leader(80, 35, 100);
    const r = await settle(api, host, api.follow('Claude Bulwark', { within: 4, durationMs: 300_000 }), 300_000);
    expect(r).not.toBeNull();
    expect(r!.ok).toBe(false);
    expect(r!.message).toMatch(/^Claude Bulwark is 6 m above you on a ledge or upper floor; no way up to them was found from here/);
    expect(host.me.z).toBeCloseTo(94, 0);
  });

  it('beside them on the same floor still stands (unchanged), and outdoors a fellow up a slope beside you is beside you', async () => {
    leader(80, 36, 94);
    const p = api.follow('Claude Bulwark', { within: 4, durationMs: 6000 });
    const r = await settle(api, host, p, 10_000);
    expect(r).toMatchObject({ ok: true });
    expect(Math.hypot(host.me.x - 80, host.me.y - 33)).toBeLessThan(0.5);
    // The landscape: one surface, so 3 m up a hillside 3 m away is beside you.
    host.me.cell = 0xa9b40019;
    host.objs.get(BUL)!.cell = 0xa9b40019;
    host.objs.get(BUL)!.z = 97;
    const r2 = await settle(api, host, api.follow('Claude Bulwark', { within: 4, durationMs: 6000 }), 10_000);
    expect(r2).toMatchObject({ ok: true });
    expect(Math.hypot(host.me.x - 80, host.me.y - 33)).toBeLessThan(0.5);
  });
});

describe('the arrow\'s path (ACE Player_Missile.LaunchMissile)', () => {
  it('solve_ballistic_arc: the low root, reaching the aim point at its time', () => {
    const from = { x: 0, y: 0, z: 1.5 }, to = { x: 0, y: 30, z: -2 };
    const s = solveBallisticArc(from, 25, to)!;
    const end = missileArcPoint({ origin: from, velocity: s.velocity }, s.time);
    expect(end.x).toBeCloseTo(0, 5); expect(end.y).toBeCloseTo(30, 4); expect(end.z).toBeCloseTo(-2, 4);
    expect(Math.hypot(s.velocity.x, s.velocity.y, s.velocity.z)).toBeCloseTo(25, 4);
    expect(solveBallisticArc(from, 10, { x: 0, y: 30, z: 20 })).toBeNull();
  });
  it('GetAimLevel snaps normalized z × 90 to 15° steps', () => {
    expect(missileAimLevelDeg({ x: 0, y: 1, z: 0 })).toBe(0);
    expect(missileAimLevelDeg({ x: 0, y: 1, z: -0.2 })).toBe(-15); // z/len ≈ -0.196 → -17.6
    expect(missileAimLevelDeg({ x: 0, y: 0, z: 1 })).toBe(90);
    expect(missileAimLevelDeg({ x: 0, y: 0, z: -1 })).toBe(-90);
  });
  it('spawns 2 × (radius + arrow radius) ahead at Height × 0.8454, tilted by the aim motion, and lands on the aim point', () => {
    const arc = missileArc({ from: { x: 0, y: 0, z: 10 }, to: { x: 0, y: 14.8, z: 7 }, speed: 24, shooterHeight: 1.8, shooterRadius: 0.48, targetHeight: 1.6 })!;
    const radsum = 2 * 0.48 + 2 * DEFAULT_PROJECTILE_RADIUS;
    const a = (arc.aimLevelDeg * Math.PI) / 180;
    expect(arc.aimLevelDeg).toBe(-15);
    expect(arc.origin.y).toBeCloseTo(radsum * Math.cos(a), 5);
    expect(arc.origin.z).toBeCloseTo(10 + 1.8 * PROJ_SPAWN_HEIGHT + radsum * Math.sin(a), 5);
    expect(arc.aim).toEqual({ x: 0, y: 14.8, z: 7.8 });
    const end = missileArcPoint(arc, arc.time);
    expect(end.y).toBeCloseTo(14.8, 4); expect(end.z).toBeCloseTo(7.8, 4);
  });
});

describe('ServerObjectManager.missileArcOfFire: the sweep follows the arrow\'s arc, not the eye line', () => {
  const makeSOM = (): ServerObjectManager => {
    const som = new ServerObjectManager({ loadSetupModel: () => null } as never, {} as never, new THREE.Scene());
    som.missileLocalPlayer = () => ({ x: 100, y: 100, z: 10, radius: 0.48, height: 1.8 });
    return som;
  };
  const put = (som: ServerObjectManager, guid: number, x: number, y: number, z: number): void => {
    const o = {
      guid, name: 'Shadow Child', itemType: ItemType.Creature, physicsState: 0, mesh: new THREE.Group(),
      worldX: x, worldZ: y, worldY: z, collisionRadius: 0.5, collisionHeight: 1.6,
    } as unknown as ServerObject;
    (som as unknown as { objects: Map<number, ServerObject> }).objects.set(guid, o);
  };
  type P = { x: number; y: number; z: number };
  /** A flat ceiling at height `top` (AC z): the first point of the segment the sphere's top reaches it. */
  const ceiling = (top: number) => (from: P, to: P, r: number) => {
    if (Math.max(from.z, to.z) + r < top) return null;
    const t = from.z + r >= top ? 0 : (top - r - from.z) / (to.z - from.z);
    return { t, normal: { x: 0, y: 0, z: -1 } };
  };
  /** A ledge (top at z 10) out to y = `edge`: a segment going below its top short of the edge meets its lip. */
  const ledge = (edge: number) => (from: P, to: P, r: number) => {
    const n = 40;
    for (let i = 1; i <= n; i++) {
      const t = i / n, y = from.y + (to.y - from.y) * t, z = from.z + (to.z - from.z) * t;
      if (y < edge && z - r < 10) return { t, normal: { x: 0, y: -1, z: 0 } };
    }
    return null;
  };

  it('a long level shot under a 3 m dungeon ceiling: the eye line is clear, the arc\'s apex is not', () => {
    const som = makeSOM();
    put(som, 0x80000081, 100, 150, 10);
    som.missileEnvironmentSweep = ceiling(13);
    expect(som.lineOfFire(0x80000081)?.blockedAt).toBeNull();
    const arc = som.missileArcOfFire(0x80000081, { speed: 24 })!;
    expect(arc.noArc).toBeUndefined();
    expect(arc.blockedAt).not.toBeNull();
    // The aim motion for a 50 m lob is AimHigh45: the spawn point itself is tilted up toward the ceiling.
    expect(arc.blockedAt!).toBeGreaterThan(1);
    expect(arc.blockedAt!).toBeLessThan(25);
    expect(arc.blocker).toBe('the ceiling');
    // A fast bow flies flatter: the same shot clears.
    expect(som.missileArcOfFire(0x80000081, { speed: 50 })?.blockedAt).toBeNull();
  });

  it('down past a ledge\'s edge: blocked while you stand back from the lip, clear at the edge (Azreath)', () => {
    const som = makeSOM();
    put(som, 0x80000082, 100, 114.8, 7);
    som.missileEnvironmentSweep = ledge(108);
    // 8 m back from the lip, the arrow's path down to the target's legs meets the ledge before its edge.
    const back = som.missileArcOfFire(0x80000082, { speed: 24, aim: 'low' })!;
    expect(back.blockedAt).not.toBeNull();
    expect(back.blocker).toBe('a wall');
    // Stepping up to the edge opens it.
    som.missileLocalPlayer = () => ({ x: 100, y: 107.6, z: 10, radius: 0.48, height: 1.8 });
    expect(som.missileArcOfFire(0x80000082, { speed: 24, aim: 'low' })?.blockedAt).toBeNull();
  });

  it('no arc at this speed: noArc (the server\'s Out of Range!), and unknown without a body or a target', () => {
    const som = makeSOM();
    put(som, 0x80000083, 100, 140, 40);
    som.missileEnvironmentSweep = () => null;
    expect(som.missileArcOfFire(0x80000083, { speed: 15 })).toMatchObject({ noArc: true, blockedAt: null });
    expect(som.missileArcOfFire(0x80000099, { speed: 24 })).toBeNull();
    som.missileLocalPlayer = () => null;
    expect(som.missileArcOfFire(0x80000083, { speed: 24 })).toBeNull();
  });
});

describe('ac_attack with a bow: the arc decides the shot, and arrows hitting the environment move you (Azreath, 2026-10-12)', () => {
  let host: FakeHost;
  let api: AgentApi;
  const BOW = 0x50000101;
  const T = 0x80007101;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host.me.combatMode = 'missile';
    host.me.height = 1.8;
    host.inv = [{ guid: BOW, name: 'Shortbow', where: 'equipped', slot: 'MissileWeapon', itemType: 0x100, ammoType: 1 },
      { guid: 0x50000102, name: 'Arrow', where: 'equipped', slot: 'MissileAmmo', itemType: 0x100, stack: 80 }];
    host.appraisalDatas.set(BOW, { int: {}, float: {}, string: {}, bool: {}, did: {}, spells: [], maxVelocity: 24 });
    host.appraised.push(BOW);
    // A target 14.8 m north, 3 m down past a ledge's edge.
    host.add({ guid: T, name: 'Shadow Child', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 34.8, z: 91, height: 1.5 });
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  const shots = (): string[] => host.sent.filter((s) => s.startsWith('attack '));
  const hitEnvironment = (): void => { api.pushChat('Your missile attack hit the environment.', 0x05); host.pending = false; api.pushAttackDone(); };

  it('the straight line clear but the arc blocked: closes in, does not shoot from here; observe says the arc', async () => {
    host.lineOfFire = () => ({ dist: 14.8, blockedAt: null });
    const asked: Array<{ speed: number; aim?: string }> = [];
    host.missileLineOfFire = (_g, shot) => { asked.push(shot); const d = Math.hypot(host.me.x - 80, host.me.y - 34.8); return { dist: d, blockedAt: d > 8 ? 6.2 : null, blocker: 'the floor or ground' }; };
    const obs = formatObservation(api.observe());
    host.select(T);
    expect(formatObservation(api.observe())).toMatch(/Shadow Child .*no line of fire: blocked 6\.2 m along it by the floor or ground \(your arrow's arc would hit that\)/);
    expect(obs).toBeTruthy();
    const r = api.attack('Shadow Child');
    expect(r.message).toMatch(/is 15\.1 m away and in range, but no clear shot: the arrow's arc would hit the floor or ground 6\.2 m out: closing in/);
    expect(asked[0]).toEqual({ speed: 24, aim: 'medium' });
    await settle(api, host, new Promise(() => {}), 10_000, () => { if (shots().length) throw new Error('stop'); }).catch(() => {});
    expect(Math.hypot(host.me.x - 80, host.me.y - 34.8)).toBeLessThanOrEqual(8);
  });

  it('two "hit the environment" in a row: stops firing, says so, moves off the spot, shoots again; a third spot gives up as target-lost', async () => {
    host.missileLineOfFire = () => ({ dist: 14.8, blockedAt: null }); // the client sees a clear arc; the server disagrees
    const r = api.attack('Shadow Child');
    expect(r.message).toMatch(/^shooting at Shadow Child .* from here: 15\.1 m away/);
    run(api, host, 100);
    expect(shots()).toHaveLength(1);
    const spots: Array<{ x: number; y: number }> = [];
    for (let round = 0; round < 3; round++) {
      spots.push({ x: host.me.x, y: host.me.y });
      hitEnvironment(); run(api, host, 1600);
      hitEnvironment(); run(api, host, 200);
      if (round < 2) {
        const before = shots().length;
        await settle(api, host, new Promise(() => {}), 15_000, () => { if (shots().length > before) throw new Error('shot'); }).catch(() => {});
        expect(shots().length).toBe(before + 1);
        const said = api.eventsSince(0).map((e) => e.text);
        expect(said.filter((t) => /\[Agent\] closing in on Shadow Child: 2 shots in a row hit the environment: something between you and Shadow Child \(1\d\.\d m away, \d m below your bow\) stops the arrows \(a ledge's lip, a wall, the ceiling\); moving off this spot to where the arc is clear/.test(t))).toHaveLength(round + 1);
        // Off the spot the arrows hit from.
        expect(Math.hypot(host.me.x - spots[round].x, host.me.y - spots[round].y)).toBeGreaterThanOrEqual(AgentApi.MISSILE_RELOCATE_M - 0.1);
      }
    }
    const lost = api.eventsSince(0).filter((e) => e.type === 'target-lost').map((e) => e.text);
    expect(lost).toEqual([expect.stringMatching(/Shadow Child #80007101: no clear shot: your arrows hit the environment from 3 spots/)]);
    const done = api.eventsSince(0).filter((e) => e.type === 'task-done').map((e) => e.text);
    expect(done.at(-1)).toMatch(/Moved 2 times and the arrows still hit it: no clear shot from anywhere tried/);
  });

  it('a hit between environment hits resets the count: no move', () => {
    host.missileLineOfFire = () => ({ dist: 14.8, blockedAt: null });
    api.attack('Shadow Child');
    run(api, host, 100);
    hitEnvironment(); run(api, host, 1600);
    api.pushChat('You hit Shadow Child for 12 points of piercing damage!', 0x06); host.pending = false; api.pushAttackDone(); run(api, host, 1600);
    hitEnvironment(); run(api, host, 1600);
    expect(api.eventsSince(0).some((e) => /hit the environment: something between/.test(e.text))).toBe(false);
    expect(shots().length).toBeGreaterThanOrEqual(3);
    expect(host.me.y).toBe(20);
  });
});
