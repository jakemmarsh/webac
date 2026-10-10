import type { GfxObj } from '@ac/dat-parser/file-types/GfxObj.js';

/** Polygon SidesType 1 (ACE CullMode.None): both faces drawn. */
const CULL_NONE = 1;
/** Polygon SidesType 2 (ACE CullMode.Clockwise): a separate negative face. */
const CULL_CLOCKWISE = 2;

/**
 * Renderable geometry data extracted from a GfxObj.
 * Uses flat typed arrays suitable for Three.js BufferGeometry attributes.
 */
export interface GfxObjGeometry {
  positions: Float32Array;   // 3 floats per vertex (x, y, z)
  normals: Float32Array;     // 3 floats per vertex (nx, ny, nz)
  uvs: Float32Array;         // 2 floats per vertex (u, v)
  indices: Uint16Array;      // triangle indices
  surfaceIndices: number[];  // per-triangle surface ID for material assignment
  /**
   * Per triangle: its polygon draws both faces (SidesType 1, CullMode.None).
   * Retail's mesh build (D3DPolyRender, decomp ≈ :400477 / :400720) gives
   * such a polygon a second, reversed copy with negated normals; every other
   * polygon is drawn once and back-face culled (RenderMeshSubset @ 0059ca10:
   * SetCullMode(CULLMODE_CW) unless override_cull_state). SidesType 2's
   * negative copy keeps the front winding, so it never shows from behind
   * either (11 polygons in the EoL portal).
   */
  doubleSided: boolean[];
  /**
   * Per triangle: its texture is sampled with CLAMP addressing. Retail's
   * mesh build (D3DPolyRender::ConstructMesh @ 0059dfa0) sets bit 0 of a
   * surface batch's `isStippledOrAlphaedMask` when ANY polygon whose
   * pos_surface is that batch has `stippling > 0`; RenderMeshSubset @
   * 0059ca10 hands that bit to SetSurface @ 0059c4d0, which samples
   * TEXADDRESS_WRAP with it and TEXADDRESS_CLAMP without. In every DAT set
   * the unstippled polygons' UVs all lie inside [0, 1] (the stippled ones are
   * the tiling faces), so clamping only changes the filtered texel border.
   */
  clampUV: boolean[];
  /**
   * A SidesType 2 polygon's two copies land in DIFFERENT surface batches, so
   * which one shows at their shared depth is decided by batch order: retail
   * draws a mesh's batches in surface-index order (the D3DX attribute ranges
   * ConstructMesh @ 0059dfa0 builds) under `zfuncVal` = DEPTHTEST_LESS, so
   * the lower-index batch wins. ModelRenderer then pins its sub-meshes'
   * renderOrder to that order (EoL: 0x010008AA, 0x0100326E).
   */
  batchOrdered: boolean;
}

/**
 * Per surface index: the batch has no stippled polygon, so retail samples
 * it with TEXADDRESS_CLAMP (see GfxObjGeometry.clampUV). Every polygon
 * counts — including the untextured faces a building or cell draw then
 * skips (DrawMesh @ 0059d4a0): ConstructMesh sets the bit from the full
 * polygon list. `(char)stippling > 0`: values 1..127 (EoL uses 1 and 4).
 */
export function clampedSurfaceBatches(polygons: Iterable<{ posSurface: number; stippling: number }>): (index: number) => boolean {
  const stippled = new Set<number>();
  for (const p of polygons) {
    const s = p.stippling & 0xff;
    if (s > 0 && s < 0x80) stippled.add(p.posSurface);
  }
  return (index: number) => !stippled.has(index);
}

/**
 * Convert a parsed GfxObj into renderable geometry arrays.
 * Matches ACViewer's approach: each vertex is expanded into N copies
 * (one per UV set), and polygons reference specific UV indices via
 * posUVIndices to select the correct buffer vertex.
 *
 * Reference: ACViewer/Extensions/VertexArrayExtensions.cs (BuildUVLookup)
 * Reference: ACViewer/Model/Polygon.cs (BuildIndices)
 */
export function buildGfxObjGeometry(gfxObj: GfxObj): GfxObjGeometry {
  const vertexArray = gfxObj.vertexArray;
  if (!vertexArray) {
    return {
      positions: new Float32Array(0),
      normals: new Float32Array(0),
      uvs: new Float32Array(0),
      indices: new Uint16Array(0),
      surfaceIndices: [],
      doubleSided: [],
      clampUV: [],
      batchOrdered: false,
    };
  }

  const vertexMap = vertexArray.vertices;
  const keys = Array.from(vertexMap.keys()).sort((a, b) => a - b);

  // Build expanded vertex buffer and UV lookup table.
  // Each vertex with N UVs becomes N buffer entries (same position/normal, different UV).
  // uvLookup maps "vertexKey:uvIndex" → buffer index.
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

  // RENDER.sidestype2-negative-face-missing — the negative copy's vertices:
  // ConstructMesh @ 0059dfa0 files them in the vertex map's second layer
  // (`(uv + maxUVs) * numVertices + vertex`) and copyVert writes them with
  // the normal sign -1 (any copy other than the front one). Appended on
  // demand after the front vertices.
  const negLookup = new Map<string, number>();
  const negVertex = (vertKey: number, uvI: number): number | undefined => {
    const k = `${vertKey}:${uvI}`;
    const known = negLookup.get(k);
    if (known !== undefined) return known;
    const v = vertexMap.get(vertKey);
    if (!v) return undefined;
    const uv = v.uvs[uvI] ?? v.uvs[0];
    posArr.push(v.origin.x, v.origin.z, v.origin.y);
    normArr.push(-v.normal.x, -v.normal.z, -v.normal.y);
    uvArr.push(uv ? uv.u : 0, uv ? uv.v : 0);
    negLookup.set(k, bufIdx);
    return bufIdx++;
  };

  // Triangulate polygons using fan triangulation matching ACViewer.
  // Winding is reversed to compensate for Y↔Z axis swap (reflection, det=-1).
  const indexList: number[] = [];
  const surfaceIndices: number[] = [];
  const doubleSided: boolean[] = [];
  const clampUV: boolean[] = [];
  let batchOrdered = false;
  // RENDER.physics-only-polys-drawn — only the DRAWING polygons are drawn:
  // CGfxObj::InitLoad @ 005346b0 → D3DPolyRender::ConstructMesh @ 0059ea90
  // builds the mesh from `num_polygons` / `polygons` (the drawing set); the
  // physics polygons are collision-only. (No EoL, classic or 1999 GfxObj
  // has physics polygons without drawing ones.)
  // A building's portal / seam faces are left out by the building pass
  // (ModelRenderer.createMesh `buildingPass`: DrawMesh @ 0059d4a0 skips its
  // untextured surfaces), not here — an ordinary object draws every polygon.
  const polys = gfxObj.polygons;
  const clamped = clampedSurfaceBatches(polys);

  const emitFan = (verts: number[], lookup: (i: number, vertKey: number) => number | undefined, surface: number, bothFaces: boolean): void => {
    let firstBufIdx = -1;
    let lastBufIdx = -1;
    for (let i = 0; i < verts.length; i++) {
      // Ensure unsigned vertex key (polygon stores as int16, vertex array uses uint16)
      const bi = lookup(i, verts[i] & 0xFFFF);
      if (bi === undefined) continue;
      if (i === 0) {
        firstBufIdx = bi;
      } else if (i >= 2) {
        // Fan triangle: (first, last, current) — reversed for Y↔Z handedness flip
        indexList.push(firstBufIdx, bi, lastBufIdx);
        surfaceIndices.push(surface);
        doubleSided.push(bothFaces);
        clampUV.push(clamped(surface));
      }
      lastBufIdx = bi;
    }
  };

  for (const poly of polys) {
    const verts = poly.vertexIndices;
    if (verts.length < 3) continue;

    emitFan(verts, (i, vertKey) => {
      const uvI = i < poly.posUVIndices.length ? poly.posUVIndices[i] : 0;
      return uvLookup.get(`${vertKey}:${uvI}`) ?? uvLookup.get(`${vertKey}:0`);
    }, poly.posSurface, poly.sidesType === CULL_NONE);

    // RENDER.sidestype2-negative-face-missing — ConstructMesh @ 0059dfa0
    // gives a SidesType 2 polygon a second copy in its neg_surface batch:
    // the neg_uv_indices (0 when the polygon has none), normals negated, and
    // the SAME winding (only SidesType 1's copy is reversed: `2 - i` when the
    // winding pass is nonzero). RenderMeshSubset culls it CULLMODE_CW like the
    // front face, so it shows from the front only. At their shared depth the
    // first copy drawn wins (`zfuncVal` = DEPTHTEST_LESS): in one batch that
    // is the positive face (emitted first; the copy shows only where the
    // front is alpha-tested away), across batches the lower surface index
    // (GfxObjGeometry.batchOrdered).
    if (poly.sidesType === CULL_CLOCKWISE) {
      if (poly.negSurface !== poly.posSurface) batchOrdered = true;
      emitFan(verts, (i, vertKey) => negVertex(vertKey, i < poly.negUVIndices.length ? poly.negUVIndices[i] : 0),
        poly.negSurface, false);
    }
  }

  return {
    positions: new Float32Array(posArr),
    normals: new Float32Array(normArr),
    uvs: new Float32Array(uvArr),
    indices: new Uint16Array(indexList),
    surfaceIndices,
    doubleSided,
    clampUV,
    batchOrdered,
  };
}
