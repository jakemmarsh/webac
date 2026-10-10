/**
 * PERF.3 — scene composition probe: meshes by named-ancestor bucket, split by
 * effective visibility (self+ancestors visible, material.visible). Run parked
 * (no telepoi) to measure wherever the persistent character stands; found the
 * dungeon-parking bloat (108,887 meshes / 18,407 envcell groups, 2026-09-07).
 */
import { chromium, type Page } from 'playwright';
import { existsSync } from 'node:fs';

const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=sbprobe';

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(`(() => {
    const dbg = window.acDebug; const cs = dbg && dbg.collisionState && dbg.collisionState();
    return !!(cs && cs.x > 0);
  })()`) as Promise<boolean>;
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1568, height: 775 } });
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
  await page.waitForTimeout(20_000);
  const out = await page.evaluate(`(() => {
    const sm = window.__ac.sceneManager;
    const cs = window.acDebug.collisionState();
    const buckets = {};
    sm.scene.traverse((o) => {
      if (!o.isMesh) return;
      let n = o; while (n && !n.name) n = n.parent;
      const nm = ((n && n.name) || '?').replace(/[0-9a-fx]{6,}/g, '#').replace(/part_\\d+/, 'part');
      let effVisible = true; let a = o;
      while (a) { if (!a.visible) { effVisible = false; break; } a = a.parent; }
      const mat = Array.isArray(o.material) ? o.material[0] : o.material;
      const matVisible = !!(mat && mat.visible !== false);
      const b = buckets[nm] || (buckets[nm] = { total: 0, effVis: 0, drawable: 0 });
      b.total++;
      if (effVisible) b.effVis++;
      if (effVisible && matVisible) b.drawable++;
    });
    let total = 0; for (const k in buckets) total += buckets[k].total;
    return { collisionState: cs, total, buckets };
  })()`) as { collisionState: unknown; total: number; buckets: Record<string, { total: number; effVis: number; drawable: number }> };
  console.log('collisionState:', JSON.stringify(out.collisionState));
  console.log(`total meshes: ${out.total}`);
  const rows = Object.entries(out.buckets).sort((a, b) => b[1].total - a[1].total).slice(0, 25);
  console.log('bucket'.padEnd(28), 'total  effVis  drawable');
  for (const [k, v] of rows) {
    console.log(k.padEnd(28), String(v.total).padStart(5), String(v.effVis).padStart(7), String(v.drawable).padStart(8));
  }
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
