/**
 * Live verification for BUG.sealed-interior-renders-outdoor-terrain.
 * Logs into the ACE stack (same flow as tools/live-playtest.ts), spawns in
 * the Holtburg starter cottage (sealed interior 0x8602xxxx), screenshots it,
 * and probes the scene: skybox hidden, all terrain meshes hidden, sealed log
 * line present.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=sealedverify';
const OUT = '/home/user/acjs/verification/playtest/sealed-interior-fix';
const VIEW = { width: 1568, height: 775 };

const consoleAll: string[] = [];

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const dbg = (window as unknown as { acDebug?: { collisionState?: () => { x: number } } }).acDebug;
    const cs = dbg?.collisionState?.();
    return !!(cs && cs.x > 0);
  });
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

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}),
  });
  const page = await browser.newPage({ viewport: VIEW });
  page.setDefaultTimeout(120000);
  page.on('dialog', d => void d.dismiss());
  page.on('console', m => consoleAll.push(m.text().slice(0, 300)));

  console.log(`[verify] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (!createSent) {
      const created = await driveCharacterCreate(page);
      if (created !== 'not-at-create') {
        console.log(`[verify] scripted create: ${created}`);
        createSent = true;
        lastReload = Date.now();
      }
    }
    if (Date.now() - lastReload > 60_000) {
      console.log('[verify] reloading (phantom-session retry)');
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* keep */ }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) {
    await page.screenshot({ path: join(OUT, '00-never-entered.png') });
    await browser.close();
    throw new Error('never entered world within 360s');
  }

  console.log('[verify] in world — settling 15s…');
  await page.waitForTimeout(15_000);
  await page.screenshot({ path: join(OUT, '01-spawn-after-fix.png') });

  const probe = await page.evaluate(`(() => {
    const ac = window.__ac;
    const terr = ac.terrainRenderer;
    const meshes = Array.from(terr.meshes.values());
    const overlays = terr.overlayMergePool.meshes;
    const blend = overlays.filter(m => m.name === 'blendmerge');
    const roads = overlays.filter(m => m.name === 'roadmerge');
    const attach = Array.from(terr.attachments.values()).flat();
    return {
      skyObjectVisible: ac.skybox.skyObject.visible,
      directionalVisible: ac.skybox.directionalLight.visible,
      terrainMeshCount: meshes.length,
      terrainVisibleCount: meshes.filter(m => m.visible).length,
      blendVisibleCount: blend.filter(m => m.visible).length + '/' + blend.length,
      roadVisibleCount: roads.filter(m => m.visible).length + '/' + roads.length,
      attachVisibleCount: attach.filter(m => m.visible).length + '/' + attach.length,
      background: ac.sceneManager.scene.background && ac.sceneManager.scene.background.getHexString
        ? ac.sceneManager.scene.background.getHexString() : String(ac.sceneManager.scene.background),
      fogNear: ac.sceneManager.scene.fog ? ac.sceneManager.scene.fog.near : null,
      fogFar: ac.sceneManager.scene.fog ? ac.sceneManager.scene.fog.far : null,
      collision: window.acDebug.collisionState(),
    };
  })()`);
  const sealedLog = consoleAll.filter(t => t.includes('Sealed interior') || t.includes('SeenOutside interior') || t.includes('Surface building'));
  console.log('[verify] probe:', JSON.stringify(probe, null, 1));
  console.log('[verify] classification logs:', JSON.stringify(sealedLog));
  writeFileSync(join(OUT, 'probe.json'), JSON.stringify({ probe, sealedLog }, null, 2));
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
