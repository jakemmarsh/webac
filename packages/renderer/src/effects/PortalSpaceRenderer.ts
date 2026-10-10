import * as THREE from 'three';
import type { DatDatabase } from '@ac/dat-parser/DatDatabase.js';
import { DatReader } from '@ac/dat-parser/DatReader.js';
import { Animation } from '@ac/dat-parser/file-types/Animation.js';
import { AnimationHookType, type AnimationHook, type SoundHookData, type SoundTweakedHookData } from '@ac/dat-parser/file-types/AnimationHook.js';
import { readDidMapper, type DidMapper } from '@ac/dat-parser/file-types/DidMapper.js';
import type { SetupModelRenderer } from '../models/SetupModelRenderer.js';
import { retailVerticalFovDeg } from '../scene/RetailCamera.js';
import { collectPartObjects, applyPartTransforms } from '../animation/AnimatedEntity.js';
import { HOOK_DIR_BOTH, HOOK_DIR_FORWARD } from '../animation/AnimationPlayer.js';
import { buildCreatureModeCamera, placeCreatureModeCamera, distantLightPosition } from '../ui/CreatureViewCamera.js';
import { currentObjectAmbientScale, setCellLighting, CULL_NONE_DEFINE } from '../models/RetailLighting.js';
import { TELEPORT_ANIM_FPS, fovForViewDistanceRatio } from './PortalSpaceModel.js';
import { datMissEpoch, noDatMissSince } from '@ac/dat-parser/streaming/DatMiss.js';

/**
 * PortalSpaceRenderer — retail's portal-space viewport, drawn as the client
 * draws it (the decompiled EoL client): no invented geometry, no fog, no
 * hand-tuned motion.
 *
 * gmSmartBoxUI::PostInit @ 004d5f40 builds it:
 * - teleportObj = CPhysicsObj::makeObject(DBObj::GetDIDByEnum(0x10000001))
 *   — DidMapper 0x25000010 maps that enum to Setup 0x02000306, two
 *   half-annulus parts (GfxObj 0x0100080B, the opaque backing 0x08000C32
 *   plus the translucent membrane 0x08000C31);
 * - the viewport 0x10000436 is a CreatureMode holding that object, with one
 *   DISTANT_LIGHT of 2.0 along (0.3, −1.9, 0.65), the camera at
 *   (0.24, −2.7, 0.88) looking along +y, and UseSmartboxFOV (the world's
 *   projection).
 * gmSmartBoxUI::UseTime @ 004d6e30, when the tunnel appears:
 * - teleportObj->set_sequence_animation(GetDIDByEnum(0x10000002), 1, 1,
 *   TELEPORT_ANIM_FPS) — enum 0x10000002 → Animation 0x030005AC (120 frames,
 *   2 parts), looped at 40 fps. The animation turns the two parts, which is
 *   what makes the walls stream and ripple.
 * - Every frame, CreatureMode::SetCameraDirection_Degrees((0, roll, 0)) —
 *   Frame::rotate about AC +y, the view axis (the roll PortalSpaceModel
 *   schedules).
 * - A fade overrides the SmartBox view distance, and this viewport follows
 *   it (UseSmartboxFOV).
 * - The animation's own hooks run as the frames pass (CSequence::
 *   execute_hooks): frame 2 carries a SoundTweaked hook (Wave 0x0A000316,
 *   3.01 s, vol 0.3, prob 1), so every 3 s loop restarts the wave — the
 *   continuous portal-space drone. Retail plays it at the object
 *   (SoundManager::PlaySoundA @ 005507a0); the object sits in CreatureMode's
 *   own cell a few metres from the viewport camera, inside VOL_MIN_DIST, so
 *   it is heard at its full hook volume.
 * The "In Portal Space - Please Wait..." text, the fades and the Enter/Exit
 * sounds are GameUI's (PortalSpaceModel.ts).
 */

/** DBObj::GetDIDByEnum's client table (the same DidMapper the chargen views read). */
export const PORTAL_DID_MAPPER = 0x25000010;
/** gmSmartBoxUI::PostInit: GetDIDByEnum(0x10000001) — the portal-space object's Setup. */
export const PORTAL_SETUP_ENUM = 0x10000001;
/** gmSmartBoxUI::UseTime: GetDIDByEnum(0x10000002) — its tunnel animation. */
export const PORTAL_ANIMATION_ENUM = 0x10000002;
/** The EoL DidMapper's values for those enums (asserted against the DAT by the tests; used only without a mapper). */
export const PORTAL_SETUP_ID = 0x02000306;
export const PORTAL_ANIMATION_ID = 0x030005ac;
/** gmSmartBoxUI::PostInit: CreatureMode::SetCameraPosition (0x3e75c28f, 0xc02ccccd, 0x3f6147ae). */
export const PORTAL_CAMERA_POSITION: readonly [number, number, number] = [0.24, -2.7, 0.88];
/** gmSmartBoxUI::PostInit: AddLight(DISTANT_LIGHT, 2.0) + SetLightDirection (0x3e99999a, 0xbff33333, 0x3f266666). */
export const PORTAL_LIGHT_INTENSITY = 2.0;
export const PORTAL_LIGHT_DIRECTION: readonly [number, number, number] = [0.3, -1.9, 0.65];
/** CreatureMode::CreatureMode @ 00454390 — m_clrAmbientLight (0.3, 0.3, 0.3). */
export const CREATURE_MODE_AMBIENT = 0.3;
/** Retail default m_fGameFOV (π/2) when the host cannot report the preference. */
const DEFAULT_GAME_FOV_DEG = 90;

/**
 * The portal viewport's VERTICAL angle: UseSmartboxFOV → the world camera's
 * projection, Render::SetFOVRad(m_fGameFOV / (aspect − 0.1)).
 */
export function portalSpaceVerticalFovDeg(gameFovDeg: number | undefined, aspect: number): number {
  return retailVerticalFovDeg(gameFovDeg ?? DEFAULT_GAME_FOV_DEG, aspect)
    ?? retailVerticalFovDeg(DEFAULT_GAME_FOV_DEG, aspect)
    ?? DEFAULT_GAME_FOV_DEG;
}

/** Resolve the Setup + Animation DIDs through the DidMapper (the shipped values without one). */
export function resolvePortalSpaceDids(mapper: DidMapper | null): { setup: number; animation: number } {
  return {
    setup: mapper?.client.enumToId.get(PORTAL_SETUP_ENUM) ?? PORTAL_SETUP_ID,
    animation: mapper?.client.enumToId.get(PORTAL_ANIMATION_ENUM) ?? PORTAL_ANIMATION_ID,
  };
}

/**
 * How a sound hook on the tunnel animation plays (CAnimHook::Execute on the
 * teleport object): a SoundTweaked hook passes PlayProbability (`rand <
 * prob`) and plays its wave at its own volume (SoundTweakedHook::Execute @
 * 00526a80); a plain Sound hook plays its wave at the effect-volume
 * preference (SoundManager::PlaySoundA(DID, obj) @ 00550730). Anything else
 * (a SoundTable hook — the teleport object has no sound table) is silent.
 */
export function portalSpaceHookSound(
  hook: AnimationHook,
  effectsPref: number,
  rng: () => number = Math.random,
): { waveId: number; volume: number } | null {
  if (hook.hookType === AnimationHookType.SoundTweaked) {
    const h = hook as SoundTweakedHookData;
    if (!(rng() < h.probability)) return null;
    return { waveId: h.soundId >>> 0, volume: h.volume };
  }
  if (hook.hookType === AnimationHookType.Sound) {
    return { waveId: (hook as SoundHookData).soundId >>> 0, volume: effectsPref };
  }
  return null;
}

/** The tunnel animation's frame at `seconds` since it started (looped, 40 fps, whole frames). */
export function portalAnimFrame(seconds: number, numFrames: number): number {
  if (numFrames <= 0) return 0;
  return Math.floor(Math.max(0, seconds) * TELEPORT_ANIM_FPS) % numFrames;
}

export class PortalSpaceRenderer {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private object: THREE.Group | null = null;
  /** The double-sided material copies this view owns (doubleSidedCopies). */
  private ownMaterials: THREE.Material[] = [];
  private parts: (THREE.Object3D | null)[] = [];
  private anim: Animation | null = null;
  private animStart: number | null = null;
  /** Whole frames since startAnimation whose hooks have run. */
  private hooksThrough = 0;
  /** CSequence::execute_hooks' target: every forward/both hook on a frame the loop leaves. */
  onHook: ((hook: AnimationHook) => void) | null = null;
  /** Milliseconds clock for the tunnel animation (performance.now; capture tooling pins it, GameUI.pinPortalSpace). */
  clock: () => number = () => performance.now();
  private readonly gameFovDeg: number | undefined;
  private aspect: number;
  private rollDeg = 0;
  private viewDistanceRatio: number | null = null;
  private baseQuat = new THREE.Quaternion();
  readonly domElement: HTMLCanvasElement;

  constructor(
    width: number,
    height: number,
    setupModelRenderer?: SetupModelRenderer | null,
    portalDb?: DatDatabase | null,
    gameFovDeg?: number,
  ) {
    this.gameFovDeg = gameFovDeg;
    this.aspect = width / height;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 1);
    this.domElement = this.renderer.domElement;

    this.scene = new THREE.Scene();
    this.camera = buildCreatureModeCamera([...PORTAL_CAMERA_POSITION], width, height,
      portalSpaceVerticalFovDeg(gameFovDeg, this.aspect), 1000);
    this.baseQuat.copy(this.camera.quaternion);

    // CreatureMode's own lights. The `object` materials scale the scene
    // ambient by the world's day/night factor; divide it back out, as the
    // paperdoll does, so the viewport sees exactly 0.3.
    const ambientScale = currentObjectAmbientScale();
    this.scene.add(new THREE.AmbientLight(0xffffff, CREATURE_MODE_AMBIENT / (ambientScale > 0 ? ambientScale : 1)));
    const light = new THREE.DirectionalLight(0xffffff, PORTAL_LIGHT_INTENSITY);
    const lp = distantLightPosition([...PORTAL_LIGHT_DIRECTION]);
    light.position.set(lp[0], lp[1], lp[2]);
    this.scene.add(light);
    this.scene.add(light.target);

    let mapper: DidMapper | null = null;
    try {
      const data = portalDb?.getFileData(PORTAL_DID_MAPPER);
      if (data) mapper = readDidMapper(new DatReader(data));
    } catch { mapper = null; }
    this.dids = resolvePortalSpaceDids(mapper);
    this.setupModelRenderer = setupModelRenderer ?? null;
    this.portalDb = portalDb ?? null;
    this.buildObject();
  }

  private readonly dids: { setup: number; animation: number };
  private readonly setupModelRenderer: SetupModelRenderer | null;
  private readonly portalDb: DatDatabase | null;
  /**
   * RELEASE.dat-streaming — the teleport object or its animation was built
   * across a streamed miss (a cold first login can open the tunnel before
   * the world pack lands); rebuildIfIncomplete redoes it once files arrive.
   */
  private builtAcrossMiss = false;

  /** Whether the tunnel drew without some of its files (rebuildIfIncomplete pending). */
  get incomplete(): boolean { return this.builtAcrossMiss; }

  /**
   * The tunnel object or animation missed streamed files: build it again now
   * that they are resident, keeping the running animation's clock. False
   * when nothing was missing.
   */
  rebuildIfIncomplete(): boolean {
    if (!this.builtAcrossMiss) return false;
    if (this.object) this.scene.remove(this.object);
    for (const m of this.ownMaterials) m.dispose();
    this.ownMaterials = [];
    this.object = null;
    this.parts = [];
    this.anim = null;
    this.buildObject();
    if (this.object && this.animStart !== null) this.applyFrame(this.animFrame);
    return true;
  }

  private buildObject(): void {
    const epoch = datMissEpoch();
    try {
      this.object = this.setupModelRenderer?.createSetupMesh(this.dids.setup) ?? null;
      const animData = this.portalDb?.getFileData(this.dids.animation);
      if (animData) this.anim = new Animation(new DatReader(animData));
    } catch (e) {
      console.warn('[AC] Portal space: failed to build the teleport object', e);
    }
    this.builtAcrossMiss = !noDatMissSince(epoch);
    if (this.object) {
      // The camera sits INSIDE the tunnel (two half-annuli of radius 51 about
      // it), whose 360 polygons are all SidesType 0 facing outward, yet the
      // retail viewport shows their inner faces — so this view draws them
      // unculled. The shared world materials are back-face culled
      // (VISUAL.lifestone-crystal-opacity), so the tunnel takes its own
      // double-sided copies (the shader patch carried over), freed on dispose.
      this.ownMaterials = doubleSidedCopies(this.object);
      // The viewport lights its object with its own lights, whatever cell the player is in.
      setCellLighting(this.object, false, true);
      this.parts = collectPartObjects(this.object);
      this.scene.add(this.object);
      this.applyFrame(0);
    } else {
      console.warn('[AC] Portal space: no teleport object — rendering void');
    }
  }

  /** The tunnel animation's current frame number (CPhysicsObj::get_curr_frame_number). */
  get animFrame(): number {
    if (this.animStart === null || !this.anim) return 0;
    return portalAnimFrame((this.clock() - this.animStart) / 1000, this.anim.partFrames.length);
  }

  /** set_sequence_animation(anim, …, TELEPORT_ANIM_FPS): (re)start the loop at frame 0. */
  startAnimation(nowMs: number = this.clock()): void {
    this.animStart = nowMs;
    this.hooksThrough = 0;
    this.applyFrame(0);
  }

  /**
   * Run the hooks of every frame the loop has left since the last call — the
   * frames' order and rule are AnimationPlayer's (a frame's hooks fire as the
   * sequence steps past it; direction Both or Forward).
   */
  runHooks(): void {
    if (this.animStart === null || !this.anim) return;
    const n = this.anim.partFrames.length;
    if (n <= 0) return;
    const reached = Math.floor(Math.max(0, (this.clock() - this.animStart) / 1000) * TELEPORT_ANIM_FPS);
    if (!this.onHook) { this.hooksThrough = reached; return; }
    // A long stall (hidden tab) runs at most one loop's hooks, not a backlog.
    if (reached - this.hooksThrough > n) this.hooksThrough = reached - n;
    for (; this.hooksThrough < reached; this.hooksThrough++) {
      for (const hook of this.anim.partFrames[this.hooksThrough % n].hooks) {
        if (hook.direction !== HOOK_DIR_BOTH && hook.direction !== HOOK_DIR_FORWARD) continue;
        this.onHook(hook);
      }
    }
  }

  /** clear_sequence_anims. */
  stopAnimation(): void {
    this.animStart = null;
    this.hooksThrough = 0;
  }

  /** The roll (degrees) and the fade's view-distance ratio for the next draw. */
  setView(rollDeg: number, viewDistanceRatio: number | null): void {
    this.rollDeg = rollDeg;
    this.viewDistanceRatio = viewDistanceRatio;
  }

  private applyFrame(frame: number): void {
    const f = this.anim?.partFrames[frame];
    if (f) applyPartTransforms(this.parts, f.frames);
  }

  /** Draw one frame. */
  render(): void {
    if (this.animStart !== null) this.applyFrame(this.animFrame);
    this.runHooks();
    const fov = portalSpaceVerticalFovDeg(this.gameFovDeg, this.aspect);
    this.camera.fov = this.viewDistanceRatio === null ? fov : fovForViewDistanceRatio(fov, this.viewDistanceRatio);
    this.camera.updateProjectionMatrix();
    // Frame::rotate((0, roll, 0)) turns the camera about AC +y, its view axis
    // (three's camera-local z under the (x, z, y) mapping).
    this.camera.quaternion.copy(this.baseQuat);
    this.camera.rotateZ((this.rollDeg * Math.PI) / 180);
    this.renderer.render(this.scene, this.camera);
  }

  resize(width: number, height: number): void {
    this.aspect = width / height;
    this.renderer.setSize(width, height);
    placeCreatureModeCamera(this.camera, [...PORTAL_CAMERA_POSITION], portalSpaceVerticalFovDeg(this.gameFovDeg, this.aspect), this.aspect);
    this.baseQuat.copy(this.camera.quaternion);
  }

  dispose(): void {
    this.stopAnimation();
    // The Setup's geometry/materials belong to SetupModelRenderer's caches — not ours to free
    // (only the double-sided copies made for this view).
    if (this.object) this.scene.remove(this.object);
    for (const m of this.ownMaterials) m.dispose();
    this.ownMaterials = [];
    this.renderer.dispose();
    // WebGLRenderer.dispose() frees THREE's GPU resources but NOT the WebGL
    // context itself. Every teleport mounts a fresh portal-space renderer, so
    // without releasing it Chrome hits its live-context cap (16) after ~16
    // portals, drops the OLDEST context — the game world's own canvas — and
    // the world renders white for the rest of the session (found live by
    // tools/probe-spell-projectile.ts: "Too many active WebGL contexts.
    // Oldest context will be lost." → THREE "Context Lost").
    // Mark the deliberate loss so ContextHealth doesn't count it as a fault.
    this.renderer.domElement.dataset.acIntentionalLoss = '1';
    this.renderer.forceContextLoss();
  }
}

/**
 * Give every mesh under `root` a double-sided copy of its material (the
 * copies keep the retail-lighting shader patch, which Material.clone drops)
 * and return the copies for disposal.
 */
export function doubleSidedCopies(root: THREE.Object3D): THREE.Material[] {
  const copies: THREE.Material[] = [];
  const copyOf = new Map<THREE.Material, THREE.Material>();
  const swap = (m: THREE.Material): THREE.Material => {
    if (m.side === THREE.DoubleSide) return m;
    let c = copyOf.get(m);
    if (!c) {
      c = m.clone();
      c.side = THREE.DoubleSide;
      // One copy drawn unculled, not SidesType 1's two: the inner faces keep
      // the outward normal's light (RENDER.sidestype1-backface-lighting).
      c.defines = { ...c.defines, [CULL_NONE_DEFINE]: '' };
      c.onBeforeCompile = m.onBeforeCompile;
      c.customProgramCacheKey = m.customProgramCacheKey;
      copyOf.set(m, c);
      copies.push(c);
    }
    return c;
  };
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
  });
  return copies;
}
