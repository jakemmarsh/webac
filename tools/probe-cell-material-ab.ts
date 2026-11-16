/**
 * probe-cell-material-ab — live checks for PERF.shared-cell-materials (REJECTED and reverted:
 * run it on a checkout of 67db6ac9a; on later code both sides are per-cell clones)
 * (2026-11-15, docs/perf-pass-2026-11-15.md): EnvCellRenderer's cell-geometry
 * meshes share one material per surface instead of a clone per cell.
 * In one session on the real GPU, inside a dungeon / building interior:
 *   1. same-frame pixel A/B at four headings: render, read pixels, swap every
 *      cell mesh to the per-cell clone the old code made (rebuilt exactly:
 *      MaterialFactory base → clone → applyRetailLighting('envcell') → the
 *      three writes), render again in the same task, compare;
 *   2. CPU-throttled speed A/B in the same session: the two material sets
 *      alternate every SLICE_MS while the character runs in a circle, and
 *      frameStep / renderer.render time are kept per set (interleaved, so
 *      position, objects and lights are the same for both).
 * Needs the Vite dev server (it imports /src/models/RetailLighting.ts).
 * Usage (env): AC_URL as tools/lib/game-session.ts; TELE='@teleloc 0x8602023A [60 -20 0.005] 1 0 0 0'
 *   (the default: the Holtburg academy hall); THROTTLE=10; ROUNDS=6; SLICE_MS=5000.
 *   npx tsx tools/probe-cell-material-ab.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO, adminCommand, enterWorld } from './lib/game-session.ts';

const TELE = process.env.TELE ?? '@teleloc 0x8602023A [60 -20 0.005] 1 0 0 0';
const THROTTLE = Number(process.env.THROTTLE ?? 10);
const ROUNDS = Number(process.env.ROUNDS ?? 6);
const SLICE_MS = Number(process.env.SLICE_MS ?? 5000);
const { browser, page } = await enterWorld({ gpu: true, timeoutMs: 420000 });
if (TELE) await adminCommand(page, TELE);
await page.waitForTimeout(30000);
await page.mouse.click(780, 250);

const setup = await page.evaluate(`(async () => {
  const RL = await import('/src/models/RetailLighting.ts');
  const ac = window.__ac; const mf = ac.materialFactory; const ecr = ac.envCellRenderer; const scene = ac.sceneManager.scene;
  const pairs = []; const unmatched = []; const oldBySharedSide = new Map();
  scene.traverse((o) => {
    if (!o.isMesh || !o.userData.cellGeometry) return;
    const shared = o.material; const cellId = o.parent && o.parent.userData.envCellId;
    const env = cellId != null ? ecr.loadEnvCell(cellId >>> 0) : null;
    let base = null;
    if (env) for (const sid of env.surfaces) { for (const clamp of [false, true]) { const b = mf.getMaterial(sid, undefined, undefined, undefined, false, clamp); if (b.map === shared.map) { base = b; break; } } if (base) break; }
    if (!base) { unmatched.push(cellId); return; }
    // The old code: a clone per cell mesh.
    const old = RL.applyRetailLighting(base.clone(), 'envcell', 'environment');
    if (old.isMeshLambertMaterial) { old.emissive.setScalar(0); delete old.userData[RL.SURFACE_LUMINOSITY_KEY]; }
    old.side = shared.side;
    pairs.push({ mesh: o, shared, old });
  });
  window.__cellPairs = pairs;
  window.__setCellMode = (perCell) => { for (const p of pairs) p.mesh.material = perCell ? p.old : p.shared; };
  return { meshes: pairs.length, sharedMaterials: new Set(pairs.map((p) => p.shared)).size, unmatched: unmatched.length };
})()`);
console.log('SETUP', JSON.stringify(setup));

const pixels: unknown[] = [];
for (const yaw of [0, 90, 180, 270]) {
  await page.evaluate(`window.acDebug.setPlayerYaw(${yaw * Math.PI / 180})`); await page.waitForTimeout(2500);
  const r = await page.evaluate(`(() => {
    const sm = window.__ac.sceneManager; const gl = sm.renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const grab = () => { sm.render(); const px = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
    // Warm both sets' programs first (a first draw may compile).
    window.__setCellMode(true); sm.render(); window.__setCellMode(false); sm.render();
    const a = grab(); window.__setCellMode(true); const b = grab(); window.__setCellMode(false); const c = grab();
    let diff = 0, maxD = 0, nonBlack = 0, repeat = 0;
    for (let i = 0; i < a.length; i += 4) { let d = 0; for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(a[i+k] - b[i+k])); if (d) { diff++; maxD = Math.max(maxD, d); }
      if (a[i] + a[i+1] + a[i+2] > 30) nonBlack++; if (a[i] !== c[i] || a[i+1] !== c[i+1] || a[i+2] !== c[i+2]) repeat++; }
    return { px: w * h, nonBlackPct: +(100 * nonBlack / (w * h)).toFixed(1), diff, maxD, sameModeRepeatDiff: repeat, calls: sm.renderer.info.render.calls };
  })()`);
  console.log('PX', yaw, JSON.stringify(r));
  pixels.push({ yaw, ...(r as object) });
}

// Speed: interleaved slices of shared / per-cell while circling.
await page.evaluate(`(() => {
  const ac = window.__ac; const r = ac.sceneManager.renderer; const fp = ac.framePhases;
  window.__mode = 'shared'; window.__ab = { shared: { work: [], render: [], frames: [] }, perCell: { work: [], render: [], frames: [] } };
  let lastFp = -1, last = -1;
  const ro = r.render; r.render = function (a, b) { const t = performance.now(); const o = ro.call(this, a, b); if (a === ac.sceneManager.scene) window.__ab[window.__mode].render.push(performance.now() - t); return o; };
  requestAnimationFrame(function tick(t) {
    if (last >= 0) window.__ab[window.__mode].frames.push(t - last); last = t;
    if (fp.frames !== lastFp) { if (lastFp >= 0) { let w = 0; for (const v of fp.frameMs) w += v; window.__ab[window.__mode].work.push(w); } lastFp = fp.frames; }
    requestAnimationFrame(tick); });
})()`);
const cdp = await page.context().newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
await page.keyboard.down('KeyW'); await page.keyboard.down('KeyD');
for (let i = 0; i < ROUNDS * 2; i++) {
  const perCell = i % 2 === 1;
  await page.evaluate(`window.__setCellMode(${perCell}); window.__mode = ${JSON.stringify(perCell ? 'perCell' : 'shared')}; window.__drop = 2`);
  await page.waitForTimeout(SLICE_MS);
}
await page.keyboard.up('KeyD'); await page.keyboard.up('KeyW');
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
await page.evaluate('window.__setCellMode(false)');
const ab = await page.evaluate('window.__ab') as Record<string, { work: number[]; render: number[]; frames: number[] }>;
await browser.close();
const st = (v: number[]) => { const s = [...v].sort((a, b) => a - b); const m = v.reduce((a, b) => a + b, 0) / Math.max(1, v.length); return { n: v.length, mean: +m.toFixed(2), p50: +(s[Math.floor(s.length / 2)] ?? 0).toFixed(2), p95: +(s[Math.floor(s.length * 0.95)] ?? 0).toFixed(2), over50: v.filter((x) => x > 50).length }; };
const speed = Object.fromEntries(Object.entries(ab).map(([k, v]) => [k, { frameStep: st(v.work), render: st(v.render), frame: st(v.frames) }]));
console.log('SPEED', JSON.stringify(speed, null, 1));
mkdirSync(resolve(REPO, 'verification/perf'), { recursive: true });
const file = resolve(REPO, `verification/perf/cell-material-ab-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(file, JSON.stringify({ tele: TELE, throttle: THROTTLE, rounds: ROUNDS, sliceMs: SLICE_MS, setup, pixels, speed }, null, 1) + '\n');
console.log('wrote', file);
