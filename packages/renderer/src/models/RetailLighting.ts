/**
 * RetailLighting — the EoL client's world-lighting equation on three.js
 * MeshLambertMaterial (CORE.17.e).
 *
 * Ground truth (decompiled acclient, build ac1_sep13 — reference/client-eol):
 *  - `SkyDesc::GetLighting` @ 00500a80: between the two bracketing
 *    SkyTimeOfDay keyframes, lerp amb_bright / amb_color / dir_bright /
 *    dir_color; sunlight vector = dir_bright · (sin h·cos p, cos h·cos p, sin p).
 *  - `LScape` light tick (the caller of `set_landscape_lighting` @ 005054d0):
 *    ambient_level = max(level, LScape::min_ambient); `LSCAPE_LIGHT_MINIMUM`
 *    = 0.2 (acclient.exe .data @ 0x7c63e4, copied by static initializer
 *    `$E258` @ 006fa960).
 *  - `CLandBlockStruct::calc_lighting` @ 00531700 — per landscape vertex:
 *        L = clamp01( sunlight_color · max(0, N·sunlight) + ambient_color · ambient_level )
 *    written as the vertex diffuse that D3D modulates the terrain texel with.
 *  - `SmartBox::SetWorldAmbientLight` @ 004530a0, called from
 *    `set_landscape_lighting` with `|sunlight| · 0.2 + ambient_level`
 *    (= `LScape::calc_object_light` @ 00455730): every non-landscape object
 *    is lit with ambient = ambient_color · (ambient_level + 0.2·dir_bright)
 *    plus one D3DLIGHT_DIRECTIONAL whose Diffuse = sunlight_color · |sunlight|
 *    (`PrimD3DRender::UpdateLightsInternal` @ 0059aed0) — the same clamp01(Σ).
 *
 * Stock three.js Lambert (r160 through r186) differs from that in two ways, and together they
 * are why night looked like day (the gestalt audit measured terrain keeping
 * ~78% of its daytime luminance under a black sky):
 *  1. The light sum is divided by PI (BRDF_Lambert). DAT brightness values
 *     (0.8 sun + 0.35 ambient at noon) came out ~3x too dark, and the scene
 *     had been propped up with undriven white fill lights that never dimmed.
 *  2. Lighting happens in LINEAR space (sRGB texels are decoded before the
 *     multiply and re-encoded after). D3D8 multiplied the 8-bit texel by the
 *     light in gamma space: a 0.40 light takes a texel to 40% of its value,
 *     not to 0.40^(1/2.2) = 66%.
 *
 * The `onBeforeCompile` patch keeps all of three.js's light bookkeeping
 * (light uniforms, point-light attenuation, per-material maps) and replaces
 * only the shading equation: Σ light without the 1/PI BRDF, clamped per
 * channel, multiplied against the texel in sRGB space, converted back to
 * linear so the rest of the pipeline is untouched. Fog is applied by three.js
 * AFTER the output encode (gamma space), exactly where D3D8 blended it.
 *
 * CORE.17.q.a — the equation is evaluated PER VERTEX (Gouraud), as the
 * fixed-function pipeline did, not per fragment as three.js r155+ Lambert does.
 * Retail lit three ways, all per vertex and all clamped to [0,1] before the
 * texture stage (stage 0 is a plain `TEXOP_MODULATE(texture, diffuse)` —
 * `D3DPolyRender::SetSurface` @ 0059c8b0.., decomp :399056 — no 2X headroom):
 *  - landscape: `CLandBlockStruct::calc_lighting` (sun + ambient, above);
 *  - objects (and buildings, `RenderDeviceD3D::DrawMeshInternal` @ 0059f360 →
 *    `Render::minimize_object_lighting` @ 0054d480): up to 8 D3D hardware
 *    lights — `PrimD3DRender::config_hardware_light` @ 0059ad30 programs
 *    Diffuse = colour · intensity, Range = falloff · rangeAdjust (1.5),
 *    Attenuation (0, 1, 0) = 1/d; D3D adds Diffuse · max(0, N·L) / d for every
 *    vertex inside Range and nothing beyond it (a hard cutoff, not three.js's
 *    smooth `pow2(1 − (d/R)^4)` window);
 *  - env cells (`RenderDeviceD3D::DrawEnvCell` @ 0059f170): the pooled STATIC
 *    lights are burned into the vertex diffuse by
 *    `D3DPolyRender::SetStaticLightingVertexColors` @ 0059cfe0 →
 *    `calc_point_light` @ 0059c8b0 (below) and fed to the pipeline as the
 *    EMISSIVE source (`SetFFEmissiveColorSource(FromVertex)` in
 *    `RenderMeshSubset` @ 0059ca10); the DYNAMIC lights (the viewer light,
 *    creature-carried lights) reach the cell through the hardware path
 *    (`Render::minimize_envcell_lighting` @ 0054c170 enables every dynamic
 *    light and no static one).
 * A vertex inside a torch's range with intensity 100 still saturates, but the
 * polygon interpolates linearly to its unlit neighbours — the soft warm pools
 * of rawg_04.jpg that per-fragment evaluation flattened into a uniform clamp.
 */
import * as THREE from 'three';
import {
  applySamplerBias, markSamplerBias, patchSamplerBias, mipBiasUniform, MIP_BIAS_UNIFORM, SAMPLER_BIAS_CACHE_KEY,
} from './TextureSamplerPrefs.js';
import {
  detailTexturing, markDetail, patchDetailFragment, patchDetailVertex, RETAIL_OUTGOING_LINE,
  DETAIL_MAP_UNIFORM, DETAIL_TILING_UNIFORM, DETAIL_ON_UNIFORM, DETAIL_CACHE_KEY, type DetailKind,
} from './DetailTexturing.js';

/** `LScape::min_ambient` — the floor on the DAT ambient level. */
export const LSCAPE_LIGHT_MINIMUM = 0.2;

/** `LScape::calc_object_light`: objects add this fraction of |sunlight| to ambient. */
export const RETAIL_OBJECT_AMBIENT_SUN_FRACTION = 0.2;

/**
 * CORE.17.q.d — the SEALED-cell world ambient is a constant.
 * `CellManager::ChangePosition` @ 004559b0 (on a cell change only — the
 * function returns early while `load_pos.objcell_id` is unchanged): an
 * outdoor cell or a `seen_outside` interior copies `LScape::sunlight` into
 * `Render::world_lights` and calls `SmartBox::SetWorldAmbientLight(
 * LScape::calc_object_light(), LScape::ambient_color)`; a sealed cell first
 * `LScape::release_all`s the landscape (`loaded_cell_id = 0`,
 * `GameSky::SetInactive`) and calls `SetWorldAmbientLight(
 * DUNGEON_LIGHT_MINIMUM, 0xffffffff)` — exe bytes at 0x455aeb
 * `mov edx,[0x79b7fc]; push 0xffffffff; push edx; call 0x4530a0`, the float
 * at .rdata 0x79b7fc = 0.2f. `SetWorldAmbientLight` @ 004530a0 stores
 * `Render::world_lights.ambient_color = RGBColor(colour) · level`, so the
 * dungeon ambient is white 0.2 — for env cells AND the objects in them (the
 * object factor `calc_object_light` is never applied underground).
 *
 * The constant is never overwritten while the viewer stays sealed:
 * `LScape::UseTime` @ 00505880 — the ONLY caller of `set_landscape_lighting`
 * (the light tick) and of the D3D fog-state setters — is gated by
 * `this->loaded_cell_id != 0`, and only `LScape::update_loadpoint` (an
 * outdoor cell: `CellManager::UpdateLoadPoint` @ 00455710 checks
 * `(objcell_id & 0xffff) < 0x100`; the `seen_outside` arm of ChangePosition
 * passes `Position::get_outside_cell_id`) sets it again. So the sun, the
 * ambient and the fog state all FREEZE at their last outdoor tick while the
 * player is in a sealed dungeon, and the next tick after leaving re-lights.
 */
export const DUNGEON_LIGHT_MINIMUM = 0.2;

/** The `SetWorldAmbientLight` colour argument of the sealed-cell arm: white. */
export const DUNGEON_AMBIENT_COLOR = 0xffffffff;

/**
 * CORE.17.q — point/spot light range. `PrimD3DRender::config_hardware_light`
 * @ 0059ad30: `D3DLIGHT.Range = LIGHTINFO.falloff * rangeAdjust`,
 * `Diffuse = color * intensity`, attenuation (0, 1, 0) = 1/d. `rangeAdjust`
 * is acclient.exe .data @ 0x820cc4 = 1.5f (fmul operand at 0059add2).
 */
export const RETAIL_LIGHT_RANGE_ADJUST = 1.5;

/** `F_EPSILON` (0.0002): the slack in `Render::minimize_object_lighting`'s light-reach test. */
export const RETAIL_F_EPSILON = 0.0002;

/**
 * VISUAL.dungeon-lighting-saturation — the `cellobject` uniform holding the
 * drawn part's DAT drawing sphere (local centre xyz, radius w; w < 0 = no
 * sphere known, every light reaches). Filled per draw from
 * `geometry.userData[DRAWING_SPHERE_KEY]` (ModelRenderer.createMesh).
 */
export const PART_SPHERE_UNIFORM = 'acPartSphere';
/** geometry.userData key: the GfxObj drawing-BSP root sphere, three axes, [x, y, z, r]. */
export const DRAWING_SPHERE_KEY = 'acDrawingSphere';

/**
 * `ambientBoostFactor` (.data @ 0x820cc8 = 1.0f, fmul operand at 0059aeda):
 * `PrimD3DRender::UpdateLightsInternal` multiplies the world ambient by it
 * before SetFFAmbientColor32. Unity at EoL — recorded so the equation is
 * complete, applied nowhere.
 */
export const RETAIL_AMBIENT_BOOST = 1.0;

/** three.js PointLight `distance` for a DAT LightInfo falloff. */
export function retailLightRange(falloff: number): number {
  return falloff * RETAIL_LIGHT_RANGE_ADJUST;
}

/**
 * A DAT _RGB light colour as the retail engine used it: the raw bytes / 255
 * become the D3D light Diffuse (`Render::insert_light` @ 0054d1b0 stores
 * `byte * 1/255`; `config_hardware_light` multiplies by intensity), and the
 * fixed-function pipeline multiplies that against the texel in gamma space.
 * So the bytes go in as the WORKING (linear) values — the same convention
 * SkyboxRenderer's argbToColor uses for the sun/ambient — not through
 * three.js's sRGB→linear hex decode, which would darken a (c8,96,64) torch to
 * (0.58,0.31,0.13) before the retail patch multiplies it in gamma space.
 */
export function rawByteColor(argb: number): THREE.Color {
  return new THREE.Color(((argb >> 16) & 0xff) / 255, ((argb >> 8) & 0xff) / 255, (argb & 0xff) / 255);
}

/**
 * CORE.17.q.a — `calc_point_light` @ 0059c8b0, the per-vertex static-light
 * term retail burns into env-cell vertex colours (`SetStaticLightingVertexColors`
 * @ 0059cfe0 loops it over `Render::world_lights.sorted_static_lights`):
 *
 *     D = light.origin − vertex;  d = |D|;  range = falloff · static_light_factor
 *     if d < range:
 *       wrap = ( N·D / d + (2·LIGHT_POINT_RANGE − 1) ) / (2·LIGHT_POINT_RANGE)
 *       if wrap > 0:
 *         f = (1 − d / range) · intensity · wrap · ( d > 1 ? 1 / d² : 1 )
 *         sum += min( colour, f · colour )        (per channel)
 *     sum clamped to [0,1] per channel, stored as the vertex diffuse.
 *
 * `static_light_factor` = acclient.exe .data @ 0x820e24 = 1.3f (fmul operand at
 * 0059c901; no runtime writer in the decomp), `LIGHT_POINT_RANGE` = .rdata @
 * 0x7e5430 = 0.75f (fld at 0059c927). So the static range is falloff × 1.3
 * (shorter than the hardware Range of falloff × 1.5), the N·L is WRAPPED —
 * (cos θ + 0.5) / 1.5, a vertex facing 90° away from the torch still takes a
 * third — and the falloff is a linear window times 1/d² beyond one metre,
 * capped at the raw colour.
 */
export const RETAIL_STATIC_LIGHT_FACTOR = 1.3;

/** `LIGHT_POINT_RANGE` (.rdata @ 0x7e5430) — the wrap constant of calc_point_light. */
export const RETAIL_LIGHT_POINT_RANGE = 0.75;

/**
 * The light-class channel. three.js uploads `PointLight.decay` verbatim into
 * the light uniform and the retail patch never uses it as an exponent, so a
 * DAT static light (a cell stab's LightInfo — `state & 1`, the burned-in list)
 * carries `decay = −intensity`: the sign says "static", the magnitude lets the
 * env-cell shader recover the raw colour from three.js's colour × intensity
 * uniform. Hardware lights (the viewer light, effect lights) keep decay ≥ 0.
 */
export function retailStaticLightDecay(intensity: number): number {
  return -Math.abs(intensity);
}

export function isRetailStaticLightDecay(decay: number): boolean {
  return decay < 0;
}

/** The env-cell static range as a fraction of the three.js `distance` (= the hardware Range). */
export const RETAIL_STATIC_RANGE_SCALE = RETAIL_STATIC_LIGHT_FACTOR / RETAIL_LIGHT_RANGE_ADJUST;

/**
 * The four lighting sets retail drew with, keyed by WHAT is drawn — the
 * `Render::useSunlightSet` state is a property of the draw pass, and every
 * draw pass is decided by the geometry class (CORE.17.q.b):
 *
 *  - `landscape` — `LScape::draw` under `useSunlightSet(1)`: sun + ambient
 *    per vertex (`CLandBlockStruct::calc_lighting`), no point lights.
 *  - `object` — everything else in the landscape pass (`RenderDeviceD3D::
 *    DrawBlock` @ 005a17c0 → the land cells' objects, `DrawBuilding` @
 *    0059f2a0): the sun is the ONLY active hardware light
 *    (`useSunlightSet` @ 0054d450 → `add_active_light(-1, 0)`), and
 *    `DrawMeshInternal` @ 0059f360 runs `minimize_object_lighting` only
 *    when `useSunlight == 0` — so an outdoor object takes no pool light.
 *  - `envcell` — cell geometry, always drawn by `PView::DrawCells` @
 *    005a4840 after `useSunlightSet(0)` + `restore_all_lighting`: no sun;
 *    static DAT lights through calc_point_light, dynamic through the
 *    hardware path.
 *  - `cellobject` — the objects INSIDE env cells (`DrawCells` draws each
 *    cell's objects through `DrawObjCell` @ 005a1a40 in the same
 *    `useSunlightSet(0)` span): no sun; the pool lights through the
 *    hardware path (`minimize_object_lighting` @ 0054d480).
 *
 * `DrawCells` runs for BOTH viewer cases — `PView::DrawInside` @ 005a5860
 * when the viewer is in a cell (`SmartBox::RenderNormalMode` @ 00453aa0,
 * device slot +0x48) and `PView::DrawPortal` @ 005a5ab0 when an outdoor
 * viewer looks through a building portal (the LScape pass draws the portal
 * polygon, constructs the view and calls `DrawCells(this, 1)`). So a
 * SeenOutside cottage interior and the furniture / creatures / player in
 * it never see the sun, from inside or from the street.
 */
export type RetailLightingKind = 'landscape' | 'object' | 'envcell' | 'cellobject' | 'sky';

/** The kinds drawn inside `PView::DrawCells`'s `useSunlightSet(0)` span. */
export function isCellLightingKind(kind: RetailLightingKind): boolean {
  return kind === 'envcell' || kind === 'cellobject';
}

/** Program cache key prefix; the kind is appended (landscape GLSL differs — see AC_LANDSCAPE). */
export const RETAIL_LIGHTING_CACHE_KEY = 'acRetailLighting';

export function retailLightingCacheKey(kind: RetailLightingKind): string {
  return `${RETAIL_LIGHTING_CACHE_KEY}:${kind}`;
}

/**
 * Shared uniforms. `object` materials multiply the scene ambient (which
 * carries the LANDSCAPE value, `ambient_color · ambient_level`) by
 * `(ambient_level + 0.2·dir_bright) / ambient_level`; landscape stays at 1.
 * One object per kind, mutated in place, so a single per-frame update
 * reaches every compiled material.
 */
const objectAmbientScale = { value: 1.0 };
const landscapeAmbientScale = { value: 1.0 };

/** Materials that carry the patch, by kind (a WeakMap, not userData:
 *  `Material.clone()` copies userData but NOT onBeforeCompile, so a clone
 *  must be re-patched). */
const patched = new WeakMap<THREE.Material, RetailLightingKind>();

export function retailObjectAmbientScale(dirBright: number, ambLevel: number): number {
  if (!(ambLevel > 0)) return 1.0;
  return (ambLevel + RETAIL_OBJECT_AMBIENT_SUN_FRACTION * dirBright) / ambLevel;
}

/** Per light tick: publish the DAT-derived levels to the object materials. */
export function setRetailLightLevels(dirBright: number, ambLevel: number): void {
  objectAmbientScale.value = retailObjectAmbientScale(dirBright, ambLevel);
}

export function currentObjectAmbientScale(): number {
  return objectAmbientScale.value;
}

export function isRetailLit(material: THREE.Material): boolean {
  return patched.has(material);
}

/** The kind a material was patched with (undefined = not retail-lit). */
export function retailLightingKindOf(material: THREE.Material): RetailLightingKind | undefined {
  return patched.get(material);
}

/**
 * Carry a material's retail-lighting patch (onBeforeCompile chain, program
 * cache key, kind registration) onto a copy: three's Material.clone() drops
 * onBeforeCompile, so a cloned lit material would draw plain Lambert.
 */
export function inheritRetailLighting(src: THREE.Material, dst: THREE.Material): void {
  dst.onBeforeCompile = src.onBeforeCompile;
  dst.customProgramCacheKey = src.customProgramCacheKey;
  const kind = patched.get(src);
  if (kind) { patched.set(dst, kind); markSamplerBias(dst); }
  dst.needsUpdate = true;
}

// ── Pure-JS mirror of the retail equation (tests, diagnostics) ────────────

export type Rgb = [number, number, number];

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * `CLandBlockStruct::calc_lighting` for one vertex. `sunlight` is the
 * dir_bright-scaled vector from GetLighting (so its length is dir_bright).
 */
export function retailLightSum(
  normal: Rgb,
  sunlight: Rgb,
  sunColor: Rgb,
  ambColor: Rgb,
  ambLevel: number,
): Rgb {
  const ndotl = Math.max(0, normal[0] * sunlight[0] + normal[1] * sunlight[1] + normal[2] * sunlight[2]);
  return [
    clamp01(sunColor[0] * ndotl + ambColor[0] * ambLevel),
    clamp01(sunColor[1] * ndotl + ambColor[1] * ambLevel),
    clamp01(sunColor[2] * ndotl + ambColor[2] * ambLevel),
  ];
}

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** D3D8 modulate: texel (sRGB bytes/255) × light, in gamma space → the displayed sRGB value. */
export function retailShade(texelSrgb: Rgb, light: Rgb): Rgb {
  return [texelSrgb[0] * light[0], texelSrgb[1] * light[1], texelSrgb[2] * light[2]];
}

/**
 * CORE.17.q.a — one D3D fixed-function point light at one vertex
 * (`config_hardware_light`: Diffuse = colour · intensity, Range = falloff ·
 * rangeAdjust, attenuation 1/d, nothing beyond Range). `colour` is the raw
 * DAT bytes / 255; positions in any common frame.
 */
export function retailHardwarePointLight(
  vertex: Rgb, normal: Rgb, lightPos: Rgb, colour: Rgb, intensity: number, falloff: number,
): Rgb {
  const dx = lightPos[0] - vertex[0], dy = lightPos[1] - vertex[1], dz = lightPos[2] - vertex[2];
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(d < retailLightRange(falloff)) || d <= 0) return [0, 0, 0];
  const ndotl = Math.max(0, (normal[0] * dx + normal[1] * dy + normal[2] * dz) / d);
  const f = intensity * ndotl / d;
  return [colour[0] * f, colour[1] * f, colour[2] * f];
}

/**
 * CORE.17.q.a — `calc_point_light` @ 0059c8b0 for one static light at one
 * env-cell vertex (see RETAIL_STATIC_LIGHT_FACTOR). Returns the per-channel
 * contribution before the caller's clamp01 of the running sum.
 */
export function retailStaticPointLight(
  vertex: Rgb, normal: Rgb, lightPos: Rgb, colour: Rgb, intensity: number, falloff: number,
): Rgb {
  const dx = lightPos[0] - vertex[0], dy = lightPos[1] - vertex[1], dz = lightPos[2] - vertex[2];
  const d2 = dx * dx + dy * dy + dz * dz;
  const d = Math.sqrt(d2);
  const range = falloff * RETAIL_STATIC_LIGHT_FACTOR;
  if (!(d < range) || d <= 0) return [0, 0, 0];
  const twoLpr = 2 * RETAIL_LIGHT_POINT_RANGE;
  const wrap = ((normal[0] * dx + normal[1] * dy + normal[2] * dz) / d + (twoLpr - 1)) / twoLpr;
  if (!(wrap > 0)) return [0, 0, 0];
  const f = (1 - d / range) * intensity * wrap / (d2 > 1 ? d2 : 1);
  return [
    Math.min(colour[0], f * colour[0]),
    Math.min(colour[1], f * colour[1]),
    Math.min(colour[2], f * colour[2]),
  ];
}

// ── GLSL patch ────────────────────────────────────────────────────────────

/** Landscape materials compile with this define and skip point lights. */
export const LANDSCAPE_DEFINE = 'AC_LANDSCAPE';
/** Env-cell materials compile with this define: static DAT lights take calc_point_light. */
export const ENVCELL_DEFINE = 'AC_ENVCELL';
/** Objects inside env cells compile with this define: no sun, the pool lights through the hardware path. */
export const CELLOBJECT_DEFINE = 'AC_CELLOBJECT';
/**
 * VISUAL.night-sky-vs-retail — GameSky's sky objects compile with this define.
 * `D3DPolyRender::RenderMeshSubset` @ 0059ca10 forces `SetFFLighting(true)`
 * while `GameSky::Draw` @ 00506ff0 holds the sky-draw flag, so a sky object is
 * lit like any object (the world ambient + the sun), with its OWN D3D material:
 * `CMaterial::CMaterial` @ 00539770 starts Ambient = Diffuse = 1, Emissive = 0;
 * `GameSky::UseTime` @ 005075b0 sets Emissive (`SetLuminositySimple`) and
 * Diffuse (`SetDiffuseSimple`) from the SkyObjectReplace luminosity/max_bright.
 * Diffuse scales the sun term only (the ambient term stays × material Ambient
 * 1), so the sky kind carries that factor as a per-material uniform.
 */
export const SKY_DEFINE = 'AC_SKY';
/** The per-material D3D material Diffuse of a sky object (`SetDiffusion`). */
export const SKY_DIFFUSE_UNIFORM = 'acSkyDiffuse';
/** The Gouraud varying: the clamped D3D vertex diffuse. */
export const LIGHT_VARYING = 'vAcLight';
/** The back copy's Gouraud varying (RENDER.sidestype1-backface-lighting): the sum for −N. */
export const LIGHT_VARYING_BACK = 'vAcLightBack';
/**
 * A double-sided material whose back faces keep the FRONT normal's light: a
 * single-sided polygon drawn unculled (D3D CULL_NONE, one copy), e.g. the
 * portal-space tunnel's SidesType 0 faces seen from inside. Set it in
 * `material.defines` (part of three's program cache key).
 */
export const CULL_NONE_DEFINE = 'AC_CULL_NONE';
/**
 * RENDER.sidestype1-backface-lighting — `D3DPolyRender::ConstructMesh` @
 * 0059dfa0 gives a SidesType 1 (CullMode.None) polygon a second copy: its
 * vertices go through `copyVert(..., -1)` (the normal × −1) with the winding
 * reversed (`2 - i`), both copies culled CW. The two copies are lit
 * separately, so the face seen from behind takes the light of −N. We draw the
 * one triangle with THREE.DoubleSide (no extra geometry) and sum the lights
 * for both normals; the fragment picks by gl_FrontFacing. Not the landscape
 * (one copy) and not CULL_NONE_DEFINE materials.
 */
const GLSL_BACK_LIGHT = `( defined( DOUBLE_SIDED ) && !defined( ${LANDSCAPE_DEFINE} ) && !defined( ${CULL_NONE_DEFINE} ) )`;

const KIND_DEFINE: Record<RetailLightingKind, string> = {
  landscape: `#define ${LANDSCAPE_DEFINE}\n`,
  object: '',
  envcell: `#define ${ENVCELL_DEFINE}\n`,
  cellobject: `#define ${CELLOBJECT_DEFINE}\n`,
  sky: `#define ${SKY_DEFINE}\n`,
};

/** GLSL: true for the kinds `PView::DrawCells` draws under `useSunlightSet(0)`. */
export const GLSL_IN_CELL = `( defined( ${ENVCELL_DEFINE} ) || defined( ${CELLOBJECT_DEFINE} ) )`;
/** The sun loop's guard: the landscape pass only (`useSunlightSet(1)`). */
export const GLSL_SUN_GUARD = `#if ( NUM_DIR_LIGHTS > 0 ) && !${GLSL_IN_CELL}`;
/** The point-light loop's guard: the cell pass only (`useSunlightSet(0)` — the pool lights). */
export const GLSL_POINT_GUARD = `#if ( NUM_POINT_LIGHTS > 0 ) && ${GLSL_IN_CELL}`;

const glslFloat = (v: number): string => (Number.isInteger(v) ? `${v}.0` : `${v}`);

/**
 * Vertex-stage declarations: the light uniforms under three.js's own names
 * and member layout (WebGLLights uploads by name — `ambientLightColor`,
 * `directionalLights[i].direction/color`, `pointLights[i].position/color/
 * distance/decay`, all in VIEW space), the ambient scale and the varying.
 * `NUM_DIR_LIGHTS` / `NUM_POINT_LIGHTS` are replaced by WebGLProgram in both
 * stages (replaceLightNums), and `#pragma unroll_loop` is expanded there too.
 */
const GLSL_VERTEX_PARS = `uniform float acAmbientScale;
varying vec3 ${LIGHT_VARYING};
#if ${GLSL_BACK_LIGHT}
	#define AC_BACK_LIGHT
	varying vec3 ${LIGHT_VARYING_BACK};
#endif
#ifdef ${SKY_DEFINE}
	uniform float ${SKY_DIFFUSE_UNIFORM};
	#define AC_SUN_DIFFUSE ${SKY_DIFFUSE_UNIFORM}
#else
	#define AC_SUN_DIFFUSE 1.0
#endif
uniform vec3 ambientLightColor;
#if NUM_DIR_LIGHTS > 0
	struct DirectionalLight {
		vec3 direction;
		vec3 color;
	};
	uniform DirectionalLight directionalLights[ NUM_DIR_LIGHTS ];
#endif
#if NUM_POINT_LIGHTS > 0
	struct PointLight {
		vec3 position;
		vec3 color;
		float distance;
		float decay;
	};
	uniform PointLight pointLights[ NUM_POINT_LIGHTS ];
	#ifdef ${CELLOBJECT_DEFINE}
	// Render::minimize_object_lighting @ 0054d480: a point light reaches a part only when
	// |light − centre|² − ( falloff + radius )² < F_EPSILON, centre/radius = the part's
	// drawing sphere (viewconeCheck: local_object_radius = object_scale · radius).
	uniform vec4 ${PART_SPHERE_UNIFORM};
	bool acPartLit( const in PointLight light, const in vec3 c, const in float r ) {
		if ( r < 0.0 ) return true;
		float falloff = light.distance / ${glslFloat(RETAIL_LIGHT_RANGE_ADJUST)};
		vec3 dc = light.position - c;
		return dot( dc, dc ) - ( falloff + r ) * ( falloff + r ) < ${glslFloat(RETAIL_F_EPSILON)};
	}
	#endif
	vec3 acPointLight( const in PointLight light, const in vec3 p, const in vec3 n ) {
		vec3 lv = light.position - p;
		float d = max( length( lv ), 1e-4 );
		// D3DLIGHT9.Range / calc_point_light: nothing beyond the range — a hard cutoff.
		if ( d >= light.distance ) return vec3( 0.0 );
		#ifdef ${ENVCELL_DEFINE}
		if ( light.decay < 0.0 ) {
			// D3DPolyRender::SetStaticLightingVertexColors -> calc_point_light @ 0059c8b0
			float intensity = - light.decay;
			float range = light.distance * ${glslFloat(RETAIL_STATIC_RANGE_SCALE)};
			if ( d >= range ) return vec3( 0.0 );
			float wrap = ( dot( n, lv ) / d + ${glslFloat(2 * RETAIL_LIGHT_POINT_RANGE - 1)} ) / ${glslFloat(2 * RETAIL_LIGHT_POINT_RANGE)};
			if ( wrap <= 0.0 ) return vec3( 0.0 );
			float f = ( 1.0 - d / range ) * intensity * wrap / ( d > 1.0 ? d * d : 1.0 );
			return ( light.color / intensity ) * min( f, 1.0 );
		}
		#endif
		// PrimD3DRender::config_hardware_light: Diffuse * max( 0, N.L ) * 1 / ( 0 + 1 * d + 0 * d * d )
		return light.color * saturate( dot( n, lv ) / d ) / d;
	}
#endif
`;

/** The per-vertex sum, inserted after project_vertex (mvPosition + transformedNormal exist). */
const GLSL_VERTEX_SUM = `
	vec3 acN = normalize( transformedNormal );
	vec3 acSum = ambientLightColor * acAmbientScale;
	#ifdef AC_BACK_LIGHT
	vec3 acSumBack = acSum;
	#endif
	// CORE.17.q.b — the sun is active only in the landscape pass (useSunlightSet(1)):
	// PView::DrawCells draws every env cell and the objects in it under useSunlightSet(0).
	${GLSL_SUN_GUARD}
		#pragma unroll_loop_start
		for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {
			acSum += AC_SUN_DIFFUSE * directionalLights[ i ].color * saturate( dot( acN, directionalLights[ i ].direction ) );
			#ifdef AC_BACK_LIGHT
			acSumBack += AC_SUN_DIFFUSE * directionalLights[ i ].color * saturate( dot( - acN, directionalLights[ i ].direction ) );
			#endif
		}
		#pragma unroll_loop_end
	#endif
	// … and the pool lights reach only that useSunlightSet(0) span: DrawMeshInternal runs
	// minimize_object_lighting when useSunlight == 0, the landscape pass has the sun alone.
	${GLSL_POINT_GUARD}
		#ifdef ${CELLOBJECT_DEFINE}
		// The part's drawing sphere in view space (through the instance matrix when batched).
		vec4 acPartC = vec4( ${PART_SPHERE_UNIFORM}.xyz, 1.0 );
		float acPartScale = length( modelMatrix[ 0 ].xyz );
		#ifdef USE_INSTANCING
		acPartC = instanceMatrix * acPartC;
		acPartScale *= length( instanceMatrix[ 0 ].xyz );
		#endif
		acPartC = modelViewMatrix * acPartC;
		float acPartR = ${PART_SPHERE_UNIFORM}.w < 0.0 ? -1.0 : ${PART_SPHERE_UNIFORM}.w * acPartScale;
		#endif
		#pragma unroll_loop_start
		for ( int i = 0; i < NUM_POINT_LIGHTS; i ++ ) {
			#ifdef ${CELLOBJECT_DEFINE}
			if ( acPartLit( pointLights[ i ], acPartC.xyz, acPartR ) )
			#endif
			{
				acSum += acPointLight( pointLights[ i ], mvPosition.xyz, acN );
				#ifdef AC_BACK_LIGHT
				acSumBack += acPointLight( pointLights[ i ], mvPosition.xyz, - acN );
				#endif
			}
		}
		#pragma unroll_loop_end
	#endif
	${LIGHT_VARYING} = clamp( acSum, 0.0, 1.0 );
	#ifdef AC_BACK_LIGHT
	${LIGHT_VARYING_BACK} = clamp( acSumBack, 0.0, 1.0 );
	#endif`;

const GLSL_FRAGMENT_PARS = `varying vec3 ${LIGHT_VARYING};
#if ${GLSL_BACK_LIGHT}
	varying vec3 ${LIGHT_VARYING_BACK};
	#define AC_VERTEX_LIGHT ( gl_FrontFacing ? ${LIGHT_VARYING} : ${LIGHT_VARYING_BACK} )
#else
	#define AC_VERTEX_LIGHT ${LIGHT_VARYING}
#endif
vec3 acSRGBToLinear( in vec3 c ) {
	return mix( c / 12.92, pow( ( c + 0.055 ) / 1.055, vec3( 2.4 ) ), step( 0.04045, c ) );
}
`;

const VERTEX_COMMON_INCLUDE = '#include <common>';
const VERTEX_PROJECT_INCLUDE = '#include <project_vertex>';
const VERTEX_NORMAL_INCLUDE = '#include <defaultnormal_vertex>';
/** Lambert / Phong declare it; MeshBasic does not (its normal chunks are env-map-gated). */
const VERTEX_VIEWPOS_DECL = 'varying vec3 vViewPosition;';
const OUTGOING_LINE = 'vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;';
/** The fragment-stage light machinery the Gouraud path replaces (meshlambert.glsl.js; anchors unchanged r160 → r186). */
const FRAGMENT_LIGHT_INCLUDES = [
  '#include <lights_pars_begin>',
  '#include <lights_lambert_fragment>',
  '#include <lights_fragment_begin>',
  '#include <lights_fragment_maps>',
  '#include <lights_fragment_end>',
];
/** The clamped vertex colour + the emissive term, as the fragment sees it. */
export const RETAIL_LIGHT_LINE = 'vec3 acLight = clamp( AC_VERTEX_LIGHT + totalEmissiveRadiance, 0.0, 1.0 );';

/**
 * Rewrite a MeshLambertMaterial VERTEX shader to sum the retail lights per
 * vertex into the varying. Throws if the three.js (r186) anchors are gone — a silent
 * fall-through would leave the fragment reading an unset varying (black).
 */
export function patchLambertVertex(vertexShader: string, kind: RetailLightingKind = 'object'): string {
  if (!vertexShader.includes(VERTEX_COMMON_INCLUDE) || !vertexShader.includes(VERTEX_NORMAL_INCLUDE)
    || !vertexShader.includes(VERTEX_PROJECT_INCLUDE) || !vertexShader.includes(VERTEX_VIEWPOS_DECL)) {
    throw new Error('RetailLighting: not a MeshLambertMaterial vertex shader (missing common/defaultnormal/project/vViewPosition anchors)');
  }
  return KIND_DEFINE[kind] + vertexShader
    .replace(VERTEX_COMMON_INCLUDE, `${VERTEX_COMMON_INCLUDE}\n${GLSL_VERTEX_PARS}`)
    .replace(VERTEX_PROJECT_INCLUDE, `${VERTEX_PROJECT_INCLUDE}${GLSL_VERTEX_SUM}`);
}

/**
 * Rewrite a MeshLambertMaterial FRAGMENT shader to the retail equation: the
 * per-fragment light loops go (the sum arrives in the varying), the clamped
 * vertex colour + emissive multiplies the texel in sRGB space, converted back
 * to linear so the rest of the pipeline is untouched. Throws if three.js's
 * chunks no longer have the anchors — a silent fall-through here would
 * quietly bring the /PI-linear per-fragment model back.
 *
 * CORE.17.q / CORE.17.q.b — the kind decides the light set (in the vertex
 * stage): `landscape` and `object` are the `useSunlightSet(1)` pass (the sun
 * is the only active D3D light — `SmartBox::RenderNormalMode` @ 00453aa0 /
 * `PView::DrawCells`' portal landscape pass), `envcell` and `cellobject` are
 * the `useSunlightSet(0)` span of `PView::DrawCells` @ 005a4840 (no sun; the
 * world's point lights — DAT static lights, the viewer light — through
 * `Render::minimize_object_lighting` @ 0054d480 / the burned-in
 * `calc_point_light`).
 */
export function patchLambertFragment(fragmentShader: string, kind: RetailLightingKind = 'object'): string {
  for (const inc of FRAGMENT_LIGHT_INCLUDES) {
    if (!fragmentShader.includes(inc)) {
      throw new Error(`RetailLighting: not a MeshLambertMaterial fragment shader (missing ${inc} anchor)`);
    }
  }
  if (!fragmentShader.includes(OUTGOING_LINE)) {
    throw new Error('RetailLighting: not a MeshLambertMaterial fragment shader (missing outgoingLight anchor)');
  }
  // CORE.17.k.b.b.a.g.b — the emissive term is part of the D3D vertex colour
  // (D3DMATERIAL9.Emissive, `CMaterial::SetLuminositySimple`): it is summed
  // with the lights, clamped, and MODULATEs the texel — it is not added after
  // the texel multiply as stock three.js does. A luminosity of 0.99 (the
  // retail selection blink) renders the object at its raw texel brightness.
  const outgoing = [
    RETAIL_LIGHT_LINE,
    '\tvec3 acTexel = sRGBTransferOETF( vec4( diffuseColor.rgb, 1.0 ) ).rgb;',
    RETAIL_OUTGOING_LINE,
  ].join('\n');
  let out = fragmentShader;
  // lights_lambert_pars_fragment stays: it declares vViewPosition, which
  // normal_fragment_begin's flat-shading / tangent-frame paths still read.
  for (const inc of FRAGMENT_LIGHT_INCLUDES) out = out.replace(inc, '');
  return KIND_DEFINE[kind] + GLSL_FRAGMENT_PARS + out.replace(OUTGOING_LINE, outgoing);
}

/**
 * Install the retail shading equation on a MeshLambertMaterial. Other
 * material classes keep their own shading but still take the world sampler
 * prefs (CORE.17.h.g.c — `applySamplerBias`, the Sharp-mode mip LOD bias the
 * retail device programs on every sampler). Idempotent per material
 * instance; a `clone()` must be re-applied (three.js drops onBeforeCompile
 * on copy).
 *
 * CORE.17.h.g.c.b — `detail` folds retail's Environment Detail Textures
 * second draw into the same program (building shells / env-cell walls only:
 * `RenderDeviceD3D::DrawBuilding` / `DrawEnvCell` set
 * `Render::curr_detail_surface` around those draws alone). The material
 * shares the kind's uniform set, so the Config toggle and the region's
 * surface reach it without a recompile.
 */
export function applyRetailLighting<T extends THREE.Material>(material: T, kind: RetailLightingKind, detail?: DetailKind): T {
  // PERF (2026-09-30): three draws a transparent DoubleSide material in two
  // passes (back faces, then front), setting needsUpdate before each, which
  // re-runs the whole program lookup (getParameters / getProgramCacheKey)
  // twice per object per frame — 16,920 bumps a second at Holtburg from the
  // terrain blend overlays and particle quads. Retail draws a cull-none
  // surface once (D3D CULL_NONE, after the opaque pass), so single-pass is
  // also the faithful draw.
  material.forceSinglePass = true;
  if (!(material instanceof THREE.MeshLambertMaterial)) return applySamplerBias(material);
  if (patched.has(material)) return material;
  // Objects and cells share SmartBox::SetWorldAmbientLight's calc_object_light level
  // (CellManager::ChangePosition sets it for outdoor and seen_outside cells alike).
  const scale = kind === 'landscape' ? landscapeAmbientScale : objectAmbientScale;
  const detailUniforms = detail ? detailTexturing.uniformsFor(detail) : null;
  const skyDiffuse = kind === 'sky' ? skyDiffuseUniform(material) : null;
  const partSphere = kind === 'cellobject' ? installPartSphere(material) : null;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.acAmbientScale = scale;
    if (partSphere) shader.uniforms[PART_SPHERE_UNIFORM] = partSphere;
    if (skyDiffuse) shader.uniforms[SKY_DIFFUSE_UNIFORM] = skyDiffuse;
    shader.uniforms[MIP_BIAS_UNIFORM] = mipBiasUniform;
    shader.vertexShader = patchLambertVertex(shader.vertexShader, kind);
    shader.fragmentShader = patchSamplerBias(patchLambertFragment(shader.fragmentShader, kind));
    if (detailUniforms) {
      shader.uniforms[DETAIL_MAP_UNIFORM] = detailUniforms.map;
      shader.uniforms[DETAIL_TILING_UNIFORM] = detailUniforms.tiling;
      shader.uniforms[DETAIL_ON_UNIFORM] = detailUniforms.on;
      shader.vertexShader = patchDetailVertex(shader.vertexShader);
      shader.fragmentShader = patchDetailFragment(shader.fragmentShader);
    }
  };
  const cacheKey = `${retailLightingCacheKey(kind)}|${SAMPLER_BIAS_CACHE_KEY}`
    + (detail ? `|${DETAIL_CACHE_KEY}:${detail}` : '');
  material.customProgramCacheKey = () => cacheKey;
  material.needsUpdate = true;
  patched.set(material, kind);
  markSamplerBias(material);
  if (detail) markDetail(material, detail);
  return material;
}

/**
 * VISUAL.dungeon-lighting-saturation — `DrawMesh` @ 005a0860 picks the lights
 * per PART: `viewconeCheck(gfxobj->drawing_sphere)` sets the part's centre and
 * radius, then `minimize_object_lighting` enables only the lights whose
 * falloff reaches that sphere. three.js re-uploads a Lambert material's
 * uniforms only when the draw switches material, so the sphere is a constant
 * of the `cellobject` variant: one variant per (base material, drawing
 * sphere) — cellObjectVariantOf — sharing the one program.
 */
const partSphereUniforms = new WeakMap<THREE.Material, { value: THREE.Vector4 }>();
function installPartSphere(material: THREE.Material): { value: THREE.Vector4 } {
  let uniform = partSphereUniforms.get(material);
  if (!uniform) {
    uniform = { value: new THREE.Vector4(0, 0, 0, -1) };
    partSphereUniforms.set(material, uniform);
  }
  return uniform;
}

/**
 * JS mirror of the `cellobject` shader gate (`Render::minimize_object_lighting`
 * @ 0054d480): does a point light of `falloff` at `light` reach a part whose
 * drawing sphere is centred at `centre` with `radius` (already × object scale)?
 */
export function retailLightReachesPart(light: readonly number[], falloff: number, centre: readonly number[], radius: number): boolean {
  const dx = light[0] - centre[0], dy = light[1] - centre[1], dz = light[2] - centre[2];
  return dx * dx + dy * dy + dz * dz - (falloff + radius) * (falloff + radius) < RETAIL_F_EPSILON;
}

/** The drawing sphere a `cellobject` material gates its pool lights by ([x, y, z, r]; r < 0 = none). */
export function partSphereOf(material: THREE.Material): [number, number, number, number] | null {
  const u = partSphereUniforms.get(material);
  return u ? [u.value.x, u.value.y, u.value.z, u.value.w] : null;
}

/** Per-material `acSkyDiffuse` uniforms (the program is shared, the value is not). */
const skyDiffuseUniforms = new WeakMap<THREE.Material, { value: number }>();

function skyDiffuseUniform(material: THREE.Material): { value: number } {
  let u = skyDiffuseUniforms.get(material);
  if (!u) { u = { value: 1.0 }; skyDiffuseUniforms.set(material, u); }
  return u;
}

/** VISUAL.night-sky-vs-retail — `CMaterial::SetDiffuseSimple` on a sky-kind material. */
export function setSkyDiffuse(material: THREE.Material, diffuse: number): void {
  skyDiffuseUniform(material).value = diffuse;
}

/** The current D3D material Diffuse of a sky-kind material (1 until set). */
export function skyDiffuseOf(material: THREE.Material): number {
  return skyDiffuseUniforms.get(material)?.value ?? 1.0;
}

// ── Built-in three.js materials outside the patch (CORE.17.q.e) ─────────

/**
 * three.js's point / spot attenuation call sites in `lights_pars_begin`
 * (`getPointLightInfo` / `getSpotLightInfo`): an inverse-power falloff times
 * a smooth window that fades to 0 AT `distance`.
 */
const THREE_POINT_ATTENUATION = 'getDistanceAttenuation( lightDistance, pointLight.distance, pointLight.decay )';
const THREE_SPOT_ATTENUATION = 'getDistanceAttenuation( lightDistance, spotLight.distance, spotLight.decay )';

/** `config_hardware_light`'s attenuation (0, 1, 0) with D3DLIGHT9.Range: 1/d inside Range, nothing beyond — a hard cut. */
const GLSL_D3D_ATTENUATION = `
float acD3DAttenuation( const in float lightDistance, const in float range ) {
	return lightDistance < range ? 1.0 / max( lightDistance, 0.01 ) : 0.0;
}
`;

/** The JS mirror of the GLSL above (the value three.js's call is replaced with). */
export function retailD3DAttenuation(distance: number, range: number): number {
  return distance < range ? 1 / Math.max(distance, 0.01) : 0;
}

/**
 * `lights_pars_begin` with the point / spot attenuation turned into the D3D
 * fixed-function form. Throws when three.js moves the anchors (a silent miss
 * would bring the smooth window back).
 */
export function d3dLightsParsBegin(chunk: string = THREE.ShaderChunk.lights_pars_begin): string {
  if (!chunk.includes(THREE_POINT_ATTENUATION) || !chunk.includes(THREE_SPOT_ATTENUATION)) {
    throw new Error('RetailLighting: lights_pars_begin lost its point / spot attenuation anchors');
  }
  return GLSL_D3D_ATTENUATION + chunk
    .replace(THREE_POINT_ATTENUATION, 'acD3DAttenuation( lightDistance, pointLight.distance )')
    .replace(THREE_SPOT_ATTENUATION, 'acD3DAttenuation( lightDistance, spotLight.distance )');
}

const LIGHTS_PARS_INCLUDE = '#include <lights_pars_begin>';

/** Chain an onBeforeCompile step and a program-cache-key suffix onto whatever the material carries. */
function chainCompile(material: THREE.Material, key: string, step: (shader: THREE.WebGLProgramParametersWithUniforms) => void): void {
  const prevCompile = material.onBeforeCompile;
  const prevKeyFn = material.customProgramCacheKey;
  const prevKey = prevKeyFn !== THREE.Material.prototype.customProgramCacheKey ? prevKeyFn.call(material) : '';
  material.onBeforeCompile = (shader, renderer) => {
    prevCompile.call(material, shader, renderer);
    step(shader);
  };
  material.customProgramCacheKey = () => `${prevKey}|${key}`;
  material.needsUpdate = true;
}

const d3dPatched = new WeakSet<THREE.Material>();

/**
 * CORE.17.q.e — a lit built-in material (Phong / Standard / Lambert) that
 * stays outside `applyRetailLighting` takes point and spot lights with the
 * D3D hard Range cut instead of three.js's smooth window. Idempotent.
 */
export function applyD3DPointAttenuation<T extends THREE.Material>(material: T): T {
  if (d3dPatched.has(material)) return material;
  d3dPatched.add(material);
  chainCompile(material, 'ac-d3d-atten', (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(LIGHTS_PARS_INCLUDE, d3dLightsParsBegin());
    shader.vertexShader = shader.vertexShader.replace(LIGHTS_PARS_INCLUDE, d3dLightsParsBegin());
  });
  return material;
}

// ── Objects inside env cells (CORE.17.q.b) ────────────────────────────────

/** base material → its `cellobject` clone (one program per shared material, like DetailTexturing.variantOf). */
const cellObjectVariants = new WeakMap<THREE.Material, Map<string, THREE.Material>>();
/** `cellobject` clone → the base material it was cloned from. */
const cellObjectBases = new WeakMap<THREE.Material, THREE.Material>();

/**
 * The `cellobject` variant of a material: a clone carrying the retail patch
 * with the sun compiled out and the pool lights in. Non-Lambert (unlit)
 * materials and materials already of a cell kind come back unchanged.
 * Cached per base material and the drawn part's DAT drawing sphere
 * (`geometry.userData[DRAWING_SPHERE_KEY]`, VISUAL.dungeon-lighting-
 * saturation): every part of one GfxObj sharing a MaterialFactory material
 * shares one variant, and every variant shares one program.
 */
export function cellObjectVariantOf<T extends THREE.Material | THREE.Material[]>(material: T, geometry?: THREE.BufferGeometry): T {
  if (Array.isArray(material)) return material.map(m => cellObjectVariantOf(m, geometry)) as T;
  const mat = material as THREE.Material;
  if (!(mat instanceof THREE.MeshLambertMaterial)) return material;
  if (drawsFromDelayedList(mat)) return material;
  const kind = patched.get(mat);
  if (kind !== undefined && isCellLightingKind(kind)) return material;
  const sphere = geometry?.userData?.[DRAWING_SPHERE_KEY] as readonly number[] | undefined;
  const key = sphere ? sphere.join(',') : '';
  let perSphere = cellObjectVariants.get(mat);
  if (!perSphere) {
    perSphere = new Map();
    cellObjectVariants.set(mat, perSphere);
  }
  let variant = perSphere.get(key);
  if (!variant) {
    variant = applyRetailLighting(mat.clone(), 'cellobject');
    if (sphere) installPartSphere(variant).value.set(sphere[0], sphere[1], sphere[2], sphere[3]);
    perSphere.set(key, variant);
    cellObjectBases.set(variant, mat);
  }
  return variant as T;
}

/** userData key on a material: its batch is in retail's clip list (MaterialFactory tags it, prepareSurfaceMesh orders it). */
export const CLIP_LIST_KEY = 'acClipList';

/**
 * VISUAL.sylsfear-tree-foliage — true for a batch retail delays to the clip
 * or alpha list: a Base1ClipMap surface (MaterialFactory tags it
 * CLIP_LIST_KEY) or a blended one (Alpha / InvAlpha / Additive /
 * Translucent, or a part whose material carries alpha — all `transparent`).
 * `D3DPolyRender::DrawMesh` @ 0059d4a0 hands such a batch to
 * `AddMeshToAlphaList` @ 0059c230, which stores the world matrix and the
 * material but NOT the lights `minimize_object_lighting` just picked;
 * `FlushAlphaList` @ 0059d2e0 draws it after `PView::DrawCells` @ 005a4840
 * has restored `useSunlightSet(1)`. So inside a cell these batches take the
 * landscape pass's light set (sun + ambient, no pool lights): they stay on
 * the `object` kind instead of switching to `cellobject`.
 */
export function drawsFromDelayedList(material: THREE.Material): boolean {
  return material.transparent || material.userData?.[CLIP_LIST_KEY] === true;
}

/** The base (landscape-pass) material of a `cellobject` variant; other materials come back unchanged. */
export function cellObjectBaseOf<T extends THREE.Material | THREE.Material[]>(material: T): T {
  if (Array.isArray(material)) return material.map(m => cellObjectBaseOf(m)) as T;
  return (cellObjectBases.get(material as THREE.Material) ?? material) as T;
}

/** userData key: the light set a subtree was last switched to (`true` = in a cell). */
export const CELL_LIGHTING_KEY = 'acInCell';

/**
 * Switch an object's parts between the landscape pass (`object`: the sun,
 * no pool lights) and the cell pass (`cellobject`: no sun, the pool
 * lights), the way `PView::DrawCells` vs `DrawBlock` decide it in retail
 * by the cell the physics object is in. Every Mesh under `root` swaps its
 * material for the cached variant / back to the base; unlit materials are
 * left alone. Idempotent per root unless `force` (a subtree attached
 * later — a wielded item — needs the pass re-applied).
 */
export function setCellLighting(root: THREE.Object3D, inCell: boolean, force = false): void {
  const flags = root.userData ?? (root.userData = {});
  if (!force && flags[CELL_LIGHTING_KEY] === inCell) return;
  flags[CELL_LIGHTING_KEY] = inCell;
  root.traverse(o => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    const cur = mesh.material;
    const next = inCell ? cellObjectVariantOf(cur, mesh.geometry) : cellObjectBaseOf(cur);
    if (next === cur) return;
    if (Array.isArray(cur)) cur.forEach((m, i) => carryScriptMaterial(m, (next as THREE.Material[])[i]));
    else carryScriptMaterial(cur, next as THREE.Material);
    mesh.material = next;
  });
}

/**
 * Material userData key: the luminosity / diffusion a PhysicsScript wrote
 * to a part's own material copy (CPhysicsPart::SetLuminosity @ 0050e5f0 /
 * SetDiffusion on the part's CMaterial).
 */
export const SCRIPT_MATERIAL_KEY = 'acScriptMaterial';

/**
 * FX.cell-swap-loses-script-material — retail's part keeps ONE material
 * whatever pass it draws in (the light set is chosen per draw,
 * Render::useSunlightSet), so a script's luminosity / diffusion survives the
 * object moving between a cell and the landscape. Our two passes are two
 * materials: the one swapped in takes the values the script left on the one
 * swapped out. Only an owned (script-written) material carries the key.
 */
function carryScriptMaterial(from: THREE.Material, to: THREE.Material | undefined): void {
  const rec = from.userData?.[SCRIPT_MATERIAL_KEY] as { luminous?: number; diffuse?: number } | undefined;
  if (!rec || !to || to === from) return;
  if (rec.luminous !== undefined && to instanceof THREE.MeshLambertMaterial) setMaterialLuminosity(to, rec.luminous);
  if (rec.diffuse !== undefined && 'color' in to) (to as THREE.MeshBasicMaterial).color.setScalar(rec.diffuse);
  to.userData[SCRIPT_MATERIAL_KEY] = { ...rec };
}

/**
 * VISUAL.lifestone-crystal-glow — userData key on a lit material: the DAT
 * `Surface.luminosity` it was built from (MaterialFactory).
 */
export const SURFACE_LUMINOSITY_KEY = 'acSurfaceLuminosity';

/** The DAT surface luminosity a lit material was built from (0 when none). */
export function surfaceLuminosityOf(material: THREE.Material): number {
  const v = material.userData?.[SURFACE_LUMINOSITY_KEY];
  return typeof v === 'number' && v > 0 ? v : 0;
}

/**
 * VISUAL.lifestone-crystal-glow — write a lit material's D3D Emissive the way
 * retail resolves it at draw time. `CMaterial::SetLuminositySimple` @ 00539720
 * sets Emissive = grey(value) on the part's material (`CPhysicsPart::
 * SetLuminosity` @ 0050e5f0, `CPhysicsPart::SetLighting` @ 0050e400), but
 * `D3DPolyRender::RenderMeshSubset` @ 0059ca10 (decomp :399334) then, for a
 * surface whose `luminosity > 0`, draws with Emissive = the SURFACE's
 * luminosity: into the shared tmpmaterial when the part has no material of
 * its own, or written over the part's material for the draw and restored
 * after. So a luminous surface keeps its own glow whatever the part asks for.
 */
export function setMaterialLuminosity(material: THREE.MeshLambertMaterial, value: number): void {
  const surface = surfaceLuminosityOf(material);
  material.emissive.setScalar(surface > 0 ? surface : value);
  material.emissiveIntensity = 1;
}
