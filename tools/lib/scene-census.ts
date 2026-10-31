/**
 * Scene census for the perf tools (measure-perf.ts): what the scene holds,
 * and what each part of it actually costs in draw calls.
 *
 * Both halves are page-side JavaScript kept as source strings so the page
 * runs exactly the code the tests run (tests/verify-perf-scene-census.ts
 * evaluates them against a real three.js scene).
 *
 * Distances are measured from the camera to each mesh's WORLD-space
 * bounding-sphere centre. The first census used the object's own position
 * (and an InstancedMesh's local bounding sphere), which put every mesh
 * whose geometry is baked away from its origin tens of km off: all cell
 * furniture (InstancedMeshes under a cell group) and every portal punch
 * (world-space vertices on a mesh at 0,0,0) read as ">600 m" while they
 * stood a few metres away (2026-10-31).
 *
 * The scene census counts meshes, hidden ones too; `visible` counts those
 * whose whole ancestor chain is visible. Only the draw census says what is
 * drawn: it counts WebGLRenderer.renderBufferDirect calls per category over
 * a run of frames (two-pass materials, multi-material meshes and the indoor
 * view's second render all count, as in renderer.info.render.calls).
 */

export interface CensusBucket { total: number; visible: number; beyond300: number; beyond600: number }

export interface SceneCensus {
  meshes: number;
  instanced: number;
  /** category (parent-name family: part / envcell_# / gfxobj_# / physcoll_# …) → counts */
  categories: Record<string, CensusBucket>;
}

export interface DrawCensus {
  frames: number;
  /** Mean renderBufferDirect calls per frame. */
  drawsPerFrame: number;
  /** category → mean draws per frame */
  byCategory: Record<string, number>;
  /** blend class (opaque / alphatest / transparent / additive) → mean draws per frame */
  byBlend: Record<string, number>;
  /** Mean distinct materials / geometries drawn per frame. */
  distinctMaterials: number;
  distinctGeometries: number;
}

/**
 * `function (obj)` → the census category: the nearest named ancestor's name
 * with long hex/digit runs folded to `#` and `part_N` folded to `part`.
 */
export const CENSUS_CATEGORY_SRC = `function censusCategory(o) {
  let n = o; while (n && !n.name) n = n.parent;
  return ((n && n.name) || '?').replace(/[0-9a-fx]{6,}/g, '#').replace(/part_\\d+/, 'part');
}`;

/** `function (scene, camera)` → SceneCensus. */
export const SCENE_CENSUS_SRC = `function sceneCensus(scene, camera) {
  const censusCategory = ${CENSUS_CATEGORY_SRC};
  scene.updateMatrixWorld();
  const cp = camera.getWorldPosition(camera.position.clone());
  const v = cp.clone();
  const categories = {}; let meshes = 0, instanced = 0;
  const chainVisible = (o) => { for (let n = o; n; n = n.parent) if (!n.visible) return false; return true; };
  scene.traverse((o) => {
    if (!o.isMesh) return;
    meshes++; if (o.isInstancedMesh) instanced++;
    let sphere = null;
    if (o.isInstancedMesh) { if (!o.boundingSphere) o.computeBoundingSphere(); sphere = o.boundingSphere; }
    else if (o.geometry) { if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere(); sphere = o.geometry.boundingSphere; }
    if (sphere && Number.isFinite(sphere.radius) && sphere.radius >= 0) v.copy(sphere.center).applyMatrix4(o.matrixWorld);
    else o.getWorldPosition(v);
    const d = v.distanceTo(cp);
    const nm = censusCategory(o);
    const b = categories[nm] || (categories[nm] = { total: 0, visible: 0, beyond300: 0, beyond600: 0 });
    b.total++; if (chainVisible(o)) b.visible++; if (d > 300) b.beyond300++; if (d > 600) b.beyond600++;
  });
  return { meshes, instanced, categories };
}`;

/**
 * `function (renderer, frames, nextFrame)` → Promise<DrawCensus>. Wraps
 * renderer.renderBufferDirect for `frames` frames (`nextFrame()` resolves
 * at the next frame; requestAnimationFrame in the page), then restores it.
 */
export const DRAW_CENSUS_SRC = `async function drawCensus(renderer, frames, nextFrame) {
  const censusCategory = ${CENSUS_CATEGORY_SRC};
  const catOf = new WeakMap();
  const byCategory = {}, byBlend = {};
  let draws = 0, mats = 0, geoms = 0;
  let frameMats = new Set(), frameGeoms = new Set();
  const own = Object.prototype.hasOwnProperty.call(renderer, 'renderBufferDirect');
  const orig = renderer.renderBufferDirect;
  renderer.renderBufferDirect = function (camera, scene, geometry, material, object, group) {
    let c = catOf.get(object);
    if (c === undefined) { c = censusCategory(object); catOf.set(object, c); }
    byCategory[c] = (byCategory[c] || 0) + 1;
    const blend = material.blending === 2 ? 'additive' : material.transparent ? 'transparent' : material.alphaTest > 0 ? 'alphatest' : 'opaque';
    byBlend[blend] = (byBlend[blend] || 0) + 1;
    draws++; frameMats.add(material); frameGeoms.add(geometry);
    return orig.call(this, camera, scene, geometry, material, object, group);
  };
  try {
    await nextFrame();
    draws = 0; for (const k in byCategory) delete byCategory[k]; for (const k in byBlend) delete byBlend[k];
    frameMats = new Set(); frameGeoms = new Set();
    for (let i = 0; i < frames; i++) {
      await nextFrame();
      mats += frameMats.size; geoms += frameGeoms.size;
      frameMats = new Set(); frameGeoms = new Set();
    }
  } finally {
    if (own) renderer.renderBufferDirect = orig; else delete renderer.renderBufferDirect;
  }
  const per = (n) => Math.round((n / frames) * 10) / 10;
  const mean = (o) => Object.fromEntries(Object.entries(o).map(([k, n]) => [k, per(n)]).sort((a, b) => b[1] - a[1]));
  return { frames, drawsPerFrame: per(draws), byCategory: mean(byCategory), byBlend: mean(byBlend),
    distinctMaterials: per(mats), distinctGeometries: per(geoms) };
}`;
