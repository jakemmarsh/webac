/**
 * PERF.1 terrain-group A/B evidence capture — parks at Holtburg, pins time of
 * day, screenshots the 3D scene at 3 fixed yaws, and dumps renderer.info +
 * terrain-mesh group counts. Run once pre-change (git stash) and once
 * post-change: the covenant requires identical frames with fewer draw calls.
 *
 * Usage: npx tsx tools/capture-terrain-group-ab.ts <label>
 */
import { chromium, type Page } from 'playwright';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

const label = process.argv[2] || 'run';
const OUT = 'verification/perf1-terrain-groups';
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
  // Let streaming settle so the loaded landblock set is complete + stable.
  let lastMeshes = -1;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(6000);
    const meshes = await page.evaluate(`(() => { let m = 0; window.__ac.sceneManager.scene.traverse(o => { if (o.isMesh) m++; }); return m; })()`) as number;
    if (meshes === lastMeshes) break;
    lastMeshes = meshes;
  }
  // Pin time of day + kill weather so A/B frames are lighting-identical.
  // MUST be freezeTimeOfDay, not setTimeOfDay: the latter is overwritten by
  // the world clock within ~1s, so this "pin" silently did nothing before
  // 2026-09-07 (tools/probe-timeofday-pin.ts).
  // (weather rerolls per session: snow streaks + cloud state differ otherwise)
  await page.evaluate(`window.__ac.skybox.setWeatherEnabled(false)`);
  await page.evaluate(`window.acDebug.freezeTimeOfDay(0.5)`);
  await page.waitForTimeout(5_000);
  await page.evaluate(`window.acDebug.freezeTimeOfDay(0.5)`);
  await page.waitForTimeout(2_000);

  const yaws: [string, number][] = [['yaw0', 0], ['yaw1', 2.4], ['yaw2', 4.19]];
  const allStats: Record<string, unknown> = {};
  for (const [name, yaw] of yaws) {
    await page.evaluate(`window.acDebug.setPlayerYaw(${yaw})`);
    await page.waitForTimeout(3_000);
    const stats = await page.evaluate(`(() => {
      const sm = window.__ac.sceneManager;
      const info = sm.renderer.info;
      let terrainMeshes = 0, terrainGroups = 0;
      sm.scene.traverse((o) => {
        if (!o.isMesh || !Array.isArray(o.material)) return;
        // terrain landblock meshes are the only multi-material meshes at top level
        if (o.geometry && o.geometry.groups && o.geometry.getIndex()
            && o.geometry.getIndex().count === 384) {
          terrainMeshes++;
          terrainGroups += o.geometry.groups.length;
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
        terrainMeshes,
        terrainGroups,
      };
    })()`);
    allStats[name] = stats;
    console.log(`[${label} ${name}]`, JSON.stringify(stats));
    const canvas = page.locator('canvas').first();
    await canvas.screenshot({ path: `${OUT}/${label}-${name}.png` });
  }
  writeFileSync(`${OUT}/stats-${label}.json`, JSON.stringify(allStats, null, 2));
  console.log(`[${label}] done -> ${OUT}`);
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
