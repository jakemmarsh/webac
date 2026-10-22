/**
 * PERF.firefox-cover-compile-stall — the portal-space warm froze Firefox.
 *
 * Production, 2026-10-22 (build ba2c2cb5): a new player on Firefox 158 /
 * Windows / "ANGLE (Intel, Intel(R) HD Graphics Direct3D11)" closed the tab
 * 14.2 s after entering; first_minute had frames=8 worldFrames=0, warmup
 * 348.6 ms a frame over 8 frames (2.8 s), compileMs 2722, programsCreated 17,
 * workP95 at its 2000 ms cap. Firefox has no KHR_parallel_shader_compile:
 * three.js then marks every program ready at once, compileAsync resolves on
 * a 10 ms timer, and the warm's first sweep render waited for every link in
 * one frame, while the portal-space tunnel (drawn from the same main thread)
 * stood still.
 *
 * These tests drive the REAL RendererWarmup through a REAL three.js
 * WebGLRenderer on the recording stub context (tests/_harness/stubGl.ts),
 * which counts link waits: the first query of a linked program's results,
 * where a driver without the extension blocks. A fake clock charges each
 * link wait a fixed cost, as the GPU process does.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as THREE from 'three';
import {
  RendererWarmup, WARM_SLICE_BUDGET_MS, WARM_HEADINGS, MAX_WAIT_MS, QUIET_MS, PARALLEL_COMPILE_EXT,
} from '../packages/renderer/src/scene/RendererWarmup.js';
import {
  TeleportAnimation, TeleportAnimState, TELEPORT_ANIM_WARM_HOLD_MAX_TIME,
} from '../packages/renderer/src/effects/PortalSpaceModel.js';
import { createStubRenderer } from './_harness/stubGl.js';

/** One program link on the reporter's GPU, roughly: 2722 ms / 17 programs. */
const LINK_MS = 160;
const FRAME_MS = 16;
const POINT_LIGHTS = 6;

function tex(): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array(4), 1, 1);
  t.needsUpdate = true;
  return t;
}

/**
 * A small world: pinned point lights + sun + ambient + fog, and many meshes
 * over a dozen material kinds (shared materials, material arrays, an
 * instanced mesh, points, a sprite, a transparent double-sided material, a
 * hidden degrade level), so several distinct programs and many repeats.
 */
function buildWorld() {
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x808080, 10, 500);
  const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 2000);
  camera.position.set(10, 2, 10);
  camera.updateMatrixWorld(true);
  for (let i = 0; i < POINT_LIGHTS; i++) {
    const l = new THREE.PointLight(0xffffff, i === 0 ? 1 : 0, 10, 1);
    l.position.set(i, 1, 0);
    scene.add(l);
  }
  scene.add(new THREE.DirectionalLight(0xffffff, 1), new THREE.AmbientLight(0x404040));
  const shared = {
    lambertMap: new THREE.MeshLambertMaterial({ map: tex() }),
    lambert: new THREE.MeshLambertMaterial({ color: 0x884422 }),
    basicMap: new THREE.MeshBasicMaterial({ map: tex() }),
    basic: new THREE.MeshBasicMaterial({ color: 0x00ff00 }),
    phong: new THREE.MeshPhongMaterial({ map: tex() }),
    standard: new THREE.MeshStandardMaterial({ roughness: 0.5 }),
    alphaTest: new THREE.MeshLambertMaterial({ map: tex(), alphaTest: 0.5 }),
    glass: new THREE.MeshLambertMaterial({ transparent: true, opacity: 0.5, side: THREE.DoubleSide }),
    shader: new THREE.ShaderMaterial({
      uniforms: { u: { value: tex() } },
      vertexShader: 'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform sampler2D u; void main() { gl_FragColor = texture2D(u, vec2(0.5)); }',
    }),
  };
  const box = new THREE.BoxGeometry();
  const block = new THREE.Group();
  scene.add(block);
  const kinds = Object.values(shared);
  for (let i = 0; i < 300; i++) {
    // Each material repeats many times, as a landblock's objects share a few hundred materials.
    const m = new THREE.Mesh(box, kinds[i % kinds.length]);
    m.position.set(i % 20, 0, Math.floor(i / 20));
    block.add(m);
  }
  // Equal parameters, different material objects: three shares their program.
  for (let i = 0; i < 20; i++) block.add(new THREE.Mesh(box, new THREE.MeshLambertMaterial({ map: tex() })));
  block.add(new THREE.Mesh(box, [shared.lambert, shared.basicMap]));
  const inst = new THREE.InstancedMesh(box, shared.lambertMap, 4);
  block.add(inst);
  block.add(new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3)),
    new THREE.PointsMaterial({ size: 2 })));
  block.add(new THREE.Sprite(new THREE.SpriteMaterial({ map: tex() })));
  const degraded = new THREE.Mesh(box, new THREE.MeshLambertMaterial({ emissive: 0x111111 }));
  degraded.visible = false; // a degrade level not drawn yet: its program is still warmed
  block.add(degraded);
  scene.updateMatrixWorld(true);
  return { scene, camera, block };
}

/**
 * The live programs' cache keys. A ShaderMaterial's key starts with its two
 * shader-stage ids, numbered per renderer in first-seen order, so those are
 * normalised; everything else (light counts, fog, instancing, side, maps) is
 * compared as three.js keys it.
 */
function programKeys(renderer: THREE.WebGLRenderer): string[] {
  return (renderer.info.programs ?? [])
    .map(p => (p as unknown as { cacheKey: string }).cacheKey.replace(/^\d+,\d+,/, 'shader,'))
    .sort();
}

/** The programs compile(scene, camera) makes on a fresh renderer: what the warm must leave compiled. */
function referencePrograms(): string[] {
  const { renderer } = createStubRenderer(64, 64);
  const w = buildWorld();
  renderer.compile(w.scene, w.camera);
  return programKeys(renderer);
}

function warmHarness(opts: { parallel: boolean }) {
  const clock = { ms: 0 };
  const { renderer, stub } = createStubRenderer(64, 64, {
    extensions: opts.parallel ? [PARALLEL_COMPILE_EXT] : [],
    onLinkWait: () => { clock.ms += LINK_MS; },
  });
  const w = buildWorld();
  const env = { covered: false, version: 1 };
  const warm = new RendererWarmup(renderer, w.scene, w.camera, {
    isCovered: () => env.covered,
    contentVersion: () => env.version,
    clock: () => clock.ms,
  });
  /** One frame: the frame clock moves on, the warm ticks; returns that tick's link waits and main-thread ms. */
  const frame = () => {
    clock.ms += FRAME_MS;
    const links0 = stub.log.linkWaits, t0 = clock.ms;
    warm.tick(clock.ms);
    return { links: stub.log.linkWaits - links0, ms: clock.ms - t0 };
  };
  return { renderer, stub, clock, env, warm, frame, ...w };
}

/**
 * A cover warm leaves every program compile(scene) makes, plus one program
 * per object kind for the play-time upload draw (stepUploadKinds), and nothing else.
 */
function expectCoverWarmed(h: ReturnType<typeof warmHarness>): void {
  const live = programKeys(h.renderer);
  const ref = referencePrograms();
  for (const k of ref) expect(live).toContain(k);
  expect(live.length - ref.length).toBe(h.warm.stats.uploadKindsLinked);
  for (const k of live.filter(k => !ref.includes(k))) expect(k.startsWith('basic,')).toBe(true);
}

const flush = () => new Promise(res => setTimeout(res, 20));
const settle = () => new Promise(res => setImmediate(res));

/** Covered frames until a cover warm has started and finished; each frame's link waits and ms. */
async function runCover(h: ReturnType<typeof warmHarness>) {
  h.env.covered = true;
  const perTick: Array<{ links: number; ms: number; busy: boolean }> = [];
  const warms0 = h.warm.stats.coverWarms, sweeps0 = h.warm.stats.sweepRenders;
  const settled = () => h.warm.stats.coverWarms !== warms0 && !h.warm.busy && h.warm.stats.sweepRenders > sweeps0;
  for (let i = 0; i < 1000 && !settled(); i++) {
    const f = h.frame();
    perTick.push({ ...f, busy: h.warm.busy });
    await settle();
  }
  return perTick;
}

/** Covered frames until a cover warm starts. */
async function untilWarmStarts(h: ReturnType<typeof warmHarness>): Promise<void> {
  h.env.covered = true;
  const warms0 = h.warm.stats.coverWarms;
  for (let i = 0; i < 1000 && h.warm.stats.coverWarms === warms0; i++) { h.frame(); await settle(); }
}

describe('PERF.firefox-cover-compile-stall — the root cause in three.js 0.186 without KHR_parallel_shader_compile', () => {
  it('compileAsync waits for no link; the first render waits for every one of them in that one call', async () => {
    const { renderer, stub } = createStubRenderer(64, 64);
    const w = buildWorld();
    const p = renderer.compileAsync(w.scene, w.camera);
    const created = stub.log.programsCreated;
    expect(created).toBeGreaterThanOrEqual(8);
    expect(stub.log.linkWaits).toBe(0); // compile and link only queued
    await p; // resolves on a timer: every program reports ready at once
    expect(stub.log.linkWaits).toBe(0);
    renderer.render(w.scene, w.camera);
    // Every program the scene draws is waited for inside the one render (the ~2.7 s frame).
    expect(stub.log.linkWaits).toBeGreaterThanOrEqual(created - 1);
  });
});

describe('PERF.firefox-cover-compile-stall — RendererWarmup without KHR_parallel_shader_compile slices the cover warm', () => {
  // A batch holds one new material: one program, or two for a transparent
  // DoubleSide material (three compiles its BackSide and FrontSide passes).
  const MAX_LINKS_PER_FRAME = 2;

  it('no frame waits for more than one material\'s links once a link outlasts the budget, and the tunnel gets every frame between', async () => {
    const h = warmHarness({ parallel: false });
    const perTick = await runCover(h);
    const totalLinks = perTick.reduce((n, t) => n + t.links, 0);
    expect(totalLinks).toBeGreaterThanOrEqual(8);
    // The old warm waited for all of them in one frame; now one material's at most.
    expect(Math.max(...perTick.map(t => t.links))).toBeLessThanOrEqual(MAX_LINKS_PER_FRAME);
    expect(perTick.filter(t => t.links > 1).length).toBeLessThanOrEqual(1); // only the double-sided glass
    // A frame's main-thread time: at most the budget plus the links that overran it.
    for (const t of perTick) expect(t.ms).toBeLessThanOrEqual(WARM_SLICE_BUDGET_MS + MAX_LINKS_PER_FRAME * LINK_MS);
    expect(h.warm.stats.sliceMaxStepMs).toBeLessThanOrEqual(WARM_SLICE_BUDGET_MS + MAX_LINKS_PER_FRAME * LINK_MS);
    expect(h.warm.stats.slicedLinks).toBe(totalLinks);
  });

  it('every program compile(scene) makes is compiled and linked before the warm ends; the sweep then compiles nothing', async () => {
    const h = warmHarness({ parallel: false });
    await runCover(h);
    expect(h.warm.busy).toBe(false);
    expect(h.warm.stats.sweepRenders).toBe(WARM_HEADINGS + 1);
    // The same programs (keys carry the pinned point-light count, fog, instancing, side, ...).
    expectCoverWarmed(h);
    // Nothing left for the sweep or the first world frame: no new program, no link wait.
    const created = h.stub.log.programsCreated, waits = h.stub.log.linkWaits;
    h.renderer.render(h.scene, h.camera);
    expect(h.stub.log.programsCreated).toBe(created);
    expect(h.stub.log.linkWaits).toBe(waits);
  });

  it('the total time is the links\' own: about one frame per program, not longer than the one-frame warm by more than the frames between', async () => {
    const h = warmHarness({ parallel: false });
    const perTick = await runCover(h);
    const links = perTick.reduce((n, t) => n + t.links, 0);
    // Frames from the warm's start to its end (the frames before it waited for content to settle).
    const ticks = perTick.length - perTick.findIndex(t => t.busy);
    // Slicing frames + the 5 sweep frames; no idle frames beyond one per program plus a few cheap ones.
    expect(ticks).toBeLessThanOrEqual(links + WARM_HEADINGS + 1 + 4);
  });

  it('the renderer\'s render target is the canvas while compiling (the canvas program variant) and restored after', async () => {
    const h = warmHarness({ parallel: false });
    const rt = new THREE.WebGLRenderTarget(4, 4);
    h.renderer.setRenderTarget(rt);
    const seen: Array<THREE.WebGLRenderTarget | null> = [];
    const compile = h.renderer.compile.bind(h.renderer);
    h.renderer.compile = (s, c, t) => { seen.push(h.renderer.getRenderTarget()); return compile(s, c, t); };
    await runCover(h);
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set([null]));
    expect(h.renderer.getRenderTarget()).toBe(rt);
  });

  it('nothing visible changes: no object is re-parented and no matrix moves', async () => {
    const h = warmHarness({ parallel: false });
    const parents = h.block.children.map(c => c.parent);
    const m0 = h.block.children[7].matrixWorld.clone();
    await runCover(h);
    expect(h.block.children.map(c => c.parent)).toEqual(parents);
    expect(h.block.children[7].matrixWorld.equals(m0)).toBe(true);
  });

  it('an object unloaded mid-warm is skipped: its own material never gets a program', async () => {
    const h = warmHarness({ parallel: false });
    const lone = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshToonMaterial());
    const holder = new THREE.Group();
    holder.add(lone);
    h.scene.add(holder);
    await untilWarmStarts(h); // the job snapshots the scene, the toon mesh (added last) included
    expect(h.warm.busy).toBe(true);
    h.scene.remove(holder); // a landblock unloads under the cover
    for (let i = 0; i < 200 && h.warm.busy; i++) { h.frame(); await settle(); }
    expect(h.warm.busy).toBe(false);
    expect(programKeys(h.renderer).some(k => k.includes('TOON'))).toBe(false);
  });

  it('the cover lifting mid-warm stops it at once; the next cover finishes the rest', async () => {
    const h = warmHarness({ parallel: false });
    await untilWarmStarts(h);
    h.frame();
    expect(h.warm.busy).toBe(true);
    h.env.covered = false;
    const links0 = h.stub.log.linkWaits;
    for (let i = 0; i < 20; i++) h.frame();
    expect(h.stub.log.linkWaits).toBe(links0);
    expect(h.warm.busy).toBe(false);
    await runCover(h);
    expectCoverWarmed(h);
  });
});

describe('PERF.firefox-cover-compile-stall — with KHR_parallel_shader_compile the warm is unchanged', () => {
  it('one compileAsync of the whole scene, no sliced batches, no link forced by the warm before the sweep', async () => {
    const h = warmHarness({ parallel: true });
    const calls: unknown[] = [];
    const compileAsync = h.renderer.compileAsync.bind(h.renderer);
    h.renderer.compileAsync = (s, c, t) => { calls.push(s); return compileAsync(s, c, t); };
    await untilWarmStarts(h);
    expect(calls).toEqual([h.scene]);
    expect(h.stub.log.linkWaits).toBe(0);
    expect(h.warm.stats.sliceSteps).toBe(0);
    expect(h.warm.stats.slicedBatches).toBe(0);
    await flush();
    for (let i = 0; i < WARM_HEADINGS + 2; i++) h.frame();
    expect(h.warm.busy).toBe(false);
    expect(h.warm.stats.sweepRenders).toBe(WARM_HEADINGS + 1);
    expect(calls).toEqual([h.scene]);
  });
});

describe('PERF.firefox-cover-compile-stall — precompile (character select) without the extension is sliced too', () => {
  it('a queued subtree compiles over frames, at most one link a frame, and the KHR path keeps its one compileAsync', async () => {
    const h = warmHarness({ parallel: false });
    h.warm.precompile(h.block);
    const perTick: number[] = [];
    for (let i = 0; i < 300; i++) perTick.push(h.frame().links);
    expect(perTick.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(8);
    expect(Math.max(...perTick)).toBeLessThanOrEqual(2); // one material's programs (two: the double-sided glass)
    expect(programKeys(h.renderer)).toEqual(referencePrograms());

    const k = warmHarness({ parallel: true });
    const calls: unknown[] = [];
    const compileAsync = k.renderer.compileAsync.bind(k.renderer);
    k.renderer.compileAsync = (s, c, t) => { calls.push(s); return compileAsync(s, c, t); };
    k.warm.precompile(k.block);
    k.frame();
    k.frame();
    expect(calls).toEqual([k.block]);
    expect(k.warm.stats.sliceSteps).toBe(0);
  });

  it('a cover arriving mid-precompile drops it: the cover warm takes over the whole scene that frame', () => {
    const h = warmHarness({ parallel: false });
    h.warm.precompile(h.block);
    h.frame();
    expect(h.warm.stats.precompiles).toBe(1);
    h.env.covered = true;
    h.env.version++; // content still settling: the sliced cover warm starts anyway
    h.frame();
    expect(h.warm.stats.coverWarms).toBe(1);
    expect(h.warm.slicing).toBe(true);
    h.env.covered = false;
    for (let i = 0; i < 5; i++) h.frame();
    expect(h.warm.stats.precompiles).toBe(1); // not resumed: the cover warm covered it
  });
});

describe('PERF.firefox-cover-compile-stall — an arrival warm does not wait for streaming to go quiet', () => {
  it('sliced (no extension): the cover warm starts on the first covered frame, streaming or not', () => {
    const h = warmHarness({ parallel: false });
    h.env.covered = true;
    h.env.version++;
    h.frame();
    expect(h.warm.stats.coverWarms).toBe(1);
    expect(h.warm.slicing).toBe(true);
  });

  it('after requestWarm under a cover that already warmed, streaming that never pauses still warms after MAX_WAIT_MS', async () => {
    const h = warmHarness({ parallel: true });
    let compiles = 0;
    const compileAsync = h.renderer.compileAsync.bind(h.renderer);
    h.renderer.compileAsync = (s, c, t) => { compiles++; return compileAsync(s, c, t); };
    h.env.covered = true;
    // The login gate's cover: warmed once while the hold waited.
    for (let i = 0; i < Math.ceil(MAX_WAIT_MS / FRAME_MS) + 2; i++) { h.env.version++; h.frame(); await settle(); }
    expect(compiles).toBe(1);
    for (let i = 0; i < WARM_HEADINGS + 2; i++) { h.env.version++; h.frame(); await settle(); }
    expect(h.warm.busy).toBe(false);
    // startGame: arrival, landblocks streaming in every frame from here on.
    h.warm.requestWarm();
    const start = h.clock.ms;
    while (compiles === 1 && h.clock.ms - start < 5 * MAX_WAIT_MS) { h.env.version++; h.frame(); await settle(); }
    expect(compiles).toBe(2);
    expect(h.clock.ms - start).toBeLessThanOrEqual(MAX_WAIT_MS + 2 * FRAME_MS);
    expect(h.clock.ms - start).toBeGreaterThanOrEqual(QUIET_MS); // not at once: streaming is given its chance to settle
  });
});

describe('PERF.firefox-cover-compile-stall — the arrival tunnel waits for a sliced warm (a named browser-UX exception, capped)', () => {
  it('holding: CONTINUE passes retail\'s exits and its 5 s cap, up to TELEPORT_ANIM_WARM_HOLD_MAX_TIME; not holding: retail as before', () => {
    const held = new TeleportAnimation(() => 0.5);
    held.begin(TeleportAnimState.Tunnel, 0);
    held.end(1);
    // frame 72 → 1.2 s left: retail's exit window, 2 s after the end.
    expect(held.update(3.0, 72, true).state).toBe(TeleportAnimState.TunnelContinue);
    expect(held.update(6.0, 0, true).state).toBe(TeleportAnimState.TunnelContinue); // past retail's 5 s
    expect(held.update(1 + TELEPORT_ANIM_WARM_HOLD_MAX_TIME - 0.1, 72, true).state).toBe(TeleportAnimState.TunnelContinue);
    expect(held.update(1 + TELEPORT_ANIM_WARM_HOLD_MAX_TIME, 0, true).state).toBe(TeleportAnimState.TunnelFadeOut); // our cap
    // The hold dropping after 5 s: out at once (retail's cap has passed), not at the next window.
    const late = new TeleportAnimation(() => 0.5);
    late.begin(TeleportAnimState.Tunnel, 0);
    late.end(1);
    expect(late.update(8.0, 0, true).state).toBe(TeleportAnimState.TunnelContinue);
    expect(late.update(8.1, 0, false).state).toBe(TeleportAnimState.TunnelFadeOut);
    const free = new TeleportAnimation(() => 0.5);
    free.begin(TeleportAnimState.Tunnel, 0);
    free.end(1);
    expect(free.update(3.0, 72, false).state).toBe(TeleportAnimState.TunnelFadeOut);
    // The hold lifting: the next window releases it.
    const lifted = new TeleportAnimation(() => 0.5);
    lifted.begin(TeleportAnimState.Tunnel, 0);
    lifted.end(1);
    expect(lifted.update(3.0, 72, true).state).toBe(TeleportAnimState.TunnelContinue);
    expect(lifted.update(3.1, 72, false).state).toBe(TeleportAnimState.TunnelFadeOut);
  });

  describe('GameUI passes the host\'s hold to each UseTime pass (happy-dom), never for a logoff', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let H: any;
    const env = { hold: false };
    beforeAll(async () => {
      const { mountGameUI } = await import('./_harness/gameui.js');
      H = await mountGameUI();
      H.ui.setUIHost({ gameFov: 90, setViewDistanceRatio: () => {}, portalTunnelHold: () => env.hold });
      H.ui.playUISound = () => {};
    });
    afterAll(() => H?.teardown());

    it('arrival: the hold reaches update(); a logoff fade: it does not', () => {
      const ui = H.ui;
      const anim = ui['teleportAnim'] as TeleportAnimation;
      const seen: boolean[] = [];
      const update = anim.update.bind(anim);
      anim.update = (now: number, frame: number, hold?: boolean) => { seen.push(!!hold); return update(now, frame, hold); };
      ui.showPortalSpace();
      const t0 = performance.now() / 1000;
      env.hold = true;
      ui.teleportTick(t0);
      env.hold = false;
      ui.teleportTick(t0 + 0.1);
      expect(seen).toEqual([true, false]);
      ui.hidePortalSpace();

      // A logoff's fade (pollLogOffRequest) runs the same loop: never held.
      const anim2 = ui['teleportAnim'] as TeleportAnimation;
      const seen2: boolean[] = [];
      const update2 = anim2.update.bind(anim2);
      anim2.update = (now: number, frame: number, hold?: boolean) => { seen2.push(!!hold); return update2(now, frame, hold); };
      ui.noteLogOffRequested(false);
      env.hold = true;
      expect(ui.pollLogOffRequest(performance.now() / 1000 + 10)).toBe(true);
      ui.teleportTick(performance.now() / 1000 + 10.1);
      expect(seen2.length).toBeGreaterThan(0);
      expect(seen2.every(h => h === false)).toBe(true);
      ui.hidePortalSpace();
    });
  });

  it('RendererWarmup.slicing is true only while a sliced cover warm compiles (not its sweep, never with the extension)', async () => {
    const h = warmHarness({ parallel: false });
    await untilWarmStarts(h);
    expect(h.warm.slicing).toBe(true);
    for (let i = 0; i < 500 && h.warm.slicing; i++) { h.frame(); await settle(); }
    expect(h.warm.slicing).toBe(false);
    expect(h.warm.busy).toBe(true); // the sweep follows; the tunnel need not wait for it
    const k = warmHarness({ parallel: true });
    k.env.covered = true;
    for (let i = 0; i < 100; i++) { k.frame(); expect(k.warm.slicing).toBe(false); await settle(); }
  });
});

/**
 * The live Firefox A/B of 24d9694a2 (2026-10-22, 150 ms injected per link):
 * the sliced warm still had programs left when the tunnel left at retail's
 * 5 s, and the fade-out's first world draw linked them all, a 3.3 s frame.
 * This replays a login on the stub: the login gate's cover with little in
 * the scene, then startGame (40 new programs' worth of world, requestWarm,
 * EndTeleportAnimation) with landblocks streaming in every frame for 3 s,
 * the real TeleportAnimation deciding when the world draws, and the world
 * drawn every frame it is not hidden, as main.ts does.
 */
describe('PERF.firefox-cover-compile-stall — a login on a slow-link machine: the cover never lifts with programs left', () => {
  const SLOW_LINK_MS = 150;
  const WORLD_PROGRAMS = 40;

  function simulateLogin(opts: { hold: boolean }) {
    const clock = { ms: 0 };
    const { renderer, stub } = createStubRenderer(64, 64, { onLinkWait: () => { clock.ms += SLOW_LINK_MS; } });
    const scene = new THREE.Scene();
    for (let i = 0; i < POINT_LIGHTS; i++) scene.add(new THREE.PointLight(0xffffff, 0, 10, 1));
    scene.add(new THREE.DirectionalLight(0xffffff, 1), new THREE.AmbientLight(0x404040));
    const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 2000);
    const box = new THREE.BoxGeometry();
    // The gate's scene: the sky and little else.
    scene.add(new THREE.Mesh(box, new THREE.MeshBasicMaterial({ map: tex() })), new THREE.Mesh(box, new THREE.MeshLambertMaterial()));
    let version = 1;
    const warm = new RendererWarmup(renderer, scene, camera, {
      isCovered: () => covered(), contentVersion: () => version, clock: () => clock.ms,
    });
    const anim = new TeleportAnimation(() => 0.5);
    const S = TeleportAnimState;
    const covered = () => anim.state === S.TunnelFadeIn || anim.state === S.Tunnel || anim.state === S.TunnelContinue || anim.state === S.TunnelFadeOut;
    // Forty distinct programs (one shader each), as a world's lit variants are.
    const worldMaterials = Array.from({ length: WORLD_PROGRAMS }, (_, i) => new THREE.ShaderMaterial({
      vertexShader: `// landblock variant ${i}\nvoid main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `void main() { gl_FragColor = vec4(${i}.0 / 40.0); }`,
    }));
    const frames: Array<{ atMs: number; links: number; ms: number; drew: boolean; covered: boolean; state: TeleportAnimState }> = [];
    let startGameAt = -1;
    anim.begin(S.Tunnel, 0);
    for (let i = 0; i < 4000; i++) {
      clock.ms += FRAME_MS;
      const t0 = clock.ms, links0 = stub.log.linkWaits;
      if (startGameAt < 0 && clock.ms >= 1500) {
        // startGame: the arrival ring, requestWarm, EndTeleportAnimation.
        for (let k = 0; k < 400; k++) scene.add(new THREE.Mesh(box, worldMaterials[k % WORLD_PROGRAMS]));
        version++;
        warm.requestWarm();
        anim.end(clock.ms / 1000);
        startGameAt = clock.ms;
      }
      if (startGameAt >= 0 && clock.ms - startGameAt < 3000) { // landblocks keep streaming in
        scene.add(new THREE.Mesh(box, worldMaterials[i % WORLD_PROGRAMS]));
        version++;
      }
      warm.tick(clock.ms);
      const now = clock.ms / 1000;
      anim.update(now, Math.floor(now * 40) % 120, opts.hold && warm.slicing);
      const hidden = covered() && anim.state !== S.TunnelFadeOut; // SmartBox hidden: no world draw
      if (!hidden) renderer.render(scene, camera);
      frames.push({ atMs: t0, links: stub.log.linkWaits - links0, ms: clock.ms - t0, drew: !hidden, covered: covered(), state: anim.state });
      if (anim.state === S.Off && clock.ms - startGameAt > 2000) break;
    }
    return { frames, startGameAt, offAt: frames.find(f => f.state === S.Off)?.atMs ?? Infinity, warm };
  }

  it('without the hold (retail\'s exits only) the fade-out\'s world draw links what the warm had left: the 3.3 s frame, reproduced', () => {
    const { frames } = simulateLogin({ hold: false });
    const burst = Math.max(...frames.filter(f => f.drew).map(f => f.links));
    expect(burst).toBeGreaterThanOrEqual(5);
    expect(Math.max(...frames.map(f => f.ms))).toBeGreaterThanOrEqual(5 * SLOW_LINK_MS);
  });

  it('with the hold: no frame links more than one program, the world\'s draws link nothing, and the tunnel ends once the links are done', () => {
    const { frames, startGameAt, offAt, warm } = simulateLogin({ hold: true });
    expect(Math.max(...frames.map(f => f.links))).toBeLessThanOrEqual(1);
    for (const f of frames) expect(f.ms).toBeLessThanOrEqual(FRAME_MS + WARM_SLICE_BUDGET_MS + SLOW_LINK_MS);
    expect(frames.filter(f => f.drew).reduce((n, f) => n + f.links, 0)).toBe(0);
    expect(warm.stats.slicedLinks).toBeGreaterThanOrEqual(WORLD_PROGRAMS);
    // One job for the whole cover: the arrival's content was taken into the gate's job, not queued behind it.
    expect(warm.stats.coverWarms).toBe(1);
    expect(warm.stats.sliceRefreshes).toBeGreaterThan(0);
    // Past retail's 5 s (the links alone take 6 s), but no later than the links plus the fade frames need.
    const links = frames.reduce((n, f) => n + f.links, 0);
    expect(offAt - startGameAt).toBeGreaterThan(5000);
    expect(offAt - startGameAt).toBeLessThanOrEqual(links * (SLOW_LINK_MS + FRAME_MS) + 3000);
  });
});

describe('PERF.firefox-cover-compile-stall — CompileTrace (window.__ac.compileTrace) names the frame that linked which programs', () => {
  it('keeps long frames and frames that created programs, with the programs (shader name + key hash) and the cover state', async () => {
    const { CompileTrace, ProgramCreationCounter } = await import('../packages/renderer/src/telemetry/MainThreadCost.js');
    const trace = new CompileTrace(250, 3);
    const counter = new ProgramCreationCounter(p => trace.noteProgram(p));
    const { renderer } = createStubRenderer(64, 64);
    counter.sample(renderer.info);
    const w = buildWorld();
    const frame = (draw: boolean, workMs: number) => {
      trace.frameBegin();
      if (draw) renderer.render(w.scene, w.camera);
      trace.frameEnd({ at: 0, workMs, warmupMs: 0, renderMs: workMs, covered: true, worldHidden: false, tunnelState: 5, warm: 'idle' });
    };
    frame(false, 5); // short, no programs: not kept
    expect(trace.frames).toEqual([]);
    frame(true, 3300); // the fade-out's first world draw
    expect(trace.frames.length).toBe(1);
    const f = trace.frames[0];
    expect(f.programs.length).toBe(counter.created);
    expect(f.programs.length).toBeGreaterThanOrEqual(8);
    for (const p of f.programs) expect(p).toMatch(/^[A-Za-z]+:[0-9a-f]{8}$/);
    // Named by material class (three's shaderType), not the usually empty material name.
    expect(f.programs.some(p => p.startsWith('MeshLambertMaterial:'))).toBe(true);
    expect(f.programs.some(p => p.startsWith('ShaderMaterial:'))).toBe(true);
    expect(f.tunnelState).toBe(5);
    // A program created outside frameStep is marked, and lands in the next kept frame.
    trace.noteProgram({ name: 'MeshLambertMaterial', cacheKey: 'k' });
    frame(false, 1);
    expect(trace.frames.at(-1)!.programs).toEqual([expect.stringMatching(/^~MeshLambertMaterial:/)]);
    for (let i = 0; i < 5; i++) frame(false, 400 + i);
    expect(trace.frames.length).toBe(3); // bounded
    expect(trace.longest(1)[0].workMs).toBe(404);
  });
});

/**
 * Pass 3 (live Firefox A/B of 69ecaa755): the longest frame, 2919 ms with 17
 * programs, was at TAS_TUNNEL_CONTINUE with covered=false. startGame opened
 * the tunnel itself (no gate hold) and ended it in the same call; the game
 * loop's frame runs before the teleport loop's in that browser frame, so it
 * saw CONTINUE with no overlay mounted, drew the world and linked everything.
 */
describe('PERF.firefox-cover-compile-stall — the tunnel covers from BeginTeleportAnimation, not from the overlay\'s mount (happy-dom, real GameUI)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let H: any;
  beforeAll(async () => {
    const { mountGameUI } = await import('./_harness/gameui.js');
    H = await mountGameUI();
    H.ui.setUIHost({ gameFov: 90, setViewDistanceRatio: () => {} });
    H.ui.playUISound = () => {};
  });
  afterAll(() => H?.teardown());

  it('show + end back to back (startGame\'s own tunnel): covered and the world hidden before the teleport loop has run once', () => {
    const ui = H.ui;
    expect(ui.portalSpaceCovering).toBe(false);
    expect(ui.worldHiddenByPortalSpace).toBe(false);
    ui.showPortalSpace();
    expect(ui.portalSpaceCovering).toBe(true); // TAS_TUNNEL: SmartBox::Hide at Begin
    expect(ui.worldHiddenByPortalSpace).toBe(true);
    ui.endPortalSpace();
    expect(ui.portalSpaceState).toBe(TeleportAnimState.TunnelContinue);
    expect(ui.portalSpaceCovering).toBe(true);
    expect(ui.worldHiddenByPortalSpace).toBe(true);
    // The loop's pass mounts the overlay; nothing changes for the world.
    const t0 = performance.now() / 1000;
    ui.teleportTick(t0);
    expect(ui.portalSpaceCovering).toBe(true);
    // ...and the usual exit: drawn in the fade-out under the cover, uncovered once torn down.
    ui.teleportTick(t0 + 6);
    expect(ui.portalSpaceState).toBe(TeleportAnimState.TunnelFadeOut);
    expect(ui.worldHiddenByPortalSpace).toBe(false);
    expect(ui.portalSpaceCovering).toBe(true);
    ui.teleportTick(t0 + 7.1);
    expect(ui.portalSpaceCovering).toBe(false);
    ui.hidePortalSpace();
    expect(ui.portalSpaceCovering).toBe(false);
  });

  it('a logoff\'s world fade-out still shows the world until the tunnel fades in', () => {
    const ui = H.ui;
    ui.noteLogOffRequested(false);
    expect(ui.pollLogOffRequest(performance.now() / 1000 + 10)).toBe(true);
    expect(ui.portalSpaceState).toBe(TeleportAnimState.WorldFadeOut);
    expect(ui.portalSpaceCovering).toBe(false);
    expect(ui.worldHiddenByPortalSpace).toBe(false);
    ui.hidePortalSpace();
  });

  it('frame order on the stub: the game loop\'s frame right after startGame starts the sliced warm and draws nothing', () => {
    const ui = H.ui;
    const clock = { ms: 0 };
    const { renderer, stub } = createStubRenderer(64, 64, { onLinkWait: () => { clock.ms += 150; } });
    const w = buildWorld();
    const warm = new RendererWarmup(renderer, w.scene, w.camera, {
      isCovered: () => ui.portalSpaceCovering, contentVersion: () => 1, clock: () => clock.ms,
    });
    // startGame: showArrivalTunnel → requestWarm → … → endPortalSpace, in one call.
    ui.showPortalSpace();
    warm.requestWarm();
    ui.endPortalSpace();
    // The game loop's frame (main.ts frameStep): warm tick, then draw unless hidden.
    clock.ms += 16;
    const links0 = stub.log.linkWaits;
    warm.tick(clock.ms);
    if (!ui.worldHiddenByPortalSpace) renderer.render(w.scene, w.camera);
    expect(warm.stats.coverWarms).toBe(1);
    expect(stub.log.linkWaits - links0).toBeLessThanOrEqual(1);
    ui.hidePortalSpace();
  });
});

/**
 * Pass 4 (live Firefox A/B of fa4bb7ccd): the last long frame, 673 ms in the
 * world after the cover, linked three unnamed programs inside frameStep. They
 * are the play-time upload draw's (warmAddedDuringPlay): one override
 * MeshBasicMaterial drawn over each newly streamed landblock, through a proxy
 * scene that gathered the landblock's own DAT point lights. three.js keys
 * every program on the point-light count, so each count (and each object
 * kind: plain, instanced, skinned) was a new program and a link, none of
 * which the cover warm had made.
 */
describe('PERF.firefox-cover-compile-stall — the play-time upload draw links nothing after the cover', () => {
  function landblock(lights: number, instanced: boolean): THREE.Group {
    const g = new THREE.Group();
    for (let i = 0; i < lights; i++) g.add(new THREE.PointLight(0xffffff, 1, 10, 1)); // DAT lights, enabled
    g.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshLambertMaterial({ map: tex() })));
    if (instanced) g.add(new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshLambertMaterial(), 3));
    return g;
  }

  async function arriveThenStream(): Promise<{ h: ReturnType<typeof warmHarness>; playLinks: number[]; playCreated: number }> {
    const h = warmHarness({ parallel: false });
    // The world at arrival already holds plain and instanced objects (scenery pools are InstancedMeshes).
    h.scene.add(landblock(3, true));
    h.env.version++;
    await runCover(h);
    h.env.covered = false;
    const created0 = h.stub.log.programsCreated;
    const playLinks: number[] = [];
    // Landblocks streaming in during play, each with a different number of enabled DAT lights.
    for (const n of [2, 0, 5, 1]) {
      const b = landblock(n, n % 2 === 0);
      h.scene.add(b);
      h.warm.noteAdded(b);
      playLinks.push(h.frame().links);
    }
    return { h, playLinks, playCreated: h.stub.log.programsCreated - created0 };
  }

  it('the cover warm links the upload draw\'s programs (one per object kind); streamed landblocks then create and link none', async () => {
    const { h, playLinks, playCreated } = await arriveThenStream();
    expect(h.warm.stats.uploadKindsLinked).toBeGreaterThanOrEqual(2); // plain + instanced
    expect(h.warm.stats.playUploadRenders).toBe(4);
    expect(playCreated).toBe(0);
    expect(playLinks).toEqual([0, 0, 0, 0]);
  });

  // The pre-linked programs are keyed on no point lights; the draw must match.
  // (three.js keeps an unlit material's program when only the light count
  // changes, so the FIRST upload draw's count is what stuck, and before the
  // flattening that was the first streamed landblock's own DAT lights.)
  it('the upload draw gathers no landblock lights: its program is keyed on 0 point lights, as the cover pre-linked it', () => {
    const { renderer, stub } = createStubRenderer(64, 64);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const warm = new RendererWarmup(renderer, scene, camera, { isCovered: () => false, contentVersion: () => 1 });
    const keys = new Set<string>();
    for (const n of [2, 0, 5]) {
      const b = landblock(n, false);
      scene.add(b);
      warm.noteAdded(b);
      warm.tick(n);
      for (const p of renderer.info.programs ?? []) keys.add((p as unknown as { cacheKey: string }).cacheKey);
    }
    expect(keys.size).toBe(1);
    expect(stub.log.programsCreated).toBe(1);
    // numPointLights sits right after the 'basic' material's booleans; compare with a 0-light compile.
    const { renderer: ref } = createStubRenderer(64, 64);
    const empty = new THREE.Scene();
    const probe = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    empty.add(probe);
    ref.compile(empty, new THREE.OrthographicCamera());
    const refKey = (ref.info.programs![0] as unknown as { cacheKey: string }).cacheKey;
    expect([...keys][0].replace(/onBeforeCompile.*$/, '')).toBe(refKey.replace(/onBeforeCompile.*$/, ''));
  });
});

/**
 * Pass 5 (live Firefox A/B of 91941a857): the last long frame, 673-676 ms
 * right after the tunnel (tunnelState 0, uncovered), linked three
 * MeshLambertMaterial programs the warm never made, the same three in both
 * runs. The leading suspect: a server object fading (ACE's OnTeleportComplete
 * un-hides the player as LoginComplete lands; materialize / death / cloak
 * fades): applyFadeToMeshes gives each part a faded copy (transparent, no
 * alpha test, normal blending), a program of its own per surface kind.
 * CompileTrace now names the object, its parents, the material's key inputs
 * and the key fields that differ, so the live probe can confirm it.
 */
describe('PERF.firefox-cover-compile-stall — a server object\'s fade links nothing after the cover', async () => {
  const { applyRetailLighting } = await import('../packages/renderer/src/models/RetailLighting.js');
  const { markSharedMaterial } = await import('../packages/renderer/src/models/MaterialOwnership.js');
  const { setPartTranslucency, fadedMaterialVariant, PHYSICS_STATE_KEY } = await import('../packages/renderer/src/models/ObjectTranslucency.js');
  const { CompileTrace, ProgramCreationCounter } = await import('../packages/renderer/src/telemetry/MainThreadCost.js');

  /** A server object (a creature / the player): parts with shared MaterialFactory-style lit surfaces. */
  function serverObject(): THREE.Group {
    const root = new THREE.Group();
    root.name = 'player';
    root.userData[PHYSICS_STATE_KEY] = 0;
    const surfaces = [
      markSharedMaterial(applyRetailLighting(new THREE.MeshLambertMaterial({ map: tex(), side: THREE.DoubleSide }), 'object')),
      markSharedMaterial(applyRetailLighting(new THREE.MeshLambertMaterial({ map: tex(), side: THREE.FrontSide, alphaTest: 0.5 }), 'object')),
      markSharedMaterial(applyRetailLighting(new THREE.MeshLambertMaterial({ color: 0x884422, side: THREE.FrontSide }), 'object')),
    ];
    surfaces.forEach((m, i) => {
      const part = new THREE.Group();
      part.name = `part_${i}`;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(), m);
      mesh.name = `gfx_${i}`;
      part.add(mesh);
      root.add(part);
    });
    return root;
  }

  async function arriveThenFade(withVariants: boolean) {
    const clock = { ms: 0 };
    const { renderer, stub } = createStubRenderer(64, 64, { onLinkWait: () => { clock.ms += LINK_MS; } });
    const trace = new CompileTrace(250, 20);
    const counter = new ProgramCreationCounter((p, existing) => trace.noteProgram(p, existing));
    counter.sample(renderer.info);
    trace.wrapRenderer(renderer);
    const w = buildWorld();
    const player = serverObject();
    w.scene.add(player);
    const env = { covered: true };
    const variants = new WeakMap<THREE.Material, THREE.Material>();
    const warm = new RendererWarmup(renderer, w.scene, w.camera, {
      isCovered: () => env.covered, contentVersion: () => 1, clock: () => clock.ms,
      ...(withVariants ? {
        variantFor: (o: THREE.Object3D, m: THREE.Material) => {
          let server = false;
          for (let q: THREE.Object3D | null = o; q; q = q.parent) if (q.userData[PHYSICS_STATE_KEY] !== undefined) server = true;
          if (!server || !(m instanceof THREE.MeshLambertMaterial)) return null;
          let v = variants.get(m);
          if (!v) { v = fadedMaterialVariant(m, (o as THREE.Mesh).geometry); variants.set(m, v); }
          return v;
        },
      } : {}),
    });
    trace.warmedMaterial = m => warm.compiledMaterial(m);
    const perTick: number[] = [];
    for (let i = 0; i < 600; i++) {
      clock.ms += FRAME_MS;
      const l0 = stub.log.linkWaits;
      warm.tick(clock.ms);
      perTick.push(stub.log.linkWaits - l0);
      await settle();
      if (i > 5 && !warm.busy && warm.stats.sweepRenders > 0) break;
    }
    // The cover lifts; the world draws; then the player materializes (fades in).
    env.covered = false;
    renderer.render(w.scene, w.camera);
    // Close the trace's earlier frames (the warm's programs), so the fade's frame stands alone.
    trace.frameEnd({ at: 0, workMs: 0, warmupMs: 0, renderMs: 0, covered: true, worldHidden: true, tunnelState: 4, warm: 'idle' });
    const created0 = stub.log.programsCreated, links0 = stub.log.linkWaits;
    trace.frameBegin();
    for (const part of player.children) setPartTranslucency(part, 0.5);
    renderer.render(w.scene, w.camera);
    trace.frameEnd({ at: 0, workMs: 0, warmupMs: 0, renderMs: 0, covered: false, worldHidden: false, tunnelState: 0, warm: 'idle' });
    return {
      warm, trace, perTick,
      fadeCreated: stub.log.programsCreated - created0, fadeLinks: stub.log.linkWaits - links0,
    };
  }

  it('without the variants, the first fade after the cover links the faded programs in one frame (the live 673 ms frame, reproduced) and CompileTrace names them', async () => {
    const { fadeCreated, fadeLinks, trace } = await arriveThenFade(false);
    expect(fadeCreated).toBeGreaterThanOrEqual(2);
    expect(fadeLinks).toBe(fadeCreated);
    const f = trace.frames.at(-1)!;
    expect(f.programs.every(p => p.startsWith('MeshLambertMaterial:'))).toBe(true);
    const d = f.details!;
    expect(d.length).toBe(fadeCreated);
    for (const x of d) {
      expect(x.object).toMatch(/^gfx_\d$/);
      expect(x.parents.slice(0, 2)).toEqual([expect.stringMatching(/^part_\d$/), 'player']);
      expect(x.material).toBe('MeshLambertMaterial');
      expect(x.materialFlags.transparent).toBe(true);
      expect(x.materialFlags.depthWrite).toBe(false);
      // The surface was compiled by the warm in its authored state: the fade changed its key, not its arrival.
      expect(x.warmed).toBe(false); // the faded copy itself is a new material...
      expect(x.keyDiff && x.keyDiff.length).toBeGreaterThan(0); // ...whose key differs from a warmed program in a few fields
    }
  });

  it('with the variants: the cover warm links each faded program, one a frame, and the fade then creates and links none', async () => {
    const { fadeCreated, fadeLinks, warm, perTick } = await arriveThenFade(true);
    expect(warm.stats.variantsCompiled).toBeGreaterThanOrEqual(3);
    expect(Math.max(...perTick)).toBeLessThanOrEqual(2);
    expect(fadeCreated).toBe(0);
    expect(fadeLinks).toBe(0);
  });
});
