/**
 * PERF.1 (town-facing part-bucket slice) — per-cell instanced furniture
 * parity. EnvCellRenderer.createCellMesh batches cell static objects
 * (furniture/torches) into per-cell InstancedMeshes when a SceneryInstancer
 * is wired (main.ts does), replacing one Mesh per SetupModel part-surface —
 * the largest town-facing draw-call bucket at Holtburg (~973 calls from
 * through-the-door-visible cottage interiors).
 *
 * Covenant: pixels must be identical, so these DAT-gated tests build the
 * SAME cell with and without the instancer and assert triangle totals,
 * world-space furniture bounds, and DAT light world positions are equal.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { openDat } from './_harness/dat.js';

const REPO = resolve(__dirname, '..');
const PORTAL = resolve(REPO, 'dat/client_portal.dat');
const CELL = resolve(REPO, 'dat/client_cell_1.dat');
const datPresent = existsSync(PORTAL) && existsSync(CELL);

// Training Academy (0x8602, the EoL starter dungeon) — furniture-rich cells.
const LB = 0x8602;

describe.skipIf(!datPresent)('PERF.1 — per-cell instanced furniture parity (needs DAT files)', () => {
  let plainRenderer: import('../packages/renderer/src/world/EnvCellRenderer.js').EnvCellRenderer;
  let instRenderer: import('../packages/renderer/src/world/EnvCellRenderer.js').EnvCellRenderer;

  beforeAll(async () => {
    const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase.js');
    const { EnvCellRenderer } = await import('../packages/renderer/src/world/EnvCellRenderer.js');
    const { SetupModelRenderer } = await import('../packages/renderer/src/models/SetupModelRenderer.js');
    const { ModelRenderer } = await import('../packages/renderer/src/models/ModelRenderer.js');
    const { MaterialFactory } = await import('../packages/renderer/src/models/MaterialFactory.js');
    const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
    const { SceneryInstancer } = await import('../packages/renderer/src/terrain/SceneryInstancer.js');

    const portalDb = openDat(PORTAL);
    const cellDb = openDat(CELL);
    const textureManager = new TextureManager(portalDb);
    const materialFactory = new MaterialFactory(portalDb, textureManager);
    const modelRenderer = new ModelRenderer(portalDb, materialFactory);
    const setupRenderer = new SetupModelRenderer(portalDb, modelRenderer);

    plainRenderer = new EnvCellRenderer(portalDb, cellDb, materialFactory, setupRenderer, modelRenderer);
    instRenderer = new EnvCellRenderer(portalDb, cellDb, materialFactory, setupRenderer, modelRenderer);
    instRenderer.setInstancer(new SceneryInstancer(modelRenderer, setupRenderer));
  });

  /** Sum triangles + union world bbox over the REFERENCE cell's furniture
   *  meshes (everything that is a Mesh but not tagged cell geometry). */
  function refFurnitureStats(group: THREE.Group) {
    group.updateMatrixWorld(true);
    let tris = 0;
    const bbox = new THREE.Box3();
    const scratch = new THREE.Box3();
    group.traverse(o => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || mesh.userData.cellGeometry) return;
      tris += (mesh.geometry.index?.count ?? 0) / 3;
      mesh.geometry.computeBoundingBox();
      scratch.copy(mesh.geometry.boundingBox!).applyMatrix4(mesh.matrixWorld);
      bbox.union(scratch);
    });
    return { tris, bbox };
  }

  /** Same stats over the INSTANCED cell's furniture batches. */
  function instFurnitureStats(group: THREE.Group) {
    group.updateMatrixWorld(true);
    let tris = 0;
    let batches = 0;
    const bbox = new THREE.Box3();
    const scratch = new THREE.Box3();
    const im = new THREE.Matrix4();
    const world = new THREE.Matrix4();
    group.traverse(o => {
      const mesh = o as THREE.InstancedMesh;
      if (!mesh.isInstancedMesh || !mesh.name.startsWith('envfurninst_')) return;
      batches++;
      tris += ((mesh.geometry.index?.count ?? 0) / 3) * mesh.count;
      mesh.geometry.computeBoundingBox();
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, im);
        world.multiplyMatrices(mesh.matrixWorld, im);
        scratch.copy(mesh.geometry.boundingBox!).applyMatrix4(world);
        bbox.union(scratch);
      }
    });
    return { tris, batches, bbox };
  }

  function lightWorldPositions(group: THREE.Group): string[] {
    group.updateMatrixWorld(true);
    const out: string[] = [];
    const v = new THREE.Vector3();
    group.traverse(o => {
      if (!(o as THREE.PointLight).isLight || !o.userData.datLight) return;
      o.getWorldPosition(v);
      out.push(`${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`);
    });
    return out.sort();
  }

  it('instanced cells draw the same furniture triangles in the same places, with fewer meshes', () => {
    let cellsCompared = 0;
    let cellsWithBatches = 0;
    let refMeshTotal = 0;
    let instBatchTotal = 0;
    for (let cell = 0x100; cell <= 0x1ff; cell++) {
      const cellId = ((LB << 16) | cell) >>> 0;
      let envCell;
      try { envCell = plainRenderer.loadEnvCell(cellId); } catch { continue; }
      if (!envCell || envCell.staticObjects.length === 0) continue;

      const refGroup = plainRenderer.createCellMesh(cellId);
      const instGroup = instRenderer.createCellMesh(cellId);
      if (!refGroup || !instGroup) continue;

      const ref = refFurnitureStats(refGroup);
      const inst = instFurnitureStats(instGroup);
      cellsCompared++;
      if (inst.batches === 0) continue; // every stab fell back (nothing to compare)
      cellsWithBatches++;

      // Same triangles…
      expect(inst.tris).toBe(ref.tris);
      // …occupying the same world-space bounds (float32 instance matrices).
      for (const axis of ['x', 'y', 'z'] as const) {
        expect(inst.bbox.min[axis]).toBeCloseTo(ref.bbox.min[axis], 3);
        expect(inst.bbox.max[axis]).toBeCloseTo(ref.bbox.max[axis], 3);
      }
      // …from fewer drawable objects.
      let refMeshes = 0;
      refGroup.traverse(o => { if ((o as THREE.Mesh).isMesh && !o.userData.cellGeometry) refMeshes++; });
      refMeshTotal += refMeshes;
      instBatchTotal += inst.batches;
      expect(inst.batches).toBeLessThanOrEqual(refMeshes);

      // DAT lights land at identical world positions on both paths.
      expect(lightWorldPositions(instGroup)).toEqual(lightWorldPositions(refGroup));
    }
    // The Training Academy must actually exercise the instanced path.
    expect(cellsCompared).toBeGreaterThan(0);
    expect(cellsWithBatches).toBeGreaterThan(0);
    expect(instBatchTotal).toBeLessThan(refMeshTotal);
  });

  it('instanced batches carry sharedResources so cell disposal never frees templates', () => {
    for (let cell = 0x100; cell <= 0x1ff; cell++) {
      const cellId = ((LB << 16) | cell) >>> 0;
      let group;
      try { group = instRenderer.createCellMesh(cellId); } catch { continue; }
      if (!group) continue;
      let batches = 0;
      group.traverse(o => {
        const mesh = o as THREE.InstancedMesh;
        if (mesh.isInstancedMesh && mesh.name.startsWith('envfurninst_')) {
          batches++;
          expect(mesh.userData.sharedResources).toBe(true);
        }
      });
      if (batches > 0) return; // proved on a real furnished cell
    }
    throw new Error('no Training Academy cell produced instanced furniture');
  });
});
