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
 *    false, object is passed 0). The 1999 client still draws the landscape
 *    pass behind its own checkbox: see "The landscape pass" below (webac#23).
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

// ── The landscape pass (webac#23: the 1999 Performance panel's "Detail Texture: Landscape") ──
//
// 1999 client.exe (reference/ac1999/Client/decomp + disassembly):
//  - PerformancePanel @ 0x594e00 builds "Detail Texture" with a "Landscape" and an "Environment"
//    checkbox; ApplySettings @ 0x598430 passes (landscape, env, env, 0) to LScape_SetDetailTexturing
//    @ 0x44340f, which wraps GenerateDetailSurface(0) = terrain_desc[0]'s detail texture and sets
//    the landscape detail surface (0x65421c) and its tiling (0x61c504, the DetailTexTiling) — the
//    same LIST index 0 the EoL decomp reads (TexMerge::GetDetailTex @ 005039e0).
//  - The render-options defaults @ 0x42c236 zero all four flags: off until the player ticks it.
//  - The D3D device's block draw (0x57e9de) makes it the current detail surface, src blend 5
//    (SRCALPHA) / dst blend 6 (INVSRCALPHA), only for a block at full resolution (side == the
//    LandDefs side, 0x6573a0). Its triangle draw (0x583a58) then draws the land triangle a second
//    time when any vertex lies nearer than screen z 0.04: each vertex keeps its lit RGB, its alpha
//    is 255 below screen z 0.02, (1 − (z − 0.02) / 0.02) · 255 up to 0.04, 0 beyond, and its UVs
//    are the base cell UVs (CLandBlockStruct land_uvs, 0..1 across a cell) × the tiling. Screen z
//    is the camera z (which the 1999 view transform keeps divided by the focal length F) × F / 500
//    (0x61dbc8 = 0x61c4cc / 0x61c4d4 @ 0x57f87a), i.e. view depth / 500 m: 10 m to 20 m.
//  - Render_SetupD3DDevice @ 0x43d2a0 sets stage 0 COLOROP / ALPHAOP MODULATE(TEXTURE, DIFFUSE),
//    so per pixel, with dst = texel · L already drawn and a = detail.a · fade:
//        out = clamp(detail.rgb · L) · a + texel · L · (1 − a)
//  - The end-of-retail client keeps the same immediate-mode draw (ACRender::landPolyDraw
//    @ 006b6320, MY_MIN/MAX_Z_TO_DETAIL 10 / 50 m) but never reaches it: Render::
//    UpdateFromPreferences @ 0054d850 forces landscape detail off. EraWorldRules.
//    landscapeDetailTextures carries the era's fade; null leaves the terrain programs unpatched.
//
// Ours folds the second draw into every landscape program (the base cells and the blend / road
// overlays: the blend is affine in the colour, so detailing each layer before the overlay's alpha
// blend equals detailing the finished cell). One extra texture sample per terrain fragment, only in
// an era with the option; `acLandDetailOn` switches it without a recompile.

export const LAND_DETAIL_MAP_UNIFORM = 'acLandDetailMap';
export const LAND_DETAIL_ON_UNIFORM = 'acLandDetailOn';
/** (tiling / 24 m): cell UVs per metre × DetailTexTiling. */
export const LAND_DETAIL_SCALE_UNIFORM = 'acLandDetailScale';
/** A whole-landblock world offset (x, north) subtracted before scaling, keeping the UVs small. */
export const LAND_DETAIL_ORIGIN_UNIFORM = 'acLandDetailOrigin';
/** (fadeMinZ, fadeMaxZ) in metres of view depth. */
export const LAND_DETAIL_FADE_UNIFORM = 'acLandDetailFade';
export const LAND_DETAIL_UV_VARYING = 'vAcLandDetailUv';
export const LAND_DETAIL_ALPHA_VARYING = 'vAcLandDetailFade';
export const LAND_DETAIL_CACHE_KEY = 'acLandDetail';

/** A landblock is 8 cells of 24 m; the origin snaps to it so integer tilings stay seamless. */
const LAND_CELL_SIZE = 24;
const LANDBLOCK_SIZE = 192;

/** The per-vertex fade (0..1): the 1999 vertex alpha before its byte truncation. */
export function landscapeDetailFade(viewDepth: number, fade: { fadeMinZ: number; fadeMaxZ: number }): number {
  if (viewDepth < fade.fadeMinZ) return 1;
  if (viewDepth > fade.fadeMaxZ) return 0;
  return 1 - (viewDepth - fade.fadeMinZ) / (fade.fadeMaxZ - fade.fadeMinZ);
}

/**
 * One pixel of the landscape pass: `texelSrgb` and `detail` raw bytes / 255, `light` the clamped
 * lit vertex diffuse, `fade` the interpolated vertex alpha. SRCALPHA / INVSRCALPHA of
 * src = clamp(detail.rgb · L), src.a = detail.a · fade over dst = texel · L.
 */
export function retailLandscapeDetail(texelSrgb: Rgb, light: Rgb, detail: Rgba, fade: number): Rgb {
  const a = detail[3] * fade;
  const out: Rgb = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const dst = texelSrgb[c] * light[c];
    out[c] = clamp01(clamp01(detail[c] * light[c]) * a + dst * (1 - a));
  }
  return out;
}

/**
 * Whether a landscape detail texture is see-through enough to offer (webac#23): its mean alpha, the
 * pass's blend weight, is at most half (127 / 255). The retail detail textures weigh about 0.2
 * (1999 0x5001786: 51 everywhere; end of retail / Dark Majesty: 48-60). Classic Dereth 1.0 / 1.1
 * replace 0x5001786 with an opaque 512² image (alpha 255 everywhere), which would paint over the
 * ground near the camera, so those regions offer no option.
 */
export const LANDSCAPE_DETAIL_MAX_MEAN_ALPHA = 127;

export function landscapeDetailSeeThrough(rgba: { data: Uint8Array } | null): boolean {
  if (!rgba || rgba.data.length < 4) return false;
  let sum = 0;
  const n = rgba.data.length >> 2;
  for (let i = 3; i < rgba.data.length; i += 4) sum += rgba.data[i];
  return sum / n <= LANDSCAPE_DETAIL_MAX_MEAN_ALPHA;
}

/** The cell UV the 1999 land vertex carries (u east, v south, one per 24 m cell) × the tiling. */
export function landscapeDetailUv(worldX: number, worldNorth: number, tiling: number): [number, number] {
  return [worldX / LAND_CELL_SIZE * tiling, -worldNorth / LAND_CELL_SIZE * tiling];
}

const LAND_VERTEX_PRELUDE = `uniform float ${LAND_DETAIL_SCALE_UNIFORM};
uniform vec2 ${LAND_DETAIL_ORIGIN_UNIFORM};
uniform vec2 ${LAND_DETAIL_FADE_UNIFORM};
varying vec2 ${LAND_DETAIL_UV_VARYING};
varying float ${LAND_DETAIL_ALPHA_VARYING};
`;

/** After project_vertex: world x / north → cell UVs × tiling; view depth → the vertex fade. */
const LAND_VERTEX_BODY = `
	{
		vec4 acLdWorld = modelMatrix * vec4( transformed, 1.0 );
		${LAND_DETAIL_UV_VARYING} = vec2( acLdWorld.x - ${LAND_DETAIL_ORIGIN_UNIFORM}.x, ${LAND_DETAIL_ORIGIN_UNIFORM}.y - acLdWorld.z ) * ${LAND_DETAIL_SCALE_UNIFORM};
		${LAND_DETAIL_ALPHA_VARYING} = 1.0 - clamp( ( -mvPosition.z - ${LAND_DETAIL_FADE_UNIFORM}.x ) / ( ${LAND_DETAIL_FADE_UNIFORM}.y - ${LAND_DETAIL_FADE_UNIFORM}.x ), 0.0, 1.0 );
	}`;

const LAND_FRAGMENT_PRELUDE = `uniform sampler2D ${LAND_DETAIL_MAP_UNIFORM};
uniform float ${LAND_DETAIL_ON_UNIFORM};
varying vec2 ${LAND_DETAIL_UV_VARYING};
varying float ${LAND_DETAIL_ALPHA_VARYING};
`;

/** The landscape second draw, folded into the retail-lit fragment: see the section header. */
export const LAND_DETAIL_OUTGOING_LINES = [
  `\tvec4 acLandDetail = texture2D( ${LAND_DETAIL_MAP_UNIFORM}, ${LAND_DETAIL_UV_VARYING}, ${MIP_BIAS_UNIFORM} );`,
  `\tfloat acLandDetailA = acLandDetail.a * ${LAND_DETAIL_ALPHA_VARYING} * ${LAND_DETAIL_ON_UNIFORM};`,
  '\tvec3 outgoingLight = acSRGBToLinear( mix( acTexel * acLight, clamp( acLandDetail.rgb * acLight, 0.0, 1.0 ), acLandDetailA ) );',
].join('\n');

/** Rewrite a RetailLighting-patched landscape fragment shader to carry the landscape pass. */
export function patchLandscapeDetailFragment(fragmentShader: string): string {
  if (fragmentShader.includes(`uniform sampler2D ${LAND_DETAIL_MAP_UNIFORM};`)) return fragmentShader;
  if (!fragmentShader.includes(RETAIL_OUTGOING_LINE)) {
    throw new Error('DetailTexturing: landscape fragment shader lacks the RetailLighting outgoing line (patch order)');
  }
  if (!fragmentShader.includes(`uniform float ${MIP_BIAS_UNIFORM};`)) {
    throw new Error('DetailTexturing: landscape fragment shader lacks the sampler-bias uniform (patch order)');
  }
  return LAND_FRAGMENT_PRELUDE + fragmentShader.replace(RETAIL_OUTGOING_LINE, LAND_DETAIL_OUTGOING_LINES);
}

const PROJECT_VERTEX_INCLUDE = '#include <project_vertex>';

/** Compute the detail UVs + the vertex fade after project_vertex (mvPosition, transformed). */
export function patchLandscapeDetailVertex(vertexShader: string): string {
  if (vertexShader.includes(`varying vec2 ${LAND_DETAIL_UV_VARYING};`)) return vertexShader;
  if (!vertexShader.includes(PROJECT_VERTEX_INCLUDE)) {
    throw new Error('DetailTexturing: landscape vertex shader lost its project_vertex anchor');
  }
  return LAND_VERTEX_PRELUDE + vertexShader.replace(PROJECT_VERTEX_INCLUDE, `${PROJECT_VERTEX_INCLUDE}${LAND_VERTEX_BODY}`);
}

export interface LandscapeDetailUniforms {
  map: { value: THREE.Texture | null };
  on: { value: number };
  scale: { value: number };
  origin: { value: THREE.Vector2 };
  fade: { value: THREE.Vector2 };
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
  /** webac#23 — the era's landscape pass (null: the era's client has none; terrain programs stay unpatched). */
  private landscapeRule: { fadeMinZ: number; fadeMaxZ: number } | null = null;
  /** The landscape checkbox (1999 default off, the render-options defaults @ 0x42c236). */
  private landscapeEnabled = false;
  /** The region's landscape detail texture would cover the ground (landscapeDetailSeeThrough false). */
  private landscapeOpaque = false;
  /** landscapeDetailSeeThrough per landscape detail GID (decoded once). */
  private readonly seeThroughByGid = new Map<number, boolean>();
  private readonly landscapeUniforms: LandscapeDetailUniforms = {
    map: { value: null }, on: { value: 0 }, scale: { value: 0 },
    origin: { value: new THREE.Vector2(0, 0) }, fade: { value: new THREE.Vector2(0, 0) },
  };
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

  /**
   * webac#23 — the era's landscape pass rule (EraWorldRules.landscapeDetailTextures). Set once per
   * page load before the first terrain material is made: a landscape material made while it is
   * null carries no detail program at all.
   */
  setLandscapeRule(rule: { fadeMinZ: number; fadeMaxZ: number } | null): void {
    this.landscapeRule = rule;
    this.landscapeUniforms.fade.value.set(rule?.fadeMinZ ?? 0, rule?.fadeMaxZ ?? 0);
    this.refresh();
  }

  /**
   * Whether landscape materials take the detail program and the Config page offers the row: the
   * era has the pass and the loaded region's texture (if loaded yet) is see-through.
   */
  get landscapeAvailable(): boolean {
    return this.landscapeRule !== null && !this.landscapeOpaque;
  }

  get isLandscapeEnabled(): boolean {
    return this.landscapeEnabled;
  }

  /** Whether the landscape pass draws now (era rule, checkbox, and a region surface). */
  get isLandscapeDrawing(): boolean {
    return this.landscapeUniforms.on.value === 1;
  }

  landscapeUniformsFor(): LandscapeDetailUniforms {
    return this.landscapeUniforms;
  }

  /** The 1999 "Detail Texture: Landscape" checkbox → LScape_SetDetailTexturing(landscape, …). Returns whether it changed. */
  setLandscapeEnabled(on: boolean): boolean {
    if (this.landscapeEnabled === on) return false;
    this.landscapeEnabled = on;
    this.refresh();
    return true;
  }

  /**
   * Keep the detail UVs small: snap the subtracted world offset to the landblock (192 m) holding
   * (x, north). A whole number of cells × an integer tiling moves the UVs by whole repeats, so
   * the drawn texture is unchanged as the origin follows the camera.
   */
  setLandscapeOrigin(x: number, north: number): void {
    const ox = Math.floor(x / LANDBLOCK_SIZE) * LANDBLOCK_SIZE;
    const oy = Math.floor(north / LANDBLOCK_SIZE) * LANDBLOCK_SIZE;
    const o = this.landscapeUniforms.origin.value;
    if (o.x !== ox || o.y !== oy) o.set(ox, oy);
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
      u.map.value = this.textureForSurface(s, source);
      u.tiling.value = s.tiling;
    }
    // webac#23 — terrain_desc[0], only decoded where the era has the landscape pass, and only
    // used when it is see-through (landscapeDetailSeeThrough).
    let land = this.landscapeRule ? surfaces.landscape : null;
    let landRgba: { width: number; height: number; data: Uint8Array } | null = null;
    if (land && !this.seeThroughByGid.has(land.texGID)) {
      landRgba = source.getRGBA(land.texGID);
      this.seeThroughByGid.set(land.texGID, landscapeDetailSeeThrough(landRgba));
    }
    this.landscapeOpaque = land !== null && !this.seeThroughByGid.get(land.texGID);
    if (this.landscapeOpaque) land = null;
    this.landscapeUniforms.map.value = land ? this.textureForSurface(land, source, landRgba) : null;
    this.landscapeUniforms.scale.value = land ? land.tiling / LAND_CELL_SIZE : 0;
    this.refresh();
    return surfaces;
  }

  /** The landscape detail DataTexture (null outside an era with the pass, or before the region loads). */
  landscapeTexture(): THREE.DataTexture | null {
    return (this.landscapeUniforms.map.value as THREE.DataTexture | null) ?? null;
  }

  /** One decoded DataTexture per detail GID. */
  private textureForSurface(
    s: DetailSurface, source: DetailTextureSource,
    rgba?: { width: number; height: number; data: Uint8Array } | null,
  ): THREE.DataTexture | null {
    let tex = this.textures.get(s.texGID) ?? null;
    if (!tex) {
      // CORE.17.h.g.c.d — the detail surfaces are RenderTextures like any
      // other, so Very High draws their client_highres.dat level too.
      const hiRes = source.getHighResRGBA && (source.hasHighResLevel?.(s.texGID) ?? true)
        ? () => source.getHighResRGBA!(s.texGID) : undefined;
      tex = DetailTexturing.createDetailTexture(rgba ?? source.getRGBA(s.texGID), hiRes);
      if (tex) this.textures.set(s.texGID, tex);
    }
    return tex;
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
    const l = this.landscapeUniforms;
    l.on.value = this.landscapeRule && this.landscapeEnabled && l.map.value ? 1 : 0;
  }
}

export const detailTexturing = new DetailTexturing();
