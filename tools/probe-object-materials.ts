/**
 * probe-object-materials — why server objects of one kind draw distinct materials
 * (PERF, 2026-11-16, docs/perf-pass-2026-11-15.md). Groups the visible server objects
 * by name and, per group, counts distinct materials / maps / programs across the
 * group's meshes, and how each material differs from the same part's material on the
 * group's first object (which fields of the serialised material differ).
 * Usage (env): AC_URL; TELE (default: the Holtburg academy hall); NAME=regex (default: all).
 *   npx tsx tools/probe-object-materials.ts
 */
import { adminCommand, enterWorld } from './lib/game-session.ts';

const TELE = process.env.TELE ?? '@teleloc 0x8602023A [60 -20 0.005] 1 0 0 0';
const { browser, page } = await enterWorld({ gpu: true, timeoutMs: 420000 });
if (TELE) await adminCommand(page, TELE);
await page.waitForTimeout(Number(process.env.SETTLE_MS ?? 30000));
const r = await page.evaluate(`(() => {
  const scene = window.__ac.sceneManager.scene; const re = new RegExp(${JSON.stringify(process.env.NAME ?? '.')});
  const groups = new Map();
  for (const top of scene.children) {
    if (!top.name || !top.name.startsWith('server_') || !re.test(top.name)) continue;
    const key = top.name.replace(/^server_[0-9a-f]+_/, '');
    const meshes = []; top.traverse((o) => { if (o.isMesh && o.visible) meshes.push(o); });
    let g = groups.get(key); if (!g) { g = []; groups.set(key, g); } g.push(meshes);
  }
  const out = [];
  const diffFields = (a, b) => { const f = []; for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { if (k === 'uuid' || k === 'id') continue; const x = a[k], y = b[k]; if (x !== y && JSON.stringify(x) !== JSON.stringify(y)) f.push(k + (k === 'userData' ? ':' + Object.keys(x || {}).concat(Object.keys(y || {})).filter((u, i, s) => s.indexOf(u) === i && JSON.stringify((x||{})[u]) !== JSON.stringify((y||{})[u])).join('/') : '')); } return f; };
  for (const [name, objs] of groups) {
    if (objs.length < 2) continue;
    const mats = new Set(), maps = new Set(); const why = {};
    const first = objs[0];
    for (const meshes of objs) meshes.forEach((m, i) => {
      const list = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of list) { mats.add(mat); if (mat.map) maps.add(mat.map); }
      if (meshes !== first && first[i] && !Array.isArray(m.material) && m.material !== first[i].material) {
        const a = { ...m.material, userData: m.material.userData }, b = { ...first[i].material, userData: first[i].material.userData };
        delete a._listeners; delete b._listeners;
        for (const f of diffFields(a, b)) why[f] = (why[f] || 0) + 1;
        why['sameMap:' + (m.material.map === first[i].material.map)] = (why['sameMap:' + (m.material.map === first[i].material.map)] || 0) + 1;
        why['sameType:' + (m.material.type === first[i].material.type)] = (why['sameType:' + (m.material.type === first[i].material.type)] || 0) + 1;
      }
    });
    out.push({ name, objects: objs.length, meshesEach: objs.map((m) => m.length), materials: mats.size, maps: maps.size, why });
  }
  return out.sort((a, b) => b.materials - a.materials).slice(0, 12);
})()`);
console.log(JSON.stringify(r, null, 1));
await browser.close();
