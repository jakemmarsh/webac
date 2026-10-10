import * as THREE from 'three';
import type { DatDatabase } from '@ac/dat-parser/DatDatabase.js';
import { DatReader } from '@ac/dat-parser/DatReader.js';
import { GfxObj } from '@ac/dat-parser/file-types/GfxObj.js';
import type { Surface } from '@ac/dat-parser/file-types/Surface.js';
import { buildGfxObjGeometry, type GfxObjGeometry } from './GfxObjMesh.js';
import { prepareSurfaceMesh, type MaterialFactory } from './MaterialFactory.js';
import { LruMap } from '../utils/LruMap.js';
import { DRAWING_SPHERE_KEY } from './RetailLighting.js';

/**
 * ModelRenderer — converts GfxObj meshes into Three.js objects.
 * Loads GfxObj from portal.dat, builds BufferGeometry, assigns materials,
 * and creates renderable THREE.Mesh or THREE.Group objects.
 */
export class ModelRenderer {
  private portalDb: DatDatabase;
  private materialFactory: MaterialFactory;
  // ASSESS: bounded leak backstop (fresh-eyes audit 2026-06-10). GfxObjGeometry
  // is plain typed arrays that live meshes also reference through their
  // BufferAttributes, so eviction must NOT dispose anything — we just drop the
  // cache reference and GC reclaims orphans. 4096 entries (typically tens of
  // KB each) far exceeds the distinct GfxObjs a session touches.
  private geometryCache = new LruMap<number, GfxObjGeometry>(4096);

  constructor(portalDb: DatDatabase, materialFactory: MaterialFactory) {
    this.portalDb = portalDb;
    this.materialFactory = materialFactory;
  }

  /**
   * Load and parse a GfxObj from portal.dat.
   */
  loadGfxObj(gfxObjId: number): GfxObj | null {
    const data = this.portalDb.getFileData(gfxObjId);
    if (!data) return null;
    return new GfxObj(new DatReader(data));
  }

  /**
   * Get or compute the geometry arrays for a GfxObj.
   */
  getGeometry(gfxObjId: number): GfxObjGeometry | null {
    const cached = this.geometryCache.get(gfxObjId);
    if (cached) return cached;

    const gfxObj = this.loadGfxObj(gfxObjId);
    if (!gfxObj) return null;

    const geom = buildGfxObjGeometry(gfxObj);
    this.geometryCache.set(gfxObjId, geom);
    return geom;
  }

  /**
   * Create a Three.js object from a GfxObj ID.
   * Returns a Group with child meshes, one per unique surface.
   * Optionally accepts texture overrides (SurfaceTexture substitutions)
   * and composite palette colors for palette-indexed textures.
   */
  createMesh(
    gfxObjId: number,
    textureOverrides?: Map<number, number>,
    paletteColors?: number[],
    /**
     * RENDER.untextured-skipped-in-buildings-and-cells — drawn as (part of) a
     * LandBlockInfo building: RenderDeviceD3D::DrawBuilding @ 0059f2a0 sets
     * ObjBuildingOrBuildingPart around the building's part draw, and
     * D3DPolyRender::DrawMesh @ 0059d4a0 then skips every subset whose surface
     * is untextured (`(type & 6) == 0`, skipNoTexture = 1 in acclient.exe's
     * .data) — the building's portal / seam faces (all 832 drawing-BSP
     * portal faces in the EoL buildings are untextured). Ordinary objects
     * still draw untextured surfaces.
     */
    buildingPass = false,
  ): THREE.Group | null {
    const gfxObj = this.loadGfxObj(gfxObjId);
    if (!gfxObj) return null;

    // ASSESS: route through the geometry cache — this path rebuilt the
    // typed arrays from scratch on every call (every appearance rebuild).
    // The cached arrays are immutable; per-mesh BufferAttributes share them.
    const geomData = this.getGeometry(gfxObjId);
    if (!geomData || geomData.indices.length === 0) return null;

    const group = new THREE.Group();
    group.name = `gfxobj_${gfxObjId.toString(16).padStart(8, '0')}`;

    // Group triangles by surface ID, sidedness and texture addressing: a
    // SidesType 1 polygon draws both faces, the rest are back-face culled as
    // retail culls them (GfxObjGeometry.doubleSided); a batch with no
    // stippled polygon samples CLAMP (GfxObjGeometry.clampUV).
    // Key: surfaceId * 4 + clampUV * 2 + doubleSided.
    const surfaceGroups = new Map<number, number[]>();
    /** Per group: its lowest surface index (retail's batch / attribute order). */
    const groupBatch = new Map<number, number>();
    const triCount = geomData.surfaceIndices.length;

    for (let tri = 0; tri < triCount; tri++) {
      const surfIdx = geomData.surfaceIndices[tri];
      const surfaceId = gfxObj.surfaces[surfIdx] ?? 0;
      const key = surfaceId * 4 + (geomData.clampUV[tri] ? 2 : 0) + (geomData.doubleSided[tri] ? 1 : 0);
      let list = surfaceGroups.get(key);
      if (!list) {
        list = [];
        surfaceGroups.set(key, list);
      }
      const b = groupBatch.get(key);
      if (b === undefined || surfIdx < b) groupBatch.set(key, surfIdx);
      // Each triangle is 3 indices
      const base = tri * 3;
      list.push(
        geomData.indices[base],
        geomData.indices[base + 1],
        geomData.indices[base + 2],
      );
    }

    // VISUAL.dungeon-lighting-saturation — the drawing-BSP root sphere the
    // cell pass picks this part's lights by (Render::viewconeCheck), in the
    // geometry's axes (AC x, z, y — buildGfxObjGeometry's swizzle).
    const ds = (gfxObj.drawingBSP?.rootNode as { sphere?: { origin: { x: number; y: number; z: number }; radius: number } } | undefined)?.sphere;
    const drawingSphere = ds ? [ds.origin.x, ds.origin.z, ds.origin.y, ds.radius] : undefined;

    // Create a mesh per surface
    for (const [key, indices] of surfaceGroups) {
      const surfaceId = Math.floor(key / 4);
      if (buildingPass && !surfaceIsTextured(this.materialFactory.getSurface(surfaceId))) continue;
      const bothFaces = key % 2 === 1;
      const clampUV = key % 4 >= 2;
      const bufferGeom = new THREE.BufferGeometry();
      if (drawingSphere) bufferGeom.userData[DRAWING_SPHERE_KEY] = drawingSphere;
      bufferGeom.setAttribute('position', new THREE.BufferAttribute(geomData.positions, 3));
      bufferGeom.setAttribute('normal', new THREE.BufferAttribute(geomData.normals, 3));
      bufferGeom.setAttribute('uv', new THREE.BufferAttribute(geomData.uvs, 2));
      bufferGeom.setIndex(new THREE.BufferAttribute(new Uint16Array(indices), 1));

      const material = this.materialFactory.getMaterial(surfaceId, undefined, textureOverrides, paletteColors, !bothFaces, clampUV);
      const mesh = new THREE.Mesh(bufferGeom, material);
      // VISUAL.night-sky-vs-retail — the DAT Surface behind this sub-mesh
      // (GameSky reads its luminosity: the D3D material's starting Emissive).
      mesh.userData.surfaceId = surfaceId;
      // RENDER.clip-map-deferral / alpha-ref-follows-bound-texture — the
      // per-mesh half of SetSurface's state; RENDER.sidestype2-batch-order —
      // with a SidesType 2 copy in another batch, the sub-meshes draw in
      // surface-index order (GfxObjGeometry.batchOrdered).
      prepareSurfaceMesh(mesh, geomData.batchOrdered ? BATCH_ORDER_STEP * (groupBatch.get(key) ?? 0) : 0);
      group.add(mesh);
    }

    return group;
  }

  /** The parsed DAT Surface (0x08) for an id, or null. */
  getSurface(surfaceId: number): Surface | null {
    return this.materialFactory.getSurface(surfaceId);
  }

  /**
   * Create a Three.js BufferGeometry from a GfxObj (single geometry, no material split).
   * Useful for physics or simple rendering.
   */
  createBufferGeometry(gfxObjId: number): THREE.BufferGeometry | null {
    const geomData = this.getGeometry(gfxObjId);
    if (!geomData || geomData.indices.length === 0) return null;

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(geomData.positions, 3));
    geom.setAttribute('normal', new THREE.BufferAttribute(geomData.normals, 3));
    geom.setAttribute('uv', new THREE.BufferAttribute(geomData.uvs, 2));
    geom.setIndex(new THREE.BufferAttribute(geomData.indices, 1));
    return geom;
  }

  /**
   * Place a model at a world position.
   */
  placeModel(gfxObjId: number, position: { x: number; y: number; z: number }, rotation?: { w: number; x: number; y: number; z: number }): THREE.Group | null {
    const group = this.createMesh(gfxObjId);
    if (!group) return null;

    // AC Z-up → Three.js Y-up: swap Y and Z
    group.position.set(position.x, position.z, position.y);

    if (rotation) {
      group.quaternion.set(-rotation.x, -rotation.z, -rotation.y, rotation.w);
    }

    return group;
  }

  /**
   * Get the number of cached geometries.
   */
  get cacheSize(): number {
    return this.geometryCache.size;
  }

  /**
   * Clear all cached geometry data.
   */
  clear(): void {
    this.geometryCache.clear();
  }
}

/**
 * D3DPolyRender::DrawMesh @ 0059d4a0's textured test: `(surface->type & 6) != 0`
 * (Base1Image | Base1ClipMap). An unreadable surface counts as textured, so
 * it still draws (as the magenta fallback) instead of silently vanishing.
 */
/**
 * renderOrder step between a batch-ordered GfxObj's sub-meshes (surface
 * index × step): small enough to stay inside its band (opaque 0, clip
 * CLIP_LIST_RENDER_ORDER) for any GfxObj's surface count.
 */
export const BATCH_ORDER_STEP = 1e-4;

export function surfaceIsTextured(surface: Surface | null): boolean {
  return !surface || (surface.type & 6) !== 0;
}
