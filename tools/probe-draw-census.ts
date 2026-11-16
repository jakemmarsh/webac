/**
 * probe-draw-census — what one world frame draws (PERF.cell-surface-merge, 2026-11-16,
 * docs/perf-pass-2026-11-15.md). Hooks renderer.renderBufferDirect for one
 * sceneManager.render() and buckets every draw by what it is (cell geometry, cell
 * furniture pool, building / scenery pool, server object, terrain, …), counting
 * material switches, program switches and geometry (VAO) switches per bucket.
 * Usage (env): AC_URL as tools/lib/game-session.ts; TELE (default: the Holtburg academy hall);
 *   YAWS='0,90,180,270'.   npx tsx tools/probe-draw-census.ts
 */
import { adminCommand, enterWorld } from './lib/game-session.ts';

const TELE = process.env.TELE ?? '@teleloc 0x8602023A [60 -20 0.005] 1 0 0 0';
const YAWS = (process.env.YAWS ?? '0,90,180,270').split(',').map(Number);
const { browser, page } = await enterWorld({ gpu: true, timeoutMs: 420000 });
if (TELE) await adminCommand(page, TELE);
await page.waitForTimeout(Number(process.env.SETTLE_MS ?? 30000));

// The scene graph by top-level child: nodes, nodes under an all-visible chain (what
// projectObject / the matrix walk visit), meshes, lights, frozen nodes.
const graph = await page.evaluate(`(() => {
  const scene = window.__ac.sceneManager.scene;
  const top = {}; let total = 0, visibleChain = 0;
  const walk = (o, topName, vis) => {
    total++;
    const v = vis && o.visible;
    const t = top[topName] ??= { nodes: 0, visibleChain: 0, meshes: 0, visMeshes: 0, lights: 0, frozen: 0 };
    t.nodes++; if (v) { t.visibleChain++; visibleChain++; }
    if (o.isMesh || o.isPoints || o.isLine || o.isSprite) { t.meshes++; if (v) t.visMeshes++; }
    if (o.isLight) t.lights++;
    if (!o.matrixAutoUpdate && !o.matrixWorldAutoUpdate) t.frozen++;
    for (const c of o.children) walk(c, topName, v);
  };
  for (const c of scene.children) walk(c, (c.name || c.type).replace(/[0-9a-f]{4,}/g, '#'), true);
  const rows = Object.entries(top).sort((a, b) => b[1].nodes - a[1].nodes).slice(0, 20).map(([k, v]) => k + ' ' + JSON.stringify(v));
  return { total, visibleChain, topLevel: scene.children.length, rows };
})()`);
console.log('GRAPH', JSON.stringify(graph, null, 1));

for (const yaw of YAWS) {
  await page.evaluate(`window.acDebug.setPlayerYaw(${yaw * Math.PI / 180})`);
  await page.waitForTimeout(2500);
  const r = await page.evaluate(`(() => {
    const sm = window.__ac.sceneManager; const r = sm.renderer;
    const kind = (o) => {
      if (o.userData.cellGeometry) return 'cellGeometry';
      for (let p = o; p; p = p.parent) {
        const n = p.name || '';
        if (n.startsWith('envcell_')) return o.isInstancedMesh ? 'cellFurniturePool' : 'cellObject';
        if (n.startsWith('dungeon_stream')) return 'dungeonOther';
        if (p.userData && p.userData.objCellId !== undefined) return 'serverObject';
        if (/terrain/i.test(n)) return 'terrain';
      }
      return o.isInstancedMesh ? 'pool' : (o.isPoints ? 'points' : 'other');
    };
    const stats = {}; let lastMat = null, lastProg = null, lastGeom = null, n = 0;
    const props = r.properties;
    const orig = r.renderBufferDirect;
    r.renderBufferDirect = function (camera, scene, geometry, material, object, group) {
      if (scene === sm.scene) {
        const k = kind(object); const s = stats[k] ??= { draws: 0, matSwitch: 0, progSwitch: 0, geomSwitch: 0, objects: new Set(), materials: new Set(), transparent: 0 };
        s.draws++; s.objects.add(object.id); s.materials.add(material.id); if (material.transparent) s.transparent++;
        const prog = props.get(material).currentProgram;
        if (material !== lastMat) s.matSwitch++;
        if (prog !== lastProg) s.progSwitch++;
        if (geometry !== lastGeom) s.geomSwitch++;
        lastMat = material; lastProg = prog; lastGeom = geometry; n++;
      }
      return orig.apply(this, arguments);
    };
    try { sm.render(); } finally { r.renderBufferDirect = orig; }
    const out = {};
    for (const [k, s] of Object.entries(stats)) out[k] = { draws: s.draws, objects: s.objects.size, materials: s.materials.size, matSwitch: s.matSwitch, progSwitch: s.progSwitch, geomSwitch: s.geomSwitch, transparent: s.transparent };
    let cellMeshes = 0, cells = 0, visibleCells = 0;
    sm.scene.traverse((o) => { if (o.userData.cellGeometry) cellMeshes++; if (o.userData.envCellId !== undefined && o.name.startsWith('envcell_')) { cells++; if (o.visible) visibleCells++; } });
    return { total: n, calls: r.info.render.calls, programs: r.info.programs.length, geometries: r.info.memory.geometries, cellMeshes, cells, visibleCells, byKind: out };
  })()`);
  console.log('YAW', yaw, JSON.stringify(r, null, 1));
}
await browser.close();
