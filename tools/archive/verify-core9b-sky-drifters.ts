/**
 * CORE.9.b live verification — sky drifter emitters track the camera.
 *
 * The always-on sky Setup 0x2000714's DefaultScript (0x330007db) spawns
 * three endless drifter emitters (0x32000455/56/57). Retail parents sky
 * physics objects into GameSky's viewer-following sky cells
 * (GameSky::MakeObject → AddObjectToSingleCell(before/after_sky_cell)), so
 * the drifters ride with the camera. Pre-fix they were scene-rooted at the
 * world position of spawn time (world origin at init → stuck at (0,250,0)).
 *
 * Asserts against the live ACE stack:
 *  1. The drifter particle systems exist and are PARENTED to a sky_setup_*
 *     anchor (not the scene root).
 *  2. Their world position matches the camera-following sky group (x/z of
 *     the player, y+250).
 *  3. After a @telepoi to a distant POI, the world positions moved with the
 *     camera — the pre-fix bug left them behind at the old spot.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';

const OUT = '/home/user/acjs/verification/core9b';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=core9b';

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

/** Snapshot the drifter systems: parent chain + world vs sky-group position. */
async function drifterState(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(`(() => {
    const ac = window.__ac;
    const THREE = window.__THREE || null;
    const sky = ac.skybox;
    const group = sky.skyObjectsGroup;
    const drifters = [];
    ac.sceneManager.scene.traverse((o) => {
      if (o.name && /^particles_320004(55|56|57)$/.test(o.name)) {
        const w = { x: 0, y: 0, z: 0 };
        o.updateWorldMatrix(true, false);
        const e = o.matrixWorld.elements;
        w.x = e[12]; w.y = e[13]; w.z = e[14];
        drifters.push({
          name: o.name,
          parent: o.parent ? o.parent.name || o.parent.type : 'none',
          local: { x: +o.position.x.toFixed(1), y: +o.position.y.toFixed(1), z: +o.position.z.toFixed(1) },
          world: { x: +w.x.toFixed(1), y: +w.y.toFixed(1), z: +w.z.toFixed(1) },
        });
      }
    });
    const cs = window.acDebug.collisionState();
    return {
      dayGroup: sky.dayGroupName,
      skyGroupPos: group ? { x: +group.position.x.toFixed(1), y: +group.position.y.toFixed(1), z: +group.position.z.toFixed(1) } : null,
      player: cs ? { x: +cs.x.toFixed(1), z: +cs.z.toFixed(1) } : null,
      drifters,
    };
  })()`) as Promise<Record<string, unknown>>;
}

async function forceSunny(page: Page): Promise<unknown> {
  return page.evaluate(`(() => {
    const ac = window.__ac;
    const groups = ac.regionDesc.skyInfo.dayGroups;
    const g = groups.find(x => /sunny/i.test(x.dayName));
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
  page.on('console', m => { if (/\[Sky\]/.test(m.text())) console.log('[console]', m.text()); });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (!createSent) {
      const created = await driveCharacterCreate(page);
      if (created !== 'not-at-create') { console.log(`[core9b] char create: ${created}`); createSent = true; lastReload = Date.now(); }
    }
    if (Date.now() - lastReload > 60_000) {
      console.log('[core9b] reload (phantom-session retry)');
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* keep polling */ }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) { await browser.close(); throw new Error('never entered world'); }
  console.log('[core9b] in world — settling 10s');
  await page.waitForTimeout(10_000);

  await page.evaluate(`window.acDebug.admin('@telepoi holtburg')`);
  console.log('[core9b] telepoi holtburg — streaming 20s');
  await page.waitForTimeout(20_000);

  // Force Sunny (only the always-on spawner survives) and rebuild — this
  // re-runs the spawn path at the CURRENT camera position; the follow
  // assertion below is what pre-fix behavior fails.
  console.log('[core9b] forceSunny:', await forceSunny(page));
  await page.waitForTimeout(3_000);

  const s1 = await drifterState(page);
  console.log('[core9b] AT-HOLTBURG:', JSON.stringify(s1, null, 1));
  await page.screenshot({ path: `${OUT}/core9b-holtburg.png` });

  await page.evaluate(`window.acDebug.admin('@telepoi eastham')`);
  console.log('[core9b] telepoi eastham — streaming 20s');
  await page.waitForTimeout(20_000);

  const s2 = await drifterState(page);
  console.log('[core9b] AT-EASTHAM:', JSON.stringify(s2, null, 1));
  await page.screenshot({ path: `${OUT}/core9b-eastham.png` });

  // ── Assertions ──
  type D = { name: string; parent: string; world: { x: number; y: number; z: number } };
  const d1 = (s1.drifters as D[]) ?? [];
  const d2 = (s2.drifters as D[]) ?? [];
  const g1 = s1.skyGroupPos as { x: number; y: number; z: number };
  const g2 = s2.skyGroupPos as { x: number; y: number; z: number };
  const fails: string[] = [];
  if (d1.length !== 3) fails.push(`expected 3 drifter systems at holtburg, got ${d1.length}`);
  for (const d of d1) {
    if (!/^sky_setup_/.test(d.parent)) fails.push(`${d.name} parented to ${d.parent}, not a sky_setup anchor`);
    if (Math.abs(d.world.x - g1.x) > 1 || Math.abs(d.world.z - g1.z) > 1) {
      fails.push(`${d.name} world (${d.world.x},${d.world.z}) != sky group (${g1.x},${g1.z}) at holtburg`);
    }
  }
  const moved = Math.hypot(g2.x - g1.x, g2.z - g1.z);
  if (moved < 100) fails.push(`camera barely moved between POIs (${moved.toFixed(0)}u) — teleport failed?`);
  for (const d of d2) {
    if (Math.abs(d.world.x - g2.x) > 1 || Math.abs(d.world.z - g2.z) > 1) {
      fails.push(`${d.name} did NOT follow the camera to eastham: world (${d.world.x},${d.world.z}) vs sky group (${g2.x},${g2.z})`);
    }
  }
  await browser.close();
  if (fails.length) { console.error('[core9b] FAIL:\n  ' + fails.join('\n  ')); process.exit(1); }
  console.log(`[core9b] PASS — 3 drifters parented to sky anchors, followed the camera ${moved.toFixed(0)}u between POIs`);
}

main().catch(e => { console.error(e); process.exit(1); });
