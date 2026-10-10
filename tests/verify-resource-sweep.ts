/**
 * PERF.browser-memory-crash — the resource sweep (models/ResourceSweep.ts
 * plus each cache's sweep/retire). A real-GPU soak showed GPU textures
 * 828 → 3,448 and pooled scene children 340 → 1,052 across teleports. These
 * tests drive the real pool, instancer, material factory and texture manager.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { collectLiveResources, texturesOfMaterial } from '../packages/renderer/src/models/ResourceSweep.js';
import { SceneryInstancer, type InstanceEntry } from '../packages/renderer/src/terrain/SceneryInstancer.js';
import { SceneryInstancePool } from '../packages/renderer/src/terrain/SceneryInstancePool.js';
import { MaterialFactory } from '../packages/renderer/src/models/MaterialFactory.js';
import { TextureManager } from '../packages/renderer/src/models/TextureManager.js';

const GFX_A = 0x01000a01;
const GFX_B = 0x01000b02;

function makePool() {
  const geoms = new Map<number, THREE.BufferGeometry>();
  const createMesh = (id: number): THREE.Group | null => {
    if (id !== GFX_A && id !== GFX_B) return null;
    const g = new THREE.Group();
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geoms.set(id, geo);
    g.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial()));
    return g;
  };
  const inst = new SceneryInstancer({ createMesh }, { loadSetupModel: () => null });
  const scene = new THREE.Scene();
  const pool = new SceneryInstancePool(inst, 'sceneryinst', (m) => scene.add(m), (m) => scene.remove(m));
  return { inst, pool, scene, geoms };
}
const at = (objId: number, x: number): InstanceEntry => ({ objId, matrix: new THREE.Matrix4().makeTranslation(x, 0, 0) });

describe('collectLiveResources', () => {
  it('collects geometries, materials and every texture slot / uniform a scene still uses', () => {
    const scene = new THREE.Scene();
    const map = new THREE.Texture(); const alpha = new THREE.Texture(); const uni = new THREE.Texture(); const bg = new THREE.Texture();
    scene.background = bg;
    const geo = new THREE.BufferGeometry();
    scene.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map, alphaMap: alpha })));
    const shader = new THREE.ShaderMaterial({ uniforms: { tex: { value: uni } } });
    scene.add(new THREE.Mesh(new THREE.BufferGeometry(), [shader]));
    const live = collectLiveResources([scene]);
    expect(live.geometries.has(geo)).toBe(true);
    expect(live.materials.has(shader)).toBe(true);
    for (const t of [map, alpha, uni, bg]) expect(live.textures.has(t)).toBe(true);
    const only = new Set<THREE.Texture>(); texturesOfMaterial(new THREE.MeshBasicMaterial({ map }), only);
    expect([...only]).toEqual([map]);
  });
});

describe('SceneryInstancePool.retireEmptyFamilies + SceneryInstancer.sweep', () => {
  it('drops a family once all its landblocks unloaded, then frees its template geometry; live families stay', () => {
    const { inst, pool, scene, geoms } = makePool();
    pool.addBlock(1, [at(GFX_A, 0), at(GFX_B, 5)]);
    pool.addBlock(2, [at(GFX_B, 9)]);
    const before = scene.children.length;
    expect(before).toBeGreaterThan(0);
    pool.removeBlock(1); // GFX_A now empty; GFX_B still has block 2
    expect(pool.retireEmptyFamilies()).toBe(1);
    expect(scene.children.length).toBeLessThan(before);
    let disposedA = false; geoms.get(GFX_A)!.addEventListener('dispose', () => { disposedA = true; });
    let disposedB = false; geoms.get(GFX_B)!.addEventListener('dispose', () => { disposedB = true; });
    const live = collectLiveResources([scene]);
    expect(inst.sweep(live.geometries)).toBe(1);
    expect(disposedA).toBe(true);
    expect(disposedB).toBe(false);
    // a later block that uses GFX_A again rebuilds its family from fresh templates
    pool.addBlock(3, [at(GFX_A, 1)]);
    expect(pool.instanceCountFor(3)).toBe(1);
  });

  it('a family that still has instances is never retired', () => {
    const { pool } = makePool();
    pool.addBlock(1, [at(GFX_A, 0)]);
    expect(pool.retireEmptyFamilies()).toBe(0);
  });
});

describe('MaterialFactory.sweep / TextureManager.sweep', () => {
  it('release only what no live mesh references', () => {
    const db = { getFileData: () => null, hasFile: () => false } as never;
    const tm = new TextureManager(db);
    const mf = new MaterialFactory(db, tm);
    const a = mf.getMaterial(0x08000001);
    const b = mf.getMaterial(0x08000002);
    let aDisposed = false; a.addEventListener('dispose', () => { aDisposed = true; });
    let bDisposed = false; b.addEventListener('dispose', () => { bDisposed = true; });
    expect(mf.sweep(new Set([a]))).toBe(1);
    expect(aDisposed).toBe(false);
    expect(bDisposed).toBe(true);
    expect(mf.getMaterial(0x08000001)).toBe(a); // still cached
    expect(mf.getMaterial(0x08000002)).not.toBe(b); // rebuilt on demand
    expect(tm.sweep(new Set())).toBe(0); // nothing owned yet
  });
});
