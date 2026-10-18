import * as THREE from 'three';
import { mirrorCameraX, installMirrorAwareCulling, type MirrorCullingRenderer } from './WorldMirror.js';
import { retailVerticalFovDeg } from './RetailCamera.js';
import { fovForViewDistanceRatio } from '../effects/PortalSpaceModel.js';
import { ProgramRetention, type RetainableProgram } from './ProgramRetention.js';
import { renderPixelRatio, renderAdaptConfig, contextAntialias, MIN_RENDER_PIXEL_RATIO } from './RenderScale.js';
import { DynamicResolution } from './DynamicResolution.js';
import { renderIndoorView, type IndoorViewContext } from './IndoorView.js';

/** Retail `Render::znear` (globals.tsv: 0.1; SetFOVRad resets it to 0.1). */
export const RETAIL_ZNEAR = 0.1;
/** Retail `Render::zfar` (globals.tsv: 4000). */
export const RETAIL_ZFAR = 4000;

export interface SceneManagerConfig {
  fov?: number;
  near?: number;
  far?: number;
  clearColor?: number;
  fogColor?: number;
  fogNear?: number;
  fogFar?: number;
}

/**
 * SceneManager — sets up and manages the Three.js scene, camera, and renderer.
 *
 * The scene and camera are always available (they work without WebGL).
 * The WebGLRenderer is created only when a canvas is provided (browser context).
 */
export class SceneManager {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer | null = null;
  readonly clearColor: number;
  /** PERF.gpu-soak-frame-hitches-28a525da — every compiled program stays linked. */
  readonly programRetention = new ProgramRetention(() => this.renderer?.info.programs as unknown as RetainableProgram[] | null);

  private aspect: number = 1;
  /**
   * CORE.18.b — the Config "Field of View" preference in degrees (retail
   * Render.FieldOfView, default 90 = SmartBox m_fGameFOV π/2). It is NOT the
   * camera's vertical angle: see applyGameFov.
   */
  private gameFovDeg: number;
  /** FAITHFUL.490 — saved THREE.Fog reference for DisableDistanceFog
   *  CharacterOption (0x30). When the player disables distance fog,
   *  `scene.fog` is set to null and `savedFog` holds the previous
   *  instance so re-enabling restores it. Live fog-color/range
   *  updates from indoor/outdoor transitions (main.ts:2659+,
   *  4003+, 4040+) all null-check `scene.fog`, so they harmlessly
   *  skip while disabled. */
  private savedFog: THREE.Fog | null = null;

  /**
   * DECOMP.environs-ambient-additive — the server EnvironChange override is
   * NOT a scene-level fog swap + second ambient light: retail keeps it in
   * LScape (m_override_*), blends the landscape fog and ambient toward it on
   * the sky ticks, and the override ambient REPLACES the day ambient. It
   * lives in SkyboxRenderer.setEnvironOverride, which writes the one fog
   * object and the one ambient light.
   *
   * CORE.18.b.a.a.a.a.a — RenderDeviceD3D::SetFFFogSystemDisabled (SmartBox::
   * DisableFogging, set by the Map View camera): no fog is drawn at all while
   * set, whatever the distance / environ fog state; the fog it hid is
   * stashed and comes back when it clears.
   */
  private fogSystemDisabled = false;
  private systemStashedFog: THREE.Fog | null = null;

  /** FAITHFUL.490 — toggle distance fog. */
  setFogEnabled(enabled: boolean): void {
    if (enabled) {
      if (this.savedFog && !this.scene.fog && !this.systemStashedFog) {
        this.scene.fog = this.savedFog;
      }
    } else {
      if (this.scene.fog) {
        this.savedFog = this.scene.fog as THREE.Fog;
        this.scene.fog = null;
      } else if (this.systemStashedFog) {
        // Hidden by the fog system: keep it for re-enabling, not for the restore.
        this.savedFog = this.systemStashedFog;
        this.systemStashedFog = null;
      }
    }
    this.suppressFogWhileSystemDisabled();
  }

  /** CORE.18.b.a.a.a.a.a — SmartBox::DisableFogging(on) (Map View). */
  setFogSystemDisabled(disabled: boolean): void {
    if (disabled === this.fogSystemDisabled) return;
    this.fogSystemDisabled = disabled;
    if (disabled) {
      this.suppressFogWhileSystemDisabled();
      return;
    }
    const stashed = this.systemStashedFog;
    this.systemStashedFog = null;
    if (stashed && !this.scene.fog) this.scene.fog = stashed;
  }

  /** The fog system is disabled (Map View). */
  get isFogSystemDisabled(): boolean { return this.fogSystemDisabled; }

  private suppressFogWhileSystemDisabled(): void {
    if (!this.fogSystemDisabled || !this.scene.fog) return;
    this.systemStashedFog = this.scene.fog as THREE.Fog;
    this.scene.fog = null;
  }

  constructor(config?: SceneManagerConfig) {
    // FAITHFUL.605 — default vertical FOV is 90°, not an invented 75°. ACE's
    // SmartBox.GameFOV = 1.5707963705062866f (float32 of pi/2 rad = 90 deg,
    // PlayerPhysicsUpdatedCallback) and the decompiled EoL client's
    // SmartBox::SetDefaultFov both source the retail default from this value.
    const fov = config?.fov ?? 90;
    const near = config?.near ?? RETAIL_ZNEAR;
    // DECOMP.camera-far-plane — retail Render::zfar = 4000 (globals.tsv
    // .data static; PrimD3DRender::SetFOVInternal @ 0059ab40 builds the
    // projection from Render::znear 0.1 / Render::zfar). GameSky::Draw
    // @ 00506ff0 draws the sky alone at zfar × 4 (SkyboxRenderer scales the
    // camera-centred sky set into this frustum instead).
    const far = config?.far ?? RETAIL_ZFAR;

    this.scene = new THREE.Scene();
    this.gameFovDeg = fov;
    this.camera = new THREE.PerspectiveCamera(fov, 1, near, far);
    // CORE.18 — the world is built with AC (x,y,z) → three (x,z,y), a
    // reflection; the world camera carries the one compensating mirror.
    mirrorCameraX(this.camera);
    this.clearColor = config?.clearColor ?? 0x87ceeb; // sky blue

    // Default camera position: slightly above ground, looking forward
    this.camera.position.set(0, 10, 0);

    // Background handled by SkyboxRenderer's sky sphere.
    // Set clear color as fallback (visible if sky sphere doesn't cover viewport).
    this.scene.background = new THREE.Color(this.clearColor);

    // Fog for distance fade
    if (config?.fogColor !== undefined) {
      this.scene.fog = new THREE.Fog(
        config.fogColor,
        config.fogNear ?? 100,
        config.fogFar ?? 1500
      );
      this.savedFog = this.scene.fog as THREE.Fog;
    }

    // CORE.17.e — the world carries NO undriven light. Outdoors every lumen
    // comes from the RegionDesc SkyTimeOfDay curve via SkyboxRenderer (retail
    // LScape::set_landscape_lighting / SmartBox::SetWorldAmbientLight); the
    // white 0.25 ambient "floor" and 0.8 directional that used to live here
    // never dimmed. CORE.17.q — sealed interiors carry no placeholder either.
    // DECOMP.environs-ambient-additive — nor does the EnvironChange override
    // add one: it replaces the SkyboxRenderer ambient (setEnvironOverride).
  }

  /**
   * Initialize the WebGL renderer with a canvas element.
   * This must be called in a browser context.
   */
  initRenderer(canvas: HTMLCanvasElement): void {
    // stencil: building portal punches (world/PortalPunch.ts) mask the terrain.
    // PERF.render-adapt — a software-rendered context has no MSAA (RenderScale.ts).
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: contextAntialias(), stencil: true });
    installMirrorAwareCulling(this.renderer as unknown as MirrorCullingRenderer);
    this.renderer.setClearColor(this.clearColor);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.resize(canvas.clientWidth, canvas.clientHeight);
  }

  /**
   * PERF.render-adapt — dynamic resolution (DynamicResolution.ts), created on
   * the first resize when RenderScale's config turns it on; null otherwise,
   * and then the renderer keeps devicePixelRatio exactly as before.
   */
  dynamicResolution: DynamicResolution | null = null;
  /** The world's draw-distance steps changed (main.ts applies them under the player's own setting). */
  onDrawDistanceSteps: ((steps: number) => void) | null = null;

  private devicePixelRatio(): number {
    const d = typeof window !== 'undefined' ? window.devicePixelRatio : 1;
    return Number.isFinite(d) && d > 0 ? d : 1;
  }

  /** The adapted pixel ratio for the current size (dynamic resolution on). */
  private adaptPixelRatio(width: number, height: number): number {
    const cfg = renderAdaptConfig();
    const dpr = this.devicePixelRatio();
    const min = Math.min(dpr, MIN_RENDER_PIXEL_RATIO);
    if (!this.dynamicResolution) {
      let lastSteps = 0;
      this.dynamicResolution = new DynamicResolution({
        max: dpr, min,
        // Software rendering starts at ~1280×720 of pixels instead of full.
        start: renderPixelRatio(dpr, width, height, cfg.software),
        onChange: (ratio, steps) => {
          this.renderer?.setPixelRatio(ratio);
          if (steps !== lastSteps) { lastSteps = steps; this.onDrawDistanceSteps?.(steps); }
        },
      });
    } else {
      this.dynamicResolution.setBounds(min, dpr);
    }
    return this.dynamicResolution.ratio;
  }

  /**
   * Resize the renderer and update camera aspect ratio.
   */
  resize(width: number, height: number): void {
    this.aspect = width / height;
    this.camera.aspect = this.aspect;
    this.applyGameFov();
    this.camera.updateProjectionMatrix();
    // PERF.render-adapt — the buffer follows dynamic resolution; the canvas
    // keeps its CSS size. With adaptation off (automation) nothing here runs.
    if (this.renderer && renderAdaptConfig().dynamic) this.renderer.setPixelRatio(this.adaptPixelRatio(width, height));
    this.renderer?.setSize(width, height);
  }

  /** CORE.18.b — set the Config Field of View preference (degrees) and re-project. */
  setGameFov(deg: number): void {
    this.gameFovDeg = deg;
    this.applyGameFov();
    this.camera.updateProjectionMatrix();
  }

  /** The Config Field of View preference currently applied (degrees). */
  get gameFov(): number { return this.gameFovDeg; }

  /**
   * CORE.18.b — retail derives the world camera's VERTICAL angle from the
   * preference and the viewport aspect every frame:
   * Render::SetFOVRad(m_fGameFOV / (aspect − 0.1)) (RetailCamera.ts). An
   * out-of-range result is rejected and the previous projection kept.
   */
  private applyGameFov(): void {
    const v = retailVerticalFovDeg(this.gameFovDeg, this.aspect);
    if (v !== null) {
      this.camera.fov = this.viewDistanceRatio === null ? v : fovForViewDistanceRatio(v, this.viewDistanceRatio);
    }
  }

  /** SmartBox::SetOverrideFovDistance as g / v; null restores the game's own projection. */
  private viewDistanceRatio: number | null = null;

  /**
   * The teleport fades zoom the world view by overriding its view-plane
   * distance (gmSmartBoxUI::UseTime → SmartBox::SetOverrideFovDistance;
   * PortalSpaceModel.ts). `ratio` = the game's distance / the override.
   */
  setViewDistanceRatio(ratio: number | null): void {
    if (ratio === this.viewDistanceRatio) return;
    this.viewDistanceRatio = ratio;
    this.applyGameFov();
    this.camera.updateProjectionMatrix();
  }

  /**
   * Render one frame.
   *
   * BUG.hidden-canvas-gpu-backlog — the world canvas stays `visibility:
   * hidden` through pre-play (char select, char create, the login gate: see
   * main()), and retail draws no SmartBox world there. A hidden canvas is
   * never presented, so nothing paces its frames: drawing it every
   * requestAnimationFrame queued GPU work faster than a slow GPU (SwiftShader)
   * executes it, and the backlog grew for as long as char select stayed up
   * (68 s of it after ~2 min). The next synchronous GPU call, the portal-space
   * renderer's context creation at login, then waited it all out on the main
   * thread (a 3.5-minute world entry with the streamed AC1999 world, whose
   * world packs keep char select up longest). A hidden canvas skips the draw.
   */
  private pendingCaptures: Array<(jpeg: string | null) => void> = [];

  /** A screenshot is waiting for a frame (the background beat draws one even while the window is covered). */
  get capturePending(): boolean { return this.pendingCaptures.length > 0; }

  /**
   * AGENT.hosted-mcp-connector — the next frame the game draws, as a JPEG (base64, no data: prefix,
   * at most 1024 wide). Read right after that frame's render, in the same task, so the WebGL buffer
   * still holds it (no preserveDrawingBuffer) and the camera, sky and lights are the frame's own: a
   * render of our own between frames drew a half-set-up scene. Null when no frame comes within
   * `timeoutMs` (the world hidden: char select, portal space).
   */
  captureNextFrame(timeoutMs = 1500): Promise<string | null> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v: string | null) => { if (!done) { done = true; resolve(v); } };
      this.pendingCaptures.push(finish);
      setTimeout(() => finish(null), timeoutMs);
    });
  }

  private flushCaptures(): void {
    const waiting = this.pendingCaptures.splice(0);
    const src = this.renderer?.domElement;
    let jpeg: string | null = null;
    if (src?.width) {
      const scale = Math.min(1, 1024 / src.width);
      const out = document.createElement('canvas');
      out.width = Math.round(src.width * scale);
      out.height = Math.round(src.height * scale);
      out.getContext('2d')?.drawImage(src, 0, 0, out.width, out.height);
      jpeg = out.toDataURL('image/jpeg', 0.75).replace(/^data:image\/jpeg;base64,/, '');
    }
    for (const w of waiting) w(jpeg);
  }

  /**
   * BUG.bunker-terrain-over-stairs — set each frame while the camera is in a
   * surface building cell that sees outside: render() then draws the
   * landscape backdrop, clears depth and draws the viewer's cells over it
   * (PView::DrawCells; scene/IndoorView.ts). Null: one ordinary pass.
   */
  indoorView: IndoorViewContext | null = null;

  render(): void {
    if (this.renderer?.domElement?.style?.visibility === 'hidden') {
      this.skipDraw();
      return;
    }
    if (this.indoorView && this.renderer) renderIndoorView(this.renderer, this.scene, this.camera, this.indoorView);
    else this.renderer?.render(this.scene, this.camera);
    if (this.pendingCaptures.length) this.flushCaptures();
    // PERF.gpu-soak-frame-hitches-28a525da — no program is ever relinked.
    this.programRetention.retainNew();
  }

  /**
   * Show or hide the world canvas. Hidden through every pre-world screen (char
   * select, char create, the Disconnected screen), which are opaque 2D layouts
   * with no SmartBox world behind them: retail CPlayerSystem::ExecuteLogOff @
   * 0055d780 drops the world on logout. render() draws nothing while hidden.
   * PERF.charselect-after-logout-renders-world: logout used to leave the canvas
   * revealed, so the whole world scene kept drawing behind char select.
   */
  setWorldShown(shown: boolean): void {
    const style = this.renderer?.domElement?.style;
    if (style) style.visibility = shown ? 'visible' : 'hidden';
  }

  /**
   * A frame with the world hidden (retail SmartBox::hidden — the portal-space
   * tunnel covers it): no draw, but the world matrices three.js would update
   * in render() stay current for code that reads them meanwhile.
   */
  skipDraw(): void {
    if (this.scene.matrixWorldAutoUpdate) this.scene.updateMatrixWorld();
    if (this.camera.parent === null && this.camera.matrixWorldAutoUpdate) this.camera.updateMatrixWorld();
  }

  /**
   * Add an object to the scene.
   */
  add(object: THREE.Object3D): void {
    this.scene.add(object);
  }

  /**
   * Remove an object from the scene.
   */
  remove(object: THREE.Object3D): void {
    this.scene.remove(object);
  }

  /**
   * Get the number of objects in the scene (excluding lights/camera).
   */
  get objectCount(): number {
    let count = 0;
    this.scene.traverse((child) => {
      if (child instanceof THREE.Mesh || child instanceof THREE.Group) {
        count++;
      }
    });
    return count;
  }
}
