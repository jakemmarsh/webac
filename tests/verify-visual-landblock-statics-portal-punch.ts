/**
 * VISUAL.landblock-statics-missing-vs-retail — Xarabydun's dungeon pit.
 *
 * (1) The portal punch (world/PortalPunch.ts): retail draws a building's
 *     drawing-BSP portal polygons with D3DPolyRender::DrawPortalPolyInternal
 *     @ 0059bc90 — DEPTHTEST_ALWAYS, depth write, z = 0.99999899, alpha 0 —
 *     so the building's cells show through the terrain that caps them. The
 *     punch is shown exactly while its gate (ConstructView) is open.
 * (2) The outdoor ground (world/outdoorGround.ts): a teleport arriving on a
 *     building's walkable surface (the pit rim 0x01002bef, z 18.1 over
 *     terrain at 16) stands on it instead of falling through to the terrain.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PORTAL_PUNCH_STENCIL_BIT, PORTAL_PUNCH_RENDER_ORDER, TERRAIN_RENDER_ORDER, PORTAL_PUNCH_D3D_Z,
  retailPortalPunchDrawn, applyPortalPunchMask, createPortalPunch,
  portalPunchMarkMaterial, portalPunchEraseMaterial,
} from '../packages/renderer/src/world/PortalPunch.js';
import {
  buildBuildingGates, applySurfaceCellVisibility, type SurfaceCellBlock, type SurfaceView,
} from '../packages/renderer/src/world/buildingCells.js';
import { outdoorGroundY, floorSearchFromY, type OutdoorGroundSources } from '../packages/renderer/src/world/outdoorGround.js';
import { isSharedMaterial } from '../packages/renderer/src/models/MaterialOwnership.js';
import { openDat } from './_harness/dat.js';

const REPO = resolve(__dirname, '..');
const CELL = resolve(REPO, 'dat/client_cell_1.dat');
const PORTAL = resolve(REPO, 'dat/client_portal.dat');

describe('DrawPortalPolyInternal edge guard', () => {
  const sq = (pts: [number, number][]) => pts.map(([x, y]) => ({ x, y, z: 0 }));
  it('draws an ordinary portal polygon', () => {
    expect(retailPortalPunchDrawn(sq([[0, 0], [1, 0], [1, 1]]))).toBe(true);
  });
  it('skips a polygon whose vertices all lie on x = ±12 or y = ±12', () => {
    expect(retailPortalPunchDrawn([{ x: 12, y: 0, z: 0 }, { x: 12, y: 3, z: 1 }, { x: 12, y: 3, z: 0 }])).toBe(false);
    expect(retailPortalPunchDrawn([{ x: -12, y: 0, z: 0 }, { x: -12, y: 3, z: 1 }, { x: -12, y: 3, z: 0 }])).toBe(false);
    expect(retailPortalPunchDrawn(sq([[0, 12], [3, 12], [5, 12]]))).toBe(false);
    expect(retailPortalPunchDrawn(sq([[0, -12], [3, -12], [5, -12]]))).toBe(false);
  });
  it('draws a polygon that only touches the edge plane', () => {
    expect(retailPortalPunchDrawn(sq([[12, 0], [12, 3], [11, 3]]))).toBe(true);
  });
});

describe('portal punch passes', () => {
  it('mark pass: depth-tested, no colour / depth write, sets the stencil bit', () => {
    const m = portalPunchMarkMaterial();
    expect(m.colorWrite).toBe(false);
    expect(m.depthTest).toBe(true);
    expect(m.depthWrite).toBe(false);
    expect(m.stencilWrite).toBe(true);
    expect(m.stencilFunc).toBe(THREE.AlwaysStencilFunc);
    expect(m.stencilZPass).toBe(THREE.ReplaceStencilOp);
    expect(m.stencilRef & PORTAL_PUNCH_STENCIL_BIT).toBe(PORTAL_PUNCH_STENCIL_BIT);
    expect(m.side).toBe(THREE.DoubleSide);
    expect(isSharedMaterial(m)).toBe(true);
  });

  it('erase pass: DEPTHTEST_ALWAYS + depth write at z 0.99999899 on marked pixels only', () => {
    const m = portalPunchEraseMaterial();
    expect(m.colorWrite).toBe(false);
    expect(m.depthWrite).toBe(true);
    expect(m.depthFunc).toBe(THREE.AlwaysDepth);
    expect(m.stencilFunc).toBe(THREE.EqualStencilFunc);
    expect(m.stencilWriteMask).toBe(0);
    expect(m.stencilFuncMask).toBe(PORTAL_PUNCH_STENCIL_BIT);
    expect(PORTAL_PUNCH_D3D_Z).toBeCloseTo(0.99999899, 8);
    const shader = { vertexShader: '#include <project_vertex>\n', fragmentShader: '', uniforms: {} };
    m.onBeforeCompile(shader as never, undefined as never);
    // D3D [0, 1] depth 0.99999899 → GL NDC 2·z − 1
    const z = /gl_Position\.z = ([0-9.]+) \* gl_Position\.w/.exec(shader.vertexShader);
    expect(z).not.toBeNull();
    expect(Number(z![1])).toBeCloseTo(2 * 0.99999899 - 1, 7);
    expect(isSharedMaterial(m)).toBe(true);
  });

  it('builds the polygons as fans in three axes, ordered after the terrain, hidden, unpickable', () => {
    // AC z-up quad + triangle → 2 + 1 fan triangles.
    const punch = createPortalPunch([
      [{ x: 10, y: 20, z: 18.2 }, { x: 14, y: 20, z: 18.2 }, { x: 14, y: 24, z: 18.2 }, { x: 10, y: 24, z: 18.2 }],
      [{ x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 1 }, { x: 0, y: 1, z: 1 }],
    ])!;
    expect(punch.visible).toBe(false);
    expect(punch.children).toHaveLength(2);
    const [mark, erase] = punch.children as THREE.Mesh[];
    expect(mark.material).toBe(portalPunchMarkMaterial());
    expect(erase.material).toBe(portalPunchEraseMaterial());
    expect(mark.renderOrder).toBeGreaterThan(TERRAIN_RENDER_ORDER);
    expect(erase.renderOrder).toBeGreaterThan(mark.renderOrder);
    expect(erase.renderOrder).toBeLessThan(0); // ahead of every default-order object
    expect(PORTAL_PUNCH_RENDER_ORDER).toBe(mark.renderOrder);
    const pos = (mark.geometry.getAttribute('position') as THREE.BufferAttribute);
    expect(pos.count).toBe(9);
    // first vertex: AC (10, 20, 18.2) → three (10, 18.2, 20)
    expect([pos.getX(0), pos.getY(0), pos.getZ(0)].map(v => +v.toFixed(3))).toEqual([10, 18.2, 20]);
    const hits: THREE.Intersection[] = [];
    mark.raycast(new THREE.Raycaster(new THREE.Vector3(12, 30, 22), new THREE.Vector3(0, -1, 0)), hits);
    expect(hits).toHaveLength(0);
  });

  it('builds nothing from degenerate polygons', () => {
    expect(createPortalPunch([[{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }]])).toBeNull();
  });

  it('overlay masking: the stencil test skips pixels carrying the punch bit, writes nothing', () => {
    const mats = [new THREE.MeshLambertMaterial(), new THREE.MeshLambertMaterial()];
    applyPortalPunchMask(mats);
    for (const m of mats) {
      expect(m.stencilWrite).toBe(true); // three only enables the test with this set
      expect(m.stencilWriteMask).toBe(0);
      expect(m.stencilFunc).toBe(THREE.NotEqualStencilFunc);
      expect(m.stencilRef).toBe(PORTAL_PUNCH_STENCIL_BIT);
      expect(m.stencilFuncMask).toBe(PORTAL_PUNCH_STENCIL_BIT);
    }
  });
});

describe('the punch follows its gate (PView::DrawPortal → ConstructView)', () => {
  // The Xarabydun pit's portal: a horizontal polygon at z 18.2 whose
  // enterable side is above (portal flags 0x2 → requirePositive).
  const pit = [
    { x: 100, y: 10, z: 18.2 }, { x: 110, y: 10, z: 18.2 }, { x: 110, y: 20, z: 18.2 }, { x: 100, y: 20, z: 18.2 },
  ];
  const lookDown: SurfaceView['frustum'] = []; // no frustum planes → only the side test applies
  const view = (z: number): SurfaceView => ({ viewpoints: [{ x: 105, y: 0, z }, { x: 105, y: 0, z }], frustum: lookDown });

  function block(): { reg: Map<number, SurfaceCellBlock<{ visible: boolean }>>; punch: { visible: boolean }; madeFor: number[] } {
    const madeFor: number[] = [];
    const punch = { visible: false };
    const gates = buildBuildingGates(
      [{ flags: 0x2, otherCellId: 0x130, stabList: [0x130, 0x132] }],
      new Map([[0, [pit]]]), 0x40, (i) => { madeFor.push(i); return punch; });
    const meshes = new Map([[0x130, { visible: false }], [0x132, { visible: false }]]);
    const reg = new Map([[0x934b, { meshes, stabSet: new Set([0x130, 0x132]), gates }]]);
    return { reg, punch, madeFor };
  }

  it('asks for one punch per gated portal, by portal index', () => {
    expect(block().madeFor).toEqual([0]);
  });

  it('a viewer above the opening sees the cells AND punches the terrain', () => {
    const { reg, punch } = block();
    applySurfaceCellVisibility(reg, -1, new Set(), view(19.9));
    expect(reg.get(0x934b)!.meshes.get(0x130)!.visible).toBe(true);
    expect(punch.visible).toBe(true);
  });

  it('a viewer below the rim (our old z = 16 landing) gets neither', () => {
    const { reg, punch } = block();
    punch.visible = true;
    applySurfaceCellVisibility(reg, -1, new Set(), view(17.8));
    expect(reg.get(0x934b)!.meshes.get(0x130)!.visible).toBe(false);
    expect(punch.visible).toBe(false);
  });

  it('ungated (no view) every stab cell draws, so every portal punches', () => {
    const { reg, punch } = block();
    applySurfaceCellVisibility(reg, -1, new Set());
    expect(punch.visible).toBe(true);
  });
});

describe('outdoor ground rule', () => {
  const src = (terrain: number | null, floors: number[] | null): OutdoorGroundSources => ({
    terrainHeight: () => terrain,
    // nearest floor within the DungeonCollision window [fromY − 5, fromY + 2]
    floorHeight: floors === null ? null : (_x, _z, fromY) => {
      const c = floors.filter(f => f <= fromY + 2 && f >= fromY - 5);
      return c.length ? c.reduce((a, b) => (Math.abs(a - fromY) < Math.abs(b - fromY) ? a : b)) : null;
    },
  });

  it('a BSP floor at or above the terrain wins', () => {
    expect(outdoorGroundY(src(16, [18.1]), 0, 0, 18.1)).toBeCloseTo(18.1);
  });
  it('a floor more than 0.5 m under the terrain loses to the terrain', () => {
    expect(outdoorGroundY(src(16, [15]), 0, 0, 16)).toBe(16);
  });
  it('a floor just under the terrain lifts to the terrain', () => {
    expect(outdoorGroundY(src(16, [15.7]), 0, 0, 16)).toBe(16);
  });
  it('no collision world → terrain', () => {
    expect(outdoorGroundY(src(16, null), 0, 0, 18)).toBe(16);
  });
  it('the floor search starts at a pending arrival height, else last ground + step bias', () => {
    expect(floorSearchFromY(18.1, 16, 0)).toBe(18.1);
    expect(floorSearchFromY(null, 16, 0.3)).toBeCloseTo(16.3);
  });
});

describe.skipIf(!existsSync(CELL) || !existsSync(PORTAL))('Xarabydun pit rim (0x934B, building 0x01002bef) — real collision world', () => {
  const BX = 0x93, BY = 0x4b;
  // ACE points_of_interest "Xarabydun" → 0x934B0021 (108.3, 6.1, 18.1)
  const ARRIVAL = { x: BX * 192 + 108.3, y: BY * 192 + 6.1, z: 18.1 };
  let sources: OutdoorGroundSources;
  let terrainAt: (x: number, y: number) => number | null;

  beforeAll(async () => {
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    const { RegionDesc, CellLandblock, LandblockInfo } = await import('@ac/dat-parser');
    const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
    const { MaterialFactory } = await import('../packages/renderer/src/models/MaterialFactory.js');
    const { ModelRenderer } = await import('../packages/renderer/src/models/ModelRenderer.js');
    const { SetupModelRenderer } = await import('../packages/renderer/src/models/SetupModelRenderer.js');
    const { makeTerrainSampler } = await import('../packages/renderer/src/terrain/SceneryGenerator.js');
    const { DungeonCollision, collisionKey } = await import('../packages/renderer/src/world/DungeonCollision.js');
    const { resolveObjectPhysics, addObjectCollision } = await import('../packages/renderer/src/world/ObjectCollision.js');
    const portalDb = openDat(PORTAL);
    const cellDb = openDat(CELL);
    const region = new RegionDesc(new DatReader(portalDb.getFileData(0x13000000)!));
    const mr = new ModelRenderer(portalDb, new MaterialFactory(portalDb, new TextureManager(portalDb)));
    const sr = new SetupModelRenderer(portalDb, mr);
    const physSrc = { loadSetupModel: (id: number) => sr.loadSetupModel(id), loadGfxObj: (id: number) => mr.loadGfxObj(id) };
    const lbId = ((BX << 24) | (BY << 16) | 0xffff) >>> 0;
    const sampler = makeTerrainSampler(lbId, CellLandblock.read(new DatReader(cellDb.getFileData(lbId)!)), region);
    terrainAt = (x, y) => sampler.sample(x - BX * 192, y - BY * 192)?.z ?? null;
    const info = new LandblockInfo(new DatReader(cellDb.getFileData((lbId & 0xfffffffe) >>> 0)!));
    const dc = new DungeonCollision();
    info.buildings.forEach((b, bi) => {
      const m = resolveObjectPhysics(b.modelId, physSrc);
      if (!m) return;
      const q = b.frame.orientation;
      addObjectCollision(dc, (k, i) => collisionKey.building(0x934b, bi, k, i), m,
        b.frame.origin, { w: q.w, x: q.x, y: q.y, z: q.z }, 1, BX * 192, BY * 192);
    });
    sources = {
      terrainHeight: (x, z) => terrainAt(x, z),
      floorHeight: (x, z, fromY) => dc.getFloorHeight(x, z, fromY),
    };
  }, 60_000);

  it('the terrain is flat at 16 under the rim (the building, not the heightmap, raises it)', () => {
    expect(terrainAt(ARRIVAL.x, ARRIVAL.y)).toBeCloseTo(16, 1);
  });

  it('searching from the arrival height stands the player on the rim at ≈ 18.1', () => {
    const y = outdoorGroundY(sources, ARRIVAL.x, ARRIVAL.y, floorSearchFromY(ARRIVAL.z, 16, 0));
    expect(y).not.toBeNull();
    expect(y!).toBeGreaterThan(18);
    expect(Math.abs(y! - ARRIVAL.z)).toBeLessThan(0.1);
  });

  it('searching from the terrain (the old seed) misses the rim — the fall-through this fixes', () => {
    expect(outdoorGroundY(sources, ARRIVAL.x, ARRIVAL.y, 16)).toBeCloseTo(16, 1);
  });
});
