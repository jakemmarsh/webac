/**
 * CORE.14.c A/B evidence capture — parks at Holtburg with a fixed camera yaw,
 * screenshots the 3D scene, and dumps renderer.info + a scene census of
 * road/blend overlay meshes. Run once per build (pre-merge via git stash,
 * post-merge with the working tree) and diff the outputs: the covenant
 * requires pixel-identical frames with fewer draw calls.
 *
 * Usage: npx tsx tools/capture-overlay-merge-ab.ts <label>
 */
import { chromium, type Page } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';

const label = process.argv[2] || 'run';
const OUT = 'verification/core14c';
mkdirSync(OUT, { recursive: true });

const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=ab' + Date.now();

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
  // Fixed camera: face the Holtburg road (yaw chosen to include road + blend
  // overlays in frame), then let streaming/settling finish.
  await page.evaluate(`window.acDebug.setPlayerYaw(2.4)`);
  await page.waitForTimeout(15_000);
  // Pin time of day so A/B frames are lighting-identical (sky + lambert tint)
  await page.evaluate(`window.acDebug.freezeTimeOfDay(0.5)`);
  await page.waitForTimeout(5_000);
  await page.evaluate(`window.acDebug.freezeTimeOfDay(0.5)`);
  await page.waitForTimeout(2_000);

  const stats = await page.evaluate(`(() => {
    const sm = window.__ac.sceneManager;
    const info = sm.renderer.info;
    let overlayMeshes = 0, overlayMerged = 0, overlayQuadVerts = 0;
    sm.scene.traverse((o) => {
      if (!o.isMesh) return;
      const mat = Array.isArray(o.material) ? o.material[0] : o.material;
      if (o.name === 'roadmerge' || o.name === 'blendmerge') {
        overlayMerged++;
        overlayQuadVerts += o.geometry.getAttribute('position').count;
      } else if (mat && mat.polygonOffset && (mat.polygonOffsetFactor === -1 || mat.polygonOffsetFactor === -2)
                 && o.geometry && o.geometry.getAttribute('position')
                 && o.geometry.getAttribute('position').count === 4) {
        overlayMeshes++; // pre-merge per-cell quad signature
      }
    });
    const cs = window.acDebug.collisionState();
    return {
      loc: { x: cs.x, y: cs.y },
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs.length,
      perQuadOverlayMeshes: overlayMeshes,
      mergedOverlayMeshes: overlayMerged,
      mergedOverlayVerts: overlayQuadVerts,
    };
  })()`);
  writeFileSync(`${OUT}/stats-${label}.json`, JSON.stringify(stats, null, 2));
  console.log(`[${label}]`, JSON.stringify(stats));

  const canvas = page.locator('canvas').first();
  await canvas.screenshot({ path: `${OUT}/holtburg-${label}.png` });
  console.log(`[${label}] screenshot: ${OUT}/holtburg-${label}.png`);
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
