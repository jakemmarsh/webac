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
 * Without KHR_parallel_shader_compile (Firefox has none: PERF.firefox-cover-
 * compile-stall) compileAsync is no help: three.js reports every program
 * ready at once, and the first draw that reads a program's uniforms waits for
 * its link, so the warm's first sweep pass waited for EVERY link in one
 * frame. Production, 2026-10-22, Firefox 158 / ANGLE D3D11 on Intel HD: about
 * 2.7 s in the warm phase (compileMs 2722, programsCreated 17) in one frame,
 * the portal-space tunnel (its own context, drawn from the same main thread)
 * frozen with it, and a new player closed the tab 14 s after entering. There
 * the warm is sliced instead (SlicedWarmJob): textures, then the scene's
 * objects in batches holding at most one material the job has not compiled,
 * each batch through renderer.compile against the scene's own lights (the
 * programs compile(scene) makes, keyed on DatLightBudget's pinned point-light
 * total), each new program's link waited for at once (getUniforms) so its
 * cost lands in that frame and not in a later draw. A frame stops after
 * WARM_SLICE_BUDGET_MS; the tunnel draws between frames.
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
  /** Synchronous program creation (three.js queues compile + link; nothing waits for them). */
  compile(scene: THREE.Object3D, camera: THREE.Camera, targetScene?: THREE.Scene | null): unknown;
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
  /** three.js's live programs (renderer.info.programs); getUniforms() waits for a program's link and reads it. */
  readonly info: { programs: ReadonlyArray<WarmupProgram> | null };
}

/** The part of a three.js WebGLProgram the sliced warm uses. */
export interface WarmupProgram {
  getUniforms(): unknown;
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
  /** Wall clock (ms) for the sliced warm's per-frame budget; performance.now by default. */
  clock?: () => number;
  /**
   * Another material `object` will draw with in this world for `material`
   * (main.ts: a server object's faded copy, ObjectTranslucency
   * fadedMaterialVariant), or null. The sliced cover warm compiles it on the
   * object, once per base material, after the scene itself.
   */
  variantFor?: (object: THREE.Object3D, material: THREE.Material) => THREE.Material | null;
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
/**
 * Main-thread ms a frame spends on a sliced warm (no KHR_parallel_shader_compile)
 * before it stops: half a 60 Hz frame. Every frame makes some progress, so a
 * program whose link alone takes longer overruns it by that one link.
 */
export const WARM_SLICE_BUDGET_MS = 8;
/** The most objects in one sliced-warm compile batch (the runs of already-compiled materials between new ones). */
export const WARM_SLICE_MAX_OBJECTS = 512;

type Phase = 'idle' | 'compiling' | 'slicing' | 'sweeping';

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

/**
 * A stand-in root that hands renderer.compile exactly the listed objects
 * (traverse visits them, not their children) and no lights of its own
 * (traverseVisible visits nothing), so compile(root, camera, scene) gathers
 * the lights once, from the scene, as compile(scene, camera) does. The
 * objects are never adopted: their parents and matrices are untouched.
 */
class WarmBatchRoot extends THREE.Object3D {
  items: THREE.Object3D[] = [];
  override traverse(callback: (object: THREE.Object3D) => unknown): void {
    for (const o of this.items) callback(o);
  }
  override traverseVisible(_callback: (object: THREE.Object3D) => unknown): void { /* no lights of its own */ }
}

/** What renderer.compile prepares a program for: a mesh, points, line or sprite with a material. */
function isDrawable(o: THREE.Object3D): boolean {
  const d = o as THREE.Object3D & { isMesh?: boolean; isPoints?: boolean; isLine?: boolean; isSprite?: boolean; material?: unknown };
  return !!(d.isMesh || d.isPoints || d.isLine || d.isSprite) && !!d.material;
}

function materialsOf(o: THREE.Object3D): THREE.Material[] {
  const mat = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
  if (!mat) return [];
  return Array.isArray(mat) ? mat : [mat];
}

/**
 * What three.js keys a program on from the OBJECT (not its material), for
 * the play-time upload draw's one override material: instancing (and its
 * colours / morphs), batching, skinning and morph targets
 * (WebGLPrograms.getParameters). Objects of one kind share that draw's program.
 */
export function uploadKind(o: THREE.Object3D): string {
  const x = o as THREE.Object3D & {
    isInstancedMesh?: boolean; instanceColor?: unknown; morphTexture?: unknown;
    isBatchedMesh?: boolean; _colorsTexture?: unknown; isSkinnedMesh?: boolean; isPoints?: boolean;
    geometry?: THREE.BufferGeometry;
  };
  const g = x.geometry;
  const morph = g?.morphAttributes ?? {};
  return [
    x.isInstancedMesh ? 'i' : '', x.isInstancedMesh && x.instanceColor ? 'c' : '', x.isInstancedMesh && x.morphTexture ? 'm' : '',
    x.isBatchedMesh ? 'b' : '', x.isBatchedMesh && x._colorsTexture ? 'bc' : '', x.isSkinnedMesh ? 's' : '',
    morph.position ? `mp${morph.position.length}` : '', morph.normal ? 'mn' : '', morph.color ? 'mc' : '',
    x.isPoints && g?.attributes.uv ? 'pu' : '',
  ].join('.');
}

/** The drawables under `o` that have no drawable above them (the renderer reaches the rest through them). */
function collectTopDrawables(o: THREE.Object3D, out: THREE.Object3D[]): void {
  if (isDrawable(o)) { out.push(o); return; }
  for (const c of o.children) collectTopDrawables(c, out);
}

/** True while `o` still hangs under `root` (a subtree unloaded meanwhile is skipped, never recompiled). */
function attachedTo(o: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p === root) return true;
  return false;
}

/**
 * One sliced warm (no KHR_parallel_shader_compile): a snapshot of a subtree's
 * textures and drawable objects, worked through a frame at a time by step().
 */
export class SlicedWarmJob {
  private readonly textures: THREE.Texture[] = [];
  private readonly objects: THREE.Object3D[] = [];
  private texIdx = 0;
  private objIdx = 0;
  /** Everything ever queued, so refresh() adds only what arrived since. */
  private readonly queuedObjects = new WeakSet<THREE.Object3D>();
  private readonly queuedTextures = new WeakSet<THREE.Texture>();
  /** Objects queued since the last takeNewObjects. */
  private newObjects: THREE.Object3D[] = [];
  /** One object of each uploadKind seen, not yet handed out (takeNewKinds). */
  private newKinds = new Map<string, THREE.Object3D>();
  private readonly kindsSeen = new Set<string>();
  /** Materials this job has compiled: a batch holds at most one material not in here. */
  private readonly seen = new WeakSet<THREE.Material>();
  private readonly root = new WarmBatchRoot();

  constructor(
    subtree: THREE.Object3D,
    /** The scene whose lights key the programs, and that each object must still hang under. */
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.Camera,
    /** Every material any job compiled (RendererWarmup.compiledMaterial, for CompileTrace). */
    private readonly everCompiled: WeakSet<THREE.Material> | null = null,
  ) {
    this.refresh(subtree);
  }

  /**
   * Queue what `subtree` holds that this job has not queued yet (content
   * that streamed in since): the cover warm keeps one job across an arrival
   * instead of finishing a stale snapshot first. Returns how much was added.
   */
  refresh(subtree: THREE.Object3D): number {
    const textures = new Set<THREE.Texture>();
    let added = 0;
    subtree.traverse(obj => {
      if (!isDrawable(obj) || this.queuedObjects.has(obj)) return;
      this.queuedObjects.add(obj);
      this.objects.push(obj);
      added++;
      this.newObjects.push(obj);
      const kind = uploadKind(obj);
      if (!this.kindsSeen.has(kind)) { this.kindsSeen.add(kind); this.newKinds.set(kind, obj); }
      for (const m of materialsOf(obj)) collectMaterialTextures(m, textures);
    });
    for (const t of textures) {
      // A texture with no image data yet (async DAT decode pending) is left to its first real draw.
      if (t.image == null || this.queuedTextures.has(t)) continue;
      this.queuedTextures.add(t);
      this.textures.push(t);
      added++;
    }
    return added;
  }

  get done(): boolean { return this.texIdx >= this.textures.length && this.objIdx >= this.objects.length; }

  /** The object kinds (uploadKind) first seen since the last call, one object each. */
  takeNewObjects(): THREE.Object3D[] {
    const out = this.newObjects;
    this.newObjects = [];
    return out;
  }

  takeNewKinds(): Map<string, THREE.Object3D> {
    const out = this.newKinds;
    this.newKinds = new Map();
    return out;
  }

  /**
   * Work until `budgetMs` of `clock` has passed, and always at least one
   * unit: texture uploads, then compile batches. `linked` holds every program
   * whose link has been waited for; each new one is waited for (getUniforms)
   * right after its batch. Returns the programs linked in this step.
   */
  step(r: WarmupRenderer, clock: () => number, budgetMs: number, linked: WeakSet<WarmupProgram>,
    stats: { texturesInitialized: number; slicedBatches: number }): number {
    const start = clock();
    let linkedNow = 0;
    let first = true;
    while (!this.done && (first || clock() - start < budgetMs)) {
      first = false;
      if (this.texIdx < this.textures.length) {
        r.initTexture(this.textures[this.texIdx++]);
        stats.texturesInitialized++;
        continue;
      }
      const batch = this.nextBatch();
      if (batch.length === 0) continue;
      this.root.items = batch;
      try {
        r.compile(this.root, this.camera, this.scene);
      } finally {
        this.root.items = [];
      }
      stats.slicedBatches++;
      for (const p of r.info.programs ?? []) {
        if (linked.has(p)) continue;
        linked.add(p);
        p.getUniforms(); // waits for this program's link now, in this frame
        linkedNow++;
      }
    }
    return linkedNow;
  }

  /** The next objects, up to (not including) the second material this job has not compiled. */
  private nextBatch(): THREE.Object3D[] {
    const batch: THREE.Object3D[] = [];
    let unseen = 0;
    while (this.objIdx < this.objects.length && batch.length < WARM_SLICE_MAX_OBJECTS) {
      const o = this.objects[this.objIdx];
      const mats = materialsOf(o);
      let fresh = 0;
      for (const m of mats) if (!this.seen.has(m)) fresh++;
      if (fresh > 0 && unseen > 0) break;
      this.objIdx++;
      if (!attachedTo(o, this.scene)) continue;
      unseen += fresh;
      for (const m of mats) { this.seen.add(m); this.everCompiled?.add(m); }
      batch.push(o);
    }
    return batch;
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
  readonly stats = {
    coverWarms: 0, sweepRenders: 0, texturesInitialized: 0, playCompiles: 0, playUploadRenders: 0, precompiles: 0,
    /** Sliced warms (no KHR_parallel_shader_compile): frames run, compile batches, programs linked, longest frame (ms). */
    sliceSteps: 0, slicedBatches: 0, slicedLinks: 0, sliceMaxStepMs: 0, sliceRefreshes: 0, uploadKindsLinked: 0, variantsCompiled: 0,
  };
  /** The running sliced cover warm (no KHR_parallel_shader_compile). */
  private coverJob: SlicedWarmJob | null = null;
  /** The content version the sliced cover warm last swept (null: not yet, or an arrival asked for another). */
  private sweptVersion: number | null = null;
  private lastSweepMs = 0;
  /** uploadKinds whose play-time upload program is linked; the ones a cover job found that still need it. */
  private readonly uploadKindsLinked = new Set<string>();
  /**
   * Work a caught-up cover job still owes, one compile each: the play-time
   * upload draw's program per object kind, and the variants
   * (RendererWarmupOptions.variantFor) of the materials it compiled.
   */
  private readonly pendingExtras: Array<{ upload: THREE.Object3D } | { object: THREE.Object3D; material: THREE.Material; variant: THREE.Material }> = [];
  private readonly variantQueued = new WeakSet<THREE.Material>();
  private readonly uploadBatch = new WarmBatchRoot();
  /** Materials a warm compiled (any path): CompileTrace tells late arrivals from changed keys with it. */
  private readonly everCompiled = new WeakSet<THREE.Material>();

  /** Whether a warm (cover, precompile) ever compiled `material`. */
  compiledMaterial(material: unknown): boolean {
    return !!material && typeof material === 'object' && this.everCompiled.has(material as THREE.Material);
  }
  /** The running sliced precompile (no KHR_parallel_shader_compile); pendingPrecompile holds the ones after it. */
  private precompileJob: SlicedWarmJob | null = null;
  /** Programs whose link a sliced warm has waited for. */
  private readonly linked = new WeakSet<WarmupProgram>();
  private readonly clock: () => number;
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
    this.clock = opts.clock ?? (() => performance.now());
  }

  /** The driver links programs off the main thread (KHR_parallel_shader_compile), so compileAsync never blocks. */
  private get parallelCompile(): boolean {
    return this.renderer.extensions.has(PARALLEL_COMPILE_EXT);
  }

  /**
   * Login / teleport arrival: warm again under this cover even if no content
   * changed. The arrival gets its own MAX_WAIT_MS: landblocks that keep
   * streaming in never go QUIET_MS quiet, and a cover that had warmed once
   * already (the login gate's, before the world was built) then left every
   * world program to the tunnel fade-out's first world draw.
   */
  requestWarm(): void {
    this.dirty = true;
    this.warmedThisCover = false;
    this.coverSinceMs = null;
  }

  /** A subtree was added to the scene (landblock streaming): compile it during play if that is free. */
  noteAdded(object: THREE.Object3D): void {
    this.pendingAdded.push(object);
  }

  /**
   * Compile a subtree's programs on the next uncovered frame (idle screens:
   * character select), so no later cover-time warm has to. Unlike
   * noteAdded this runs without KHR_parallel_shader_compile too (sliced, a
   * frame at a time): a link paid while the player idles at character select
   * beats one paid inside the login gate. Under a cover the queue waits; the full warm compiles the
   * scene anyway.
   */
  precompile(object: THREE.Object3D): void {
    if (!this.pendingPrecompile.includes(object)) this.pendingPrecompile.push(object);
  }

  /** True while a cover-time warm is compiling or sweeping. */
  get busy(): boolean { return this.phase !== 'idle'; }

  /** True while a sliced cover warm (no KHR_parallel_shader_compile) still has programs to compile. */
  get slicing(): boolean { return this.phase === 'slicing'; }

  /** The warm's phase, for diagnostics (CompileTrace). */
  get phaseName(): string { return this.phase; }

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
      this.coverJob = null;
      this.coverSinceMs = null;
      this.warmedThisCover = false;
      this.runPrecompiles();
      this.warmAddedDuringPlay();
      return;
    }

    // Under the cover a full warm subsumes per-subtree compiles.
    this.pendingAdded.length = 0;
    this.precompileJob = null;
    if (this.coverSinceMs === null) this.coverSinceMs = nowMs;

    if (this.phase === 'sweeping') {
      this.renderSweepPass();
      return;
    }
    if (!this.parallelCompile) {
      this.tickSlicedCover(nowMs, version);
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

  /**
   * The cover warm without KHR_parallel_shader_compile: one SlicedWarmJob per
   * cover, started on the first covered frame (no QUIET_MS / MAX_WAIT_MS
   * wait: the work is incremental, so starting early costs nothing and
   * waiting only pushed the links past the tunnel). Content that arrives
   * while it runs (the arrival's landblocks, requestWarm) is taken into the
   * same job once it has caught up, so only new objects are compiled. The 1x1
   * sweep (geometry upload) runs once the job is caught up and the content
   * has gone QUIET_MS quiet, or MAX_WAIT_MS after the last sweep.
   *
   * Live Firefox A/B, 2026-10-22 (150 ms per link injected): the first sliced
   * warm started up to MAX_WAIT_MS after the arrival and still had programs
   * left at the tunnel's 5 s cap; the fade-out's first world draw linked
   * them all, a 3.3 s frame. `slicing` (the tunnel's hold) is true while a
   * backlog remains.
   */
  private tickSlicedCover(nowMs: number, version: number): void {
    if (!this.coverJob) {
      if (!this.dirty && version === this.warmedVersion) return;
      this.dirty = false;
      this.warmedThisCover = true;
      this.warmedVersion = version;
      this.sweptVersion = null;
      this.lastSweepMs = nowMs;
      this.stats.coverWarms++;
      this.generation++;
      this.coverJob = new SlicedWarmJob(this.scene, this.scene, this.camera, this.everCompiled);
    }
    const job = this.coverJob;
    this.absorbNewContent(job);
    const ranJob = !job.done;
    if (ranJob) this.runSlice(job);
    this.absorbNewContent(job);
    if (!job.done) {
      this.phase = 'slicing';
      return;
    }
    for (const [kind, rep] of job.takeNewKinds()) if (!this.uploadKindsLinked.has(kind)) this.pendingExtras.push({ upload: rep });
    this.queueVariants(job.takeNewObjects());
    if (this.pendingExtras.length > 0) {
      if (!ranJob) this.stepExtras();
      if (this.pendingExtras.length > 0) {
        this.phase = 'slicing';
        return;
      }
    }
    this.phase = 'idle';
    const unswept = this.sweptVersion !== this.warmedVersion;
    const quiet = nowMs - this.lastVersionChangeMs >= QUIET_MS;
    if (unswept && (quiet || nowMs - this.lastSweepMs >= MAX_WAIT_MS)) {
      this.sweptVersion = this.warmedVersion;
      this.lastSweepMs = nowMs;
      this.phase = 'sweeping';
      this.sweepIndex = 0;
    }
  }

  /**
   * The work a caught-up cover job still owes, linked a frame at a time:
   *  - the play-time upload draw's programs (warmAddedDuringPlay: the
   *    override MeshBasicMaterial, no lights, no fog), one per object kind;
   *  - each variantFor material on its object (a server object's faded copy:
   *    the three Lambert programs the live Firefox A/B of 91941a857 linked in
   *    one 673 ms frame right after the tunnel, to be confirmed by
   *    CompileTrace's details).
   */
  private stepExtras(): void {
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const start = this.clock();
    let first = true;
    try {
      r.setRenderTarget(null);
      this.uploadRoot.children = [];
      while (this.pendingExtras.length > 0 && (first || this.clock() - start < WARM_SLICE_BUDGET_MS)) {
        first = false;
        const unit = this.pendingExtras.shift()!;
        const target = 'upload' in unit ? unit.upload : unit.object;
        if (!attachedTo(target, this.scene)) continue; // another object of its kind comes with the next refresh
        const m = target as THREE.Mesh;
        const material = m.material;
        if ('upload' in unit) {
          const kind = uploadKind(target);
          if (this.uploadKindsLinked.has(kind)) continue;
          this.uploadKindsLinked.add(kind);
          m.material = this.uploadMaterial;
        } else {
          // The object as it draws mid-fade: the one surface swapped for its faded copy.
          m.material = Array.isArray(material)
            ? material.map(x => (x === unit.material ? unit.variant : x))
            : unit.variant;
        }
        this.uploadBatch.items = [target];
        try {
          if ('upload' in unit) r.compile(this.uploadBatch, this.uploadCamera, this.uploadRoot);
          else r.compile(this.uploadBatch, this.camera, this.scene);
        } finally {
          this.uploadBatch.items = [];
          m.material = material;
        }
        if ('upload' in unit) this.stats.uploadKindsLinked++;
        else this.stats.variantsCompiled++;
        for (const p of r.info.programs ?? []) {
          if (this.linked.has(p)) continue;
          this.linked.add(p);
          p.getUniforms();
          this.stats.slicedLinks++;
        }
      }
    } finally {
      r.setRenderTarget(prevTarget);
    }
  }

  /**
   * The materials an object will draw with later in the same world
   * (RendererWarmupOptions.variantFor: a server object's faded copy), queued
   * once per base material.
   */
  private queueVariants(objects: readonly THREE.Object3D[]): void {
    const variantFor = this.opts.variantFor;
    if (!variantFor) return;
    for (const o of objects) {
      for (const material of materialsOf(o)) {
        if (this.variantQueued.has(material)) continue;
        this.variantQueued.add(material);
        let variant: THREE.Material | null = null;
        try { variant = variantFor(o, material); } catch { variant = null; }
        if (variant) this.pendingExtras.push({ object: o, material, variant });
      }
    }
  }

  /** A caught-up cover job takes in whatever arrived since it last looked (only the new objects compile). */
  private absorbNewContent(job: SlicedWarmJob): void {
    if (!job.done) return;
    const v = this.opts.contentVersion();
    if (v === this.warmedVersion && !this.dirty) return;
    if (this.dirty) this.sweptVersion = null; // an arrival (requestWarm): sweep again from the new spot
    this.warmedVersion = v;
    this.dirty = false;
    this.stats.sliceRefreshes++;
    job.refresh(this.scene);
  }

  /** One budgeted step of a sliced job, compiled for the canvas (render target null) as compileAsync is. */
  private runSlice(job: SlicedWarmJob): void {
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const t0 = this.clock();
    try {
      r.setRenderTarget(null);
      this.stats.slicedLinks += job.step(r, this.clock, WARM_SLICE_BUDGET_MS, this.linked, this.stats);
    } finally {
      r.setRenderTarget(prevTarget);
    }
    this.stats.sliceSteps++;
    this.stats.sliceMaxStepMs = Math.max(this.stats.sliceMaxStepMs, this.clock() - t0);
  }

  /** Upload every texture a subtree's materials reference (once each: three.js skips an uploaded texture). */
  private initTextures(root: THREE.Object3D): void {
    const textures = new Set<THREE.Texture>();
    root.traverse(obj => {
      const mat = (obj as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (!mat) return;
      for (const m of Array.isArray(mat) ? mat : [mat]) {
        collectMaterialTextures(m, textures);
        this.everCompiled.add(m); // compileAsync(root) compiles it (the KHR paths)
      }
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
    if (!this.parallelCompile) {
      // No KHR_parallel_shader_compile: compileAsync would leave every link to
      // the next draw at once, so each queued subtree runs as a sliced job.
      while (!this.precompileJob) {
        const next = this.pendingPrecompile.shift();
        if (!next) return;
        if (!attachedTo(next, this.scene)) continue; // replaced before its turn (a day-group rebuild)
        this.stats.precompiles++;
        this.precompileJob = new SlicedWarmJob(next, this.scene, this.camera, this.everCompiled);
      }
      this.runSlice(this.precompileJob);
      if (this.precompileJob.done) this.precompileJob = null;
      return;
    }
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
      // Without the extension this stays a geometry upload: during visible
      // play a compile is a main-thread wait for its link, which the first
      // draw pays no later than a compile here would.
      if (this.parallelCompile) {
        for (const obj of added) {
          this.stats.playCompiles++;
          r.compileAsync(obj, this.camera, this.scene).catch(() => { /* warm is best-effort */ });
        }
      }
      const cam = this.uploadCamera;
      this.camera.getWorldPosition(cam.position);
      cam.updateMatrixWorld(true);
      // The drawables only, flattened: a landblock's DAT point lights are not
      // gathered, so the override program never keys on how many of them the
      // subtree holds (one program per count, each a link, was the 2026-10-22
      // in-world 673 ms frame), and its programs are the ones
      // stepExtras linked under the cover.
      const drawables: THREE.Object3D[] = [];
      for (const o of added) collectTopDrawables(o, drawables);
      this.uploadRoot.children = drawables;
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
