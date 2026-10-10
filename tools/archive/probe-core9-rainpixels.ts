/** CORE.9 — isolate the rain domes' pixel contribution (A/B via pivot visibility). */
import { chromium, type Page } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';

const OUT = '/home/user/acjs/verification/core9';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=core9b';

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(`(() => {
    const dbg = window.acDebug; const cs = dbg && dbg.collisionState && dbg.collisionState();
    return !!(cs && cs.x > 0);
  })()`) as Promise<boolean>;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    headless: true, args: ['--enable-unsafe-swiftshader'],
    ...(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1568, height: 775 } });
  page.setDefaultTimeout(120000);
  page.on('dialog', d => void d.dismiss());
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline && !(await inWorld(page))) await page.waitForTimeout(3000);
  if (!(await inWorld(page))) throw new Error('never entered world');
  await page.waitForTimeout(8_000);
  await page.evaluate(`window.acDebug.admin('@telepoi holtburg')`);
  await page.waitForTimeout(20_000);

  const info = await page.evaluate(`(() => {
    const ac = window.__ac;
    const groups = ac.regionDesc.skyInfo.dayGroups;
    const g = groups.find(x => /rain/i.test(x.dayName));
    ac.skybox.activeDayGroup = g;
    ac.skybox.rebuildSkyObjects(ac.modelRenderer);
    // freeze time-of-day at mid-morning for a stable A/B
    ac.skybox.setForceDaylight(true);
    const out = [];
    for (const p of ac.skybox.skyObjectsGroup.children) {
      const mats = [];
      p.traverse(c => { if (c.isMesh) mats.push({
        color: c.material.color.getHexString(), hasMap: !!c.material.map,
        transparent: c.material.transparent, opacity: c.material.opacity,
        offset: c.material.map ? [c.material.map.offset.x, c.material.map.offset.y] : null,
        wrapS: c.material.map ? c.material.map.wrapS : null,
      }); });
      out.push({ name: p.name, visible: p.visible, mats });
    }
    return out;
  })()`);
  console.log('[probe] pivots:', JSON.stringify(info, null, 1));

  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${OUT}/ab-rain-on.png` });
  // sticky gate (manual pivot.visible would be re-derived next frame)
  await page.evaluate(`window.__ac.skybox.setWeatherEnabled(false)`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/ab-rain-off.png` });
  await page.evaluate(`window.__ac.skybox.setWeatherEnabled(true)`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/ab-rain-on2.png` });
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
