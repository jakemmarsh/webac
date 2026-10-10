/**
 * CORE.9.c diagnosis probe — Sunny sky dome-edge V-lines.
 * Enters world, forces Sunny, scans timeOfDay, then bisects sky objects
 * (hide all → show one at a time) to find which object draws the hairlines.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';

const OUT = '/home/user/acjs/verification/core9c';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=core9c';

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

async function skyState(page: Page): Promise<unknown> {
  return page.evaluate(`(() => {
    const ac = window.__ac;
    return {
      dayGroup: ac.skybox.dayGroupName,
      t: ac.skybox.currentTimeOfDay,
      pivots: (ac.skybox.skyObjectsGroup ? ac.skybox.skyObjectsGroup.children : [])
        .map(p => ({ name: p.name, visible: p.visible })),
    };
  })()`);
}

async function setTime(page: Page, t: number): Promise<void> {
  await page.evaluate(`window.__ac.skybox.updateTimeOfDay(${t})`);
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
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (!createSent) {
      const created = await driveCharacterCreate(page);
      if (created !== 'not-at-create') { console.log(`[c] char create: ${created}`); createSent = true; lastReload = Date.now(); }
    }
    if (Date.now() - lastReload > 60_000) {
      console.log('[c] reload (phantom-session retry)');
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* keep polling */ }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) { await browser.close(); throw new Error('never entered world'); }
  console.log('[c] in world — settling 8s');
  await page.waitForTimeout(8_000);
  await page.evaluate(`window.acDebug.admin('@telepoi holtburg')`);
  await page.waitForTimeout(20_000);

  // Force Sunny like the CORE.9 probe (real rebuild path)
  const forced = await page.evaluate(`(() => {
    const ac = window.__ac;
    const g = ac.regionDesc.skyInfo.dayGroups.find(x => /sunny/i.test(x.dayName));
    if (!g) return 'no-group';
    ac.skybox.activeDayGroup = g;
    ac.skybox.rebuildSkyObjects(ac.modelRenderer);
    return ac.skybox.dayGroupName;
  })()`);
  console.log('[c] forced group:', forced);
  await page.waitForTimeout(2_000);

  // Phase 1: time scan — everything as-is
  for (const t of [0.05, 0.18, 0.21, 0.30, 0.50]) {
    await setTime(page, t);
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${OUT}/scan-t${t.toFixed(2)}.png` });
  }
  console.log('[c] time scan done. state:', JSON.stringify(await skyState(page)));

  // Phase 2: bisect at t=0.18 (morning window: moons + additive dome active)
  await setTime(page, 0.18);
  await page.waitForTimeout(500);
  // Freeze the per-frame sky update so manual visibility toggles stick
  // (update() → updateTimeOfDay() re-derives every entry's mesh.visible).
  await page.evaluate(`window.__ac.skybox.update = function(){}`);

  // 2a: hide entire sky object group
  await page.evaluate(`window.__ac.skybox.skyObjectsGroup.visible = false`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/bisect-noskyobjs.png` });

  // 2b: also hide gradient sphere
  await page.evaluate(`window.__ac.skybox.skyObject.visible = false`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/bisect-nosky-nograd.png` });
  await page.evaluate(`window.__ac.skybox.skyObject.visible = true`);

  // 2c: show pivots one at a time (updateTimeOfDay re-derives visibility, so
  // force via traverse after each frame — instead hide siblings each shot)
  await page.evaluate(`window.__ac.skybox.skyObjectsGroup.visible = true`);
  const names: string[] = await page.evaluate(`window.__ac.skybox.skyObjectsGroup.children.map(p=>p.name)`) as string[];
  console.log('[c] pivots:', names.join(', '));
  for (let i = 0; i < names.length; i++) {
    await page.evaluate(`(() => {
      const kids = window.__ac.skybox.skyObjectsGroup.children;
      kids.forEach((p, j) => { p.visible = (j === ${i}); });
    })()`);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/bisect-only-${i}-${names[i].replace(/[^a-z0-9_]/gi,'')}.png` });
  }
  // restore
  await page.evaluate(`window.__ac.skybox.updateTimeOfDay(0.18)`);
  console.log('[c] done');
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
