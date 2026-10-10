import * as THREE from 'three';
import type { DatDatabase } from '@ac/dat-parser/DatDatabase.js';
import { DatReader } from '@ac/dat-parser/DatReader.js';
import { SetupModel } from '@ac/dat-parser/file-types/SetupModel.js';
import { Animation } from '@ac/dat-parser/file-types/Animation.js';
import type { ModelRenderer } from './ModelRenderer.js';
import type { DegradeLod } from './DegradeLod.js';
import { getPartPlacements, PLACEMENT_RESTING } from './SetupModelGroup.js';
import { LruMap } from '../utils/LruMap.js';
import { wavePrefetch } from '../audio/WavePrefetch.js';

/**
 * SetupModelRenderer — assembles multi-part SetupModel into Three.js Group.
 * Loads SetupModel from portal.dat, creates child GfxObj meshes per part,
 * positions them using placement frames and parent hierarchy.
 */
/** A placement frame on a part mesh (AC Z-up to Three.js Y-up: swap Y and Z). */
function poseSetupPart(part: THREE.Object3D, frame: { origin: { x: number; y: number; z: number }; orientation: { w: number; x: number; y: number; z: number } }): void {
  part.position.set(frame.origin.x, frame.origin.z, frame.origin.y);
  part.quaternion.set(-frame.orientation.x, -frame.orientation.z, -frame.orientation.y, frame.orientation.w);
}

export class SetupModelRenderer {
  private portalDb: DatDatabase;
  private modelRenderer: ModelRenderer;
  // ASSESS: bounded leak backstop (fresh-eyes audit 2026-06-10). Parsed
  // SetupModels are small plain objects (a few KB); 2048 exceeds the distinct
  // creature/object models a long session touches, and a miss just re-parses
  // from the in-memory portal DAT. No disposal needed on evict — pure data.
  private setupCache = new LruMap<number, SetupModel>(2048);
  /** Parsed Setup DefaultAnimations (DAT statics' loops; StaticAnimationDriver). */
  private animationCache = new LruMap<number, Animation>(512);
  /** CORE.17.h.g.c.c — retail's per-part degrade (LOD) system; parts of
   *  every setup built here register with it (CPhysicsPart::SetPart →
   *  LoadGfxObjArray). Null = every part draws its level 0 only. */
  private degradeLod: DegradeLod | null = null;

  constructor(portalDb: DatDatabase, modelRenderer: ModelRenderer) {
    this.portalDb = portalDb;
    this.modelRenderer = modelRenderer;
  }

  /** Wire the degrade system (main.ts) — parts built afterwards get LOD chains. */
  setDegradeLod(lod: DegradeLod | null): void {
    this.degradeLod = lod;
  }

  /**
   * Load and parse a SetupModel from portal.dat.
   */
  loadSetupModel(setupId: number): SetupModel | null {
    const cached = this.setupCache.get(setupId);
    if (cached) return cached;

    const data = this.portalDb.getFileData(setupId);
    if (!data) return null;

    const setup = new SetupModel(new DatReader(data));
    this.setupCache.set(setupId, setup);
    return setup;
  }

  /** Load and parse an Animation (0x03…) from portal.dat; null when not readable (not cached). */
  loadAnimation(animId: number): Animation | null {
    const cached = this.animationCache.get(animId);
    if (cached) return cached;
    const data = this.portalDb.getFileData(animId);
    if (!data) return null;
    const anim = new Animation(new DatReader(data));
    this.animationCache.set(animId, anim);
    wavePrefetch().hooks(anim.partFrames); // SOUND.wave-precache
    return anim;
  }

  /**
   * Create a Three.js Group from a SetupModel ID.
   * Each part is a child GfxObj mesh positioned using placement frames.
   * Parts are assembled into a parent-child hierarchy if parentIndex exists.
   */
  createSetupMesh(setupId: number, placementKey: number = PLACEMENT_RESTING, buildingPass = false): THREE.Group | null {
    return this.createSetupMeshWithOverrides(setupId, placementKey, undefined, undefined, undefined, buildingPass);
  }

  /**
   * Create a setup mesh with ObjDesc-style overrides for character rendering.
   * partChanges: maps part index → replacement GfxObj ID
   * perPartTextureOverrides: maps part index → (old SurfaceTexture ID → new SurfaceTexture ID)
   *   In AC, each TextureMapChange has a partIndex — texture swaps only apply to that specific part.
   * paletteColors: composite palette for palette-indexed textures (applied globally to all parts)
   */
  createSetupMeshWithOverrides(
    setupId: number,
    placementKey: number = PLACEMENT_RESTING,
    partChanges?: Map<number, number>,
    perPartTextureOverrides?: Map<number, Map<number, number>>,
    paletteColors?: number[],
    /** A LandBlockInfo building's parts (ModelRenderer.createMesh `buildingPass`). */
    buildingPass = false,
  ): THREE.Group | null {
    const setup = this.loadSetupModel(setupId);
    if (!setup || setup.parts.length === 0) return null;

    const placements = getPartPlacements(setup, placementKey);

    const group = new THREE.Group();
    group.name = `setup_${setupId.toString(16).padStart(8, '0')}`;

    // Create a Three.js Object3D for each part
    const partObjects: (THREE.Object3D | null)[] = [];

    for (const placement of placements) {
      // Check for part replacement via AnimPartChange
      const gfxObjId = partChanges?.get(placement.partIndex) ?? placement.gfxObjId;

      // Get texture overrides for THIS specific part only (per ACE/ACViewer behavior)
      const partTexOverrides = perPartTextureOverrides?.get(placement.partIndex);

      const partMesh = this.modelRenderer.createMesh(gfxObjId, partTexOverrides, paletteColors, buildingPass);

      if (!partMesh) {
        partObjects.push(null);
        continue;
      }

      partMesh.name = `part_${placement.partIndex}`;
      // The part's GfxObj — CPhysics::AddGfxVelocity keys texture scroll by it
      // (PhysicsScriptPlayer, DECOMP.texture-velocity-shared).
      partMesh.userData.gfxObjId = gfxObjId;

      // CORE.17.h.g.c.c — CPhysicsPart::LoadGfxObjArray: a part GfxObj with
      // a DIDDegrade draws one of its chain's GfxObjs by viewer distance;
      // the level meshes are built lazily with this part's overrides/palette
      // (the level GfxObjs list the identical surfaces as level 0).
      if (this.degradeLod) {
        this.degradeLod.attachPart(partMesh, gfxObjId,
          (levelId) => this.modelRenderer.createMesh(levelId, partTexOverrides, paletteColors, buildingPass));
      }

      poseSetupPart(partMesh, placement.frame);

      // Apply scale if present (swap Y↔Z)
      if (placement.scale) {
        partMesh.scale.set(placement.scale.x, placement.scale.z, placement.scale.y);
      }

      partObjects.push(partMesh);
    }

    // Add all parts directly to root group with absolute positions.
    // Placement frame positions are in model-local (absolute) space,
    // NOT relative to parent. Parent indices define animation hierarchy
    // (for bone-based animation), not spatial nesting.
    for (let i = 0; i < partObjects.length; i++) {
      const obj = partObjects[i];
      if (!obj) continue;
      group.add(obj);
    }

    return group;
  }

  /**
   * CPhysicsObj::SetPlacementFrame on a built setup mesh: every part moves to
   * the placement's frame (a missing placement falls back to Default, as
   * getPartPlacements does). Parts are found by their `part_<index>` names.
   */
  posePlacement(group: THREE.Object3D, setupId: number, placementKey: number): boolean {
    const setup = this.loadSetupModel(setupId);
    if (!setup) return false;
    for (const placement of getPartPlacements(setup, placementKey)) {
      const part = group.getObjectByName(`part_${placement.partIndex}`);
      if (part && part.parent === group) poseSetupPart(part, placement.frame);
    }
    return true;
  }

  /**
   * Get the number of cached SetupModels.
   */
  get cacheSize(): number {
    return this.setupCache.size;
  }

  /**
   * Clear all cached SetupModel data.
   */
  clear(): void {
    this.setupCache.clear();
  }
}
