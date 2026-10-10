/**
 * PERF.4 — first-look hitch: prewarm the GPU while portal space covers the
 * screen.
 *
 * three.js compiles a material's shader program, uploads its textures, and
 * uploads a mesh's geometry lazily, the first frame each one is DRAWN. After
 * login / teleport the world renders only the arrival heading, so the first
 * camera sweep compiles and uploads everything else (SwiftShader probe:
 * programs 81→155, geometries 1243→2101, textures 391→560 on the first
 * sweep; real GPU, Apple M3 Max: 2-3 frames over 100 ms, max 375 ms, in the
 * turning phase only). The transparent fix is to pay that cost while the
 * portal-space overlay (GameUI.showPortalSpace, an
 * opaque full-screen layer over the world canvas) still hides the world:
 *
 *   1. renderer.initTexture for every texture any material in the scene
 *      references (covers degrade / LOD meshes that are not drawn yet);
 *   2. renderer.compileAsync(scene, camera) — every material's program, with
 *      KHR_parallel_shader_compile doing the links off the main thread where
 *      the driver has it;
 *   3. one tiny-scissor render per frame from the camera's own position at
 *      WARM_HEADINGS yaw headings (plus one looking down), with a wide warm
 *      frustum, so every mesh in the loaded ring gets its geometry uploaded
 *      and each program's first-use bookkeeping done.
 *
 * Nothing visible changes: the scene graph, camera, and materials are never
 * modified (the warm passes use a private camera), and the renderer's render
 * target and scissor state are restored after each pass. The warm passes
 * only draw into a 1×1 scissor of the world canvas while it is covered, and
 * the next regular frame clears and repaints it.
 *
 * The prewarm only holds if the programs it compiles are the ones later
 * frames use. They were not at first (live M3 Max probe with
 * measure-perf --program-keys): three.js keys every lit program on
 * numPointLights, and DatLightBudget's enabled count followed cell
 * visibility, so a camera turn cycled the scene through 0/8/9/16/…/41 point
 * lights and recompiled every visible material at each count, prewarmed or
 * not. DatLightBudget's fixedLightCount (main.ts) pins that total, which is
 * what makes these compiles stick.
 *
 * Content that exists before any cover (the sky objects, built at boot or
 * behind character select) is queued with `precompile`: its programs compile
 * on the next uncovered frame, while the player is still at character select.
 * Otherwise the first cover-time warm (the login portal-space gate) is what
 * compiles them, and the sky's lit programs alone held the warm login gate
 * ~2 s (RELEASE.streaming-charselect-weight, 2026-10-05: one rendered frame
 * in 8 s of gate on SwiftShader; 2.6 s vs 0.5 s on the real GPU). The queue
 * drains after the frame's DatLightBudget update, so the programs carry the
 * pinned point-light total every later frame keys on, and compiles each
 * subtree for both sun states (outdoors, and a sealed cell's sun-off).
 *
 * Outside the cover (landblocks streaming in during play) each newly added
 * subtree gets compileAsync, only when KHR_parallel_shader_compile makes it
 * non-blocking, and one 1×1-scissor draw of just that subtree with an unlit
 * override material, which uploads its geometry at arrival, spread across
 * the streamer's budgeted frames, instead of all at once on the first turn
 * that reveals it. Textures are not pre-uploaded during play: that is a
 * synchronous upload either way.
 */
import * as THREE from 'three';

/** The subset of THREE.WebGLRenderer the warmup drives (fakeable in tests). */
export interface WarmupRenderer {
  compileAsync(scene: THREE.Object3D, camera: THREE.Camera, targetScene?: THREE.Scene | null): Promise<unknown>;
  initTexture(texture: THREE.Texture): void;
  render(scene: THREE.Object3D, camera: THREE.Camera): void;
  getRenderTarget(): THREE.WebGLRenderTarget | null;
  setRenderTarget(target: THREE.WebGLRenderTarget | null): void;
  getScissor(target: THREE.Vector4): THREE.Vector4;
  setScissor(x: number, y: number, width: number, height: number): void;
  getScissorTest(): boolean;
  setScissorTest(enable: boolean): void;
  readonly extensions: { has(name: string): boolean };
}

export interface RendererWarmupOptions {
  /** True while an opaque loading cover (portal space) hides the world canvas. */
  isCovered: () => boolean;
  /**
   * A number that changes whenever world content is added (models placed,
   * scene children). The cover-time warm re-runs when it moves, once it has
   * been stable for QUIET_MS.
   */
  contentVersion: () => number;
}

/** Yaw headings the warm sweep renders (each covers WARM_H_FOV_DEG > 360/N). */
export const WARM_HEADINGS = 4;
/** Warm frustum: vertical FOV and aspect → horizontal FOV ≈ 100°, so 4 headings overlap. */
export const WARM_V_FOV_DEG = 90;
export const WARM_ASPECT = 1.2;
/** Pitch of the extra look-down pass (radians; −π/2 is straight down). */
export const WARM_DOWN_PITCH = -Math.PI * 0.4;
/** Content must be unchanged this long before a cover-time warm starts. */
export const QUIET_MS = 250;
/** ...unless the cover has been up this long without a warm (streaming never pauses). */
export const MAX_WAIT_MS = 1000;
export const PARALLEL_COMPILE_EXT = 'KHR_parallel_shader_compile';
/** Half-size (m) of the play-time upload camera's box: past any landscape draw distance (25 blocks × 192 m). */
export const UPLOAD_HALF_EXTENT = 6000;

type Phase = 'idle' | 'compiling' | 'sweeping';

/** Every texture-valued property of a material (map, normalMap, uniforms, ...). */
function collectMaterialTextures(material: THREE.Material, out: Set<THREE.Texture>): void {
  const m = material as unknown as Record<string, unknown>;
  for (const key in m) {
    const v = m[key];
    if (v && (v as THREE.Texture).isTexture) out.add(v as THREE.Texture);
  }
  const uniforms = (material as THREE.ShaderMaterial).uniforms;
  if (uniforms) {
    for (const key in uniforms) {
      const v = uniforms[key]?.value;
      if (v && (v as THREE.Texture).isTexture) out.add(v as THREE.Texture);
    }
  }
}

export class RendererWarmup {
  private phase: Phase = 'idle';
  /** contentVersion the last completed (or running) cover-time warm saw. */
  private warmedVersion: number | null = null;
  private dirty = true;
  private lastVersion = NaN;
  private lastVersionChangeMs = 0;
  private coverSinceMs: number | null = null;
  /** A warm has started under the current cover. */
  private warmedThisCover = false;
  private sweepIndex = 0;
  /** Bumped when the cover drops, so a compile finishing later doesn't start a sweep. */
  private generation = 0;
  private readonly warmCamera = new THREE.PerspectiveCamera();
  private readonly savedScissor = new THREE.Vector4();
  private readonly pendingAdded: THREE.Object3D[] = [];
  /** Counters for tests / the acDebug surface. */
  readonly stats = { coverWarms: 0, sweepRenders: 0, texturesInitialized: 0, playCompiles: 0, playUploadRenders: 0, precompiles: 0 };
  /** Subtrees to compile on the next uncovered frame (precompile). */
  private readonly pendingPrecompile: THREE.Object3D[] = [];
  /**
   * Geometry pre-upload for subtrees streamed in during play: a proxy root
   * that LISTS them (never adopts them — their parent / matrixWorld are
   * untouched: matrixWorldAutoUpdate is off so render() doesn't recompute
   * them) drawn with one unlit override material, so no lit program variant
   * is compiled for it, through a camera whose frustum holds the whole ring.
   */
  private readonly uploadRoot = new THREE.Scene();
  private readonly uploadCamera = new THREE.OrthographicCamera(-UPLOAD_HALF_EXTENT, UPLOAD_HALF_EXTENT,
    UPLOAD_HALF_EXTENT, -UPLOAD_HALF_EXTENT, -UPLOAD_HALF_EXTENT, UPLOAD_HALF_EXTENT);
  private readonly uploadMaterial = new THREE.MeshBasicMaterial();

  constructor(
    private readonly renderer: WarmupRenderer,
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly opts: RendererWarmupOptions,
  ) {
    this.uploadRoot.matrixWorldAutoUpdate = false;
    this.uploadRoot.overrideMaterial = this.uploadMaterial;
  }

  /** Login / teleport arrival: warm again under this cover even if no content changed. */
  requestWarm(): void {
    this.dirty = true;
  }

  /** A subtree was added to the scene (landblock streaming): compile it during play if that is free. */
  noteAdded(object: THREE.Object3D): void {
    this.pendingAdded.push(object);
  }

  /**
   * Compile a subtree's programs on the next uncovered frame (idle screens:
   * character select), so no later cover-time warm has to. Unlike
   * noteAdded this runs without KHR_parallel_shader_compile too: a link paid
   * while the player idles at character select beats one paid inside the
   * login gate. Under a cover the queue waits; the full warm compiles the
   * scene anyway.
   */
  precompile(object: THREE.Object3D): void {
    if (!this.pendingPrecompile.includes(object)) this.pendingPrecompile.push(object);
  }

  /** True while a cover-time warm is compiling or sweeping. */
  get busy(): boolean { return this.phase !== 'idle'; }

  /** Call once per frame, before the regular scene render. */
  tick(nowMs: number): void {
    const version = this.opts.contentVersion();
    if (version !== this.lastVersion) {
      this.lastVersion = version;
      this.lastVersionChangeMs = nowMs;
    }

    if (!this.opts.isCovered()) {
      // Visible gameplay: abandon any cover-time work immediately — never
      // render an extra pass or upload synchronously while the world shows.
      if (this.phase !== 'idle') {
        this.phase = 'idle';
        this.generation++;
        this.dirty = true; // finish it under the next cover
      }
      this.coverSinceMs = null;
      this.warmedThisCover = false;
      this.runPrecompiles();
      this.warmAddedDuringPlay();
      return;
    }

    // Under the cover a full warm subsumes per-subtree compiles.
    this.pendingAdded.length = 0;
    if (this.coverSinceMs === null) this.coverSinceMs = nowMs;

    if (this.phase === 'sweeping') {
      this.renderSweepPass();
      return;
    }
    if (this.phase === 'compiling') return;

    const changed = this.dirty || version !== this.warmedVersion;
    if (!changed) return;
    const quiet = nowMs - this.lastVersionChangeMs >= QUIET_MS;
    const waitedOut = !this.warmedThisCover && nowMs - this.coverSinceMs >= MAX_WAIT_MS;
    if (!quiet && !waitedOut) return;
    this.startCoverWarm(version);
  }

  private startCoverWarm(version: number): void {
    this.dirty = false;
    this.warmedThisCover = true;
    this.warmedVersion = version;
    this.stats.coverWarms++;
    const gen = ++this.generation;

    // 1. Textures — uploaded now rather than on first draw.
    this.initTextures(this.scene);

    // 2. Programs — compiled against the canvas (render target null), since
    // the program cache key depends on the target's colour space / tone mapping.
    this.phase = 'compiling';
    const prevTarget = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(null);
    let compiled: Promise<unknown>;
    try {
      compiled = this.renderer.compileAsync(this.scene, this.camera);
    } finally {
      this.renderer.setRenderTarget(prevTarget);
    }
    const startSweep = () => {
      if (gen !== this.generation || this.phase !== 'compiling') return;
      this.phase = 'sweeping';
      this.sweepIndex = 0;
    };
    compiled.then(startSweep, startSweep);
  }

  /** Upload every texture a subtree's materials reference (once each: three.js skips an uploaded texture). */
  private initTextures(root: THREE.Object3D): void {
    const textures = new Set<THREE.Texture>();
    root.traverse(obj => {
      const mat = (obj as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (!mat) return;
      if (Array.isArray(mat)) for (const m of mat) collectMaterialTextures(m, textures);
      else collectMaterialTextures(mat, textures);
    });
    for (const t of textures) {
      // A texture with no image data yet (async DAT decode pending) would
      // upload an empty placeholder; leave it to its first real draw.
      if (t.image == null) continue;
      this.renderer.initTexture(t);
      this.stats.texturesInitialized++;
    }
  }

  /** 3. One scissored render per frame at the next warm heading. */
  private renderSweepPass(): void {
    const total = WARM_HEADINGS + 1;
    if (this.sweepIndex >= total) {
      this.phase = 'idle';
      return;
    }
    const i = this.sweepIndex++;
    const cam = this.warmCamera;
    cam.fov = WARM_V_FOV_DEG;
    cam.aspect = WARM_ASPECT;
    cam.near = this.camera.near;
    cam.far = this.camera.far;
    cam.layers.mask = this.camera.layers.mask;
    this.camera.getWorldPosition(cam.position);
    if (i < WARM_HEADINGS) cam.rotation.set(0, (i / WARM_HEADINGS) * Math.PI * 2, 0, 'YXZ');
    else cam.rotation.set(WARM_DOWN_PITCH, 0, 0, 'YXZ');
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);

    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevScissorTest = r.getScissorTest();
    r.getScissor(this.savedScissor);
    try {
      r.setRenderTarget(null);
      r.setScissorTest(true);
      r.setScissor(0, 0, 1, 1);
      r.render(this.scene, cam);
      this.stats.sweepRenders++;
    } finally {
      r.setScissor(this.savedScissor.x, this.savedScissor.y, this.savedScissor.z, this.savedScissor.w);
      r.setScissorTest(prevScissorTest);
      r.setRenderTarget(prevTarget);
    }
    if (this.sweepIndex >= total) this.phase = 'idle';
  }

  /**
   * The precompile queue: each subtree still in the scene uploads its
   * textures and compileAsyncs its programs (targetScene = scene: its lights).
   */
  private runPrecompiles(): void {
    if (this.pendingPrecompile.length === 0) return;
    const queued = this.pendingPrecompile.splice(0).filter(o => o.parent !== null);
    if (queued.length === 0) return;
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    try {
      r.setRenderTarget(null); // the canvas's program variant, as the cover warm compiles it
      // One sun state: the sun light stays on in a sealed cell too
      // (SkyboxRenderer.setSealedInterior, VISUAL.sylsfear-tree-foliage), so
      // numDirLights never changes and the scene's own lights are the only
      // variant (the cell kinds compile the sun loop out by define).
      for (const obj of queued) {
        this.stats.precompiles++;
        this.initTextures(obj);
        r.compileAsync(obj, this.camera, this.scene).catch(() => { /* warm is best-effort */ });
      }
    } finally {
      r.setRenderTarget(prevTarget);
    }
  }

  /**
   * Newly streamed subtrees during play: compileAsync their materials (only
   * with KHR_parallel_shader_compile — non-blocking), and upload their
   * geometry with one scissored 1×1 draw of just those subtrees (the upload
   * the first look at them would otherwise do all at once while turning).
   */
  private warmAddedDuringPlay(): void {
    if (this.pendingAdded.length === 0) return;
    const added = this.pendingAdded.splice(0).filter(o => o.parent !== null); // not removed again
    if (added.length === 0) return;
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevScissorTest = r.getScissorTest();
    r.getScissor(this.savedScissor);
    try {
      r.setRenderTarget(null);
      if (r.extensions.has(PARALLEL_COMPILE_EXT)) {
        for (const obj of added) {
          this.stats.playCompiles++;
          r.compileAsync(obj, this.camera, this.scene).catch(() => { /* warm is best-effort */ });
        }
      }
      const cam = this.uploadCamera;
      this.camera.getWorldPosition(cam.position);
      cam.updateMatrixWorld(true);
      this.uploadRoot.children = added;
      r.setScissorTest(true);
      r.setScissor(0, 0, 1, 1);
      r.render(this.uploadRoot, cam);
      this.stats.playUploadRenders++;
    } finally {
      this.uploadRoot.children = [];
      r.setScissor(this.savedScissor.x, this.savedScissor.y, this.savedScissor.z, this.savedScissor.w);
      r.setScissorTest(prevScissorTest);
      r.setRenderTarget(prevTarget);
    }
  }
}
