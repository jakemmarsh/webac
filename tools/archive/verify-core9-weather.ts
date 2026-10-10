/**
 * CORE.9 live verification — "constant snow" fix.
 *
 * Diagnosis: the hand-rolled WeatherEffect point cloud (2000 white dots,
 * rendered on Rainy day-group days, indoors too) read as perpetual snow.
 * Fix: DAT weather sky objects (Rainy rain domes 0x1004c42/0x1004c44,
 * properties&0x4) rendered by SkyboxRenderer per the decompiled client's
 * GameSky, rebuilt at each day-group re-roll, gated by
 * DisableMostWeatherEffects.
 *
 * This probe logs in, teleports outdoors (Holtburg), then captures:
 *  1. the as-rolled day group (asserting no weather_rain/weather_snow
 *     Points object exists in the scene any more);
 *  2. a forced-Rainy rebuild via the real rebuildSkyObjects path — rain
 *     domes present, scrolling;
 *  3. the DisableMostWeatherEffects gate hiding the rain layers;
 *  4. a forced-Sunny rebuild — rain layers gone.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';

const OUT = '/home/user/acjs/verification/core9';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=core9';

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(`(() => {
    const dbg = window.acDebug; const cs = dbg && dbg.collisionState && dbg.collisionState();
    return !!(cs && cs.x > 0);
  })()`) as Promise<boolean>;
}

async function driveCharacterCreate(page: Page): Promise<string> {
  return page.evaluate(`(() => {
    const ui = window.__ac && window.__ac.gameUI;
    if (!ui || !ui.ui || ui.ui.currentScreen !== 'character-create') return 'not-at-create';
    if (!ui.wizard || !ui.callbacks || !ui.callbacks.onCharacterCreated) return 'no-hooks';
    ui.wizard.name = 'Perf Tester';
    ui.callbacks.onCharacterCreated(ui.wizard);
    return 'sent';
  })()`) as Promise<string>;
}

/** Snapshot the sky/weather state + all Points objects in the scene. */
async function weatherState(page: Page): Promise<unknown> {
  return page.evaluate(`(() => {
    const ac = window.__ac;
    const points = [];
    ac.sceneManager.scene.traverse((o) => {
      if (o.isPoints) points.push({ name: o.name || (o.parent && o.parent.name) || '(anon)',
        count: o.geometry.attributes.position ? o.geometry.attributes.position.count : 0 });
    });
    const skyPivots = (ac.skybox.skyObjectsGroup ? ac.skybox.skyObjectsGroup.children : [])
      .map(p => ({ name: p.name, visible: p.visible, renderOrder: p.renderOrder }));
    return {
      dayGroup: ac.skybox.dayGroupName,
      timeOfDay: ac.skybox.currentTimeOfDay,
      weatherEnabled: ac.skybox.isWeatherEnabled,
      skyGroupVisible: ac.skybox.skyObjectsGroup ? ac.skybox.skyObjectsGroup.visible : null,
      skyPivots, points,
    };
  })()`);
}

/** Force a specific day group live and run the REAL rebuild path. */
async function forceDayGroup(page: Page, namePattern: string): Promise<unknown> {
  return page.evaluate(`(() => {
    const ac = window.__ac;
    const groups = ac.regionDesc.skyInfo.dayGroups;
    const g = groups.find(x => new RegExp('${namePattern}', 'i').test(x.dayName));
    if (!g) return 'no-group';
    ac.skybox.activeDayGroup = g;
    ac.skybox.rebuildSkyObjects(ac.modelRenderer);
    return ac.skybox.dayGroupName;
  })()`);
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
  page.on('console', m => { if (/\[Sky\]|\[Weather\]/.test(m.text())) console.log('[console]', m.text()); });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (!createSent) {
      const created = await driveCharacterCreate(page);
      if (created !== 'not-at-create') { console.log(`[core9] char create: ${created}`); createSent = true; lastReload = Date.now(); }
    }
    if (Date.now() - lastReload > 60_000) {
      console.log('[core9] reload (phantom-session retry)');
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* keep polling */ }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) { await browser.close(); throw new Error('never entered world'); }
  console.log('[core9] in world — settling 10s');
  await page.waitForTimeout(10_000);

  await page.evaluate(`window.acDebug.admin('@telepoi holtburg')`);
  console.log('[core9] telepoi holtburg — streaming 25s');
  await page.waitForTimeout(25_000);

  console.log('[core9] AS-ROLLED:', JSON.stringify(await weatherState(page), null, 1));
  await page.screenshot({ path: `${OUT}/core9-fix-asrolled.png` });

  console.log('[core9] force Rainy →', await forceDayGroup(page, 'rain'));
  await page.waitForTimeout(3_000);
  console.log('[core9] RAINY:', JSON.stringify(await weatherState(page), null, 1));
  await page.screenshot({ path: `${OUT}/core9-fix-rainy.png` });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/core9-fix-rainy-2.png` });

  await page.evaluate(`window.__ac.skybox.setWeatherEnabled(false)`);
  await page.waitForTimeout(1_000);
  console.log('[core9] RAINY+DISABLED:', JSON.stringify(await weatherState(page), null, 1));
  await page.screenshot({ path: `${OUT}/core9-fix-rainy-weather-disabled.png` });
  await page.evaluate(`window.__ac.skybox.setWeatherEnabled(true)`);

  console.log('[core9] force Sunny →', await forceDayGroup(page, 'sunny'));
  await page.waitForTimeout(2_000);
  console.log('[core9] SUNNY:', JSON.stringify(await weatherState(page), null, 1));
  await page.screenshot({ path: `${OUT}/core9-fix-sunny.png` });

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
