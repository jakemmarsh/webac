import * as THREE from 'three';
import { freezeStaticTransform } from '../utils/freezeStatic.js';
import type { DatDatabase } from '@ac/dat-parser/DatDatabase.js';
import { DatReader } from '@ac/dat-parser/DatReader.js';
import { PortalFileType } from '@ac/dat-parser/DatFileType.js';
import { EnvCell } from '@ac/dat-parser/file-types/EnvCell.js';
import { Environment, type CellStruct } from '@ac/dat-parser/file-types/Environment.js';
import type { Frame } from '@ac/dat-parser/file-types/Frame.js';
import { prepareSurfaceMesh, type MaterialFactory } from '../models/MaterialFactory.js';
import { applyRetailLighting, cellObjectVariantOf, rawByteColor, retailLightRange, retailStaticLightDecay, setCellLighting, SURFACE_LUMINOSITY_KEY } from '../models/RetailLighting.js';
import type { SetupModelRenderer } from '../models/SetupModelRenderer.js';
import { surfaceIsTextured, type ModelRenderer } from '../models/ModelRenderer.js';
import { clampedSurfaceBatches } from '../models/GfxObjMesh.js';
import type { SceneryInstancer, InstanceEntry } from '../terrain/SceneryInstancer.js';
import { SceneryInstancePool } from '../terrain/SceneryInstancePool.js';
import type { DegradeLod } from '../models/DegradeLod.js';
import { tagStaticScriptAnchor } from './StaticScriptDriver.js';
import { tagStaticDefaultAnimation } from './StaticAnimationDriver.js';
import { landblockX, landblockY } from '@ac/shared';

/** CORE.17.h.g.c.c.a — one live cell's furniture pool (cell-local matrices). */
interface CellFurniture {
  group: THREE.Group;
  pool: SceneryInstancePool;
}

const _viewerLocal = new THREE.Vector3();

/**
 * EnvCellRenderer — converts EnvCell dungeon geometry into Three.js objects.
 * Loads the Environment's CellStruct, builds BufferGeometry from its vertices
 * and polygons, and positions the cell using its Frame data.
 * Also renders static objects (torches, furniture, etc.) inside each cell.
 */
export class EnvCellRenderer {
  private portalDb: DatDatabase;
  private cellDb: DatDatabase;
  private materialFactory: MaterialFactory;
  private setupModelRenderer: SetupModelRenderer | null;
  private modelRenderer: ModelRenderer | null;
  private envCache = new Map<number, Environment>();
  /** PERF.1 — shared instancer for per-cell static-object (furniture)
   *  batching; optional so DAT-only tests keep working without one. */
  private instancer: SceneryInstancer | null = null;
  /** CORE.17.h.g.c.c.a — the degrade (LOD) system; null = every furniture
   *  part at level 0 (DAT-only tests). */
  private degradeLod: DegradeLod | null = null;
  /** Live per-cell furniture pools, pruned as their cells leave the scene. */
  private furniture = new Set<CellFurniture>();

  constructor(
    portalDb: DatDatabase,
    cellDb: DatDatabase,
    materialFactory: MaterialFactory,
    setupModelRenderer?: SetupModelRenderer,
    modelRenderer?: ModelRenderer,
  ) {
    this.portalDb = portalDb;
    this.cellDb = cellDb;
    this.materialFactory = materialFactory;
    this.setupModelRenderer = setupModelRenderer ?? null;
    this.modelRenderer = modelRenderer ?? null;
  }

  /** PERF.1 — wire the shared SceneryInstancer (constructed after this
   *  renderer in main.ts) so cell static objects batch per cell. */
  setInstancer(instancer: SceneryInstancer): void {
    this.instancer = instancer;
  }

  /** CORE.17.h.g.c.c.a — wire the degrade system so cell furniture (pooled
   *  batches AND the single-GfxObj fallback groups) degrades like every
   *  other CPhysicsPart. */
  setDegradeLod(lod: DegradeLod | null): void {
    this.degradeLod = lod;
  }

  /**
   * CORE.17.h.g.c.c.a — CPhysicsObj::UpdateViewerDistance for every live
   * cell's pooled furniture. Cell batches are parented under the cell group
   * (visibility = stab set + PVS + portal gating, unchanged), so their
   * matrices are cell-local and the viewer is brought into that frame
   * (EnvCell orientations are yaw-only, so local "up" is world up for the
   * billboard modes). Cells no longer under a scene are pruned; hidden cells
   * (portal-culled) are skipped until they show again — visibility is
   * applied earlier in the frame than this update, so they are current on
   * the frame they reappear.
   */
  updateFurnitureLod(viewerWorld: THREE.Vector3): void {
    if (!this.degradeLod) return;
    for (const entry of this.furniture) {
      const group = entry.group;
      let root: THREE.Object3D = group;
      let visible = group.visible;
      while (root.parent) {
        root = root.parent;
        if (!root.visible) visible = false;
      }
      if (!(root as THREE.Scene).isScene) { this.furniture.delete(entry); continue; }
      if (!visible) continue;
      group.updateWorldMatrix(true, false);
      _viewerLocal.copy(viewerWorld);
      group.worldToLocal(_viewerLocal);
      entry.pool.updateLod(_viewerLocal);
    }
  }

  /** Debug census across the live cell pools (same shape as SceneryInstancePool.lodCensus). */
  furnitureLodCensus(): { cells: number; families: number; withChain: number; instances: number; drawn: number; byLevel: Record<number, number> } {
    const out = { cells: 0, families: 0, withChain: 0, instances: 0, drawn: 0, byLevel: {} as Record<number, number> };
    for (const entry of this.furniture) {
      const c = entry.pool.lodCensus();
      out.cells++;
      out.families += c.families; out.withChain += c.withChain;
      out.instances += c.instances; out.drawn += c.drawn;
      for (const [l, n] of Object.entries(c.byLevel)) out.byLevel[+l] = (out.byLevel[+l] ?? 0) + n;
    }
    return out;
  }

  /**
   * Load an EnvCell from cell.dat.
   */
  loadEnvCell(cellId: number): EnvCell | null {
    const data = this.cellDb.getFileData(cellId);
    if (!data) return null;
    return new EnvCell(new DatReader(data));
  }

  /**
   * Load an Environment from portal.dat (cached).
   */
  loadEnvironment(envId: number): Environment | null {
    const cached = this.envCache.get(envId);
    if (cached) return cached;

    const data = this.portalDb.getFileData(envId);
    if (!data) return null;

    const env = new Environment(new DatReader(data));
    this.envCache.set(envId, env);
    return env;
  }

  /**
   * Get the CellStruct for an EnvCell by looking up its environment + structure index.
   */
  getCellStruct(envCell: EnvCell): CellStruct | null {
    const env = this.loadEnvironment(envCell.environmentId);
    if (!env) return null;
    return env.cells.get(envCell.cellStructure) ?? null;
  }

  /**
   * Get collision data for a cell: CellStruct (with physicsBSP) + position Frame.
   * Used by DungeonCollision to build sphere-BSP collision trees.
   */
  getCellCollisionData(cellId: number): { cellStruct: CellStruct; position: Frame; outsidePortalPolygonIds: number[] } | null {
    const envCell = this.loadEnvCell(cellId);
    if (!envCell) return null;
    const cellStruct = this.getCellStruct(envCell);
    if (!cellStruct) return null;
    // BUG.bunker-sealed-at-ground — the portals out to the landscape (OtherCellId 0xFFFF).
    const outsidePortalPolygonIds = envCell.cellPortals.filter((p) => p.otherCellId === 0xFFFF).map((p) => p.polygonId);
    return { cellStruct, position: envCell.position, outsidePortalPolygonIds };
  }

  /**
   * Build invisible Three.js collision mesh from PHYSICS polygons.
   * Physics polygons have ramp surfaces for stairs (not individual steps)
   * and simplified walls with portal openings already excluded.
   * Positioned using the same cell Frame as the rendering mesh.
   */
  buildPhysicsCollisionMesh(cellId: number): THREE.Group | null {
    const envCell = this.loadEnvCell(cellId);
    if (!envCell) return null;
    const cellStruct = this.getCellStruct(envCell);
    if (!cellStruct || cellStruct.physicsPolygons.size === 0) return null;

    const group = new THREE.Group();
    group.name = `physcoll_${cellId.toString(16).padStart(8, '0')}`;

    const vertexMap = cellStruct.vertexArray.vertices;

    // Build geometry from physics polygons (all in one mesh)
    const posArr: number[] = [];
    const indices: number[] = [];
    const vertLookup = new Map<number, number>(); // original vertex index → buffer index
    let bufIdx = 0;

    for (const [, poly] of cellStruct.physicsPolygons) {
      const polyBufIndices: number[] = [];
      for (const vIdx of poly.vertexIndices) {
        let bi = vertLookup.get(vIdx);
        if (bi === undefined) {
          const v = vertexMap.get(vIdx);
          if (!v) continue;
          // AC Z-up → Three.js Y-up: swap Y and Z
          posArr.push(v.origin.x, v.origin.z, v.origin.y);
          bi = bufIdx++;
          vertLookup.set(vIdx, bi);
        }
        polyBufIndices.push(bi);
      }
      // Fan triangulation
      for (let i = 2; i < polyBufIndices.length; i++) {
        indices.push(polyBufIndices[0], polyBufIndices[i], polyBufIndices[i - 1]);
      }
    }

    if (indices.length === 0) return null;

    const bufferGeom = new THREE.BufferGeometry();
    bufferGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(posArr), 3));
    bufferGeom.setIndex(new THREE.BufferAttribute(new Uint16Array(indices), 1));
    bufferGeom.computeVertexNormals();

    // Invisible mesh — used only for raycasting, not rendering
    const material = new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(bufferGeom, material);
    mesh.userData.physicsGeometry = true;
    group.add(mesh);

    // Position using cell Frame (same transform as rendering mesh)
    const worldOffsetX = landblockX(cellId) * 192;
    const worldOffsetZ = landblockY(cellId) * 192;
    const pos = envCell.position;
    group.position.set(
      worldOffsetX + pos.origin.x,
      pos.origin.z + 0.05,
      worldOffsetZ + pos.origin.y,
    );
    group.quaternion.set(
      -pos.orientation.x,
      -pos.orientation.z,
      -pos.orientation.y,
      pos.orientation.w,
    );

    return group;
  }

  /**
   * Create Three.js geometry from a CellStruct's vertices and polygons.
   * Expands vertices by UV count (matching ACViewer's BuildUVLookup) so
   * polygons can reference specific UV sets via posUVIndices.
   */
  buildCellGeometry(cellStruct: CellStruct, surfaces: number[]): THREE.Group {
    const group = new THREE.Group();

    const vertexMap = cellStruct.vertexArray.vertices;
    const keys = Array.from(vertexMap.keys()).sort((a, b) => a - b);

    // Build expanded vertex buffer: each vertex with N UVs becomes N entries
    const uvLookup = new Map<string, number>();
    const posArr: number[] = [];
    const normArr: number[] = [];
    const uvArr: number[] = [];

    let bufIdx = 0;
    for (const key of keys) {
      const v = vertexMap.get(key)!;
      const numUVs = Math.max(1, v.uvs.length);

      for (let uvI = 0; uvI < numUVs; uvI++) {
        uvLookup.set(`${key}:${uvI}`, bufIdx);

        // Convert AC Z-up to Three.js Y-up: swap Y and Z
        posArr.push(v.origin.x, v.origin.z, v.origin.y);
        normArr.push(v.normal.x, v.normal.z, v.normal.y);

        if (uvI < v.uvs.length) {
          uvArr.push(v.uvs[uvI].u, v.uvs[uvI].v);
        } else {
          uvArr.push(0, 0);
        }

        bufIdx++;
      }
    }

    const positions = new Float32Array(posArr);
    const normals = new Float32Array(normArr);
    const uvs = new Float32Array(uvArr);

    // Group triangles by surface ID for material assignment
    const surfaceGroups = new Map<number, number[]>();
    // A cell's mesh is built by the same D3DPolyRender::ConstructMesh @
    // 0059dfa0 (CEnvCell, decomp :293684): a surface batch with no stippled
    // polygon (portal openings included) samples CLAMP (GfxObjMesh.clampedSurfaceBatches).
    const clamped = clampedSurfaceBatches(cellStruct.polygons.values());

    // RENDER.untextured-skipped-in-buildings-and-cells — RenderDeviceD3D::
    // DrawEnvCell @ 0059f170 draws the cell mesh with DrawMesh @ 0059d4a0's
    // bool set, so every subset whose surface is untextured (`(type & 6) == 0`)
    // is skipped (skipNoTexture = 1 in acclient.exe's .data). That covers the
    // portal openings (every NoPos cell polygon is untextured) and the
    // untextured filler faces (e.g. the pink 0x08000B79 slabs in the 0xB2AA /
    // 0xB3AA Environments 0x0D000444–0x0D00044E).
    const textured = new Map<number, boolean>();
    const isTextured = (surfaceId: number): boolean => {
      let t = textured.get(surfaceId);
      if (t === undefined) {
        t = surfaceIsTextured(this.materialFactory.getSurface(surfaceId));
        textured.set(surfaceId, t);
      }
      return t;
    };

    for (const [, poly] of cellStruct.polygons) {
      const verts = poly.vertexIndices;
      if (verts.length < 3) continue;

      // Resolve surface ID from the cell's surface list
      const surfaceId = surfaces[poly.posSurface] ?? 0;
      if (!isTextured(surfaceId)) continue;

      // Cell polygons cull like object ones (DrawEnvCell → DrawMesh →
      // RenderMeshSubset @ 0059ca10: CULLMODE_CW; only SidesType 1 draws
      // both faces) — keyed surfaceId * 4 + clampUV * 2 + bothFaces.
      const groupKey = surfaceId * 4 + (clamped(poly.posSurface) ? 2 : 0) + (poly.sidesType === 1 ? 1 : 0);
      let triList = surfaceGroups.get(groupKey);
      if (!triList) {
        triList = [];
        surfaceGroups.set(groupKey, triList);
      }

      // Fan triangulation with UV lookup — winding reversed for Y↔Z handedness flip
      let firstBufIdx = -1;
      let lastBufIdx = -1;

      for (let i = 0; i < verts.length; i++) {
        const vertKey = verts[i] & 0xFFFF;
        const uvI = i < poly.posUVIndices.length ? poly.posUVIndices[i] : 0;
        const bi = uvLookup.get(`${vertKey}:${uvI}`) ?? uvLookup.get(`${vertKey}:0`);

        if (bi === undefined) continue;

        if (i === 0) {
          firstBufIdx = bi;
        } else if (i >= 2) {
          triList.push(firstBufIdx, bi, lastBufIdx);
        }
        lastBufIdx = bi;
      }
    }

    // Create a mesh per surface
    for (const [groupKey, indices] of surfaceGroups) {
      if (indices.length === 0) continue;
      const surfaceId = Math.floor(groupKey / 4);
      const bothFaces = groupKey % 2 === 1;
      const clampUV = groupKey % 4 >= 2;

      const bufferGeom = new THREE.BufferGeometry();
      bufferGeom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      bufferGeom.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
      bufferGeom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
      bufferGeom.setIndex(new THREE.BufferAttribute(new Uint16Array(indices), 1));

      // CORE.17.e — Material.clone() drops onBeforeCompile, so re-apply the
      // retail shading patch to the per-cell copy. CORE.17.h.g.c.b — cell
      // structure geometry is what RenderDeviceD3D::DrawEnvCell @ 0059f170
      // draws under Render::environment_detail_surface (the objects inside
      // the cell are not), so the per-cell copy carries the detail pass.
      // CORE.17.q.a — cell geometry is the 'envcell' kind: the pooled static
      // DAT lights reach it through calc_point_light (burned vertex colours),
      // the dynamic ones through the hardware path.
      const material = applyRetailLighting(this.materialFactory.getMaterial(surfaceId, undefined, undefined, undefined, false, clampUV).clone(), 'envcell', 'environment');
      // VISUAL.lifestone-crystal-glow — a burned-in mesh (`burnedInStaticLights`
      // high bit, set by D3DPolyRender::SetStaticLightingVertexColors @ 0059cfe0)
      // takes its emissive FROM THE VERTEX in RenderMeshSubset @ 0059ca10, so
      // the surface luminosity MaterialFactory put on the object material never
      // reaches cell geometry.
      if (material instanceof THREE.MeshLambertMaterial) {
        material.emissive.setScalar(0);
        delete material.userData[SURFACE_LUMINOSITY_KEY];
      }
      // VISUAL.holtburg-roof-plank — no depth bias: retail leaves
      // D3DRS_DEPTHBIAS at 0 (RenderDeviceD3D::SetDefaultD3DStates) and
      // DrawEnvCell sets none. The former slope-scaled offset (factor −2)
      // pulled a cell's sloped attic ceiling, seen at a grazing angle from
      // outside, in front of the building's own roof 0.2–0.5 m above it.
      material.side = bothFaces ? THREE.DoubleSide : THREE.FrontSide;
      const mesh = new THREE.Mesh(bufferGeom, material);
      prepareSurfaceMesh(mesh); // the clip band / alpha-ref sync (MaterialFactory)
      mesh.userData.cellGeometry = true; // tag for collision filtering
      group.add(mesh);
    }

    return group;
  }

  /**
   * Create a Three.js Group for a single EnvCell.
   * Positioned at the cell's world position using its Frame data.
   */
  createCellMesh(cellId: number): THREE.Group | null {
    const envCell = this.loadEnvCell(cellId);
    if (!envCell) return null;

    const cellStruct = this.getCellStruct(envCell);
    if (!cellStruct) return null;

    const group = this.buildCellGeometry(cellStruct, envCell.surfaces);
    group.name = `envcell_${cellId.toString(16).padStart(8, '0')}`;
    // BUG.bunker-camera-in-head — interior geometry for the camera sweep (DungeonCollision.setMeshes).
    group.userData.envCellId = cellId >>> 0;

    // Position cell using its Frame + landblock world offset
    const worldOffsetX = landblockX(cellId) * 192;
    const worldOffsetZ = landblockY(cellId) * 192;

    const pos = envCell.position;
    // AC Z-up → Three.js Y-up: swap Y and Z, add landblock offsets
    // Small Y offset (+0.05) prevents z-fighting between building floors
    // and terrain at the same height (combined with material.polygonOffset)
    group.position.set(
      worldOffsetX + pos.origin.x,
      pos.origin.z + 0.05,         // AC z (up) → Three.js y + z-fight offset
      worldOffsetZ + pos.origin.y, // AC y (north) → Three.js z
    );
    group.quaternion.set(
      -pos.orientation.x,
      -pos.orientation.z,
      -pos.orientation.y,
      pos.orientation.w,
    );
    // PERF (2026-09-30): the cell is placed once. Bake its matrix and freeze
    // its own structural geometry (the children buildCellGeometry made); the
    // group keeps walking its children so the statics added below (some carry
    // animations or emitters) still update every frame.
    group.updateMatrixWorld(true);
    group.matrixAutoUpdate = false;
    for (const child of group.children) freezeStaticTransform(child);

    // Render static objects inside this cell (torches, furniture, decorations)
    // Reference: ACViewer R_EnvCell.DrawStaticObjs() — static objects use only
    // the landblock translation, NOT the cell's rotation. Since we parent them
    // under the cell group (which has the cell's rotation), we must apply the
    // inverse cell rotation to both position offsets and orientations so Three.js's
    // automatic parent rotation produces the correct world-space result.
    const cellOrigin = envCell.position.origin;
    const invCellQuat = new THREE.Quaternion(
      -pos.orientation.x,
      -pos.orientation.z,
      -pos.orientation.y,
      pos.orientation.w,
    ).invert();
    // PERF.1 (town-facing part-bucket slice) — cell static objects batch
    // into per-cell InstancedMeshes, one per (GfxObj, submesh) used in THIS
    // cell, parented under the cell group so visibility (stab set + PVS +
    // portal gating) and streaming lifecycle are untouched. The instance
    // matrices are the exact cell-local transforms the per-object path
    // applied below (same inverse-cell-rotation correction, exact DAT frame),
    // geometry/materials are the same shared templates — pixels identical.
    // Pre-fix this was the largest town-facing draw-call bucket at Holtburg
    // (~973 calls: every through-the-door-visible cottage interior drew each
    // furniture part-surface as its own Mesh).
    const furnitureEntries: InstanceEntry[] = [];
    for (const stab of envCell.staticObjects) {
      const highByte = (stab.id >> 24) & 0xff;
      // SWEEP1006B — a Setup with a DefaultAnimation loops it (CPartArray::
      // InitDefaults → CPhysics static_animating_objects): its parts move, so
      // it is built per-object, never instanced (StaticAnimationDriver).
      const defaultAnim = highByte === PortalFileType.Setup && this.setupModelRenderer
        ? (this.setupModelRenderer.loadSetupModel(stab.id)?.defaultAnimation ?? 0) : 0;
      if (!defaultAnim && this.instancer && this.instancer.hasModel(stab.id)) {
        // VISUAL.holtburg-roof-plank — at the stab's exact DAT frame (ACE
        // EnvCell: staticObj.add_obj_to_cell(this, StaticObjectFrames[i])).
        const offset = new THREE.Vector3(
          stab.frame.origin.x - cellOrigin.x,
          stab.frame.origin.z - cellOrigin.z,
          stab.frame.origin.y - cellOrigin.y,
        );
        offset.applyQuaternion(invCellQuat);
        const localQuat = invCellQuat.clone().multiply(new THREE.Quaternion(
          -stab.frame.orientation.x,
          -stab.frame.orientation.z,
          -stab.frame.orientation.y,
          stab.frame.orientation.w,
        ));
        furnitureEntries.push({
          objId: stab.id,
          matrix: new THREE.Matrix4().compose(offset, localQuat, new THREE.Vector3(1, 1, 1)),
        });
        // GAP.2 lights ride a transform-only anchor at the same local frame
        // the per-object group had, so light world positions are unchanged.
        // VISUAL.dat-static-default-scripts — so does the Setup's
        // DefaultScript (torch flames, brazier fire; StaticScriptDriver).
        if (highByte === PortalFileType.Setup && this.setupModelRenderer) {
          const setup = this.setupModelRenderer.loadSetupModel(stab.id);
          if (setup && (setup.lights.size > 0 || setup.defaultScript)) {
            const anchor = new THREE.Object3D();
            anchor.position.copy(offset);
            anchor.quaternion.copy(localQuat);
            if (setup.lights.size > 0) this.attachDatLights(anchor, setup.lights.values());
            if (setup.defaultScript) tagStaticScriptAnchor(anchor, stab.id, setup.defaultScript);
            group.add(anchor);
          }
        }
        continue;
      }
      let obj: THREE.Group | null = null;
      try {
        if (highByte === PortalFileType.Setup && this.setupModelRenderer) {
          obj = this.setupModelRenderer.createSetupMesh(stab.id);
        } else if (highByte === PortalFileType.GraphicsObject && this.modelRenderer) {
          obj = this.modelRenderer.createMesh(stab.id);
          // CORE.17.h.g.c.c.a — a bare GfxObj stab is a one-part CPhysicsObj:
          // the group is both the part and the object.
          if (obj && this.degradeLod) {
            const mr = this.modelRenderer;
            this.degradeLod.attachPart(obj, stab.id, id => mr.createMesh(id), obj);
          }
        }
      } catch { /* skip unrenderable objects */ }
      if (obj) {
        // VISUAL.holtburg-roof-plank — the stab sits at its exact DAT frame
        // (ACE EnvCell add_obj_to_cell; collision already used it). The old
        // "-bbox.min.y base lift" raised pivot-centred models by up to half
        // their height — Holtburg's attic stabs 0x01000bc6 (2.6 m) and
        // 0x01000621 (0.56 m) poked through the cottage roof.
        const offset = new THREE.Vector3(
          stab.frame.origin.x - cellOrigin.x,
          stab.frame.origin.z - cellOrigin.z,
          stab.frame.origin.y - cellOrigin.y,
        );
        // Undo parent cell rotation so final world pos = worldOffset + stab.origin
        offset.applyQuaternion(invCellQuat);
        obj.position.copy(offset);

        // Object's own rotation, also corrected for parent cell rotation
        const stabQuat = new THREE.Quaternion(
          -stab.frame.orientation.x,
          -stab.frame.orientation.z,
          -stab.frame.orientation.y,
          stab.frame.orientation.w,
        );
        obj.quaternion.copy(invCellQuat.clone().multiply(stabQuat));
        // CORE.17.q.b — a cell stab is drawn by PView::DrawCells →
        // DrawObjCell @ 005a1a40 inside the useSunlightSet(0) span: no
        // sun, the pool lights through the hardware path.
        setCellLighting(obj, true);
        group.add(obj);

        // GAP.2 — DAT-driven dungeon lighting. Setup models carry a Lights
        // dict (LightInfo: viewer-space frame + _RGB color + intensity +
        // falloff + coneAngle, per ACE.DatLoader/Entity/LightInfo.cs); the
        // retail dungeons were lit exclusively by these (torch sconces,
        // braziers, lamps). Attach a THREE.PointLight per LightInfo,
        // parented to the placed object so the existing cell streaming
        // adds/removes them with their cell. Falloff maps to Three's
        // `distance` with decay=1 — the era-correct D3D fixed-function
        // linear attenuation with an absolute range, matching how the
        // retail engine consumed falloff.
        if (highByte === PortalFileType.Setup && this.setupModelRenderer) {
          const setup = this.setupModelRenderer.loadSetupModel(stab.id);
          if (setup && setup.lights.size > 0) {
            this.attachDatLights(obj, setup.lights.values());
          }
          if (setup?.defaultScript) tagStaticScriptAnchor(obj, stab.id, setup.defaultScript);
          if (defaultAnim) tagStaticDefaultAnimation(obj, stab.id, defaultAnim);
        }
      }
    }

    // PERF.1 — emit the per-cell instanced furniture batches (empty when the
    // instancer is unset or every stab fell back to the per-object path).
    // CORE.17.h.g.c.c.a — the batches are a per-cell SceneryInstancePool so
    // each family partitions into degrade levels like the landscape pools
    // (same collectSubmeshInstances matrices, same shared templates; with no
    // degrade system wired every instance stays at level 0 — the one-shot
    // buildInstances picture).
    if (this.instancer && furnitureEntries.length > 0) {
      // CORE.17.q.b — the batched stabs draw through their `cellobject`
      // variants (the same no-sun / pool-light set as the per-object path).
      const pool = new SceneryInstancePool(
        this.instancer, 'envfurninst',
        m => group.add(m), m => group.remove(m),
        // CORE.17.h.g.c.c.c — env cells: CObjCell::GetViewerDistance is 0,
        // every stab takes the per-object path.
        { materialFor: (m, g) => cellObjectVariantOf(m, g), lod: this.degradeLod, landCells: false },
      );
      pool.addBlock(cellId >>> 0, furnitureEntries);
      if (this.degradeLod) this.furniture.add({ group, pool });
    }

    return group;
  }

  /**
   * GAP.2 — DAT-driven dungeon lighting. Setup models carry a Lights dict
   * (LightInfo: viewer-space frame + _RGB color + intensity + falloff +
   * coneAngle, per ACE.DatLoader/Entity/LightInfo.cs); the retail dungeons
   * were lit exclusively by these (torch sconces, braziers, lamps). Attach a
   * THREE.PointLight per LightInfo, parented to the placed object (or its
   * transform anchor on the instanced path) so the existing cell streaming
   * adds/removes them with their cell. Falloff maps to Three's `distance`
   * with decay=1 — the era-correct D3D fixed-function linear attenuation
   * with an absolute range, matching how the retail engine consumed falloff.
   */
  private attachDatLights(
    parent: THREE.Object3D,
    lights: Iterable<{ color: number; intensity: number; falloff: number; viewerSpaceLocation: Frame }>,
  ): void {
    for (const light of lights) {
      // CORE.17.q — D3DLIGHT.Range = falloff × rangeAdjust (1.5), Diffuse =
      // raw colour bytes × intensity, attenuation 1/d
      // (PrimD3DRender::config_hardware_light @ 0059ad30; rangeAdjust =
      // acclient.exe .data @ 0x820cc4). The high byte is always FF (LightInfo.cs).
      // CORE.17.q.a — decay is the light-class channel: −intensity marks a
      // STATIC light (the burned-in calc_point_light path on env cells; the
      // hardware 1/d path on objects ignores the tag).
      const pl = new THREE.PointLight(rawByteColor(light.color), light.intensity, retailLightRange(light.falloff), retailStaticLightDecay(light.intensity));
      const lp = light.viewerSpaceLocation.origin;
      pl.position.set(lp.x, lp.z, lp.y); // AC (x,y,z) → Three (x,z,y)
      pl.userData.datLight = true;
      // Lights start DISABLED — DatLightBudget (main.ts) enables the
      // retail static list: the nearest Render::max_static_lights (40 at
      // deg_mul 0) to the player, per Render::insert_light. A cell stab is a
      // STATIC physics object, so its LightInfo is a `state & 1` light
      // (CPartArray::InitLights @ 00518c00) — CORE.17.h.g.c.c.b.
      pl.visible = false;
      parent.add(pl);
    }
  }

  /**
   * Get the number of cached Environments.
   */
  get cacheSize(): number {
    return this.envCache.size;
  }

  /**
   * Clear all caches.
   */
  clear(): void {
    this.envCache.clear();
  }
}
