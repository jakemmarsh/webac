/**
 * CORE.14.b — retail surface interior-cell visibility
 * (collectBuildingStabCells + applySurfaceCellVisibility).
 *
 * Retail anchor (decompiled EoL client): while the viewer is outdoors a
 * landblock draws ONLY the interior cells its building portals reference —
 * CLandBlock::init_buildings builds the block stablist exclusively from
 * CBuildingObj::add_to_stablist → per-portal CBldPortal::add_to_stablist
 * (dedup'd union of each portal's precomputed stab_list), and
 * CLandBlock::grab_visible_cells loads exactly that (CEnvCell::
 * grab_visible). Indoors, the viewer's cell draws itself + its
 * VisibleCells PVS (CObjCell::draw_visible). Cells no building references
 * (deeper rooms, under-terrain dungeon complexes) never render outdoors.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  collectBuildingStabCells,
  applySurfaceCellVisibility,
  type SurfaceCellBlock,
} from '../packages/renderer/src/world/buildingCells.js';
import { openDat } from './_harness/dat.js';

describe('collectBuildingStabCells — retail CLandBlock stablist', () => {
  it('unions otherCellId + stabList across every building portal', () => {
    const stab = collectBuildingStabCells(
      [
        { portals: [{ otherCellId: 0x0100, stabList: [0x0100, 0x0102] }] },
        { portals: [{ otherCellId: 0x0105, stabList: [] }] },
      ],
      16,
    );
    expect(stab).toEqual(new Set([0x0100, 0x0102, 0x0105]));
  });

  it('dedups cells referenced by multiple portals (retail add_to_stablist dedup loop)', () => {
    const stab = collectBuildingStabCells(
      [
        {
          portals: [
            { otherCellId: 0x0100, stabList: [0x0101] }, // door
            { otherCellId: 0x0100, stabList: [0x0101] }, // window into the same rooms
          ],
        },
      ],
      4,
    );
    expect(stab).toEqual(new Set([0x0100, 0x0101]));
  });

  it('excludes cells no portal references — deeper rooms / dungeon complexes', () => {
    // Landblock with 6 cells; the building's door only sees the first two.
    const stab = collectBuildingStabCells(
      [{ portals: [{ otherCellId: 0x0100, stabList: [0x0101] }] }],
      6,
    );
    expect(stab.has(0x0102)).toBe(false);
    expect(stab.has(0x0105)).toBe(false);
    expect(stab.size).toBe(2);
  });

  it('filters exterior sentinels (0, 0xFFFF) and out-of-range indices', () => {
    const stab = collectBuildingStabCells(
      [{ portals: [{ otherCellId: 0x0000, stabList: [0xffff, 0x0900, 0x00ff] }] }],
      2, // valid range is 0x0100..0x0101
    );
    expect(stab.size).toBe(0);
  });

  it('a portal-less building contributes nothing (retail: no portals → no stablist)', () => {
    const stab = collectBuildingStabCells([{ portals: [] }], 5);
    expect(stab.size).toBe(0);
  });
});

describe('applySurfaceCellVisibility — retail draw rule', () => {
  function block(stab: number[], indices: number[]): SurfaceCellBlock {
    return {
      stabSet: new Set(stab),
      meshes: new Map(indices.map((i) => [i, { visible: true }])),
    };
  }

  it('outdoors (playerBlockKey -1): only stab cells render', () => {
    const registry = new Map([[0xa9b4, block([0x0100], [0x0100, 0x0101, 0x0102])]]);
    applySurfaceCellVisibility(registry, -1, new Set());
    const b = registry.get(0xa9b4)!;
    expect(b.meshes.get(0x0100)!.visible).toBe(true);   // through-the-door room
    expect(b.meshes.get(0x0101)!.visible).toBe(false);  // deeper room
    expect(b.meshes.get(0x0102)!.visible).toBe(false);  // dungeon room
  });

  it('indoors: current cell + PVS join the stab set in the player block only', () => {
    const registry = new Map([
      [0xa9b4, block([0x0100], [0x0100, 0x0101, 0x0102, 0x0103])],
      [0xacb5, block([0x0100], [0x0100, 0x0101])],
    ]);
    // Player stands in 0xa9b4 cell 0x0101, whose PVS sees 0x0102.
    applySurfaceCellVisibility(registry, 0xa9b4, new Set([0x0101, 0x0102]));
    const home = registry.get(0xa9b4)!;
    expect(home.meshes.get(0x0100)!.visible).toBe(true);   // stab (still drawn)
    expect(home.meshes.get(0x0101)!.visible).toBe(true);   // current cell
    expect(home.meshes.get(0x0102)!.visible).toBe(true);   // PVS
    expect(home.meshes.get(0x0103)!.visible).toBe(false);  // out of PVS
    const other = registry.get(0xacb5)!;
    expect(other.meshes.get(0x0100)!.visible).toBe(true);  // other blocks keep stab rule
    expect(other.meshes.get(0x0101)!.visible).toBe(false); // PVS never leaks across blocks
  });

  it('walking deep into a walk-in complex keeps rooms visible via PVS, not bbox', () => {
    // Mine with entrance stab {0x0100} and deep rooms 0x0110/0x0111.
    const registry = new Map([[0xacb5, block([0x0100], [0x0100, 0x0110, 0x0111])]]);
    applySurfaceCellVisibility(registry, 0xacb5, new Set([0x0110, 0x0111]));
    const b = registry.get(0xacb5)!;
    expect(b.meshes.get(0x0110)!.visible).toBe(true);
    expect(b.meshes.get(0x0111)!.visible).toBe(true);
    // Stepping back out (cell → 0): deep rooms hide again.
    applySurfaceCellVisibility(registry, -1, new Set());
    expect(b.meshes.get(0x0110)!.visible).toBe(false);
    expect(b.meshes.get(0x0100)!.visible).toBe(true);
  });
});

// ── DAT-backed: real Holtburg-area landblocks ───────────────────────────
const REPO = resolve(__dirname, '..');
const CELL_DAT = resolve(REPO, 'dat/client_cell_1.dat');
const datPresent = existsSync(CELL_DAT);

describe.skipIf(!datPresent)('collectBuildingStabCells — EoL cell.dat ground truth (needs DAT files)', () => {
  let DatDatabase: typeof import('../packages/dat-parser/src/DatDatabase.js').DatDatabase;
  let DatReader: typeof import('../packages/dat-parser/src/DatReader.js').DatReader;
  let LandblockInfo: typeof import('../packages/dat-parser/src/file-types/LandblockInfo.js').LandblockInfo;
  let cellDb: InstanceType<typeof DatDatabase>;

  beforeAll(async () => {
    ({ DatDatabase } = await import('../packages/dat-parser/src/DatDatabase.js'));
    ({ DatReader } = await import('../packages/dat-parser/src/DatReader.js'));
    ({ LandblockInfo } = await import('../packages/dat-parser/src/file-types/LandblockInfo.js'));
    cellDb = openDat(CELL_DAT);
  });

  function loadInfo(blockId: number) {
    const data = cellDb.getFileData(((blockId << 16) | 0xfffe) >>> 0);
    return data ? new LandblockInfo(new DatReader(data)) : null;
  }

  it('Holtburg 0xA9B4: every building portal resolves stab cells, all in range', () => {
    const info = loadInfo(0xa9b4);
    expect(info).not.toBeNull();
    expect(info!.buildings.length).toBeGreaterThan(0);
    const stab = collectBuildingStabCells(info!.buildings, info!.numCells);
    // Ground truth (verified 2026-09-04): town-building stabLists cover the
    // buildings' ENTIRE interiors — all 123 cells of 0xA9B4 are portal-
    // referenced. Retail loads all of them outdoors and relies on per-frame
    // portal-frustum culling for the drawn set; the wholesale reduction
    // comes from unreferenced complexes like 0xACB5 (next test).
    expect(stab.size).toBe(info!.numCells);
    for (const idx of stab) {
      expect(idx).toBeGreaterThanOrEqual(0x0100);
      expect(idx).toBeLessThan(0x0100 + info!.numCells);
    }
    // Per-building: every 0xA9B4 building has portals with stab lists.
    for (const b of info!.buildings) {
      expect(collectBuildingStabCells([b], info!.numCells).size).toBeGreaterThan(0);
    }
  });

  it('0xACB5 (walk-in complex, 238 cells): the stab set leaves the dungeon body out', () => {
    const info = loadInfo(0xacb5);
    expect(info).not.toBeNull();
    expect(info!.numCells).toBeGreaterThan(200);
    const stab = collectBuildingStabCells(info!.buildings, info!.numCells);
    expect(stab.size).toBeGreaterThan(0);
    // Entrance-visible rooms only — a sliver of the complex.
    expect(stab.size).toBeLessThan(info!.numCells / 4);
  });

  it('walk-in deep-cell pipeline: real containment + PVS shows the room around the player', async () => {
    // Drives the exact pieces the render loop wires together for the surface
    // rule, with real 0xACB5 data: register every cell BSP the way
    // loadLandblockObjects does (outdoorCollision.addCell), locate the
    // player inside deep cell 0x0150 (not SeenOutside, unreachable by any
    // building stab list), then apply the visibility rule with that cell's
    // PVS — the deep rooms around the player must render even though the
    // outdoor stab rule hides them.
    const { EnvCellRenderer } = await import('../packages/renderer/src/world/EnvCellRenderer.js');
    const { DungeonCollision } = await import('../packages/renderer/src/world/DungeonCollision.js');
    const { MaterialFactory } = await import('../packages/renderer/src/models/MaterialFactory.js');
    const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
    const { EnvCell } = await import('../packages/dat-parser/src/file-types/EnvCell.js');
    const PORTAL_DAT = resolve(REPO, 'dat/client_portal.dat');
    const portalDb = openDat(PORTAL_DAT);
    const envRenderer = new EnvCellRenderer(
      portalDb, cellDb, new MaterialFactory(portalDb, new TextureManager(portalDb)));

    const blockId = 0xacb5;
    const info = loadInfo(blockId)!;
    const collision = new DungeonCollision();
    const meshes = new Map<number, { visible: boolean }>();
    for (let i = 0; i < info.numCells; i++) {
      const cellId = ((blockId << 16) | (0x0100 + i)) >>> 0;
      const coll = envRenderer.getCellCollisionData(cellId);
      if (coll) collision.addCell(cellId, coll.cellStruct, coll.position);
      meshes.set(0x0100 + i, { visible: false });
    }
    const stabSet = collectBuildingStabCells(info.buildings, info.numCells);
    const registry = new Map([[blockId, { meshes, stabSet }]]);

    // Player standing in deep cell 0x0150 (cell-local origin + a bit inside).
    const deepId = ((blockId << 16) | 0x0150) >>> 0;
    const deep = new EnvCell(new DatReader(cellDb.getFileData(deepId)!));
    const o = deep.position.origin;
    const found = collision.findCellContaining(
      ((blockId >> 8) & 0xff) * 192 + o.x, (blockId & 0xff) * 192 + o.y, o.z + 0.5, 0);
    expect(found).toBe(deepId);

    const pvs = new Set<number>([found & 0xffff]);
    for (const v of deep.visibleCells) pvs.add(v);
    applySurfaceCellVisibility(registry, blockId, pvs);
    expect(meshes.get(0x0150)!.visible).toBe(true);          // the room itself
    expect(deep.cellPortals.length).toBeGreaterThan(0);
    for (const p of deep.cellPortals) {                       // its neighbors
      if (p.otherCellId >= 0x0100 && p.otherCellId < 0x0100 + info.numCells) {
        expect(meshes.get(p.otherCellId)!.visible).toBe(true);
      }
    }
    // And the outdoor rule hides them again once the player steps out.
    applySurfaceCellVisibility(registry, -1, new Set());
    expect(meshes.get(0x0150)!.visible).toBe(false);
    expect(meshes.get(0x0101)!.visible).toBe(true);           // entrance stab cell stays
  });
});
