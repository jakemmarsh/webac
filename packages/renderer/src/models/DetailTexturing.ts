/**
 * DetailTexturing — retail's "Environment Detail Textures" pass
 * (CORE.17.h.g.c.b): a second, higher-frequency texture the EoL client
 * blends over every building shell and env-cell wall.
 *
 * Ground truth (decompiled acclient, build ac1_sep13 — reference/client-eol):
 *  - `SmartBox::SetDetailTexturing @ 00451df0` → `LScape::SetDetailTexturing
 *    @ 00506b40`(landscape, building = pref, environment = pref, object = 0):
 *    the one Config toggle `Render.BuildingDetailTextures` drives BOTH the
 *    building and the environment surface; landscape/object detailing is
 *    compiled out (`Render::UpdateFromPreferences` :325054 forces landscape
 *    false, object is passed 0).
 *  - `LScape::SetDetailTexturing` reads `TexMerge::GetDetailTiling(i)` /
 *    `GetDetailTex(i)` (@ 00503a10 / 005039e0) = `terrain_desc[i].terrain_tex
 *    ->detail_tex_tiling / detail_tex_gid` by LIST INDEX i — 0 landscape,
 *    1 building, 2 environment, 3 object — and `GenerateDetailSurface @
 *    00506230` wraps the 0x05 texture in a custom CSurface (type | 0x20000).
 *    EoL region 0x13000000: building = environment = 0x5001787 (256×256,
 *    dark RGB ≈ 42 with a low-mean alpha ≈ 34) at tiling 4.
 *  - `RenderDeviceD3D::DrawEnvCell @ 0059f170` / `DrawBuilding @ 0059f2a0`
 *    set `Render::curr_detail_surface` (+ tiling, src blend 9, dst blend 6)
 *    around the cell structure / building-part draws only — the objects
 *    inside a cell and everything else draw with it null.
 *  - `RenderDevice::m_caps.bCanDoSinglePassDetailing` is only ever assigned
 *    false (ctor @ 0059dcd0) in the EoL binary, and every runtime GfxObj /
 *    CEnvCell uses a built mesh (`use_built_mesh = 1` under
 *    `DBCache::IsRunTime`, :293681 / :300575), so the shipped path is the
 *    SECOND DRAW in `D3DPolyRender::RenderMeshSubset @ 0059ca10`:
 *    `ACRender::SetDetailSurfaceInternal(0) @ 006b6280` binds the detail
 *    texture to stage 0 (WRAP, LINEAR — the sampler pref promotion applies),
 *    blend (SRCBLEND 9 = D3DBLEND_DESTCOLOR, DESTBLEND 6 = INVSRCALPHA —
 *    `SetBlendFunction @ 005a2b90` passes the enum straight to
 *    SetRenderState 0x13/0x14), depth LESSEQUAL, then
 *    `SetStageFFTexCoordIndex(0, 1)` selects UV set 1 = `curr_detail_tiling`
 *    × UV set 0 (`SetDetailTiling @ 0059c150`, FVF 0x252) and the subset is
 *    drawn again. Stage 0 keeps `SetSurface @ 0059c4d0`'s ops: COLOROP
 *    MODULATE(TEXTURE, DIFFUSE), ALPHAOP MODULATE(TEXTURE, DIFFUSE) (enum
 *    values pass straight to SetTextureStageState). The vertex diffuse is
 *    the fixed-function LIT colour (SetFFLighting true; material colour from
 *    the vertex, whose alpha is 0xff — `ConstructMesh` writes 0xffffffff,
 *    `SetStaticLightingVertexColors @ 0059cfe0` ORs 0xff000000).
 *
 *    So per pixel, with dst = texel·L already in the frame buffer:
 *        src  = detail.rgb · L,   src.a = detail.a
 *        out  = src · dst + dst · (1 − src.a)
 *             = texel · L · (1 + detail.rgb · L − detail.a)
 *    — a signed modulation: the texture's alpha darkens, its RGB (scaled by
 *    the light) brightens, all in the D3D8 gamma space the base pass used.
 *  - The view-depth fade (`ACRender::get_alpha_for_z @ 006b6230`: alpha 255
 *    below MY_MIN_Z_TO_DETAIL = 10 m, 0 beyond MY_MAX_Z_TO_DETAIL = 50 m,
 *    .rdata 0x8067b0/0x8067b4, linear between) is written only by the
 *    immediate-mode `DrawPolyInternal` / `landPolyDraw` paths, which the
 *    runtime built-mesh path never takes — recorded, not implemented.
 *
 * Ours folds the second draw into the retail-lit fragment shader (one extra
 * texture sample, no extra draw call): `patchDetailFragment` rewrites the
 * RetailLighting outgoing line to the equation above and `patchDetailVertex`
 * carries the raw `uv` (retail's UV set 0) to the fragment stage. One shared
 * uniform set per kind lets a Config toggle or a late region load reach
 * every compiled program without recompiling.
 */
import * as THREE from 'three';
import { MIP_BIAS_UNIFORM, textureSamplerPrefs, type HiResSource } from './TextureSamplerPrefs.js';
// Cycle with RetailLighting (which imports the patch functions above) is
// call-time only: neither module touches the other at evaluation.
import { applyRetailLighting } from './RetailLighting.js';

/** `LScape::SetDetailTexturing` terrain_desc list indices. */
export const RETAIL_DETAIL_TERRAIN_INDEX = { landscape: 0, building: 1, environment: 2, object: 3 } as const;

/** `RenderDeviceD3D::DrawEnvCell` / `DrawBuilding`: SRCBLEND / DESTBLEND (D3DBLEND values). */
export const RETAIL_DETAIL_SRC_BLEND = 9;  // D3DBLEND_DESTCOLOR
export const RETAIL_DETAIL_DST_BLEND = 6;  // D3DBLEND_INVSRCALPHA

/** `ACRender::get_alpha_for_z` bounds (metres of view depth) — immediate-mode path only. */
export const RETAIL_DETAIL_FADE_MIN_Z = 10;
export const RETAIL_DETAIL_FADE_MAX_Z = 50;

/** The EoL region's building/environment detail surface (0x13000000, indices 1 and 2). */
export const EOL_BUILDING_DETAIL_TEX_GID = 0x5001787;
export const EOL_BUILDING_DETAIL_TILING = 4;

export type DetailKind = 'building' | 'environment';

export interface DetailSurface {
  texGID: number;
  tiling: number;
}

export interface RegionDetailSurfaces {
  landscape: DetailSurface | null;
  building: DetailSurface | null;
  environment: DetailSurface | null;
  object: DetailSurface | null;
}

interface TerrainDescLike {
  terrainTex: { detailTexGID: number; detailTexTiling: number };
}

const INVALID_DID = 0xffffffff;

function detailSurfaceAt(list: readonly TerrainDescLike[], index: number): DetailSurface | null {
  const desc = list[index];
  if (!desc) return null;
  const gid = desc.terrainTex.detailTexGID >>> 0;
  if (gid === 0 || gid === INVALID_DID) return null;
  return { texGID: gid, tiling: desc.terrainTex.detailTexTiling >>> 0 };
}

/**
 * `LScape::SetDetailTexturing`'s reads of the region: the detail surface +
 * tiling for each of the four terrain_desc list indices. The DID is
 * INVALID (`GenerateDetailSurface` returns null) when absent.
 */
export function regionDetailSurfaces(texMerge: { terrainDesc: readonly TerrainDescLike[] }): RegionDetailSurfaces {
  const list = texMerge.terrainDesc;
  return {
    landscape: detailSurfaceAt(list, RETAIL_DETAIL_TERRAIN_INDEX.landscape),
    building: detailSurfaceAt(list, RETAIL_DETAIL_TERRAIN_INDEX.building),
    environment: detailSurfaceAt(list, RETAIL_DETAIL_TERRAIN_INDEX.environment),
    object: detailSurfaceAt(list, RETAIL_DETAIL_TERRAIN_INDEX.object),
  };
}

// ── Pure-JS mirror of the second draw (tests, diagnostics) ────────────────

export type Rgb = [number, number, number];
export type Rgba = [number, number, number, number];

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * One pixel of the retail detail pass. `texelSrgb` and `detail` are the
 * raw bytes / 255 (D3D8 gamma space), `light` the clamped lit vertex
 * diffuse. Returns the displayed sRGB value:
 *   clamp01( texel · L · (1 + detail.rgb · L − detail.a) )
 * which is exactly `clamp01( src·dst + dst·(1 − src.a) )` with
 * src = detail.rgb · L, src.a = detail.a, dst = texel · L.
 */
export function retailDetailModulation(texelSrgb: Rgb, light: Rgb, detail: Rgba): Rgb {
  const out: Rgb = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const dst = texelSrgb[c] * light[c];
    const src = clamp01(detail[c] * light[c]);
    out[c] = clamp01(src * dst + dst * (1 - detail[3]));
  }
  return out;
}

/** `ACRender::get_alpha_for_z` — the immediate-mode fade (0..1), for the record. */
export function retailDetailFadeAlpha(viewDepth: number): number {
  if (viewDepth < RETAIL_DETAIL_FADE_MIN_Z) return 1;
  if (viewDepth > RETAIL_DETAIL_FADE_MAX_Z) return 0;
  return Math.floor(255 * (1 - (viewDepth - RETAIL_DETAIL_FADE_MIN_Z) / (RETAIL_DETAIL_FADE_MAX_Z - RETAIL_DETAIL_FADE_MIN_Z))) / 255;
}

// ── GLSL patch ────────────────────────────────────────────────────────────

export const DETAIL_MAP_UNIFORM = 'acDetailMap';
export const DETAIL_TILING_UNIFORM = 'acDetailTiling';
export const DETAIL_ON_UNIFORM = 'acDetailOn';
export const DETAIL_UV_VARYING = 'vAcDetailUv';
export const DETAIL_CACHE_KEY = 'acDetail';

/** The line RetailLighting's Lambert patch emits — the detail pass rewrites it. */
/** (CORE.17.k.b.b.a.g.b — the emissive term is inside `acLight`'s clamp, the D3D vertex colour.) */
export const RETAIL_OUTGOING_LINE = '\tvec3 outgoingLight = acSRGBToLinear( acTexel * acLight );';

const UV_VERTEX_INCLUDE = '#include <uv_vertex>';

const FRAGMENT_PRELUDE = `uniform sampler2D ${DETAIL_MAP_UNIFORM};
uniform float ${DETAIL_TILING_UNIFORM};
uniform float ${DETAIL_ON_UNIFORM};
varying vec2 ${DETAIL_UV_VARYING};
`;

/** The second draw, folded into the retail-lit fragment: see the header. */
export const DETAIL_OUTGOING_LINES = [
  `\tvec4 acDetail = texture2D( ${DETAIL_MAP_UNIFORM}, ${DETAIL_UV_VARYING} * ${DETAIL_TILING_UNIFORM}, ${MIP_BIAS_UNIFORM} );`,
  '\tvec3 acDetailSrc = clamp( acDetail.rgb * acLight, 0.0, 1.0 );',
  '\tvec3 acDetailed = clamp( acTexel * acLight * ( 1.0 + acDetailSrc - acDetail.a ), 0.0, 1.0 );',
  `\tvec3 outgoingLight = acSRGBToLinear( mix( acTexel * acLight, acDetailed, ${DETAIL_ON_UNIFORM} ) );`,
].join('\n');

/**
 * Rewrite a RetailLighting-patched Lambert fragment shader so the outgoing
 * colour carries the detail pass. Throws when the retail outgoing line is
 * absent (the patch must follow `patchLambertFragment`) — a silent
 * fall-through would ship a material that claims detail and draws none.
 */
export function patchDetailFragment(fragmentShader: string): string {
  if (fragmentShader.includes(`uniform sampler2D ${DETAIL_MAP_UNIFORM};`)) return fragmentShader;
  if (!fragmentShader.includes(RETAIL_OUTGOING_LINE)) {
    throw new Error('DetailTexturing: fragment shader lacks the RetailLighting outgoing line (patch order)');
  }
  if (!fragmentShader.includes(`uniform float ${MIP_BIAS_UNIFORM};`)) {
    throw new Error('DetailTexturing: fragment shader lacks the sampler-bias uniform (patch order)');
  }
  return FRAGMENT_PRELUDE + fragmentShader.replace(RETAIL_OUTGOING_LINE, DETAIL_OUTGOING_LINES);
}

/** Carry retail's UV set 0 (the raw `uv` attribute) to the fragment stage. */
export function patchDetailVertex(vertexShader: string): string {
  if (vertexShader.includes(`varying vec2 ${DETAIL_UV_VARYING};`)) return vertexShader;
  if (!vertexShader.includes(UV_VERTEX_INCLUDE)) {
    throw new Error('DetailTexturing: vertex shader lost its uv_vertex include anchor');
  }
  return `varying vec2 ${DETAIL_UV_VARYING};\n` + vertexShader
    .replace(UV_VERTEX_INCLUDE, `${UV_VERTEX_INCLUDE}\n\t${DETAIL_UV_VARYING} = uv;`);
}

// ── Shared uniforms + registry ────────────────────────────────────────────

export interface DetailUniforms {
  map: { value: THREE.Texture | null };
  tiling: { value: number };
  on: { value: number };
}

/** Anything that can decode a 0x05 SurfaceTexture to RGBA (TextureManager.getRGBA). */
export interface DetailTextureSource {
  getRGBA(surfaceTextureId: number): { width: number; height: number; data: Uint8Array } | null;
  /** CORE.17.h.g.c.d — the highres (level-0) image, null when the SurfaceTexture has none (TextureManager.getHighResRGBA). */
  getHighResRGBA?(surfaceTextureId: number): { width: number; height: number; data: Uint8Array } | null;
  /** Whether the SurfaceTexture has a highres level at all (TextureManager.hasHighResLevel). */
  hasHighResLevel?(surfaceTextureId: number): boolean;
}

const detailKinds = new WeakMap<THREE.Material, DetailKind>();

export function detailKindOf(material: THREE.Material): DetailKind | null {
  return detailKinds.get(material) ?? null;
}

/** Called by RetailLighting once a material carries the patch. */
export function markDetail(material: THREE.Material, kind: DetailKind): void {
  detailKinds.set(material, kind);
}

/**
 * The live state of the pass: the Config toggle, the region's surfaces, and
 * the per-kind uniform objects every detail material shares (mutated in
 * place — `on` flips without a recompile, a late `loadSurfaces` lands in
 * already-compiled programs).
 */
export class DetailTexturing {
  private enabled = true;
  private readonly uniforms: Record<DetailKind, DetailUniforms> = {
    building: { map: { value: null }, tiling: { value: 0 }, on: { value: 0 } },
    environment: { map: { value: null }, tiling: { value: 0 }, on: { value: 0 } },
  };
  private surfaces: RegionDetailSurfaces | null = null;
  /** One DataTexture per detail GID (building + environment share 0x5001787). */
  private textures = new Map<number, THREE.DataTexture>();
  /** Material → its detail variant, per kind (building shells share
   *  MaterialFactory-cached materials with every other object). */
  private variants: Record<DetailKind, WeakMap<THREE.Material, THREE.Material>> = {
    building: new WeakMap(), environment: new WeakMap(),
  };

  uniformsFor(kind: DetailKind): DetailUniforms {
    return this.uniforms[kind];
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  get loadedSurfaces(): RegionDetailSurfaces | null {
    return this.surfaces;
  }

  /** The DataTexture serving a kind (null before the region loads or when it has no surface). */
  textureFor(kind: DetailKind): THREE.DataTexture | null {
    const s = this.surfaces?.[kind];
    return s ? this.textures.get(s.texGID) ?? null : null;
  }

  /** `Render.BuildingDetailTextures` → `SmartBox::SetDetailTexturing(false, on)`. Returns whether it changed. */
  setEnabled(on: boolean): boolean {
    if (this.enabled === on) return false;
    this.enabled = on;
    this.refresh();
    return true;
  }

  /**
   * `LScape::SetDetailTexturing` for a region: decode each kind's detail
   * texture once (raw bytes — no colour-space decode, the D3D8 pass ran in
   * gamma space; WRAP; registered as an 'environment' texture so the Config
   * filter mode / detail level reach it like every other ImgTex) and point
   * the shared uniforms at it.
   */
  loadSurfaces(texMerge: { terrainDesc: readonly TerrainDescLike[] }, source: DetailTextureSource): RegionDetailSurfaces {
    const surfaces = regionDetailSurfaces(texMerge);
    this.surfaces = surfaces;
    for (const kind of ['building', 'environment'] as const) {
      const s = surfaces[kind];
      const u = this.uniforms[kind];
      if (!s) { u.map.value = null; u.tiling.value = 0; continue; }
      let tex = this.textures.get(s.texGID) ?? null;
      if (!tex) {
        // CORE.17.h.g.c.d — the detail surfaces are RenderTextures like any
        // other, so Very High draws their client_highres.dat level too.
        const hiRes = source.getHighResRGBA && (source.hasHighResLevel?.(s.texGID) ?? true)
          ? () => source.getHighResRGBA!(s.texGID) : undefined;
        tex = DetailTexturing.createDetailTexture(source.getRGBA(s.texGID), hiRes);
        if (tex) this.textures.set(s.texGID, tex);
      }
      u.map.value = tex;
      u.tiling.value = s.tiling;
    }
    this.refresh();
    return surfaces;
  }

  /**
   * A raw-byte, wrapping, mipmapped DataTexture for a detail surface. `hiRes`
   * is the lazy level-0 source (CORE.17.h.g.c.d); when Very High is already
   * active the texture is built from it directly.
   */
  static createDetailTexture(rgba: { width: number; height: number; data: Uint8Array } | null, hiRes?: HiResSource): THREE.DataTexture | null {
    if (!rgba) return null;
    const hiImage = hiRes && textureSamplerPrefs.usesHighResLevel('environment') ? hiRes() : null;
    const image = hiImage ?? rgba;
    const tex = new THREE.DataTexture(
      new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength),
      image.width, image.height, THREE.RGBAFormat,
    );
    tex.colorSpace = THREE.NoColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    textureSamplerPrefs.register(tex, 'environment', rgba, { hiRes, builtFromHiRes: hiImage !== null });
    return tex;
  }

  /**
   * The detail variant of a shared material for a kind: a clone carrying the
   * retail lighting + detail patch, cached so every building instance of the
   * same surface shares one program. Non-Lambert (unlit luminous/additive)
   * materials come back unchanged — see the docs section for that remaining
   * difference.
   */
  variantOf<T extends THREE.Material | THREE.Material[]>(material: T, kind: DetailKind): T {
    if (Array.isArray(material)) return material.map(m => this.variantOf(m, kind)) as T;
    const mat = material as THREE.Material;
    if (!(mat instanceof THREE.MeshLambertMaterial)) return material;
    if (detailKinds.get(mat) === kind) return material;
    const cache = this.variants[kind];
    let variant = cache.get(mat);
    if (!variant) {
      // CORE.17.q.a — env-cell walls take the static-light burn-in path.
      variant = applyRetailLighting(mat.clone(), kind === 'environment' ? 'envcell' : 'object', kind);
      cache.set(mat, variant);
    }
    return variant as T;
  }

  private refresh(): void {
    for (const kind of ['building', 'environment'] as const) {
      const u = this.uniforms[kind];
      u.on.value = this.enabled && u.map.value ? 1 : 0;
    }
  }
}

export const detailTexturing = new DetailTexturing();
