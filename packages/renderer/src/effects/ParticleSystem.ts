import * as THREE from 'three';
import {
  EmitterType,
  ParticleType,
  type ParticleEmitterInfo,
} from '@ac/dat-parser/file-types/ParticleEmitterInfo.js';
import {
  billboardRotation,
  isBillboardMode,
  landCellViewerDistance,
  selectDegradeLevel,
  DegradeMode,
  MAX_CELL_2D_DEGRADE_DISTANCE,
  RETAIL_DEGRADE_PREFS,
  STARTUP_PARTICLE_DISTANCE_2DSQ,
} from '../models/DegradeLod.js';
import { fallbackParticleGfx, particleMaxDegradeDistance, type ParticleGfx, type ParticleSurface } from './ParticleGfx.js';
import { applyRetailLighting, CULL_NONE_DEFINE, type RetailLightingKind } from '../models/RetailLighting.js';
import { applySurfaceMaterialState, surfaceMaterialState } from '../models/MaterialFactory.js';
import { SurfaceType } from '@ac/dat-parser/file-types/Surface.js';

interface Particle {
  /** Emitter-elapsed time at spawn. */
  birth: number;
  /**
   * World-frame mode: the parent frame's origin at birth (AC axes) —
   * Particle::Init's StartFrame, which a non-parent-local particle keeps
   * using for its whole life (it stays where it was emitted).
   */
  origin: THREE.Vector3;
  /**
   * World-frame mode: the parent frame's orientation at birth (three.js) —
   * the StartFrame a non-parent-local GR particle spins from.
   */
  quat: THREE.Quaternion;
  /**
   * World-frame mode with a cell-stamping frame source: the landblock origin
   * (AC axes) of the cell the particle was emitted in (AddPartToShadowCells).
   */
  cell: THREE.Vector3;
  /** Per-particle randomized scale / translucency endpoints (EmitParticle). */
  startScale: number;
  finalScale: number;
  startTrans: number;
  finalTrans: number;
  lifespan: number;
  /** Random spawn offset (GetRandomOffset). May be scaled by `c` for Implode. */
  offset: THREE.Vector3;
  /** Randomized A/B/C vectors, masked per particleType (Particle.Init). */
  a: THREE.Vector3;
  b: THREE.Vector3;
  c: THREE.Vector3;
}

/** Sprite rendering options for a particle system (resolveEmitterSprite). */
export interface ParticleSpriteOptions {
  /**
   * The emitter's HW GfxObj as drawable geometry + its degrade chain — what
   * every particle draws (VISUAL.particles-oriented-quads). Absent: a
   * billboarded `sizeScale` square textured with `map`.
   */
  gfx?: ParticleGfx | null;
  /** Level-0 surface texture (also the fallback square's texture). */
  map?: THREE.Texture | null;
  /** Level-0 surface Additive bit (0x10000) — additive blending. */
  additive?: boolean;
  /** The HW GfxObj's largest axis extent (m) — the fallback square's size. */
  sizeScale?: number;
}

/**
 * What the particles are drawn against this frame — Render::viewer_pos and
 * the degrade preferences GfxObjDegradeInfo::get_degrade reads.
 */
export interface ParticleView {
  /** Render::viewer_pos (the camera), three.js world space. */
  viewer: THREE.Vector3;
  /** Render::s_rDegradeDistance (Config "Degrade Distance", default 50). */
  degradeDistance?: number;
  /** deg_mul / s_rUserSuppliedDegradeBias (default 0). */
  bias?: number;
  /** Render::particle_distance_2dsq (startup 16). */
  particleDistance2dSq?: number;
  /** Render::force_level (−1 = off). */
  forceLevel?: number;
  /** degrades_disabled. */
  disabled?: boolean;
}

/**
 * The frame a DAT emitter rides — retail's ParticleEmitter::SetParenting
 * @ 0051c190: the emitter object is parented to its owner (or to the owner's
 * part `part_index`) at the hook's offset, so it follows the hand / the
 * creature as they animate. Particles are then simulated in WORLD space
 * (Particle::Init @ 0051c930 / Particle::Update @ 0051c290).
 */
export interface ParticleFrameSource {
  /**
   * Write the parent frame's CURRENT world position + orientation (THREE
   * axes); return false once the parent is gone (the emitter then stops).
   */
  getFrame(outPos: THREE.Vector3, outQuat: THREE.Quaternion): boolean;
  /** The hook's offset origin (ParentOffset), AC axes, in the parent's local frame. */
  offset: { x: number; y: number; z: number };
  /**
   * Whether the parent sits in an outdoor LAND cell — RenderDeviceD3D::
   * UpdateObjCell hands such a cell's 2-D viewer distance to every object
   * in it beyond MAX_CELL_2D_DEGRADE_DISTANCE (the particle object too).
   */
  inLandCell?(): boolean;
  /**
   * Whether the parent is drawn in an env cell's pass (PView::DrawCells,
   * useSunlightSet(0): no sun, the pool lights) — the particle object is in
   * its parent's cell, so its parts are lit the same way.
   */
  inCell?(): boolean;
  /**
   * The world origin (three.js) of the landblock the frame is expressed in;
   * when present, getFrame returns the frame LOCAL to that landblock.
   * VISUAL.night-sky-vs-retail.a — a particle part keeps the cell its object
   * was in when it was emitted: CPhysicsObj::AddPartToShadowCells @ 00510e00
   * stamps `part->pos.objcell_id = cell->id`, Particle::Update @ 0051c290
   * rewrites only the frame origin, and calc_draw_frame @ 0050dfa0 draws the
   * part at that stamped cell. The particle object itself (its distance and
   * heading) is in the parent's CURRENT cell. Absent: frames are world
   * frames and nothing is stamped.
   */
  cellOrigin?(out: THREE.Vector3): void;
  /**
   * The parent object's mesh was rebuilt (an ObjDesc change, or a streamed
   * GfxObj arriving after the first build): follow the matching node under
   * `to` instead of the one under `from`. Retail swaps only the part array's
   * parts (CPhysicsObj::DoObjDescChanges @ 0050fa30); the emitter keeps its
   * parent object and part index.
   */
  rebind?(from: THREE.Object3D, to: THREE.Object3D): void;
}

/**
 * GameSky::Draw @ 00506ff0 for a sky object's emitter: the particles are
 * drawn in the sky pass with DEPTHTEST_ALWAYS under `Render::zfar × 4`.
 * `viewScale` maps that frustum onto ours the way the sky domes do
 * (SkyboxRenderer SKY_OBJ_SCALE): the draw is scaled about the viewer, which
 * leaves the projection unchanged. `afterWorld` = after_sky_cell (props&1),
 * drawn over the world; otherwise before it, in sky object order.
 */
export interface ParticleSkyPass {
  renderOrder: number;
  afterWorld: boolean;
  viewScale: number;
}

/** Particle scale clamp (the MINIMUM_SCALE / MAXIMUM_SCALE globals GetRandom*Scale reads). */
const MINIMUM_SCALE = 0.1;
const MAXIMUM_SCALE = 10;

/**
 * VISUAL.particle-surfaces-unlit — a particle is drawn through the ordinary
 * lit part path: CPhysicsParticle's parts go CPhysicsPart::Draw @ 0050d7a0 →
 * RenderDeviceD3D::DrawMesh → D3DPolyRender::RenderMeshSubset @ 0059ca10,
 * which keeps D3DRS_LIGHTING on and adds the surface's `luminosity` as the
 * material emissive (lum 1 saturates to full-bright; lum 0 is lit by the sun
 * outdoors, the pool lights in a cell), and SetSurface @ 0059c4d0 enables
 * fog for every surface except Additive (0x10000). So the draw is the retail
 * object equation (models/RetailLighting, MeshLambertMaterial) with the
 * per-particle translucency (Particle::Update → CPhysicsPart::
 * SetTranslucency, the D3D material alpha) as an instance attribute folded
 * into the fragment alpha before the alpha test, as D3D's alpha test sees it.
 *
 * FX.additive-particle-faded-discarded — nothing is discarded for being
 * nearly transparent: a ONE/ONE (Additive without the Alpha bit) surface
 * ignores alpha in the blend, so retail adds a fully faded particle's (and an
 * alpha-0 texel's) colour all the same. Only translucency 1 removes a
 * particle — CPhysicsPart::SetTranslucency @ 0050e670 sets the no-draw bit,
 * which the instance writer honours by skipping it (`alpha <= 0`).
 */
const PARTICLE_ALPHA_CACHE_KEY = 'acParticleAlphaNoCut';

function injectOnce(src: string, anchor: string, replacement: string, what: string): string {
  if (!src.includes(anchor)) throw new Error(`ParticleSystem: ${what} anchor ${anchor} missing`);
  return src.replace(anchor, replacement);
}

/**
 * RENDER.cell-particles-delayed-light-set — true when retail hands this
 * particle draw to the alpha list instead of drawing it in its cell.
 * `D3DPolyRender::ConstructMesh` @ 0059dfa0 tags each batch by its surface
 * type (Alpha / InvAlpha / Additive → 2, Base1ClipMap → 8, Translucent → 4,
 * else 0) and `DrawMesh` @ 0059d4a0 delays a batch whose tag is in
 * `s_AlphaDelayMask` (14: all three), or any batch while the current
 * CMaterial `has_alpha` (a fading emitter's particles: Particle::Update →
 * SetTranslucency copies the material with alpha < 1). `FlushAlphaList`
 * @ 0059d2e0 then draws it after `PView::DrawCells` @ 005a4840 has restored
 * `useSunlightSet(1)`: sun + ambient, never the cell's pool lights. The
 * synthetic fallback square is Base1Image | Alpha, so it is always delayed.
 */
export function particleDrawsFromDelayedList(surf: ParticleSurface, fades: boolean): boolean {
  const type = surf.type ?? (SurfaceType.Base1Image | SurfaceType.Alpha | (surf.additive ? SurfaceType.Additive : 0));
  const delayedTypes = SurfaceType.Alpha | SurfaceType.InvAlpha | SurfaceType.Additive
    | SurfaceType.Base1ClipMap | SurfaceType.Translucent;
  return (type & delayedTypes) !== 0 || fades;
}

/** Build one particle submesh's material for a draw pass (`object` = the landscape pass, `cellobject` = an env cell's). */
export function makeParticleMaterial(surf: ParticleSurface, tint: THREE.Color, kind: RetailLightingKind, fog = true, fades = true): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({
    color: new THREE.Color(surf.map ? 0xffffff : surf.color).multiply(tint),
    map: surf.map,
    side: THREE.DoubleSide,
    // SetSurface @ 0059c4d0: SetFFFogAlphaDisabled(additive) — additive
    // surfaces are never fogged; everything else takes the world fog.
    fog: fog && !surf.additive,
  });
  // RENDER.particle-surface-state — SetSurface's blend / alpha test / depth
  // write for the surface. A particle's translucency is its part's CMaterial
  // alpha (Particle::Update → CPhysicsPart::SetTranslucency): any value but
  // 0 copies the material with alpha < 1 (has_alpha), which turns depth
  // writes and the alpha test off; an emitter whose particles never fade
  // (start = final = 0, no transRand) draws with the surface's own state.
  // The synthetic fallback square has no DAT surface: an alpha-blended image
  // (SRCALPHA/INVSRCALPHA), SRCALPHA/ONE when additive.
  const type = surf.type ?? (SurfaceType.Base1Image | SurfaceType.Alpha | (surf.additive ? SurfaceType.Additive : 0));
  const st = surfaceMaterialState(type, 1 - surf.opacity, surf.map, fades);
  applySurfaceMaterialState(mat, { ...st, opacity: surf.opacity });
  // Instance alpha needs the blended list even for an opaque surface state.
  mat.transparent = true;
  mat.emissive.setScalar(surf.luminosity);
  // DoubleSide here is not the GfxObj's SidesType (RENDER.particle-polygon-sides):
  // both faces keep the front normal's light, as before the SidesType 1 back light.
  mat.defines = { ...mat.defines, [CULL_NONE_DEFINE]: '' };
  applyRetailLighting(mat, kind);
  const retailCompile = mat.onBeforeCompile;
  const retailKey = mat.customProgramCacheKey();
  mat.onBeforeCompile = (shader, renderer) => {
    retailCompile.call(mat, shader, renderer);
    shader.vertexShader = injectOnce(shader.vertexShader, '#include <common>',
      '#include <common>\nattribute float instanceAlpha;\nvarying float vAcInstanceAlpha;', 'vertex');
    shader.vertexShader = injectOnce(shader.vertexShader, '#include <begin_vertex>',
      '#include <begin_vertex>\n\tvAcInstanceAlpha = instanceAlpha;', 'vertex');
    shader.fragmentShader = injectOnce(shader.fragmentShader, '#include <common>',
      '#include <common>\nvarying float vAcInstanceAlpha;', 'fragment');
    shader.fragmentShader = injectOnce(shader.fragmentShader, '#include <alphatest_fragment>',
      '\tdiffuseColor.a *= vAcInstanceAlpha;\n#include <alphatest_fragment>', 'fragment');
  };
  mat.customProgramCacheKey = () => `${retailKey}|${PARTICLE_ALPHA_CACHE_KEY}`;
  mat.needsUpdate = true;
  mat.userData.particleSurface = surf;
  return mat;
}

/**
 * GameSky::Draw @ 00506ff0 material state for a sky emitter's particles:
 * DEPTHTEST_ALWAYS with no depth writes. A before-sky draw goes in the
 * opaque list (drawn before the world, in renderOrder) keeping the
 * surface's blend (SetSurface: Additive → SRCALPHA/ONE, else
 * SRCALPHA/INVSRCALPHA); an after-sky draw stays in the transparent list.
 */
function applySkyPass(mat: THREE.MeshLambertMaterial, surf: ParticleSurface, pass: ParticleSkyPass): void {
  mat.depthTest = false;
  mat.depthWrite = false;
  mat.transparent = pass.afterWorld;
  mat.blending = THREE.CustomBlending;
  mat.blendEquation = THREE.AddEquation;
  mat.blendSrc = THREE.SrcAlphaFactor;
  mat.blendDst = surf.additive ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor;
  mat.needsUpdate = true;
}

/** One instanced draw: a (GfxObj, surface) submesh of the emitter's chain. */
interface ParticleDraw {
  mesh: THREE.InstancedMesh;
  alpha: THREE.InstancedBufferAttribute;
  surface: ParticleSurface;
  /** The landscape-pass material (built at construction). */
  landscape: THREE.MeshLambertMaterial;
  /** The env-cell-pass material (built on first use; never for a delayed draw). */
  cell: THREE.MeshLambertMaterial | null;
  /** Retail draws it from the alpha list (particleDrawsFromDelayedList): the landscape light set even inside a cell. */
  delayed: boolean;
}

/** The GR particle types — Particle::Update copies the frame and spins it by C·t. */
function isSpinningType(t: number): boolean {
  return t === ParticleType.ParabolicLVGAGR || t === ParticleType.ParabolicLVLALR || t === ParticleType.ParabolicGVGAGR;
}

/**
 * ParticleSystem — runtime particle emitter driven by ParticleEmitterInfo data.
 *
 * ACE-exact (FAITHFUL.604), anchored against
 * reference/ACE/Source/ACE.Server/Physics/Particles/:
 *
 * - `birthrate` is the INTERVAL between emissions in seconds, not a rate:
 *   ParticleEmitterInfo.ShouldEmitParticle emits when
 *   `CurrentTime - lastEmitTime > Birthrate`. (The previous implementation
 *   computed `interval = 1/birthrate`, so a fast 0.05s emitter emitted once
 *   every 20s and vice versa.)
 * - Spawn offsets are random directions PERPENDICULAR to `offsetDir`
 *   (GetRandomOffset: rng - offsetDir·dot), scaled by `maxOffset * rand`.
 * - A/B/C are randomized once per particle (GetRandomA/B/C) and masked by
 *   particleType (Particle.Init): e.g. the GR parabolic types (4/9/11) keep
 *   C as the part-frame rotation rate.
 * - Positions are CLOSED-FORM by lifetime (Particle.Update), not Euler
 *   integration — exact at any frame rate (the old integrator drifted at
 *   the capture tab's ~12fps).
 * - `startTrans/finalTrans` are TRANSLUCENCY (1 = invisible), matching
 *   PhysicsPart.SetTranslucency and Surface.translucency semantics; opacity
 *   is `1 - trans`. (Previously read as opacity, inverting every fade.)
 * - Scale/translucency interpolate linearly by `min(lifetime/lifespan, 1)`.
 *
 * Rendering (VISUAL.particles-oriented-quads) follows CPhysicsPart::Draw:
 * each particle is the emitter's HW GfxObj mesh (ParticleGfx), one
 * InstancedMesh per (GfxObj, surface) so an emitter costs one draw call,
 * with a per-instance matrix = the particle's position, its part-frame
 * orientation (identity, or the parent frame spun by C·t for the GR types)
 * re-oriented by the degrade level's mode (billboard / about Z), and its
 * uniform gfxobj_scale; per-instance alpha = 1 − translucency. The degrade
 * chain also culls: a particle whose level is INVALID, or an emitter
 * beyond its max degrade distance, draws nothing. Additive surfaces blend
 * additively — the retail luminous-glow path portal space (VISUAL.1) and
 * the casting glows depend on. Every surface is LIT like an object part and
 * fogged unless Additive (makeParticleMaterial, VISUAL.particle-surfaces-unlit).
 */
/**
 * Systems drawn with an untextured white surface (no sprite, or a texture that
 * was not resident): the streaming A/B gate compares this against whole DATs
 * (tools/streaming-ab.ts noWhiteParticles). On globalThis for the harness.
 */
export const particleStats = { whiteFallback: 0 };
(globalThis as { __acParticleStats?: typeof particleStats }).__acParticleStats = particleStats;

export class ParticleSystem {
  private emitterInfo: ParticleEmitterInfo;
  private particles: Particle[] = [];
  /** REND.per-frame-allocations — expired particles, reused by spawnParticle. */
  private pool: Particle[] = [];
  private lastEmitTime = 0;
  /** Emissions RecordParticleEmission counted while degraded out (part of num_particles). */
  private recordedEmissions = 0;
  /** The parent frame is gone (see readFrame). */
  private parentGone = false;
  private disposed = false;
  private totalEmitted = 0;
  private elapsedTime = 0;
  private stopped = false;
  /** The system's root (hidden by owners); holds `drawRoot`. */
  private readonly root = new THREE.Group();
  /** Hidden while the emitter is beyond its degrade distance (ShouldDrawParticles). */
  private readonly drawRoot = new THREE.Group();
  private readonly gfx: ParticleGfx;
  private readonly draws: ParticleDraw[] = [];
  /** Draw indices per ParticleGfx.gfxObjs entry. */
  private readonly drawsByGfx: number[][];
  /** Instances written per draw this frame (scratch). */
  private readonly drawCounts: number[];
  private readonly maxDegradeDistance: number;
  /** Per-particle simulated state (three.js axes; system space). */
  private positions: Float32Array;
  private scales: Float32Array;
  private alphas: Float32Array;
  private quats: Float32Array;
  private view: ParticleView | null = null;
  private frameSource: ParticleFrameSource | null;
  /** World-frame mode: the parent frame this tick (AC-axes origin + THREE quaternion). */
  private readonly frameOrigin = new THREE.Vector3();
  private readonly frameQuat = new THREE.Quaternion();
  private frameValid = false;
  /** The frame source's current landblock origin (AC axes; zero without cellOrigin). */
  private readonly frameCell = new THREE.Vector3();
  /** GameSky::Draw's sky pass for a sky object's emitter (null = the world pass). */
  private skyPass: ParticleSkyPass | null = null;
  /** BirthratePerMeter: the emitter origin at the last emission (RecordParticleEmission). */
  private lastEmitOrigin: THREE.Vector3 | null = null;
  /** The pass the draws are in: false = landscape (the sun), true = an env cell (the pool lights). */
  private inCellPass = false;
  /** Fog on the non-additive surfaces (off for GameSky's sky objects). */
  private fogEnabled = true;
  private readonly tint: THREE.Color;
  /** The emitter's particles carry a translucency (start/final/rand) — their part material has alpha. */
  private readonly fades: boolean;

  constructor(info: ParticleEmitterInfo, color = 0xffffff, sprite?: ParticleSpriteOptions, frameSource?: ParticleFrameSource) {
    this.emitterInfo = info;
    this.frameSource = frameSource ?? null;
    if (this.frameSource) this.readFrame();

    const maxPts = Math.max(info.maxParticles, 1);
    // RENDER.particle-surface-state — any particle translucency other than 0
    // gives the part a material alpha (makeParticleMaterial `fades`).
    this.fades = info.startTrans !== 0 || info.finalTrans !== 0 || info.transRand !== 0;
    this.positions = new Float32Array(maxPts * 3);
    this.scales = new Float32Array(maxPts);
    this.alphas = new Float32Array(maxPts);
    this.quats = new Float32Array(maxPts * 4);

    this.gfx = sprite?.gfx ?? fallbackParticleGfx(sprite?.sizeScale ?? 1, sprite?.map ?? null, sprite?.additive ?? false);
    if (this.gfx.gfxObjs.some((subs) => subs.some((sub) => !sub.surface.map && sub.surface.color === 0xffffff))) particleStats.whiteFallback++;
    this.maxDegradeDistance = particleMaxDegradeDistance(this.gfx.degrades);
    this.drawsByGfx = this.gfx.gfxObjs.map(() => []);
    const tint = this.tint = new THREE.Color(color);
    this.gfx.gfxObjs.forEach((submeshes, gfxIndex) => {
      for (const sub of submeshes) {
        // Per-system copy of the (cached, a few vertices) GfxObj geometry plus
        // this system's per-instance alpha — its own GPU buffers, so disposing
        // one system never frees another's (shared BufferAttributes would
        // leave the other geometries' bindings on deleted buffers).
        const geometry = sub.geometry.clone();
        const alpha = new THREE.InstancedBufferAttribute(new Float32Array(maxPts), 1);
        alpha.setUsage(THREE.DynamicDrawUsage);
        geometry.setAttribute('instanceAlpha', alpha);
        const surf = sub.surface;
        const material = makeParticleMaterial(surf, tint, 'object', true, this.fades);
        const mesh = new THREE.InstancedMesh(geometry, material, maxPts);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.count = 0;
        mesh.frustumCulled = false;
        mesh.name = `particle_gfx${gfxIndex}`;
        this.drawsByGfx[gfxIndex].push(this.draws.length);
        this.draws.push({ mesh, alpha, surface: surf, landscape: material, cell: null,
          delayed: particleDrawsFromDelayedList(surf, this.fades) });
        this.drawRoot.add(mesh);
      }
    });
    this.drawCounts = this.draws.map(() => 0);
    this.root.add(this.drawRoot);

    // Initial burst — ParticleEmitter::InitEnd @ 0051d400 emits
    // initial_particles (ACE's port emits TotalParticles instead). A world-
    // frame emitter whose parent is already gone emits nothing.
    this.syncLightingPass();
    const burst = this.frameSource && !this.frameValid ? 0 : Math.min(info.initialParticles, info.maxParticles);
    for (let i = 0; i < burst; i++) {
      this.spawnParticle();
    }
    this.updateBuffers();
  }

  /** The system's scene node (a Group of instanced meshes). */
  get object3D(): THREE.Object3D {
    return this.root;
  }

  /**
   * VISUAL.particle-surfaces-unlit — draw in the parent's pass: the landscape
   * pass (sun + ambient) or, for a parent in an env cell, the cell pass (the
   * pool lights, no sun). Retail's particle object lives in its parent's
   * cell, and PView::DrawCells / DrawBlock pick the light set per cell.
   * A delayed draw (particleDrawsFromDelayedList) keeps the landscape
   * material in a cell: retail flushes it under the sun set.
   */
  private syncLightingPass(): void {
    const inCell = this.frameSource?.inCell?.() ?? false;
    if (inCell === this.inCellPass) return;
    this.inCellPass = inCell;
    for (const d of this.draws) {
      if (d.delayed) continue;
      if (inCell && !d.cell) {
        d.cell = makeParticleMaterial(d.surface, this.tint, 'cellobject', this.fogEnabled, this.fades);
        if (this.skyPass) applySkyPass(d.cell, d.surface, this.skyPass);
      }
      d.mesh.material = inCell ? d.cell! : d.landscape;
    }
  }

  /**
   * GameSky::Draw @ 00506ff0 draws the sky objects (and their emitters) with
   * D3D fog off unless an Environs fog override is up — a sky emitter's
   * particles are not fogged.
   */
  setFogEnabled(enabled: boolean): void {
    if (enabled === this.fogEnabled) return;
    this.fogEnabled = enabled;
    for (const d of this.draws) {
      for (const m of [d.landscape, d.cell]) {
        if (!m) continue;
        m.fog = enabled && !d.surface.additive;
        m.needsUpdate = true;
      }
    }
  }

  /**
   * Draw this emitter in GameSky's sky pass (ParticleSkyPass) — set once,
   * right after construction, for a sky object's emitter.
   */
  setSkyPass(pass: ParticleSkyPass): void {
    this.skyPass = { ...pass };
    for (const d of this.draws) {
      d.mesh.renderOrder = pass.renderOrder;
      for (const m of [d.landscape, d.cell]) if (m) applySkyPass(m, d.surface, pass);
    }
    this.writeInstances();
  }

  /** The sky pass this emitter draws in (null = the world pass). */
  get skyPassState(): Readonly<ParticleSkyPass> | null {
    return this.skyPass;
  }

  /** The draw node's transform (the sky pass's view scale about the viewer). */
  get drawNode(): THREE.Object3D {
    return this.drawRoot;
  }

  /** The draws' current material pass: 'object' (landscape) or 'cellobject' (env cell). */
  get lightingPass(): 'object' | 'cellobject' {
    return this.inCellPass ? 'cellobject' : 'object';
  }

  /** The instanced draws (one per GfxObj surface) — probes / tests. */
  get meshes(): readonly THREE.InstancedMesh[] {
    return this.draws.map(d => d.mesh);
  }

  /** Instances drawn this frame across all draws (culled particles excluded). */
  get drawnCount(): number {
    if (!this.drawRoot.visible) return 0;
    let n = 0;
    for (const d of this.draws) n += d.mesh.count;
    return n;
  }

  /** Live particle `i`'s position (three.js axes; world for a parented emitter, else system-local). */
  positionAt(i: number, out = new THREE.Vector3()): THREE.Vector3 {
    return out.fromArray(this.positions, i * 3);
  }

  /** Live particle `i`'s gfxobj_scale (Particle::Update's lerped scale). */
  scaleAt(i: number): number {
    return this.scales[i];
  }

  /** Live particle `i`'s opacity (1 − translucency). */
  alphaAt(i: number): number {
    return this.alphas[i];
  }

  /** Live particle `i`'s part-frame orientation before calc_draw_frame (three.js). */
  orientationAt(i: number, out = new THREE.Quaternion()): THREE.Quaternion {
    return out.fromArray(this.quats, i * 4);
  }

  get activeCount(): number {
    return this.particles.length;
  }

  get totalEmittedCount(): number {
    return this.totalEmitted;
  }

  /** True once the emitter no longer emits (StopEmitter / StopParticleEmitter). */
  get isStopped(): boolean {
    return this.stopped;
  }

  /**
   * Stopped and every particle dead — ParticleEmitter::UpdateParticles
   * returns 0 and the manager deletes the emitter.
   */
  get isDone(): boolean {
    // DECOMP.degraded-emitters-simulate — num_particles counts the emissions
    // recorded while degraded out; an emitter whose parent is gone has no
    // object left to hold it, so only its real particles keep it.
    return this.stopped && (this.parentGone ? this.particles.length : this.numParticles) === 0;
  }

  /** Disposed (removed from its manager) — no longer a live emitter. */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /** The parent object's mesh `from` was rebuilt as `to` (ParticleFrameSource.rebind). */
  rebindParent(from: THREE.Object3D, to: THREE.Object3D): void {
    this.frameSource?.rebind?.(from, to);
  }

  /** True when particles are simulated in world space against a parent frame. */
  get isWorldSpace(): boolean {
    return this.frameSource !== null;
  }

  /**
   * ParticleManager::StopParticleEmitter @ 0051b7b0 (the StopParticle hook):
   * set the emitter's stopped flag — no new particles; the live ones play out.
   */
  stop(): void {
    this.stopped = true;
  }

  /**
   * The viewer + degrade preferences the particles are drawn against
   * (CPhysicsPart::UpdateViewerDistance / calc_draw_frame). Re-lays the
   * instances immediately; update() keeps using the latest view.
   */
  setView(view: ParticleView | null): void {
    this.view = view;
    this.writeInstances();
  }

  /**
   * BUG.bunker-terrain-over-stairs — a world-space system's parent frame origin in world
   * coordinates (three.js axes), or null before its first frame: the node itself stays at the
   * scene origin, so the indoor view sorts the system by where its parent is (scene/IndoorView.ts).
   */
  anchorWorldPosition(out: THREE.Vector3): THREE.Vector3 | null {
    if (!this.frameSource || !this.frameValid) return null;
    const x = this.frameOrigin.x + this.frameCell.x, y = this.frameOrigin.y + this.frameCell.y, z = this.frameOrigin.z + this.frameCell.z;
    return out.set(x, z, y); // AC (z-up) → three (y-up)
  }

  /** Emitter origin (AC axes) = parent frame ∘ hook offset, in the parent's current cell. */
  private emitterOrigin(out: THREE.Vector3): THREE.Vector3 {
    const off = this.frameSource!.offset;
    return this.toGlobal(out.set(off.x, off.y, off.z)).add(this.frameOrigin).add(this.frameCell);
  }

  /** Refresh the parent frame; a vanished parent stops the emitter. */
  private readFrame(): void {
    const src = this.frameSource;
    if (!src) return;
    const pos = ParticleSystem.tmpFramePos;
    if (src.getFrame(pos, this.frameQuat)) {
      // THREE (y-up) → AC (z-up): swap y/z.
      this.frameOrigin.set(pos.x, pos.z, pos.y);
      this.frameValid = true;
      if (src.cellOrigin) {
        src.cellOrigin(pos);
        this.frameCell.set(pos.x, pos.z, pos.y);
      }
    } else {
      this.stopped = true;
      this.parentGone = true;
    }
  }

  /**
   * AFrame::LocalToGlobalVec for an AC-axes vector: rotate by the parent
   * orientation. The THREE quaternion acts on THREE axes, so swap in and out.
   */
  private toGlobal(v: THREE.Vector3): THREE.Vector3 {
    if (!this.frameSource) return v;
    const t = ParticleSystem.tmpSwap.set(v.x, v.z, v.y).applyQuaternion(this.frameQuat);
    return v.set(t.x, t.z, t.y);
  }

  /**
   * ParticleEmitter::UpdateParticles @ 0051d180 — advance the emitter by
   * deltaTime seconds. Drawn (ShouldDrawParticles): every live particle
   * updates and dies at the end of its lifespan (Particle::Update /
   * KillParticle), then AT MOST ONE particle is emitted
   * (ShouldEmitParticle → EmitParticle) and the caps are checked
   * (StopEmitter). Degraded out (beyond the emitter's degrade distance) it
   * takes the else-branch: see updateDegradedOut.
   */
  update(deltaTime: number): void {
    this.elapsedTime += deltaTime;
    if (this.frameSource) {
      this.readFrame();
      this.syncLightingPass();
    }

    if (!this.shouldDrawParticles()) {
      this.updateDegradedOut(deltaTime);
      return;
    }

    this.killExpired();
    if (!this.stopped) {
      if (this.shouldEmitParticle()) this.spawnParticle();
      this.stopEmitter();
    }
    this.updateBuffers();
  }

  /**
   * UpdateParticles' degraded-out branch (:276390-400): the particles are not
   * drawn (SetNoDraw) and
   *  - a persistent emitter (no time or count bound) freezes: every
   *    particle's birthtime is reset to now, so its lifetime stops advancing
   *    (Particle::Update accumulates lifetime for persistent emitters);
   *  - a bounded one keeps ageing its particles and killing the expired, and
   *    counts the emissions it would have made without making them
   *    (RecordParticleEmission @ 0051c870 — num_particles and total_emitted
   *    grow, last emit time/offset move), then StopEmitter.
   */
  private updateDegradedOut(deltaTime: number): void {
    const info = this.emitterInfo;
    this.drawRoot.visible = false;
    if (info.totalParticles <= 0 && info.totalSeconds <= 0) {
      for (const p of this.particles) p.birth += deltaTime;
      return;
    }
    this.killExpired();
    if (this.stopped) return;
    if (this.shouldEmitParticle()) this.recordParticleEmission();
    this.stopEmitter();
  }

  /** KillParticle for every live particle: lifetime ≥ lifespan. */
  private killExpired(): void {
    // REND.per-frame-allocations — one stable compaction pass (O(n), was a
    // splice per death = O(n²)); survivors keep their relative order, which
    // is the buffer / draw order of the normal-blended (non-additive)
    // emitters. Dead particles go back to the pool for reuse.
    const ps = this.particles;
    let w = 0;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      if (this.elapsedTime - p.birth >= p.lifespan) this.pool.push(p);
      else ps[w++] = p;
    }
    ps.length = w;
  }

  /**
   * ParticleEmitter::num_particles — the live particles plus the emissions
   * recorded while degraded out (RecordParticleEmission counts a particle it
   * never creates, and nothing ever un-counts it).
   */
  get numParticles(): number {
    return this.particles.length + this.recordedEmissions;
  }

  /**
   * ParticleEmitter::ShouldEmitParticle @ 0051c8b0 → ParticleEmitterInfo::
   * ShouldEmitParticle @ 00517420: not past the total, below max_particles,
   * and — per second — more than `birthrate` seconds since the last
   * emission, or — per metre — the emitter moved more than `birthrate`
   * metres since it (squared compare). Only an emitter riding a moving
   * parent (a casting hand) ever moves.
   */
  private shouldEmitParticle(): boolean {
    const info = this.emitterInfo;
    if (info.totalParticles > 0 && this.totalEmitted >= info.totalParticles) return false;
    if (this.numParticles >= info.maxParticles) return false;
    if (info.emitterType === EmitterType.BirthratePerSec) {
      return this.elapsedTime - this.lastEmitTime > info.birthrate;
    }
    if (info.emitterType === EmitterType.BirthratePerMeter) {
      if (!this.frameSource || !this.frameValid) return false;
      const here = this.emitterOrigin(ParticleSystem.tmpEmit);
      return !this.lastEmitOrigin || here.distanceToSquared(this.lastEmitOrigin) > info.birthrate * info.birthrate;
    }
    return false;
  }

  /** ParticleEmitter::StopEmitter @ 0051c230: stop past total_seconds or at total_particles. */
  private stopEmitter(): void {
    if (this.stopped) return;
    const info = this.emitterInfo;
    if (info.totalSeconds > 0 && this.elapsedTime > info.totalSeconds) this.stopped = true;
    if (info.totalParticles > 0 && this.totalEmitted >= info.totalParticles) this.stopped = true;
  }

  /** RecordParticleEmission @ 0051c870: an emission counted but not made. */
  private recordParticleEmission(): void {
    this.recordedEmissions++;
    this.totalEmitted++;
    this.lastEmitTime = this.elapsedTime;
    if (this.frameSource && this.frameValid) {
      this.lastEmitOrigin = this.emitterOrigin(this.lastEmitOrigin ?? new THREE.Vector3());
    }
  }

  /** True while the emitter is beyond its degrade distance (UpdateParticles' degraded_out). */
  get isDegradedOut(): boolean {
    return !this.drawRoot.visible;
  }

  /**
   * ParticleEmitterInfo::GetRandomOffset @ 005174a0 — a random direction
   * perpendicular to offsetDir, magnitude min + (max − min)·rand(0,1).
   * (ACE's port collapses the magnitude to maxOffset·rand; the retail
   * client does not.)
   */
  private randomOffset(out: THREE.Vector3): THREE.Vector3 {
    const info = this.emitterInfo;
    const rng = ParticleSystem.tmpRng.set(
      Math.random() * 2 - 1,
      Math.random() * 2 - 1,
      Math.random() * 2 - 1,
    );
    const dir = ParticleSystem.tmpDir.set(info.offsetDir.x, info.offsetDir.y, info.offsetDir.z);
    const perp = out.copy(rng).sub(dir.multiplyScalar(rng.dot(dir)));
    if (perp.lengthSq() < 1e-10) return out.set(0, 0, 0);
    perp.normalize();
    return perp.multiplyScalar((info.maxOffset - info.minOffset) * Math.random() + info.minOffset);
  }

  /** GetRandom{Start,Final}Scale @ 005170d0/00517120: ±scaleRand, clamped to [0.1, 10]. */
  private randomScale(base: number): number {
    const v = (Math.random() * 2 - 1) * this.emitterInfo.scaleRand + base;
    return Math.min(Math.max(v, MINIMUM_SCALE), MAXIMUM_SCALE);
  }

  /** GetRandom{Start,Final}Trans @ 00517170/005171c0: ±transRand, clamped to [0, 1]. */
  private randomTrans(base: number): number {
    const v = (Math.random() * 2 - 1) * this.emitterInfo.transRand + base;
    return Math.min(Math.max(v, 0), 1);
  }

  /** ParticleEmitter::EmitParticle @ 0051d010 → Particle::Init @ 0051c930. */
  private spawnParticle(): void {
    const birthTime = this.elapsedTime;
    const info = this.emitterInfo;

    // REND.per-frame-allocations — reuse a dead particle's vectors (pool)
    // and module scratch for the unmasked a/b/c; no per-spawn Vector3s.
    const p = this.pool.pop() ?? {
      birth: 0, lifespan: 0, origin: new THREE.Vector3(), quat: new THREE.Quaternion(), cell: new THREE.Vector3(),
      startScale: 1, finalScale: 1, startTrans: 0, finalTrans: 0,
      offset: new THREE.Vector3(), a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(),
    };

    // EmitParticle's draw order: lifespan, final/start trans, final/start
    // scale, C, B, A, offset.
    const lifespan = Math.max(0, info.lifespan + (Math.random() * 2 - 1) * info.lifespanRand);
    p.finalTrans = this.randomTrans(info.finalTrans);
    p.startTrans = this.randomTrans(info.startTrans);
    p.finalScale = this.randomScale(info.finalScale);
    p.startScale = this.randomScale(info.startScale);
    // GetRandomA/B/C: vector * (min + rand*(max-min))
    const randMag = (min: number, max: number) => (max - min) * Math.random() + min;
    const c = ParticleSystem.tmpC.set(info.c.x, info.c.y, info.c.z).multiplyScalar(randMag(info.minC, info.maxC));
    const b = ParticleSystem.tmpB.set(info.b.x, info.b.y, info.b.z).multiplyScalar(randMag(info.minB, info.maxB));
    const a = ParticleSystem.tmpA.set(info.a.x, info.a.y, info.a.z).multiplyScalar(randMag(info.minA, info.maxA));
    const offset = this.randomOffset(p.offset);

    // Particle::Init: StartFrame = the parent (or its part) frame now;
    // Offset = StartFrame.localtoglobalvec(ParentOffset + random offset).
    // Without a parent frame (a bare system) the frame is the identity.
    if (this.frameSource) {
      const off = this.frameSource.offset;
      this.toGlobal(offset.add(ParticleSystem.tmpSwap.set(off.x, off.y, off.z)));
      p.origin.copy(this.frameOrigin);
      p.quat.copy(this.frameQuat);
      // AddPartToShadowCells @ 00510e00: the part keeps this cell for life.
      p.cell.copy(this.frameCell);
      // RecordParticleEmission: last_emit_offset = the emitter's position.
      this.lastEmitOrigin = this.emitterOrigin(this.lastEmitOrigin ?? new THREE.Vector3());
    } else {
      p.origin.set(0, 0, 0);
      p.quat.identity();
      p.cell.set(0, 0, 0);
    }

    // Particle::Init's per-type switch, fall-throughs included: the local
    // (LV / LVLA) vectors rotate into the start frame, the global ones and
    // the swarm's B/C stay as authored. Unlisted vectors stay 0.
    const A = p.a.set(0, 0, 0);
    const B = p.b.set(0, 0, 0);
    const C = p.c.set(0, 0, 0);
    switch (info.particleType) {
      case ParticleType.Still:
        break;
      case ParticleType.ParabolicLVGAGR: // C, then falls into LVGA
        C.copy(c);
      // falls through
      case ParticleType.ParabolicLVGA: // B, then falls into LocalVelocity
        B.copy(b);
      // falls through
      case ParticleType.LocalVelocity:
        A.copy(this.toGlobal(a));
        break;
      case ParticleType.Swarm:
        A.copy(this.toGlobal(a)); B.copy(b); C.copy(c);
        break;
      case ParticleType.Explode: {
        A.copy(a); B.copy(b);
        // Random direction on a sphere, component-scaled by c, normalized
        // (the z component is sin(po)·c.z — no cos(po) factor).
        const ra = Math.random() * 2 * Math.PI - Math.PI;
        const po = Math.random() * 2 * Math.PI - Math.PI;
        const rb = Math.cos(po);
        C.set(Math.cos(ra) * c.x * rb, Math.sin(ra) * c.y * rb, Math.sin(po) * c.z);
        if (C.lengthSq() < 1e-10) C.set(0, 0, 0);
        else C.normalize();
        break;
      }
      case ParticleType.Implode:
        A.copy(a); B.copy(b);
        offset.multiply(c);
        C.copy(offset);
        break;
      case ParticleType.ParabolicLVLALR: // C (rotated), then falls into LVLA
        C.copy(this.toGlobal(c));
      // falls through
      case ParticleType.ParabolicLVLA:
        B.copy(this.toGlobal(b));
        A.copy(this.toGlobal(a));
        break;
      case ParticleType.ParabolicGVGAGR: // C, then falls into GVGA
        C.copy(c);
      // falls through
      case ParticleType.ParabolicGVGA: // B, then falls into GlobalVelocity
        B.copy(b);
      // falls through
      case ParticleType.GlobalVelocity:
        A.copy(a);
        break;
      default:
        A.copy(a); B.copy(b); C.copy(c);
        break;
    }

    p.birth = birthTime;
    p.lifespan = Math.max(lifespan, 0.01);
    this.particles.push(p);
    this.totalEmitted++;
    this.lastEmitTime = birthTime;
  }

  /** Particle::Update @ 0051c290 — closed-form position by lifetime (frame-rate exact). */
  private positionOf(p: Particle, out: THREE.Vector3): THREE.Vector3 {
    const t = this.elapsedTime - p.birth;
    const info = this.emitterInfo;
    switch (info.particleType) {
      case ParticleType.Still:
        return out.copy(p.offset);
      case ParticleType.LocalVelocity:
      case ParticleType.GlobalVelocity:
        return out.copy(p.a).multiplyScalar(t).add(p.offset);
      // The GR types move exactly like their parabolic bases (C spins the
      // part's frame — orientationOf).
      case ParticleType.ParabolicLVGA:
      case ParticleType.ParabolicLVLA:
      case ParticleType.ParabolicGVGA:
      case ParticleType.ParabolicLVGAGR:
      case ParticleType.ParabolicLVLALR:
      case ParticleType.ParabolicGVGAGR:
        // offset + A·t + B·t²/2
        return out.copy(p.b).multiplyScalar(t * t * 0.5)
          .addScaledVector(p.a, t).add(p.offset);
      case ParticleType.Swarm:
        // A·t + (cos(B.x t)·C.x, sin(B.y t)·C.y, cos(B.z t)·C.z) + offset —
        // an orbit of radius C (ACE's port adds C and a unit cos/sin instead).
        return out.set(
          p.a.x * t + Math.cos(p.b.x * t) * p.c.x + p.offset.x,
          p.a.y * t + Math.sin(p.b.y * t) * p.c.y + p.offset.y,
          p.a.z * t + Math.cos(p.b.z * t) * p.c.z + p.offset.z,
        );
      case ParticleType.Explode:
        // x/y: (C·A.x + B·t)·t; z also carries A.z: (C.z·A.x + B.z·t + A.z)·t
        return out.set(
          (p.c.x * p.a.x + p.b.x * t) * t + p.offset.x,
          (p.c.y * p.a.x + p.b.y * t) * t + p.offset.y,
          (p.c.z * p.a.x + p.b.z * t + p.a.z) * t + p.offset.z,
        );
      case ParticleType.Implode:
        // cos(A.x·t)·C + B·t² + offset
        return out.copy(p.c).multiplyScalar(Math.cos(p.a.x * t))
          .addScaledVector(p.b, t * t).add(p.offset);
      default:
        return out.copy(p.offset);
    }
  }

  /**
   * The particle part's frame orientation (three.js) — Particle::Update
   * @ 0051c290. Only the GR types (4 / 9 / 11) write the part's frame: the
   * parent frame (parent-local) or the StartFrame, then `Frame::rotate(C·t)`
   * @ 004525b0 — C·t taken as a rotation vector in THAT frame's local axes
   * (localtoglobal, then Frame::grotate @ 005357a0 premultiplies the
   * axis-angle quaternion). Every other type only moves the part's origin,
   * so its frame stays the identity: world axes (system axes for a bare
   * system). The AC→three y/z swap is a reflection, so the three.js
   * rotation is about (C.x, C.z, C.y) by −|C|·t.
   */
  private orientationOf(p: Particle, out: THREE.Quaternion): THREE.Quaternion {
    if (!isSpinningType(this.emitterInfo.particleType)) return out.identity();
    const base = this.frameSource ? (this.emitterInfo.isParentLocal ? this.frameQuat : p.quat) : ParticleSystem.IDENTITY;
    const t = this.elapsedTime - p.birth;
    const axis = ParticleSystem.tmpAxis.set(p.c.x, p.c.z, p.c.y);
    const rate = axis.length();
    // grotate ignores a rotation vector below F_EPSILON (0.0002).
    if (rate * t < 0.0002) return out.copy(base);
    axis.divideScalar(rate);
    return out.copy(base).multiply(ParticleSystem.tmpSpin.setFromAxisAngle(axis, -rate * t));
  }

  private static readonly IDENTITY = new THREE.Quaternion();
  private static readonly tmpVec = new THREE.Vector3();
  private static readonly tmpSwap = new THREE.Vector3();
  private static readonly tmpEmit = new THREE.Vector3();
  private static readonly tmpFramePos = new THREE.Vector3();
  private static readonly tmpRng = new THREE.Vector3();
  private static readonly tmpDir = new THREE.Vector3();
  private static readonly tmpA = new THREE.Vector3();
  private static readonly tmpB = new THREE.Vector3();
  private static readonly tmpC = new THREE.Vector3();
  private static readonly tmpAxis = new THREE.Vector3();
  private static readonly tmpSpin = new THREE.Quaternion();
  private static readonly tmpQuat = new THREE.Quaternion();
  private static readonly tmpDrawQuat = new THREE.Quaternion();
  private static readonly tmpPos = new THREE.Vector3();
  private static readonly tmpScale = new THREE.Vector3();
  private static readonly tmpMatrix = new THREE.Matrix4();
  private static readonly tmpInverse = new THREE.Matrix4();
  private static readonly tmpViewer = new THREE.Vector3();
  private static readonly tmpEmitter = new THREE.Vector3();
  private static readonly tmpAnchor = new THREE.Vector3();
  private static readonly tmpHeadingSrc = new THREE.Vector3();
  private static readonly tmpSort = new THREE.Vector3();

  /** Particle::Update for every live particle: position, orientation, scale, translucency. */
  private updateBuffers(): void {
    const info = this.emitterInfo;
    const v = ParticleSystem.tmpVec;
    const q = ParticleSystem.tmpQuat;

    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      this.positionOf(p, v);
      // World-frame mode (Particle::Update's `parent` frame): a parent-local
      // particle rides the parent's CURRENT origin; any other keeps its
      // StartFrame origin (it stays where it was emitted).
      // The frame is local to the particle's stamped cell (zero unless the
      // frame source stamps cells).
      if (this.frameSource) v.add(info.isParentLocal ? this.frameOrigin : p.origin).add(p.cell);
      // Particle kinematics run in AC space (z-up) because the emitter's
      // offsetDir/A/B/C come straight from the DAT and the closed forms are
      // per-axis (Swarm: cos on x, sin on y, cos on z — a HORIZONTAL orbit
      // in AC). Convert to THREE (y-up) only here — feeding AC vectors
      // straight through made e.g. the portal vortex orbit in a vertical
      // plane and its sink motion drift sideways
      // (VISUAL.portal-renders-opaque-white follow-through).
      this.positions[i * 3] = v.x;
      this.positions[i * 3 + 1] = v.z;
      this.positions[i * 3 + 2] = v.y;
      this.orientationOf(p, q).toArray(this.quats, i * 4);

      // min(lifetime/lifespan, 1) — linear scale + translucency interp
      const k = Math.min((this.elapsedTime - p.birth) / p.lifespan, 1);
      const scale = p.startScale + (p.finalScale - p.startScale) * k;
      const trans = p.startTrans + (p.finalTrans - p.startTrans) * k;
      this.scales[i] = scale;
      // trans is TRANSLUCENCY (1 = invisible): opacity = 1 - trans
      this.alphas[i] = Math.max(0, Math.min(1, 1 - trans));
    }

    this.writeInstances();
  }

  /** The viewer in system space (a bare/anchored system is local to its node); null without a view. */
  private viewerInSystem(): THREE.Vector3 | null {
    if (!this.view) return null;
    const viewer = ParticleSystem.tmpViewer.copy(this.view.viewer);
    if (!this.frameSource) {
      this.root.updateWorldMatrix(true, false);
      viewer.applyMatrix4(ParticleSystem.tmpInverse.copy(this.root.matrixWorld).invert());
    }
    return viewer;
  }

  /** The particle object's position (three.js): the emitter origin (parent ∘ offset). */
  private emitterPosition(): THREE.Vector3 {
    const emitter = ParticleSystem.tmpEmitter;
    if (this.frameSource) {
      this.emitterOrigin(emitter);
      emitter.set(emitter.x, emitter.z, emitter.y);
    } else {
      emitter.set(0, 0, 0);
    }
    return emitter;
  }

  /**
   * CPhysicsObj::ShouldDrawParticles @ 0050fe60: the particle object's
   * viewer distance (its land cell's 2-D distance beyond
   * MAX_CELL_2D_DEGRADE_DISTANCE outdoors) within the emitter's degrade
   * distance. Always true without a view.
   */
  private shouldDrawParticles(): boolean {
    const viewer = this.viewerInSystem();
    if (!viewer) return true;
    const emitter = this.emitterPosition();
    const cellDist = this.frameSource?.inLandCell?.() ? landCellViewerDistance(emitter, viewer, ParticleSystem.tmpHeadingSrc) : 0;
    const cyPt = cellDist > MAX_CELL_2D_DEGRADE_DISTANCE ? cellDist : emitter.distanceTo(viewer);
    return cyPt <= this.maxDegradeDistance;
  }

  /**
   * Lay the live particles out as instances — CPhysicsObj::
   * UpdateViewerDistance @ 00510b30 → CPhysicsPart::UpdateViewerDistance
   * @ 0050e030 / @ 0050e1a0 → calc_draw_frame @ 0050dfa0, then Draw:
   *
   * - The emitter draws nothing beyond its degrade distance
   *   (ShouldDrawParticles @ 0050fe60, ParticleEmitter::UpdateParticles).
   * - The viewer distance + heading: per particle (its sort centre) while the
   *   emitter is within Render::particle_distance_2dsq (2-D); beyond it every
   *   particle takes the emitter's; an outdoor emitter beyond 50 m takes its
   *   land cell's 2-D distance (RenderDeviceD3D::UpdateObjCell).
   * - get_degrade(distance / scale): an INVALID level draws nothing; the
   *   level's mode re-orients the particle (billboard / about an axis).
   * - SetTranslucency(1) sets the part's no-draw bit.
   */
  private writeInstances(): void {
    const view = this.view;
    const gfx = this.gfx;
    const degrades = gfx.degrades;
    const counts = this.drawCounts;
    counts.fill(0);

    const viewer = this.viewerInSystem();
    const emitter = this.emitterPosition();
    // Sky pass: scale the draw about the viewer (retail's zfar × 4 frustum
    // onto ours). Simulation, distances and billboards stay in world units.
    if (this.skyPass && this.view) {
      const s = this.skyPass.viewScale;
      this.drawRoot.position.copy(this.view.viewer).multiplyScalar(1 - s);
      this.drawRoot.scale.setScalar(s);
    }
    // VISUAL.glow-vs-cutout-draw-order — a world-frame emitter's draws sit at
    // the scene origin with world-space instances, and three.js sorts the
    // transparent list by the object's own position, so a glow sorted as if
    // it stood at the origin and drew before the cut-outs behind it. Retail
    // delays every translucent / additive / clip-map part into the alpha
    // list (s_AlphaDelayMask = 14) and sorts it by the part's viewer
    // distance (D3DPolyRender::DrawMesh → AddMeshToAlphaList), so anchor the
    // draw at the emitter and write the instances relative to it.
    const anchor = this.frameSource && !this.skyPass ? ParticleSystem.tmpAnchor.copy(emitter) : null;
    if (anchor) this.drawRoot.position.copy(anchor);

    let shared: 'none' | 'emitter' | 'cell' = 'none';
    let sharedDist = 0;
    const headingSrc = ParticleSystem.tmpHeadingSrc;
    if (viewer) {
      const dx = emitter.x - viewer.x, dz = emitter.z - viewer.z;
      const emitterDist = emitter.distanceTo(viewer);
      const cellDist = this.frameSource?.inLandCell?.() ? landCellViewerDistance(emitter, viewer, headingSrc) : 0;
      let cyPt = emitterDist;
      if (cellDist > MAX_CELL_2D_DEGRADE_DISTANCE) {
        shared = 'cell'; sharedDist = cellDist; cyPt = cellDist;
      } else if (dx * dx + dz * dz >= (view!.particleDistance2dSq ?? STARTUP_PARTICLE_DISTANCE_2DSQ)) {
        shared = 'emitter'; sharedDist = emitterDist; headingSrc.copy(emitter);
      }
      // ShouldDrawParticles: CYpt <= degrade_distance.
      this.drawRoot.visible = cyPt <= this.maxDegradeDistance;
    } else {
      this.drawRoot.visible = true;
    }

    if (this.drawRoot.visible) {
      const pos = ParticleSystem.tmpPos;
      const base = ParticleSystem.tmpQuat;
      const drawQ = ParticleSystem.tmpDrawQuat;
      const scl = ParticleSystem.tmpScale;
      const m = ParticleSystem.tmpMatrix;
      const sortCenter = gfx.sortCenter;
      const hasSort = sortCenter.x !== 0 || sortCenter.y !== 0 || sortCenter.z !== 0;
      const degradeDistance = view?.degradeDistance ?? RETAIL_DEGRADE_PREFS.degradeDistance;
      const bias = view?.bias ?? RETAIL_DEGRADE_PREFS.adaptiveDegradeBias;
      for (let i = 0; i < this.particles.length; i++) {
        const alpha = this.alphas[i];
        if (alpha <= 0) continue;
        const s = this.scales[i];
        pos.fromArray(this.positions, i * 3);
        base.fromArray(this.quats, i * 4);
        let level = 0;
        let mode: number = DegradeMode.Normal;
        if (degrades.length > 0) {
          let src = headingSrc;
          let dist = sharedDist;
          if (viewer && shared === 'none') {
            src = ParticleSystem.tmpSort.copy(pos);
            if (hasSort) {
              src.add(ParticleSystem.tmpSwap.set(sortCenter.x, sortCenter.z, sortCenter.y).multiplyScalar(s).applyQuaternion(base));
            }
            dist = src.distanceTo(viewer);
          }
          if (viewer) {
            level = selectDegradeLevel(degrades, s > 0 ? dist / s : dist, degradeDistance, bias, view!.forceLevel ?? -1, view!.disabled ?? false);
          }
          mode = degrades[level].degradeMode;
          if (viewer && isBillboardMode(mode)) billboardRotation(mode, base, src, viewer, drawQ);
          else drawQ.copy(base);
        } else {
          drawQ.copy(base);
        }
        const g = gfx.levelGfx[level] ?? -1;
        if (g < 0) continue; // INVALID_DID: nothing drawn at this distance
        if (anchor) pos.sub(anchor);
        m.compose(pos, drawQ, scl.set(s, s, s));
        for (const di of this.drawsByGfx[g]) {
          const d = this.draws[di];
          const n = counts[di]++;
          d.mesh.setMatrixAt(n, m);
          d.alpha.setX(n, alpha);
        }
      }
    }

    for (let di = 0; di < this.draws.length; di++) {
      const d = this.draws[di];
      d.mesh.count = counts[di];
      d.mesh.instanceMatrix.needsUpdate = true;
      d.alpha.needsUpdate = true;
    }
  }

  dispose(): void {
    this.disposed = true;
    // This system's geometry copies, instance buffers and materials (the
    // resolved textures and the cached source geometry stay).
    for (const d of this.draws) {
      d.mesh.dispose();
      d.mesh.geometry.dispose();
      d.landscape.dispose();
      d.cell?.dispose();
    }
  }
}
