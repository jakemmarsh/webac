import { averageTextureColor } from '../remaster/GrassField.js';
import * as THREE from 'three';
import { TERRAIN_RENDER_ORDER } from '../world/PortalPunch.js';
import { freezeStaticTransform } from '../utils/freezeStatic.js';
import {
  LandblockMesh, LandblockGeometry, BlockDirection, buildLandblockLod, retailBlockLod,
  type BlockLod,
} from './LandblockMesh.js';
import { TerrainManager } from './TerrainManager.js';
import type { TMTerrainDesc, RoadAlphaMap, TerrainAlphaMap, TexMerge } from '@ac/dat-parser/file-types/RegionDesc.js';
import type { TextureManager } from '../models/TextureManager.js';
import { LruMap } from '../utils/LruMap.js';
import { OverlayMergePool, type PooledOverlayBucket } from './OverlayMergePool.js';
import { applyRetailLighting } from '../models/RetailLighting.js';
import { textureSamplerPrefs, EOL_REGION_BASE_TEX_SIZE } from '../models/TextureSamplerPrefs.js';
import { disposeOwnedMaterials } from '../models/MaterialOwnership.js';
import {
  cellAlphaUVs, cellPalCode, terrainBlend, roadCodes, roadCornersFromMask,
  findTerrainAlpha, findRoadAlpha,
} from './TexMergeCodes.js';

/**
 * Optional callback invoked once per loaded landblock. Returns a list of
 * Object3Ds (already added to the scene by the callback) that this renderer
 * will dispose when the landblock unloads. Use it to attach scenery, lights,
 * particle emitters, or any other DAT-driven decoration that scopes to a
 * single landblock's lifetime.
 */
export type LandblockAttacher = (
  fileId: number,
  worldOffsetX: number,
  worldOffsetZ: number,
) => THREE.Object3D[];

/**
 * CORE.14.c: one merged-geometry accumulation bucket for overlay quads that
 * share a material. Road/blend overlays used to be one Mesh+Material per cell
 * quad (~1,459 draw calls at Holtburg); quads sharing a material are
 * concatenated into a single BufferGeometry — since PERF.1's OverlayMergePool,
 * one per (layer, material) key across ALL loaded landblocks. Alpha-map
 * rotation lives in the UVs, and quads never share vertices, so the merged
 * geometry (computeVertexNormals included) is bit-identical to the per-quad
 * output.
 */
export interface OverlayQuadBucket {
  verts: number[];
  uvs: number[];
  indices: number[];
  quadCount: number;
  material: THREE.Material;
  /** Overlay layer index within a cell (blend overlay index / road rCode
   *  slot). The pool turns the bucket's rank into the mesh's renderOrder so
   *  intra-cell stacking holds from any camera position (see
   *  OverlayMergePool / BUG.road-flicker-running). */
  layer: number;
}

/**
 * DECOMP.terrain-lod — the per-cell inputs the overlay/material builders
 * read, for a block at any retail LOD: a full-resolution LandblockMesh
 * (side 8) or a reduced LandblockLodMesh (side 4 / 2 / 1).
 */
interface CellView {
  /** Cells per side (8 = full resolution). */
  side: number;
  /** Vertex positions, x-major (side+1)², height in [1]. */
  positions: Float32Array;
  cellTerrainTypes: number[];
  cellRoadMasks: number[];
  cellCornerTerrainTypes: number[];
  cellCornerRoadBits: number[];
}

/**
 * TerrainRenderer — creates Three.js meshes from terrain data
 * and manages them in a scene.
 *
 * Each loaded landblock becomes a Three.js Mesh with BufferGeometry.
 * Landblocks are positioned in world space: x = blockX * 192, z = blockY * 192.
 *
 * When Region terrain data is provided, creates multi-material meshes
 * with per-cell texture assignment based on terrain types.
 */
export class TerrainRenderer {
  private scene: THREE.Scene;
  private terrainManager: TerrainManager;
  private meshes: Map<number, THREE.Mesh> = new Map();
  private material: THREE.Material;
  /** PERF.1 — cross-landblock road/blend overlay pool: one Mesh per distinct
   *  (layer, base texture, alpha map) key REGION-WIDE instead of per block. */
  private overlayPool: OverlayMergePool;

  /** Map from terrain type index → Three.js material (when using Region data) */
  private terrainMaterials: Map<number, THREE.Material> = new Map();
  /** Whether multi-material mode is active */
  private useMultiMaterial = false;
  /** Loaded road alpha textures keyed by roadTexGID.
   *  ASSESS: bounded leak backstop (fresh-eyes audit 2026-06-10). RegionDesc's
   *  TexMerge defines only a few dozen road/terrain alpha maps, so 128 never
   *  evicts in practice; evicted textures are disposed (THREE re-uploads a
   *  disposed DataTexture from retained CPU pixels if a live quad still
   *  references it). */
  private roadAlphaTextures = new LruMap<number, THREE.DataTexture>(
    128,
    (_gid, tex) => { textureSamplerPrefs.unregister(tex); tex.dispose(); },
  );
  /** Road alpha maps from RegionDesc */
  private roadMaps: RoadAlphaMap[] = [];
  /** Road terrain base texture (terrainType 0x20) */
  private roadBaseTex: THREE.DataTexture | null = null;
  /** Whether road rendering is enabled */
  private useRoads = false;

  /** Terrain alpha textures keyed by texGID — same bounding rationale as roadAlphaTextures. */
  private terrainAlphaTextures = new LruMap<number, THREE.DataTexture>(
    128,
    (_gid, tex) => { textureSamplerPrefs.unregister(tex); tex.dispose(); },
  );
  /** Corner terrain alpha maps from RegionDesc */
  private cornerTerrainMaps: TerrainAlphaMap[] = [];
  /** Side terrain alpha maps from RegionDesc */
  private sideTerrainMaps: TerrainAlphaMap[] = [];
  /** Map from terrain type → base texture for terrain blending */
  private terrainBaseTextures: Map<number, THREE.DataTexture> = new Map();
  /** The region's TexMerge::base_tex_size (CORE.17.h.g.c.a merge size). */
  private baseTexSize = EOL_REGION_BASE_TEX_SIZE;
  /** Whether terrain blending is enabled */
  private useTerrainBlend = false;
  /** CORE.14.c: merged-overlay materials shared across landblocks — keyed by
   *  road alpha GID ('full' for full-road cells) / `terrainType|alphaGID`.
   *  Marked userData.sharedOverlayMaterial so per-landblock unload keeps
   *  them alive; clear() disposes them. */
  private mergedRoadMaterials = new Map<string, THREE.MeshLambertMaterial>();
  private mergedBlendMaterials = new Map<string, THREE.MeshLambertMaterial>();
  /** Per-terrain-type tiled clone of the overlay base texture (repeat baked
   *  in) — one clone per type instead of one per cell quad. */
  private tiledBlendTextures = new Map<number, THREE.DataTexture>();
  /** TextureManager reference for lazy-loading alpha textures */
  private textureManager: TextureManager | null = null;

  /**
   * DECOMP.terrain-lod — each block's current retail LOD (LScape::
   * get_block_orient relative to the viewer's block) and the viewer block
   * it was computed for. A reduced block (side < 8) draws one TexMerge
   * surface per cell built at size / 4 (CLandBlockStruct::GetCellRotation
   * packs size code 4 into the surface code for any lod ≠ 1;
   * TexMerge::MakeNewSurface @ 005049b0 divides the merged size by it), so
   * its materials are separate clones registered at base_tex_size / 4.
   */
  private blockLods = new Map<number, BlockLod>();
  private viewerBlock: { x: number; y: number } | null = null;
  /** The region's TexMerge::base_tex_size the terrain materials were built for. */
  private terrainBaseTexSize = EOL_REGION_BASE_TEX_SIZE;
  private coarseTerrainMaterials = new Map<number, THREE.Material>();
  private coarseBlendMaterials = new Map<string, THREE.MeshLambertMaterial>();
  private coarseTiledBlendTextures = new Map<number, THREE.DataTexture>();
  private coarseRoadMaterials = new Map<string, THREE.MeshLambertMaterial>();
  private coarseRoadBaseTex: THREE.DataTexture | null = null;
  private coarseAlphaTextures = new Map<THREE.DataTexture, THREE.DataTexture>();
  /** Textures created for coarse materials (disposed in clear()). */
  private coarseOwnedTextures = new Set<THREE.DataTexture>();

  /** Optional callback fired once per loaded landblock — return Object3Ds to dispose on unload. */
  private attacher: LandblockAttacher | null = null;
  /** Per-landblock attachments (e.g. scenery objects) returned by the attacher. */
  private attachments: Map<number, THREE.Object3D[]> = new Map();
  /** PERF.1 — optional callback fired once per UNloaded landblock, for
   *  resources the attacher routed outside the attachment list (the
   *  cross-landblock SceneryInstancePool retires the block's instances). */
  private detacher: ((fileId: number) => void) | null = null;

  constructor(scene: THREE.Scene, terrainManager: TerrainManager, material?: THREE.Material) {
    this.scene = scene;
    this.terrainManager = terrainManager;
    this.overlayPool = new OverlayMergePool(scene);
    // Default material: green terrain with flat shading
    this.material = material ?? applyRetailLighting(new THREE.MeshLambertMaterial({
      color: 0x4a7c2e,
      flatShading: true,
      side: THREE.DoubleSide,
    }), 'landscape');
  }

  /**
   * Register a callback fired once per loaded landblock — returns the Object3Ds
   * that should be disposed when the landblock unloads. Used for DAT-driven
   * scenery (trees/rocks/plants), per-landblock lights, etc.
   */
  setLandblockAttacher(attacher: LandblockAttacher | null): void {
    this.attacher = attacher;
  }

  /** Register a callback fired once per unloaded landblock (see `detacher`). */
  setLandblockDetacher(detacher: ((fileId: number) => void) | null): void {
    this.detacher = detacher;
  }

  /** BUG.sealed-interior-renders-outdoor-terrain — whether the outdoor
   *  landscape (terrain meshes, blend/road overlays, scenery attachments) is
   *  drawn. Sealed interiors (EnvCell SeenOutside unset) hide it entirely,
   *  matching ACE's ObjectMaint gate; meshes streamed in while hidden are
   *  created hidden. */
  private landscapeVisible = true;

  setLandscapeVisible(visible: boolean): void {
    if (this.landscapeVisible === visible) return;
    this.landscapeVisible = visible;
    for (const mesh of this.meshes.values()) mesh.visible = visible;
    this.overlayPool.setVisible(visible);
    for (const objs of this.attachments.values()) {
      for (const o of objs) o.visible = visible;
    }
  }

  /**
   * Build terrain materials from Region TMTerrainDesc data.
   * Maps each terrain type to a textured material.
   *
   * CORE.17.h.g.c.a — `baseTexSize` is the region's TexMerge::base_tex_size:
   * with the Landscape Texture Detail level it fixes the merged per-cell
   * texture size M, and the terrain texture repeats M / 512 times per cell
   * (TextureSamplerPrefs keeps the repeat in step with the level).
   */
  buildTerrainMaterials(
    tmTerrainDescs: TMTerrainDesc[],
    textureManager: TextureManager,
    baseTexSize: number = EOL_REGION_BASE_TEX_SIZE,
  ): void {
    this.terrainBaseTexSize = baseTexSize || EOL_REGION_BASE_TEX_SIZE;
    for (const desc of tmTerrainDescs) {
      if (this.terrainMaterials.has(desc.terrainType)) continue;

      const texGID = desc.terrainTex.texGID;
      // CORE.17.h.g.c — 'landscape': scaled by Landscape Texture Detail
      // (retail ImgTex::fLandTextureScale via TexMerge), not Environment.
      const tex = textureManager.getTexture(texGID, undefined, false, 'landscape');
      if (tex) {
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        // UVs span 0-1 across the full landblock (8 cells); the prefs set
        // repeat = 8 × landscapeRepeatsPerCell(M, 512) — retail's TexMerge
        // copies the texture 1:1 into an M-px cell (TileCSI @ 0053e740), so
        // TerrainTex.texTiling (2) only shows at High, where M = 1024.
        textureSamplerPrefs.register(tex, 'landscape', undefined, { landscape: { uvCells: 8, baseTexSize } });

        // CORE.17.e — landscape shades per CLandBlockStruct::calc_lighting
        // (no object ambient boost), see RetailLighting.
        const mat = applyRetailLighting(new THREE.MeshLambertMaterial({
          map: tex,
          side: THREE.DoubleSide,
        }), 'landscape');
        this.terrainMaterials.set(desc.terrainType, mat);
      }
    }
    this.useMultiMaterial = this.terrainMaterials.size > 0;
  }

  /**
   * Build road overlay data from Region TexMerge road maps.
   * Loads road alpha textures and the road base texture.
   */
  buildRoadOverlays(texMerge: TexMerge, textureManager: TextureManager): void {
    this.roadMaps = texMerge.roadMaps;
    if (this.roadMaps.length === 0) return;

    // Load road alpha textures.
    // AC road alpha maps: alpha=0 means "road here", alpha=255 means "no road".
    // ACViewer shader inverts: result.a = 1 - roadAlpha0.a (texture_clamp.fx:452)
    // Three.js alphaMap: high value = opaque. So we must invert: 255 - alpha.
    for (const rm of this.roadMaps) {
      if (this.roadAlphaTextures.has(rm.roadTexGID)) continue;
      // CORE.17.h.g.c — built from the full-resolution source pixels
      // (getRGBA), never from a DataTexture image that the Landscape Texture
      // Detail level may already have scaled; the alpha map is then
      // registered as a landscape alpha map so it follows the merge size
      // (CORE.17.h.g.c.a: point-subsampled like MergeTexture's alpha read)
      // and filters with the rest.
      const rgba = textureManager.getRGBA(rm.roadTexGID);
      if (rgba) {
        const src = rgba.data;
        const w = rgba.width;
        const h = rgba.height;
        const dst = new Uint8Array(w * h * 4);
        for (let i = 0; i < w * h; i++) {
          const inverted = 255 - src[i * 4 + 3]; // invert alpha (0=road → 255=opaque)
          dst[i * 4] = inverted;     // R
          dst[i * 4 + 1] = inverted; // G
          dst[i * 4 + 2] = inverted; // B
          dst[i * 4 + 3] = 255;
        }
        const alphaTex = new THREE.DataTexture(dst, w, h, THREE.RGBAFormat);
        alphaTex.wrapS = THREE.ClampToEdgeWrapping;
        alphaTex.wrapT = THREE.ClampToEdgeWrapping;
        alphaTex.needsUpdate = true;
        textureSamplerPrefs.register(alphaTex, 'landscapeAlpha');
        this.roadAlphaTextures.set(rm.roadTexGID, alphaTex);
      }
    }

    // Find road terrain texture (terrainType 0x20). CORE.17.h.g.c.a — the
    // road quads carry per-cell UVs, so they draw a clone of the (shared,
    // landblock-UV) terrain texture laid out one cell per UV — the shared
    // instance's 8-cells-per-UV repeat used to reach the roads too (16
    // repeats per cell). Sampled through the unrotated `uv1` channel:
    // MergeTexture rotates only the alpha map, never the road texture.
    const ROAD_TYPE = 0x20;
    for (const desc of texMerge.terrainDesc) {
      if (desc.terrainType === ROAD_TYPE) {
        const tex = textureManager.getTexture(desc.terrainTex.texGID, undefined, false, 'landscape');
        if (tex) {
          if (this.roadBaseTex) { textureSamplerPrefs.unregister(this.roadBaseTex); this.roadBaseTex.dispose(); }
          this.roadBaseTex = this.cellLayoutClone(tex, texMerge.baseTexSize);
        }
        break;
      }
    }

    this.useRoads = this.roadAlphaTextures.size > 0;
  }

  /**
   * Build terrain blend overlay data from TexMerge corner/side alpha maps.
   * Loads alpha textures for terrain transitions.
   */
  buildTerrainBlendOverlays(texMerge: TexMerge, textureManager: TextureManager): void {
    this.cornerTerrainMaps = texMerge.cornerTerrainMaps;
    this.sideTerrainMaps = texMerge.sideTerrainMaps;
    this.textureManager = textureManager;
    this.baseTexSize = texMerge.baseTexSize || EOL_REGION_BASE_TEX_SIZE;

    if (this.cornerTerrainMaps.length === 0 && this.sideTerrainMaps.length === 0) return;

    // Pre-load all terrain alpha textures (corner + side maps)
    const allMaps = [...this.cornerTerrainMaps, ...this.sideTerrainMaps];
    for (const am of allMaps) {
      if (this.terrainAlphaTextures.has(am.texGID)) continue;
      const rgba = textureManager.getRGBA(am.texGID);
      if (rgba) {
        // Terrain alpha maps: like road alpha, alpha=0 means "overlay here", alpha=255 = "no overlay"
        // Three.js alphaMap: high value = opaque. So invert.
        // CORE.17.h.g.c — full-resolution source pixels (see buildRoadOverlays).
        const src = rgba.data;
        const w = rgba.width;
        const h = rgba.height;
        const dst = new Uint8Array(w * h * 4);
        for (let i = 0; i < w * h; i++) {
          const inverted = 255 - src[i * 4 + 3];
          dst[i * 4] = inverted;
          dst[i * 4 + 1] = inverted;
          dst[i * 4 + 2] = inverted;
          dst[i * 4 + 3] = 255;
        }
        const alphaTex = new THREE.DataTexture(dst, w, h, THREE.RGBAFormat);
        alphaTex.wrapS = THREE.ClampToEdgeWrapping;
        alphaTex.wrapT = THREE.ClampToEdgeWrapping;
        alphaTex.needsUpdate = true;
        textureSamplerPrefs.register(alphaTex, 'landscapeAlpha');
        this.terrainAlphaTextures.set(am.texGID, alphaTex);
      }
    }

    // Store per-terrain-type base textures for overlay rendering
    for (const desc of texMerge.terrainDesc) {
      if (this.terrainBaseTextures.has(desc.terrainType)) continue;
      const tex = textureManager.getTexture(desc.terrainTex.texGID, undefined, false, 'landscape');
      if (tex) this.terrainBaseTextures.set(desc.terrainType, tex);
    }

    this.useTerrainBlend = this.terrainAlphaTextures.size > 0;
  }

  /** Global draw-rank bands for pooled overlay buckets: blend layers first
   *  (rank = layer index), then the opaque full-road bucket, then alpha road
   *  layers — mirroring the per-landblock creation order (blend group before
   *  road group; road buckets sorted 'full' first). */
  static readonly ROAD_RANK_FULL = 100;
  static readonly ROAD_RANK_ALPHA = 101;

  /**
   * Collect terrain blend overlay quads for a landblock into pooled buckets
   * keyed by (layer, overlay terrain type, alpha map) — vertices in WORLD
   * space (worldX/worldZ = landblock origin) for the cross-landblock pool.
   */
  private collectTerrainBlendBuckets(
    block: CellView | LandblockMesh, fileId: number, worldX: number, worldZ: number,
    buckets: Map<string, PooledOverlayBucket>,
  ): void {
    const lbMesh = TerrainRenderer.cellView(block);
    const side = lbMesh.side;
    const svc = side + 1;
    const coarse = side < 8;
    const CELL_SIZE = 192 / side;
    const positions = lbMesh.positions;

    for (let col = 0; col < side; col++) {
      for (let row = 0; row < side; row++) {
        const cellIdx = col * side + row;
        const cornerBase = cellIdx * 4;

        // Get 4 corner terrain types: SW, SE, NE, NW
        const t1 = lbMesh.cellCornerTerrainTypes[cornerBase];
        const t2 = lbMesh.cellCornerTerrainTypes[cornerBase + 1];
        const t3 = lbMesh.cellCornerTerrainTypes[cornerBase + 2];
        const t4 = lbMesh.cellCornerTerrainTypes[cornerBase + 3];

        // Skip if all corners are the same terrain type — no blending needed
        if (t1 === t2 && t1 === t3 && t1 === t4) continue;

        // Get road bits
        const r1 = lbMesh.cellCornerRoadBits[cornerBase];
        const r2 = lbMesh.cellCornerRoadBits[cornerBase + 1];
        const r3 = lbMesh.cellCornerRoadBits[cornerBase + 2];
        const r4 = lbMesh.cellCornerRoadBits[cornerBase + 3];

        // The cell's palcode (GetCellRotation; size code 4 on a reduced
        // block) and its base + overlays (TexMerge::GetTerrain).
        const pcode = cellPalCode(r1, r2, r3, r4, t1, t2, t3, t4, coarse);
        const blendInfo = terrainBlend(pcode);
        if (blendInfo.overlays.length === 0) continue;

        // Get terrain heights at the 4 corners
        const swIdx = (col * svc + row) * 3;
        const seIdx = ((col + 1) * svc + row) * 3;
        const nwIdx = (col * svc + (row + 1)) * 3;
        const neIdx = ((col + 1) * svc + (row + 1)) * 3;
        const hSW = positions[swIdx + 1];
        const hSE = positions[seIdx + 1];
        const hNW = positions[nwIdx + 1];
        const hNE = positions[neIdx + 1];

        // Cell position in world space
        const cx = worldX + col * CELL_SIZE;
        const cz = worldZ + row * CELL_SIZE;

        // Triangle split direction (DECOMP.terrain-lod: the coarse cell
        // index, as ConstructPolygons keys it)
        const splitNWtoSE = LandblockMesh.getSplitDir(fileId, col, row);

        // Accumulate overlay quads for each terrain blend layer into
        // per-(layer, terrain type, alpha map) merged buckets
        for (let li = 0; li < blendInfo.overlays.length; li++) {
          const overlay = blendInfo.overlays[li];
          const alphaResult = findTerrainAlpha(
            this.cornerTerrainMaps,
            this.sideTerrainMaps,
            overlay.tcode,
            pcode,
          );
          if (!alphaResult) continue;

          const alphaGID = alphaResult.alphaMap.texGID;
          const alphaTex = this.terrainAlphaTextures.get(alphaGID);
          if (!alphaTex) continue;

          const overlayBaseTex = this.terrainBaseTextures.get(overlay.terrainType);
          if (!overlayBaseTex) continue;

          const key = `${coarse ? 'bc' : 'b'}|${li}|${overlay.terrainType}|${alphaGID}`;
          let bucket = buckets.get(key);
          if (!bucket) {
            bucket = {
              verts: [], uvs: [], indices: [], quadCount: 0, layer: li,
              rank: li, name: 'blendmerge',
              material: coarse
                ? this.getCoarseBlendMaterial(overlay.terrainType, overlayBaseTex, alphaGID, alphaTex)
                : this.getMergedBlendMaterial(overlay.terrainType, overlayBaseTex, alphaGID, alphaTex),
            };
            buckets.set(key, bucket);
          }
          TerrainRenderer.appendOverlayQuad(
            bucket, cx, cz, CELL_SIZE, hSW, hSE, hNW, hNE,
            alphaResult.rotation, splitNWtoSE,
          );
        }
      }
    }
  }

  /**
   * Append one overlay quad (4 verts / 2 tris) to a merged bucket.
   * Vertex order SW, SE, NW, NE; alpha-map rotation baked into UVs; the
   * triangle split matches the terrain cell so the overlay lies exactly on it.
   * The map texture's repeat is a texture-level transform on the material,
   * and the map samples the unrotated `uv1` channel the OverlayMergePool
   * adds per quad (CORE.17.h.g.c.a), so it needs nothing from the bucket.
   */
  static appendOverlayQuad(
    bucket: OverlayQuadBucket,
    cx: number, cz: number, size: number,
    hSW: number, hSE: number, hNW: number, hNE: number,
    rotation: number,
    splitNWtoSE: boolean,
  ): void {
    const base = bucket.quadCount * 4;
    bucket.verts.push(
      cx,        hSW, cz,            // SW
      cx + size, hSE, cz,            // SE
      cx,        hNW, cz + size,     // NW
      cx + size, hNE, cz + size,     // NE
    );
    // The alpha map rotated as ImgTex::MergeTexture samples it, mapped
    // north-up as CLandBlockStruct::land_uvs lays the surface on the cell.
    const rotUVs = cellAlphaUVs(rotation);
    for (let i = 0; i < 8; i++) bucket.uvs.push(rotUVs[i]);
    if (splitNWtoSE) {
      bucket.indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
    } else {
      bucket.indices.push(base, base + 2, base + 3, base, base + 3, base + 1);
    }
    bucket.quadCount++;
  }

  /**
   * CORE.17.h.g.c.a — a clone of a shared terrain texture for the per-cell
   * overlay quads: one cell per UV (the prefs set repeat = M / 512 per the
   * detail level) on the unrotated `uv1` channel, since retail's
   * ImgTex::MergeTexture @ 0053e870 reads the terrain/road texture straight
   * and rotates only the alpha map (`uv`). The clone shares the base
   * texture's Source and is registered with the same full-res record, so a
   * detail change re-images both together.
   */
  private cellLayoutClone(baseTex: THREE.DataTexture, baseTexSize: number): THREE.DataTexture {
    const tex = baseTex.clone();
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.channel = 1;
    tex.needsUpdate = true;
    textureSamplerPrefs.register(tex, 'landscape', textureSamplerPrefs.fullResOf(baseTex) ?? undefined, {
      landscape: { uvCells: 1, baseTexSize: baseTexSize || EOL_REGION_BASE_TEX_SIZE },
    });
    return tex;
  }

  /**
   * Shared material for merged terrain blend overlays: the overlay terrain
   * texture (one per-cell clone per terrain type, see cellLayoutClone) +
   * alpha map. Same settings the per-quad materials used.
   */
  private getMergedBlendMaterial(
    terrainType: number, baseTex: THREE.DataTexture,
    alphaGID: number, alphaMap: THREE.DataTexture,
  ): THREE.Material {
    const key = `${terrainType}|${alphaGID}`;
    let mat = this.mergedBlendMaterials.get(key);
    if (!mat) {
      let terrainTex = this.tiledBlendTextures.get(terrainType);
      if (!terrainTex) {
        terrainTex = this.cellLayoutClone(baseTex, this.baseTexSize);
        this.tiledBlendTextures.set(terrainType, terrainTex);
      }
      mat = applyRetailLighting(new THREE.MeshLambertMaterial({
        map: terrainTex,
        alphaMap,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }), 'landscape');
      mat.userData.sharedOverlayMaterial = true;
      this.mergedBlendMaterials.set(key, mat);
    }
    return mat;
  }

  /**
   * Collect road overlay quads for a landblock into pooled buckets keyed by
   * (road slot, alpha map) — vertices in WORLD space for the pool.
   */
  private collectRoadOverlayBuckets(
    block: CellView | LandblockMesh, fileId: number, worldX: number, worldZ: number,
    buckets: Map<string, PooledOverlayBucket>,
  ): void {
    const lbMesh = TerrainRenderer.cellView(block);
    const side = lbMesh.side;
    const svc = side + 1;
    const coarse = side < 8;
    const CELL_SIZE = 192 / side;
    const positions = lbMesh.positions;
    const pre = coarse ? 'rc' : 'r';

    for (let col = 0; col < side; col++) {
      for (let row = 0; row < side; row++) {
        const cellIdx = col * side + row;
        const mask = lbMesh.cellRoadMasks[cellIdx];
        if (mask === 0) continue;

        const { rCodes, allRoad } = roadCodes(roadCornersFromMask(mask));

        // Get terrain heights at the 4 corners for this cell
        const swIdx = (col * svc + row) * 3;
        const seIdx = ((col + 1) * svc + row) * 3;
        const nwIdx = (col * svc + (row + 1)) * 3;
        const neIdx = ((col + 1) * svc + (row + 1)) * 3;
        const hSW = positions[swIdx + 1]; // y component
        const hSE = positions[seIdx + 1];
        const hNW = positions[nwIdx + 1];
        const hNE = positions[neIdx + 1];

        // Cell position in world space
        const cx = worldX + col * CELL_SIZE;
        const cz = worldZ + row * CELL_SIZE;

        // FindRoadAlpha seeds its pick with the cell's palcode.
        const cb = cellIdx * 4;
        const ct = lbMesh.cellCornerTerrainTypes;
        const cr = lbMesh.cellCornerRoadBits;
        const cellPcode = cellPalCode(
          cr[cb] ?? 0, cr[cb + 1] ?? 0, cr[cb + 2] ?? 0, cr[cb + 3] ?? 0,
          ct[cb] ?? 0, ct[cb + 1] ?? 0, ct[cb + 2] ?? 0, ct[cb + 3] ?? 0, coarse,
        );

        // Match terrain triangle split direction so road conforms to terrain surface
        const splitNWtoSE = LandblockMesh.getSplitDir(fileId, col, row);

        if (allRoad) {
          // Full road cell — opaque road base texture, no alpha map
          let bucket = buckets.get(`${pre}|full`);
          if (!bucket) {
            bucket = {
              verts: [], uvs: [], indices: [], quadCount: 0, layer: -1,
              rank: TerrainRenderer.ROAD_RANK_FULL, name: 'roadmerge',
              material: coarse ? this.getCoarseRoadMaterial(null, null) : this.getMergedRoadMaterial(null, null),
            };
            buckets.set(`${pre}|full`, bucket);
          }
          TerrainRenderer.appendOverlayQuad(
            bucket, cx, cz, CELL_SIZE, hSW, hSE, hNW, hNE, 0, splitNWtoSE,
          );
          continue;
        }

        // Process up to 2 road codes per cell
        for (let ri = 0; ri < 2; ri++) {
          if (rCodes[ri] === 0) break;
          const match = findRoadAlpha(this.roadMaps, rCodes[ri], cellPcode);
          if (!match) continue;

          const alphaGID = match.roadMap.roadTexGID;
          const alphaTex = this.roadAlphaTextures.get(alphaGID);
          if (!alphaTex) continue;

          const key = `${pre}|${ri}|${alphaGID}`;
          let bucket = buckets.get(key);
          if (!bucket) {
            bucket = {
              verts: [], uvs: [], indices: [], quadCount: 0, layer: ri,
              rank: TerrainRenderer.ROAD_RANK_ALPHA + ri, name: 'roadmerge',
              material: coarse ? this.getCoarseRoadMaterial(alphaGID, alphaTex) : this.getMergedRoadMaterial(alphaGID, alphaTex),
            };
            buckets.set(key, bucket);
          }
          TerrainRenderer.appendOverlayQuad(
            bucket, cx, cz, CELL_SIZE, hSW, hSE, hNW, hNE, match.rotation, splitNWtoSE,
          );
        }
      }
    }
  }

  /**
   * Shared material for merged road overlay quads — same settings the
   * per-quad materials used (alpha'd transparent overlay, or opaque
   * full-road cell when alphaGID is null).
   */
  private getMergedRoadMaterial(
    alphaGID: number | null,
    alphaMap: THREE.DataTexture | null,
  ): THREE.Material {
    const key = alphaGID === null ? 'full' : `a|${alphaGID}`;
    let mat = this.mergedRoadMaterials.get(key);
    if (!mat) {
      mat = applyRetailLighting(alphaMap
        ? new THREE.MeshLambertMaterial({
            map: this.roadBaseTex,
            alphaMap,
            transparent: true,
            depthWrite: false,
            side: THREE.DoubleSide,
            polygonOffset: true,
            polygonOffsetFactor: -1,
            polygonOffsetUnits: -1,
          })
        : new THREE.MeshLambertMaterial({
            map: this.roadBaseTex,
            side: THREE.DoubleSide,
            polygonOffset: true,
            polygonOffsetFactor: -1,
            polygonOffsetUnits: -1,
          }), 'landscape');
      mat.userData.sharedOverlayMaterial = true;
      this.mergedRoadMaterials.set(key, mat);
    }
    return mat;
  }

  /**
   * DECOMP.terrain-lod — a texture clone for a reduced block's per-cell
   * surface: TexMerge::MakeNewSurface @ 005049b0 builds it at
   * (base_tex_size >> ImageShift[scale]) / 4 (floored at min_tex_size), so
   * the clone is registered at base_tex_size / 4 with one cell per UV unit
   * (the reduced geometry and overlay quads carry cell-unit UVs). The same
   * crop + repeat rules as the full-size surface then apply
   * (TextureSamplerPrefs). `kind` 'landscapeAlpha' point-subsamples an alpha
   * map to the reduced size, as MergeTexture does.
   */
  private coarseClone(src: THREE.DataTexture, kind: 'landscape' | 'landscapeAlpha', channel: number, baseTexSize = this.baseTexSize): THREE.DataTexture {
    const tex = src.clone();
    tex.channel = channel;
    if (kind === 'landscape') {
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
    }
    tex.needsUpdate = true;
    textureSamplerPrefs.register(tex, kind, textureSamplerPrefs.fullResOf(src) ?? undefined, {
      landscape: { uvCells: 1, baseTexSize: Math.max(1, (baseTexSize || EOL_REGION_BASE_TEX_SIZE) / 4) },
    });
    this.coarseOwnedTextures.add(tex);
    return tex;
  }

  private coarseAlpha(alpha: THREE.DataTexture): THREE.DataTexture {
    let tex = this.coarseAlphaTextures.get(alpha);
    if (!tex) {
      tex = this.coarseClone(alpha, 'landscapeAlpha', 0);
      this.coarseAlphaTextures.set(alpha, tex);
    }
    return tex;
  }

  /** The reduced-size base material for a terrain type (cell-unit UVs). */
  private getCoarseTerrainMaterial(terrainType: number): THREE.Material {
    let mat = this.coarseTerrainMaterials.get(terrainType);
    if (mat) return mat;
    const fine = this.terrainMaterials.get(terrainType) as THREE.MeshLambertMaterial | undefined;
    if (!fine || !fine.map) return fine ?? this.material;
    const map = this.coarseClone(fine.map as THREE.DataTexture, 'landscape', 0, this.terrainBaseTexSize);
    mat = applyRetailLighting(new THREE.MeshLambertMaterial({ map, side: THREE.DoubleSide }), 'landscape');
    this.coarseTerrainMaterials.set(terrainType, mat);
    return mat;
  }

  /** getMergedBlendMaterial for reduced-block overlay quads. */
  private getCoarseBlendMaterial(
    terrainType: number, baseTex: THREE.DataTexture,
    alphaGID: number, alphaMap: THREE.DataTexture,
  ): THREE.Material {
    const key = `${terrainType}|${alphaGID}`;
    let mat = this.coarseBlendMaterials.get(key);
    if (!mat) {
      let terrainTex = this.coarseTiledBlendTextures.get(terrainType);
      if (!terrainTex) {
        terrainTex = this.coarseClone(baseTex, 'landscape', 1);
        this.coarseTiledBlendTextures.set(terrainType, terrainTex);
      }
      mat = applyRetailLighting(new THREE.MeshLambertMaterial({
        map: terrainTex,
        alphaMap: this.coarseAlpha(alphaMap),
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }), 'landscape');
      mat.userData.sharedOverlayMaterial = true;
      this.coarseBlendMaterials.set(key, mat);
    }
    return mat;
  }

  /** getMergedRoadMaterial for reduced-block overlay quads. */
  private getCoarseRoadMaterial(alphaGID: number | null, alphaMap: THREE.DataTexture | null): THREE.Material {
    const key = alphaGID === null ? 'full' : `a|${alphaGID}`;
    let mat = this.coarseRoadMaterials.get(key);
    if (!mat) {
      if (!this.coarseRoadBaseTex && this.roadBaseTex) {
        this.coarseRoadBaseTex = this.coarseClone(this.roadBaseTex, 'landscape', 1);
      }
      mat = applyRetailLighting(alphaMap
        ? new THREE.MeshLambertMaterial({
            map: this.coarseRoadBaseTex,
            alphaMap: this.coarseAlpha(alphaMap),
            transparent: true,
            depthWrite: false,
            side: THREE.DoubleSide,
            polygonOffset: true,
            polygonOffsetFactor: -1,
            polygonOffsetUnits: -1,
          })
        : new THREE.MeshLambertMaterial({
            map: this.coarseRoadBaseTex,
            side: THREE.DoubleSide,
            polygonOffset: true,
            polygonOffsetFactor: -1,
            polygonOffsetUnits: -1,
          }), 'landscape');
      mat.userData.sharedOverlayMaterial = true;
      this.coarseRoadMaterials.set(key, mat);
    }
    return mat;
  }

  /**
   * Convert a LandblockGeometry to a Three.js BufferGeometry.
   */
  static toBufferGeometry(geometry: LandblockGeometry): THREE.BufferGeometry {
    const bufGeom = new THREE.BufferGeometry();
    bufGeom.setAttribute('position', new THREE.BufferAttribute(geometry.positions, 3));
    bufGeom.setAttribute('normal', new THREE.BufferAttribute(geometry.normals, 3));
    bufGeom.setAttribute('uv', new THREE.BufferAttribute(geometry.uvs, 2));
    bufGeom.setIndex(new THREE.BufferAttribute(geometry.indices, 1));
    return bufGeom;
  }

  /**
   * Create a multi-material mesh for a landblock, assigning materials per cell.
   *
   * PERF.1 — one geometry group per MATERIAL, not per cell. three.js issues
   * one draw call per group, so the original per-cell grouping cost 64 draw
   * calls per landblock (~1,700/frame across the loaded region — the largest
   * single draw-call bucket). The index buffer is permuted so all cells that
   * share a terrain type are contiguous; same triangles, same winding, same
   * materials, opaque + depth-tested, so the rasterized output is identical.
   */
  private createMultiMaterialMesh(lbMesh: { geometry: LandblockGeometry; cellTerrainTypes: number[] }, side = 8): THREE.Mesh {
    const bufGeom = TerrainRenderer.toBufferGeometry(lbMesh.geometry);
    const coarse = side < 8;

    // Collect unique terrain types used in this landblock
    const usedTypes = new Set(lbMesh.cellTerrainTypes);
    const typeToGroupIdx = new Map<number, number>();
    const materials: THREE.Material[] = [];

    for (const tt of usedTypes) {
      const mat = coarse ? this.getCoarseTerrainMaterial(tt) : (this.terrainMaterials.get(tt) ?? this.material);
      typeToGroupIdx.set(tt, materials.length);
      materials.push(mat);
    }

    // Bucket cells (each cell = 2 triangles = 6 contiguous indices, in
    // col*side+row order matching the geometry builders) by material.
    const cellsByGroup: number[][] = materials.map(() => []);
    for (let cellIdx = 0; cellIdx < side * side; cellIdx++) {
      const terrainType = lbMesh.cellTerrainTypes[cellIdx] ?? 0;
      cellsByGroup[typeToGroupIdx.get(terrainType) ?? 0].push(cellIdx);
    }

    // Rewrite the index buffer with same-material cells contiguous and emit
    // one group per material.
    const oldIndex = bufGeom.getIndex()!;
    const oldArr = oldIndex.array as Uint16Array;
    const newArr = new Uint16Array(oldArr.length);
    bufGeom.clearGroups();
    let write = 0;
    for (let groupIdx = 0; groupIdx < cellsByGroup.length; groupIdx++) {
      const start = write;
      for (const cellIdx of cellsByGroup[groupIdx]) {
        for (let k = 0; k < 6; k++) newArr[write++] = oldArr[cellIdx * 6 + k];
      }
      if (write > start) bufGeom.addGroup(start, write - start, groupIdx);
    }
    bufGeom.setIndex(new THREE.BufferAttribute(newArr, 1));

    return new THREE.Mesh(bufGeom, materials);
  }

  /**
   * Update terrain meshes around the given world position.
   * Creates Three.js meshes for newly loaded landblocks,
   * removes meshes for unloaded ones, and — DECOMP.terrain-lod — re-LODs
   * the loaded blocks when the viewer's block changes (LScape::update_block
   * → CLandBlockStruct::generate for each block, which returns early when
   * its side_cell_count and trans_dir are unchanged).
   */
  update(worldX: number, worldZ: number): { added: number; removed: number } {
    const { loaded, unloaded } = this.terrainManager.update(worldX, worldZ);

    // Remove unloaded meshes from scene
    for (const id of unloaded) {
      this.removeBlockVisuals(id);
      // Remove per-landblock attachments (scenery, lights, etc.)
      const attached = this.attachments.get(id);
      if (attached) {
        for (const obj3d of attached) {
          this.scene.remove(obj3d);
          obj3d.traverse(child => TerrainRenderer.disposeAttachment(child));
        }
        this.attachments.delete(id);
      }
      // PERF.1 — retire pooled cross-landblock resources for this block.
      this.detacher?.(id);
    }

    const viewer = TerrainManager.worldToBlock(worldX, worldZ);
    const viewerMoved = !this.viewerBlock || this.viewerBlock.x !== viewer.blockX || this.viewerBlock.y !== viewer.blockY;
    this.viewerBlock = { x: viewer.blockX, y: viewer.blockY };
    let relod = 0;
    if (viewerMoved) {
      const fresh = new Set(loaded);
      for (const id of [...this.meshes.keys()]) {
        if (fresh.has(id)) continue;
        const lod = this.lodFor(id);
        const prev = this.blockLods.get(id);
        if (prev && TerrainRenderer.sameLod(prev, lod)) continue;
        this.removeBlockVisuals(id);
        this.buildBlockVisuals(id, lod);
        relod++;
      }
    }

    // Create meshes for newly loaded landblocks
    for (const id of loaded) {
      if (!this.buildBlockVisuals(id, this.lodFor(id))) continue;
      const { blockX, blockY } = TerrainManager.fileIdToBlock(id);

      // Per-landblock attachments — scenery, lights, particle emitters, etc.
      if (this.attacher) {
        const attached = this.attacher(id, blockX * 192, blockY * 192);
        if (attached && attached.length > 0) {
          if (!this.landscapeVisible) {
            for (const o of attached) o.visible = false;
          }
          this.attachments.set(id, attached);
        }
      }
    }

    if (loaded.length > 0 || unloaded.length > 0 || relod > 0) this.overlayPool.flush();

    return { added: loaded.length, removed: unloaded.length };
  }

  /** A full-resolution LandblockMesh viewed as side-8 cells (CellView passes through). */
  private static cellView(block: CellView | LandblockMesh): CellView {
    if ('side' in block) return block;
    return {
      side: 8, positions: block.geometry.positions,
      cellTerrainTypes: block.cellTerrainTypes, cellRoadMasks: block.cellRoadMasks,
      cellCornerTerrainTypes: block.cellCornerTerrainTypes, cellCornerRoadBits: block.cellCornerRoadBits,
    };
  }

  /** The retail LOD of a block relative to the current viewer block. */
  private lodFor(fileId: number): BlockLod {
    if (!this.viewerBlock) return { sideCells: 8, dir: BlockDirection.IN_VIEWER_BLOCK };
    const { blockX, blockY } = TerrainManager.fileIdToBlock(fileId);
    return retailBlockLod(blockX - this.viewerBlock.x, blockY - this.viewerBlock.y);
  }

  /**
   * Whether two LODs draw the same block: the side count, and the seam
   * direction only where TransAdjust reads it (1 < side < 8).
   */
  static sameLod(a: BlockLod, b: BlockLod): boolean {
    if (a.sideCells !== b.sideCells) return false;
    const seams = a.sideCells > 1 && a.sideCells < 8;
    return !seams || a.dir === b.dir;
  }

  /** The LOD a loaded block is drawn at (tests/verification). */
  getBlockLod(fileId: number): BlockLod | undefined {
    return this.blockLods.get(fileId);
  }

  /** Drop a block's terrain mesh + overlay contributions (flush separately). */
  private removeBlockVisuals(id: number): void {
    const mesh = this.meshes.get(id);
    if (mesh) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      this.meshes.delete(id);
    }
    this.blockLods.delete(id);
    // Retire the block's road/blend overlay quads from the pool
    this.overlayPool.removeBlock(id);
  }

  /**
   * Build a block's terrain mesh + overlay contributions at `lod` (flush
   * separately). A full-resolution block (side 8) is the TerrainManager's
   * LandblockMesh as-is; a reduced one is CLandBlockStruct::generate's
   * geometry (buildLandblockLod) with per-cell reduced-size surfaces.
   */
  private buildBlockVisuals(id: number, lod: BlockLod): boolean {
    const lbMesh = this.terrainManager.getMesh(id);
    if (!lbMesh) return false;
    const { blockX, blockY } = TerrainManager.fileIdToBlock(id);

    let view: CellView;
    let mesh: THREE.Mesh;
    if (lod.sideCells === 8) {
      view = TerrainRenderer.cellView(lbMesh);
      mesh = this.useMultiMaterial
        ? this.createMultiMaterialMesh(lbMesh)
        : new THREE.Mesh(TerrainRenderer.toBufferGeometry(lbMesh.geometry), this.material);
    } else {
      const reduced = buildLandblockLod(lbMesh.source, lod);
      view = {
        side: lod.sideCells, positions: reduced.geometry.positions,
        cellTerrainTypes: reduced.cellTerrainTypes, cellRoadMasks: reduced.cellRoadMasks,
        cellCornerTerrainTypes: reduced.cellCornerTerrainTypes, cellCornerRoadBits: reduced.cellCornerRoadBits,
      };
      mesh = this.useMultiMaterial
        ? this.createMultiMaterialMesh(reduced, lod.sideCells)
        : new THREE.Mesh(TerrainRenderer.toBufferGeometry(reduced.geometry), this.material);
    }
    mesh.userData.terrainLod = { sideCells: lod.sideCells, dir: lod.dir };
    // First opaque draw after the sky: building portal punches erase its
    // depth in doorways / pit openings next (world/PortalPunch.ts).
    mesh.renderOrder = TERRAIN_RENDER_ORDER;

    // Position in world space
    mesh.position.set(blockX * 192, 0, blockY * 192);
    mesh.visible = this.landscapeVisible;
    this.scene.add(mesh);
    freezeStaticTransform(mesh);
    this.meshes.set(id, mesh);
    this.blockLods.set(id, lod);

    // Contribute this landblock's blend + road overlay quads to the
    // cross-landblock pool (flushed once after the load loop).
    const overlayBuckets = new Map<string, PooledOverlayBucket>();
    if (this.useTerrainBlend) {
      this.collectTerrainBlendBuckets(view, id, blockX * 192, blockY * 192, overlayBuckets);
    }
    if (this.useRoads) {
      this.collectRoadOverlayBuckets(view, id, blockX * 192, blockY * 192, overlayBuckets);
    }
    if (overlayBuckets.size > 0) this.overlayPool.addBlock(id, overlayBuckets);
    return true;
  }

  /**
   * Dispose one attachment node on landblock unload. Objects flagged
   * `userData.sharedResources` (CORE.14 SceneryInstancer output) share their
   * geometry + MaterialFactory-cached materials across landblocks, so only
   * their per-instance buffers are released; everything else disposes fully.
   */
  static disposeAttachment(child: THREE.Object3D): void {
    if (!(child instanceof THREE.Mesh)) return;
    if (child.userData.sharedResources) {
      if (child instanceof THREE.InstancedMesh) child.dispose();
      return;
    }
    child.geometry.dispose();
    // REND.shared-cached-material-disposed-faded — a MaterialFactory-cached
    // material is shared with every other mesh drawing that surface.
    disposeOwnedMaterials(child.material as THREE.Material | THREE.Material[]);
  }

  /**
   * Get the number of terrain meshes currently in the scene.
   */
  get meshCount(): number {
    return this.meshes.size;
  }

  /**
   * Whether this renderer is using multi-material terrain textures.
   */
  get isMultiMaterial(): boolean {
    return this.useMultiMaterial;
  }

  /**
   * Get a terrain mesh by file ID.
   */
  getMesh(fileId: number): THREE.Mesh | undefined {
    return this.meshes.get(fileId);
  }

  /** The cross-landblock road/blend overlay pool (tests/verification). */
  get overlayMergePool(): OverlayMergePool {
    return this.overlayPool;
  }

  /**
   * Remove all terrain meshes from the scene.
   */
  clear(): void {
    for (const mesh of this.meshes.values()) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
    }
    this.meshes.clear();
    this.blockLods.clear();
    this.viewerBlock = null;
    this.overlayPool.clear();
    for (const mat of this.coarseTerrainMaterials.values()) mat.dispose();
    this.coarseTerrainMaterials.clear();
    for (const mat of this.coarseBlendMaterials.values()) mat.dispose();
    this.coarseBlendMaterials.clear();
    for (const mat of this.coarseRoadMaterials.values()) mat.dispose();
    this.coarseRoadMaterials.clear();
    for (const tex of this.coarseOwnedTextures) { textureSamplerPrefs.unregister(tex); tex.dispose(); }
    this.coarseOwnedTextures.clear();
    this.coarseTiledBlendTextures.clear();
    this.coarseAlphaTextures.clear();
    this.coarseRoadBaseTex = null;
    // Shared merged-overlay materials + tiled base-texture clones are
    // per-renderer, not per-landblock — dispose them here (they lazily
    // rebuild if the renderer is reused after clear()).
    for (const mat of this.mergedRoadMaterials.values()) mat.dispose();
    this.mergedRoadMaterials.clear();
    for (const mat of this.mergedBlendMaterials.values()) mat.dispose();
    this.mergedBlendMaterials.clear();
    for (const tex of this.tiledBlendTextures.values()) { textureSamplerPrefs.unregister(tex); tex.dispose(); }
    this.tiledBlendTextures.clear();
    for (const attached of this.attachments.values()) {
      for (const obj3d of attached) {
        this.scene.remove(obj3d);
        obj3d.traverse(child => TerrainRenderer.disposeAttachment(child));
      }
    }
    if (this.detacher) {
      for (const id of this.terrainManager.getLoadedMeshes().keys()) this.detacher(id);
    }
    this.attachments.clear();
    this.terrainManager.clear();
  }

  /**
   * REMASTER grass (RemasterMode.ts): the average colour of a terrain type's
   * DAT texture (linear), or null before the terrain materials exist.
   */
  terrainTypeColor(terrainType: number): THREE.Color | null {
    const cached = this.terrainTypeColors.get(terrainType);
    if (cached !== undefined) return cached;
    const map = (this.terrainMaterials.get(terrainType) as THREE.MeshLambertMaterial | undefined)?.map as THREE.DataTexture | null | undefined;
    const data = map?.image?.data as ArrayLike<number> | undefined;
    const color = data && data.length >= 4 ? averageTextureColor(data) : null;
    if (color) this.terrainTypeColors.set(terrainType, color);
    return color;
  }
  private terrainTypeColors = new Map<number, THREE.Color>();

  /**
   * Get terrain texture IDs from landblock terrain data.
   * Each cell has a terrain type (bits 2-6 of the terrain uint16)
   * that maps to a texture.
   */
  static getTerrainTypes(terrain: number[]): number[] {
    return terrain.map(t => (t >> 2) & 0x1f);
  }
}
