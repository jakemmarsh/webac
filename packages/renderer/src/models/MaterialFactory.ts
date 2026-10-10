import * as THREE from 'three';
import type { DatDatabase } from '@ac/dat-parser/DatDatabase.js';
import { DatReader } from '@ac/dat-parser/DatReader.js';
import { Surface, SurfaceType } from '@ac/dat-parser/file-types/Surface.js';
import type { TextureManager } from './TextureManager.js';
import { applyRetailLighting, CLIP_LIST_KEY, SURFACE_LUMINOSITY_KEY } from './RetailLighting.js';
import { applySamplerBias } from './TextureSamplerPrefs.js';
import { markSharedMaterial } from './MaterialOwnership.js';
import { datMissEpoch, noDatMissSince } from '@ac/dat-parser/streaming/DatMiss.js';

/**
 * MaterialFactory — creates Three.js materials from AC Surface definitions.
 * Loads Surface data from portal.dat, resolves textures via TextureManager,
 * and applies transparency/luminosity/diffuse properties.
 */
/**
 * VISUAL.night-sky-clouds-vs-retail — whether retail blends a surface
 * additively (D3D SRCALPHA/ONE or ONE/ONE). `D3DPolyRender::SetSurface`
 * @ 0059c4d0 picks the Additive (0x10000) destination factor first, but a
 * Translucent (0x10) surface that is also alpha-tested (Base1ClipMap 0x4)
 * is then forced to SRCALPHA/INVSRCALPHA with the alpha test off. In the EoL
 * portal.dat that is exactly one surface: the Cloudy/Rainy cloud dome's
 * 0x08000023 (type 0x10114), which therefore composites like any alpha
 * cloud layer instead of glowing over the stars.
 */
export function surfaceBlendsAdditive(type: number): boolean {
  return surfaceDrawState(type).dst === D3DBlend.One;
}

/** The D3DBLEND factors D3DPolyRender::SetSurface @ 0059c4d0 chooses between. */
export const D3DBlend = { Zero: 1, One: 2, SrcAlpha: 5, InvSrcAlpha: 6 } as const;
export type D3DBlendFactor = (typeof D3DBlend)[keyof typeof D3DBlend];

/** D3DPolyRender::s_256AlphaTestRef (globals.tsv: 100) — palettized textures. */
export const ALPHA_TEST_REF_256 = 100;
/** D3DPolyRender::s_ddsAlphaTestRef (globals.tsv: 200) — every other texture. */
export const ALPHA_TEST_REF_DDS = 200;

/** The render state SetSurface leaves for one surface batch. */
export interface SurfaceDrawState {
  /** SetAlphaBlendEnable. */
  blend: boolean;
  src: D3DBlendFactor;
  dst: D3DBlendFactor;
  /** SetAlphaTestEnable (ALPHATESTFUNC_GREATEREQUAL against the test ref). */
  alphaTest: boolean;
  /** SetDepthBufferMode(zfunc, depthWrite) → D3DRS_ZWRITEENABLE. */
  depthWrite: boolean;
  /** SetFFFogAlphaDisabled(!fog) → D3DRS_FOGENABLE. */
  fog: boolean;
}

/**
 * RENDER.translucent-writes-depth — `D3DPolyRender::SetSurface` @ 0059c4d0's
 * blend / alpha-test / depth-write decision for a surface type, with the
 * per-draw inputs at their normal values (param_4 false: RenderPrefs
 * MultiPassAlpha is false; `skipChk` 0; no part material alpha — a faded
 * part is ObjectTranslucency's business):
 *
 *  - Alpha 0x100 → SRCALPHA / (Additive ? ONE : INVSRCALPHA), blended;
 *    else no InvAlpha 0x200 → ONE / (Additive ? ONE, blended : ZERO, opaque);
 *    else InvAlpha → INVSRCALPHA / (Additive ? ONE : SRCALPHA), blended.
 *  - Base1ClipMap 0x4 → alpha test on, blend on (ONE / INVSRCALPHA when
 *    nothing above blended).
 *  - Translucent 0x10 → when not blended yet or alpha-tested:
 *    SRCALPHA / INVSRCALPHA, blended, alpha test OFF (curr_alpha =
 *    1 − translucency, whatever its value — 0 included).
 *  - depth write = alpha-tested || not blended (`local_8`).
 *  - fog off for Additive (SetFFFogAlphaDisabled(true)).
 */
export function surfaceDrawState(type: number): SurfaceDrawState {
  const additive = (type & SurfaceType.Additive) !== 0;
  let src: D3DBlendFactor;
  let dst: D3DBlendFactor;
  let blend: boolean;
  if ((type & SurfaceType.Alpha) !== 0) {
    src = D3DBlend.SrcAlpha; dst = additive ? D3DBlend.One : D3DBlend.InvSrcAlpha; blend = true;
  } else if ((type & SurfaceType.InvAlpha) === 0) {
    src = D3DBlend.One;
    if (additive) { dst = D3DBlend.One; blend = true; } else { dst = D3DBlend.Zero; blend = false; }
  } else {
    src = D3DBlend.InvSrcAlpha; dst = additive ? D3DBlend.One : D3DBlend.SrcAlpha; blend = true;
  }
  let alphaTest = false;
  if ((type & SurfaceType.Base1ClipMap) !== 0) {
    if (!blend) { src = D3DBlend.One; dst = D3DBlend.InvSrcAlpha; }
    blend = true;
    alphaTest = true;
  }
  if ((type & SurfaceType.Translucent) !== 0 && (!blend || alphaTest)) {
    src = D3DBlend.SrcAlpha; dst = D3DBlend.InvSrcAlpha; blend = true; alphaTest = false;
  }
  return { blend, src, dst, alphaTest, depthWrite: alphaTest || !blend, fog: !additive };
}

/**
 * SetSurface's alpha-test ref as a three.js `alphaTest` (both keep alpha >= ref):
 * s_256AlphaTestRef when the texture is palettized (ImgTex::m_pPalette set),
 * s_ddsAlphaTestRef otherwise (TextureManager tags `userData.acPaletted`).
 */
export function alphaTestRefFor(texture: THREE.Texture | null): number {
  const paletted = texture?.userData?.acPaletted === true;
  return (paletted ? ALPHA_TEST_REF_256 : ALPHA_TEST_REF_DDS) / 255;
}

const THREE_FACTOR: Record<D3DBlendFactor, THREE.BlendingDstFactor> = {
  [D3DBlend.Zero]: THREE.ZeroFactor,
  [D3DBlend.One]: THREE.OneFactor,
  [D3DBlend.SrcAlpha]: THREE.SrcAlphaFactor,
  [D3DBlend.InvSrcAlpha]: THREE.OneMinusSrcAlphaFactor,
};

/**
 * RENDER.clip-map-deferral — which of retail's delayed lists a surface's
 * batch goes to. D3DPolyRender::ConstructMesh @ 0059dfa0 tags each batch:
 * Alpha / InvAlpha / Additive (0x10300) → 2, else Base1ClipMap → 8, else
 * Translucent → 4, else 0; DrawMesh @ 0059d4a0 delays a batch whose tag is
 * in s_AlphaDelayMask (.data 0x820d88 = 14) — tag 8 to the CLIP list, 2 / 4
 * to the ALPHA list (AddMeshToAlphaList @ 0059c230) — and FlushAlphaList
 * @ 0059d2e0 draws the clip list, then the alpha list, after the scene.
 */
export function surfaceDelayList(type: number): 'none' | 'clip' | 'alpha' {
  if ((type & (SurfaceType.Alpha | SurfaceType.InvAlpha | SurfaceType.Additive)) !== 0) return 'alpha';
  if ((type & SurfaceType.Base1ClipMap) !== 0) return 'clip';
  if ((type & SurfaceType.Translucent) !== 0) return 'alpha';
  return 'none';
}

/**
 * The renderOrder band for the clip list: in three's transparent list (drawn
 * after every opaque draw) it comes before the alpha list's draws at
 * renderOrder 0, after the before-world sky objects (-50…) and the terrain
 * overlays (-1 + rank/1000), as FlushAlphaList draws clip before alpha.
 *
 * RENDER.alpha-list-order — within a list retail does NOT sort: AddMeshToAlphaList
 * @ 0059c230 appends and FlushAlphaList @ 0059d2e0 draws in insertion order.
 * The insertion order is the draw traversal, which is back to front: LScape::
 * draw @ 00506330 walks block_draw_list from its END (get_block_order puts the
 * viewer's block first), and CLandBlock::calc_draw_order @ 00530300 fills
 * draw_array from the end with the closest cell last, which DrawBlock walks
 * forward. So three's default transparent sort (renderOrder, then far-to-near
 * by object) is the closest match and is kept. What still differs: retail is
 * back-to-front per 24 m land cell with the cell's object-list order inside it
 * (we sort per object / per InstancedMesh pool, whose instances keep pool
 * order); and DrawBuilding @ 0059f2a0 / PView::DrawCells flush the lists
 * (FlushAlphaList(0)) mid-frame, and DrawBlock does whenever a list nears 2250
 * of its 3000 slots (`flush` .data 0x820ed0 = 0.75) — retail's clip-before-alpha
 * holds per flush segment, ours across the whole frame.
 */
export const CLIP_LIST_RENDER_ORDER = -0.5;

/** userData key on a material: its batch is in retail's clip list (prepareSurfaceMesh; defined beside its RetailLighting reader). */
export { CLIP_LIST_KEY };
/** userData key on a material: its alpha-test ref follows the bound texture (prepareSurfaceMesh). */
export const AUTO_ALPHA_REF_KEY = 'acAutoAlphaRef';

/** The three.js material state SetSurface leaves for a surface. */
export interface SurfaceMaterialState {
  transparent: boolean;
  depthWrite: boolean;
  depthFunc: THREE.DepthModes;
  alphaTest: number;
  blending: THREE.Blending;
  blendSrc?: THREE.BlendingSrcFactor;
  blendDst?: THREE.BlendingDstFactor;
  blendEquation?: THREE.BlendingEquation;
  opacity?: number;
  /** One draw for a double-sided material (retail's CULL_NONE copy is in the same batch). */
  forceSinglePass: boolean;
  /** The batch is in retail's clip list (CLIP_LIST_RENDER_ORDER). */
  clipList: boolean;
}

/**
 * SetSurface @ 0059c4d0 as three.js material state.
 *  - `zfuncVal` (.data 0x820e1c = 2 = DEPTHTEST_LESS, never written) → LessDepth.
 *  - `materialHasAlpha`: the part's CMaterial has an alpha below 1
 *    (CMaterial::CheckAlphaValues @ 005396a0 — a fading part / particle).
 *    Unless the surface already blends without an alpha test, SetSurface
 *    then forces SRCALPHA/INVSRCALPHA with the alpha test off; either way
 *    depth writes are off (`local_8 = false`).
 *  - A delayed CLIP-list batch draws after the opaque pass: transparent
 *    (three's after-opaque list) at CLIP_LIST_RENDER_ORDER, with its own
 *    ONE/INVSRCALPHA blend, alpha test and depth write.
 */
export function surfaceMaterialState(
  type: number,
  translucency: number,
  texture: THREE.Texture | null,
  materialHasAlpha = false,
): SurfaceMaterialState {
  let state = surfaceDrawState(type);
  if (materialHasAlpha) {
    state = state.blend && !state.alphaTest
      ? { ...state, depthWrite: false }
      : { ...state, blend: true, src: D3DBlend.SrcAlpha, dst: D3DBlend.InvSrcAlpha, alphaTest: false, depthWrite: false };
  }
  const out: SurfaceMaterialState = {
    transparent: state.blend,
    depthWrite: state.depthWrite,
    depthFunc: THREE.LessDepth,
    alphaTest: state.alphaTest && texture ? alphaTestRefFor(texture) : 0,
    blending: THREE.NormalBlending,
    forceSinglePass: true,
    clipList: !materialHasAlpha && surfaceDelayList(type) === 'clip',
  };
  // curr_alpha: (1 − translucency) × 255 for a Translucent surface (SetSurface :399158).
  if ((type & SurfaceType.Translucent) !== 0) out.opacity = 1 - translucency;
  if (!state.blend) return out;
  if (state.src === D3DBlend.SrcAlpha && state.dst === D3DBlend.InvSrcAlpha) {
    out.blending = THREE.NormalBlending;
  } else if (state.src === D3DBlend.SrcAlpha && state.dst === D3DBlend.One) {
    out.blending = THREE.AdditiveBlending;
  } else {
    out.blending = THREE.CustomBlending;
    out.blendSrc = THREE_FACTOR[state.src] as THREE.BlendingSrcFactor;
    out.blendDst = THREE_FACTOR[state.dst];
    out.blendEquation = THREE.AddEquation;
  }
  return out;
}

/** Write a SurfaceMaterialState onto a material (and tag it for prepareSurfaceMesh). */
export function applySurfaceMaterialState(mat: THREE.Material, st: SurfaceMaterialState): void {
  mat.transparent = st.transparent;
  mat.depthWrite = st.depthWrite;
  mat.depthFunc = st.depthFunc;
  mat.alphaTest = st.alphaTest;
  mat.blending = st.blending;
  if (st.blendSrc !== undefined) mat.blendSrc = st.blendSrc;
  if (st.blendDst !== undefined) mat.blendDst = st.blendDst;
  if (st.blendEquation !== undefined) mat.blendEquation = st.blendEquation;
  if (st.opacity !== undefined) mat.opacity = st.opacity;
  mat.forceSinglePass = st.forceSinglePass;
  if (st.clipList) mat.userData[CLIP_LIST_KEY] = true;
  if (st.alphaTest > 0) mat.userData[AUTO_ALPHA_REF_KEY] = true;
}

/**
 * RENDER.alpha-ref-follows-bound-texture — SetSurface reads the ref from the
 * texture BOUND for the draw (`curr_texture_is_set`, `m_pPalette`): when
 * Very High swaps a palettized portal texture for its DXT highres level
 * (TextureSamplerPrefs.applyTo re-tags `userData.acPaletted`), the ref moves
 * from 100 to 200. Runs per draw for the material actually used, leaving a
 * faded material's alpha test (0) alone.
 *
 * RENDER.alpha-ref-hook-on-clones — installed on Material.prototype, so
 * EVERY copy of a surface material syncs: cell / detail / owned / authored
 * copies, the examine and paperdoll figures, held-item copies, instancer
 * clones — Material.clone() keeps userData (the AUTO_ALPHA_REF_KEY tag)
 * but not an instance's own hooks, and a mesh-level hook is lost by any
 * mesh built outside the mesh factories.
 */
export function syncSurfaceAlphaRef(material: THREE.Material): void {
  if (material.alphaTest <= 0 || !material.userData?.[AUTO_ALPHA_REF_KEY]) return;
  const ref = alphaTestRefFor((material as THREE.MeshBasicMaterial).map ?? null);
  if (material.alphaTest !== ref) material.alphaTest = ref;
}

const ALPHA_REF_HOOK = Symbol.for('acjs.surfaceAlphaRefHook');
{
  const proto = THREE.Material.prototype as THREE.Material & { [ALPHA_REF_HOOK]?: true };
  if (!proto[ALPHA_REF_HOOK]) {
    const base = proto.onBeforeRender;
    proto.onBeforeRender = function (this: THREE.Material, ...args: Parameters<THREE.Material['onBeforeRender']>): void {
      syncSurfaceAlphaRef(this);
      base.apply(this, args);
    };
    proto[ALPHA_REF_HOOK] = true;
  }
}

/**
 * Per-mesh half of SetSurface's state: a clip-list material's mesh draws in
 * the clip band (CLIP_LIST_RENDER_ORDER), a batch-ordered GfxObj's sub-mesh
 * at its batch's order. Object3D.clone() copies renderOrder, so mesh clones
 * keep it. Call where a mesh is made from MaterialFactory materials
 * (ModelRenderer, EnvCellRenderer, the instancers).
 */
export function prepareSurfaceMesh(mesh: THREE.Mesh, renderOrderBase = 0): void {
  const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  if (list.some(m => m?.userData?.[CLIP_LIST_KEY])) mesh.renderOrder = CLIP_LIST_RENDER_ORDER + renderOrderBase;
  else if (renderOrderBase !== 0) mesh.renderOrder = renderOrderBase;
}

export class MaterialFactory {
  private portalDb: DatDatabase;
  private textureManager: TextureManager;
  private materialCache = new Map<string, THREE.Material>();

  constructor(portalDb: DatDatabase, textureManager: TextureManager) {
    this.portalDb = portalDb;
    this.textureManager = textureManager;
  }

  /**
   * Get or create a Three.js Material from a Surface ID (0x08xxxxxx).
   * Optional textureOverrides maps old SurfaceTexture IDs to new ones.
   * Optional paletteColors provides a composite palette for indexed textures.
   */
  getMaterial(
    surfaceId: number,
    paletteOverride?: number,
    textureOverrides?: Map<number, number>,
    paletteColors?: number[],
    /** Back-face culled (THREE.FrontSide) — a single-sided polygon's material (GfxObjGeometry.doubleSided). */
    frontSide = false,
    /** TEXADDRESS_CLAMP sampling — a batch with no stippled polygon (GfxObjGeometry.clampUV). */
    clampUV = false,
  ): THREE.Material {
    // When overrides are present the Material INSTANCE must stay unique:
    // applyTranslucency (ServerObjectManager.ts) mutates materials in place
    // per object, so sharing instances across characters would bleed ghost
    // translucency between them. ASSESS: the expensive part — the composite
    // palette texture decode + GPU upload — is now content-hash cached in
    // TextureManager.getTextureWithPalette, so this fresh Material object is
    // just a cheap JS wrapper around a cached texture.
    if (textureOverrides || paletteColors) {
      const surface = this.loadSurface(surfaceId);
      if (!surface) {
        return applyRetailLighting(new THREE.MeshLambertMaterial({ color: 0xff00ff }), 'object');
      }
      return this.createMaterialFromSurface(surface, paletteOverride, textureOverrides, paletteColors, frontSide, clampUV);
    }

    const cacheKey = `${surfaceId}:${paletteOverride ?? 0}${frontSide ? ':f' : ''}${clampUV ? ':c' : ''}`;
    const cached = this.materialCache.get(cacheKey);
    if (cached) return cached;

    const epoch = datMissEpoch();
    const surface = this.loadSurface(surfaceId);
    const mat = surface
      ? this.createMaterialFromSurface(surface, paletteOverride, undefined, undefined, frontSide, clampUV)
      : applyRetailLighting(new THREE.MeshLambertMaterial({ color: 0xff00ff }), 'object');
    // RELEASE.dat-streaming — a material built while a streamed DAT file
    // (surface / texture / palette) was not resident yet stays uncached, so
    // the rebuild after it arrives makes the real one (DatMiss.ts).
    if (noDatMissSince(epoch)) this.cacheShared(cacheKey, mat);
    return mat;
  }

  /**
   * PERF.browser-memory-crash — drop and dispose cached materials no live
   * mesh uses (models/ResourceSweep.ts); their textures then become
   * releasable by TextureManager.sweep. Returns how many were released.
   */
  sweep(live: ReadonlySet<THREE.Material>): number {
    let released = 0;
    for (const [key, mat] of [...this.materialCache]) {
      if (live.has(mat)) continue;
      this.materialCache.delete(key);
      mat.dispose();
      released++;
    }
    return released;
  }

  /**
   * REND.shared-cached-material-disposed-faded — a cached material is shared
   * by every mesh drawing the surface: register it (MaterialOwnership) so the
   * dispose paths skip it and per-object writes copy it first, and evict it
   * if anything disposes it anyway so the cache never hands out a disposed
   * material (the next request rebuilds it).
   */
  private cacheShared(cacheKey: string, mat: THREE.Material): void {
    markSharedMaterial(mat);
    this.materialCache.set(cacheKey, mat);
    const evict = (): void => {
      mat.removeEventListener('dispose', evict);
      if (this.materialCache.get(cacheKey) === mat) this.materialCache.delete(cacheKey);
    };
    mat.addEventListener('dispose', evict);
  }

  /** The parsed DAT Surface for an id, or null (VISUAL.night-sky-vs-retail). */
  getSurface(surfaceId: number): Surface | null {
    try { return this.loadSurface(surfaceId); } catch { return null; }
  }

  /**
   * Load and parse a Surface from portal.dat.
   */
  private loadSurface(surfaceId: number): Surface | null {
    const data = this.portalDb.getFileData(surfaceId);
    if (!data) return null;
    return Surface.read(new DatReader(data));
  }

  /**
   * Convert a Surface into a Three.js Material.
   * Supports texture substitution via textureOverrides and composite palette via paletteColors.
   */
  private createMaterialFromSurface(
    surface: Surface,
    paletteOverride?: number,
    textureOverrides?: Map<number, number>,
    paletteColors?: number[],
    frontSide = false,
    clampUV = false,
  ): THREE.Material {
    const isClipMap = (surface.type & SurfaceType.Base1ClipMap) !== 0;
    const hasTexture = (surface.type & SurfaceType.Base1Image) !== 0 || isClipMap;
    const isAdditive = (surface.type & SurfaceType.Additive) !== 0;
    const isLuminous = (surface.type & SurfaceType.Luminous) !== 0;

    let texture: THREE.DataTexture | null = null;
    if (hasTexture && surface.origTextureId) {
      // Apply texture substitution if available
      let textureId = surface.origTextureId;
      if (textureOverrides?.has(textureId)) {
        textureId = textureOverrides.get(textureId)!;
      }

      if (paletteColors) {
        // Use composite palette colors directly for palette-indexed textures
        texture = this.textureManager.getTextureWithPalette(textureId, paletteColors, isClipMap, clampUV);
      } else {
        const paletteId = paletteOverride ?? surface.origPaletteId;
        texture = this.textureManager.getTexture(textureId, paletteId || undefined, isClipMap, 'environment', clampUV);
      }
    }

    // RENDER.translucent-writes-depth — blend, alpha test, depth write, fog
    // and opacity all follow D3DPolyRender::SetSurface @ 0059c4d0
    // (surfaceDrawState / surfaceMaterialState), for the unlit and lit paths alike.
    if (isLuminous || isAdditive) {
      const params: THREE.MeshBasicMaterialParameters = {};
      if (texture) {
        params.map = texture;
      } else {
        params.color = surface.colorValue || 0xffffff;
      }
      // D3DPolyRender::SetSurface @ 0059c4d0: SetFFFogAlphaDisabled(true)
      // for an Additive surface — never fogged (VISUAL.particle-surfaces-unlit).
      if (isAdditive) params.fog = false;
      params.side = frontSide ? THREE.FrontSide : THREE.DoubleSide;
      const basic = new THREE.MeshBasicMaterial(params);
      applySurfaceMaterialState(basic, surfaceMaterialState(surface.type, surface.translucency, texture));
      // CORE.17.h.g.c — unlit surfaces still sample through the world's
      // sampler prefs (the Sharp-mode mip bias is device-wide in retail).
      return applySamplerBias(basic);
    }

    const params: THREE.MeshLambertMaterialParameters = {};
    if (texture) {
      params.map = texture;
    } else {
      params.color = surface.colorValue || 0xcccccc;
    }

    // VISUAL.lifestone-crystal-glow — `D3DPolyRender::RenderMeshSubset` @
    // 0059ca10 (decomp :399334) draws any surface with `luminosity > 0` with
    // D3D Emissive = grey(luminosity), whatever its type flags: the emissive
    // joins the clamped vertex colour that modulates the texel (RetailLighting).
    // 570 lit surfaces carry one, e.g. the lifestone crystal 0x080011DE (0.75).
    // Env-cell geometry ignores it (EnvCellRenderer: burned-in static lights).
    const luminosity = surface.luminosity > 0 ? surface.luminosity : 0;
    if (luminosity > 0) params.emissive = new THREE.Color(luminosity, luminosity, luminosity);

    params.side = frontSide ? THREE.FrontSide : THREE.DoubleSide;
    // CORE.17.e — every lit world object shades with the retail equation
    // (clamp01 Σ light, gamma-space modulate, SetWorldAmbientLight's
    // ambient boost). Luminous/Additive surfaces above are unlit (Basic).
    const material = new THREE.MeshLambertMaterial(params);
    applySurfaceMaterialState(material, surfaceMaterialState(surface.type, surface.translucency, texture));
    if (luminosity > 0) material.userData[SURFACE_LUMINOSITY_KEY] = luminosity;
    return applyRetailLighting(material, 'object');
  }

  /**
   * Get the number of cached materials.
   */
  get cacheSize(): number {
    return this.materialCache.size;
  }

  /**
   * Clear all cached materials and dispose GPU resources.
   */
  clear(): void {
    for (const mat of [...this.materialCache.values()]) {
      mat.dispose();
    }
    this.materialCache.clear();
  }
}
