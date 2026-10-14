/**
 * Point-blank bolts that did nothing (Claude Arcanist, 2026-10-12 and 2026-10-14): Flame Bolt III after Flame Bolt III
 * at a Skeleton Warrior 1.5–1.6 m away, "Casting" and the incantation, then silence while it clawed the mage.
 *
 * Not an ACE or retail minimum distance. Run with ACE's own physics (the live server's ACE.Server.dll, its
 * CalculateProjectileOrigins / IsProjectileVisible / transitions, the EoL DATs), a targeted bolt hits a still target
 * at 0.6–3.5 m on open ground, and at 1.4–2.4 m in all 2797 spots of dungeon 0x0145 where 3–4 m shots hit. Both
 * incidents were at Door #70145010, the lever-timed door at the foot of that dungeon's stairs (ACE world DB,
 * 0x0145010D (100, -34.75, -6)): with the door closed every bolt dies on it, and ACE's monster melee checks distance
 * only (Monster_Navigation.GetDistanceToTarget: CylinderDistance ≤ 0.75), so a skeleton pressed against the far side
 * claws a mage on the near side. A bolt that meets a door reports nothing (OnCollideEnvironment / a non-creature
 * OnCollideObject: SpellProjectile.cs).
 *
 * Ours: the line-of-fire check that should have refused those casts swept a different line (eye at 3/4 height to
 * the target's middle) and skipped its first 0.6 m and last 0.7 m, exactly where a door you and a monster are both
 * pressed against stands. It now sweeps the bolt's real path (boltLaunch: ACE WorldObject_Magic) — your eye back
 * to the spawn point (IsProjectileVisible), then the spawn point to the target's two-thirds point — and a bolt that
 * still does nothing says what stands in its way.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { ItemType, boltLaunch, cylinderDistance, SPELL_PROJ_HEIGHT } from '@ac/shared';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import type { AgentResult } from '../packages/renderer/src/agent/types.ts';
import { ServerObjectManager, type ServerObject } from '../packages/renderer/src/world/ServerObjectManager.js';
import { FakeHost, run } from './_harness/agentFake.ts';

// Human (Setup 0x02000001) and Skeleton Warrior (0x02000059), portal.dat: Setup radius / height, first sphere radius.
const HUMAN = { radius: 0.6788225173950195, height: 1.8350000381469727, physicsRadius: 0.47999998927116394 };
const SKELETON = { radius: 0.7071067690849304, height: 1.8250000476837158 };
const SKELETON_SPHERES = [{ origin: { x: 0, y: 0, z: 0.4975 }, radius: 0.5 }, { origin: { x: 0, y: 0, z: 1.3225 }, radius: 0.5 }];

describe('boltLaunch: where ACE spawns a targeted bolt (WorldObject_Magic.CalculatePreOffset / CalculateProjectileOrigins)', () => {
  const launch = (to: { x: number; y: number; z: number }) => boltLaunch({
    from: { x: 0, y: 0, z: 0 }, to,
    casterHeight: HUMAN.height, casterRadius: HUMAN.radius, casterPhysicsRadius: HUMAN.physicsRadius,
    targetHeight: SKELETON.height, targetRadius: SKELETON.radius, projectileRadius: 0.1,
  });

  // The numbers ACE.Server.dll itself produced for these placements (the physics harness, 2026-10-14).
  it('a skeleton 1.6 m away on level ground: one radius sum (0.58 m) ahead, at two thirds of your height', () => {
    const b = launch({ x: 0, y: 1.6, z: 0 });
    expect(b.close).toBe(true);
    expect(b.origin.y).toBeCloseTo(0.58, 2);
    expect(b.origin.z).toBeCloseTo(HUMAN.height * SPELL_PROJ_HEIGHT, 2);
    expect(b.aim).toEqual({ x: 0, y: 1.6, z: SKELETON.height * SPELL_PROJ_HEIGHT });
    // IsProjectileVisible looks back at your feet + Height − the bolt's 0.2 m Height.
    expect(b.eye.z).toBeCloseTo(HUMAN.height - 0.2, 5);
  });

  it('3 m away: two radius sums (1.16 m) ahead; the facing is the target\'s bearing, not yours', () => {
    const b = launch({ x: 3 * Math.sin(1), y: 3 * Math.cos(1), z: 0 });
    expect(b.close).toBe(false);
    expect(Math.hypot(b.origin.x, b.origin.y)).toBeCloseTo(1.16, 2);
    expect(Math.atan2(b.origin.x, b.origin.y)).toBeCloseTo(1, 5);
  });

  it('a skeleton 1.2 m below you down the stairs: the spawn tilts toward its chest (0.45 m ahead, 0.85 m up)', () => {
    // ACE: caster (100, -36.15, -4.794), target (100, -34.70, -5.9975) in dungeon 0x0145 → spawnAhead 0.45, z +0.85.
    const b = boltLaunch({
      from: { x: 100, y: -36.1498, z: -4.7944 }, to: { x: 100, y: -34.7, z: -5.9975 },
      casterHeight: HUMAN.height, casterRadius: HUMAN.radius, casterPhysicsRadius: HUMAN.physicsRadius,
      targetHeight: SKELETON.height, targetRadius: SKELETON.radius,
    });
    expect(b.origin.y - -36.1498).toBeCloseTo(0.445, 2);
    expect(b.origin.z - -4.7944).toBeCloseTo(0.852, 2);
  });

  it('cylinderDistance is ACE Position.CylinderDistance (reach less both radii; height gaps above and below)', () => {
    const o = { x: 0, y: 0, z: 0 };
    expect(cylinderDistance(o, 0.68, 1.8, { x: 0, y: 1.6, z: 0 }, 0.71, 1.8)).toBeCloseTo(0.21, 2);
    // 3 m up: the vertical gap above your head counts with the reach.
    const up = cylinderDistance(o, 0.68, 1.8, { x: 0, y: 2, z: 3 }, 0.71, 1.8);
    expect(up).toBeCloseTo(Math.hypot(1.2, Math.hypot(2, 3) - 1.39), 5);
    // Overlapping both ways: negative.
    expect(cylinderDistance(o, 0.68, 1.8, { x: 0, y: 0.5, z: 0 }, 0.71, 1.8)).toBeLessThan(0);
  });
});

describe('ServerObjectManager.lineOfFire: the bolt\'s own path, door and all', () => {
  const SKEL = 0x80000080, DOOR = 0x70145010, PILLAR = 0x70000002;
  const makeSOM = (): ServerObjectManager => {
    const som = new ServerObjectManager({ loadSetupModel: (id: number) => (id === 0x02000059 ? { spheres: SKELETON_SPHERES, cylSpheres: [] } : null) } as never, {} as never, new THREE.Scene());
    som.missileLocalPlayer = () => ({ x: 100, y: 100, z: 0, radius: HUMAN.radius, height: HUMAN.height, physicsRadius: HUMAN.physicsRadius });
    som.missileEnvironmentSweep = () => null;
    return som;
  };
  const put = (som: ServerObjectManager, guid: number, y: number, over: Partial<ServerObject> = {}): void => {
    const o = {
      guid, name: 'Skeleton Warrior', itemType: ItemType.Creature, physicsState: 0, mesh: new THREE.Group(), setupId: 0x02000059,
      worldX: 100, worldZ: y, worldY: 0, collisionRadius: SKELETON.radius, collisionHeight: SKELETON.height, ...over,
    } as unknown as ServerObject;
    (som as unknown as { objects: Map<number, ServerObject> }).objects.set(guid, o);
  };
  /** A door leaf across x 99–101 at AC y = `plane`: the first point a sphere of `r` moving north touches it. */
  const doorSweep = (plane: number) => (o: ServerObject, from: { x: number; y: number }, to: { x: number; y: number }, r: number) => {
    if (o.guid !== DOOR && o.guid !== PILLAR) return null;
    const p = o.guid === DOOR ? plane : o.worldZ;
    if (to.y === from.y) return null;
    const t = (p - r - from.y) / (to.y - from.y);
    return t >= 0 && t <= 1 ? { t, normal: { x: 0, y: -1, z: 0 } } : null;
  };

  it('dungeon 0x0145\'s timed door, closed, with the skeleton pressed against it 1.55 m away: blocked by the Door', () => {
    // The live spot: the mage at the stair foot, the leaf 1.45 m north, our copy of the skeleton 0.1 m past it.
    const som = makeSOM();
    put(som, SKEL, 101.55);
    put(som, DOOR, 101.45, { name: 'Door', itemType: ItemType.Misc, setupId: 0x0200024f, collisionRadius: 0, collisionHeight: 0 });
    som.missileObjectSweep = doorSweep(101.45) as never;
    const r = som.lineOfFire(SKEL)!;
    expect(r.blockedAt).not.toBeNull();
    expect(r.blocker).toBe('Door');
    expect(r.blockedAt!).toBeCloseTo(1.35, 1);
  });

  it('the old eye-to-target line was blind there: the leaf sits in the 0.7 m it never swept', () => {
    // The previous sweep ran from 0.58 m along the eye (3/4 height) → target-middle line to 0.71 m short of the
    // target: at 1.55 m that ends 0.79 m out, short of the leaf at 1.45 m.
    const len = Math.hypot(1.55, HUMAN.height * 0.75 - SKELETON.height * 0.5);
    const oldEnd = (len - SKELETON.radius) * (1.55 / len);
    expect(oldEnd).toBeLessThan(1.45 - 0.1);
  });

  it('the same door open (ethereal), or no door: clear', () => {
    const som = makeSOM();
    put(som, SKEL, 101.55);
    som.missileObjectSweep = doorSweep(101.45) as never;
    expect(som.lineOfFire(SKEL)).toEqual({ dist: expect.closeTo(1.55, 5), blockedAt: null });
    put(som, DOOR, 101.45, { name: 'Door', itemType: ItemType.Misc, physicsState: 0x4 /* Ethereal */, collisionRadius: 0, collisionHeight: 0 });
    expect(som.lineOfFire(SKEL)?.blockedAt).toBeNull();
  });

  it('a door right against you (0.4 m ahead, behind the 0.58 m spawn point): the bolt can\'t see back to you', () => {
    const som = makeSOM();
    put(som, SKEL, 101.6);
    put(som, DOOR, 100.4, { name: 'Door', itemType: ItemType.Misc, collisionRadius: 0, collisionHeight: 0 });
    som.missileObjectSweep = doorSweep(100.4) as never;
    const r = som.lineOfFire(SKEL)!;
    expect(r.blocker).toBe('Door');
    expect(r.blockedAt!).toBeLessThan(0.58);
  });

  it('a wall or chest behind the target, or beside the path, is not in the way; other creatures never are', () => {
    const som = makeSOM();
    put(som, SKEL, 101.6);
    put(som, 0x80000081, 100.9, { name: 'Claude Bulwark' });
    put(som, PILLAR, 102.4, { name: 'Chest', itemType: ItemType.Container, collisionRadius: 0, collisionHeight: 0 });
    som.missileObjectSweep = doorSweep(999) as never;
    som.missileEnvironmentSweep = (from, to) => (to.y < 102.3 ? null : { t: (102.3 - from.y) / (to.y - from.y), normal: { x: 0, y: -1, z: 0 } });
    expect(som.lineOfFire(SKEL)?.blockedAt).toBeNull();
  });

  it('a spawn point already inside the target is a hit whatever is past it (ACE\'s world-entry collision)', () => {
    const som = makeSOM();
    put(som, SKEL, 100.9);
    put(som, DOOR, 101.3, { name: 'Door', itemType: ItemType.Misc, collisionRadius: 0, collisionHeight: 0 });
    som.missileObjectSweep = doorSweep(101.3) as never;
    expect(som.lineOfFire(SKEL)?.blockedAt).toBeNull();
  });

  it('down a ledge: the lip the spawn-to-chest line dips under blocks; 0.3 m nearer the edge it clears', () => {
    // You on a ledge top (z 0) whose edge is 1.3 m north; the skeleton 1.6 m north on the floor 2 m below. The bolt
    // spawns 0.94 m out at 0.77 m (tilted down at its chest) and meets the lip.
    const som = makeSOM();
    put(som, SKEL, 101.6, { worldY: -2 });
    som.missileObjectSweep = () => null;
    let edge = 101.3;
    som.missileEnvironmentSweep = (from, to, r) => {
      for (let i = 1; i <= 80; i++) {
        const t = i / 80, y = from.y + (to.y - from.y) * t, z = from.z + (to.z - from.z) * t;
        if (y < edge && z - r < 0) return { t, normal: { x: 0, y: 0, z: 1 } };
      }
      return null;
    };
    const r = som.lineOfFire(SKEL)!;
    expect(r.blocker).toBe('the floor or ground');
    expect(r.blockedAt!).toBeGreaterThan(0.94);
    expect(r.blockedAt!).toBeLessThan(1.3);
    edge = 101.0;
    expect(som.lineOfFire(SKEL)?.blockedAt).toBeNull();
  });
});

describe('a bolt that does nothing says what is in its way', () => {
  const SKEL = 0x80005001;
  let host: FakeHost;
  let api: AgentApi;
  let lof: { dist: number; blockedAt: number | null; blocker?: string };
  let castsSent: number;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host.spells = () => [{ id: 82, name: 'Flame Bolt III', school: 'War', level: 3, projectile: true, range: 20 }];
    host.add({ guid: SKEL, name: 'Skeleton Warrior', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 21.6 });
    host.me.mana = { current: 198, max: 198 };
    castsSent = 0;
    lof = { dist: 1.55, blockedAt: null };
    host.lineOfFire = () => lof;
    host.cast = (id: number, t: number | null) => {
      host.sent.push(`cast ${id} ${t === null ? 'self' : t.toString(16)}`);
      castsSent++;
      // The door shuts after the cast went out: the server eats the bolt and says nothing.
      lof = { dist: 1.55, blockedAt: 1.4, blocker: 'Door' };
      setTimeout(() => { api.pushChat('Casting Flame Bolt III', 0x11); api.pushChat('You say, "Zojak Quaguz"', 0x11); }, 300);
      return true;
    };
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  async function settle(p: Promise<AgentResult>, ms = 30_000): Promise<AgentResult> {
    let out: AgentResult | undefined;
    void p.then((r) => { out = r; });
    for (let t = 0; t < ms && out === undefined; t += 100) { run(api, host, 100); await vi.advanceTimersByTimeAsync(100); }
    if (!out) throw new Error('cast never answered');
    return out;
  }

  it('a single cast names the door', async () => {
    const r = await settle(api.cast('Flame Bolt III', SKEL));
    expect(castsSent).toBe(1);
    expect(r.message.split('\n')[1]).toBe('  no hit seen: no damage line came for it (Skeleton Warrior is 1.6 m away): Door 1.4 m from you is in the bolt\'s way (a monster can reach you through a closed door or grate; a bolt can\'t)');
  });

  it('a repeat\'s next cast is refused by the line of fire, naming the door', async () => {
    const r = await settle(api.cast('Flame Bolt III', SKEL, { repeat: true }));
    expect(castsSent).toBe(1);
    expect(r.message).toContain('  1: no hit seen: no damage line (Skeleton Warrior 1.6 m away): Door 1.4 m from you is in the bolt\'s way');
    expect(r.message).toMatch(/stopped: the cast was refused: Flame Bolt III not cast: no line of fire to Skeleton Warrior \(1\.6 m away\): Door 1\.4 m along the line would take the bolt/);
  });
});
