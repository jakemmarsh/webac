/**
 * BUG.scenery-setup-instances-invisible-near-player — SceneryInstancePool.
 * removeBlock swap-removes a retiring block's rows and must move EVERY
 * per-instance LodState array with the row it overwrites. It moved centers /
 * origins / invScale / levels but not `cells` (the land-cell centre the
 * RenderDeviceD3D::UpdateObjCell @ 005a0690 branch of selectLevel measures
 * beyond MAX_CELL_2D_DEGRADE_DISTANCE). A moved instance inherited the
 * removed row's cell, often hundreds of metres off, and picked a far level.
 * For a chain ending in INVALID_DID that meant CPhysicsPart::Draw with a NULL
 * gfxobj, i.e. nothing drawn. Live symptom: the Holtburg south-slope tree
 * (Setup 0x020002D3, placement #53 of 0xA9B3) had collision but no drawn
 * instance with the player standing against it.
 *
 * Synthetic mechanism test (always runs) + the real-DAT Holtburg stream
 * (describe.skipIf, loads in beforeAll).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { DegradeLod, INVALID_DID, type DegradeChain } from '../packages/renderer/src/models/DegradeLod.js';
import { SceneryInstancer, type InstanceEntry } from '../packages/renderer/src/terrain/SceneryInstancer.js';
import { SceneryInstancePool } from '../packages/renderer/src/terrain/SceneryInstancePool.js';
import type { GfxObjLOD } from '@ac/dat-parser';
import { openDat } from './_harness/dat.js';

const REPO = resolve(__dirname, '..');
const CELL = resolve(REPO, 'dat/client_cell_1.dat');
const PORTAL = resolve(REPO, 'dat/client_portal.dat');

const GFX_TREE = 0x1003769;
const GFX_L1 = 0x100376e;
const GFX_L2 = 0x100376f;
const lodEntry = (gfxObjId: number, min: number, ideal: number, max: number): GfxObjLOD =>
  ({ gfxObjId, degradeMode: 1, minDist: min, idealDist: ideal, maxDist: max });
/** The EoL 0x11000000 tree chain: 42 → 26 → 9 polys → nothing. */
const TREE_CHAIN: GfxObjLOD[] = [
  lodEntry(GFX_TREE, 10, 25, 50), lodEntry(GFX_L1, 25, 50, 100), lodEntry(GFX_L2, 50, 100, 200),
  lodEntry(INVALID_DID, 3.4e38, 3.4e38, 3.4e38),
];

function makePool() {
  const createMesh = vi.fn((id: number): THREE.Group | null => {
    if (![GFX_TREE, GFX_L1, GFX_L2].includes(id)) return null;
    const g = new THREE.Group();
    g.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial()));
    return g;
  });
  const lod = new DegradeLod(null);
  const chain: DegradeChain = { infoId: 0x11000000, degrades: TREE_CHAIN, levelIds: TREE_CHAIN.map(l => l.gfxObjId), sortCenter: new THREE.Vector3() };
  lod.setChain(GFX_TREE, chain); lod.setChain(GFX_L1, null); lod.setChain(GFX_L2, null);
  const inst = new SceneryInstancer({ createMesh }, { loadSetupModel: () => null });
  const scene = new Set<THREE.InstancedMesh>();
  const pool = new SceneryInstancePool(inst, 'sceneryinst', m => scene.add(m as THREE.InstancedMesh), m => scene.delete(m as THREE.InstancedMesh), { lod });
  return { pool, scene };
}

const at = (x: number, z: number): InstanceEntry =>
  ({ objId: GFX_TREE, matrix: new THREE.Matrix4().makeTranslation(x, 0, z) });

/** World x of every drawn instance, per mesh name. */
function drawnPositions(scene: Set<THREE.InstancedMesh>): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  const m = new THREE.Matrix4();
  for (const mesh of scene) {
    if (!mesh.visible) continue;
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m);
      (out[mesh.name] ??= []).push(new THREE.Vector3().setFromMatrixPosition(m).x);
    }
  }
  for (const k of Object.keys(out)) out[k].sort((a, b) => a - b);
  return out;
}

describe('SceneryInstancePool.removeBlock — the land-cell distance input moves with its row', () => {
  it('a tree at the viewer stays at level 0 after an earlier block (whose rows it fills) unloads', () => {
    const { pool, scene } = makePool();
    const viewer = new THREE.Vector3(5, 0, 5);
    // Block 1 is 400 m away (its cells' 2-D distance > 50 → UpdateObjCell →
    // INVALID); block 2's tree is 2 m from the viewer.
    pool.addBlock(1, [at(400, 0), at(424, 0)]);
    pool.addBlock(2, [at(3, 5), at(410, 0)]);
    pool.updateLod(viewer);
    expect(drawnPositions(scene)).toEqual({ sceneryinst_01003769: [3] });
    // Swap-remove moves block 2's rows into slots 0 and 1. Before the fix,
    // the tree at 3 m inherited block 1's cell centre (396–420 m away) and
    // drew nothing.
    pool.removeBlock(1);
    pool.updateLod(viewer);
    expect(pool.levelCensusFor(GFX_TREE)).toEqual({ 0: 1, 3: 1 });
    expect(drawnPositions(scene)).toEqual({ sceneryinst_01003769: [3] });
  });

  it('the far-row case too: an instance moved next to a removed near row keeps its own far cell', () => {
    const { pool, scene } = makePool();
    const viewer = new THREE.Vector3(0, 0, 0);
    pool.addBlock(1, [at(2, 0)]);
    // 130 m: cell centre (132, 12) → 132.5 − 50 = 82.5 → level 2
    pool.addBlock(2, [at(130, 0)]);
    pool.updateLod(viewer);
    pool.removeBlock(1);
    pool.updateLod(viewer);
    // The stale near cell (12, 12) would have sent it through the per-object
    // path: 130 − 50 = 80 → still level 2, so also check the census against a
    // fresh pool built from the survivors only.
    const fresh = makePool();
    fresh.pool.addBlock(2, [at(130, 0)]);
    fresh.pool.updateLod(viewer);
    expect(pool.levelCensusFor(GFX_TREE)).toEqual(fresh.pool.levelCensusFor(GFX_TREE));
    expect(drawnPositions(scene)).toEqual(drawnPositions(fresh.scene));
  });
});

describe.skipIf(!existsSync(CELL) || !existsSync(PORTAL))('Holtburg south slope (0xA9B3) — streamed pool vs a fresh one', () => {
  const MAIN = 0xa9b3ffff;
  const CANOPY = 0x1003ab5, TRUNK = 0x1003ab6; // Setup 0x020002D3's two parts (0x1003AB6: r 1.5 m, bark 0x0800157E)
  let churned: SceneryInstancePool;
  let fresh: SceneryInstancePool;
  let tree53 = new THREE.Vector3();
  let families: number[] = [];
  let viewer = new THREE.Vector3();

  beforeAll(async () => {
    const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    const { RegionDesc, CellLandblock, LandblockInfo, Scene } = await import('@ac/dat-parser');
    const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
    const { MaterialFactory } = await import('../packages/renderer/src/models/MaterialFactory.js');
    const { ModelRenderer } = await import('../packages/renderer/src/models/ModelRenderer.js');
    const { SetupModelRenderer } = await import('../packages/renderer/src/models/SetupModelRenderer.js');
    const { makeTerrainSampler, generateScenery, buildingCellMask } = await import('../packages/renderer/src/terrain/SceneryGenerator.js');
    const { resolveObjectPhysics, objWithinBlock } = await import('../packages/renderer/src/world/ObjectCollision.js');
    const portalDb = openDat(PORTAL);
    const cellDb = openDat(CELL);
    const region = new RegionDesc(new DatReader(portalDb.getFileData(0x13000000)!));
    const mr = new ModelRenderer(portalDb, new MaterialFactory(portalDb, new TextureManager(portalDb)));
    const sr = new SetupModelRenderer(portalDb, mr);
    const src = { loadSetupModel: (id: number) => sr.loadSetupModel(id), loadGfxObj: (id: number) => mr.loadGfxObj(id) };
    const inst = new SceneryInstancer(mr, sr);
    const lod = new DegradeLod(portalDb);
    const makePoolReal = () => new SceneryInstancePool(inst, 'sceneryinst', () => {}, () => {}, { lod });
    // main.ts's terrain attacher: generateScenery → addBlock(placementMatrix)
    const blocks = new Map<number, InstanceEntry[]>();
    const entriesFor = (x: number, y: number) => {
      const id = ((x << 24) | (y << 16) | 0xffff) >>> 0;
      const lb = CellLandblock.read(new DatReader(cellDb.getFileData(id)!));
      const exclude = new Set<number>();
      const infoData = lb.hasObjects ? cellDb.getFileData(((id & 0xffff0000) | 0xfffe) >>> 0) : null;
      if (infoData) for (const c of buildingCellMask(new LandblockInfo(new DatReader(infoData)).buildings)) exclude.add(c);
      const placements = generateScenery(id, lb, region, sid => {
        const d = portalDb.getFileData(sid);
        return d ? Scene.read(new DatReader(d)) : null;
      }, makeTerrainSampler(id, lb, region), {
        excludeCells: exclude,
        withinBlock: (objId, o, q) => { const m = resolveObjectPhysics(objId, src); return !m || objWithinBlock(m, o, q); },
      });
      if (id === MAIN) {
        // collision key #53 = the 53rd placement with a model (main.ts placementIdx)
        const p = placements.filter(pl => inst.hasModel(pl.objId))[52];
        tree53 = new THREE.Vector3(x * 192 + p.x, p.z, y * 192 + p.y);
      }
      return { id, entries: placements.map(p => ({ objId: p.objId, matrix: SceneryInstancer.placementMatrix(p, x * 192, y * 192) })) };
    };
    // Stream a 5×5 region with 0xA9B3 loaded LAST, then unload the outer
    // ring: its rows are refilled from the tail, i.e. from 0xA9B3.
    const order: [number, number][] = [];
    for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) if (dx || dy) order.push([0xa9 + dx, 0xb3 + dy]);
    order.push([0xa9, 0xb3]);
    for (const [x, y] of order) { const e = entriesFor(x, y); blocks.set(e.id, e.entries); }
    viewer = new THREE.Vector3(32513, tree53.y + 1.7, 34448);
    churned = makePoolReal();
    for (const [x, y] of order) { const id = ((x << 24) | (y << 16) | 0xffff) >>> 0; churned.addBlock(id, blocks.get(id)!); }
    churned.updateLod(viewer);
    fresh = makePoolReal();
    for (const [x, y] of order) {
      const id = ((x << 24) | (y << 16) | 0xffff) >>> 0;
      if (Math.abs(x - 0xa9) === 2 || Math.abs(y - 0xb3) === 2) churned.removeBlock(id);
      else fresh.addBlock(id, blocks.get(id)!);
    }
    churned.updateLod(viewer);
    fresh.updateLod(viewer);
    families = [...(churned as unknown as { families: Map<number, unknown> }).families.keys()];
  }, 120_000);

  it('placement #53 is the 0x020002D3 tree at the reported spot', () => {
    expect(tree53.x).toBeCloseTo(32512.2, 1);
    expect(tree53.z).toBeCloseTo(34446.8, 1);
    expect(families).toContain(TRUNK);
    expect(families).toContain(CANOPY);
  });

  it('with the viewer at the tree, both of its parts draw full detail (level 0) after the ring unloads', () => {
    for (const g of [TRUNK, CANOPY]) {
      const fam = (churned as unknown as { families: Map<number, { count: number; lod: { origins: Float32Array; levels: Uint8Array } }> }).families.get(g)!;
      const levels: number[] = [];
      for (let i = 0; i < fam.count; i++) {
        const o = fam.lod.origins;
        if (Math.hypot(o[i * 3] - tree53.x, o[i * 3 + 2] - tree53.z) < 0.01) levels.push(fam.lod.levels[i]);
      }
      expect(levels).toEqual([0]);
    }
  });

  it('every family\'s per-level census matches a pool that never held the unloaded blocks', () => {
    // (families emptied by the unload stay in the churned pool with no instances)
    const { instances, drawn, byLevel } = churned.lodCensus();
    const f = fresh.lodCensus();
    expect({ instances, drawn, byLevel }).toEqual({ instances: f.instances, drawn: f.drawn, byLevel: f.byLevel });
    for (const g of families) expect(churned.levelCensusFor(g) ?? {}).toEqual(fresh.levelCensusFor(g) ?? {});
  });
});
