import * as THREE from 'three';
import { TERRAIN_RENDER_ORDER } from '../world/PortalPunch.js';
import { freezeStaticTransform, refreeze } from '../utils/freezeStatic.js';

/**
 * PERF.terrain-base-pool (2026-10-31) — cross-landblock base terrain pool.
 *
 * Each landblock's terrain mesh draws one group per terrain-type material
 * (createMultiMaterialMesh), so the loaded region cost ~95–131 draw calls
 * at Holtburg at every heading, against a few dozen distinct materials
 * region-wide. This pool concatenates every landblock's triangles for one
 * material into ONE mesh, as OverlayMergePool does for the blend / road
 * overlays.
 *
 * Why the picture is the same: the base terrain is opaque and depth-tested,
 * and no two landblocks' (or two materials') triangles overlap, so the order
 * three draws them in changes nothing; the pool keeps TERRAIN_RENDER_ORDER,
 * so the building portal punch still erases terrain depth after it. The
 * landscape is lit by the sun alone (no per-object light pick), and every
 * terrain mesh was already in the indoor view's outside pass.
 *
 * Precision: each slice keeps the block's own local vertices (0–192 m), and
 * a pool mesh sits at the centre of its blocks with every vertex placed
 * relative to it (offsets summed in doubles). Baking world coordinates
 * (~32 km at Holtburg) into float32 jittered vertices by millimetres in the
 * GPU's view transform and changed the colour of most terrain pixels by a
 * few levels against the per-block meshes; within ~1.7 km of the mesh
 * origin the rasterized frame matches them.
 *
 * The per-landblock meshes stay the record of what each block draws
 * (TerrainRenderer.getMesh, LOD, visibility) but are no longer added to the
 * scene.
 */

/** One landblock's triangles for one material, in the block's local frame. */
interface BlockSlice {
  /** The block's world offset (its mesh position). */
  ox: number; oy: number; oz: number;
  /** Block-local positions, exactly the block mesh's values. */
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  /** Indices into this slice's own vertices. */
  indices: Uint16Array | Uint32Array;
}

interface PoolEntry {
  material: THREE.Material;
  blocks: Map<number, BlockSlice>;
  mesh: THREE.Mesh | null;
  dirty: boolean;
}

/** Census/mesh name of every pool mesh (tools/lib/scene-census.ts). */
export const BASE_TERRAIN_POOL_NAME = 'terrainpool';

export class BaseTerrainPool {
  private scene: THREE.Scene;
  private entries = new Map<THREE.Material, PoolEntry>();
  private visible = true;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  /**
   * Contribute a landblock's terrain mesh (not in the scene): each of its
   * geometry groups (or the whole geometry for a single material) becomes a
   * world-space slice of that material's pool mesh. Call flush() afterwards.
   */
  addBlock(fileId: number, mesh: THREE.Mesh): void {
    const geom = mesh.geometry;
    const index = geom.getIndex();
    if (!index) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const groups = geom.groups.length > 0 ? geom.groups : [{ start: 0, count: index.count, materialIndex: 0 }];
    const pos = geom.getAttribute('position') as THREE.BufferAttribute;
    const nrm = geom.getAttribute('normal') as THREE.BufferAttribute | undefined;
    const uv = geom.getAttribute('uv') as THREE.BufferAttribute | undefined;
    const ox = mesh.position.x, oy = mesh.position.y, oz = mesh.position.z;
    for (const g of groups) {
      const material = materials[g.materialIndex ?? 0];
      if (!material || g.count <= 0) continue;
      const remap = new Map<number, number>();
      const local: number[] = [];
      for (let i = g.start; i < g.start + g.count; i++) {
        const v = index.getX(i);
        let r = remap.get(v);
        if (r === undefined) { r = remap.size; remap.set(v, r); }
        local.push(r);
      }
      const n = remap.size;
      const positions = new Float32Array(n * 3);
      const normals = new Float32Array(n * 3);
      const uvs = new Float32Array(n * 2);
      for (const [v, r] of remap) {
        positions[r * 3] = pos.getX(v);
        positions[r * 3 + 1] = pos.getY(v);
        positions[r * 3 + 2] = pos.getZ(v);
        if (nrm) { normals[r * 3] = nrm.getX(v); normals[r * 3 + 1] = nrm.getY(v); normals[r * 3 + 2] = nrm.getZ(v); }
        if (uv) { uvs[r * 2] = uv.getX(v); uvs[r * 2 + 1] = uv.getY(v); }
      }
      const slice: BlockSlice = {
        ox, oy, oz, positions, normals, uvs,
        indices: n > 65535 ? Uint32Array.from(local) : Uint16Array.from(local),
      };
      let entry = this.entries.get(material);
      if (!entry) {
        entry = { material, blocks: new Map(), mesh: null, dirty: true };
        this.entries.set(material, entry);
      }
      // One group per material per block (createMultiMaterialMesh).
      entry.blocks.set(fileId, slice);
      entry.dirty = true;
    }
  }

  /** Retire one landblock's slices. Call flush() afterwards. */
  removeBlock(fileId: number): void {
    for (const entry of this.entries.values()) {
      if (entry.blocks.delete(fileId)) entry.dirty = true;
    }
  }

  /** Apply pending changes: drop empty materials, rebuild dirty meshes. */
  flush(): void {
    for (const [key, entry] of this.entries) {
      if (entry.blocks.size > 0) continue;
      if (entry.mesh) {
        this.scene.remove(entry.mesh);
        entry.mesh.geometry.dispose();
      }
      this.entries.delete(key);
    }
    for (const entry of this.entries.values()) {
      if (!entry.dirty) continue;
      const slices = [...entry.blocks.values()];
      const origin = BaseTerrainPool.originOf(slices);
      const geom = BaseTerrainPool.buildGeometry(slices, origin);
      if (entry.mesh) {
        entry.mesh.geometry.dispose();
        entry.mesh.geometry = geom;
        // The origin follows the block set: re-derive the frozen matrices.
        entry.mesh.position.copy(origin);
        refreeze(entry.mesh);
      } else {
        const mesh = new THREE.Mesh(geom, entry.material);
        mesh.position.copy(origin);
        mesh.name = BASE_TERRAIN_POOL_NAME;
        // First opaque draw after the sky; portal punches follow (PortalPunch.ts).
        mesh.renderOrder = TERRAIN_RENDER_ORDER;
        // Spans the loaded region: the frustum test would never reject it.
        mesh.frustumCulled = false;
        mesh.visible = this.visible;
        this.scene.add(mesh);
        freezeStaticTransform(mesh);
        entry.mesh = mesh;
      }
      entry.dirty = false;
    }
  }

  /** Hide / show every pool mesh (sealed interiors hide the landscape). */
  setVisible(visible: boolean): void {
    this.visible = visible;
    for (const entry of this.entries.values()) if (entry.mesh) entry.mesh.visible = visible;
  }

  /** Pool meshes currently in the scene (tests/verification). */
  get meshes(): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const entry of this.entries.values()) if (entry.mesh) out.push(entry.mesh);
    return out;
  }

  /** Remove every mesh and dispose pool-owned geometry (materials belong to TerrainRenderer). */
  clear(): void {
    for (const entry of this.entries.values()) {
      if (entry.mesh) {
        this.scene.remove(entry.mesh);
        entry.mesh.geometry.dispose();
      }
    }
    this.entries.clear();
  }

  /** The mesh origin: the centre of the slices' block offsets, on the 192 m landblock grid. */
  private static originOf(slices: BlockSlice[]): THREE.Vector3 {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const s of slices) {
      minX = Math.min(minX, s.ox); maxX = Math.max(maxX, s.ox);
      minZ = Math.min(minZ, s.oz); maxZ = Math.max(maxZ, s.oz);
    }
    const snap = (v: number) => Math.round(v / 192) * 192;
    return new THREE.Vector3(snap((minX + maxX) / 2), 0, snap((minZ + maxZ) / 2));
  }

  /** Concatenate slices into one geometry, each vertex placed relative to `origin`. */
  private static buildGeometry(list: BlockSlice[], origin: THREE.Vector3): THREE.BufferGeometry {
    let verts = 0, idx = 0;
    for (const s of list) { verts += s.positions.length / 3; idx += s.indices.length; }
    const positions = new Float32Array(verts * 3);
    const normals = new Float32Array(verts * 3);
    const uvs = new Float32Array(verts * 2);
    const indices = verts > 65535 ? new Uint32Array(idx) : new Uint16Array(idx);
    let vBase = 0, iWrite = 0;
    for (const s of list) {
      const dx = s.ox - origin.x, dy = s.oy - origin.y, dz = s.oz - origin.z;
      const p = s.positions;
      for (let i = 0, o = vBase * 3; i < p.length; i += 3, o += 3) {
        positions[o] = p[i] + dx;
        positions[o + 1] = p[i + 1] + dy;
        positions[o + 2] = p[i + 2] + dz;
      }
      normals.set(s.normals, vBase * 3);
      uvs.set(s.uvs, vBase * 2);
      for (let i = 0; i < s.indices.length; i++) indices[iWrite++] = s.indices[i] + vBase;
      vBase += p.length / 3;
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geom.setIndex(new THREE.BufferAttribute(indices, 1));
    return geom;
  }
}
