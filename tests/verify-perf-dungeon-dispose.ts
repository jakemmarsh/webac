/**
 * ASSESS: DungeonRenderer streamed-cell disposal (fresh-eyes audit 2026-06-10
 * §performance flagged the cell-unload path as leaking materials). Pins the
 * ownership-aware disposal model:
 *   - geometry: always per-mesh → always disposed
 *   - cell-geometry materials (userData.cellGeometry): an OWNED copy is
 *     disposed (EnvCellRenderer gives a cell its own copy only when the factory
 *     material was built across a streamed-DAT miss; since
 *     PERF.shared-cell-materials the usual copy is shared per surface and
 *     registered shared, so it is spared like the static-object material —
 *     tests/verify-perf-shared-cell-materials.ts)
 *   - static-object materials: SHARED MaterialFactory-cached instances → must
 *     NOT be disposed when one cell unloads (other live meshes use them)
 * Also pins the previously-leaking paths: initStream() over a prior dungeon
 * and clear() now dispose leftover loaded cells.
 *
 * Drives the real DungeonRenderer with a stub EnvCellRenderer.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import type { DatDatabase } from '@ac/dat-parser/DatDatabase.js';
import { DungeonRenderer } from '@ac/renderer/world/DungeonRenderer.js';
import { markSharedMaterial } from '@ac/renderer/models/MaterialOwnership.js';
import type { EnvCellRenderer } from '@ac/renderer/world/EnvCellRenderer.js';

interface CellSpec {
  cellId: number;
  x: number;
  y: number;
}

interface DisposalTrackers {
  cellGeomDisposed: Set<number>;
  cellMatDisposed: Set<number>;
  staticGeomDisposed: Set<number>;
  sharedMaterial: THREE.Material;
  sharedMaterialDisposed: () => boolean;
}

/** Build a DungeonRenderer over stub cells, tracking every dispose() call. */
function makeStreamedDungeon(cells: CellSpec[]) {
  let sharedDisposed = false;
  // REND.shared-cached-material-disposed-faded — MaterialFactory registers
  // every cached material as shared (MaterialOwnership.markSharedMaterial);
  // the stub does the same so the one ownership rule recognises it.
  const sharedMaterial = markSharedMaterial(new THREE.MeshLambertMaterial());
  sharedMaterial.addEventListener('dispose', () => { sharedDisposed = true; });

  const trackers: DisposalTrackers = {
    cellGeomDisposed: new Set(),
    cellMatDisposed: new Set(),
    staticGeomDisposed: new Set(),
    sharedMaterial,
    sharedMaterialDisposed: () => sharedDisposed,
  };

  const stubEnvCellRenderer = {
    loadEnvCell(cellId: number) {
      const spec = cells.find(c => c.cellId === cellId);
      if (!spec) return null;
      return {
        position: { origin: { x: spec.x, y: spec.y, z: 0 } },
        cellPortals: [],
      };
    },
    createCellMesh(cellId: number): THREE.Group {
      const group = new THREE.Group();

      // Cell geometry mesh — material is an owned per-cell clone
      // (mirrors EnvCellRenderer.buildCellGeometry)
      const cellGeom = new THREE.BufferGeometry();
      cellGeom.addEventListener('dispose', () => trackers.cellGeomDisposed.add(cellId));
      const ownedMat = new THREE.MeshLambertMaterial();
      ownedMat.addEventListener('dispose', () => trackers.cellMatDisposed.add(cellId));
      const cellMesh = new THREE.Mesh(cellGeom, ownedMat);
      cellMesh.userData.cellGeometry = true;
      group.add(cellMesh);

      // Static object mesh — geometry per-mesh, material SHARED across cells
      // (mirrors ModelRenderer.createMesh + MaterialFactory cache)
      const staticGeom = new THREE.BufferGeometry();
      staticGeom.addEventListener('dispose', () => trackers.staticGeomDisposed.add(cellId));
      group.add(new THREE.Mesh(staticGeom, trackers.sharedMaterial));

      return group;
    },
  } as unknown as EnvCellRenderer;

  const stubCellDb = {
    getFileData: () => null,
    hasFile: () => false,
  } as unknown as DatDatabase;

  const dr = new DungeonRenderer(stubCellDb, stubEnvCellRenderer);
  // findInteriorCells normally walks LandblockInfo from cell.dat — pin the
  // cell list directly so initStream/updateStream run their real logic.
  dr.findInteriorCells = () => cells.map(c => c.cellId);

  return { dr, trackers };
}

describe('DungeonRenderer streamed-cell disposal', () => {
  it('unloading a distant cell disposes geometry + owned material, spares shared material', () => {
    const { dr, trackers } = makeStreamedDungeon([
      { cellId: 0x01010100, x: 0, y: 0 },
      { cellId: 0x01010101, x: 500, y: 0 },
    ]);
    const group = dr.initStream(0x0101FFFF);
    expect(group).not.toBeNull();

    // Player at origin → only cell 1 in LOAD_RADIUS (80)
    dr.updateStream(0, 0);
    expect(dr.streamCellCount).toBe(1);

    // Player moves to the far cell → cell 1 beyond UNLOAD_RADIUS (120) unloads,
    // cell 2 loads (its static object still uses the shared material)
    dr.updateStream(500, 0);
    expect(dr.streamCellCount).toBe(1);

    expect(trackers.cellGeomDisposed.has(0x01010100)).toBe(true);
    expect(trackers.staticGeomDisposed.has(0x01010100)).toBe(true);
    expect(trackers.cellMatDisposed.has(0x01010100)).toBe(true);
    // shared factory material must survive — cell 2's static object renders with it
    expect(trackers.sharedMaterialDisposed()).toBe(false);
    // the still-loaded cell was not disposed
    expect(trackers.cellGeomDisposed.has(0x01010101)).toBe(false);
  });

  it('initStream over a previous dungeon disposes its leftover loaded cells', () => {
    const { dr, trackers } = makeStreamedDungeon([
      { cellId: 0x01010100, x: 0, y: 0 },
    ]);
    dr.initStream(0x0101FFFF);
    dr.updateStream(0, 0);
    expect(dr.streamCellCount).toBe(1);

    // switching dungeons re-inits the stream — the old cells must be disposed
    dr.initStream(0x0101FFFF);
    expect(dr.streamCellCount).toBe(0);
    expect(trackers.cellGeomDisposed.has(0x01010100)).toBe(true);
    expect(trackers.cellMatDisposed.has(0x01010100)).toBe(true);
    expect(trackers.staticGeomDisposed.has(0x01010100)).toBe(true);
    expect(trackers.sharedMaterialDisposed()).toBe(false);
  });

  it('clear() disposes loaded streamed cells', () => {
    const { dr, trackers } = makeStreamedDungeon([
      { cellId: 0x01010100, x: 0, y: 0 },
    ]);
    dr.initStream(0x0101FFFF);
    dr.updateStream(0, 0);
    dr.clear();
    expect(dr.streamCellCount).toBe(0);
    expect(trackers.cellGeomDisposed.has(0x01010100)).toBe(true);
    expect(trackers.cellMatDisposed.has(0x01010100)).toBe(true);
    expect(trackers.sharedMaterialDisposed()).toBe(false);
  });

  it('nearby cells stay loaded and undisposed across updates', () => {
    const { dr, trackers } = makeStreamedDungeon([
      { cellId: 0x01010100, x: 0, y: 0 },
      { cellId: 0x01010101, x: 30, y: 0 },
    ]);
    dr.initStream(0x0101FFFF);
    dr.updateStream(0, 0);
    expect(dr.streamCellCount).toBe(2);
    dr.updateStream(10, 5);
    dr.updateStream(0, 0);
    expect(dr.streamCellCount).toBe(2);
    expect(trackers.cellGeomDisposed.size).toBe(0);
    expect(trackers.cellMatDisposed.size).toBe(0);
  });

  // PERF.dungeon-stream-lookup — the unload pass finds each loaded cell's
  // origin by id (a Map) instead of a linear find per cell per frame. Same
  // loads and unloads, step for step, as the radius rule computed here.
  it('streams the same cells as the radius rule over a long walk, and re-indexes on a new dungeon', () => {
    const cells: CellSpec[] = [];
    for (let i = 0; i < 24; i++) for (let j = 0; j < 24; j++) cells.push({ cellId: (0x01010100 + i * 24 + j) >>> 0, x: i * 20, y: j * 20 });
    const { dr } = makeStreamedDungeon(cells);
    dr.initStream(0x0101FFFF);
    const loaded = new Set<number>();
    const LOAD = DungeonRenderer.LOAD_RADIUS, UNLOAD = DungeonRenderer.UNLOAD_RADIUS;
    for (let step = 0; step <= 60; step++) {
      const px = step * 8, py = 230 + 120 * Math.sin(step / 6);
      for (const c of cells) {
        const d2 = (c.x - px) ** 2 + (c.y - py) ** 2;
        if (d2 <= LOAD * LOAD) loaded.add(c.cellId);
        else if (d2 > UNLOAD * UNLOAD) loaded.delete(c.cellId);
      }
      dr.updateStream(px, py);
      expect(dr.streamCellCount).toBe(loaded.size);
    }
    expect(loaded.size).toBeGreaterThan(20);
    // A new stream over a different layout of the same ids: the old origins must not answer.
    const moved = cells.map((c) => ({ ...c, x: c.x + 5000 }));
    cells.splice(0, cells.length, ...moved);
    dr.initStream(0x0101FFFF);
    dr.updateStream(5000, 0);
    const near = moved.filter((c) => (c.x - 5000) ** 2 + c.y ** 2 <= LOAD * LOAD).length;
    expect(dr.streamCellCount).toBe(near);
    // Walking away unloads them by their new origins.
    dr.updateStream(9000, 0);
    expect(dr.streamCellCount).toBe(0);
  });
});
