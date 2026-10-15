/**
 * "About two-thirds of my casts were refused for line of fire" (Claude Arcanist, dungeon 0x0286 with Shore
 * Armoredillos and Hea Hunters, 2026-10-15): "no line of fire to Shore Armoredillo (3.1 m away): a wall 0.5 m along
 * the line would take the bolt", the same at 5.2 m / 0.7 m, 5.1 m / 0.4 m, … "a wall 0.5 m away blocks a dillo only
 * 3 m off, which looks odd".
 *
 * Checked against ACE's own physics (tools/ace-physics-harness: the live server image's ACE.Server.dll over our DATs,
 * WorldObject_Magic CalculateProjectileOrigins + LaunchSpellProjectiles → IsProjectileVisible + the flight): on 96,000
 * caster/target placements in that cave (grid 0286, 1 m and 0.5 m steps) our lineOfFire and ACE agree on 99.96%;
 * the 20 disagreements are corners grazed 1.2 m or more out, and EVERY refusal under 0.8 m (4,850) is one ACE drops
 * too. The refusals were right: the mage stood against a wall or a door jamb with the dillo round the corner, and ACE
 * starts the bolt 2 × (0.48 + 0.1) = 1.16 m ahead of you at two thirds of your height, past that wall; the spawn point
 * then can't see back to your eye (WorldObject.IsProjectileVisible) and the server drops the bolt as "hit the
 * environment", silently. Getting closer doesn't fix that; stepping off the wall does.
 *
 * So the refusal now says so (the wall is between you and where the bolt starts) and names the nearest spot within
 * 3 m with an open line (ServerObjectManager.openLineSpot), which ACE confirmed for all 436 spots it suggested in
 * those grids (tools/ace-physics-harness `pairs`).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import * as THREE from 'three';
import { ItemType } from '@ac/shared';
import { AgentApi, compassWord, parseOffset } from '../packages/renderer/src/agent/AgentApi.ts';
import type { AgentResult } from '../packages/renderer/src/agent/types.ts';
import { ServerObjectManager, type ServerObject } from '../packages/renderer/src/world/ServerObjectManager.js';
import { FakeHost, run } from './_harness/agentFake.ts';
import { DAT_PATHS, openDat } from './_harness/dat.ts';

const datPresent = existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.cell);

/** Landblock 0x0286's interior cells sit at (0x02 × 192, 0x86 × 192) + their local frame. */
const BX = 0x02 * 192, BY = 0x86 * 192;
/** The caster ACE placed at (72.929, −91.744, 0.005) in cell 0x028602F3 when asked for (73, −92): slid off the wall. */
const CASTER = { x: 72.929, y: -91.744, z: 0.005 };
/**
 * ACE's verdict (HIT: the bolt reached the armoredillo; MISS: it didn't) for every ninth target of that caster's grid
 * (local x, y, z of the target's feet, as ACE placed it), from `ALL=1 STEP=0.5 run.sh grid 0286 02000004 0.8 73 79 -94 -88 6`.
 */
const ACE_SHOTS: Array<[number, number, number, 'HIT' | 'MISS']> = [
  [68.804, -92.363, 0.008, 'HIT'], [69.314, -95.361, 0.008, 'HIT'], [68.500, -91.500, 0.008, 'HIT'], [69.246, -94.958, 0.008, 'HIT'],
  [68.706, -90.831, 0.008, 'HIT'], [69.500, -94.000, 0.008, 'HIT'], [70.000, -96.500, 0.008, 'MISS'], [70.000, -93.000, 0.008, 'HIT'],
  [70.500, -95.500, 0.008, 'MISS'], [70.040, -92.017, 0.008, 'HIT'], [70.754, -94.958, 0.008, 'MISS'], [71.693, -90.600, 0.008, 'HIT'],
  [70.768, -94.876, 0.008, 'MISS'], [71.500, -91.000, 0.008, 'HIT'], [71.113, -92.849, 0.008, 'HIT'], [72.500, -97.500, 0.008, 'MISS'],
  [73.570, -89.824, 0.008, 'HIT'], [73.000, -90.000, 0.008, 'HIT'], [73.500, -90.500, 0.008, 'HIT'], [73.872, -90.239, 0.008, 'HIT'],
  [73.114, -96.800, 0.008, 'MISS'], [74.800, -90.781, 0.008, 'HIT'], [75.000, -89.500, 0.008, 'HIT'], [76.300, -91.114, 0.008, 'HIT'],
  [75.500, -90.000, 0.008, 'HIT'], [76.800, -92.614, 0.008, 'MISS'], [76.000, -89.500, 0.008, 'HIT'], [76.500, -93.000, 0.008, 'MISS'],
  [76.500, -88.500, 0.008, 'HIT'], [77.000, -91.500, 0.008, 'MISS'], [77.500, -93.594, 0.008, 'MISS'], [77.500, -89.500, 0.008, 'HIT'],
  [78.000, -91.500, 0.008, 'MISS'], [78.500, -92.500, 0.008, 'MISS'],
];
const DILLO = 0x80000001;

describe.skipIf(!datPresent)('dungeon 0x0286: our bolt line of fire against ACE\'s, with the real cell geometry', () => {
  let som: ServerObjectManager;
  let me = { ...CASTER };
  const put = (x: number, y: number, z: number): void => {
    (som as unknown as { objects: Map<number, ServerObject> }).objects.set(DILLO, {
      guid: DILLO, name: 'Shore Armoredillo', itemType: ItemType.Creature, physicsState: 0, mesh: dilloMesh, setupId: 0x02000004,
      worldX: BX + x, worldZ: BY + y, worldY: z, collisionRadius: dilloSetup.radius * 0.8, collisionHeight: dilloSetup.height * 0.8,
    } as unknown as ServerObject);
  };
  let dilloSetup: { radius: number; height: number };
  const dilloMesh = new THREE.Group();
  dilloMesh.scale.setScalar(0.8); // Shore Armoredillo (wcid 2565): Setup 0x02000004, scale 0.8

  beforeAll(async () => {
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    const { SetupModel } = await import('../packages/dat-parser/src/file-types/SetupModel.js');
    const { DungeonCollision } = await import('../packages/renderer/src/world/DungeonCollision.js');
    const { EnvCellRenderer } = await import('../packages/renderer/src/world/EnvCellRenderer.js');
    const { SetupModelRenderer } = await import('../packages/renderer/src/models/SetupModelRenderer.js');
    const { ModelRenderer } = await import('../packages/renderer/src/models/ModelRenderer.js');
    const { MaterialFactory } = await import('../packages/renderer/src/models/MaterialFactory.js');
    const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
    const portal = openDat(DAT_PATHS.portal), cell = openDat(DAT_PATHS.cell);
    const mf = new MaterialFactory(portal, new TextureManager(portal));
    const mr = new ModelRenderer(portal, mf);
    const envRenderer = new EnvCellRenderer(portal, cell, mf, new SetupModelRenderer(portal, mr), mr);
    const dc = new DungeonCollision();
    for (let c = 0x100; c < 0x1000; c++) {
      const id = ((0x0286 << 16) | c) >>> 0;
      if (!cell.getFileData(id)) continue;
      const coll = envRenderer.getCellCollisionData(id);
      if (coll) dc.addCell(id, coll.cellStruct, coll.position);
    }
    const setup = (id: number) => new SetupModel(new DatReader(portal.getFileData(id)!));
    const dillo = setup(0x02000004), human = setup(0x02000001);
    dilloSetup = dillo;
    som = new ServerObjectManager({ loadSetupModel: (id: number) => (id === 0x02000004 ? dillo : null) } as never, {} as never, new THREE.Scene());
    // main.ts's in-dungeon sweep: the dungeon cells, AC ↔ THREE axes.
    som.missileEnvironmentSweep = (from, to, r) => {
      const h = dc.sweepSphere({ x: from.x, y: from.z, z: from.y }, { x: to.x, y: to.z, z: to.y }, r);
      return h ? { t: h.t, normal: { x: h.normal.x, y: h.normal.z, z: h.normal.y } } : null;
    };
    som.missileObjectSweep = () => null;
    som.missileLocalPlayer = () => ({ x: BX + me.x, y: BY + me.y, z: me.z, radius: human.radius, height: human.height, physicsRadius: human.spheres[0].radius });
  }, 120_000);

  it('agrees with ACE on every sampled shot from a caster pressed against the wall', () => {
    me = { ...CASTER };
    const wrong: string[] = [];
    for (const [x, y, z, ace] of ACE_SHOTS) {
      put(x, y, z);
      const r = som.lineOfFire(DILLO)!;
      if ((r.blockedAt === null) !== (ace === 'HIT')) wrong.push(`(${x}, ${y}) ACE ${ace}, ours ${r.blockedAt === null ? 'clear' : `blocked ${r.blockedAt}`}`);
    }
    expect(wrong).toEqual([]);
  });

  it('a dillo 6 m off round the corner: the wall is between you and the spawn point, as ACE\'s IsProjectileVisible finds', () => {
    // ACE: "realD=6.07 … spawnAhead=1.16 z=1.22 | NOT VISIBLE -> OnCollideEnvironment (silent)".
    me = { ...CASTER };
    put(71.0, -97.5, 0.008);
    const r = som.lineOfFire(DILLO)!;
    expect(r.dist).toBeCloseTo(6.07, 1);
    expect(r.blocker).toBe('a wall');
    expect(r.beforeSpawn).toBe(true);
    expect(r.spawnAhead).toBeCloseTo(1.2, 1);
    expect(r.blockedAt!).toBeLessThan(r.spawnAhead!);
  });

  it('names a spot ACE confirms: 1 m west, off the wall, the same bolt reaches it', () => {
    // ACE from (71.929, −91.744): "realD=5.83 … flight 0.27s moved 3.68 m -> [OnCollideObject(… target=creature …)]".
    me = { ...CASTER };
    put(71.0, -97.5, 0.008);
    expect(som.openLineSpot(DILLO)).toEqual({ dx: -1, dy: 0, dist: 1 });
    me = { x: CASTER.x - 1, y: CASTER.y, z: CASTER.z };
    expect(som.lineOfFire(DILLO)?.blockedAt).toBeNull();
  });

  it('an open line needs no spot; a dillo past the room\'s far corner gets one ACE confirms', () => {
    me = { ...CASTER };
    put(75.0, -89.5, 0.008); // ACE HIT
    expect(som.lineOfFire(DILLO)?.blockedAt).toBeNull();
    put(78.5, -92.5, 0.008); // ACE MISS from here …
    expect(som.lineOfFire(DILLO)?.blockedAt).not.toBeNull();
    // … and HIT from 1.5 m northeast: "cp=(74.036,-90.683,…) … -> [OnCollideObject(… target=creature …)]".
    expect(som.openLineSpot(DILLO)).toEqual({ dx: 1.1, dy: 1.1, dist: 1.5 });
  });
});

describe('ServerObjectManager.openLineSpot (synthetic walls)', () => {
  const T = 0x80000002;
  const make = (wall: (from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }, r: number) => { t: number; normal: { x: number; y: number; z: number } } | null): ServerObjectManager => {
    const som = new ServerObjectManager({ loadSetupModel: () => null } as never, {} as never, new THREE.Scene());
    som.missileLocalPlayer = () => ({ x: 100, y: 100, z: 0, radius: 0.68, height: 1.835, physicsRadius: 0.48 });
    som.missileObjectSweep = () => null;
    som.missileEnvironmentSweep = wall;
    (som as unknown as { objects: Map<number, ServerObject> }).objects.set(T, {
      guid: T, name: 'Drudge', itemType: ItemType.Creature, physicsState: 0, mesh: new THREE.Group(), setupId: 0,
      worldX: 100, worldZ: 106, worldY: 0, collisionRadius: 0.5, collisionHeight: 1.5,
    } as unknown as ServerObject);
    return som;
  };
  /** A floor at z 0 everywhere, plus a wall across y = 100.6 for x < `wallEnd` (the target 6 m north). */
  const floorAndWall = (wallEnd: number) => (from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }, r: number) => {
    for (let i = 1; i <= 100; i++) {
      const t = i / 100, x = from.x + (to.x - from.x) * t, y = from.y + (to.y - from.y) * t, z = from.z + (to.z - from.z) * t;
      if (z - r < 0) return { t: (i - 1) / 100, normal: { x: 0, y: 0, z: 1 } };
      if (x < wallEnd && Math.abs(y - 100.6) < r && z < 3) return { t: (i - 1) / 100, normal: { x: 0, y: -1, z: 0 } };
    }
    return null;
  };

  it('a wall in front ending 1 m east of you: the spot is east, past its end', () => {
    const som = make(floorAndWall(101));
    const lof = som.lineOfFire(T)!;
    expect(lof.beforeSpawn).toBe(true);
    const spot = som.openLineSpot(T)!;
    expect(spot.dx).toBeGreaterThan(1);
    expect(spot.dist).toBeLessThanOrEqual(3);
  });

  it('a wall too long to step round within 3 m: no spot', () => {
    expect(make(floorAndWall(200)).openLineSpot(T)).toBeNull();
  });

  it('no floor there (a drop): not a spot', () => {
    // The wall ends 1 m east, but east of x 100.4 the floor is 3 m down.
    const som = make((from, to, r) => {
      for (let i = 1; i <= 100; i++) {
        const t = i / 100, x = from.x + (to.x - from.x) * t, y = from.y + (to.y - from.y) * t, z = from.z + (to.z - from.z) * t;
        if (z - r < (x > 100.4 ? -3 : 0)) return { t: (i - 1) / 100, normal: { x: 0, y: 0, z: 1 } };
        if (x < 101 && Math.abs(y - 100.6) < r && z < 3) return { t: (i - 1) / 100, normal: { x: 0, y: -1, z: 0 } };
      }
      return null;
    });
    const spot = som.openLineSpot(T);
    expect(spot === null || spot.dx <= 0.4).toBe(true);
  });
});

describe('compassWord: an offset walk_to reads back', () => {
  it('each of the 8 points round-trips through parseOffset', () => {
    for (let i = 0; i < 8; i++) {
      const b = (i * Math.PI) / 4;
      const word = compassWord(Math.sin(b) * 1.5, Math.cos(b) * 1.5);
      expect(parseOffset(`1.5m ${word}`)).toEqual({ dist: 1.5, bearing: i * 45 });
    }
  });
});

describe('the cast refusal says the wall is at your side of the spawn point and where the line opens', () => {
  const DILLO_G = 0x80005002;
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host.spells = () => [{ id: 82, name: 'Flame Bolt III', school: 'War', level: 3, projectile: true, range: 20 }];
    host.add({ guid: DILLO_G, name: 'Shore Armoredillo', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 23.1 });
    host.me.mana = { current: 198, max: 198 };
    host.cast = () => { throw new Error('a refused cast must not go out'); };
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  async function settle(p: Promise<AgentResult>): Promise<AgentResult> {
    let out: AgentResult | undefined;
    void p.then((r) => { out = r; });
    for (let t = 0; t < 10_000 && out === undefined; t += 100) { run(api, host, 100); await vi.advanceTimersByTimeAsync(100); }
    if (!out) throw new Error('cast never answered');
    return out;
  }

  it('against a wall, with a spot: names both', async () => {
    host.lineOfFire = () => ({ dist: 3.1, blockedAt: 0.5, blocker: 'a wall', beforeSpawn: true, spawnAhead: 1.2 });
    host.lineOfFireOpenSpot = () => ({ dx: -1.5, dy: 0, dist: 1.5 });
    const r = await settle(api.cast('Flame Bolt III', DILLO_G));
    expect(r.ok).toBe(false);
    expect(r.message).toBe('Flame Bolt III not cast: no line of fire to Shore Armoredillo (3.1 m away): a wall 0.5 m from you, between you and where the bolt starts (1.2 m ahead of you), would take it: you are against a wall or corner on that side. The line is open from 1.5 m west of you (walk_to "1.5m west"), if it stays put. Then cast.');
  });

  it('a wall further out, no spot: the old advice', async () => {
    host.lineOfFire = () => ({ dist: 12, blockedAt: 3.2, blocker: 'Bookshelf' });
    host.lineOfFireOpenSpot = () => null;
    const r = await settle(api.cast('Flame Bolt III', DILLO_G));
    expect(r.message).toBe('Flame Bolt III not cast: no line of fire to Shore Armoredillo (12.0 m away): Bookshelf 3.2 m along the line would take the bolt. No spot within 3 m of you has an open line: go round the corner, into its room, or let it come to you. Then cast.');
  });
});
