/**
 * PERF.1 — per-bucket DRAW CALL attribution. The scene census counts meshes;
 * this counts actual draw calls by patching renderBufferDirect for a few
 * frames at parked Holtburg (same reset as measure-perf: @telepoi + yaw),
 * bucketing each call by the drawn object's nearest named ancestor.
 */
import { chromium, type Page } from 'playwright';
import { existsSync } from 'node:fs';

const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=dcprobe';

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
  await page.waitForTimeout(10_000);
  await page.evaluate(`window.acDebug.admin('@telepoi holtburg')`);
  await page.waitForTimeout(15_000);
  await page.evaluate(`window.acDebug.setTimeOfDay(0.5)`);
  // Let landblock/scenery streaming settle: wait until scene mesh count is stable.
  let lastMeshes = -1;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(6000);
    const meshes = await page.evaluate(`(() => { let m = 0; window.__ac.sceneManager.scene.traverse(o => { if (o.isMesh) m++; }); return m; })()`) as number;
    console.log(`settle: ${meshes} meshes`);
    if (meshes === lastMeshes) break;
    lastMeshes = meshes;
  }

  for (const yawName of ['yaw0', 'town']) {
    const yaw = yawName === 'yaw0' ? 0 : (4 * Math.PI) / 3;
    await page.evaluate(`window.acDebug.setPlayerYaw(${yaw})`);
    await page.waitForTimeout(2000);
    const result = await page.evaluate(`(() => {
      const sm = window.__ac.sceneManager;
      const r = sm.renderer;
      const buckets = {};
      const orig = r.renderBufferDirect.bind(r);
      let frames = 0;
      r.renderBufferDirect = function (camera, scene, geometry, material, object, group) {
        let n = object; while (n && !n.name) n = n.parent;
        const nm = ((n && n.name) || '?').replace(/[0-9a-fx]{6,}/g, '#').replace(/part_\\d+/, 'part');
        buckets[nm] = (buckets[nm] || 0) + 1;
        return orig(camera, scene, geometry, material, object, group);
      };
      const infoStart = r.info.render.calls;
      let infoFrames = [];
      return new Promise(res => {
        const finish = () => {
          r.renderBufferDirect = orig;
          const total = Object.values(buckets).reduce((a, b) => a + b, 0);
          res({ frames, total, perFrame: Math.round(total / frames), buckets, infoCalls: infoFrames });
        };
        const tick = () => { frames++; infoFrames.push(r.info.render.calls); if (frames >= 3) requestAnimationFrame(() => finish()); else requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
      });
    })()`) as { frames: number; total: number; perFrame: number; buckets: Record<string, number>; infoCalls: number[] };
    console.log(`renderer.info.render.calls at frame boundaries: ${result.infoCalls.join(', ')}`);
    const per = Object.entries(result.buckets)
      .map(([k, v]) => [k, Math.round((v as number) / result.frames)] as [string, number])
      .sort((a, b) => b[1] - a[1]);
    console.log(`\n=== ${yawName} (yaw=${yaw.toFixed(2)}) — ${result.perFrame} draw calls/frame over ${result.frames} frames ===`);
    for (const [k, v] of per) if (v > 0) console.log(`${String(v).padStart(6)}  ${k}`);
  }
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
