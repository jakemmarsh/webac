import * as THREE from 'three';
import { prepareSurfaceMesh } from '../models/MaterialFactory.js';
import type { SceneryPlacement } from './SceneryGenerator.js';
import { getPartPlacements } from '../models/SetupModelGroup.js';
import { PortalFileType } from '@ac/dat-parser/DatFileType.js';
import { datMissEpoch, noDatMissSince } from '@ac/dat-parser/streaming/DatMiss.js';

/**
 * CORE.14 / PERF.1 — instanced rendering for landscape scenery.
 *
 * Retail draws scenery per-landblock (CLandBlock scenery lists, drawn via
 * CObjCell::draw_visible), and our pre-instancing port mirrored that with one
 * THREE.Mesh per SetupModel part per placement — ~19.7k meshes / ~10.7k draw
 * calls outdoors (11 fps on a real GPU; the frame cost is CPU draw-call
 * submission, not rasterization).
 *
 * This class batches identical scenery models into THREE.InstancedMesh, one
 * per (GfxObj, surface submesh) per landblock. The instance matrices are the
 * exact per-placement transforms the un-batched path produced (same placement
 * PRNG, same ground snap, same base orientation × heading), the geometry and
 * materials are the exact ones ModelRenderer.createMesh builds, and batching
 * stays per-landblock so frustum-culling granularity matches the old
 * per-object behavior at landblock scale. Output pixels are identical — this
 * is a transparent submission-cost fix, not a fidelity change (see
 * docs/performance-budgets.md covenant).
 */

/** Structural slice of ModelRenderer this class needs (kept minimal for tests). */
export interface SceneryModelSource {
  /** Build a renderable group for a GfxObj — one child Mesh per surface. */
  createMesh(gfxObjId: number): THREE.Group | null;
}

/** Structural slice of SetupModelRenderer this class needs. */
export interface ScenerySetupSource {
  loadSetupModel(setupId: number): Parameters<typeof getPartPlacements>[0] | null;
}

/** One template submesh: shared geometry + shared (MaterialFactory-cached) material. */
export interface TemplateSubmesh {
  geometry: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
  /** The source sub-mesh's renderOrder (the clip band / batch order — MaterialFactory.prepareSurfaceMesh). */
  renderOrder?: number;
}

/** One (GfxObj, submesh) bucket of world-space instance matrices. */
export interface SubmeshInstances {
  gfxObjId: number;
  /** Index of the submesh within the GfxObj's template list. */
  tplIdx: number;
  template: TemplateSubmesh;
  matrices: THREE.Matrix4[];
  /** CORE.17.h.g.c.c.a — the owning object's origin (entry matrix
   *  translation) per matrix: CPhysicsObj::m_position for the degrade
   *  system's object-distance branch. */
  origins: THREE.Vector3[];
}

/** A GfxObj to instance at a model-local transform (part placement frame). */
interface PartEntry {
  gfxObjId: number;
  localMatrix: THREE.Matrix4;
}

const IDENTITY = new THREE.Matrix4();

/** One object to instance: any Setup/GfxObj id at a final world matrix. */
export interface InstanceEntry {
  objId: number;
  matrix: THREE.Matrix4;
}

export class SceneryInstancer {
  private modelSource: SceneryModelSource;
  private setupSource: ScenerySetupSource;

  /** gfxObjId → template submeshes (shared across all landblocks). Bounded by
   *  the number of distinct scenery GfxObjs in the loaded region (tens). */
  private templates = new Map<number, TemplateSubmesh[] | null>();
  /** objId (Setup or GfxObj) → flattened part list with local matrices. */
  private partLists = new Map<number, PartEntry[] | null>();

  constructor(modelSource: SceneryModelSource, setupSource: ScenerySetupSource) {
    this.modelSource = modelSource;
    this.setupSource = setupSource;
  }

  /** Whether a scenery objId resolves to at least one renderable part. */
  hasModel(objId: number): boolean {
    const parts = this.getPartList(objId);
    if (!parts || parts.length === 0) return false;
    return parts.some(p => (this.getTemplates(p.gfxObjId)?.length ?? 0) > 0);
  }

  /**
   * Compose the world matrix for one scenery placement — the same transform
   * the un-batched path applied via Object3D position/quaternion/scale.
   */
  static placementMatrix(
    p: SceneryPlacement,
    worldOffsetX: number,
    worldOffsetZ: number,
  ): THREE.Matrix4 {
    let quat: THREE.Quaternion;
    if (p.quat) {
      // The retail frame orientation (SceneryGenerator.sceneryFrameQuat —
      // GetObjFrame / ObjAlign → Frame::set_heading), AC Z-up → three Y-up.
      quat = new THREE.Quaternion(-p.quat.x, -p.quat.z, -p.quat.y, p.quat.w);
    } else {
      const baseRot = p.desc.baseLoc.orientation;
      const baseQuat = new THREE.Quaternion(-baseRot.x, -baseRot.z, -baseRot.y, baseRot.w);
      const headingQuat = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0), p.heading * Math.PI / 180,
      );
      quat = headingQuat.multiply(baseQuat);
    }
    return new THREE.Matrix4().compose(
      new THREE.Vector3(worldOffsetX + p.x, p.z, worldOffsetZ + p.y),
      quat,
      new THREE.Vector3(p.scale, p.scale, p.scale),
    );
  }

  /**
   * Build the instanced meshes for one landblock's scenery placements.
   * Returns Object3Ds ready to add to the scene; each is flagged
   * `userData.sharedResources` so landblock disposal must NOT dispose its
   * geometry/material (both are shared across landblocks).
   */
  buildLandblockInstances(
    placements: SceneryPlacement[],
    worldOffsetX: number,
    worldOffsetZ: number,
  ): THREE.Object3D[] {
    const entries: InstanceEntry[] = placements.map(p => ({
      objId: p.objId,
      matrix: SceneryInstancer.placementMatrix(p, worldOffsetX, worldOffsetZ),
    }));
    return this.buildInstances(entries, 'sceneryinst');
  }

  /**
   * CORE.14.a — generic instancing: batch arbitrary Setup/GfxObj placements
   * (each an objId at a final world matrix) into InstancedMeshes, one per
   * (GfxObj, surface submesh) across all entries. Used for landblock static
   * objects (wells, fences, carts) in addition to scenery; the caller keeps
   * batches per-landblock so culling granularity matches the un-batched path.
   */
  buildInstances(entries: InstanceEntry[], namePrefix: string): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    for (const { gfxObjId, template, matrices } of this.collectSubmeshInstances(entries)) {
      const inst = new THREE.InstancedMesh(template.geometry, template.material, matrices.length);
      inst.name = `${namePrefix}_${gfxObjId.toString(16).padStart(8, '0')}`;
      inst.userData.sharedResources = true;
      prepareSurfaceMesh(inst);
      inst.renderOrder = template.renderOrder ?? inst.renderOrder;
      for (let i = 0; i < matrices.length; i++) inst.setMatrixAt(i, matrices[i]);
      inst.instanceMatrix.needsUpdate = true;
      // Static scenery never re-writes matrices after build.
      inst.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      inst.computeBoundingSphere();
      out.push(inst);
    }
    return out;
  }

  /**
   * PERF.1 — bucket arbitrary Setup/GfxObj placements into per-(GfxObj,
   * submesh) world-matrix lists. Shared by the per-landblock builder above
   * and the cross-landblock SceneryInstancePool; the matrices are the exact
   * entry matrix × part placement frame products the un-batched path applied.
   */
  collectSubmeshInstances(entries: InstanceEntry[]): SubmeshInstances[] {
    // Bucket final matrices (+ owning-object origins) by gfxObjId.
    const buckets = new Map<number, { matrices: THREE.Matrix4[]; origins: THREE.Vector3[] }>();
    const scratch = new THREE.Matrix4();

    for (const e of entries) {
      const parts = this.getPartList(e.objId);
      if (!parts || parts.length === 0) continue;
      const origin = new THREE.Vector3().setFromMatrixPosition(e.matrix);
      for (const part of parts) {
        if ((this.getTemplates(part.gfxObjId)?.length ?? 0) === 0) continue;
        const final = scratch.multiplyMatrices(e.matrix, part.localMatrix).clone();
        let bucket = buckets.get(part.gfxObjId);
        if (!bucket) {
          bucket = { matrices: [], origins: [] };
          buckets.set(part.gfxObjId, bucket);
        }
        bucket.matrices.push(final);
        bucket.origins.push(origin);
      }
    }

    const out: SubmeshInstances[] = [];
    for (const [gfxObjId, { matrices, origins }] of buckets) {
      const templates = this.getTemplates(gfxObjId);
      if (!templates) continue;
      for (let tplIdx = 0; tplIdx < templates.length; tplIdx++) {
        out.push({ gfxObjId, tplIdx, template: templates[tplIdx], matrices, origins });
      }
    }
    return out;
  }

  /**
   * PERF.1 (building pooling) — world-space AABB for one placement of an
   * objId, equal to what `Box3.setFromObject(group)` returned on the
   * un-batched Object3D after position/quaternion were applied:
   * Box3.expandByObject copies each mesh's geometry bounding box and applies
   * the mesh's matrixWorld (= placement world matrix × part local matrix) —
   * the exact product used here. Lets building-shell footprints be computed
   * without instantiating per-object meshes. Returns null when the objId has
   * no renderable parts.
   */
  getWorldBBox(objId: number, worldMatrix: THREE.Matrix4): THREE.Box3 | null {
    const parts = this.getPartList(objId);
    if (!parts || parts.length === 0) return null;
    const out = new THREE.Box3();
    const box = new THREE.Box3();
    const partWorld = new THREE.Matrix4();
    let any = false;
    for (const part of parts) {
      const templates = this.getTemplates(part.gfxObjId);
      if (!templates) continue;
      partWorld.multiplyMatrices(worldMatrix, part.localMatrix);
      for (const tpl of templates) {
        if (tpl.geometry.boundingBox === null) tpl.geometry.computeBoundingBox();
        if (tpl.geometry.boundingBox === null) continue;
        box.copy(tpl.geometry.boundingBox).applyMatrix4(partWorld);
        out.union(box);
        any = true;
      }
    }
    return any ? out : null;
  }

  /**
   * Flatten a scenery objId (Setup 0x02… or GfxObj 0x01…) into GfxObj parts
   * with their model-local transforms — the same frames SetupModelRenderer
   * applies to its `part_N` children (AC Z-up → three Y-up swap included).
   */
  private getPartList(objId: number): PartEntry[] | null {
    const cached = this.partLists.get(objId);
    if (cached !== undefined) return cached;

    const epoch = datMissEpoch();
    let parts: PartEntry[] | null = null;
    const highByte = (objId >>> 24) & 0xff;
    if (highByte === PortalFileType.GraphicsObject) {
      parts = [{ gfxObjId: objId, localMatrix: IDENTITY.clone() }];
    } else if (highByte === PortalFileType.Setup) {
      const setup = this.setupSource.loadSetupModel(objId);
      if (setup) {
        parts = [];
        for (const placement of getPartPlacements(setup)) {
          const f = placement.frame;
          const pos = new THREE.Vector3(f.origin.x, f.origin.z, f.origin.y);
          const quat = new THREE.Quaternion(
            -f.orientation.x, -f.orientation.z, -f.orientation.y, f.orientation.w,
          );
          const scale = placement.scale
            ? new THREE.Vector3(placement.scale.x, placement.scale.z, placement.scale.y)
            : new THREE.Vector3(1, 1, 1);
          parts.push({
            gfxObjId: placement.gfxObjId,
            localMatrix: new THREE.Matrix4().compose(pos, quat, scale),
          });
        }
      }
    }
    // RELEASE.dat-streaming — never cache a part list built across a streamed-DAT miss.
    if (noDatMissSince(epoch)) this.partLists.set(objId, parts);
    return parts;
  }

  /**
   * CORE.17.h.g.c.c — public template access for the pool's degrade levels:
   * a LOD GfxObj is drawn through the same shared submesh templates as any
   * other GfxObj (and lists the identical surfaces as its level 0, so the
   * materials are the level-0 materials — CPhysicsPart::SetGfxObjArray).
   */
  templatesFor(gfxObjId: number): TemplateSubmesh[] | null {
    return this.getTemplates(gfxObjId);
  }

  /**
   * PERF.browser-memory-crash — forget the templates of GfxObjs no live mesh
   * draws (no pool family and no un-pooled mesh holds their geometry) and
   * free their geometry. The materials are MaterialFactory's (swept there).
   * Returns how many GfxObjs were released.
   */
  sweep(liveGeometries: ReadonlySet<THREE.BufferGeometry>): number {
    let released = 0;
    for (const [id, templates] of [...this.templates]) {
      if (!templates) continue;
      if (templates.some((t) => liveGeometries.has(t.geometry))) continue;
      this.templates.delete(id);
      for (const t of templates) t.geometry.dispose();
      released++;
    }
    return released;
  }

  /**
   * Template submeshes for a GfxObj: built once via ModelRenderer.createMesh
   * (identical surface split + materials to the un-batched path), then the
   * geometry/material pairs are shared by every InstancedMesh that renders
   * this GfxObj in any landblock.
   */
  private getTemplates(gfxObjId: number): TemplateSubmesh[] | null {
    const cached = this.templates.get(gfxObjId);
    if (cached !== undefined) return cached;

    const epoch = datMissEpoch();
    let templates: TemplateSubmesh[] | null = null;
    try {
      const group = this.modelSource.createMesh(gfxObjId);
      if (group) {
        templates = [];
        for (const child of group.children) {
          if (child instanceof THREE.Mesh) {
            templates.push({ geometry: child.geometry, material: child.material, renderOrder: child.renderOrder });
          }
        }
        if (templates.length === 0) templates = null;
      }
    } catch {
      templates = null;
    }
    if (noDatMissSince(epoch)) this.templates.set(gfxObjId, templates);
    return templates;
  }
}
