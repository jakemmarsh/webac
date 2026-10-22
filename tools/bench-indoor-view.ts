/**
 * PERF.indoor-two-pass-cost — CPU cost of an indoor frame (scene/IndoorView.ts
 * renderIndoorView) against an ordinary single render(), on a real
 * THREE.WebGLRenderer over the recording stub context (tests/_harness/stubGl.ts:
 * no GPU, so this is the main-thread JS three.js and we spend per frame).
 *
 * The scene is sized like a town block from the first_minute telemetry
 * (Yaraq, 2026-10-20: ~23k scene objects, ~300 server objects): frozen
 * instancing pools and terrain, hundreds of env cell groups, animated server
 * objects (unfrozen part trees), static-script / particle nodes placed by
 * position, and DAT pool lights.
 *
 *   npx tsx tools/bench-indoor-view.ts            # all modes interleaved, median ms / frame
 *   npx tsx tools/bench-indoor-view.ts --frames 400
 *   npx tsx tools/bench-indoor-view.ts --impl <file>   # another IndoorView.ts (an older
 *     commit's, saved next to the current one so its imports resolve) on the same scene
 *
 * The stub's GL calls cost more than a driver's queueing, so per-draw work
 * weighs more here than in a browser; compare modes, not absolute numbers.
 */
import * as THREE from 'three';
import { resolve as resolvePath } from 'node:path';
import { indoorPassOf, type IndoorViewContext, type PortalPolygon } from '../packages/renderer/src/scene/IndoorView.js';
import { createStubRenderer } from '../tests/_harness/stubGl.js';

const argFrames = process.argv.indexOf('--frames');
const FRAMES = argFrames > 0 ? Number(process.argv[argFrames + 1]) : 300;

function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000); }

export function townScene(seed = 1) {
  const r = rng(seed);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0.6, 0.7, 0.9);
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const lit = new THREE.MeshLambertMaterial();
  const at = (o: THREE.Object3D) => { o.position.set((r() - 0.5) * 600, r() * 20, (r() - 0.5) * 600); return o; };
  const freeze = (o: THREE.Object3D) => { o.updateMatrixWorld(true); o.traverse((x) => { x.matrixAutoUpdate = false; x.matrixWorldAutoUpdate = false; }); };
  // Instancing pools (scenery / statics / building shells) and terrain blocks: frozen, top level.
  for (let i = 0; i < 200; i++) { const m = new THREE.InstancedMesh(geo, lit, 64); m.frustumCulled = false; m.name = `sceneryinst_${i}`; scene.add(m); freeze(m); }
  for (let i = 0; i < 49; i++) { const m = new THREE.Mesh(geo, lit); at(m); m.scale.set(192, 1, 192); scene.add(m); freeze(m); }
  // Env cells: a group (matrixAutoUpdate off) with frozen children, some with a DAT light.
  const blockKey = 0x7d64;
  for (let i = 0; i < 700; i++) {
    const g = new THREE.Group();
    const id = ((blockKey << 16) | (0x100 + i)) >>> 0;
    g.name = `envcell_${id.toString(16).padStart(8, '0')}`;
    g.userData.envCellId = id;
    at(g);
    g.matrixAutoUpdate = false; g.updateMatrix();
    for (let k = 0; k < 6; k++) { const m = new THREE.Mesh(geo, lit); m.position.set(k, 0, 0); g.add(m); freeze(m); }
    if (i % 4 === 0) { const pl = new THREE.PointLight(0xffc080, 0, 6, 1); pl.userData.datLight = true; pl.visible = i % 8 === 0; g.add(pl); }
    scene.add(g);
  }
  // Server objects: animated part trees (unfrozen), each in an outdoor land cell.
  for (let i = 0; i < 312; i++) {
    const g = new THREE.Group();
    g.name = `server_${(0x80000000 + i).toString(16)}`;
    g.userData.objCellId = ((blockKey << 16) | 0x21) >>> 0;
    at(g);
    for (let k = 0; k < 20; k++) { const p = new THREE.Group(); p.position.set(0, k * 0.1, 0); p.add(new THREE.Mesh(geo, lit)); g.add(p); }
    scene.add(g);
  }
  // Static scripts / particle systems: placed by position (indoorPassOf asks cellAt).
  for (let i = 0; i < 600; i++) {
    const pts = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3)), new THREE.PointsMaterial());
    pts.name = i % 2 ? `static_script_${i}` : `particles_${i}`;
    at(pts);
    scene.add(pts);
  }
  scene.add(new THREE.DirectionalLight(), new THREE.AmbientLight(), new THREE.PointLight());
  let n = 0; scene.traverse(() => { n++; });
  return { scene, objects: n };
}

export function benchCamera(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
  cam.position.set(0, 2, 0);
  cam.lookAt(0, 2, -10);
  cam.updateMatrixWorld();
  return cam;
}

function median(xs: number[]): number { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; }

/** Run every mode once per round (interleaved, so machine load hits them alike); median ms per mode. */
function interleaved(modes: [string, () => void][]): void {
  for (let i = 0; i < 30; i++) for (const [, f] of modes) f();
  const ms = modes.map(() => [] as number[]);
  for (let i = 0; i < FRAMES; i++) {
    modes.forEach(([, f], k) => { const t = performance.now(); f(); ms[k].push(performance.now() - t); });
  }
  modes.forEach(([label], k) => console.log(`${label.padEnd(64)} ${median(ms[k]).toFixed(3)} ms`));
}

if (process.argv[1]?.endsWith('bench-indoor-view.ts')) {
  const argImpl = process.argv.indexOf('--impl');
  const impl: typeof import('../packages/renderer/src/scene/IndoorView.js') = argImpl > 0
    ? await import(resolvePath(process.argv[argImpl + 1]))
    : await import('../packages/renderer/src/scene/IndoorView.js');
  const { renderer } = createStubRenderer(1280, 720);
  const { scene, objects } = townScene();
  const cam = benchCamera();
  console.log(`scene objects: ${objects}, top-level: ${scene.children.length}, frames: ${FRAMES}`);
  const ctx: IndoorViewContext = { blockKey: 0x7d64, cells: new Set([0x105, 0x106]), playerCellId: 0x7d640105, cellAt: (x, y) => (Math.abs(x) < 3 && Math.abs(y) < 3 ? 0x7d640105 : 0) };
  // A doorway 4 m ahead of the camera, and one 4 m behind it.
  const doorway = (z: number): PortalPolygon => [new THREE.Vector3(-1, 0, z), new THREE.Vector3(1, 0, z), new THREE.Vector3(1, 3, z), new THREE.Vector3(-1, 3, z)];
  const datLights: THREE.Object3D[] = [];
  scene.traverse((o) => { if (o.userData.datLight) datLights.push(o); });
  const lights: IndoorViewContext['forEachPointLight'] = (visit) => { for (const l of datLights) visit(l); };
  interleaved([
    ['ordinary frame: renderer.render', () => renderer.render(scene, cam)],
    ['indoor frame, no portal data / light list (two passes)', () => impl.renderIndoorView(renderer, scene, cam, ctx)],
    ['indoor frame, outdoor portal in view (two passes)', () => impl.renderIndoorView(renderer, scene, cam, { ...ctx, outsidePortals: [doorway(-4)], forEachPointLight: lights })],
    ['indoor frame, outdoor portal behind (cell pass only)', () => impl.renderIndoorView(renderer, scene, cam, { ...ctx, outsidePortals: [doorway(4)], forEachPointLight: lights })],
    ['  part: scene.updateMatrixWorld()', () => scene.updateMatrixWorld()],
    ['  part: indoorPassOf over the top level', () => { for (const c of scene.children) indoorPassOf(c, ctx); }],
    ['  part: traverseVisible (the old pad-count walk)', () => { let n = 0; scene.traverseVisible((o) => { if ((o as THREE.PointLight).isPointLight) n++; }); }],
  ]);
}
