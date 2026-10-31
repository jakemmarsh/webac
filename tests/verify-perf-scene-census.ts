/**
 * tools/lib/scene-census — the perf tools' scene census and draw census,
 * run against a real three.js scene.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { DRAW_CENSUS_SRC, SCENE_CENSUS_SRC, type DrawCensus, type SceneCensus } from '../tools/lib/scene-census.js';

const sceneCensus = new Function(`return (${SCENE_CENSUS_SRC})`)() as (s: THREE.Scene, c: THREE.Camera) => SceneCensus;
type FakeRenderer = { renderBufferDirect: (...a: unknown[]) => void };
const drawCensus = new Function(`return (${DRAW_CENSUS_SRC})`)() as
  (r: FakeRenderer, frames: number, next: () => Promise<void>) => Promise<DrawCensus>;

// Holtburg-ish world coordinates (three: x east, y up, z north).
const CAM = new THREE.Vector3(32532, 100, 34567);

function camera(): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera();
  c.position.copy(CAM);
  return c;
}

function box(): THREE.BufferGeometry { return new THREE.BoxGeometry(1, 1, 1); }

describe('scene census distances are world-space', () => {
  it('counts an InstancedMesh under a moved cell group by where its instances are, not 0,0,0', () => {
    const scene = new THREE.Scene();
    const cell = new THREE.Group(); cell.name = 'envcell_a9b40105';
    cell.position.set(CAM.x + 10, 90, CAM.z + 5);
    const furn = new THREE.InstancedMesh(box(), new THREE.MeshBasicMaterial(), 2);
    furn.name = 'envfurninst_01000a2b';
    furn.setMatrixAt(0, new THREE.Matrix4().makeTranslation(1, 0, 1));
    furn.setMatrixAt(1, new THREE.Matrix4().makeTranslation(-1, 0, 2));
    cell.add(furn); scene.add(cell);
    const c = sceneCensus(scene, camera());
    expect(c.instanced).toBe(1);
    expect(c.categories['envfurninst_#']).toEqual({ total: 1, visible: 1, beyond300: 0, beyond600: 0 });
  });

  it('counts a mesh at the origin whose vertices are baked in world space (portal punch) by its geometry', () => {
    const scene = new THREE.Scene();
    const g = box(); g.translate(CAM.x + 20, 95, CAM.z);
    const punch = new THREE.Mesh(g, new THREE.MeshBasicMaterial()); punch.name = 'portal_punch';
    scene.add(punch);
    expect(sceneCensus(scene, camera()).categories.portal_punch).toEqual({ total: 1, visible: 1, beyond300: 0, beyond600: 0 });
  });

  it('still counts genuinely far meshes as far, and hidden ancestors as not visible', () => {
    const scene = new THREE.Scene();
    const far = new THREE.Group(); far.name = 'setup_02000001'; far.position.set(CAM.x + 700, 100, CAM.z);
    far.visible = false;
    const part = new THREE.Mesh(box(), new THREE.MeshBasicMaterial()); part.name = 'part_3';
    far.add(part); scene.add(far);
    const c = sceneCensus(scene, camera());
    expect(c.categories.part).toEqual({ total: 1, visible: 0, beyond300: 1, beyond600: 1 });
  });
});

describe('draw census', () => {
  it('counts renderBufferDirect calls per frame by category and blend class, then restores the renderer', async () => {
    const opaque = new THREE.MeshBasicMaterial();
    const additive = new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending });
    const cutout = new THREE.MeshBasicMaterial({ alphaTest: 0.5 });
    const setup = new THREE.Group(); setup.name = 'setup_0200004e';
    const p0 = new THREE.Mesh(box(), opaque); p0.name = 'part_0';
    const p1 = new THREE.Mesh(box(), cutout); p1.name = 'part_1';
    setup.add(p0, p1);
    const spark = new THREE.InstancedMesh(box(), additive, 4); spark.name = 'particle_gfx0';

    const drawn: unknown[] = [];
    const original = (...a: unknown[]) => { drawn.push(a[4]); };
    const renderer: FakeRenderer = { renderBufferDirect: original };
    // One "game frame": each part once, the particle twice (a two-pass material).
    const frame = () => {
      for (const [o, m] of [[p0, opaque], [p1, cutout], [spark, additive], [spark, additive]] as const) {
        renderer.renderBufferDirect(null, null, o.geometry, m, o, null);
      }
    };
    const next = () => new Promise<void>((res) => { frame(); res(); });

    const d = await drawCensus(renderer, 3, next);
    expect(d.frames).toBe(3);
    expect(d.drawsPerFrame).toBe(4);
    expect(d.byCategory).toEqual({ particle_gfx0: 2, part: 2 });
    expect(d.byBlend).toEqual({ additive: 2, opaque: 1, alphatest: 1 });
    expect(d.distinctMaterials).toBe(3);
    expect(d.distinctGeometries).toBe(3);
    expect(renderer.renderBufferDirect).toBe(original);
    expect(drawn.length).toBe(16); // every call still reached the real renderer (4 frames incl. warm-up)
  });
});
