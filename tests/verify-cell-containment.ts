/**
 * BUG.10 — point-in-cell containment (ACE physics parity) + live cell lookup.
 *
 * Mirrors ACE exactly:
 *   BSPNode.point_inside_cell_bsp (Physics/BSP/BSPNode.cs:191) — Front/Close
 *   recurses posNode / accepts; Behind rejects; leaves accept (ACE leaf has a
 *   default zero plane → Close → true).
 *   PlaneExtensions.GetSide epsilon = 0.0002 (PhysicsGlobals.cs:9).
 *   EnvCell.point_in_cell (Physics/Common/EnvCell.cs:418) — cell-local
 *   transform via AFrame.GlobalToLocal.
 *
 * DAT-gated integration: registers all Training Academy (0x8602) EnvCells in
 * DungeonCollision and asserts the self-consistency property that anchors
 * findCellContaining: for every cell that contains a probe point derived
 * from its own geometry, findCellContaining must resolve that point to that
 * cell (with the cell preferred — the steady-state lookup path) and to a
 * containing cell without preference (the transition path).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pointInsideCellBsp, pointInCell, inverseRotate } from '../packages/renderer/src/world/cellContainment.js';
import { openDat } from './_harness/dat.js';

const REPO = resolve(__dirname, '..');
const PORTAL = resolve(REPO, 'dat/client_portal.dat');
const CELL = resolve(REPO, 'dat/client_cell_1.dat');
const datPresent = existsSync(PORTAL) && existsSync(CELL);

describe('BUG.10 — pointInsideCellBsp unit behavior', () => {
  const plane = (nx: number, ny: number, nz: number, distance: number) => ({ normal: { x: nx, y: ny, z: nz }, distance });

  it('single-plane node: Front/Close inside, Behind outside', () => {
    const node = { type: 'BPnn', splittingPlane: plane(0, 0, 1, 0) } as never;
    expect(pointInsideCellBsp(node, { x: 0, y: 0, z: 1 })).toBe(true);   // front
    expect(pointInsideCellBsp(node, { x: 0, y: 0, z: 0 })).toBe(true);   // close (|d| <= 0.0002)
    expect(pointInsideCellBsp(node, { x: 0, y: 0, z: -1 })).toBe(false); // behind
  });

  it('recurses only the positive child, leaf accepts', () => {
    const node = {
      type: 'BPIn',
      splittingPlane: plane(0, 0, 1, 0),
      posNode: { type: 'BPnn', splittingPlane: plane(1, 0, 0, -5) },
    } as never;
    expect(pointInsideCellBsp(node, { x: 6, y: 0, z: 1 })).toBe(true);
    expect(pointInsideCellBsp(node, { x: 4, y: 0, z: 1 })).toBe(false); // fails child plane
    const leafChild = { type: 'BPIn', splittingPlane: plane(0, 0, 1, 0), posNode: { type: 'LEAF' } } as never;
    expect(pointInsideCellBsp(leafChild, { x: 0, y: 0, z: 5 })).toBe(true);
  });

  it('inverseRotate matches quaternion conjugation (90° about Z)', () => {
    // q = 90° about +Z: (w=cos45, z=sin45). Global +X → local -Y? inverse rotation maps +X to (0,-1,0)... verify algebraically: rotating local v by q gives global; inverse takes global→local.
    const s = Math.SQRT1_2;
    const q = { w: s, x: 0, y: 0, z: s };
    const local = inverseRotate(q, { x: 1, y: 0, z: 0 });
    expect(local.x).toBeCloseTo(0, 6);
    expect(local.y).toBeCloseTo(-1, 6);
    expect(local.z).toBeCloseTo(0, 6);
  });
});

describe.skipIf(!datPresent)('BUG.10 — academy cell lookup (needs DAT files)', () => {
  it('findCellContaining resolves geometry-derived probe points to their own cell', async () => {
    const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    const { EnvCell } = await import('../packages/dat-parser/src/file-types/EnvCell.js');
    const { DungeonCollision } = await import('../packages/renderer/src/world/DungeonCollision.js');
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
    const envRenderer = new EnvCellRenderer(portalDb, cellDb, materialFactory, setupRenderer, modelRenderer);

    const collision = new DungeonCollision();
    const probes: Array<{ cellId: number; acX: number; acY: number; acZ: number }> = [];
    for (let c = 0x100; c <= 0x3ff; c++) {
      const cellId = ((0x8602 << 16) | c) >>> 0;
      const data = cellDb.getFileData(cellId);
      if (!data) continue;
      const env = new EnvCell(new DatReader(data));
      const coll = envRenderer.getCellCollisionData(cellId);
      if (!coll) continue;
      collision.addCell(cellId, coll.cellStruct, coll.position);
      // probe: cell frame origin lifted 1m — inside for box-like cells;
      // filtered below by the cell's own containment test.
      probes.push({
        cellId,
        acX: (cellId >>> 24) * 192 + env.position.origin.x,
        acY: ((cellId >>> 16) & 0xff) * 192 + env.position.origin.y,
        acZ: env.position.origin.z + 1.0,
      });
    }
    expect(probes.length).toBeGreaterThan(500); // 568 academy cells

    let selfContained = 0;
    let resolvedPreferred = 0;
    let resolvedUnpreferred = 0;
    for (const p of probes) {
      const cell = (collision as never as { cells: Map<number, { cellBspRoot: unknown; origin: never; quat: never; blockOffsetX: number; blockOffsetY: number }> }).cells.get(p.cellId)!;
      const contains = pointInCell(cell.cellBspRoot as never, cell.origin, cell.quat,
        { x: p.acX - cell.blockOffsetX, y: p.acY - cell.blockOffsetY, z: p.acZ });
      if (!contains) continue; // probe fell outside (portal-edge origin) — not a valid probe
      selfContained++;
      // steady-state path: current cell preferred
      if (collision.findCellContaining(p.acX, p.acY, p.acZ, p.cellId) === p.cellId) resolvedPreferred++;
      // transition path: no preference — must land in SOME containing cell
      // (overlapping portal boundaries may legitimately resolve to a neighbor)
      const found = collision.findCellContaining(p.acX, p.acY, p.acZ, 0);
      if (found !== 0) resolvedUnpreferred++;
    }
    expect(selfContained).toBeGreaterThan(150);       // origins often sit at portal boundaries; ~200/568 are interior
    expect(resolvedPreferred).toBe(selfContained);     // preferred lookup is exact
    expect(resolvedUnpreferred).toBe(selfContained);   // scan always finds a cell
    // Negative discrimination (the original field-name bug made everything
    // "contained" and this suite passed vacuously): the broken chargen spawn
    // point is NOT inside its claimed cell 0x860201AD (10x10m room at
    // landblock-local (10,-30) — the point sits 193m away), matching ACE's
    // own AddWorldObjectInternal spawn failure for the same position.
    const spawnProbeCell = collision.findCellContaining(0x86 * 192 + 12.32, 0x02 * 192 + 163.518, 0.5, 0x860201ad);
    expect(spawnProbeCell).not.toBe(0x860201ad);
    // And a point far outside the dungeon resolves to nothing.
    expect(collision.findCellContaining(0x86 * 192 + 500, 0x02 * 192 + 500, 0.5, 0)).toBe(0);
  }, 120_000);
});

describe.skipIf(!datPresent)('GAP.2 — portal-graph visibility culling (needs DAT files)', () => {
  it('applyPortalVisibility shows only the current cell + its DAT VisibleCells (PVS)', async () => {
    const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase.js');
    const { DungeonRenderer } = await import('../packages/renderer/src/world/DungeonRenderer.js');
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
    const envRenderer = new EnvCellRenderer(portalDb, cellDb, materialFactory, setupRenderer, modelRenderer);

    const dungeon = new DungeonRenderer(cellDb, envRenderer);
    const group = dungeon.initStream(0x8602ffff);
    expect(group).not.toBeNull();
    // Load the neighborhood around the academy start room 0x1AD (true
    // interior at landblock-local (10,-30) — see the containment suite).
    dungeon.updateStream(10, -30);
    expect(dungeon.streamCellCount).toBeGreaterThan(1);

    const current = 0x860201ad;
    const env = envRenderer.loadEnvCell(current)!;
    expect(env.visibleCells.length).toBeGreaterThan(0);
    const pvs = new Set(env.visibleCells);

    dungeon.applyPortalVisibility(current);
    const meshes = (dungeon as never as { loadedCellMeshes: Map<number, { visible: boolean }> }).loadedCellMeshes;
    let visible = 0, hidden = 0;
    for (const [cellId, mesh] of meshes) {
      const idx = cellId & 0xffff;
      const expected = idx === 0x1ad || pvs.has(idx);
      expect(mesh.visible).toBe(expected);
      if (mesh.visible) visible++; else hidden++;
    }
    // The PVS must actually cull something within the stream radius —
    // otherwise this test is vacuous.
    expect(visible).toBeGreaterThan(0);
    expect(hidden).toBeGreaterThan(0);

    // Unknown current cell (mid-portal / out-of-bounds hold) → show all.
    dungeon.applyPortalVisibility(0);
    for (const [, mesh] of meshes) expect(mesh.visible).toBe(true);
  }, 120_000);
});
