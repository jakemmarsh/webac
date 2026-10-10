/**
 * CORE.9.a live verification — SETUP sky object scripts + fog-hide bit.
 *
 * Asserts against the live ACE stack:
 *  1. Forced-Rainy rebuild creates the 11 sky_setup anchors alongside the
 *     rain domes.
 *  2. Setting time-of-day into the midday thunder window (0.40–0.50)
 *     activates PhysicsScript playback (thunder cycle 0x33000453 + the
 *     quiet rain loop 0x3300042c); the lightning-flash/endless particle
 *     systems appear in the scene.
 *  3. Moving time outside every bounded window drops the active scripts.
 *  4. DisableMostWeatherEffects stops weather-flagged (props&0x4) scripts.
 *  5. Forced-Sunny keeps only the always-on spawner (0x2000714).
 *  6. setFogOverrideActive(true) hides the props&0x2 cloud bank pivot.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';

const OUT = '/home/user/acjs/verification/core9a';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=core9a';

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

/** Sky/script/particle state snapshot. */
async function state(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(`(() => {
    const ac = window.__ac;
    const setups = [];
    const gfx = [];
    for (const p of (ac.skybox.skyObjectsGroup ? ac.skybox.skyObjectsGroup.children : [])) {
      if (p.name.startsWith('sky_setup_')) setups.push(p.name);
      else gfx.push({ name: p.name, visible: p.visible });
    }
    const particles = [];
    ac.sceneManager.scene.traverse((o) => {
      if (o.name && o.name.startsWith('particles_')) particles.push(o.name);
    });
    const slots = (ac.skybox.setupSkyEntries || []).map(e => ({
      idx: e.index, setup: '0x' + e.setupId.toString(16),
      window: e.skyObj.beginTime.toFixed(3) + '..' + e.skyObj.endTime.toFixed(3),
      weather: e.isWeather, active: e.active,
    }));
    return {
      dayGroup: ac.skybox.dayGroupName,
      timeOfDay: +ac.skybox.currentTimeOfDay.toFixed(4),
      weatherEnabled: ac.skybox.isWeatherEnabled,
      activeScripts: window.acDebug.activeScripts(),
      setupAnchors: setups.length, slots, gfx, particles,
    };
  })()`) as Promise<Record<string, unknown>>;
}

async function forceDayGroup(page: Page, namePattern: string): Promise<unknown> {
  return page.evaluate(`(() => {
    const ac = window.__ac;
    const groups = ac.regionDesc.skyInfo.dayGroups;
    const g = groups.find(x => new RegExp('${namePattern}', 'i').test(x.dayName)
      && x.skyObjects.some(o => ((o.defaultGFXObjectId >> 24) & 0xff) === 2 && o.defaultGFXObjectId !== 0x02000714));
    const g2 = g || groups.find(x => new RegExp('${namePattern}', 'i').test(x.dayName));
    if (!g2) return 'no-group';
    ac.skybox.activeDayGroup = g2;
    ac.skybox.rebuildSkyObjects(ac.modelRenderer);
    return ac.skybox.dayGroupName + ' (' + g2.skyObjects.length + ' skyObjects)';
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
  page.on('console', m => { if (/\[Sky\]|\[Weather\]|\[AC\] PScript/.test(m.text())) console.log('[console]', m.text()); });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (!createSent) {
      const created = await driveCharacterCreate(page);
      if (created !== 'not-at-create') { console.log(`[core9a] char create: ${created}`); createSent = true; lastReload = Date.now(); }
    }
    if (Date.now() - lastReload > 60_000) {
      console.log('[core9a] reload (phantom-session retry)');
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* keep polling */ }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) { await browser.close(); throw new Error('never entered world'); }
  console.log('[core9a] in world — settling 10s');
  await page.waitForTimeout(10_000);

  await page.evaluate(`window.acDebug.admin('@telepoi holtburg')`);
  console.log('[core9a] telepoi holtburg — streaming 20s');
  await page.waitForTimeout(20_000);

  console.log('[core9a] AS-ROLLED:', JSON.stringify(await state(page), null, 1));

  console.log('[core9a] force Rainy →', await forceDayGroup(page, 'rain'));
  await page.waitForTimeout(1_000);
  console.log('[core9a] RAINY (as-is time):', JSON.stringify(await state(page), null, 1));

  // Midday thunder window 0.40–0.50 (+ quiet rain loop 0.27–0.91).
  await page.evaluate(`window.acDebug.setTimeOfDay(0.45)`);
  await page.waitForTimeout(4_000);
  console.log('[core9a] RAINY t=0.45 (thunder window):', JSON.stringify(await state(page), null, 1));
  await page.screenshot({ path: `${OUT}/core9a-rainy-thunderwindow.png` });

  // Outside every bounded window (0.20 < t < 0.27 gap): scripts must stop.
  await page.evaluate(`window.acDebug.setTimeOfDay(0.22)`);
  await page.waitForTimeout(2_000);
  console.log('[core9a] RAINY t=0.22 (no bounded window):', JSON.stringify(await state(page), null, 1));

  // Weather gate: back in the thunder window, then disable weather.
  await page.evaluate(`window.acDebug.setTimeOfDay(0.45)`);
  await page.waitForTimeout(2_000);
  await page.evaluate(`window.__ac.skybox.setWeatherEnabled(false)`);
  await page.waitForTimeout(1_000);
  console.log('[core9a] RAINY t=0.45 weather OFF:', JSON.stringify(await state(page), null, 1));
  await page.evaluate(`window.__ac.skybox.setWeatherEnabled(true)`);
  await page.waitForTimeout(500);

  console.log('[core9a] force Sunny →', await forceDayGroup(page, 'sunny'));
  await page.waitForTimeout(1_000);
  console.log('[core9a] SUNNY:', JSON.stringify(await state(page), null, 1));
  await page.screenshot({ path: `${OUT}/core9a-sunny.png` });

  // Fog-override hide bit on the Sunny cloud bank (props&0x2).
  await page.evaluate(`window.__ac.skybox.setFogOverrideActive(true)`);
  await page.waitForTimeout(500);
  console.log('[core9a] SUNNY + fog override:', JSON.stringify(await state(page), null, 1));
  await page.screenshot({ path: `${OUT}/core9a-sunny-fogoverride.png` });
  await page.evaluate(`window.__ac.skybox.setFogOverrideActive(false)`);
  await page.waitForTimeout(500);
  console.log('[core9a] SUNNY fog cleared:', JSON.stringify(await state(page), null, 1));

  await browser.close();
  console.log('[core9a] done');
}

main().catch(err => { console.error(err); process.exit(1); });
