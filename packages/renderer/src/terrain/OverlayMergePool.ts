import * as THREE from 'three';
import { applyPortalPunchMask } from '../world/PortalPunch.js';
import { freezeStaticTransform } from '../utils/freezeStatic.js';
import type { OverlayQuadBucket } from './TerrainRenderer.js';

/** Rot0 corner UVs in overlay-quad vertex order SW, SE, NW, NE. */
/** SW, SE, NW, NE at ROT_0 = CLandBlockStruct::land_uvs (row 0 = north), i.e. cellAlphaUVs(0). */
const UNROTATED_QUAD_UVS = [0, 1, 1, 1, 0, 0, 1, 0];

/**
 * PERF.1 — cross-landblock terrain overlay pool.
 *
 * CORE.14.c merged road/blend overlay quads per landblock (one Mesh per
 * (layer, base texture, alpha map) bucket), but with ~49 loaded landblocks
 * that still cost ~533 blendmerge + roadmerge draw calls at town-facing
 * headings. Region-wide the DISTINCT bucket keys number only a few dozen, so
 * this pool concatenates every landblock's quads for a key into ONE Mesh.
 *
 * Correctness invariants (why draw order still works):
 * - Overlay quads from different landblocks never overlap in 3D — each lies
 *   flat on its own terrain cells — so inter-block draw order is irrelevant;
 *   only intra-cell stacking matters (blend layer 0 under layer 1 under
 *   roads), exactly as in the per-landblock scheme.
 * - That stacking is pinned by renderOrder = overlayRenderOrder(rank).
 *   BUG.road-flicker-running: three.js (WebGLRenderer.projectObject, r160 through r186)
 *   sorts transparent meshes by the projected GEOMETRY bounding-sphere
 *   centre, not the object position — every merged bucket has its own centre,
 *   so the old "identical depth → id (creation) order" tie-break never held:
 *   blend layers re-sorted over the roads as the camera moved and the roads
 *   flickered in and out. renderOrder is compared before depth, so rank now
 *   decides regardless of camera position.
 * - Full-road cells use the opaque road material: depth-tested with polygon
 *   offset, pass-order independent.
 */

/** Pool meshes draw in the transparent pass after the before-sky objects
 *  (renderOrder -100 / -50+i, SkyboxRenderer) and before every other
 *  transparent object (0): ground overlays are the farthest transparent
 *  layer, and rank / 1000 keeps all ranks (< 200) inside (-1, -0.8). */
export function overlayRenderOrder(rank: number): number {
  return -1 + rank / 1000;
}

/** A landblock's contribution to one pool bucket: world-space quad geometry
 *  (same layout appendOverlayQuad produces, verts already translated by the
 *  landblock origin) plus the global draw rank + census name for the key. */
export interface PooledOverlayBucket extends OverlayQuadBucket {
  /** Global draw rank: blend layers 0..N, then road buckets (see
   *  TerrainRenderer.ROAD_RANK_*). Meshes are created in ascending rank. */
  rank: number;
  /** Census/mesh name — 'blendmerge' or 'roadmerge' (attribution tooling). */
  name: string;
}

interface PoolEntry {
  rank: number;
  name: string;
  material: THREE.Material;
  /** Per-landblock quad data, keyed by landblock file ID. */
  blocks: Map<number, PooledOverlayBucket>;
  mesh: THREE.Mesh | null;
  dirty: boolean;
}

export class OverlayMergePool {
  private scene: THREE.Scene;
  private entries = new Map<string, PoolEntry>();
  private visible = true;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  /** Contribute one landblock's overlay buckets. Call flush() afterwards. */
  addBlock(fileId: number, buckets: Map<string, PooledOverlayBucket>): void {
    for (const [key, bucket] of buckets) {
      if (bucket.quadCount === 0) continue;
      let entry = this.entries.get(key);
      if (!entry) {
        entry = {
          rank: bucket.rank,
          name: bucket.name,
          material: bucket.material,
          blocks: new Map(),
          mesh: null,
          dirty: true,
        };
        this.entries.set(key, entry);
      }
      entry.blocks.set(fileId, bucket);
      entry.dirty = true;
    }
  }

  /** Retire one landblock's contributions. Call flush() afterwards. */
  removeBlock(fileId: number): void {
    for (const entry of this.entries.values()) {
      if (entry.blocks.delete(fileId)) entry.dirty = true;
    }
  }

  /**
   * Apply pending changes: drop empty keys and rebuild dirty geometries.
   * (Stacking order lives in each mesh's renderOrder, not creation order.)
   */
  flush(): void {
    // Drop keys with no remaining blocks.
    for (const [key, entry] of this.entries) {
      if (entry.blocks.size > 0) continue;
      if (entry.mesh) {
        this.scene.remove(entry.mesh);
        entry.mesh.geometry.dispose();
      }
      this.entries.delete(key);
    }

    // Rebuild dirty geometries.
    for (const entry of this.entries.values()) {
      if (!entry.dirty) continue;
      const geom = OverlayMergePool.buildMergedGeometry(entry.blocks.values());
      if (entry.mesh) {
        entry.mesh.geometry.dispose();
        entry.mesh.geometry = geom;
      } else {
        entry.mesh = this.makeMesh(entry, geom);
      }
      entry.dirty = false;
    }
  }

  private makeMesh(entry: PoolEntry, geom: THREE.BufferGeometry): THREE.Mesh {
    const mesh = new THREE.Mesh(geom, entry.material);
    // Building portal punches keep blend / road overlays off doorways too.
    applyPortalPunchMask(entry.material);
    mesh.name = entry.name;
    mesh.renderOrder = overlayRenderOrder(entry.rank);
    // World-space vertices; bounding sphere spans the loaded region so
    // frustum culling never rejects — skip the test (and its bound upkeep).
    mesh.frustumCulled = false;
    mesh.visible = this.visible;
    this.scene.add(mesh);
    freezeStaticTransform(mesh);
    return mesh;
  }

  /**
   * Concatenate per-landblock quad arrays into one geometry. Quads never
   * share vertices, so computeVertexNormals reproduces the per-quad normals
   * bit-for-bit — the merged output equals the per-landblock meshes exactly.
   */
  static buildMergedGeometry(blocks: Iterable<PooledOverlayBucket>): THREE.BufferGeometry {
    let vertCount = 0;
    let indexCount = 0;
    const list = [...blocks];
    for (const b of list) {
      vertCount += b.verts.length / 3;
      indexCount += b.indices.length;
    }
    const positions = new Float32Array(vertCount * 3);
    const uvs = new Float32Array(vertCount * 2);
    const indices = vertCount > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
    let vBase = 0;
    let vWrite = 0;
    let uvWrite = 0;
    let iWrite = 0;
    for (const b of list) {
      positions.set(b.verts, vWrite);
      uvs.set(b.uvs, uvWrite);
      for (let i = 0; i < b.indices.length; i++) indices[iWrite++] = b.indices[i] + vBase;
      vWrite += b.verts.length;
      uvWrite += b.uvs.length;
      vBase += b.verts.length / 3;
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    // CORE.17.h.g.c.a — the unrotated per-cell UVs (SW, SE, NW, NE = Rot0)
    // the overlay terrain/road texture samples (texture.channel = 1):
    // ImgTex::MergeTexture @ 0053e870 rotates only the alpha map.
    const uv1 = new Float32Array(vertCount * 2);
    for (let v = 0; v < vertCount; v += 4) uv1.set(UNROTATED_QUAD_UVS, v * 2);
    geom.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2));
    geom.setIndex(new THREE.BufferAttribute(indices, 1));
    geom.computeVertexNormals();
    return geom;
  }

  /** BUG.sealed-interior-renders-outdoor-terrain — hide/show all pool meshes. */
  setVisible(visible: boolean): void {
    this.visible = visible;
    for (const entry of this.entries.values()) {
      if (entry.mesh) entry.mesh.visible = visible;
    }
  }

  /** Pool meshes currently in the scene (tests/verification). */
  get meshes(): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const entry of this.entries.values()) {
      if (entry.mesh) out.push(entry.mesh);
    }
    return out;
  }

  /** Remove every mesh + dispose pool-owned geometry. Materials are the
   *  TerrainRenderer's shared merged-overlay materials — left alive here. */
  clear(): void {
    for (const entry of this.entries.values()) {
      if (entry.mesh) {
        this.scene.remove(entry.mesh);
        entry.mesh.geometry.dispose();
      }
    }
    this.entries.clear();
  }
}
