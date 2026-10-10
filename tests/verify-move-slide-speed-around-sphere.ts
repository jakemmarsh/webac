/**
 * MOVE.slide-speed-around-sphere — in the god-speed run-turn A/B
 * (docs/movement-ab.md, finding 12) retail went round Pathwarden Thorolf
 * (Holtburg 0xA9B40022 (97, 27, 94.005), human Setup 0x02000001: two 0.48 m
 * spheres) at about 7.7 m/s; ours ran past him at ~13.7 m/s and stopped ~4 m
 * further on. Two retail rules ours lacked:
 *
 * 1. The sliding normal. CTransition::find_transitional_position runs every
 *    step's offset through CTransition::adjust_offset @ 0050a370: while the
 *    sliding normal is valid and the step pushes into it, the offset is
 *    projected onto the slide line; a step that does not push into it clears
 *    it. validate_transition @ 0050aa70 then makes the transition's collision
 *    normal (kept for the whole transition: COLLISIONINFO::init only runs when
 *    one starts) the sliding normal, and the player carries it into its next
 *    transition (CPhysicsObj::get_object_info → init_sliding_normal). Off a
 *    round obstacle the step after a slide follows the old tangent, which
 *    leads away from it, and the next hits it again.
 * 2. The heading the step moves along. CSequence::apply_physics @ 00524ab0
 *    adds velocity × quantum to the offset frame before rotating it, and
 *    UpdatePositionInternal's Frame::combine @ 005122e0 turns the offset by
 *    the pre-update rotation: a running turn moves along the heading the
 *    update began with. Ours moved along the turned heading, a tighter arc.
 *
 * Behavioural: the real DungeonCollision, OutdoorMovement.stepPlayerMovement,
 * CameraController, CharacterAnimController / MotionManager (DAT) and the A9B4
 * building + terrain (DAT).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import * as THREE from 'three';
import { DungeonCollision } from '../packages/renderer/src/world/DungeonCollision.js';
import { stepPlayerMovement, type MovementServices, type SlideState } from '../packages/renderer/src/player/OutdoorMovement.js';
import { CameraController } from '../packages/renderer/src/scene/CameraController.js';
import { yawForHeading, headingForYaw } from '../packages/renderer/src/world/Heading.js';
import { TerrainCollision } from '../packages/shared/src/physics/TerrainCollision.js';
import { WaterMap } from '../packages/shared/src/physics/WaterMap.js';
import { DAT_PATHS, openDat } from './_harness/dat.js';

const rad = (deg: number): number => (deg * Math.PI) / 180;
/** A compass heading's (east, north) step — THREE (x, z) in the outdoor world. */
const stepAt = (headingDeg: number, len: number): [number, number] => [Math.sin(rad(headingDeg)) * len, Math.cos(rad(headingDeg)) * len];

/** The human Setup's two body spheres (z 0.475 / 1.35, r 0.48) as Sphere obstacles. */
function humanSpheres(dc: DungeonCollision, x: number, y: number, z: number): void {
  dc.addSphereObstacle('npc:s0', x, z + 0.475, y, 0.48);
  dc.addSphereObstacle('npc:s1', x, z + 1.35, y, 0.48);
}

/** A flat, dry landblock 0x0000 at height 0 around (50, 50), the obstacle registered in the collider. */
function flatServices(collider: DungeonCollision, slide?: SlideState): MovementServices {
  const terrain = new TerrainCollision();
  terrain.setLandblock(0, 0, { heights: new Array(81).fill(0), blockX: 0, blockY: 0 });
  const water = new WaterMap();
  water.setLandblock(0, 0, new Array(256).fill(1));
  return {
    dungeonCollision: null, outdoorCollision: collider, terrain, water, creatureObstacles: null,
    defaultPlayerRadius: DungeonCollision.PLAYER_RADIUS, edgeSlide: true, stepDownHeight: 1.5, slide,
  };
}

const ground = (x: number, z: number) => ({ x, z, floorY: 0, inDungeon: false, airborne: false, jumpVelocityX: 0, jumpVelocityZ: 0 });

describe('the sliding normal (CTransition::adjust_offset / validate_transition)', () => {
  it('a slide off a sphere leaves its normal; the next step follows that tangent and, clear of the sphere, drops it', () => {
    const dc = new DungeonCollision();
    humanSpheres(dc, 50, 50, 0);
    const slide: SlideState = { slidingNormal: null };
    const sv = flatServices(dc, slide);
    // Touching him north-north-east of his axis, running south (heading 180°).
    const bearing = rad(20);
    let x = 50 + Math.sin(bearing) * 0.962, z = 50 + Math.cos(bearing) * 0.962;
    const [dx, dz] = stepAt(180, 0.14);
    let r = stepPlayerMovement(ground(x, z), dx, dz, 0.0095, sv);
    // The first step slid (round his east side) and set the sliding normal: his radial normal where the body was.
    expect(r.x).toBeGreaterThan(x);
    expect(slide.slidingNormal).not.toBeNull();
    const n = slide.slidingNormal!;
    expect(n.x).toBeCloseTo(Math.sin(bearing), 3);
    expect(n.z).toBeCloseTo(Math.cos(bearing), 3);
    x = r.x; z = r.z;
    // The second step is projected onto the old tangent before it is tried:
    // no component along the old normal, and it leads away from him, so
    // nothing is hit and the sliding normal is cleared.
    r = stepPlayerMovement(ground(x, z), dx, dz, 0.0095, sv);
    const mx = r.x - x, mz = r.z - z;
    expect(Math.abs(mx * n.x + mz * n.z)).toBeLessThan(1e-9);
    expect(Math.hypot(mx, mz)).toBeGreaterThan(0.01);
    expect(Math.hypot(r.x - 50, r.z - 50)).toBeGreaterThan(Math.hypot(x - 50, z - 50));
    expect(slide.slidingNormal).toBeNull();
  });

  it('a step that no longer pushes into the sliding normal is not projected', () => {
    const dc = new DungeonCollision();
    const slide: SlideState = { slidingNormal: { x: 1, z: 0 } };
    const sv = flatServices(dc, slide);
    // offset · normal > 0: adjust_offset drops the normal and keeps the offset.
    const r = stepPlayerMovement(ground(50, 50), 0.1, -0.1, 0.0095, sv);
    expect(r.x - 50).toBeCloseTo(0.1, 9);
    expect(r.z - 50).toBeCloseTo(-0.1, 9);
    expect(slide.slidingNormal).toBeNull();
  });

  it('the collision normal holds for the whole transition: a later clear step still ends with it as the sliding normal', () => {
    const dc = new DungeonCollision();
    humanSpheres(dc, 50, 50, 0);
    const slide: SlideState = { slidingNormal: null };
    const sv = flatServices(dc, slide);
    // A 0.9 m move is two transition steps (calc_num_steps: radius 0.48). The
    // first grazes his east side and slides; the second is clear.
    const x0 = 50 + 0.9, z0 = 50 + 0.5;
    const r = stepPlayerMovement(ground(x0, z0), 0, -0.9, 0.06, sv);
    expect(r.z).toBeLessThan(z0);
    expect(slide.slidingNormal).not.toBeNull();
    expect(slide.slidingNormal!.x).toBeGreaterThan(0.5); // his east side's normal
  });

  it('going round a sphere nearly head-on loses more ground with the sliding normal than with a fresh slide every step', () => {
    const run = (slide?: SlideState): number => {
      const dc = new DungeonCollision();
      humanSpheres(dc, 50, 50, 0);
      const sv = flatServices(dc, slide);
      // Running south at 14.9 m/s from 1.5 m north of him, 0.15 m east of his axis.
      let x = 50.15, z = 51.5;
      for (let i = 0; i < 30; i++) {
        const [dx, dz] = stepAt(180, 14.9 * 0.02);
        const r = stepPlayerMovement(ground(x, z), dx, dz, 0.02, sv);
        x = r.x; z = r.z;
        expect(Math.hypot(x - 50, z - 50)).toBeGreaterThan(0.95);
      }
      return z;
    };
    const withSlidingNormal = run({ slidingNormal: null });
    const fresh = run();
    // Both get round him and on south.
    expect(withSlidingNormal).toBeLessThan(49);
    expect(withSlidingNormal).toBeGreaterThan(fresh); // further north = less ground covered
  });
});

describe('CameraController: a running turn moves along the heading the update began with (Frame::combine)', () => {
  it('the step is the sequence offset at the start-of-update heading, and the turn shows in the next update', () => {
    const cam = new CameraController(new THREE.PerspectiveCamera());
    cam.sequenceStep = () => ({ x: 0, y: 0.5 }); // 0.5 m straight ahead per update
    cam.playerYaw = yawForHeading(0); // north
    cam.simulateKeyDown('KeyW');
    cam.simulateKeyDown('KeyD'); // turning right
    const p = cam.camera.position;
    const x0 = p.x, z0 = p.z;
    cam.update(0.1);
    const h1 = headingForYaw(cam.playerYaw);
    expect(h1).toBeGreaterThan(1); // it turned
    // ... but this update's 0.5 m went due north (scene +z here, as stepAt's (east, north)).
    expect(p.x - x0).toBeCloseTo(0, 9);
    expect(p.z - z0).toBeCloseTo(0.5, 9);
    const x1 = p.x, z1 = p.z;
    cam.update(0.1);
    // The next update moves along the heading the first one ended on.
    const [ex, en] = stepAt(h1, 0.5);
    expect(p.x - x1).toBeCloseTo(ex, 9);
    expect(p.z - z1).toBeCloseTo(en, 9);
  });
});

/** Holtburg 0xA9B4 landblock-local → world. */
const BX = 0xa9, BY = 0xb4;
const OX = BX * 192, OY = BY * 192;
/** The run-turn's start (landblock-local) and Pathwarden Thorolf. */
const START = { x: 85, y: 20.5 };
const THOROLF = { x: 97, y: 27, z: 94.005 };
/**
 * Retail's wire for the god-speed run-turn (relay capture, tag `god`): the
 * MoveToStates at 46 (W), 630 (D), 2114 (D up), 2722 (W up) ms and the
 * AutonomousPositions, as (east, north) from the start.
 */
const RETAIL = {
  t630: [0, 7.97], t1689: [11.14, 12.71], t2114: [12.34, 7.73], t2671: [12.57, 3.42], t2722: [12.43, 2.77],
} as const;

describe.skipIf(!existsSync(DAT_PATHS.portal) || !existsSync(DAT_PATHS.cell))('the god-speed run-turn past Thorolf against the retail wire (A9B4 terrain, building 0x01000C17, the Cooking Forge, Thorolf; DAT)', () => {
  let world: {
    services: (slide?: SlideState) => MovementServices;
    newMover: () => { cam: CameraController; tick: (dt: number) => void };
  };

  beforeAll(async () => {
    const portalDb = openDat(DAT_PATHS.portal);
    const cellDb = openDat(DAT_PATHS.cell);
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    const { RegionDesc, CellLandblock, LandblockInfo } = await import('@ac/dat-parser');
    const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
    const { MaterialFactory } = await import('../packages/renderer/src/models/MaterialFactory.js');
    const { ModelRenderer } = await import('../packages/renderer/src/models/ModelRenderer.js');
    const { SetupModelRenderer } = await import('../packages/renderer/src/models/SetupModelRenderer.js');
    const { resolveObjectPhysics, addObjectCollision } = await import('../packages/renderer/src/world/ObjectCollision.js');
    const { addCreatureObstacles } = await import('../packages/renderer/src/world/CreatureCollision.js');
    const { MotionManager } = await import('../packages/renderer/src/animation/MotionManager.js');
    const { CharacterAnimController } = await import('../packages/renderer/src/animation/CharacterAnimController.js');
    const { localSequenceStep } = await import('../packages/renderer/src/player/LocalSequenceStep.js');
    const { getClientRunRate } = await import('@ac/shared');

    const mr = new ModelRenderer(portalDb, new MaterialFactory(portalDb, new TextureManager(portalDb)));
    const sr = new SetupModelRenderer(portalDb, mr);
    const src = { loadSetupModel: (id: number) => sr.loadSetupModel(id), loadGfxObj: (id: number) => mr.loadGfxObj(id) };
    const region = new RegionDesc(new DatReader(portalDb.getFileData(0x13000000)!));
    const table = (region as any).landDefs?.landHeightTable ?? (region as any).landHeightTable;
    const terrain = new TerrainCollision();
    const lbId = ((BX << 24) | (BY << 16) | 0xffff) >>> 0;
    const lb = CellLandblock.read(new DatReader(cellDb.getFileData(lbId)!));
    terrain.setLandblock(BX, BY, { heights: lb.heights.map((h: number) => table[h]), blockX: BX, blockY: BY });
    const water = new WaterMap();
    water.setLandblock(BX, BY, new Array(256).fill(1));
    const collider = new DungeonCollision();
    const info = new LandblockInfo(new DatReader(cellDb.getFileData(((lbId & 0xffff0000) | 0xfffe) >>> 0)!));
    const bldg = info.buildings.find((b: any) => b.modelId === 0x01000c17)!;
    addObjectCollision(collider, (k, j) => `b${k}${j}` as any, resolveObjectPhysics(bldg.modelId, src)!, bldg.frame.origin, bldg.frame.orientation, 1, OX, OY);
    const thorolf = {
      guid: 0x8000b698, worldX: OX + THOROLF.x, worldY: THOROLF.z, worldZ: OY + THOROLF.y,
      collisionRadius: 0.48, setupId: 0x02000001,
      quat: { w: 0.16847099, x: 0, y: 0, z: -0.98570698 }, scale: 1, physicsState: 0x600418,
    };
    // The Cooking Forge (0x8000B490, Setup 0x0200124B at scale 1.4: one
    // 2.05 m CylSphere) the turn's arc grazes north of the start.
    const forge = {
      guid: 0x8000b490, worldX: OX + 91.519, worldY: 94, worldZ: OY + 37.745,
      collisionRadius: 2.048, setupId: 0x0200124b,
      quat: { w: 0, x: 0, y: 0, z: -1 }, scale: 1.4, physicsState: 0x600418,
    };
    const blockers = [thorolf, forge];
    world = {
      services: (slide) => ({
        dungeonCollision: null, outdoorCollision: collider, terrain, water,
        creatureObstacles: (c, x, z, range) => {
          const near = blockers.filter((b) => Math.hypot(b.worldX - x, b.worldZ - z) <= range);
          const keys = addCreatureObstacles(c as DungeonCollision, near, (id) => resolveObjectPhysics(id, src));
          return () => { for (const k of keys) (c as DungeonCollision).removeKey(k); };
        },
        defaultPlayerRadius: DungeonCollision.PLAYER_RADIUS, edgeSlide: true, stepDownHeight: 0.6, slide,
      }),
      newMover: () => {
        const mm = new MotionManager(portalDb as any);
        mm.loadMotionTable(0x09000001);
        mm.setDefaultStance(1);
        const anim = new CharacterAnimController(mm);
        const rr = getClientRunRate(0, 15225); // the @god'd mover: Run 15225, ~14.9 m/s
        anim.runRate = rr;
        const cam = new CameraController(new THREE.PerspectiveCamera());
        cam.runRate = rr;
        cam.sequenceStep = (dt, st) => localSequenceStep({ motionManager: mm, update: (d: number, m: any) => mm.update(d, m) } as any, dt, st);
        cam.playerYaw = yawForHeading(0);
        return { cam, tick: (dt: number) => anim.update(dt, cam) };
      },
    };
  });

  /**
   * Retail's player moves once per physics update (CPhysics::UseTime @ 00509950
   * runs update_object only after MIN_QUANTUM = 1/30 s); in this recording the
   * updates were 48 ms apart (2671 → 2722 ms: 0.665 m at 14.9 m/s is one 45 ms
   * update). Driving ours at the same 48 ms updates isolates the collision and
   * heading rules from the update rate. Positions are the last update at or
   * before each wire time, as the MoveToState / AutonomousPosition carry.
   */
  function run(slide?: SlideState): Record<string, [number, number]> & { cross24: number } {
    const sv = world.services(slide);
    const { cam, tick } = world.newMover();
    const keys: [number, 'down' | 'up', string][] = [[46, 'down', 'KeyW'], [630, 'down', 'KeyD'], [2114, 'up', 'KeyD'], [2722, 'up', 'KeyW']];
    const DT = 0.048;
    let x = OX + START.x, z = OY + START.y;
    const at: Record<string, [number, number]> = {};
    const marks = [630, 1689, 2114, 2671, 2722];
    let cross24 = NaN;
    let ki = 0;
    let last: [number, number] = [0, 0];
    for (let t = DT; t < 3.8; t += DT) {
      for (const m of marks) if (!at[`t${m}`] && t * 1000 > m + 0.5) at[`t${m}`] = last;
      while (ki < keys.length && keys[ki][0] / 1000 <= t) {
        const [, d, k] = keys[ki++];
        if (d === 'down') cam.simulateKeyDown(k); else cam.simulateKeyUp(k);
      }
      const p = cam.camera.position;
      p.set(x, 94, z);
      cam.update(DT);
      tick(DT);
      const r = stepPlayerMovement({ x, z, floorY: 94, inDungeon: false, airborne: false, jumpVelocityX: 0, jumpVelocityZ: 0 }, p.x - x, p.z - z, DT, sv);
      x = r.x; z = r.z;
      last = [x - OX - START.x, z - OY - START.y];
      if (isNaN(cross24) && t > 2 && z - OY < 24) cross24 = t;
      // Never inside Thorolf.
      expect(Math.hypot(x - OX - THOROLF.x, z - OY - THOROLF.y)).toBeGreaterThan(0.95);
    }
    return Object.assign(at, { cross24 });
  }

  it('with the sliding normal ours follows retail\'s track round him: every wire point within 0.35 m, the y = 24 cell crossing in the same update', () => {
    const ours = run({ slidingNormal: null });
    for (const [k, [rx, ry]] of Object.entries(RETAIL)) {
      const [ox, oy] = ours[k];
      expect(Math.hypot(ox - rx, oy - ry), `${k}: ours (${ox.toFixed(2)}, ${oy.toFixed(2)}) vs retail (${rx}, ${ry})`).toBeLessThan(0.35);
    }
    // Retail's AutonomousPosition at 2671 ms went out for the cell change at y = 24 (local f 3.5).
    expect(ours.cross24 * 1000).toBeGreaterThan(2635);
    expect(ours.cross24 * 1000).toBeLessThanOrEqual(2671 + 1);
  });

  it('without it (a fresh tangent slide every step) ours runs round him ~2 m ahead of retail by 2671 ms', () => {
    const ours = run(undefined);
    const [ox, oy] = ours.t2671;
    expect(Math.hypot(ox - RETAIL.t2671[0], oy - RETAIL.t2671[1])).toBeGreaterThan(1.5);
    expect(ours.cross24 * 1000).toBeLessThan(2600);
  });
});
