/**
 * MOVE.run-turn-collision-stop — the god-speed run-turn A/B (docs/movement-ab.md)
 * ran ours into Pathwarden Thorolf, an NPC standing at Holtburg 0xA9B40022
 * (97, 27, 94.005) with the human Setup 0x02000001 (two 0.48 m spheres).
 * Retail ran round him; ours slid for three frames and then stopped dead
 * against him while W was still held.
 *
 * Retail's sphere slide (`CSphere::slide_sphere @ 00536f40`, ACE
 * Sphere.SlideSphere; CylSphere.CollisionNormal for cylinders) takes the
 * collision normal from the body's CURRENT centre (`global_curr_center −
 * center`). DungeonCollision took it from the destination: once the body
 * touched the obstacle, the tangent of the destination's normal pointed
 * slightly back inside, the slide re-tested as a hit, and every step came
 * back [0, 0].
 *
 * Behavioural: the real DungeonCollision / OutdoorMovement.stepPlayerMovement
 * / CreatureCollision, and (DAT) the real human Setup's spheres.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import * as THREE from 'three';
import { DungeonCollision } from '../packages/renderer/src/world/DungeonCollision.js';
import { stepPlayerMovement, type MovementServices } from '../packages/renderer/src/player/OutdoorMovement.js';
import { addCreatureObstacles, type CreatureBlocker } from '../packages/renderer/src/world/CreatureCollision.js';
import { resolveObjectPhysics, type ObjectPhysicsModel } from '../packages/renderer/src/world/ObjectCollision.js';
import { TerrainCollision } from '../packages/shared/src/physics/TerrainCollision.js';
import { WaterMap } from '../packages/shared/src/physics/WaterMap.js';
import { DAT_PATHS, openDat } from './_harness/dat.js';

/** Holtburg 0xA9B4: landblock-local → world. */
const BX = 0xa9, BY = 0xb4;
const OX = BX * 192, OY = BY * 192;
const GROUND = 94;
/** Pathwarden Thorolf (wcid 33596), as the server created him. */
const THOROLF = { x: 97, y: 27, z: 94.005 };
/** Where the live run stopped dead (landblock-local), and the heading it kept turning through. */
const STUCK = { x: 97.537, y: 27.796 };
/** One live frame of the god-speed run: ~0.147 m. */
const STEP = 0.147;

const rad = (deg: number): number => (deg * Math.PI) / 180;
/** A compass heading's (east, north) step — THREE (x, z) in the outdoor world. */
const stepAt = (headingDeg: number, len = STEP): [number, number] => [Math.sin(rad(headingDeg)) * len, Math.cos(rad(headingDeg)) * len];

/** The human Setup's two body spheres (z 0.475 / 1.35, r 0.48) registered as Sphere obstacles. */
function humanSpheres(dc: DungeonCollision, key: string, x: number, y: number, z: number): void {
  dc.addSphereObstacle(`${key}:s0`, x, z + 0.475, y, 0.48);
  dc.addSphereObstacle(`${key}:s1`, x, z + 1.35, y, 0.48);
}

describe('a body resting against a round obstacle slides on (CSphere::slide_sphere: the current centre\'s normal)', () => {
  it('the live dead-stop: touching Thorolf and running 190°, the step slides instead of returning [0, 0]', () => {
    const dc = new DungeonCollision();
    humanSpheres(dc, 'thorolf', OX + THOROLF.x, OY + THOROLF.y, THOROLF.z);
    const pos = new THREE.Vector3(OX + STUCK.x, GROUND, OY + STUCK.y);
    for (const heading of [189, 190, 192, 193.8]) {
      const [dx, dz] = stepAt(heading);
      const [ax, az] = dc.getAdjustedMovement(pos, dx, dz);
      expect(Math.hypot(ax, az)).toBeGreaterThan(0.03);
      // The slide goes round him (east, still southward), never into him.
      expect(ax).toBeGreaterThan(0);
      expect(az).toBeLessThan(0);
      const before = Math.hypot(pos.x - OX - THOROLF.x, pos.z - OY - THOROLF.y);
      const after = Math.hypot(pos.x + ax - OX - THOROLF.x, pos.z + az - OY - THOROLF.y);
      expect(after).toBeGreaterThanOrEqual(before);
    }
  });

  it('a slide off a sphere or a cylinder never brings the body closer, whatever the heading', () => {
    const cases: Array<(dc: DungeonCollision) => void> = [
      (dc) => humanSpheres(dc, 'npc', 50, 50, 0),
      (dc) => dc.addCylinderObstacle('post', 50, 50, 0.48, 0, 2),
    ];
    for (const register of cases) {
      const dc = new DungeonCollision();
      register(dc);
      for (let b = 0; b < 360; b += 15) {
        // Body touching the obstacle (radius sum 0.96) on bearing b from its axis.
        const pos = new THREE.Vector3(50 + Math.sin(rad(b)) * 0.9602, 0, 50 + Math.cos(rad(b)) * 0.9602);
        for (let h = 0; h < 360; h += 10) {
          const [dx, dz] = stepAt(h);
          const [ax, az] = dc.getAdjustedMovement(pos, dx, dz);
          const before = Math.hypot(pos.x - 50, pos.z - 50);
          const after = Math.hypot(pos.x + ax - 50, pos.z + az - 50);
          expect(after).toBeGreaterThanOrEqual(before - 1e-9);
          // Heading into the obstacle but not straight at it: the tangent part survives.
          const into = -(Math.sin(rad(h)) * Math.sin(rad(b)) + Math.cos(rad(h)) * Math.cos(rad(b)));
          if (into > 0 && into < 0.95) expect(Math.hypot(ax, az)).toBeGreaterThan(0.001);
        }
      }
    }
  });
});

describe.skipIf(!existsSync(DAT_PATHS.portal))('MOVE.run-turn-collision-stop — the god-speed run-turn past Pathwarden Thorolf (real human Setup)', () => {
  let thorolfPhysics: ObjectPhysicsModel;
  let services: MovementServices;
  let collider: DungeonCollision;

  beforeAll(async () => {
    const portalDb = openDat(DAT_PATHS.portal);
    const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
    const { MaterialFactory } = await import('../packages/renderer/src/models/MaterialFactory.js');
    const { ModelRenderer } = await import('../packages/renderer/src/models/ModelRenderer.js');
    const { SetupModelRenderer } = await import('../packages/renderer/src/models/SetupModelRenderer.js');
    const mr = new ModelRenderer(portalDb, new MaterialFactory(portalDb, new TextureManager(portalDb)));
    const sr = new SetupModelRenderer(portalDb, mr);
    thorolfPhysics = resolveObjectPhysics(0x02000001, {
      loadSetupModel: (id) => sr.loadSetupModel(id),
      loadGfxObj: (id) => mr.loadGfxObj(id),
    })!;
    const blocker: CreatureBlocker = {
      guid: 0x8000b698, worldX: OX + THOROLF.x, worldY: THOROLF.z, worldZ: OY + THOROLF.y,
      collisionRadius: 0.48, setupId: 0x02000001,
      // His CreateObject frame (rw 0.168, rz −0.986): spheres sit on his axis, so only the position matters.
      quat: { w: 0.16847099, x: 0, y: 0, z: -0.98570698 }, scale: 1, physicsState: 0x600418,
    };
    const terrain = new TerrainCollision();
    terrain.setLandblock(BX, BY, { heights: new Array(81).fill(GROUND), blockX: BX, blockY: BY });
    const water = new WaterMap();
    water.setLandblock(BX, BY, new Array(256).fill(1)); // grassland, dry
    collider = new DungeonCollision();
    services = {
      dungeonCollision: null,
      outdoorCollision: collider,
      terrain,
      water,
      // main.ts's creatureObstacles: the blockers' shapes for one transition, then out again.
      creatureObstacles: (c, x, z, range) => {
        const near = Math.hypot(blocker.worldX - x, blocker.worldZ - z) <= range ? [blocker] : [];
        const keys = addCreatureObstacles(c as DungeonCollision, near, () => thorolfPhysics);
        return () => { for (const k of keys) (c as DungeonCollision).removeKey(k); };
      },
      defaultPlayerRadius: DungeonCollision.PLAYER_RADIUS,
      edgeSlide: true,
      stepDownHeight: 1.5,
    };
  });

  it('the obstacle is the human Setup\'s two 0.48 m spheres (no cylinder, no BSP)', () => {
    expect(thorolfPhysics.hasPhysicsBSP).toBe(false);
    expect(thorolfPhysics.cylSpheres).toHaveLength(0);
    expect(thorolfPhysics.spheres.map((s) => s.radius)).toEqual([expect.closeTo(0.48, 5), expect.closeTo(0.48, 5)]);
  });

  it('from the live contact point the run goes round him and on south, as retail did', () => {
    // The live frames from 2.04 s: (97.402, 27.877) at heading 185°, turning
    // right at ~129°/s until the key came up at 193.8°, W held to 2.7 s.
    let x = OX + 97.402, z = OY + 27.877;
    let heading = 185.1;
    let stuckFrames = 0, longestStuck = 0;
    for (let t = 2.04; t < 2.7; t += 0.0095) {
      if (heading < 193.8) heading = Math.min(193.8, heading + 129 * 0.0095);
      const [dx, dz] = stepAt(heading, 15.5 * 0.0095);
      const r = stepPlayerMovement({ x, z, floorY: GROUND, inDungeon: false, airborne: false, jumpVelocityX: 0, jumpVelocityZ: 0 }, dx, dz, 0.0095, services);
      const moved = Math.hypot(r.x - x, r.z - z);
      stuckFrames = moved < 1e-6 ? stuckFrames + 1 : 0;
      longestStuck = Math.max(longestStuck, stuckFrames);
      x = r.x; z = r.z;
      // Never inside him (feet spheres: radius sum 0.96 − EPSILON).
      expect(Math.hypot(x - OX - THOROLF.x, z - OY - THOROLF.y)).toBeGreaterThan(0.95);
    }
    expect(longestStuck).toBe(0);
    // Retail's resting point after the stop was landblock-local (97.26, 22.50);
    // the dead-stopped run never left y 27.8.
    expect(z - OY).toBeLessThan(24);
    expect(collider.cylinderCount + collider.sphereCount).toBe(0); // the transition took him out again
  });
});
