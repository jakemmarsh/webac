import type { GfxObj } from '@ac/dat-parser/file-types/GfxObj.js';
import type { SetupModel } from '@ac/dat-parser/file-types/SetupModel.js';
import { PortalFileType } from '@ac/dat-parser/DatFileType.js';
import { getPartPlacements } from '../models/SetupModelGroup.js';
import { DungeonCollision, type CollisionKey, type GfxObjCollisionOptions } from './DungeonCollision.js';
import { datMissEpoch, noDatMissSince } from '@ac/dat-parser/streaming/DatMiss.js';

/**
 * BUG.movement-pinned-south-holtburg-slope — the collision a static world
 * object (landscape scenery, landblock stab, building) presents, exactly as
 * ACE PhysicsObj.FindObjCollisions (Physics/PhysicsObj.cs:381-455) decides it
 * for a static object:
 *
 *  1. the object HasPhysicsBSP (PartArray.CacheHasPhysicsBSP, PhysicsObj.cs:
 *     263 — ANY part GfxObj carries a physics BSP) → collide with each part's
 *     BSP (PhysicsPart.FindObjCollisions, PhysicsPart.cs:52-59: the sphere is
 *     cached in the part's local space at GfxObjScale.Z);
 *  2. else the Setup has CylSpheres → one vertical cylinder per CylSphere
 *     (CylSphere.IntersectsSphere(pos, scale): LowPoint·scale carried into
 *     the object's frame, Height·scale, Radius·scale);
 *  3. else the Setup has Spheres → one sphere per Sphere (Sphere.
 *     IntersectsSphere(pos, scale): Center·scale in the frame, Radius·scale);
 *  4. else nothing — a BSP-less, cylsphere-less object is walk-through (most
 *     trees: bare GfxObj scenery goes through Setup.MakeSimpleSetup, which has
 *     no cylspheres/spheres).
 *
 * Coordinates are AC landblock-local (Z-up) with AC quaternions, like
 * DungeonCollision.addGfxObjCollision.
 */

export interface AcVec3 { x: number; y: number; z: number }
export interface AcQuat { w: number; x: number; y: number; z: number }

export interface ObjectCollisionSources {
  loadSetupModel(setupId: number): SetupModel | null;
  loadGfxObj(gfxObjId: number): GfxObj | null;
}

/** What FindObjCollisions / obj_within_block read off an object's part array. */
export interface ObjectPhysicsModel {
  parts: { gfx: GfxObj | null; frame: { origin: AcVec3; orientation: AcQuat }; defaultScale?: AcVec3 }[];
  /** PartArray.CacheHasPhysicsBSP — any part GfxObj has a physics BSP. */
  hasPhysicsBSP: boolean;
  cylSpheres: { origin: AcVec3; radius: number; height: number }[];
  spheres: { origin: AcVec3; radius: number }[];
  /** PartArray.GetSortingSphere (a simple GfxObj setup: its physics sphere, else its drawing sphere). */
  sortingSphere: { origin: AcVec3; radius: number };
}

const IDENTITY_FRAME = { origin: { x: 0, y: 0, z: 0 }, orientation: { w: 1, x: 0, y: 0, z: 0 } };

function bspSphere(gfx: GfxObj | null): { origin: AcVec3; radius: number } | null {
  const node = (gfx?.physicsBSP ?? gfx?.drawingBSP)?.rootNode as { sphere?: { origin: AcVec3; radius: number } } | undefined;
  return node?.sphere ?? null;
}

/**
 * Resolve an object id (GfxObj 0x01 or Setup 0x02) to its physics model.
 * Setup parts sit at the Resting placement frame (0x65, else Default — the
 * frame the renderer draws them at, SetupModelGroup.getPartPlacements).
 */
export function resolveObjectPhysics(objId: number, src: ObjectCollisionSources): ObjectPhysicsModel | null {
  const type = (objId >>> 24) & 0xff;
  if (type === PortalFileType.GraphicsObject) {
    const gfx = src.loadGfxObj(objId);
    if (!gfx) return null;
    // Setup.MakeSimpleSetup (ACE Physics/Setup.cs:110-133): one part, no
    // cylspheres / spheres, sorting sphere = physics sphere ?? drawing sphere.
    return {
      parts: [{ gfx, frame: IDENTITY_FRAME }],
      hasPhysicsBSP: !!gfx.physicsBSP,
      cylSpheres: [],
      spheres: [],
      sortingSphere: bspSphere(gfx) ?? { origin: { x: 0, y: 0, z: 0 }, radius: 0 },
    };
  }
  if (type === PortalFileType.Setup) {
    const setup = src.loadSetupModel(objId);
    if (!setup) return null;
    const parts = getPartPlacements(setup).map(p => ({
      gfx: src.loadGfxObj(p.gfxObjId),
      frame: p.frame,
      defaultScale: p.scale,
    }));
    return {
      parts,
      hasPhysicsBSP: parts.some(p => !!p.gfx?.physicsBSP),
      cylSpheres: setup.cylSpheres,
      spheres: setup.spheres,
      sortingSphere: setup.sortingSphere,
    };
  }
  return null;
}

function rotate(q: AcQuat, v: AcVec3): AcVec3 {
  // Same composition DungeonCollision uses (composeFrames with an identity child).
  return DungeonCollision.composeFrames({ x: 0, y: 0, z: 0 }, q, v, { w: 1, x: 0, y: 0, z: 0 }).origin;
}

function localToGlobal(origin: AcVec3, q: AcQuat, local: AcVec3, scale = 1): AcVec3 {
  const r = rotate(q, { x: local.x * scale, y: local.y * scale, z: local.z * scale });
  return { x: origin.x + r.x, y: origin.y + r.y, z: origin.z + r.z };
}

/** LandDefs::within_block (ACE LandDefs.InBlock, Common/LandDefs.cs:160). */
function withinBlock(p: AcVec3, radius: number): boolean {
  const BLOCK_LENGTH = 192;
  if (p.x < radius || p.y < radius) return false;
  const edge = BLOCK_LENGTH - radius;
  return p.x < edge && p.y < edge;
}

/**
 * `CPhysicsObj::obj_within_block @ 00511030` (ACE PhysicsObj.cs:2986) at the
 * object's unscaled frame: a BSP object's sorting sphere, every cylsphere's
 * low point (with its radius), a sphere object's sorting sphere, or else the
 * bare origin must lie inside the landblock.
 */
export function objWithinBlock(model: ObjectPhysicsModel, origin: AcVec3, quat: AcQuat): boolean {
  if (model.hasPhysicsBSP) {
    return withinBlock(localToGlobal(origin, quat, model.sortingSphere.origin), model.sortingSphere.radius);
  }
  if (model.cylSpheres.length > 0) {
    return model.cylSpheres.every(cs => withinBlock(localToGlobal(origin, quat, cs.origin), cs.radius));
  }
  if (model.spheres.length > 0) {
    return withinBlock(localToGlobal(origin, quat, model.sortingSphere.origin), model.sortingSphere.radius);
  }
  return withinBlock(origin, 0);
}

/**
 * Register an object's collision with `collision` per the FindObjCollisions
 * rules above. `keyFor(kind, index)` names each source ('p' part BSP,
 * 'c' cylsphere, 's' sphere). Returns every key registered, for removal.
 * `options.building` marks a building shell's part BSPs (LandblockInfo
 * buildings; BuildingObj::find_building_collisions' bldg_check).
 */
export function addObjectCollision(
  collision: DungeonCollision,
  keyFor: (kind: 'p' | 'c' | 's', index: number) => CollisionKey,
  model: ObjectPhysicsModel,
  origin: AcVec3,
  quat: AcQuat,
  scale: number,
  blockOffsetX: number,
  blockOffsetY: number,
  options: GfxObjCollisionOptions = {},
): CollisionKey[] {
  const keys: CollisionKey[] = [];
  if (model.hasPhysicsBSP) {
    for (let i = 0; i < model.parts.length; i++) {
      const part = model.parts[i];
      const gfx = part.gfx;
      if (!gfx?.physicsBSP || gfx.physicsPolygons.size === 0) continue;
      // Frame::combine(frame, part frame, Scale): the part's offset scales
      // with the object; its GfxObjScale = DefaultScale[i] · Scale (ACE
      // PartArray.SetScaleInternal) and the BSP test uses its Z.
      const partOrigin = localToGlobal(origin, quat, part.frame.origin, scale);
      const partQuat = DungeonCollision.composeFrames(origin, quat, { x: 0, y: 0, z: 0 }, part.frame.orientation).orientation;
      const partScale = (part.defaultScale?.z ?? 1) * scale;
      const key = keyFor('p', i);
      collision.addGfxObjCollision(key, gfx, partOrigin, partQuat, blockOffsetX, blockOffsetY, partScale, options);
      keys.push(key);
    }
    return keys;
  }
  if (model.cylSpheres.length > 0) {
    model.cylSpheres.forEach((cs, i) => {
      const low = localToGlobal(origin, quat, cs.origin, scale);
      const key = keyFor('c', i);
      collision.addCylinderObstacle(key, blockOffsetX + low.x, blockOffsetY + low.y, cs.radius * scale, low.z, low.z + cs.height * scale);
      keys.push(key);
    });
    return keys;
  }
  if (model.spheres.length > 0) {
    model.spheres.forEach((sp, i) => {
      const c = localToGlobal(origin, quat, sp.origin, scale);
      const key = keyFor('s', i);
      // AC (x, y, z-up) → world (x, height, z).
      collision.addSphereObstacle(key, blockOffsetX + c.x, c.z, blockOffsetY + c.y, sp.radius * scale);
      keys.push(key);
    });
    return keys;
  }
  return keys;
}

/** What a missile sweep reads off a server object: its Setup, physics origin (THREE world) and mesh frame. */
export interface MissileSweepObject {
  guid: number;
  setupId: number;
  worldX: number;
  worldY: number;
  worldZ: number;
  mesh: { quaternion: { x: number; y: number; z: number; w: number }; scale: { x: number } } | null;
}

/**
 * VERIFY.spell-projectile-arc-ring-dungeon — a non-creature server object's
 * own collision for a missile sweep (ServerObjectManager.missileObjectSweep):
 * its physics model — part BSPs, else CylSpheres, else Spheres, the
 * FindObjCollisions order above — at the object's frame and scale, in a
 * private DungeonCollision per object, rebuilt only when the object moves.
 * Sweeps are AC world axes in and out (x east, y north, z up); the object's
 * physics origin is THREE world (worldX, worldY = height, worldZ) and its
 * mesh quaternion THREE (x, y, z, w) = AC (−x, −z, −y, w).
 */
export function createServerObjectMissileSweep(physics: (setupId: number) => ObjectPhysicsModel | null): {
  sweep: (obj: MissileSweepObject, from: AcVec3, to: AcVec3, radius: number) => { t: number; normal: AcVec3 } | null;
  forget: (guid: number) => void;
} {
  const cache = new Map<number, { key: string; collision: DungeonCollision | null }>();
  return {
    sweep(obj, from, to, radius) {
      if (!obj.mesh) return null;
      const q = obj.mesh.quaternion, scale = obj.mesh.scale.x || 1;
      const key = `${obj.setupId}|${obj.worldX}|${obj.worldY}|${obj.worldZ}|${q.x}|${q.y}|${q.z}|${q.w}|${scale}`;
      let entry = cache.get(obj.guid);
      if (!entry || entry.key !== key) {
        const epoch = datMissEpoch();
        const model = physics(obj.setupId);
        let collision: DungeonCollision | null = null;
        if (model) {
          collision = new DungeonCollision();
          const keys = addObjectCollision(collision, (kind, i) => `${kind}${i}`, model,
            { x: obj.worldX, y: obj.worldZ, z: obj.worldY }, { w: q.w, x: -q.x, y: -q.z, z: -q.y }, scale, 0, 0);
          if (keys.length === 0) collision = null;
        }
        entry = { key, collision };
        // RELEASE.dat-streaming — a model built across a streamed miss (its
        // GfxObj physics BSP not resident yet) is not kept: the next sweep
        // builds it again instead of letting arrows pass through until the
        // object moves.
        if (noDatMissSince(epoch)) cache.set(obj.guid, entry);
        else cache.delete(obj.guid);
      }
      const hit = entry.collision?.sweepSphere({ x: from.x, y: from.z, z: from.y }, { x: to.x, y: to.z, z: to.y }, radius);
      return hit ? { t: hit.t, normal: { x: hit.normal.x, y: hit.normal.z, z: hit.normal.y } } : null;
    },
    forget(guid) { cache.delete(guid); },
  };
}
