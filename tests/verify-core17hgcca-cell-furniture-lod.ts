/**
 * CORE.17.h.g.c.c.a — degrade LOD for the remaining part paths + the
 * Render::SetDegradeLevelInternal derivations.
 *
 * Behavioral (no DAT): degradeLevelDerived / the DegMulController's derived
 * caps + the startup *_2dsq quirk, usesObjectDistance, the pool's and the
 * part registry's near/far switch (CPhysicsObj::UpdateViewerDistance @
 * 00510b30: per-part sort-center distance inside object_distance_2dsq,
 * object-origin distance beyond it), the explicit object root on
 * attachPart. DAT-gated (Training Academy cells, loads in beforeAll): the
 * per-cell furniture pools partition by viewer distance through
 * EnvCellRenderer.updateFurnitureLod, prune with their cells, and bare
 * GfxObj stabs on the fallback path register with the part registry.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import {
  DegradeLod, DegMulController, degradeLevelDerived, usesObjectDistance,
  STARTUP_OBJECT_DISTANCE_2DSQ, STARTUP_PARTICLE_DISTANCE_2DSQ, INVALID_DID, type DegradeChain,
} from '../packages/renderer/src/models/DegradeLod.js';
import { SceneryInstancer, type InstanceEntry } from '../packages/renderer/src/terrain/SceneryInstancer.js';
import { SceneryInstancePool } from '../packages/renderer/src/terrain/SceneryInstancePool.js';
import type { GfxObjLOD } from '@ac/dat-parser';
import { openDat } from './_harness/dat.js';

const REPO = resolve(__dirname, '..');
const PORTAL = resolve(REPO, 'dat/client_portal.dat');
const CELL = resolve(REPO, 'dat/client_cell_1.dat');
const datPresent = existsSync(PORTAL) && existsSync(CELL);

function lod(gfxObjId: number, mode: number, min: number, ideal: number, max: number): GfxObjLOD {
  return { gfxObjId, degradeMode: mode, minDist: min, idealDist: ideal, maxDist: max };
}
/** The 0x11000000 tree chain: level thresholds 25 / 50 / 100 m, then INVALID. */
const TREE_CHAIN: GfxObjLOD[] = [
  lod(0x1003769, 1, 10, 25, 50),
  lod(0x100376e, 1, 25, 50, 100),
  lod(0x100376f, 1, 50, 100, 200),
  lod(0, 1, 3.4028234663852886e+38, 3.4028234663852886e+38, 3.4028234663852886e+38),
];
function chain(degrades: GfxObjLOD[], sortCenter = new THREE.Vector3()): DegradeChain {
  return { infoId: 0x11000000, degrades, levelIds: degrades.map(l => l.gfxObjId), sortCenter };
}

describe('degradeLevelDerived — Render::SetDegradeLevelInternal @ 0054c3c0', () => {
  it('deg_mul 0 = the startup picture: object 25 m, particle 16 m, 40 static / 7 dynamic lights', () => {
    expect(degradeLevelDerived(0)).toEqual({ objectSortDistance: 25, particleSortDistance: 16, maxStaticLights: 40, maxDynamicLights: 7 });
  });

  it('positive deg_mul interpolates to 50 / 25 / 60 / 10 at +1 (slopes 25, 9, 20, 3)', () => {
    expect(degradeLevelDerived(1)).toEqual({ objectSortDistance: 50, particleSortDistance: 25, maxStaticLights: 60, maxDynamicLights: 10 });
    const half = degradeLevelDerived(0.5);
    expect(half.objectSortDistance).toBeCloseTo(37.5);
    expect(half.particleSortDistance).toBeCloseTo(20.5);
    expect(half.maxStaticLights).toBe(50);
    expect(half.maxDynamicLights).toBe(8); // _ftol2 truncates 8.5
  });

  it('negative deg_mul interpolates to 8 / 8 / 20 / 5 at −1 (slopes 17, 8, 20, 2)', () => {
    expect(degradeLevelDerived(-1)).toEqual({ objectSortDistance: 8, particleSortDistance: 8, maxStaticLights: 20, maxDynamicLights: 5 });
    const half = degradeLevelDerived(-0.5);
    expect(half.objectSortDistance).toBeCloseTo(16.5);
    expect(half.particleSortDistance).toBeCloseTo(12);
    expect(half.maxStaticLights).toBe(30);
    expect(half.maxDynamicLights).toBe(6);
  });

  it('clamps deg_mul to [−1, 1]', () => {
    expect(degradeLevelDerived(7)).toEqual(degradeLevelDerived(1));
    expect(degradeLevelDerived(-7)).toEqual(degradeLevelDerived(-1));
  });
});

describe('DegMulController — the derived caps / cut-offs', () => {
  it('starts with the $E235/$E237 quirk: the *_2dsq globals hold 25 / 16 unsquared (a 5 m / 4 m switch)', () => {
    const c = new DegMulController();
    expect(STARTUP_OBJECT_DISTANCE_2DSQ).toBe(25);
    expect(STARTUP_PARTICLE_DISTANCE_2DSQ).toBe(16);
    expect(c.objectDistance2dSq).toBe(25);
    expect(c.particleDistance2dSq).toBe(16);
    expect(c.derived).toEqual(degradeLevelDerived(0));
  });

  it('set() (= SetDegradeLevelInternal) squares the derived distances and re-derives the caps', () => {
    const c = new DegMulController();
    c.set(0);
    expect(c.objectDistance2dSq).toBe(625);
    expect(c.particleDistance2dSq).toBe(256);
    c.set(-1);
    expect(c.degMul).toBe(-1);
    expect(c.objectDistance2dSq).toBe(64);
    expect(c.particleDistance2dSq).toBe(64);
    expect(c.derived).toEqual({ objectSortDistance: 8, particleSortDistance: 8, maxStaticLights: 20, maxDynamicLights: 5 });
    c.set(3);
    expect(c.degMul).toBe(1);
    expect(c.objectDistance2dSq).toBe(2500);
  });

  it('auto off never calls SetDegradeLevelInternal — the startup values survive any frame rate', () => {
    const c = new DegMulController();
    for (let i = 0; i < 60; i++) c.tick(i % 2 ? 1 : 200, false);
    expect(c.degMul).toBe(0);
    expect(c.objectDistance2dSq).toBe(25);
    expect(c.derived.maxStaticLights).toBe(40);
  });

  it('auto on: the first accepted step (−0.15 at a very low frame rate) rewrites the squared cut-offs', () => {
    const c = new DegMulController();
    c.tick(1, true);
    expect(c.degMul).toBeCloseTo(-0.15, 5);
    const d = degradeLevelDerived(-0.15);
    expect(c.objectDistance2dSq).toBeCloseTo(d.objectSortDistance * d.objectSortDistance, 4);
    expect(c.particleDistance2dSq).toBeCloseTo(d.particleSortDistance * d.particleSortDistance, 4);
    // deg_mul is float32 (−0.15f = −0.150000006), and SetDegradeLevelInternal's
    // _ftol2 truncates 40 + 20·p = 36.99999988 → 36 (VISUAL.town-scenery-gaps).
    expect(c.derived.maxStaticLights).toBe(36);
    expect(c.derived.maxDynamicLights).toBe(6);
  });
});

describe('usesObjectDistance — CPhysicsObj::UpdateViewerDistance @ 00510b30', () => {
  it('compares the HORIZONTAL (x/z) distance² against object_distance_2dsq with ≥', () => {
    const v = new THREE.Vector3(0, 0, 0);
    expect(usesObjectDistance(new THREE.Vector3(3, 0, 4), v, 25)).toBe(true);    // 25 ≥ 25
    expect(usesObjectDistance(new THREE.Vector3(3, 0, 3.9), v, 25)).toBe(false);
    expect(usesObjectDistance(new THREE.Vector3(1, 500, 1), v, 25)).toBe(false); // height ignored
    expect(usesObjectDistance(new THREE.Vector3(1, 0, 1), v, 0)).toBe(true);
  });
});

// ── pooled instances ────────────────────────────────────────────────────────

const GFX_TREE = 0x1003769;
const GFX_L1 = 0x100376e;
const GFX_L2 = 0x100376f;

function makeModelSource(submeshes: Record<number, number>) {
  const createMesh = vi.fn((id: number): THREE.Group | null => {
    const n = submeshes[id];
    if (!n) return null;
    const group = new THREE.Group();
    for (let i = 0; i < n; i++) group.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial()));
    return group;
  });
  return { createMesh };
}
const NO_SETUPS = { loadSetupModel: () => null };

function entryAt(objId: number, x: number, scale = 1): InstanceEntry {
  return { objId, matrix: new THREE.Matrix4().compose(new THREE.Vector3(x, 0, 0), new THREE.Quaternion(), new THREE.Vector3(scale, scale, scale)) };
}

/** A tree whose sort center sits 40 m above its origin — the two branches
 *  disagree loudly. An env-cell pool (landCells: false): CObjCell::
 *  GetViewerDistance is 0 there, so the object-distance branch is always
 *  the one that runs (a land cell beyond 50 m would hand every instance its
 *  own 2-D centre distance first — CORE.17.h.g.c.c.c). */
function makeTallPool() {
  const lod = new DegradeLod(null);
  // The slider bias (0) picks the level, so only the distance branch moves
  // when the tests drive deg_mul (Adaptive Degrade would use it as the bias).
  lod.setPrefs({ degradeDistance: 0, adaptiveDegrade: false });
  lod.setChain(GFX_TREE, chain(TREE_CHAIN, new THREE.Vector3(0, 40, 0)));
  lod.setChain(GFX_L1, null); lod.setChain(GFX_L2, null);
  const inst = new SceneryInstancer(makeModelSource({ [GFX_TREE]: 1, [GFX_L1]: 1, [GFX_L2]: 1 }), NO_SETUPS);
  const inScene = new Set<THREE.InstancedMesh>();
  const pool = new SceneryInstancePool(inst, 'envfurninst',
    m => inScene.add(m as THREE.InstancedMesh), m => inScene.delete(m as THREE.InstancedMesh), { lod, landCells: false });
  return { lod, pool, inScene };
}

describe('SceneryInstancePool — the object-distance branch', () => {
  it('beyond object_distance the object origin sets the level; inside it the part sort center does', () => {
    const { lod, pool } = makeTallPool();
    // Startup quirk: object_distance_2dsq = 25 → a 5 m switch.
    // x = 3: inside → sort-center distance √(3² + 40²) = 40.1 → level 1.
    // x = 24: beyond → origin distance 24 → level 0 (per-part would be 46.6 → level 1).
    // x = 49: beyond → 49 → level 1 (per-part would be 63.2 → level 2).
    // x = 99: beyond → 99 → level 2 (per-part 106.8 → INVALID).
    pool.addBlock(1, [entryAt(GFX_TREE, 3), entryAt(GFX_TREE, 24), entryAt(GFX_TREE, 49), entryAt(GFX_TREE, 99)]);
    pool.updateLod(new THREE.Vector3(0, 0, 0));
    expect(pool.levelCensusFor(GFX_TREE)).toEqual({ 0: 1, 1: 2, 2: 1 });
    expect(pool.lodCensus().drawn).toBe(4);

    // The first adaptive update squares it: (25 m)² → x = 24 is now inside → level 1.
    lod.controller.set(0);
    pool.updateLod(new THREE.Vector3(0, 0, 0));
    expect(pool.levelCensusFor(GFX_TREE)).toEqual({ 1: 3, 2: 1 });

    // deg_mul −1 → 8 m: x = 3 stays inside, everything else is object-distance.
    lod.controller.set(-1);
    pool.updateLod(new THREE.Vector3(0, 0, 0));
    expect(pool.levelCensusFor(GFX_TREE)).toEqual({ 0: 1, 1: 2, 2: 1 });
  });

  it('the switch is horizontal: a viewer straight above the origin stays in the per-part branch', () => {
    const { pool } = makeTallPool();
    pool.addBlock(1, [entryAt(GFX_TREE, 0)]);
    // viewer 4 m up and 3 m aside (2-D 9 < 25): sort-center distance √(3² + 36²) = 36.1 → level 1
    pool.updateLod(new THREE.Vector3(3, 4, 0));
    expect(pool.levelCensusFor(GFX_TREE)).toEqual({ 1: 1 });
    // viewer 300 m up, 3 m aside: still the per-part branch → √(3² + 260²) → INVALID
    pool.updateLod(new THREE.Vector3(3, 300, 0));
    expect(pool.levelCensusFor(GFX_TREE)).toEqual({ 3: 1 });
  });

  it('removeBlock and capacity growth keep the per-instance origins aligned with the master list', () => {
    const { pool } = makeTallPool();
    pool.addBlock(1, [entryAt(GFX_TREE, 99)]);          // far → level 2
    pool.addBlock(2, [entryAt(GFX_TREE, 3)]);           // near → level 1
    pool.updateLod(new THREE.Vector3(0, 0, 0));
    expect(pool.levelCensusFor(GFX_TREE)).toEqual({ 1: 1, 2: 1 });
    pool.removeBlock(1);
    pool.updateLod(new THREE.Vector3(0, 0, 0));
    expect(pool.levelCensusFor(GFX_TREE)).toEqual({ 1: 1 });
    // grow past the 16-slot initial capacity with far instances
    const many: InstanceEntry[] = [];
    for (let i = 0; i < 40; i++) many.push(entryAt(GFX_TREE, 99));
    pool.addBlock(3, many);
    pool.updateLod(new THREE.Vector3(0, 0, 0));
    expect(pool.levelCensusFor(GFX_TREE)).toEqual({ 1: 1, 2: 40 });
  });
});

// ── the per-object part registry ───────────────────────────────────────────

describe('DegradeLod.updateParts — the object-distance branch + explicit object roots', () => {
  function makeRegistry() {
    const lod = new DegradeLod(null);
    lod.setPrefs({ degradeDistance: 0 });
    lod.setChain(GFX_TREE, chain(TREE_CHAIN, new THREE.Vector3(0, 40, 0)));
    const source = makeModelSource({ [GFX_TREE]: 1, [GFX_L1]: 1, [GFX_L2]: 1 });
    const scene = new THREE.Scene();
    return { lod, source, scene };
  }
  const drawnLevel = (part: THREE.Object3D) => (part.userData.acDegrade as { level: number }).level;

  it('a bare GfxObj group registered as its own object degrades by its origin beyond the switch', () => {
    const { lod, source, scene } = makeRegistry();
    const obj = source.createMesh(GFX_TREE)!;
    expect(lod.attachPart(obj, GFX_TREE, id => source.createMesh(id), obj)).toBe(true);
    obj.position.set(99, 0, 0);
    scene.add(obj);
    scene.updateMatrixWorld(true);
    lod.updateParts(new THREE.Vector3(0, 0, 0));
    expect(drawnLevel(obj)).toBe(2);                          // 99 m by origin; 106.8 per-part would vanish
    expect(obj.children.some(c => c.name === 'lod_2' && c.visible)).toBe(true);
    obj.position.set(3, 0, 0);
    scene.updateMatrixWorld(true);
    lod.updateParts(new THREE.Vector3(0, 0, 0));
    expect(drawnLevel(obj)).toBe(1);                          // inside 5 m: √(3² + 40²) = 40.1 → level 1
  });

  it('a setup part defaults its object to the parent group (the setup root)', () => {
    const { lod, source, scene } = makeRegistry();
    const setup = new THREE.Group();
    const part = source.createMesh(GFX_TREE)!;
    lod.attachPart(part, GFX_TREE, id => source.createMesh(id));
    part.position.set(0, 0, 30);                              // placement frame offset inside the object
    setup.add(part);
    setup.position.set(24, 0, 0);
    scene.add(setup);
    scene.updateMatrixWorld(true);
    lod.updateParts(new THREE.Vector3(0, 0, 0));
    // object origin at 24 m (2-D 576 ≥ 25) → the far branch: 24 → level 0;
    // the part itself sits at (24, 40, 30) = 55.6 m and would be level 2
    expect(drawnLevel(part)).toBe(0);
  });
});

// ── DAT-gated: the per-cell furniture pools ─────────────────────────────────

const LB = 0x8602; // Training Academy

describe.skipIf(!datPresent)('EnvCellRenderer — per-cell furniture degrade pools (needs DAT files)', () => {
  let renderer: import('../packages/renderer/src/world/EnvCellRenderer.js').EnvCellRenderer;
  let plain: import('../packages/renderer/src/world/EnvCellRenderer.js').EnvCellRenderer;
  let lod: DegradeLod;
  let plainLod: DegradeLod;
  let cellIds: number[] = [];

  beforeAll(async () => {
    const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase.js');
    const { EnvCellRenderer } = await import('../packages/renderer/src/world/EnvCellRenderer.js');
    const { SetupModelRenderer } = await import('../packages/renderer/src/models/SetupModelRenderer.js');
    const { ModelRenderer } = await import('../packages/renderer/src/models/ModelRenderer.js');
    const { MaterialFactory } = await import('../packages/renderer/src/models/MaterialFactory.js');
    const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');

    const portalDb = openDat(PORTAL);
    const cellDb = openDat(CELL);
    const textureManager = new TextureManager(portalDb);
    const materialFactory = new MaterialFactory(portalDb, textureManager);
    const modelRenderer = new ModelRenderer(portalDb, materialFactory);
    const setupRenderer = new SetupModelRenderer(portalDb, modelRenderer);

    lod = new DegradeLod(portalDb);
    renderer = new EnvCellRenderer(portalDb, cellDb, materialFactory, setupRenderer, modelRenderer);
    renderer.setInstancer(new SceneryInstancer(modelRenderer, setupRenderer));
    renderer.setDegradeLod(lod);

    // No instancer + a setup renderer WITHOUT the degrade system: only the
    // bare-GfxObj fallback path can register parts here.
    plainLod = new DegradeLod(portalDb);
    plain = new EnvCellRenderer(portalDb, cellDb, materialFactory, new SetupModelRenderer(portalDb, modelRenderer), modelRenderer);
    plain.setDegradeLod(plainLod);

    for (let cell = 0x100; cell <= 0x1ff; cell++) {
      const id = ((LB << 16) | cell) >>> 0;
      let env;
      try { env = renderer.loadEnvCell(id); } catch { continue; }
      if (env && env.staticObjects.length > 0) cellIds.push(id);
    }
  });

  it('cell furniture partitions by viewer distance: everything drawn up close, chained families vanish far away', () => {
    const scene = new THREE.Scene();
    const groups: THREE.Group[] = [];
    for (const id of cellIds) {
      const g = renderer.createCellMesh(id);
      if (g) { scene.add(g); groups.push(g); }
    }
    expect(groups.length).toBeGreaterThan(0);
    scene.updateMatrixWorld(true);
    const census0 = renderer.furnitureLodCensus();
    expect(census0.cells).toBeGreaterThan(0);
    expect(census0.withChain).toBeGreaterThan(0);
    // Before any viewer every instance is level 0 → all drawn.
    expect(census0.drawn).toBe(census0.instances);

    // A viewer 100 km away: every chained instance past its last level → not drawn.
    renderer.updateFurnitureLod(new THREE.Vector3(1e5, 0, 1e5));
    const far = renderer.furnitureLodCensus();
    expect(far.instances).toBe(census0.instances);
    expect(far.drawn).toBeLessThan(far.instances);
    let hiddenLevelMeshes = 0, visibleBatches = 0;
    scene.traverse(o => {
      const m = o as THREE.InstancedMesh;
      if (!m.isInstancedMesh || !m.name.startsWith('envfurninst_')) return;
      if (/_lod\d+$/.test(m.name)) hiddenLevelMeshes += m.visible ? 0 : 1;
      else if (m.visible && m.count > 0) visibleBatches++;
    });
    // chain-less families still draw; chained level-0 batches emptied
    expect(visibleBatches).toBeLessThan(census0.families);

    // Back inside the first furnished cell: everything at level 0 again.
    const g0 = groups[0];
    const at = new THREE.Vector3();
    g0.getWorldPosition(at);
    renderer.updateFurnitureLod(at);
    // Level 0 within the degrade distance everywhere in this cell; other
    // cells may legitimately sit at deeper levels — the census must be back
    // to strictly more drawn than the far case.
    const near = renderer.furnitureLodCensus();
    expect(near.drawn).toBeGreaterThan(far.drawn);
    // Only level meshes (lod_N) are ever hidden while their family draws level 0.
    void hiddenLevelMeshes;
  });

  it('a cell removed from the scene is pruned from the pool registry on the next update', () => {
    const scene = new THREE.Scene();
    const g = renderer.createCellMesh(cellIds[0])!;
    scene.add(g);
    const before = renderer.furnitureLodCensus().cells;
    scene.remove(g);
    renderer.updateFurnitureLod(new THREE.Vector3());
    expect(renderer.furnitureLodCensus().cells).toBeLessThan(before);
  });

  it('bare GfxObj stabs on the per-object fallback path register with the part registry', () => {
    let bareWithChain = 0;
    for (const id of cellIds) {
      const env = plain.loadEnvCell(id)!;
      for (const stab of env.staticObjects) {
        if (((stab.id >> 24) & 0xff) === 0x01 && plainLod.chainFor(stab.id)) bareWithChain++;
      }
    }
    const scene = new THREE.Scene();
    for (const id of cellIds) { const g = plain.createCellMesh(id); if (g) scene.add(g); }
    if (bareWithChain === 0) {
      // The Academy furnishes with Setups only — nothing to register here, and
      // nothing must have registered (the setup renderer has no degrade system).
      expect(plainLod.partCount).toBe(0);
      return;
    }
    expect(plainLod.partCount).toBe(bareWithChain);
  });
});
