import * as THREE from 'three';
import { datMissEpoch, noDatMissSince, onDatMissResolved } from '@ac/dat-parser/streaming/DatMiss.js';

/**
 * CORE.17.h.g.c — the Config tab's Rendering Quality texture preferences
 * (Render.TextureFiltering / Render.LandscapeTextureDetail /
 * Render.EnvironmentTextureDetail) applied to the world's samplers, the way
 * the retail client's `Render::m_RenderPrefs` reaches Direct3D.
 *
 * Retail (reference/client-eol/decomp/acclient-decompiled.c, build ac1_sep13):
 *
 * - `RenderDeviceD3D::SetSamplerFilterMode` @ 005a3350 (:404975-405010) sets
 *   D3DSAMP_MINFILTER (6) / MAGFILTER (5) / MIPFILTER (7) per sampler from
 *   the material's requested modes and `m_RenderPrefs.TextureFiltering`:
 *   choice 3 (Anisotropic) promotes a LINEAR min/mag request to ANISOTROPIC
 *   (caps permitting); choice 0 (Bilinear) demotes a LINEAR mip request to
 *   POINT; 1 (Trilinear) leaves LINEAR/LINEAR/LINEAR.
 * - `RenderDeviceD3D::BeginScene` @ 0059fc80 (:402012-402028) sets
 *   D3DSAMP_MIPMAPLODBIAS (8) on all 16 samplers every scene: −1.4 when
 *   TextureFiltering == 2 (Sharp), else the device default.
 * - `Render::UpdateFromPreferences` @ 0054d850 (:325024-325046): the two
 *   detail levels become texture SCALES — level 0 → FULL_RES (0), else
 *   level − HALF_RES (= level − 1; objdump 54d8ff `dec eax` / `xor eax,eax`):
 *   `ImgTex::fLandTextureScale` for the landscape, and
 *   `fClipmapTextureScale` = `fRGBATextureScale` = `fIndexedTextureScale`
 *   for everything else (CSurface::SetTextureAndPalette @ 00535fb0 picks the
 *   one matching the surface's texture type).
 * - `ImgTex::CreateD3DTexture` @ 0053edb0 (:309641-309670) allocates the
 *   D3D texture at `width >> scale`, `height >> scale`, clamped at
 *   `ImgTex::min_tex_size` (.data 0x81e918 = 8) unless the source is smaller.
 * - `TexMerge::RestoreSurface` @ 00504910 / `MakeNewSurface` @ 005049b0
 *   (:251377 / :251411) size the merged landscape textures at
 *   `base_tex_size >> ImageShift[fLandTextureScale]` (ImageShift = .rdata
 *   0x7c638c = [0, 1, 2, 4, 8, …]; EoL region base_tex_size = 1024, the 512 px
 *   terrain textures tile twice per cell → 1024 is the 1:1 texel density).
 * - `RenderTexture::DropUnwantedLevels` @ 0044c390 (:78769-78840) drops the
 *   top min(level, n−1) entries of a SurfaceTexture's level list — level 0
 *   (Very High) drops nothing when `RenderTexture::ShouldDropHighDetail`
 *   @ 0044b830 finds the HiFi DAT 0x69466948 (client_highres.dat) mounted in
 *   `DBCache::s_pCache`, and falls through to the level-1 case (drop one)
 *   without it. `RenderTexture::ConstructTexture` @ 0044ba70 (:78130) then
 *   allocates the D3D texture at the FIRST retained level's width/height
 *   with one mip per retained level (index 0 = the top mip), so the list is
 *   ordered highest-detail first: index 0 is the highres level (present in
 *   client_highres.dat, or in portal.dat itself for ~500 of the 3,024
 *   two-level SurfaceTextures), index 1 the portal level retail draws at
 *   High. `RenderTexture::GetSubDataIDs` @ 0044c6c0 (:78978) qualifies
 *   index 0 as optional (qualifier 4) when the list has more than one level,
 *   so a missing highres entry never fails the load. CORE.17.h.g.c.d: the
 *   TextureManager mounts client_highres.dat as a second DatDatabase and
 *   hands every environment texture a lazy level-0 source; the registry
 *   below swaps it in under Very High (0) while the HiFi DAT is mounted and
 *   falls back to the portal level otherwise — exactly retail's Very High =
 *   High without the DAT. Landscape textures keep the portal level at every
 *   level: the EoL terrain SurfaceTextures (RegionDesc 0x13000000 TexMerge)
 *   list a single 512×512 A8R8G8B8 level, so there is no highres level to
 *   swap in.
 *
 * The environment shifts below are RELATIVE to the retail default High (1),
 * whose scale is 0 = the full portal-level texture.
 *
 * CORE.17.h.g.c.a — the landscape is NOT a downscale. TexMerge builds one
 * M×M texture per cell, M = base_tex_size >> ImageShift[fLandTextureScale]
 * (≥ min_tex_size), and copies the terrain pixels into it 1:1 — nothing
 * resamples them:
 * - `FillTempTexBuffer` @ 00504450 → `CopyAndTile` @ 00503580 →
 *   `ImgTex::TileCSI` @ 0053e740 (:309232) writes the whole source image
 *   tex_tiling × tex_tiling times at the merged row pitch M. At M = 1024
 *   (High / Very High) that is exactly two 512-px tiles per cell; at a
 *   smaller M the later tiles land outside the M×M window, so the cell
 *   keeps the top-left M×M of the source (shifted down 512/M rows by the
 *   second tile's wrapped write — 1..8 texels, not reproduced).
 * - `ImgTex::MergeTexture` @ 0053e870 (:309317), the terrain/road overlays,
 *   reads the terrain texture straight (`local_34 += width` per row, wrapped
 *   modulo its width/height) — tex_tiling is ignored, only the ALPHA map is
 *   rotated and resampled nearest-neighbour to M (`param_3 / width`
 *   replication when M is larger, a `width / param_3` texel step when smaller).
 * So every level keeps the source texel size in the merged texture and
 * changes how much of the terrain texture a cell shows: M / 512 repeats per
 * cell (High 2, Medium 1) or the top-left M×M corner once (Low 256, Very
 * Low 64). Retail's default Medium therefore draws each terrain texture
 * ONCE per 24 m cell — twice the world-space size of our pre-CORE.17.h.g.c.a
 * output, which tiled it twice at every level ≥ Medium. `landscapeMergedSize`
 * / `landscapeRepeatsPerCell` below + the `landscape` layout registration
 * reproduce that: terrain images are cropped (never filtered) to min(M, S)
 * and their per-cell UV repeat is M / min(M, S); alpha maps are point-
 * subsampled to M when M is smaller.
 */

export const TEXTURE_FILTERING = {
  BILINEAR: 0,
  TRILINEAR: 1,
  SHARP: 2,
  ANISOTROPIC: 3,
} as const;

export type TextureFilteringMode = 0 | 1 | 2 | 3;

/** Render.TextureFiltering registered without a value table → choice indices. */
export const TEXTURE_FILTERING_VALUES: readonly TextureFilteringMode[] = [0, 1, 2, 3];
/** Render_LandscapeTextureDetail_Values / Render_EnvironmentTextureDetail_Values (.data 0x3ca960 / 0x3ca974). */
export const TEXTURE_DETAIL_VALUES: readonly number[] = [4, 3, 2, 1, 0];

/** gmConfigUI::InitOptions SetDefaultValue (decomp :158684-158729). */
export const RETAIL_DEFAULT_TEXTURE_FILTERING: TextureFilteringMode = 1;
export const RETAIL_DEFAULT_LANDSCAPE_TEXTURE_DETAIL = 2;
export const RETAIL_DEFAULT_ENVIRONMENT_TEXTURE_DETAIL = 1;

/** RenderDeviceD3D::BeginScene: D3DSAMP_MIPMAPLODBIAS for Sharp. */
export const SHARP_MIP_LOD_BIAS = -1.4;
/** ImgTex::min_tex_size (.data 0x81e918). */
export const RETAIL_MIN_TEX_SIZE = 8;
/** ImageShift (.rdata 0x7c638c), indexed by the landscape texture scale. */
export const LANDSCAPE_IMAGE_SHIFT: readonly number[] = [0, 1, 2, 4, 8];
/** DDDManager.HiFi_String_As_Int ("HiFi") — the DBCache id RenderTexture::ShouldDropHighDetail probes for client_highres.dat. */
export const HIFI_DAT_ID = 0x69466948;
/** The Environment Texture Detail choice that keeps the highres level (Very High). */
export const VERY_HIGH_ENVIRONMENT_TEXTURE_DETAIL = 0;

/**
 * RenderTexture::DropUnwantedLevels @ 0044c390: the levels a SurfaceTexture
 * keeps (highest detail first) for an Environment Texture Detail choice —
 * level 0 keeps everything while the HiFi DAT is mounted and otherwise
 * behaves as level 1; every other level drops min(level, n − 1) entries
 * from the top. A list of one level is never touched.
 */
export function retainedSurfaceTextureLevels<T>(levels: readonly T[], environmentTextureDetail: number, hiFiMounted: boolean): T[] {
  const n = levels.length;
  if (n <= 1) return [...levels];
  let drop: number;
  if (environmentTextureDetail === VERY_HIGH_ENVIRONMENT_TEXTURE_DETAIL) {
    if (hiFiMounted) return [...levels];
    drop = 1;
  } else if (Number.isInteger(environmentTextureDetail) && environmentTextureDetail >= 1 && environmentTextureDetail <= 4) {
    drop = environmentTextureDetail;
  } else {
    return [...levels]; // switch default: untouched
  }
  if (drop >= n) drop = n - 1;
  return levels.slice(drop);
}
/** TexMerge::base_tex_size of the EoL region (0x13000000), for documentation/tests. */
export const EOL_REGION_BASE_TEX_SIZE = 1024;

/**
 * 'landscape' = a terrain colour texture drawn through TexMerge (cropped +
 * re-tiled per Landscape Texture Detail), 'landscapeAlpha' = a TexMerge
 * terrain/road alpha map (point-subsampled to the merge size),
 * 'environment' = everything else (ImgTex::CreateD3DTexture's shift).
 */
export type TextureKind = 'landscape' | 'landscapeAlpha' | 'environment';

/**
 * How a landscape texture is laid over the cells: `uvCells` = how many 24 m
 * cells its UV 0..1 spans (8 for the landblock mesh, 1 for a per-cell
 * overlay quad), `baseTexSize` = the region's TexMerge::base_tex_size.
 */
export interface LandscapeLayout {
  uvCells: number;
  baseTexSize: number;
}

export interface TexturePrefValues {
  textureFiltering: TextureFilteringMode;
  landscapeTextureDetail: number;
  environmentTextureDetail: number;
}

/** Render.TextureFiltering: an integer choice 0..3, anything else = the retail default (Trilinear). */
export function normalizeTextureFiltering(v: unknown): TextureFilteringMode {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 3
    ? (v as TextureFilteringMode)
    : RETAIL_DEFAULT_TEXTURE_FILTERING;
}

/** A texture-detail level is one of the registered values [4,3,2,1,0]; anything else = the given default. */
export function normalizeTextureDetail(v: unknown, fallback: number): number {
  return typeof v === 'number' && TEXTURE_DETAIL_VALUES.includes(v) ? v : fallback;
}

/**
 * Render::UpdateFromPreferences: a detail level becomes a texture scale —
 * 0 → FULL_RES (0), otherwise level − HALF_RES (1).
 */
export function retailTextureScale(level: number): number {
  return level === 0 ? 0 : level - 1;
}

/** ImgTex::CreateD3DTexture: environment textures are allocated at width >> scale. */
export function retailEnvironmentShift(level: number): number {
  return retailTextureScale(level);
}

/** TexMerge: the merged landscape textures are base_tex_size >> ImageShift[scale]. */
export function retailLandscapeShift(level: number): number {
  const scale = retailTextureScale(level);
  return LANDSCAPE_IMAGE_SHIFT[Math.min(scale, LANDSCAPE_IMAGE_SHIFT.length - 1)];
}

/**
 * Our shift for environment textures, relative to the retail default High
 * (1) whose scale is 0 — today's full portal-level texture. [0,0,1,2,3].
 */
export function environmentDetailShift(level: number): number {
  return Math.max(0, retailEnvironmentShift(level) - retailEnvironmentShift(RETAIL_DEFAULT_ENVIRONMENT_TEXTURE_DETAIL));
}

/**
 * TexMerge::RestoreSurface @ 00504910 / MakeNewSurface @ 005049b0: the side
 * of the merged per-cell landscape texture, `base_tex_size >>
 * ImageShift[scale]` floored at min_tex_size (the landblock-LOD divisor
 * CLandBlockStruct::GetCellRotation packs into bits 28+ of the surface code
 * is 1 for full 8×8-cell landblocks; reduced-LOD blocks use 4, which
 * TerrainRenderer models by registering their clones at base_tex_size / 4 —
 * DECOMP.terrain-lod). EoL (1024):
 * Very High 1024, High 1024, Medium 512, Low 256, Very Low 64.
 */
export function landscapeMergedSize(level: number, baseTexSize = EOL_REGION_BASE_TEX_SIZE): number {
  const size = baseTexSize >> retailLandscapeShift(level);
  return size < RETAIL_MIN_TEX_SIZE ? RETAIL_MIN_TEX_SIZE : size;
}

/**
 * The part of a terrain texture a merged cell shows: TileCSI / MergeTexture
 * copy source pixels 1:1, so an M-px cell holds the top-left min(M, S) px
 * of an S-px texture.
 */
export function landscapeTerrainImageSize(mergedSize: number, sourceSize: number): number {
  return Math.min(mergedSize, sourceSize);
}

/**
 * How many times that image repeats across one cell: M / min(M, S) — two
 * 512-px tiles at M = 1024, one at 512, one (cropped) below that. The
 * cell's texel count is always M.
 */
export function landscapeRepeatsPerCell(mergedSize: number, sourceSize: number): number {
  return mergedSize / landscapeTerrainImageSize(mergedSize, sourceSize);
}

/**
 * ImgTex::CreateD3DTexture's size rule: `size >> shift`, but never below
 * min_tex_size unless the source itself is smaller than that.
 */
export function shiftedTextureSize(size: number, shift: number, minSize = RETAIL_MIN_TEX_SIZE): number {
  if (shift <= 0 || size <= 0) return size;
  const shifted = Math.max(1, size >> shift);
  if (shifted >= minSize) return shifted;
  return Math.min(size, minSize);
}

export interface SamplerFilters {
  minFilter: THREE.MinificationTextureFilter;
  magFilter: THREE.MagnificationTextureFilter;
  anisotropy: number;
}

/**
 * RenderDeviceD3D::SetSamplerFilterMode for a LINEAR/LINEAR/LINEAR request
 * (the world material default, :74076-74078): Bilinear demotes the mip
 * filter to POINT; Trilinear and Sharp keep LINEAR mips (Sharp adds the LOD
 * bias, see `mipBiasUniform`); Anisotropic promotes min + mag to
 * ANISOTROPIC at the device's cap (D3D's MAXANISOTROPY is left at the
 * device value, so the degree is the driver's — ours uses the WebGL max).
 */
export function samplerFilters(mode: TextureFilteringMode, maxAnisotropy: number): SamplerFilters {
  const aniso = Math.max(1, Math.floor(maxAnisotropy));
  switch (mode) {
    case TEXTURE_FILTERING.BILINEAR:
      return { minFilter: THREE.LinearMipmapNearestFilter, magFilter: THREE.LinearFilter, anisotropy: 1 };
    case TEXTURE_FILTERING.ANISOTROPIC:
      return { minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, anisotropy: aniso };
    case TEXTURE_FILTERING.SHARP:
    case TEXTURE_FILTERING.TRILINEAR:
    default:
      return { minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, anisotropy: 1 };
  }
}

/** The mip LOD bias BeginScene programs for a filtering choice. */
export function mipLodBiasFor(mode: TextureFilteringMode): number {
  return mode === TEXTURE_FILTERING.SHARP ? SHARP_MIP_LOD_BIAS : 0;
}

export interface RgbaImage {
  data: Uint8Array;
  width: number;
  height: number;
}

/**
 * Box-filter an RGBA image down by integer factors (fx × fy source pixels
 * per output pixel, rounded average — what a D3D mip-chain fill does level
 * by level). Odd remainders fold into the last cell; the result never
 * drops below 1 px on either axis.
 */
export function boxDownsampleRGBA(src: RgbaImage, fx: number, fy: number): RgbaImage {
  fx = Math.max(1, Math.floor(fx));
  fy = Math.max(1, Math.floor(fy));
  if (fx === 1 && fy === 1) return src;
  const sw = src.width;
  const sh = src.height;
  const w = Math.max(1, Math.floor(sw / fx));
  const h = Math.max(1, Math.floor(sh / fy));
  const out = new Uint8Array(w * h * 4);
  const n = fx * fy;
  const half = n >> 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < fy; dy++) {
        const sy = Math.min(sh - 1, y * fy + dy);
        for (let dx = 0; dx < fx; dx++) {
          const sx = Math.min(sw - 1, x * fx + dx);
          const i = (sy * sw + sx) * 4;
          r += src.data[i]; g += src.data[i + 1]; b += src.data[i + 2]; a += src.data[i + 3];
        }
      }
      const o = (y * w + x) * 4;
      out[o] = (r + half) / n | 0;
      out[o + 1] = (g + half) / n | 0;
      out[o + 2] = (b + half) / n | 0;
      out[o + 3] = (a + half) / n | 0;
    }
  }
  return { data: out, width: w, height: h };
}

/** Halve an image `shift` times (2×2 box per step), stopping at 1×1. */
export function downsampleRGBA(src: RgbaImage, shift: number): RgbaImage {
  let cur = src;
  for (let s = 0; s < shift; s++) {
    if (cur.width <= 1 && cur.height <= 1) break;
    cur = boxDownsampleRGBA(cur, cur.width > 1 ? 2 : 1, cur.height > 1 ? 2 : 1);
  }
  return cur;
}

/**
 * Downsample to exactly the retail target size — `shiftedTextureSize` per
 * axis, so a texture whose short side hits the min_tex_size floor keeps
 * that side while the long side still shrinks (CreateD3DTexture sizes the
 * axes independently). Returns the source image itself when nothing
 * changes.
 */
export function scaleRGBAForShift(src: RgbaImage, shift: number, minSize = RETAIL_MIN_TEX_SIZE): RgbaImage {
  const targetW = shiftedTextureSize(src.width, shift, minSize);
  const targetH = shiftedTextureSize(src.height, shift, minSize);
  if (targetW === src.width && targetH === src.height) return src;
  return boxDownsampleRGBA(src, src.width / targetW, src.height / targetH);
}

/**
 * TileCSI's effect on a merge window smaller than the source: the top-left
 * w×h pixels, copied (the source itself when nothing is cut).
 */
export function cropRGBA(src: RgbaImage, w: number, h: number): RgbaImage {
  w = Math.max(1, Math.min(src.width, Math.floor(w)));
  h = Math.max(1, Math.min(src.height, Math.floor(h)));
  if (w === src.width && h === src.height) return src;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    out.set(src.data.subarray(y * src.width * 4, (y * src.width + w) * 4), y * w * 4);
  }
  return { data: out, width: w, height: h };
}

/**
 * MergeTexture's alpha read when the alpha map is larger than the merge
 * window: every (width / M)-th texel of every (height / M)-th row, the
 * first of each block (nearest, no averaging). Returns the source itself
 * when nothing shrinks.
 */
export function pointSubsampleRGBA(src: RgbaImage, w: number, h: number): RgbaImage {
  w = Math.max(1, Math.min(src.width, Math.floor(w)));
  h = Math.max(1, Math.min(src.height, Math.floor(h)));
  if (w === src.width && h === src.height) return src;
  const fx = Math.floor(src.width / w);
  const fy = Math.floor(src.height / h);
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const row = y * fy * src.width;
    for (let x = 0; x < w; x++) {
      const i = (row + x * fx) * 4;
      const o = (y * w + x) * 4;
      out[o] = src.data[i];
      out[o + 1] = src.data[i + 1];
      out[o + 2] = src.data[i + 2];
      out[o + 3] = src.data[i + 3];
    }
  }
  return { data: out, width: w, height: h };
}

// ── Sharp-mode mip LOD bias in the shaders ────────────────────────────────

/**
 * D3DSAMP_MIPMAPLODBIAS has no WebGL sampler state; the GLSL `texture(s,
 * uv, bias)` overload adds the same bias to the computed LOD. One shared
 * uniform (default 0 = byte-identical LOD selection) reaches every world
 * material; Sharp sets it to −1.4.
 */
export const mipBiasUniform = { value: 0 };

export const MIP_BIAS_UNIFORM = 'acMipBias';
export const SAMPLER_BIAS_CACHE_KEY = 'acSamplerBias';

const MAP_INCLUDE = '#include <map_fragment>';
const ALPHAMAP_INCLUDE = '#include <alphamap_fragment>';
const MAP_SAMPLE = 'texture2D( map, vMapUv )';
const ALPHAMAP_SAMPLE = 'texture2D( alphaMap, vAlphaMapUv )';

/**
 * Rewrite a three.js fragment shader so the diffuse map and alpha map are
 * sampled with the shared LOD bias. Throws if the three.js (r186) chunks lost their
 * anchors (a silent fall-through would leave Sharp a no-op).
 */
export function patchSamplerBias(fragmentShader: string): string {
  if (fragmentShader.includes(`uniform float ${MIP_BIAS_UNIFORM};`)) return fragmentShader;
  const map = THREE.ShaderChunk.map_fragment;
  const alpha = THREE.ShaderChunk.alphamap_fragment;
  if (!map.includes(MAP_SAMPLE)) throw new Error('TextureSamplerPrefs: map_fragment lost its texture2D anchor');
  if (!alpha.includes(ALPHAMAP_SAMPLE)) throw new Error('TextureSamplerPrefs: alphamap_fragment lost its texture2D anchor');
  if (!fragmentShader.includes(MAP_INCLUDE)) throw new Error('TextureSamplerPrefs: fragment shader has no map_fragment include');
  const mapPatched = map.split(MAP_SAMPLE).join(`texture2D( map, vMapUv, ${MIP_BIAS_UNIFORM} )`);
  const alphaPatched = alpha.split(ALPHAMAP_SAMPLE).join(`texture2D( alphaMap, vAlphaMapUv, ${MIP_BIAS_UNIFORM} )`);
  return `uniform float ${MIP_BIAS_UNIFORM};\n` + fragmentShader
    .replace(MAP_INCLUDE, mapPatched)
    .replace(ALPHAMAP_INCLUDE, alphaPatched);
}

const biasPatched = new WeakSet<THREE.Material>();

export function hasSamplerBias(material: THREE.Material): boolean {
  return biasPatched.has(material);
}

/**
 * Install the shared mip-bias sampling on a material that has no other
 * onBeforeCompile (the MaterialFactory's luminous/additive
 * MeshBasicMaterials). Lambert materials get it through RetailLighting's
 * patch instead (one onBeforeCompile per material). Idempotent; a clone()
 * drops onBeforeCompile and must be re-applied.
 */
export function applySamplerBias<T extends THREE.Material>(material: T): T {
  if (biasPatched.has(material)) return material;
  // Hand-written GLSL (ShaderMaterial) has no map_fragment chunk to bias.
  if ((material as unknown as { isShaderMaterial?: boolean }).isShaderMaterial) return material;
  const prev = material.customProgramCacheKey;
  material.onBeforeCompile = (shader) => {
    shader.uniforms[MIP_BIAS_UNIFORM] = mipBiasUniform;
    shader.fragmentShader = patchSamplerBias(shader.fragmentShader);
  };
  const prevKey = typeof prev === 'function' && prev !== THREE.Material.prototype.customProgramCacheKey
    ? prev.call(material) : '';
  material.customProgramCacheKey = () => `${prevKey}|${SAMPLER_BIAS_CACHE_KEY}`;
  material.needsUpdate = true;
  biasPatched.add(material);
  return material;
}

/** Mark a material whose own onBeforeCompile already applies the bias patch. */
export function markSamplerBias(material: THREE.Material): void {
  biasPatched.add(material);
}

// ── The live preference set + texture registry ────────────────────────────

/**
 * A lazy decoder for a SurfaceTexture's level-0 (highres) image — the
 * TextureManager reads it from client_highres.dat (or portal.dat) only when
 * Very High first asks for it. Returns null when the level does not exist.
 */
export type HiResSource = () => RgbaImage | null;

/**
 * RENDER.alpha-ref-follows-bound-texture — decoded images that came from a
 * palettized (P8 / INDEX16) texture, i.e. retail's ImgTex has an
 * `m_pPalette`: D3DPolyRender::SetSurface @ 0059c4d0 alpha-tests those
 * against s_256AlphaTestRef (100), anything else (DXT highres levels
 * included) against s_ddsAlphaTestRef (200). TextureManager marks the
 * images it decodes; `applyTo` tags the texture with the image it binds
 * (`userData.acPaletted`), so the tag follows a Very High level swap.
 */
const PALETTED_IMAGES = new WeakSet<object>();
export function markPalettedImage<T extends object>(image: T): T {
  PALETTED_IMAGES.add(image);
  return image;
}
export function isPalettedImage(image: object | null | undefined): boolean {
  return !!image && PALETTED_IMAGES.has(image);
}

export interface RegisterOptions {
  /** The level-0 source for an environment texture (ignored for landscape textures). */
  hiRes?: HiResSource;
  /** The texture was constructed from `hiRes`'s image already (its current image IS the highres level at shift 0). */
  builtFromHiRes?: boolean;
  /** With `builtFromHiRes`: the decoded highres image itself (keeps its palettized mark). */
  hiResImage?: RgbaImage;
  /** CORE.17.h.g.c.a — a 'landscape' texture's cell layout; its UV repeat then follows the detail level. */
  landscape?: LandscapeLayout;
}

interface Registration {
  kind: TextureKind;
  fullRes: RgbaImage;
  /**
   * What the current image was built for — the shift (environment) or the
   * merge size (landscape kinds); −1 = unknown, decided by the dimensions.
   */
  state: number;
  /** A 'landscape' texture's cell layout (drives its UV repeat). */
  landscape?: LandscapeLayout;
  /** Lazy level-0 source; undefined = the texture has no highres level. */
  hiRes?: HiResSource;
  /** Memoised `hiRes()` result: undefined = not asked yet, null = the level is unavailable. */
  hiResImage?: RgbaImage | null;
  /** The current image was built from the highres level. */
  atHiRes: boolean;
}

/**
 * Holds the three preference values and every world DataTexture, and
 * re-applies filters / anisotropy / detail scaling to them on change —
 * retail's Render::UpdateFromPreferences + FlushGraphicsResources rolled
 * into one (a changed detail level rebuilds every texture; a changed
 * filter re-uploads them with the new sampler state, three.js has no
 * lighter path).
 */
export class TextureSamplerPrefs {
  private filtering: TextureFilteringMode = RETAIL_DEFAULT_TEXTURE_FILTERING;
  private landscapeDetail = RETAIL_DEFAULT_LANDSCAPE_TEXTURE_DETAIL;
  private environmentDetail = RETAIL_DEFAULT_ENVIRONMENT_TEXTURE_DETAIL;
  private maxAnisotropy = 1;
  /** RenderTexture::ShouldDropHighDetail's DBCache probe: client_highres.dat is mounted. */
  private hiFiMounted = false;
  private readonly registry = new Map<THREE.Texture, Registration>();
  /**
   * Streamed DATs: textures whose highres level missed (client_highres.dat
   * mounts at once, its files arrive later). They draw the portal level
   * and re-apply when streamed files land.
   */
  private readonly hiResPending = new Set<THREE.Texture>();
  private unsubscribeArrival: (() => void) | null = null;
  private readonly bias: { value: number };

  constructor(bias: { value: number } = mipBiasUniform) {
    this.bias = bias;
    this.bias.value = mipLodBiasFor(this.filtering);
  }

  get values(): TexturePrefValues {
    return {
      textureFiltering: this.filtering,
      landscapeTextureDetail: this.landscapeDetail,
      environmentTextureDetail: this.environmentDetail,
    };
  }

  get textureFiltering(): TextureFilteringMode { return this.filtering; }
  get landscapeTextureDetail(): number { return this.landscapeDetail; }
  get environmentTextureDetail(): number { return this.environmentDetail; }
  get registeredCount(): number { return this.registry.size; }
  get mipLodBias(): number { return this.bias.value; }

  /** The device cap (renderer.capabilities.getMaxAnisotropy()); re-applies when Anisotropic is active. */
  setMaxAnisotropy(max: number): void {
    const v = Math.max(1, Math.floor(max));
    if (v === this.maxAnisotropy) return;
    this.maxAnisotropy = v;
    if (this.filtering === TEXTURE_FILTERING.ANISOTROPIC) {
      for (const tex of this.registry.keys()) this.applyTo(tex);
    }
  }

  getMaxAnisotropy(): number { return this.maxAnisotropy; }

  /** Whether client_highres.dat is mounted (the HiFi DAT ShouldDropHighDetail looks for). */
  get highResMounted(): boolean { return this.hiFiMounted; }

  /**
   * Mount / unmount the HiFi DAT. Retail mounts it at startup when the file
   * exists; ours fetches it on demand, so mounting re-applies every
   * registered texture (Very High swaps the highres level in at once).
   */
  setHighResMounted(mounted: boolean): boolean {
    if (mounted === this.hiFiMounted) return false;
    this.hiFiMounted = mounted;
    const retargeted = new Map<THREE.TextureSource<unknown>, THREE.TextureSource<unknown>>();
    for (const tex of this.registry.keys()) this.applyTo(tex, retargeted);
    return true;
  }

  /**
   * DropUnwantedLevels for a kind: the highres level is drawn only for
   * environment textures at Very High with the HiFi DAT mounted.
   */
  usesHighResLevel(kind: TextureKind): boolean {
    return kind === 'environment'
      && this.environmentDetail === VERY_HIGH_ENVIRONMENT_TEXTURE_DETAIL
      && this.hiFiMounted;
  }

  /**
   * The shift a kind currently uses: the environment texture shift, or for
   * the landscape kinds retail's merge shift (ImageShift[scale]).
   */
  shiftFor(kind: TextureKind): number {
    return kind === 'environment'
      ? environmentDetailShift(this.environmentDetail)
      : retailLandscapeShift(this.landscapeDetail);
  }

  /** The current merged per-cell landscape texture size for a region's base_tex_size. */
  landscapeMergedSize(baseTexSize = EOL_REGION_BASE_TEX_SIZE): number {
    return landscapeMergedSize(this.landscapeDetail, baseTexSize);
  }

  /**
   * Adopt (partial) preference values; invalid values fall back to the
   * retail defaults. Returns true when anything changed (and every
   * registered texture was re-applied).
   */
  set(prefs: Partial<Record<keyof TexturePrefValues, unknown>>): boolean {
    const next: TexturePrefValues = {
      textureFiltering: 'textureFiltering' in prefs ? normalizeTextureFiltering(prefs.textureFiltering) : this.filtering,
      landscapeTextureDetail: 'landscapeTextureDetail' in prefs
        ? normalizeTextureDetail(prefs.landscapeTextureDetail, RETAIL_DEFAULT_LANDSCAPE_TEXTURE_DETAIL)
        : this.landscapeDetail,
      environmentTextureDetail: 'environmentTextureDetail' in prefs
        ? normalizeTextureDetail(prefs.environmentTextureDetail, RETAIL_DEFAULT_ENVIRONMENT_TEXTURE_DETAIL)
        : this.environmentDetail,
    };
    const changed = next.textureFiltering !== this.filtering
      || next.landscapeTextureDetail !== this.landscapeDetail
      || next.environmentTextureDetail !== this.environmentDetail;
    if (!changed) return false;
    this.filtering = next.textureFiltering;
    this.landscapeDetail = next.landscapeTextureDetail;
    this.environmentDetail = next.environmentTextureDetail;
    this.bias.value = mipLodBiasFor(this.filtering);
    const retargeted = new Map<THREE.TextureSource<unknown>, THREE.TextureSource<unknown>>();
    for (const tex of this.registry.keys()) this.applyTo(tex, retargeted);
    return true;
  }

  /**
   * Register a world DataTexture. `fullRes` is the source image at the
   * portal level (defaults to the texture's current image); it is kept
   * aside — not in userData, which `Texture.clone()` JSON-copies — so a
   * lower detail level can be undone. Applies the current prefs at once.
   */
  register(tex: THREE.DataTexture, kind: TextureKind, fullRes?: RgbaImage, opts: RegisterOptions = {}): THREE.DataTexture {
    const image = tex.image as unknown as RgbaImage;
    const prev = this.registry.get(tex);
    const src = fullRes ?? prev?.fullRes ?? { data: image.data, width: image.width, height: image.height };
    const hiRes = opts.hiRes ?? prev?.hiRes;
    const landscape = opts.landscape ?? prev?.landscape;
    if (opts.builtFromHiRes) {
      // Constructed straight from the highres level (Very High was already
      // active): its current image is that level at shift 0.
      this.registry.set(tex, {
        kind, fullRes: src, state: 0, hiRes, atHiRes: true, landscape,
        hiResImage: opts.hiResImage ?? { data: image.data, width: image.width, height: image.height },
      });
    } else {
      // State unknown: applyTo re-images only when the current dimensions
      // differ from the level's target, so a texture handed over at its
      // full-resolution image, a re-registration, or a clone sharing an
      // already-scaled Source keeps its image when it already fits.
      const atFull = image.width === src.width && image.height === src.height;
      this.registry.set(tex, {
        kind, fullRes: src, state: -1, landscape,
        hiRes, hiResImage: prev?.hiResImage, atHiRes: atFull ? false : (prev?.atHiRes ?? false),
      });
    }
    this.applyTo(tex);
    return tex;
  }

  unregister(tex: THREE.Texture): void {
    this.registry.delete(tex);
    this.hiResPending.delete(tex);
  }

  /** Textures still waiting for a streamed highres level (probes / tests). */
  get pendingHighResCount(): number { return this.hiResPending.size; }

  /** Streamed files landed: re-apply the textures whose highres level missed. */
  private retryPendingHighRes(): void {
    const pending = [...this.hiResPending];
    this.hiResPending.clear();
    const retargeted = new Map<THREE.TextureSource<unknown>, THREE.TextureSource<unknown>>();
    for (const tex of pending) this.applyTo(tex, retargeted);
    if (this.hiResPending.size === 0) {
      this.unsubscribeArrival?.();
      this.unsubscribeArrival = null;
    }
  }

  isRegistered(tex: THREE.Texture): boolean {
    return this.registry.has(tex);
  }

  kindOf(tex: THREE.Texture): TextureKind | null {
    return this.registry.get(tex)?.kind ?? null;
  }

  fullResOf(tex: THREE.Texture): RgbaImage | null {
    return this.registry.get(tex)?.fullRes ?? null;
  }

  /** Whether a registered texture currently draws its highres (level-0) image. */
  isAtHighRes(tex: THREE.Texture): boolean {
    return this.registry.get(tex)?.atHiRes ?? false;
  }

  /** Whether a registered texture carries a highres level source at all. */
  hasHighResLevel(tex: THREE.Texture): boolean {
    return this.registry.get(tex)?.hiRes !== undefined;
  }

  /**
   * Diagnostics for probes/tests: per kind, how many textures are
   * registered, the size histogram of their CURRENT images, the sampler
   * state they carry, and (CORE.17.h.g.c.d) how many carry a highres level
   * / draw it now.
   */
  census(): Record<TextureKind, { count: number; sizes: Record<string, number>; minFilters: number[]; magFilters: number[]; anisotropy: number[]; withHiRes: number; atHiRes: number }> {
    const out = {
      landscape: { count: 0, sizes: {} as Record<string, number>, minFilters: [] as number[], magFilters: [] as number[], anisotropy: [] as number[], withHiRes: 0, atHiRes: 0 },
      landscapeAlpha: { count: 0, sizes: {} as Record<string, number>, minFilters: [] as number[], magFilters: [] as number[], anisotropy: [] as number[], withHiRes: 0, atHiRes: 0 },
      environment: { count: 0, sizes: {} as Record<string, number>, minFilters: [] as number[], magFilters: [] as number[], anisotropy: [] as number[], withHiRes: 0, atHiRes: 0 },
    };
    for (const [tex, reg] of this.registry) {
      const o = out[reg.kind];
      const image = tex.image as unknown as RgbaImage;
      const key = `${image.width}x${image.height}`;
      o.count++;
      o.sizes[key] = (o.sizes[key] ?? 0) + 1;
      if (reg.hiRes) o.withHiRes++;
      if (reg.atHiRes) o.atHiRes++;
      if (!o.minFilters.includes(tex.minFilter)) o.minFilters.push(tex.minFilter);
      if (!o.magFilters.includes(tex.magFilter)) o.magFilters.push(tex.magFilter);
      if (!o.anisotropy.includes(tex.anisotropy)) o.anisotropy.push(tex.anisotropy);
    }
    return out;
  }

  /**
   * Re-apply the current prefs to one registered texture.
   *
   * A changed detail level needs GPU storage of a different size, and
   * three.js allocates storage (immutable `texStorage2D`) only when it
   * creates a WebGLTexture — which it keys by (Source, sampler state) and
   * deletes only once no Texture uses it. Mutating `tex.image` (= the
   * shared `Source.data`) after `dispose()` is therefore not enough when a
   * clone shares the Source (TerrainRenderer's tiled blend textures): the
   * WebGLTexture survives with its old storage, `texSubImage2D` of the new
   * image either writes a corner of it (smaller) or fails outright
   * (larger), and the world stays at the old level — live on 2026-09-11 the
   * landscape never left Very Low again. So the re-imaged texture gets a
   * NEW Source; `retargeted` (one map per `set()` pass) lets every texture
   * that shared the old Source adopt the same new one, so clones keep
   * sharing a single WebGLTexture as before.
   */
  applyTo(tex: THREE.Texture, retargeted: Map<THREE.TextureSource<unknown>, THREE.TextureSource<unknown>> = new Map()): void {
    const reg = this.registry.get(tex);
    if (!reg) return;
    let dirty = false;
    const f = samplerFilters(this.filtering, this.maxAnisotropy);
    if (tex.minFilter !== f.minFilter) { tex.minFilter = f.minFilter; dirty = true; }
    if (tex.magFilter !== f.magFilter) { tex.magFilter = f.magFilter; dirty = true; }
    if (tex.anisotropy !== f.anisotropy) { tex.anisotropy = f.anisotropy; dirty = true; }
    // CORE.17.h.g.c.d — DropUnwantedLevels: Very High + the HiFi DAT keeps
    // the highres level (drawn at scale 0, ConstructTexture sizes the D3D
    // texture at that level); any other choice, or no highres level for
    // this texture, draws the portal level at the kind's shift.
    let hiImage: RgbaImage | null = null;
    if (reg.hiRes && this.usesHighResLevel(reg.kind)) {
      if (reg.hiResImage === undefined) {
        // A streamed highres level not resident yet (or decoded without its
        // palette) is not "unavailable": draw the portal level for now and
        // ask again when the files land.
        const epoch = datMissEpoch();
        const img = reg.hiRes();
        if (noDatMissSince(epoch)) {
          reg.hiResImage = img;
        } else {
          this.hiResPending.add(tex);
          this.unsubscribeArrival ??= onDatMissResolved(() => this.retryPendingHighRes());
        }
      }
      hiImage = reg.hiResImage ?? null;
    }
    const atHiRes = hiImage !== null;
    const source = hiImage ?? reg.fullRes;
    // The bound image's palette decides SetSurface's alpha-test ref (PALETTED_IMAGES).
    tex.userData.acPaletted = isPalettedImage(source);
    // Environment: CreateD3DTexture's `size >> shift`. Landscape kinds
    // (CORE.17.h.g.c.a): the TexMerge window M — terrain images cropped to
    // min(M, S), alpha maps point-subsampled to it; never filtered.
    let state: number;
    let targetW: number;
    let targetH: number;
    let build: () => RgbaImage;
    if (reg.kind === 'environment') {
      const shift = hiImage ? 0 : this.shiftFor(reg.kind);
      state = shift;
      targetW = shiftedTextureSize(source.width, shift);
      targetH = shiftedTextureSize(source.height, shift);
      build = () => scaleRGBAForShift(source, shift);
    } else {
      const m = landscapeMergedSize(this.landscapeDetail, reg.landscape?.baseTexSize);
      state = m;
      targetW = landscapeTerrainImageSize(m, source.width);
      targetH = landscapeTerrainImageSize(m, source.height);
      build = reg.kind === 'landscape'
        ? () => cropRGBA(source, targetW, targetH)
        : () => pointSubsampleRGBA(source, targetW, targetH);
      if (reg.kind === 'landscape' && reg.landscape) {
        const rx = reg.landscape.uvCells * landscapeRepeatsPerCell(m, source.width);
        const ry = reg.landscape.uvCells * landscapeRepeatsPerCell(m, source.height);
        if (tex.repeat.x !== rx || tex.repeat.y !== ry) tex.repeat.set(rx, ry);
      }
    }
    if (state !== reg.state || atHiRes !== reg.atHiRes) {
      const image = tex.image as unknown as RgbaImage;
      // A level swap always re-images (the highres and portal images can
      // share dimensions after a shift); a pure size change re-images only
      // when the size moves.
      if (atHiRes !== reg.atHiRes || image.width !== targetW || image.height !== targetH) {
        const shared = retargeted.get(tex.source);
        const next = shared ?? new THREE.TextureSource<unknown>(build());
        if (!shared) retargeted.set(tex.source, next);
        // Release this texture's hold on the old WebGLTexture (deleted once
        // the last sharer lets go), then move to the new Source: an unseen
        // Source makes three.js create + allocate a fresh WebGLTexture at
        // the new size on the next upload.
        tex.dispose();
        tex.source = next;
        dirty = true;
      }
      reg.state = state;
      reg.atHiRes = atHiRes;
    }
    if (dirty) tex.needsUpdate = true;
  }
}

/** The one live preference set (retail: the static Render::m_RenderPrefs). */
export const textureSamplerPrefs = new TextureSamplerPrefs();
