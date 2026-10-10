import * as THREE from 'three';
import { prepareSurfaceMesh } from '../models/MaterialFactory.js';
import type { SceneryInstancer, InstanceEntry } from './SceneryInstancer.js';
import type { TemplateSubmesh } from './SceneryInstancer.js';
import {
  type DegradeLod, type DegradeChain, INVALID_DID, isBillboardMode, billboardRotation,
  MAX_CELL_2D_DEGRADE_DISTANCE, landCellCenter,
} from '../models/DegradeLod.js';

/**
 * PERF.1 — cross-landblock instancing pool for landscape scenery and
 * landblock statics.
 *
 * The per-landblock batches (SceneryInstancer.buildInstances) still cost one
 * InstancedMesh — one draw call — per (GfxObj, submesh) per landblock:
 * ~1,220 meshes / 941–1,313 draws at Holtburg, the largest remaining
 * draw-call bucket after the terrain-group merge. But the whole loaded
 * region only contains ~56 DISTINCT (GfxObj, submesh) pairs, so this pool
 * keeps exactly one InstancedMesh per pair across ALL loaded landblocks.
 * Landblocks contribute instance ranges as they stream in (addBlock) and
 * retire them on unload (removeBlock, swap-remove compaction), so scenery
 * draw calls become ~the distinct-pair count at every camera heading.
 *
 * Covenant (docs/performance-budgets.md): the instance matrices are the
 * same per-placement world transforms the per-landblock path produced
 * (SceneryInstancer.collectSubmeshInstances is shared by both), geometry and
 * materials are the same shared templates, so the drawn pixels are
 * identical. The only behavioral difference is culling granularity: a
 * pooled mesh's bounding sphere spans every loaded landblock that uses the
 * model, so off-frustum instances are vertex-processed rather than culled —
 * submission-side only, zero visible-pixel change (measured +5% triangles at
 * yaw0 for -885 draw calls).
 *
 * CORE.17.h.g.c.c — retail's per-part degrade (LOD) system runs inside the
 * pool: each GfxObj "family" keeps the master instance list and, when the
 * GfxObj carries a DIDDegrade chain, partitions it every frame
 * (updateLod) into one InstancedMesh set per degrade level — level k = the
 * degrades[k].gfxobj_id GfxObj's templates (the family's own templates
 * when that is the family GfxObj, which level 0 usually but not always is —
 * CORE.17.h.g.c.c.c; same surfaces, hence the same materials), the INVALID
 * level = not drawn at
 * all, exactly what CPhysicsPart::Draw @ 0050d7a0 does with
 * gfxobj[deg_level] == NULL. Billboard levels (degrade_mode 2/4/5) get
 * their rows re-oriented toward the viewer per CPhysicsPart::calc_draw_
 * frame. Families without a chain behave exactly as before.
 */
export class SceneryInstancePool {
  private instancer: SceneryInstancer;
  private namePrefix: string;
  private onMeshAdded: (mesh: THREE.Object3D) => void;
  private onMeshRemoved: (mesh: THREE.Object3D) => void;

  /** gfxObjId → family (master instances + level-0 submesh meshes + LOD state). */
  private families = new Map<number, Family>();
  /** Mirrors the sealed-interior landscape toggle (setLandscapeVisible). */
  private poolVisible = true;
  /** CORE.17.h.g.c.b — optional per-pool material substitution (the
   *  buildings pool draws its shared templates through their detail-pass
   *  variants, as RenderDeviceD3D::DrawBuilding draws building parts under
   *  Render::building_detail_surface). Identity when unset. */
  private materialFor: (material: THREE.Material | THREE.Material[], geometry: THREE.BufferGeometry) => THREE.Material | THREE.Material[];
  /** CORE.17.h.g.c.c — the degrade system (null = every instance at level 0). */
  private lod: DegradeLod | null;
  private landCells: boolean;
  private viewer: THREE.Vector3 | null = null;
  private lastViewer = new THREE.Vector3(NaN, NaN, NaN);

  constructor(
    instancer: SceneryInstancer,
    namePrefix: string,
    onMeshAdded: (mesh: THREE.Object3D) => void,
    onMeshRemoved: (mesh: THREE.Object3D) => void,
    options: {
      materialFor?: (material: THREE.Material | THREE.Material[], geometry: THREE.BufferGeometry) => THREE.Material | THREE.Material[];
      lod?: DegradeLod | null;
      /** CORE.17.h.g.c.c.c — the instances live in LAND cells (default):
       *  beyond MAX_CELL_2D_DEGRADE_DISTANCE each instance measures its
       *  cell centre's 2-D viewer distance (RenderDeviceD3D::UpdateObjCell).
       *  false for env-cell pools (CObjCell::GetViewerDistance = 0). */
      landCells?: boolean;
    } = {},
  ) {
    this.instancer = instancer;
    this.namePrefix = namePrefix;
    this.onMeshAdded = onMeshAdded;
    this.onMeshRemoved = onMeshRemoved;
    this.materialFor = options.materialFor ?? (m => m);
    this.lod = options.lod ?? null;
    this.landCells = options.landCells ?? true;
  }

  /**
   * Contribute one landblock's placements to the pool. A block already in
   * the pool is replaced (defensive — the streaming paths load each block
   * once between unloads).
   */
  addBlock(blockKey: number, entries: InstanceEntry[]): void {
    this.removeBlock(blockKey);
    const touched = new Set<Family>();
    for (const sub of this.instancer.collectSubmeshInstances(entries)) {
      let family = this.families.get(sub.gfxObjId);
      if (!family) {
        family = this.createFamily(sub.gfxObjId, sub.matrices.length);
        this.families.set(sub.gfxObjId, family);
      }
      if (!family.submeshes[sub.tplIdx]) {
        family.submeshes[sub.tplIdx] = this.createSubmesh(family, sub.tplIdx, sub.template, family.capacity);
      }
      // collectSubmeshInstances emits every submesh of a GfxObj with the
      // same matrix list — the family takes the instances once (tplIdx 0).
      if (sub.tplIdx !== 0) continue;
      this.ensureCapacity(family, family.count + sub.matrices.length);
      const master = family.master;
      for (let k = 0; k < sub.matrices.length; k++) {
        const m = sub.matrices[k];
        const i = family.count;
        m.toArray(master, i * 16);
        family.owners[i] = blockKey;
        if (family.lod) this.recordInstance(family.lod, i, m, sub.origins[k]);
        family.count++;
      }
      family.blockCounts.set(blockKey, sub.matrices.length);
      touched.add(family);
    }
    for (const family of touched) this.commit(family);
  }

  /** Retire a landblock's instances (swap-remove; order within a pooled
   *  mesh is not meaningful, matching the arbitrary per-landblock order the
   *  un-pooled path drew in). */
  removeBlock(blockKey: number): void {
    for (const family of this.families.values()) {
      if (!family.blockCounts.has(blockKey)) continue;
      const arr = family.master;
      const lod = family.lod;
      let i = 0;
      while (i < family.count) {
        if (family.owners[i] === blockKey) {
          family.count--;
          const last = family.count;
          if (i < last) {
            arr.copyWithin(i * 16, last * 16, last * 16 + 16);
            family.owners[i] = family.owners[last];
            if (lod) {
              // Every per-instance LodState array moves with its row. A
              // stale `cells` entry (BUG.scenery-setup-instances-invisible-
              // near-player) handed the moved instance a removed block's
              // cell centre, hundreds of metres away, through the
              // UpdateObjCell branch of selectLevel, so trees at the
              // player's feet picked their INVALID_DID level and drew nothing.
              lod.centers.copyWithin(i * 3, last * 3, last * 3 + 3);
              lod.origins.copyWithin(i * 3, last * 3, last * 3 + 3);
              lod.cells.copyWithin(i * 2, last * 2, last * 2 + 2);
              lod.invScale[i] = lod.invScale[last];
              lod.levels[i] = lod.levels[last];
            }
          }
        } else {
          i++;
        }
      }
      family.owners.length = family.count;
      family.blockCounts.delete(blockKey);
      this.commit(family);
    }
  }

  /**
   * PERF.browser-memory-crash — drop every family whose landblocks have all
   * unloaded: its (empty, hidden) InstancedMeshes left the scene graph only
   * when the family grew, so a long session kept one mesh set per GfxObj it
   * ever met (bldginst 340 → 1,052 children over five teleports). The shared
   * template geometry/materials stay with their caches (swept there).
   * Returns how many families were retired.
   */
  retireEmptyFamilies(): number {
    let retired = 0;
    for (const [id, family] of [...this.families]) {
      if (family.count > 0) continue;
      for (const mesh of this.allMeshes(family)) { this.onMeshRemoved(mesh); mesh.dispose(); }
      this.families.delete(id);
      retired++;
    }
    return retired;
  }

  /** Sealed-interior landscape toggle: hide/show every pooled mesh (the
   *  pooled meshes live outside the per-landblock attachment lists that
   *  setLandscapeVisible walks). */
  setVisible(visible: boolean): void {
    this.poolVisible = visible;
    for (const family of this.families.values()) {
      for (const mesh of this.allMeshes(family)) mesh.visible = visible && mesh.count > 0;
    }
  }

  /** Number of pooled meshes currently holding instances (≈ draw calls). */
  get drawableMeshCount(): number {
    let n = 0;
    for (const family of this.families.values()) {
      for (const mesh of this.allMeshes(family)) if (mesh.count > 0) n++;
    }
    return n;
  }

  /** Total pooled instances for one block (0 when absent) — test/debug aid. */
  instanceCountFor(blockKey: number): number {
    let n = 0;
    for (const family of this.families.values()) {
      n += (family.blockCounts.get(blockKey) ?? 0) * family.submeshes.filter(Boolean).length;
    }
    return n;
  }

  /**
   * CORE.17.h.g.c.c — CPhysicsObj/CPhysicsPart::UpdateViewerDistance for
   * every pooled instance: re-select each instance's degrade level from the
   * viewer distance and re-partition the families whose levels changed (or
   * that currently draw a billboard level and the viewer moved).
   * CORE.17.h.g.c.c.a — the distance is the part's sort-center distance
   * inside Render::object_distance_2dsq (2-D, from the owning object's
   * origin) and the object-origin distance beyond it.
   */
  updateLod(viewerPos: THREE.Vector3): void {
    if (!this.lod) return;
    if (!this.viewer) this.viewer = new THREE.Vector3();
    this.viewer.copy(viewerPos);
    const moved = !this.lastViewer.equals(viewerPos);
    this.lastViewer.copy(viewerPos);
    for (const family of this.families.values()) {
      const lod = family.lod;
      if (!lod || family.count === 0) continue;
      let changed = false;
      let billboardActive = false;
      const degrades = lod.chain.degrades;
      for (let i = 0; i < family.count; i++) {
        const level = this.selectLevel(lod, i);
        if (level !== lod.levels[i]) { lod.levels[i] = level; changed = true; }
        if (isBillboardMode(degrades[level].degradeMode)) billboardActive = true;
      }
      if (changed || (billboardActive && moved)) this.commit(family);
    }
  }

  /** Debug census: instances per level for one GfxObj family (null = no chain). */
  levelCensusFor(gfxObjId: number): Record<number, number> | null {
    const family = this.families.get(gfxObjId);
    if (!family?.lod) return null;
    const out: Record<number, number> = {};
    for (let i = 0; i < family.count; i++) {
      const l = family.lod.levels[i];
      out[l] = (out[l] ?? 0) + 1;
    }
    return out;
  }

  /** Debug census across the pool: total instances, drawn, and per-level counts. */
  lodCensus(): { families: number; withChain: number; instances: number; drawn: number; byLevel: Record<number, number> } {
    let families = 0, withChain = 0, instances = 0, drawn = 0;
    const byLevel: Record<number, number> = {};
    for (const family of this.families.values()) {
      families++;
      instances += family.count;
      if (!family.lod) { drawn += family.count; continue; }
      withChain++;
      for (let i = 0; i < family.count; i++) {
        const l = family.lod.levels[i];
        byLevel[l] = (byLevel[l] ?? 0) + 1;
        if (family.lod.chain.levelIds[l] !== INVALID_DID) drawn++;
      }
    }
    return { families, withChain, instances, drawn, byLevel };
  }

  // ── internals ──────────────────────────────────────────────────────────

  private createFamily(gfxObjId: number, initialCapacity: number): Family {
    const capacity = Math.max(16, initialCapacity);
    const chain = this.lod?.chainFor(gfxObjId) ?? null;
    return {
      gfxObjId,
      master: new Float32Array(capacity * 16),
      capacity,
      count: 0,
      owners: [],
      blockCounts: new Map(),
      submeshes: [],
      lod: chain ? this.createLodState(chain, capacity) : null,
    };
  }

  private createLodState(chain: DegradeChain, capacity: number): LodState {
    return {
      chain,
      centers: new Float32Array(capacity * 3),
      origins: new Float32Array(capacity * 3),
      cells: new Float32Array(capacity * 2),
      invScale: new Float32Array(capacity),
      levels: new Uint8Array(capacity),
      levelMeshes: [],
    };
  }

  /** Cache the per-instance viewer-distance inputs (sort center world
   *  position; the owning object's origin; 1 / gfxobj_scale.z = the
   *  three.js Y column length). */
  private recordInstance(lod: LodState, i: number, m: THREE.Matrix4, origin: THREE.Vector3): void {
    _v.copy(lod.chain.sortCenter).applyMatrix4(m);
    lod.centers[i * 3] = _v.x; lod.centers[i * 3 + 1] = _v.y; lod.centers[i * 3 + 2] = _v.z;
    lod.origins[i * 3] = origin.x; lod.origins[i * 3 + 1] = origin.y; lod.origins[i * 3 + 2] = origin.z;
    landCellCenter(origin.x, origin.z, _v);
    lod.cells[i * 2] = _v.x; lod.cells[i * 2 + 1] = _v.z;
    const e = m.elements;
    const sy = Math.sqrt(e[4] * e[4] + e[5] * e[5] + e[6] * e[6]);
    lod.invScale[i] = sy > 1e-6 ? 1 / sy : 1;
    lod.levels[i] = this.viewer ? this.selectLevel(lod, i) : 0;
  }

  /** CPhysicsObj::UpdateViewerDistance @ 00510b30: 2-D origin distance² ≥
   *  object_distance_2dsq → the object-origin distance for every part, else
   *  the part's own sort-center distance. */
  private usesObjectDistance(lod: LodState, i: number): boolean {
    const o = lod.origins;
    const dx = o[i * 3] - this.viewer!.x, dz = o[i * 3 + 2] - this.viewer!.z;
    return dx * dx + dz * dz >= this.lod!.objectDistance2dSq;
  }

  /** RenderDeviceD3D::UpdateObjCell @ 005a0690: a land cell whose 2-D viewer
   *  distance exceeds MAX_CELL_2D_DEGRADE_DISTANCE hands that distance to
   *  every object in it. Returns it, or −1 when the per-object path applies. */
  private cellDistance(lod: LodState, i: number): number {
    if (!this.landCells) return -1;
    const dx = lod.cells[i * 2] - this.viewer!.x, dz = lod.cells[i * 2 + 1] - this.viewer!.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    return d > MAX_CELL_2D_DEGRADE_DISTANCE ? d : -1;
  }

  private selectLevel(lod: LodState, i: number): number {
    if (!this.lod || !this.viewer) return 0;
    const cell = this.cellDistance(lod, i);
    if (cell >= 0) return this.lod.levelFor(lod.chain, cell * lod.invScale[i]);
    const src = this.usesObjectDistance(lod, i) ? lod.origins : lod.centers;
    const dx = src[i * 3] - this.viewer.x, dy = src[i * 3 + 1] - this.viewer.y, dz = src[i * 3 + 2] - this.viewer.z;
    return this.lod.levelFor(lod.chain, Math.sqrt(dx * dx + dy * dy + dz * dz) * lod.invScale[i]);
  }

  private createSubmesh(family: Family, tplIdx: number, template: TemplateSubmesh, capacity: number): PoolEntry {
    const mesh = this.createMesh(family.gfxObjId, template, capacity, '');
    this.onMeshAdded(mesh);
    return { tplIdx, template, mesh };
  }

  private createMesh(gfxObjId: number, template: TemplateSubmesh, capacity: number, suffix: string): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(template.geometry, this.materialFor(template.material, template.geometry), capacity);
    mesh.name = `${this.namePrefix}_${gfxObjId.toString(16).padStart(8, '0')}${suffix}`;
    // Geometry + MaterialFactory-cached materials (or their cached detail
    // variants) are shared across pools and the per-landblock paths —
    // disposal must only ever free instance buffers.
    mesh.userData.sharedResources = true;
    // The clip band / alpha-ref sync / batch order of the source sub-mesh.
    prepareSurfaceMesh(mesh);
    mesh.renderOrder = template.renderOrder ?? mesh.renderOrder;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.visible = false;
    return mesh;
  }

  /** Grow a family (fixed-capacity InstancedMeshes in three.js) by swapping
   *  in larger meshes; the master list is re-published by commit(). */
  private ensureCapacity(family: Family, needed: number): void {
    if (needed <= family.capacity) return;
    const capacity = Math.max(family.capacity * 2, needed);
    const master = new Float32Array(capacity * 16);
    master.set(family.master.subarray(0, family.count * 16));
    family.master = master;
    if (family.lod) {
      const lod = family.lod;
      const centers = new Float32Array(capacity * 3); centers.set(lod.centers.subarray(0, family.count * 3));
      const origins = new Float32Array(capacity * 3); origins.set(lod.origins.subarray(0, family.count * 3));
      const cells = new Float32Array(capacity * 2); cells.set(lod.cells.subarray(0, family.count * 2));
      const invScale = new Float32Array(capacity); invScale.set(lod.invScale.subarray(0, family.count));
      const levels = new Uint8Array(capacity); levels.set(lod.levels.subarray(0, family.count));
      lod.centers = centers; lod.origins = origins; lod.cells = cells; lod.invScale = invScale; lod.levels = levels;
    }
    family.capacity = capacity;
    for (const sub of family.submeshes) {
      if (!sub) continue;
      const next = this.createMesh(family.gfxObjId, sub.template, capacity, '');
      this.onMeshRemoved(sub.mesh);
      sub.mesh.dispose(); // frees the old instance buffer only (shared geometry/material untouched)
      sub.mesh = next;
      this.onMeshAdded(next);
    }
    // Level meshes are rebuilt lazily at the new capacity by commit().
    if (family.lod) {
      const retired = new Set<THREE.InstancedMesh[]>();
      for (let level = 0; level < family.lod.levelMeshes.length; level++) {
        const meshes = family.lod.levelMeshes[level];
        family.lod.levelMeshes[level] = undefined;
        // (levels naming one GfxObj share an array — retire it once)
        if (!meshes || retired.has(meshes)) continue;
        retired.add(meshes);
        for (const m of meshes) { this.onMeshRemoved(m); m.dispose(); }
      }
    }
  }

  /** Publish the family's master list to its drawn meshes. */
  private commit(family: Family): void {
    const lod = family.lod;
    const baseMeshes = family.submeshes.filter((s): s is PoolEntry => !!s).map(s => s.mesh);
    if (!lod || !this.viewer) {
      // No chain (or no viewer yet, pre-world): every instance at level 0 —
      // the family's own GfxObj, or (CORE.17.h.g.c.c.c) the chain's level-0
      // GfxObj when degrades[0].gfxobj_id names another one.
      const targets = lod ? this.levelTargets(family, 0) : baseMeshes;
      for (const mesh of this.allMeshes(family)) {
        if (targets && targets.includes(mesh)) {
          (mesh.instanceMatrix.array as Float32Array).set(family.master.subarray(0, family.count * 16));
          this.publish(mesh, family.count);
        } else {
          this.publish(mesh, 0);
        }
      }
      return;
    }
    const degrades = lod.chain.degrades;
    const levelCount = degrades.length;
    // BUG.tree-trunks-pop — several levels of one chain can name the SAME
    // GfxObj (EoL: 0x1100001C = [0x100379F, 0x100379F, 0x10037A7, INVALID],
    // the 0x02000258 trunk; 0x11000C96, the 0x020002D3 part; …). Retail
    // loads gfxobj[i] per level and draws whichever one deg_level names
    // (CPhysicsPart::LoadGfxObjArray @ 0050dcf0 / CPhysicsPart::Draw @
    // 0050d7a0), so an instance at level 0 and one at level 1 BOTH draw that
    // GfxObj. Here those levels resolve to the same InstancedMeshes, so the
    // rows are appended per mesh — writing each level from row 0 let the
    // later level overwrite the earlier level's rows and its count, and
    // every instance nearer than the level-1 band vanished while the
    // other parts of the same trees (whose levels are distinct GfxObjs)
    // still drew.
    const filled = new Map<THREE.InstancedMesh, number>();
    for (const mesh of this.allMeshes(family)) filled.set(mesh, 0);
    for (let level = 0; level < levelCount; level++) {
      const targets = this.levelTargets(family, level);
      if (!targets || targets.length === 0) continue;
      const billboard = isBillboardMode(degrades[level].degradeMode);
      for (let i = 0; i < family.count; i++) {
        if (lod.levels[i] !== level) continue;
        const src = i * 16;
        if (billboard) this.orientRow(family.master, src, lod, i, degrades[level].degradeMode, _row);
        for (const mesh of targets) {
          const n = filled.get(mesh) ?? 0;
          const arr = mesh.instanceMatrix.array as Float32Array;
          if (billboard) arr.set(_row.elements, n * 16);
          else arr.set(family.master.subarray(src, src + 16), n * 16);
          filled.set(mesh, n + 1);
        }
      }
    }
    // Meshes no level targets (the base GfxObj when the chain never names
    // it, levels nobody sits at) publish 0 and hide.
    for (const [mesh, n] of filled) this.publish(mesh, n);
  }

  /** CPhysicsPart::calc_draw_frame for one pooled row — viewer_heading from
   *  the sort center inside the object sort distance, from the object
   *  origin beyond it (the far branch's object-level heading). */
  private orientRow(master: Float32Array, src: number, lod: LodState, i: number, mode: number, out: THREE.Matrix4): void {
    _m.fromArray(master, src).decompose(_p, _q, _s);
    if (this.cellDistance(lod, i) >= 0) {
      // the cell's heading is horizontal (CLandCell::GetViewerDistance zeroes z)
      _v.set(lod.cells[i * 2], this.viewer!.y, lod.cells[i * 2 + 1]);
    } else {
      const from = this.usesObjectDistance(lod, i) ? lod.origins : lod.centers;
      _v.set(from[i * 3], from[i * 3 + 1], from[i * 3 + 2]);
    }
    billboardRotation(mode, _q, _v, this.viewer!, _bq);
    out.compose(_p, _bq, _s);
  }

  /** The InstancedMeshes that draw `level` for a family: the family's own
   *  submeshes when the level names the family GfxObj (CPhysicsPart::
   *  LoadGfxObjArray loads degrades[i].gfxobj_id for every level, level 0
   *  included — CORE.17.h.g.c.c.c), null for INVALID_DID, else the level
   *  GfxObj's meshes. */
  private levelTargets(family: Family, level: number): THREE.InstancedMesh[] | null {
    const id = family.lod!.chain.levelIds[level];
    if (id === family.gfxObjId) return family.submeshes.filter((s): s is PoolEntry => !!s).map(s => s.mesh);
    if (id === INVALID_DID) return null;
    return this.levelMeshes(family, level, id);
  }

  /** The level-k InstancedMeshes for a family (one per template submesh of
   *  the level GfxObj), created on first use at the family's capacity. */
  private levelMeshes(family: Family, level: number, gfxObjId: number): THREE.InstancedMesh[] | null {
    const lod = family.lod!;
    const existing = lod.levelMeshes[level];
    if (existing !== undefined) return existing;
    // Levels naming the same GfxObj draw through one mesh set (commit()
    // appends their rows), as retail draws the one GfxObj either level names.
    for (let j = 0; j < lod.levelMeshes.length; j++) {
      if (j !== level && lod.chain.levelIds[j] === gfxObjId && lod.levelMeshes[j] !== undefined) {
        lod.levelMeshes[level] = lod.levelMeshes[j];
        return lod.levelMeshes[level]!;
      }
    }
    const templates = this.instancer.templatesFor(gfxObjId);
    let meshes: THREE.InstancedMesh[] | null = null;
    if (templates && templates.length > 0) {
      meshes = templates.map(t => {
        const m = this.createMesh(family.gfxObjId, t, family.capacity, `_lod${level}`);
        this.onMeshAdded(m);
        return m;
      });
    }
    lod.levelMeshes[level] = meshes;
    return meshes;
  }

  private publish(mesh: THREE.InstancedMesh, count: number): void {
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
    // three draws instanceCount=0 meshes as an empty (but real) draw call —
    // hide emptied pools instead.
    mesh.visible = this.poolVisible && count > 0;
    if (count > 0) mesh.computeBoundingSphere();
  }

  private allMeshes(family: Family): THREE.InstancedMesh[] {
    const out: THREE.InstancedMesh[] = [];
    for (const sub of family.submeshes) if (sub) out.push(sub.mesh);
    if (family.lod) {
      for (const meshes of family.lod.levelMeshes) {
        if (meshes) for (const m of meshes) if (!out.includes(m)) out.push(m);
      }
    }
    return out;
  }
}

const _v = new THREE.Vector3();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _bq = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _row = new THREE.Matrix4();

interface PoolEntry {
  tplIdx: number;
  template: TemplateSubmesh;
  /** The level-0 InstancedMesh for this submesh. */
  mesh: THREE.InstancedMesh;
}

interface LodState {
  chain: DegradeChain;
  /** Per instance: world-space sort center (3 floats). */
  centers: Float32Array;
  /** Per instance: the containing land cell's centre (x, z). */
  cells: Float32Array;
  /** Per instance: the owning object's origin (3 floats) — CPhysicsObj::m_position. */
  origins: Float32Array;
  /** Per instance: 1 / gfxobj_scale.z. */
  invScale: Float32Array;
  /** Per instance: current degrade level. */
  levels: Uint8Array;
  /** level → InstancedMeshes (undefined = not built, null = no templates). Index 0 unused. */
  levelMeshes: (THREE.InstancedMesh[] | null | undefined)[];
}

interface Family {
  gfxObjId: number;
  /** Master instance matrices (capacity × 16), every instance of this GfxObj. */
  master: Float32Array;
  /** Allocated instance slots. */
  capacity: number;
  /** Live instance slots. */
  count: number;
  /** Slot → owning blockKey, parallel to the master buffer. */
  owners: number[];
  /** blockKey → its instance count in this family. */
  blockCounts: Map<number, number>;
  /** tplIdx → level-0 submesh mesh. */
  submeshes: (PoolEntry | undefined)[];
  /** CORE.17.h.g.c.c degrade state (null = no DIDDegrade chain). */
  lod: LodState | null;
}
