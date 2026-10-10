/**
 * CORE.9.d live verification — sky render model vs retail GameSky.
 * Enters world, telepois to Holtburg, then for Sunny + Rainy groups
 * captures t=0.05 (night), 0.18 (dawn), 0.5 (noon), 0.9 (dusk) and
 * checks the DAT-anchored invariants:
 *  - base sky box (0x10015ee) always visible, opaque, color=lum/100
 *    (dark at night — the old inverted model rendered night day-bright);
 *  - star dome (0x10015ef) renders: visible+opaque at night, gone by day;
 *  - no additive dome-face V-line seams (the box now draws opaque).
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';

const OUT = '/home/user/acjs/verification/core9d';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=core9d';

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

/** Per-time sky state: entry flags, visibility, material color/opacity. */
async function skyState(page: Page): Promise<unknown> {
  return page.evaluate(`(() => {
    const sky = window.__ac.skybox;
    const entries = sky.skyObjectEntries.map(e => ({
      idx: e.index,
      gfx: '0x' + e.skyObj.defaultGFXObjectId.toString(16),
      isBaseSky: !!e.isBaseSky,
      isStaticOverlay: !!e.isStaticOverlay,
      visible: e.mesh.visible,
      renderOrder: e.mesh.renderOrder,
      color: e.materials[0] ? +e.materials[0].color.r.toFixed(3) : null,
      opacity: e.materials[0] ? +e.materials[0].opacity.toFixed(3) : null,
      transparentFlag: e.materials[0] ? e.materials[0].transparent : null,
      blending: e.materials[0] ? e.materials[0].blending : null,
    }));
    return { dayGroup: sky.dayGroupName, t: +sky.currentTimeOfDay.toFixed(3), entries };
  })()`);
}

async function forceGroup(page: Page, pattern: string): Promise<string> {
  return page.evaluate(`(() => {
    const ac = window.__ac;
    const g = ac.regionDesc.skyInfo.dayGroups.find(x => /${pattern}/i.test(x.dayName));
    if (!g) return 'no-group';
    ac.skybox.activeDayGroup = g;
    ac.skybox.rebuildSkyObjects(ac.modelRenderer);
    return ac.skybox.dayGroupName;
  })()`) as Promise<string>;
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
      if (created !== 'not-at-create') { console.log(`[d] char create: ${created}`); createSent = true; lastReload = Date.now(); }
    }
    if (Date.now() - lastReload > 60_000) {
      console.log('[d] reload (phantom-session retry)');
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* keep polling */ }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) { await browser.close(); throw new Error('never entered world'); }
  console.log('[d] in world — settling 8s');
  await page.waitForTimeout(8_000);
  await page.evaluate(`window.acDebug.admin('@telepoi holtburg')`);
  await page.waitForTimeout(20_000);

  const results: Record<string, unknown> = {};
  for (const groupPattern of ['sunny', 'rainy']) {
    const forced = await forceGroup(page, groupPattern);
    console.log(`[d] forced group: ${forced}`);
    await page.waitForTimeout(2_000);
    for (const t of [0.05, 0.18, 0.5, 0.9]) {
      await page.evaluate(`window.__ac.skybox.updateTimeOfDay(${t})`);
      await page.waitForTimeout(800);
      await page.screenshot({ path: `${OUT}/${groupPattern}-t${t.toFixed(2)}.png` });
      results[`${groupPattern}-t${t}`] = await skyState(page);
    }
  }

  // yaw sweep at Sunny noon — catches the 45°-aligned eye-plane degeneracy
  await forceGroup(page, 'sunny');
  await page.evaluate(`window.__ac.skybox.updateTimeOfDay(0.5)`);
  await page.evaluate(`window.__ac.skybox.update = function(){}`);
  await page.evaluate(`window.__ac.cameraController.update = function(){}`);
  for (const deg of [0, 45, 90, 135, 180, 225, 270, 315]) {
    await page.evaluate(`window.__ac.sceneManager.camera.rotation.set(0.15, ${deg} * Math.PI / 180, 0, 'YXZ')`);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/noon-yaw${deg}.png` });
  }
  writeFileSync(`${OUT}/sky-state.json`, JSON.stringify(results, null, 1));
  console.log('[d] states written to sky-state.json');

  // --- Invariant checks (Sunny) ---
  type Entry = { idx: number; gfx: string; isBaseSky: boolean; isStaticOverlay: boolean;
    visible: boolean; renderOrder: number; color: number | null; opacity: number | null;
    transparentFlag: boolean | null; blending: number | null };
  const night = results['sunny-t0.05'] as { entries: Entry[] };
  const noon = results['sunny-t0.5'] as { entries: Entry[] };
  const box5 = night.entries.find(e => e.gfx === '0x10015ee');
  const star5 = night.entries.find(e => e.gfx === '0x10015ef');
  const boxN = noon.entries.find(e => e.gfx === '0x10015ee');
  const starN = noon.entries.find(e => e.gfx === '0x10015ef');
  const failures: string[] = [];
  if (!box5 || !box5.isBaseSky) failures.push('sky box 0x10015ee not tracked as base sky');
  if (box5 && !box5.visible) failures.push('sky box hidden at night');
  if (box5 && (box5.color ?? 1) > 0.2) failures.push(`night sky box color ${box5?.color} — expected ~0.11 (lum/100), day-bright night regression`);
  if (box5 && box5.transparentFlag !== false) failures.push('sky box not opaque');
  if (boxN && Math.abs((boxN.color ?? 0) - 1) > 0.05) failures.push(`noon sky box color ${boxN?.color} — expected ~1.0`);
  if (!star5) failures.push('star dome 0x10015ef entry missing (still skipped)');
  if (star5 && !star5.visible) failures.push('star dome hidden at night');
  if (star5 && (star5.opacity ?? 0) < 0.95) failures.push(`night star opacity ${star5?.opacity} — expected ~1`);
  if (starN && starN.visible) failures.push('star dome still visible at noon');
  if (box5 && star5 && !(box5.renderOrder < star5.renderOrder && star5.renderOrder < 0))
    failures.push(`order wrong: box ${box5.renderOrder} star ${star5.renderOrder}`);

  if (failures.length) {
    console.error('[d] FAIL:\n - ' + failures.join('\n - '));
    await browser.close();
    process.exit(1);
  }
  console.log('[d] PASS — all CORE.9.d invariants hold live');
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
