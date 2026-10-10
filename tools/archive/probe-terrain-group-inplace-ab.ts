/**
 * PERF.1 same-session A/B — covenant proof for terrain group merging that
 * dodges cross-session weather/sky variance. In one live session:
 *   A) screenshot with merged groups (current code),
 *   B) split every terrain mesh's groups back into per-cell 6-index groups
 *      IN PLACE (identical indices + materials — exactly the pre-change draw
 *      list), screenshot again,
 *   C) restore merged groups.
 * Any non-sky difference between A and B would be a regression; draw-call
 * counts confirm the delta comes from grouping alone.
 */
import { chromium, type Page } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';

const OUT = 'verification/perf1-terrain-groups';
mkdirSync(OUT, { recursive: true });
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=ipab' + Date.now();

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(`(() => {
    const dbg = window.acDebug; const cs = dbg && dbg.collisionState && dbg.collisionState();
    return !!(cs && cs.x > 0);
  })()`) as Promise<boolean>;
}

async function drawCalls(page: Page): Promise<number> {
  return page.evaluate(`(() => new Promise(res => {
    requestAnimationFrame(() => requestAnimationFrame(() =>
      res(window.__ac.sceneManager.renderer.info.render.calls)));
  }))()`) as Promise<number>;
}

/** Median JS-side renderer.render() ms over n frames (same patch as measure-perf). */
async function renderJsP50(page: Page, n: number): Promise<number> {
  return page.evaluate(`(() => new Promise(res => {
    const r = window.__ac.sceneManager.renderer;
    if (!r.__perfPatched) {
      const orig = r.render.bind(r);
      window.__perfRenderMs = [];
      r.render = function (a, b) { const t = performance.now(); const out = orig(a, b); window.__perfRenderMs.push(performance.now() - t); return out; };
      r.__perfPatched = true;
    }
    window.__perfRenderMs = [];
    const tick = () => {
      if ((window.__perfRenderMs || []).length >= ${n}) {
        const s = [...window.__perfRenderMs].sort((a, b) => a - b);
        res(Math.round(s[Math.floor(s.length / 2)] * 10) / 10);
      } else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }))()`) as Promise<number>;
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(120000);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + 300_000;
  let lastReload = Date.now();
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (Date.now() - lastReload > 60_000) {
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* retry */ }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) { await browser.close(); throw new Error('never entered world'); }
  await page.waitForTimeout(5_000);
  await page.evaluate(`window.acDebug.admin('@telepoi holtburg')`);
  await page.waitForTimeout(25_000);
  let lastMeshes = -1;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(6000);
    const meshes = await page.evaluate(`(() => { let m = 0; window.__ac.sceneManager.scene.traverse(o => { if (o.isMesh) m++; }); return m; })()`) as number;
    if (meshes === lastMeshes) break;
    lastMeshes = meshes;
  }
  await page.evaluate(`window.__ac.skybox.setWeatherEnabled(false)`);
  await page.evaluate(`window.acDebug.setTimeOfDay(0.5)`);
  await page.evaluate(`window.acDebug.setPlayerYaw(2.4)`);
  await page.waitForTimeout(5_000);

  const canvas = page.locator('canvas').first();

  // A: merged (current code) — captured twice to establish the null
  // (same-state) frame-to-frame variance: sky scroll + lighting drift.
  const callsMerged = await drawCalls(page);
  await canvas.screenshot({ path: `${OUT}/inplace-merged.png` });
  await drawCalls(page); // let ~2 frames pass, same cadence as the A→B gap
  await canvas.screenshot({ path: `${OUT}/inplace-merged-again.png` });

  // B: split back to per-cell groups in place
  const split = await page.evaluate(`(() => {
    const sm = window.__ac.sceneManager; let n = 0;
    sm.scene.traverse((o) => {
      if (!o.isMesh || !Array.isArray(o.material)) return;
      const idx = o.geometry.getIndex();
      if (!idx || idx.count !== 384 || !o.geometry.groups.length) return;
      o.userData.__savedGroups = o.geometry.groups.map(g => ({ start: g.start, count: g.count, materialIndex: g.materialIndex }));
      const per = [];
      for (const g of o.geometry.groups) {
        for (let s = g.start; s < g.start + g.count; s += 6) per.push({ start: s, count: 6, materialIndex: g.materialIndex });
      }
      o.geometry.groups = per; n++;
    });
    return n;
  })()`) as number;
  const callsSplit = await drawCalls(page);
  await canvas.screenshot({ path: `${OUT}/inplace-percell.png` });

  // C: restore
  const restored = await page.evaluate(`(() => {
    const sm = window.__ac.sceneManager; let n = 0;
    sm.scene.traverse((o) => {
      if (o.isMesh && o.userData.__savedGroups) { o.geometry.groups = o.userData.__savedGroups; delete o.userData.__savedGroups; n++; }
    });
    return n;
  })()`) as number;
  const callsRestored = await drawCalls(page);

  console.log(JSON.stringify({ terrainMeshesSplit: split, restored, callsMerged, callsSplit, callsRestored }));

  // Interleaved renderJs A/B (merged vs per-cell split), 4 blocks each, to
  // isolate the grouping's JS submission cost from run-to-run CPU jitter.
  const setSplit = async (on: boolean) => page.evaluate(`(() => {
    const sm = window.__ac.sceneManager;
    sm.scene.traverse((o) => {
      if (!o.isMesh || !Array.isArray(o.material)) return;
      const idx = o.geometry.getIndex();
      if (!idx || idx.count !== 384 || !o.geometry.groups.length) return;
      if (${on}) {
        if (o.userData.__savedGroups) return;
        o.userData.__savedGroups = o.geometry.groups.map(g => ({ start: g.start, count: g.count, materialIndex: g.materialIndex }));
        const per = [];
        for (const g of o.geometry.groups) {
          for (let s = g.start; s < g.start + g.count; s += 6) per.push({ start: s, count: 6, materialIndex: g.materialIndex });
        }
        o.geometry.groups = per;
      } else if (o.userData.__savedGroups) {
        o.geometry.groups = o.userData.__savedGroups; delete o.userData.__savedGroups;
      }
    });
  })()`);
  const mergedMs: number[] = [];
  const splitMs: number[] = [];
  for (let block = 0; block < 8; block++) {
    const splitOn = block % 2 === 1;
    await setSplit(splitOn);
    const p50 = await renderJsP50(page, 5);
    (splitOn ? splitMs : mergedMs).push(p50);
  }
  await setSplit(false);
  console.log(JSON.stringify({ renderJsP50Blocks: { merged: mergedMs, percell: splitMs } }));
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
