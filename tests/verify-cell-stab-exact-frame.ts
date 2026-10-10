/**
 * VISUAL.holtburg-roof-plank — env-cell statics draw at their exact DAT
 * frame (ACE EnvCell: staticObj.add_obj_to_cell(this, StaticObjectFrames[i])).
 * The former "-bbox.min.y base lift" raised Holtburg's attic stab 0x01000bc6
 * 2.6 m, through the cottage roof by the lifestone (cell 0xA9B4016B).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import * as THREE from 'three';
import { openDat } from './_harness/dat.js';

const PORTAL = 'dat/client_portal.dat';
const CELL = 'dat/client_cell_1.dat';
const datPresent = existsSync(PORTAL) && existsSync(CELL);
const CELL_ID = 0xa9b4016b;
const ATTIC_STAB = 0x01000bc6;

describe.skipIf(!datPresent)('VISUAL.holtburg-roof-plank — Holtburg attic stab at its DAT frame (needs DAT files)', () => {
  let frameZ = 0;
  let cellZ = 0;
  let instancedY: number[] = [];
  let plainY: number[] = [];

  beforeAll(async () => {
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

    const plain = new EnvCellRenderer(portalDb, cellDb, materialFactory, setupRenderer, modelRenderer);
    const env = plain.loadEnvCell(CELL_ID)!;
    const stab = env.staticObjects.find((s) => s.id === ATTIC_STAB)!;
    frameZ = stab.frame.origin.z;
    cellZ = env.position.origin.z;

    const g = plain.createCellMesh(CELL_ID)!;
    g.updateMatrixWorld(true);
    for (const child of g.children) {
      if ((child as THREE.Mesh).userData?.cellGeometry) continue;
      if (child.name.startsWith('gfxobj_01000bc6')) plainY.push(new THREE.Vector3().setFromMatrixPosition(child.matrixWorld).y);
    }

    const instanced = new EnvCellRenderer(portalDb, cellDb, materialFactory, setupRenderer, modelRenderer);
    instanced.setInstancer(new SceneryInstancer(modelRenderer, setupRenderer));
    const ig = instanced.createCellMesh(CELL_ID)!;
    ig.updateMatrixWorld(true);
    ig.traverse((o) => {
      const im = o as THREE.InstancedMesh;
      if (!im.isInstancedMesh || !im.name.includes('01000bc6')) return;
      const m = new THREE.Matrix4();
      for (let i = 0; i < im.count; i++) {
        im.getMatrixAt(i, m);
        instancedY.push(new THREE.Vector3().setFromMatrixPosition(m.premultiply(im.matrixWorld)).y);
      }
    });
  }, 120_000);

  it('the stab is in the attic cell and its model extends below its pivot (the old lift would have raised it)', () => {
    expect(frameZ).toBeGreaterThan(cellZ);
  });

  it('per-object and instanced paths both put it at the frame height (+ the cell group\'s 0.05 m)', () => {
    expect(plainY.length + instancedY.length).toBeGreaterThan(0);
    for (const y of [...plainY, ...instancedY]) expect(y).toBeCloseTo(frameZ + 0.05, 4);
  });
});
