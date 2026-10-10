/**
 * BUG.tree-trunks-pop — "tree trunks clip in/out more than branches, so the
 * canopies appear to float" (outdoors near Holtburg).
 *
 * Root cause: SceneryInstancePool.commit() wrote each degrade level's rows
 * from row 0 of that level's target InstancedMeshes. When two levels of one
 * chain name the SAME GfxObj they resolve to the same meshes, so the later
 * level overwrote the earlier level's rows and count. EoL trees hit this on
 * some parts but not others — e.g. Setup 0x02000258 (the most common
 * Holtburg-area scenery tree): part 0x0100379F (chain 0x1100001C =
 * [0x100379F, 0x100379F, 0x10037A7, INVALID]) vs 0x010037A1 (chain
 * 0x1100001E, three distinct GfxObjs). Every instance still at level 0
 * vanished as soon as any instance anywhere sat at level 1, while the parts
 * with distinct level GfxObjs kept drawing.
 *
 * Retail: CPhysicsPart::LoadGfxObjArray @ 0050dcf0 fills gfxobj[i] =
 * DBObj::Get(degrades[i].gfxobj_id) for every level and CPhysicsPart::Draw
 * @ 0050d7a0 draws gfxobj[deg_level], so an instance at level 0 and one at
 * level 1 both draw that GfxObj.
 *
 * Synthetic mechanism test (always runs) + the real-DAT Holtburg stream
 * (describe.skipIf; DAT loads in beforeAll).
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

const TRUNK = 0x100379f;
const TRUNK_L2 = 0x10037a7;
const CANOPY = 0x10037a1;
const CANOPY_L1 = 0x10037a9;
const CANOPY_L2 = 0x1003af0;
const SHARED = 0x1000d1d; // 0x020002F5's part: chain 0x11000010 names 0x1003AF1 at all 3 levels
const SHARED_LVL = 0x1003af1;
const lodEntry = (gfxObjId: number, min: number, ideal: number, max: number): GfxObjLOD =>
  ({ gfxObjId, degradeMode: 1, minDist: min, idealDist: ideal, maxDist: max });
const INV = lodEntry(INVALID_DID, 3.4e38, 3.4e38, 3.4e38);
const chainOf = (infoId: number, d: GfxObjLOD[]): DegradeChain =>
  ({ infoId, degrades: d, levelIds: d.map(l => l.gfxObjId), sortCenter: new THREE.Vector3() });
/** EoL 0x1100001C (the 0x02000258 trunk part): level 0 and 1 are the same GfxObj. */
const TRUNK_CHAIN = chainOf(0x1100001c, [lodEntry(TRUNK, 10, 25, 50), lodEntry(TRUNK, 25, 50, 100), lodEntry(TRUNK_L2, 50, 100, 200), INV]);
/** EoL 0x1100001E: three distinct GfxObjs. */
const CANOPY_CHAIN = chainOf(0x1100001e, [lodEntry(CANOPY, 10, 25, 50), lodEntry(CANOPY_L1, 25, 50, 100), lodEntry(CANOPY_L2, 50, 100, 200), INV]);
/** EoL 0x11000010: a chain naming one non-base GfxObj at every level. */
const SHARED_CHAIN = chainOf(0x11000010, [lodEntry(SHARED_LVL, 10, 25, 50), lodEntry(SHARED_LVL, 25, 50, 100), lodEntry(SHARED_LVL, 50, 100, 200), INV]);

function makePool() {
  const known = [TRUNK, TRUNK_L2, CANOPY, CANOPY_L1, CANOPY_L2, SHARED, SHARED_LVL];
  const createMesh = vi.fn((id: number): THREE.Group | null => {
    if (!known.includes(id)) return null;
    const g = new THREE.Group();
    // two submeshes (surfaces) so every level target is a mesh SET
    g.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial()));
    g.add(new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1), new THREE.MeshLambertMaterial()));
    return g;
  });
  const lod = new DegradeLod(null);
  lod.setChain(TRUNK, TRUNK_CHAIN);
  lod.setChain(CANOPY, CANOPY_CHAIN);
  lod.setChain(SHARED, SHARED_CHAIN);
  for (const id of [TRUNK_L2, CANOPY_L1, CANOPY_L2, SHARED_LVL]) lod.setChain(id, null);
  const inst = new SceneryInstancer({ createMesh }, { loadSetupModel: () => null });
  const scene = new Set<THREE.InstancedMesh>();
  const pool = new SceneryInstancePool(inst, 'sceneryinst', m => scene.add(m as THREE.InstancedMesh), m => scene.delete(m as THREE.InstancedMesh), { lod });
  return { pool, scene };
}

const at = (objId: number, x: number, z: number): InstanceEntry =>
  ({ objId, matrix: new THREE.Matrix4().makeTranslation(x, 0, z) });

/** World x of every drawn instance per mesh; every submesh of a set must agree. */
function drawnX(scene: Set<THREE.InstancedMesh>): Record<string, number[][]> {
  const out: Record<string, number[][]> = {};
  const m = new THREE.Matrix4();
  for (const mesh of scene) {
    if (!mesh.visible || mesh.count === 0) continue;
    const xs: number[] = [];
    for (let i = 0; i < mesh.count; i++) { mesh.getMatrixAt(i, m); xs.push(new THREE.Vector3().setFromMatrixPosition(m).x); }
    (out[mesh.name] ??= []).push(xs.sort((a, b) => a - b));
  }
  return out;
}

describe('SceneryInstancePool — levels naming the same GfxObj draw every instance', () => {
  // viewer at the origin. x = 3 → cell (12,12), per-object path → level 0.
  // x = 84 → cell centre (84, 12): 2-D 84.85 > 50 → UpdateObjCell; 84.85 − 50
  // = 34.85 → level 1 (25 ≤ d < 50). x = 180 → 180.4 − 50 = 130 → INVALID.
  const viewer = new THREE.Vector3(0, 0, 0);

  it('a level-0 trunk and a level-1 trunk both draw (the chain names 0x100379F at levels 0 and 1)', () => {
    const { pool, scene } = makePool();
    pool.addBlock(1, [at(TRUNK, 3, 0), at(TRUNK, 84, 0), at(TRUNK, 180, 0)]);
    pool.updateLod(viewer);
    expect(pool.levelCensusFor(TRUNK)).toEqual({ 0: 1, 1: 1, 3: 1 });
    // Before the fix: [[84], [84]] — the level-1 pass rewrote row 0 and set
    // count 1, so the trunk at the viewer's feet was not drawn.
    expect(drawnX(scene)).toEqual({ sceneryinst_0100379f: [[3, 84], [3, 84]] });
  });

  it('the canopy of the same trees (distinct level GfxObjs) draws both too — trunk and canopy agree', () => {
    const { pool, scene } = makePool();
    pool.addBlock(1, [at(TRUNK, 3, 0), at(CANOPY, 3, 0), at(TRUNK, 84, 0), at(CANOPY, 84, 0)]);
    pool.updateLod(viewer);
    const d = drawnX(scene);
    expect(d.sceneryinst_0100379f).toEqual([[3, 84], [3, 84]]);
    expect(d.sceneryinst_010037a1).toEqual([[3], [3]]);
    expect(d.sceneryinst_010037a1_lod1).toEqual([[84], [84]]);
  });

  it('stays correct as the viewer walks: every non-INVALID instance is drawn exactly once', () => {
    const { pool, scene } = makePool();
    const xs = [3, 30, 60, 84, 110, 140, 180];
    pool.addBlock(1, xs.map(x => at(TRUNK, x, 0)));
    for (const vx of [0, 40, 80, 120, -60]) {
      const v = new THREE.Vector3(vx, 0, 0);
      pool.updateLod(v);
      const census = pool.levelCensusFor(TRUNK)!;
      const expected = (census[0] ?? 0) + (census[1] ?? 0);
      const drawn = drawnX(scene);
      for (const set of drawn.sceneryinst_0100379f ?? [[]]) expect(set.length).toBe(expected);
      const l2 = drawn.sceneryinst_0100379f_lod2?.[0]?.length ?? 0;
      expect(l2).toBe(census[2] ?? 0);
    }
  });

  it('a chain naming one non-base GfxObj at several levels draws through ONE mesh set holding every instance', () => {
    const { pool, scene } = makePool();
    pool.addBlock(1, [at(SHARED, 3, 0), at(SHARED, 84, 0), at(SHARED, 140, 0), at(SHARED, 180, 0)]);
    pool.updateLod(viewer);
    expect(pool.levelCensusFor(SHARED)).toEqual({ 0: 1, 1: 1, 2: 1, 3: 1 });
    const d = drawnX(scene);
    const lodSets = Object.entries(d).filter(([name]) => name.startsWith('sceneryinst_01000d1d'));
    expect(lodSets).toHaveLength(1); // the base GfxObj itself is never drawn (not in its chain)
    expect(lodSets[0][1]).toEqual([[3, 84, 140], [3, 84, 140]]);
    // 2 submeshes → 2 drawn meshes, not 2 per level
    expect(pool.drawableMeshCount).toBe(2);
  });
});

describe.skipIf(!existsSync(CELL) || !existsSync(PORTAL))('Holtburg (0xA9B4 ± 1) — every pooled row the degrade census says is drawn is drawn', () => {
  let pool: SceneryInstancePool;
  let lod: DegradeLod;
  let scene: Set<THREE.InstancedMesh>;
  let families: number[] = [];

  beforeAll(async () => {
    const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    const { RegionDesc, CellLandblock, LandblockInfo, Scene } = await import('@ac/dat-parser');
    const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
    const { MaterialFactory } = await import('../packages/renderer/src/models/MaterialFactory.js');
    const { ModelRenderer } = await import('../packages/renderer/src/models/ModelRenderer.js');
    const { SetupModelRenderer } = await import('../packages/renderer/src/models/SetupModelRenderer.js');
    const { makeTerrainSampler, generateScenery, buildingCellMask } = await import('../packages/renderer/src/terrain/SceneryGenerator.js');
    const portalDb = openDat(PORTAL);
    const cellDb = openDat(CELL);
    const region = new RegionDesc(new DatReader(portalDb.getFileData(0x13000000)!));
    const mr = new ModelRenderer(portalDb, new MaterialFactory(portalDb, new TextureManager(portalDb)));
    const sr = new SetupModelRenderer(portalDb, mr);
    const inst = new SceneryInstancer(mr, sr);
    lod = new DegradeLod(portalDb);
    scene = new Set();
    pool = new SceneryInstancePool(inst, 'sceneryinst', m => scene.add(m as THREE.InstancedMesh), m => scene.delete(m as THREE.InstancedMesh), { lod });
    for (let x = 0xa8; x <= 0xaa; x++) for (let y = 0xb3; y <= 0xb5; y++) {
      const id = ((x << 24) | (y << 16) | 0xffff) >>> 0;
      const lb = CellLandblock.read(new DatReader(cellDb.getFileData(id)!));
      const exclude = new Set<number>();
      const infoData = lb.hasObjects ? cellDb.getFileData(((id & 0xffff0000) | 0xfffe) >>> 0) : null;
      if (infoData) for (const c of buildingCellMask(new LandblockInfo(new DatReader(infoData)).buildings)) exclude.add(c);
      const placements = generateScenery(id, lb, region, sid => {
        const d = portalDb.getFileData(sid);
        return d ? Scene.read(new DatReader(d)) : null;
      }, makeTerrainSampler(id, lb, region), { excludeCells: exclude });
      pool.addBlock(id, placements.map(p => ({ objId: p.objId, matrix: SceneryInstancer.placementMatrix(p, x * 192, y * 192) })));
    }
    const fams = (pool as unknown as { families: Map<number, { count: number; lod: { origins: Float32Array } | null }> }).families;
    families = [...fams.keys()];
    // Stand (eye height) at the 0x02000258 tree nearest the Holtburg
    // landblock's centre: trunks near it are at level 0, those 75–100 m
    // out at level 1, as in the report.
    const t = fams.get(TRUNK)!;
    let best = -1, bestD = Infinity;
    for (let i = 0; i < t.count; i++) {
      const o = t.lod!.origins;
      const d = Math.hypot(o[i * 3] - (0xa9 * 192 + 96), o[i * 3 + 2] - (0xb4 * 192 + 96));
      if (d < bestD) { bestD = d; best = i; }
    }
    const o = t.lod!.origins;
    pool.updateLod(new THREE.Vector3(o[best * 3] + 2, o[best * 3 + 1] + 1.7, o[best * 3 + 2] + 2));
  }, 120_000);

  it('the region holds the 0x02000258 tree parts, with trunks at both level 0 and level 1', () => {
    expect(families).toContain(TRUNK);
    expect(families).toContain(CANOPY);
    const c = pool.levelCensusFor(TRUNK)!;
    expect(c[0]).toBeGreaterThan(0);
    expect(c[1]).toBeGreaterThan(0);
    // the two parts of one tree sit at the same level (same cell distance)
    expect(pool.levelCensusFor(CANOPY)).toEqual(c);
  });

  it('for every family, each drawn mesh of a GfxObj holds exactly the instances whose level names that GfxObj', () => {
    let checked = 0;
    for (const g of families) {
      const chain = lod.chainFor(g);
      const census = pool.levelCensusFor(g);
      if (!chain || !census) continue;
      // rows per drawn GfxObj id
      const want = new Map<number, number>();
      for (const [lvl, n] of Object.entries(census)) {
        const id = chain.levelIds[+lvl];
        if (id !== INVALID_DID) want.set(id, (want.get(id) ?? 0) + n);
      }
      const prefix = `sceneryinst_${g.toString(16).padStart(8, '0')}`;
      const got = new Map<string, number[]>();
      for (const mesh of scene) {
        if (mesh.name !== prefix && !mesh.name.startsWith(prefix + '_lod')) continue;
        const arr = got.get(mesh.name) ?? [];
        arr.push(mesh.visible ? mesh.count : 0);
        got.set(mesh.name, arr);
      }
      // base-named meshes draw g itself
      const baseCounts = got.get(prefix) ?? [];
      for (const n of baseCounts) expect({ g: g.toString(16), n }).toEqual({ g: g.toString(16), n: want.get(g) ?? 0 });
      // the drawn total across all of this family's mesh sets == instances at a real level
      const totalWanted = [...want.values()].reduce((a, b) => a + b, 0);
      let totalDrawn = 0;
      for (const [, counts] of got) totalDrawn += counts[0] ?? 0; // one submesh per set (all agree)
      expect({ g: g.toString(16), totalDrawn }).toEqual({ g: g.toString(16), totalDrawn: totalWanted });
      checked++;
    }
    expect(checked).toBeGreaterThan(10);
  });
});
