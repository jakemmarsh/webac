/**
 * CORE.9.c mechanism probe — dome 0x10015ee hairlines.
 * Dome-only scene, then: (a) baseline additive+texture, (b) additive+flat
 * color (no map) — persists ⇒ geometric double-draw, gone ⇒ texture-border
 * bleed, (c) normal blending+texture — gone ⇒ additive-specific.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';

const OUT = '/home/user/acjs/verification/core9c';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=core9c2';

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(`(() => {
    const dbg = window.acDebug; const cs = dbg && dbg.collisionState && dbg.collisionState();
    return !!(cs && cs.x > 0);
  })()`) as Promise<boolean>;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1568, height: 775 } });
  page.setDefaultTimeout(120000);
  page.on('dialog', d => void d.dismiss());
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  const deadline = Date.now() + 360_000;
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
  await page.waitForTimeout(8_000);
  await page.evaluate(`window.acDebug.admin('@telepoi holtburg')`);
  await page.waitForTimeout(20_000);

  await page.evaluate(`(() => {
    const ac = window.__ac;
    const g = ac.regionDesc.skyInfo.dayGroups.find(x => /sunny/i.test(x.dayName));
    ac.skybox.activeDayGroup = g;
    ac.skybox.rebuildSkyObjects(ac.modelRenderer);
    ac.skybox.updateTimeOfDay(0.18);
    ac.skybox.update = function(){};
    const kids = ac.skybox.skyObjectsGroup.children;
    kids.forEach(p => { p.visible = /0x010015ee/.test(p.name); });
  })()`);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/mech-a-baseline.png` });

  // (b) strip maps — flat mid-gray additive
  await page.evaluate(`(() => {
    const dome = window.__ac.skybox.skyObjectsGroup.children.find(p => /0x010015ee/.test(p.name));
    dome.traverse(c => { if (c.isMesh) { c.material.userData._map = c.material.map; c.material.map = null; c.material.color.setScalar(0.5); c.material.needsUpdate = true; } });
  })()`);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/mech-b-nomap.png` });

  // (c) restore maps, switch to normal alpha blending (opaque-ish)
  await page.evaluate(`(() => {
    const THREEBlend = { One: 201, OneMinusSrcAlpha: 205 };
    const dome = window.__ac.skybox.skyObjectsGroup.children.find(p => /0x010015ee/.test(p.name));
    dome.traverse(c => { if (c.isMesh) {
      c.material.map = c.material.userData._map;
      c.material.color.setScalar(1.0);
      c.material.blending = 1; // NormalBlending
      c.material.transparent = false;
      c.material.needsUpdate = true;
    } });
  })()`);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/mech-c-opaque.png` });
  console.log('[c2] done');
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
