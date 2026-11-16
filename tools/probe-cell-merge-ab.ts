/**
 * probe-cell-merge-ab — in-session A/B for PERF.cell-surface-merge (2026-11-16,
 * docs/perf-pass-2026-11-15.md): each EnvCell's per-surface meshes (one Mesh +
 * BufferGeometry per surface, each wrapping the cell's vertex arrays in its own
 * BufferAttributes) against ONE mesh per cell (per renderOrder band) whose
 * geometry carries a group per surface, the same material objects in the same
 * order, and the shared vertex attributes.
 *
 * The probe builds whichever structure the build does not ship, in the page,
 * from the live meshes, and swaps them in the cell groups' child lists (the
 * other structure is detached, not hidden, so neither side pays for the other's
 * nodes). Same material objects ⇒ the same opaque sort keys (three sorts by
 * material.id), so the frames must match exactly.
 *   1. same-frame pixel A/B at YAWS headings (render A, read, swap, render B, read, swap back,
 *      render A again: the repeat must also match, or the scene is not still);
 *   2. CPU-throttled speed A/B: the two structures alternate every SLICE_MS while the character
 *      circles (W+D), frameStep / renderer.render / rAF frame time kept per structure.
 * Usage (env): AC_URL as tools/lib/game-session.ts; TELE (default: the Holtburg academy hall,
 *   '' = stay where the character logs in); THROTTLE=10; ROUNDS=6; SLICE_MS=5000; YAWS='0,90,180,270';
 *   SPEED=0 to skip the speed A/B; TAG names the output file.
 *   npx tsx tools/probe-cell-merge-ab.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO, adminCommand, enterWorld } from './lib/game-session.ts';
import { pixelAB, speedAB } from './lib/inline-ab.ts';

const TELE = process.env.TELE ?? '@teleloc 0x8602023A [60 -20 0.005] 1 0 0 0';
const THROTTLE = Number(process.env.THROTTLE ?? 10);
const ROUNDS = Number(process.env.ROUNDS ?? 6);
const SLICE_MS = Number(process.env.SLICE_MS ?? 5000);
const YAWS = (process.env.YAWS ?? '0,90,180,270').split(',').map(Number);
const SPEED = process.env.SPEED !== '0';
const TAG = process.env.TAG ?? 'academy';
const { browser, page } = await enterWorld({ gpu: true, timeoutMs: 420000 });
if (TELE) await adminCommand(page, TELE);
await page.waitForTimeout(Number(process.env.SETTLE_MS ?? 30000));
await page.mouse.click(780, 250);

/** Page side: build the other structure for every live cell and install window.__setMerged(bool). */
const SETUP_JS = `(() => {
  const sm = window.__ac.sceneManager; const scene = sm.scene;
  const cells = []; let sample = null;
  scene.traverse((o) => { if (o.userData.envCellId !== undefined && o.name && o.name.startsWith('envcell_')) cells.push(o); if (!sample && o.isMesh && o.userData.cellGeometry) sample = o; });
  // The page's own three.js classes (no THREE global): taken off a live cell mesh.
  const THREE_ = { Mesh: sample.constructor, BufferGeometry: sample.geometry.constructor, BufferAttribute: sample.geometry.index.constructor };
  let shipsMerged = false; let perSurface = 0; let merged = 0; let groups = 0;
  const swaps = [];
  for (const cell of cells) {
    const geo = cell.children.filter((c) => c.isMesh && c.userData.cellGeometry);
    if (geo.length === 0) continue;
    if (geo.some((m) => Array.isArray(m.material))) {
      // The build ships merged meshes: split each back into the per-surface meshes the old code made.
      shipsMerged = true;
      const split = [];
      for (const m of geo) {
        merged++;
        for (const g of m.geometry.groups) {
          groups++;
          const bg = new THREE_.BufferGeometry();
          for (const name of ['position', 'normal', 'uv']) { const a = m.geometry.getAttribute(name); bg.setAttribute(name, new THREE_.BufferAttribute(a.array, a.itemSize)); }
          const idx = m.geometry.index.array.slice(g.start, g.start + g.count);
          bg.setIndex(new THREE_.BufferAttribute(idx, 1));
          const mesh = new THREE_.Mesh(bg, m.material[g.materialIndex]);
          mesh.renderOrder = m.renderOrder; mesh.userData.cellGeometry = true;
          mesh.matrix.copy(m.matrix); mesh.matrixWorld.copy(m.matrixWorld);
          mesh.matrixAutoUpdate = false; mesh.matrixWorldAutoUpdate = false;
          split.push(mesh); perSurface++;
        }
      }
      swaps.push({ cell, merged: geo, perSurface: split });
    } else {
      // The build ships per-surface meshes: merge them (one mesh per renderOrder band, groups in child order).
      const bands = new Map();
      for (const m of geo) { let b = bands.get(m.renderOrder); if (!b) { b = []; bands.set(m.renderOrder, b); } b.push(m); perSurface++; }
      const out = [];
      for (const [order, list] of bands) {
        const total = list.reduce((n, m) => n + m.geometry.index.count, 0);
        const idx = new Uint16Array(total); const bg = new THREE_.BufferGeometry(); let at = 0;
        for (const name of ['position', 'normal', 'uv']) bg.setAttribute(name, list[0].geometry.getAttribute(name));
        list.forEach((m, i) => { idx.set(m.geometry.index.array, at); bg.addGroup(at, m.geometry.index.count, i); at += m.geometry.index.count; groups++; });
        bg.setIndex(new THREE_.BufferAttribute(idx, 1));
        const mesh = new THREE_.Mesh(bg, list.map((m) => m.material));
        mesh.renderOrder = order; mesh.userData.cellGeometry = true;
        mesh.matrix.copy(list[0].matrix); mesh.matrixWorld.copy(list[0].matrixWorld);
        mesh.matrixAutoUpdate = false; mesh.matrixWorldAutoUpdate = false;
        out.push(mesh); merged++;
      }
      swaps.push({ cell, merged: out, perSurface: geo });
    }
  }
  let state = shipsMerged;
  const install = (cell, from, to) => {
    const kids = cell.children; const at = kids.indexOf(from[0]);
    const keep = kids.filter((c) => !from.includes(c));
    keep.splice(at < 0 ? keep.length : Math.min(at, keep.length), 0, ...to);
    kids.length = 0; for (const c of keep) kids.push(c);
    for (const c of from) c.parent = null; for (const c of to) c.parent = cell;
  };
  window.__setMerged = (wantMerged) => {
    if (wantMerged === state) return;
    for (const s of swaps) install(s.cell, wantMerged ? s.perSurface : s.merged, wantMerged ? s.merged : s.perSurface);
    state = wantMerged;
  };
  window.__shipsMerged = shipsMerged;
  return { cells: cells.length, swapped: swaps.length, perSurfaceMeshes: perSurface, mergedMeshes: merged, groups, shipsMerged };
})()`;
const setup = await page.evaluate(SETUP_JS);
console.log('SETUP', JSON.stringify(setup));

await page.evaluate('window.__abSet = (b) => window.__setMerged(b)');
const pixels = await pixelAB(page, YAWS);
await page.evaluate('window.__setMerged(window.__shipsMerged)');
const speed = SPEED ? await speedAB(page, { throttle: THROTTLE, rounds: ROUNDS, sliceMs: SLICE_MS, labels: ['perSurface', 'merged'] }) : null;
if (speed) console.log('SPEED', JSON.stringify(speed, null, 1));
await page.evaluate('window.__setMerged(window.__shipsMerged)');
await browser.close();
mkdirSync(resolve(REPO, 'verification/perf'), { recursive: true });
const file = resolve(REPO, `verification/perf/cell-merge-ab-${new Date().toISOString().replace(/[:.]/g, '-')}-${TAG}.json`);
writeFileSync(file, JSON.stringify({ tele: TELE, throttle: THROTTLE, rounds: ROUNDS, sliceMs: SLICE_MS, setup, pixels, speed }, null, 1) + '\n');
console.log('wrote', file);
