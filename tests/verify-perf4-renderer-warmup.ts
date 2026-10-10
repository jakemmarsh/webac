/**
 * PERF.4 — first-look hitch: the renderer prewarm (scene/RendererWarmup).
 *
 * three.js compiles programs and uploads textures / geometry on first draw,
 * so the first camera sweep after login / teleport stalled (real GPU, M3 Max:
 * 2-3 frames over 100 ms, max 375 ms, turning phase only). The warmup pays
 * that cost while the opaque portal-space overlay covers the world canvas:
 * initTexture for every material texture, compileAsync(scene, camera), then
 * one 1x1-scissor render per frame at WARM_HEADINGS yaw headings plus a
 * look-down pass. During visible play newly streamed subtrees get
 * compileAsync (only with KHR_parallel_shader_compile, non-blocking) and one
 * 1x1 unlit draw that uploads their geometry.
 *
 * These tests drive the REAL RendererWarmup against a recording fake
 * renderer and a real three.js scene/camera.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import {
  RendererWarmup, type WarmupRenderer,
  WARM_HEADINGS, QUIET_MS, MAX_WAIT_MS, PARALLEL_COMPILE_EXT, UPLOAD_HALF_EXTENT,
} from '../packages/renderer/src/scene/RendererWarmup.js';
import { loadDomWindow, installDomGlobals } from './_harness/dom.js';
import {
  DatLightBudget, fixedPointLightTotal, attachedAndVisible, RETAIL_STARTUP_LIGHT_CAPS, RETAIL_MAX_LIGHT_CAPS,
  DEFAULT_RESERVED_EXTERNAL_LIGHTS, DEFAULT_FILLER_STEP,
} from '../packages/renderer/src/effects/DatLightBudget.js';
import { degradeLevelDerived } from '../packages/renderer/src/models/DegradeLod.js';

interface Call { op: string; args: unknown[]; target: unknown; scissorTest: boolean; scissor: number[] }

class FakeRenderer implements WarmupRenderer {
  calls: Call[] = [];
  target: THREE.WebGLRenderTarget | null;
  scissorTest = false;
  scissor = new THREE.Vector4(3, 4, 500, 400);
  exts: Set<string>;
  pendingCompiles: Array<() => void> = [];
  readonly extensions = { has: (n: string) => this.exts.has(n) };
  constructor(opts: { parallel?: boolean; target?: THREE.WebGLRenderTarget | null } = {}) {
    this.exts = new Set(opts.parallel ? [PARALLEL_COMPILE_EXT] : []);
    this.target = opts.target ?? null;
  }
  private rec(op: string, args: unknown[]): void {
    this.calls.push({ op, args, target: this.target, scissorTest: this.scissorTest, scissor: this.scissor.toArray() });
  }
  compileAsync(scene: THREE.Object3D, camera: THREE.Camera, targetScene?: THREE.Scene | null): Promise<unknown> {
    this.rec('compileAsync', [scene, camera, targetScene]);
    return new Promise(res => this.pendingCompiles.push(() => res(scene)));
  }
  initTexture(t: THREE.Texture): void { this.rec('initTexture', [t]); }
  render(scene: THREE.Object3D, camera: THREE.Camera): void {
    const c = camera as THREE.PerspectiveCamera;
    this.rec('render', [scene, camera, c.position.clone(), c.rotation.clone(), c.fov,
      [...scene.children], (scene as THREE.Scene).overrideMaterial]);
  }
  getRenderTarget() { return this.target; }
  setRenderTarget(t: THREE.WebGLRenderTarget | null) { this.target = t; }
  getScissor(v: THREE.Vector4) { return v.copy(this.scissor); }
  setScissor(x: number, y: number, w: number, h: number) { this.scissor.set(x, y, w, h); }
  getScissorTest() { return this.scissorTest; }
  setScissorTest(b: boolean) { this.scissorTest = b; }
  ops(op: string) { return this.calls.filter(c => c.op === op); }
  resolveCompiles() { for (const r of this.pendingCompiles.splice(0)) r(); }
}

function tex(): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array(4), 1, 1);
  t.needsUpdate = true;
  return t;
}

function world() {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 2000);
  camera.position.set(100, 12, 200);
  camera.rotation.set(-0.1, 0.7, 0, 'YXZ');
  camera.updateMatrixWorld(true);
  const texA = tex(), texB = tex(), texHidden = tex(), texUniform = tex();
  const a = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({ map: texA }));
  const b = new THREE.Mesh(new THREE.BoxGeometry(), [
    new THREE.MeshLambertMaterial({ map: texB }), new THREE.MeshLambertMaterial({ map: texA }),
  ]);
  // A degrade / LOD level not drawn yet — its texture must still be warmed.
  const hidden = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({ map: texHidden }));
  hidden.visible = false;
  const shader = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.ShaderMaterial({ uniforms: { u: { value: texUniform } } }));
  // A material whose texture has no image yet (async decode) is left alone.
  const pendingTex = new THREE.Texture();
  const pending = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({ map: pendingTex }));
  scene.add(a, b, hidden, shader, pending);
  return { scene, camera, textures: [texA, texB, texHidden, texUniform], pendingTex, hidden };
}

function harness(opts: { parallel?: boolean; target?: THREE.WebGLRenderTarget | null } = {}) {
  const w = world();
  const r = new FakeRenderer(opts);
  const env = { covered: false, version: 1 };
  const warm = new RendererWarmup(r, w.scene, w.camera, {
    isCovered: () => env.covered,
    contentVersion: () => env.version,
  });
  return { ...w, r, env, warm };
}

const flush = () => new Promise(res => setTimeout(res, 0));

describe('PERF.4 RendererWarmup — while the world is visible', () => {
  it('uncovered: no texture upload, no scene compile, no warm render — even after requestWarm and content changes', () => {
    const h = harness({ parallel: true });
    h.warm.requestWarm();
    for (let t = 0; t < 5000; t += 16) {
      if (t === 800) h.env.version++;
      h.warm.tick(t);
    }
    expect(h.r.calls).toEqual([]);
    expect(h.warm.busy).toBe(false);
  });

  it('during play a newly streamed subtree is compileAsync\'d alone (targetScene = scene) and its geometry uploaded by one 1x1 unlit draw', () => {
    const h = harness({ parallel: true, target: new THREE.WebGLRenderTarget(2, 2) });
    const prevTarget = h.r.target;
    const block = new THREE.Group();
    block.position.set(5, 0, 7);
    block.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshLambertMaterial({ map: tex() })));
    h.scene.add(block);
    h.scene.updateMatrixWorld(true);
    const worldBefore = block.children[0].matrixWorld.clone();
    h.warm.noteAdded(block);
    h.warm.tick(0);
    expect(h.r.calls.map(c => c.op)).toEqual(['compileAsync', 'render']);
    const [obj, cam, target] = h.r.calls[0].args;
    expect(obj).toBe(block);
    expect(cam).toBe(h.camera);
    expect(target).toBe(h.scene);
    expect(h.r.calls[0].target).toBeNull(); // compiled for the canvas variant

    // The upload draw: only the new subtree, an unlit override material (no
    // lit program variant), a whole-ring camera, 1x1 scissor on the canvas.
    const up = h.r.calls[1];
    const [root, upCam] = up.args as [THREE.Scene, THREE.Camera];
    expect(up.args[5]).toEqual([block]);
    expect((up.args[6] as THREE.Material).type).toBe('MeshBasicMaterial');
    expect(root).not.toBe(h.scene);
    expect(root.matrixWorldAutoUpdate).toBe(false); // never recomputes the subtree's matrices
    expect((upCam as THREE.OrthographicCamera).isOrthographicCamera).toBe(true);
    expect((upCam as THREE.OrthographicCamera).right).toBe(UPLOAD_HALF_EXTENT);
    expect(up.scissorTest).toBe(true);
    expect(up.scissor).toEqual([0, 0, 1, 1]);
    expect(up.target).toBeNull();

    // Nothing visible moved: the subtree keeps its parent and world matrix,
    // the proxy holds nothing afterwards, renderer state is restored.
    expect(block.parent).toBe(h.scene);
    expect(block.children[0].matrixWorld.equals(worldBefore)).toBe(true);
    expect(root.children).toEqual([]);
    expect(h.r.target).toBe(prevTarget);
    expect(h.r.scissorTest).toBe(false);
    expect(h.r.scissor.toArray()).toEqual([3, 4, 500, 400]);
    // Queue is drained: nothing on the next frame.
    h.warm.tick(16);
    expect(h.r.calls.length).toBe(2);
  });

  it('without KHR_parallel_shader_compile the play-time compile is skipped (a synchronous link) but the upload draw still runs', () => {
    const h = harness({ parallel: false });
    const block = new THREE.Group();
    h.scene.add(block);
    h.warm.noteAdded(block);
    h.warm.tick(0);
    expect(h.r.calls.map(c => c.op)).toEqual(['render']);
  });

  it('a subtree removed again before the next frame is neither compiled nor drawn', () => {
    const h = harness({ parallel: true });
    const block = new THREE.Group();
    h.warm.noteAdded(block); // never parented
    h.warm.tick(0);
    expect(h.r.calls).toEqual([]);
  });
});

describe('RELEASE.streaming-charselect-weight RendererWarmup.precompile — sky programs compile at character select, not in the login gate', () => {
  // 2026-10-05: the fully built sky's lit programs were first compiled by the
  // login gate's cover warm, holding it ~2 s (one rendered frame in 8 s of
  // gate on SwiftShader). precompile() moves that to the next uncovered frame.
  function sky() {
    const map = tex();
    const group = new THREE.Group();
    group.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshLambertMaterial({ map })));
    const unloaded = new THREE.Texture(); // async decode pending: left to its first draw
    group.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({ map: unloaded })));
    return { group, map };
  }

  it('the next uncovered frame uploads the subtree\'s textures and compileAsyncs it against the scene\'s lights, on the canvas variant', () => {
    const h = harness({ parallel: true, target: new THREE.WebGLRenderTarget(2, 2) });
    const prevTarget = h.r.target;
    const s = sky();
    h.scene.add(s.group);
    h.warm.precompile(s.group);
    expect(h.r.calls).toEqual([]); // nothing until the frame
    h.warm.tick(0);
    expect(h.r.calls.map(c => c.op)).toEqual(['initTexture', 'compileAsync']);
    expect(h.r.calls[0].args[0]).toBe(s.map);
    const [obj, cam, target] = h.r.calls[1].args;
    expect(obj).toBe(s.group);
    expect(cam).toBe(h.camera);
    expect(target).toBe(h.scene); // the scene's (pinned) point lights key the program
    expect(h.r.calls[1].target).toBeNull();
    expect(h.r.target).toBe(prevTarget);
    expect(h.warm.stats.precompiles).toBe(1);
    // Drained: nothing more on later frames, and no warm render ever (it is not a cover).
    h.warm.tick(16);
    h.warm.tick(32);
    expect(h.r.calls.length).toBe(2);
    expect(h.r.ops('render')).toEqual([]);
  });

  it('compiles each subtree once against the scene\'s own lights (the sun stays on in a sealed cell, so numDirLights never changes)', () => {
    const h = harness({ parallel: true });
    const sun = new THREE.DirectionalLight();
    h.scene.add(sun);
    const s = sky();
    h.scene.add(s.group);
    const sunAtCompile: boolean[] = [];
    const compile = h.r.compileAsync.bind(h.r);
    h.r.compileAsync = (o, c, t) => { sunAtCompile.push(sun.visible); return compile(o, c, t); };
    h.warm.precompile(s.group);
    h.warm.tick(0);
    expect(h.r.ops('compileAsync').map(c => c.args[0])).toEqual([s.group]);
    expect(sunAtCompile).toEqual([true]);
    expect(sun.visible).toBe(true); // nothing visible changed
  });

  it('runs without KHR_parallel_shader_compile too: a link at character select beats one inside the gate', () => {
    const h = harness({ parallel: false });
    const s = sky();
    h.scene.add(s.group);
    h.warm.precompile(s.group);
    h.warm.tick(0);
    expect(h.r.ops('compileAsync').map(c => c.args[0])).toEqual([s.group]);
  });

  it('under a cover the queue waits (the full warm compiles the scene), then drains on the first uncovered frame', () => {
    const h = harness({ parallel: true });
    const s = sky();
    h.scene.add(s.group);
    h.env.covered = true;
    h.warm.precompile(s.group);
    h.warm.tick(0);
    expect(h.r.ops('compileAsync').map(c => c.args[0])).not.toContain(s.group);
    h.env.covered = false;
    h.warm.tick(16);
    expect(h.r.ops('compileAsync').map(c => c.args[0])).toContain(s.group);
  });

  it('a subtree queued twice compiles once; one removed before the frame (a day-group rebuild) is skipped', () => {
    const h = harness({ parallel: true });
    const a = sky(), b = sky();
    h.scene.add(a.group);
    h.warm.precompile(a.group);
    h.warm.precompile(a.group);
    h.warm.precompile(b.group); // never parented (replaced before the frame)
    h.warm.tick(0);
    expect(h.r.ops('compileAsync').map(c => c.args[0])).toEqual([a.group]);
  });
});

describe('PERF.4 RendererWarmup — the cover-time warm', () => {
  it('under the cover, once content is quiet: textures, then compileAsync(scene), then one scissored pass per frame', async () => {
    const h = harness({ target: null });
    h.env.covered = true;
    h.warm.tick(0);
    expect(h.r.calls).toEqual([]); // content just seen; waiting for quiet
    h.warm.tick(QUIET_MS - 1);
    expect(h.r.calls).toEqual([]);
    h.warm.tick(QUIET_MS);

    // 1. every material texture (hidden LOD + ShaderMaterial uniform included), once each
    const inits = h.r.ops('initTexture').map(c => c.args[0]);
    expect(new Set(inits)).toEqual(new Set(h.textures));
    expect(inits.length).toBe(h.textures.length);
    expect(inits).not.toContain(h.pendingTex);

    // 2. compileAsync of the whole scene with the real camera, against the canvas
    const compiles = h.r.ops('compileAsync');
    expect(compiles.length).toBe(1);
    expect(compiles[0].args[0]).toBe(h.scene);
    expect(compiles[0].args[1]).toBe(h.camera);
    expect(compiles[0].target).toBeNull();
    expect(h.warm.busy).toBe(true);

    // No render until the programs are ready.
    h.warm.tick(QUIET_MS + 16);
    expect(h.r.ops('render').length).toBe(0);
    h.r.resolveCompiles();
    await flush();

    // 3. one pass per frame: WARM_HEADINGS yaw headings + one look-down
    for (let i = 0; i < WARM_HEADINGS + 1; i++) {
      h.warm.tick(QUIET_MS + 32 + i * 16);
      expect(h.r.ops('render').length).toBe(i + 1);
    }
    expect(h.warm.busy).toBe(false);
    h.warm.tick(2000);
    expect(h.r.ops('render').length).toBe(WARM_HEADINGS + 1);

    const renders = h.r.ops('render');
    const camPos = new THREE.Vector3();
    h.camera.getWorldPosition(camPos);
    const yaws = new Set<number>();
    for (const c of renders) {
      const [scene, cam, pos, rot] = c.args as [THREE.Scene, THREE.Camera, THREE.Vector3, THREE.Euler, number];
      expect(scene).toBe(h.scene);
      expect(cam).not.toBe(h.camera); // a private warm camera
      expect((pos as THREE.Vector3).distanceTo(camPos)).toBeLessThan(1e-9);
      expect(c.scissorTest).toBe(true);
      expect(c.scissor).toEqual([0, 0, 1, 1]);
      expect(c.target).toBeNull();
      yaws.add(Math.round((rot as THREE.Euler).y * 1e6));
    }
    // Horizontal headings cover the full circle; the extra pass pitches down.
    expect(yaws.size).toBeGreaterThanOrEqual(WARM_HEADINGS);
    expect((renders[WARM_HEADINGS].args[3] as THREE.Euler).x).toBeLessThan(-0.5);
    expect(h.warm.stats.coverWarms).toBe(1);
  });

  it('no visible state changes: camera, scene graph, materials, and the renderer\'s target/scissor are restored', async () => {
    const rt = new THREE.WebGLRenderTarget(4, 4);
    const h = harness({ target: rt });
    const camBefore = {
      pos: h.camera.position.clone(), quat: h.camera.quaternion.clone(),
      fov: h.camera.fov, aspect: h.camera.aspect, proj: h.camera.projectionMatrix.clone(),
    };
    const children = [...h.scene.children];
    const materialsBefore = h.scene.children.map(o => JSON.stringify((o as THREE.Mesh).material));
    h.env.covered = true;
    h.warm.tick(0);
    h.warm.tick(QUIET_MS);
    expect(h.r.target).toBe(rt);
    h.r.resolveCompiles();
    await flush();
    for (let i = 0; i < WARM_HEADINGS + 1; i++) {
      h.warm.tick(QUIET_MS + 16 * (i + 1));
      expect(h.r.target).toBe(rt);
      expect(h.r.scissorTest).toBe(false);
      expect(h.r.scissor.toArray()).toEqual([3, 4, 500, 400]);
    }
    expect(h.r.ops('render').length).toBe(WARM_HEADINGS + 1);
    expect(h.camera.position.equals(camBefore.pos)).toBe(true);
    expect(h.camera.quaternion.equals(camBefore.quat)).toBe(true);
    expect(h.camera.fov).toBe(camBefore.fov);
    expect(h.camera.aspect).toBe(camBefore.aspect);
    expect(h.camera.projectionMatrix.equals(camBefore.proj)).toBe(true);
    expect(h.scene.children).toEqual(children);
    expect(h.hidden.visible).toBe(false);
    expect(h.scene.children.map(o => JSON.stringify((o as THREE.Mesh).material))).toEqual(materialsBefore);
  });

  it('the cover dropping mid-compile cancels the sweep; dropping mid-sweep stops it at once', async () => {
    const h = harness();
    h.env.covered = true;
    h.warm.tick(0);
    h.warm.tick(QUIET_MS);
    h.env.covered = false; // hidePortalSpace() before the programs were ready
    h.warm.tick(QUIET_MS + 16);
    h.r.resolveCompiles();
    await flush();
    for (let t = 400; t < 1000; t += 16) h.warm.tick(t);
    expect(h.r.ops('render')).toEqual([]);
    expect(h.warm.busy).toBe(false);

    // Next cover: finishes then, and stops rendering the moment the cover lifts.
    h.env.covered = true;
    h.warm.tick(2000);
    h.r.resolveCompiles();
    await flush();
    h.warm.tick(2016);
    h.warm.tick(2032);
    expect(h.r.ops('render').length).toBe(2);
    h.env.covered = false;
    for (let t = 2048; t < 3000; t += 16) h.warm.tick(t);
    expect(h.r.ops('render').length).toBe(2);
  });

  it('streaming that never goes quiet still warms after MAX_WAIT_MS of cover', () => {
    const h = harness();
    h.env.covered = true;
    let t = 0;
    for (; t < MAX_WAIT_MS; t += 16) {
      h.env.version++;
      h.warm.tick(t);
      expect(h.r.ops('compileAsync').length).toBe(0);
    }
    h.env.version++;
    h.warm.tick(t);
    expect(h.r.ops('compileAsync').length).toBe(1);
  });

  it('re-warms when more content lands under the same cover, and on the next arrival (requestWarm)', async () => {
    const h = harness();
    h.env.covered = true;
    h.warm.tick(0);
    h.warm.tick(QUIET_MS);
    h.r.resolveCompiles();
    await flush();
    let t = QUIET_MS;
    for (let i = 0; i < WARM_HEADINGS + 2; i++) h.warm.tick((t += 16));
    expect(h.warm.stats.coverWarms).toBe(1);
    // Same content, still covered: nothing more.
    h.warm.tick((t += 1000));
    expect(h.r.ops('compileAsync').length).toBe(1);
    // A landblock finishes loading under the cover.
    h.env.version++;
    h.warm.tick((t += 16));
    h.warm.tick((t += QUIET_MS));
    expect(h.r.ops('compileAsync').length).toBe(2);
    h.r.resolveCompiles();
    await flush();
    for (let i = 0; i < WARM_HEADINGS + 2; i++) h.warm.tick((t += 16));
    // Cover lifts, then a teleport covers again with unchanged content.
    h.env.covered = false;
    h.warm.tick((t += 16));
    h.warm.requestWarm();
    h.env.covered = true;
    h.warm.tick((t += 16));
    h.warm.tick((t += QUIET_MS));
    expect(h.r.ops('compileAsync').length).toBe(3);
  });

  it('under the cover, play-time subtree compiles are subsumed by the full warm', () => {
    const h = harness({ parallel: true });
    h.env.covered = true;
    const block = new THREE.Group();
    h.scene.add(block);
    h.warm.noteAdded(block);
    h.warm.tick(0);
    h.env.covered = false;
    h.warm.tick(16);
    expect(h.r.ops('compileAsync').length).toBe(0);
  });
});

describe('PERF.4 GameUI.portalSpaceCovering tracks the opaque portal-space overlay (happy-dom, real GameUI)', () => {
  const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GameUICtor: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let domWindow: any;
  beforeAll(async () => {
    domWindow = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
    installDomGlobals(domWindow, DOM_GLOBALS, {});
    GameUICtor = (await import('../packages/renderer/src/ui/GameUI.js')).GameUI;
  });

  it('true while the tunnel covers the world: from the first teleport tick until teardown', () => {
    domWindow.document.body.innerHTML = '';
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    const ui = new GameUICtor(container);
    expect(ui.portalSpaceCovering).toBe(false);
    ui.playUISound = () => {};
    ui.showPortalSpace();
    ui.teleportTick(performance.now() / 1000); // UseTime: the tunnel appears
    expect(ui.portalSpaceCovering).toBe(true);
    ui.hidePortalSpace();
    expect(ui.portalSpaceCovering).toBe(false);
  });

  it('worldHiddenByPortalSpace is retail SmartBox::hidden: from the tunnel showing until its fade-out, which draws again under the cover', async () => {
    const { TeleportAnimState } = await import('../packages/renderer/src/effects/PortalSpaceModel.js');
    domWindow.document.body.innerHTML = '';
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    const ui = new GameUICtor(container);
    ui.playUISound = () => {};
    let t = 100;
    ui.portalClock = () => t;
    expect(ui.worldHiddenByPortalSpace).toBe(false); // character select / in world: drawn
    ui.showPortalSpace();
    ui.teleportTick(t);
    expect(ui.worldHiddenByPortalSpace).toBe(true); // SmartBox::Hide — the gate holds in here
    t += 5; ui.teleportTick(t);
    expect(ui.portalSpaceState).toBe(TeleportAnimState.Tunnel);
    expect(ui.worldHiddenByPortalSpace).toBe(true);
    ui.endPortalSpace();
    const seen: Array<[number, boolean, boolean]> = [];
    for (let i = 0; i < 400 && ui.portalSpaceState !== TeleportAnimState.Off; i++) {
      t += 0.02;
      ui.teleportTick(t);
      seen.push([ui.portalSpaceState, ui.portalSpaceCovering, ui.worldHiddenByPortalSpace]);
    }
    // The tunnel's fade-out draws the world under the still-opaque cover (a current frame at unmount)...
    expect(seen.some(([st, cov, hid]) => st === TeleportAnimState.TunnelFadeOut && cov && !hid)).toBe(true);
    // ...hidden through the rest of the tunnel, and drawn once the world fades back in.
    for (const [st, cov, hid] of seen) {
      if (st === TeleportAnimState.Tunnel || st === TeleportAnimState.TunnelContinue) expect(hid).toBe(true);
      if (!cov) expect(hid).toBe(false);
    }
    expect(seen.some(([st]) => st === TeleportAnimState.WorldFadeIn)).toBe(true);
    ui.hidePortalSpace();
    expect(ui.worldHiddenByPortalSpace).toBe(false);
  });
});

describe('SceneManager.skipDraw — a hidden-world frame keeps world matrices current without drawing', () => {
  it('updates the scene graph\'s world matrices (what render() would) and needs no renderer', async () => {
    const { SceneManager } = await import('../packages/renderer/src/scene/SceneManager.js');
    const sm = Object.create(SceneManager.prototype) as InstanceType<typeof SceneManager>;
    Object.assign(sm, { scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), renderer: null });
    const parent = new THREE.Group();
    parent.position.set(10, 0, 0);
    const child = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    child.position.set(0, 5, 0);
    parent.add(child);
    sm.scene.add(parent);
    sm.camera.position.set(1, 2, 3);
    sm.skipDraw();
    expect(new THREE.Vector3().setFromMatrixPosition(child.matrixWorld).toArray()).toEqual([10, 5, 0]);
    expect(new THREE.Vector3().setFromMatrixPosition(sm.camera.matrixWorld).toArray()).toEqual([1, 2, 3]);
  });
});

/**
 * The root cause the live probe found (measure-perf --gpu --program-keys, M3
 * Max, Holtburg): three.js keys every lit program on numPointLights, and the
 * DatLightBudget total followed cell visibility, so a camera turn cycled the
 * scene through 0/8/9/16/17/24/32/33/40/41 point lights and recompiled every
 * visible material at each count (156 new programs, 4 frames over 100 ms),
 * prewarmed or not. fixedLightCount pins the total three.js sees.
 */
describe('PERF.4 DatLightBudget fixedLightCount — the point-light total three.js keys programs on is constant', () => {
  /** What three.js counts: visible PointLights reached by traverseVisible (WebGLRenderer projectObject). */
  function threePointLights(root: THREE.Object3D): number {
    let n = 0;
    root.traverseVisible(o => { if ((o as THREE.PointLight).isPointLight) n++; });
    return n;
  }
  function datLight(parent: THREE.Object3D, x: number): THREE.PointLight {
    const l = new THREE.PointLight(0xffffff, 1, 10, 1);
    l.position.set(x, 0, 0);
    l.userData.datLight = true;
    l.visible = false;
    parent.add(l);
    return l;
  }
  // VISUAL.town-scenery-gaps — sized to the deg_mul 1 caps (60 + 10), the
  // most Automatic Degrades can reach, whatever the current caps are.
  const TOTAL = fixedPointLightTotal(RETAIL_MAX_LIGHT_CAPS, DEFAULT_RESERVED_EXTERNAL_LIGHTS, Infinity);

  it('the constant is every pool slot (40 static + 7 dynamic) plus the external headroom, capped by the device', () => {
    expect(fixedPointLightTotal(RETAIL_STARTUP_LIGHT_CAPS, DEFAULT_RESERVED_EXTERNAL_LIGHTS, Infinity)).toBe(40 + 7 + DEFAULT_RESERVED_EXTERNAL_LIGHTS);
    expect(fixedPointLightTotal(RETAIL_STARTUP_LIGHT_CAPS, 8, 30)).toBe(30);
    expect(TOTAL).toBe(60 + 10 + DEFAULT_RESERVED_EXTERNAL_LIGHTS);
  });

  it('Automatic Degrades stepping the caps (startup climb, a framerate dip) never changes the total', () => {
    expect(RETAIL_MAX_LIGHT_CAPS).toEqual({
      maxStaticLights: degradeLevelDerived(1).maxStaticLights, maxDynamicLights: degradeLevelDerived(1).maxDynamicLights,
    });
    const scene = new THREE.Scene();
    const cell = new THREE.Group();
    scene.add(cell);
    for (let i = 0; i < 80; i++) datLight(cell, i);
    scene.updateMatrixWorld(true);
    const budget = new DatLightBudget(scene, { fixedLightCount: true });
    const seen = new Set<number>();
    const enabled = new Set<number>();
    for (let k = -20; k <= 20; k++) {
      const caps = degradeLevelDerived(k / 20);
      budget.update(new THREE.Vector3(), k * 16, caps);
      seen.add(threePointLights(scene));
      enabled.add(budget.census().staticActive);
    }
    expect([...seen]).toEqual([TOTAL]);
    expect(enabled.size).toBeGreaterThan(5); // the caps really moved (20 → 60 static lights)
  });

  it('cell groups toggling in and out of view (a camera turn) never change the total; step padding did', () => {
    const scene = new THREE.Scene();
    const cells = Array.from({ length: 6 }, () => { const g = new THREE.Group(); scene.add(g); return g; });
    cells.forEach((g, ci) => { for (let i = 0; i < ci * 3 + 1; i++) datLight(g, ci * 10 + i); });
    scene.updateMatrixWorld(true);
    const fixed = new DatLightBudget(scene, { fillerStep: DEFAULT_FILLER_STEP, fixedLightCount: true });
    const stepScene = scene.clone(true);
    const stepped = new DatLightBudget(stepScene, { fillerStep: DEFAULT_FILLER_STEP });
    const stepCells = stepScene.children.filter(c => (c as THREE.Group).isGroup);
    const seenFixed = new Set<number>();
    const seenStep = new Set<number>();
    for (let mask = 0; mask < 64; mask++) {
      cells.forEach((g, i) => { g.visible = !!(mask & (1 << i)); });
      stepCells.forEach((g, i) => { g.visible = !!(mask & (1 << i)); });
      fixed.update(new THREE.Vector3(), mask);
      stepped.update(new THREE.Vector3(), mask);
      seenFixed.add(threePointLights(scene));
      seenStep.add(threePointLights(stepScene));
    }
    expect([...seenFixed]).toEqual([TOTAL]);
    expect(seenStep.size).toBeGreaterThan(2); // the variant churn fixedLightCount removes
  });

  it('with nothing pooled (open wilderness) the total is still the constant', () => {
    const scene = new THREE.Scene();
    const budget = new DatLightBudget(scene, { fixedLightCount: true });
    budget.update(new THREE.Vector3(), 0);
    expect(threePointLights(scene)).toBe(TOTAL);
    let fillers = 0;
    scene.traverse(o => { if (o.userData.datLightFiller && o.visible) { fillers++; expect((o as THREE.PointLight).intensity).toBe(0); } });
    expect(fillers).toBe(TOTAL);
  });

  it('external point lights (viewer light, a portal burst added between gathers) are absorbed every update', () => {
    const scene = new THREE.Scene();
    const cell = new THREE.Group();
    scene.add(cell);
    for (let i = 0; i < 12; i++) datLight(cell, i);
    const budget = new DatLightBudget(scene, { fixedLightCount: true });
    budget.update(new THREE.Vector3(), 0); // gather happens here
    expect(threePointLights(scene)).toBe(TOTAL);
    const viewer = new THREE.PointLight(0xffffff, 2.25, 15, 1);
    scene.add(viewer);
    const burst = new THREE.Group();
    burst.add(new THREE.PointLight(0xff00ff, 4, 20), new THREE.PointLight(0xff00ff, 2.5, 15));
    scene.add(burst);
    budget.update(new THREE.Vector3(), 16); // well inside REFRESH_MS: no re-gather
    expect(budget.externalCount).toBe(3);
    expect(threePointLights(scene)).toBe(TOTAL);
    viewer.visible = false; // stepping outdoors
    scene.remove(burst); // burst expired
    budget.update(new THREE.Vector3(), 32);
    expect(threePointLights(scene)).toBe(TOTAL);
  });

  it('a DAT-light subtree unloaded between gathers does not shrink the total', () => {
    const scene = new THREE.Scene();
    const block = new THREE.Group();
    scene.add(block);
    for (let i = 0; i < 20; i++) datLight(block, i);
    const budget = new DatLightBudget(scene, { fixedLightCount: true });
    budget.update(new THREE.Vector3(), 0);
    expect(threePointLights(scene)).toBe(TOTAL);
    scene.remove(block); // landblock unload
    budget.update(new THREE.Vector3(), 16); // no re-gather yet
    expect(threePointLights(scene)).toBe(TOTAL);
    expect(attachedAndVisible(block.children[0], scene)).toBe(false);
  });
});
