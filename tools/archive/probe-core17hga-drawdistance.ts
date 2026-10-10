/**
 * CORE.17.h.g.a live probe — Landscape Draw Distance A/B at Holtburg.
 *
 * Logs in (ACE mode), parks at the POI (noon pinned, weather off, yaw 0 and
 * 2.4), then captures the SAME whole-screen frame at the fresh-profile
 * radius (shipped 3, retail "Very Low" — the old fixed radius), at retail's
 * default "Medium" (8) and at "High" (11) — the last two driven through the
 * real GameUI options path (optionsSettings + applyOptionsBulk →
 * __ac.setLandscapeDrawDistance), not the bridge directly, so the menu →
 * world wiring is what gets exercised.
 * Records the live radius, streamed terrain block count and renderer.info per
 * state, and composes the side-by-sides against the retail references.
 *
 * Env: HGA_POI=<telepoi name> (default holtburg), HGA_CAMERA_DISTANCE=<m> (raised
 * follow camera for an open vista). Output (prefixed `<poi>-` off Holtburg):
 *         verification/core17hga/{after8,before3,high11}-yaw{0,2.4}.png,
 *         core17hga-samples.json, core17hga-town-sidebyside.png,
 *         core17hga-radius-sidebyside.png
 */
import { chromium, type Page } from 'playwright';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=probe-hga';
const POI = process.env.HGA_POI ?? 'holtburg';           // @telepoi target
const CAM = Number(process.env.HGA_CAMERA_DISTANCE ?? '0'); // 0 = leave the default follow distance
const PREFIX = POI === 'holtburg' ? '' : `${POI}-`;
const OUT = 'verification/core17hga';
const REF_TOWN = 'reference/images/hud/rawg_07.jpg';
const REF_FAR = 'reference/images/hud/shoushi-live.jpg';
const CHROME = existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {};

async function inWorld(page: Page) {
  return page.evaluate(() => { const cs = (window as any).acDebug?.collisionState?.(); return !!(cs && cs.x > 0); });
}

async function stats(page: Page) {
  return page.evaluate(`(() => { const ac = window.__ac; const r = ac.sceneManager.renderer;
    return { radius: ac.landscapeDrawDistance, terrainRadius: ac.terrainManager.getLoadRadius(),
      terrainBlocks: ac.terrainManager.getLoadedMeshes().size, terrainMeshes: ac.terrainRenderer.meshCount,
      drawCalls: r.info.render.calls, triangles: r.info.render.triangles, geometries: r.info.memory.geometries,
      pref: ac.gameUI.optionsSettings.landscapeDrawDistance }; })()`) as Promise<Record<string, number>>;
}

/** Drive the radius through the real options path (menu value → consumer). */
async function setViaOptions(page: Page, blocks: number) {
  await page.evaluate((b) => {
    const ui = (window as any).__ac.gameUI;
    ui.optionsSettings.landscapeDrawDistance = b;
    ui.applyOptionsBulk({});
  }, blocks);
}

function dataUrl(file: string): string {
  const ext = file.endsWith('.jpg') ? 'jpeg' : 'png';
  return `data:image/${ext};base64,${readFileSync(file).toString('base64')}`;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'], ...CHROME });
  const page = await browser.newPage({ viewport: { width: 1568, height: 775 } });
  page.setDefaultTimeout(120000); page.on('dialog', (d) => void d.dismiss());
  const t0 = Date.now();
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + 480_000; let lastReload = Date.now();
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (Date.now() - lastReload > 90_000) { await page.reload({ waitUntil: 'domcontentloaded' }); lastReload = Date.now(); }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) throw new Error('never entered world');
  console.log(`[hga] in world after ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  await page.waitForTimeout(6000);
  await page.evaluate((cmd) => (window as any).acDebug?.admin?.(cmd), `@telepoi ${POI}`);
  await page.waitForTimeout(5000);
  await page.evaluate(() => (window as any).__ac?.skybox?.setWeatherEnabled?.(false));
  await page.evaluate((t) => (window as any).acDebug?.freezeTimeOfDay?.(t), 0.5);
  if (CAM > 0) await page.evaluate((d) => { const c = (window as any).__ac?.cameraController; if (c) c.cameraDistance = d; }, CAM);

  const samples: Record<string, Record<string, number>> = {};
  // Fresh profile first (the shipped radius, whatever LandscapeDrawDistance.ts
  // says today), then retail's Medium 8 and High 11 through the options path.
  const states: Array<[string, number | null]> = [['before3', null], ['after8', 8], ['high11', 11]];
  for (const [label, blocks] of states) {
    if (blocks !== null) {
      const t = Date.now();
      await setViaOptions(page, blocks);
      console.log(`[hga] options → ${blocks} applied in ${Date.now() - t} ms`);
      await page.waitForTimeout(8000);
    }
    for (const yaw of [0, 2.4]) {
      await page.evaluate((y) => (window as any).acDebug?.setPlayerYaw?.(y), yaw);
      await page.waitForTimeout(yaw === 0 ? 6000 : 4000);
      const file = join(OUT, `${PREFIX}${label}-yaw${yaw}.png`);
      await page.screenshot({ path: file });
      samples[`${label}-yaw${yaw}`] = await stats(page);
      console.log(`[hga] ${file} ${JSON.stringify(samples[`${label}-yaw${yaw}`])}`);
    }
  }
  // Back to the fresh-profile radius through the same path, unfreeze the clock.
  await setViaOptions(page, samples['before3-yaw0'].radius);
  await page.waitForTimeout(3000);
  samples.restored = await stats(page);
  await page.evaluate(() => (window as any).acDebug?.freezeTimeOfDay?.(null));
  writeFileSync(join(OUT, `${PREFIX}core17hga-samples.json`), JSON.stringify(samples, null, 1));

  // ── side-by-sides ──
  const css = `<style>
    body{margin:0;background:#1a1a1a;color:#eee;font:13px/1.3 monospace;padding:10px}
    .row{display:flex;gap:12px;align-items:flex-start}
    .cell{display:flex;flex-direction:column;gap:4px}
    .lbl{color:#ffd;max-width:780px;white-space:normal}
    img{display:block;width:780px;height:auto;border:1px solid #444}
    h1{font-size:14px;margin:0 0 8px} p{max-width:2400px;color:#ccc;margin:0 0 8px}
  </style>`;
  const composer = await browser.newPage({ viewport: { width: 2420, height: 1000 } });
  await composer.setContent(`${css}<h1>CORE.17.h.g.a — Landscape Draw Distance: retail | ours fresh profile (shipped 3 = "Very Low", was the fixed radius) | ours at retail's Medium 8 via the Config menu</h1>
    <p>Retail: Render.LandscapeDrawDistance → SmartBox::set_mid_radius → LScape::SetMidRadius (mid_width = 2R+1) → a 17×17 landblock grid at the default. ${POI}, noon pinned, weather off, yaw 0${CAM ? `, camera distance ${CAM}` : ''}. Headless SwiftShader — judge terrain extent/horizon, not shading.</p>
    <div class="row">
      <div class="cell"><div class="lbl">retail ${REF_TOWN} (town street, distant terrain + mountains under fog)</div><img src="${dataUrl(REF_TOWN)}"/></div>
      <div class="cell"><div class="lbl">ours FRESH PROFILE — radius 3 (7×7 = 49 blocks): ${JSON.stringify(samples['before3-yaw0'])}</div><img src="${dataUrl(join(OUT, `${PREFIX}before3-yaw0.png`))}"/></div>
      <div class="cell"><div class="lbl">ours MENU → Medium 8 (17×17 = 289 blocks): ${JSON.stringify(samples['after8-yaw0'])}</div><img src="${dataUrl(join(OUT, `${PREFIX}after8-yaw0.png`))}"/></div>
    </div>`);
  await composer.waitForTimeout(500);
  await composer.screenshot({ path: join(OUT, `${PREFIX}core17hga-town-sidebyside.png`), fullPage: true });

  await composer.setContent(`${css}<h1>CORE.17.h.g.a — the menu drives the world: Very Low (3) | Medium (8, default) | High (11), yaw 2.4, same frame</h1>
    <p>Each state set through GameUI.optionsSettings + applyOptionsBulk (the Config menu's path) → __ac.setLandscapeDrawDistance → TerrainManager.setLoadRadius + landblock-object window. Retail far-terrain reference: ${REF_FAR}.</p>
    <div class="row">
      <div class="cell"><div class="lbl">Very Low 3: ${JSON.stringify(samples['before3-yaw2.4'])}</div><img src="${dataUrl(join(OUT, `${PREFIX}before3-yaw2.4.png`))}"/></div>
      <div class="cell"><div class="lbl">Medium 8: ${JSON.stringify(samples['after8-yaw2.4'])}</div><img src="${dataUrl(join(OUT, `${PREFIX}after8-yaw2.4.png`))}"/></div>
      <div class="cell"><div class="lbl">High 11: ${JSON.stringify(samples['high11-yaw2.4'])}</div><img src="${dataUrl(join(OUT, `${PREFIX}high11-yaw2.4.png`))}"/></div>
    </div>
    <div style="height:12px"></div>
    <div class="row"><div class="cell"><div class="lbl">retail ${REF_FAR}</div><img src="${dataUrl(REF_FAR)}"/></div></div>`);
  await composer.waitForTimeout(500);
  await composer.screenshot({ path: join(OUT, `${PREFIX}core17hga-radius-sidebyside.png`), fullPage: true });
  await browser.close();
  console.log(`[hga] wrote ${OUT}/core17hga-town-sidebyside.png + core17hga-radius-sidebyside.png`);
}
main().catch((e) => { console.error(e); process.exit(1); });
